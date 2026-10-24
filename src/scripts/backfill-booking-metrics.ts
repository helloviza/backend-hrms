// apps/backend/src/scripts/backfill-booking-metrics.ts
//
// One-time repair of the TravelBooking mirror (the data behind Travel Spend),
// to match the fixed live sync in models/ManualBooking.ts:
//
//   1. Demo flag. Mirror rows of demo ManualBookings were written isDemo:false
//      (the sync never copied the flag). Set isDemo / createdByDemoUser from
//      the source booking.
//   2. Book Now (ADMIN_QUEUE) bookings were never mirrored. Create their mirror
//      rows with the live sync itself (syncManualBookingToMirror), so a
//      backfilled row is identical to one written live.
//   3. Request-keyed CONCIERGE rows (written by Mark Done / booking completion)
//      for requests that HAVE a Book Now booking are retired — isActive:false,
//      never deleted — since that booking's own mirror row now carries the
//      trip. Same rule the live sync applies on every save of such a booking.
//
// Idempotent: each step selects only rows still needing the change, so a
// re-run after --apply reports 0 / 0 / 0.
//
// DRY RUN by default (prints counts, writes nothing). Pass --apply to write.
//
//   npx tsx src/scripts/backfill-booking-metrics.ts --expect-db=<db> [--apply]
import "dotenv/config";
import mongoose from "mongoose";
import { syncManualBookingToMirror } from "../models/ManualBooking.js";

const LIVE = { isActive: { $ne: false } };
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const sellOf = (b: any) => Number(b.pricing?.grandTotal ?? b.pricing?.totalWithGST ?? b.pricing?.quotedPrice) || 0;

export type Report = {
  db: string;
  apply: boolean;
  demoMirrorRowsToFlag: number;
  queueBookingsToMirror: number;
  queueBookingsToMirrorByStatus: Record<string, number>;
  conciergeRowsToRetire: number;
  conciergeRetireReasons: Record<string, { n: number; amount: number }>;
  written: { flagged: number; created: number; retired: number } | null;
};

export async function backfillBookingMetrics(opts: {
  expectDb?: string;
  apply: boolean;
  log?: (line: string) => void;
}): Promise<Report> {
  const { apply, expectDb } = opts;
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);

  const bookings = mongoose.connection.collection("manualbookings");
  const mirror = mongoose.connection.collection("travelbookings");
  log(`db ${db} · ${apply ? "APPLY" : "DRY RUN"}`);

  /* 1 ── demo flag on existing mirror rows ── */
  const demoBookings = await bookings
    .find(
      { source: { $nin: ["SBT", "SBT_AUTO"] }, $or: [{ isDemo: true }, { createdByDemoUser: true }] },
      { projection: { isDemo: 1, createdByDemoUser: 1 } },
    )
    .toArray();
  const demoById = new Map<string, any>(demoBookings.map((b: any) => [String(b._id), b]));
  const demoMirrorRows = demoBookings.length
    ? await mirror
        .find(
          { referenceModel: "ManualBooking", reference: { $in: demoBookings.map((b) => b._id) } },
          { projection: { reference: 1, isDemo: 1, createdByDemoUser: 1, status: 1, amount: 1, isActive: 1 } },
        )
        .toArray()
    : [];
  const demoFix = demoMirrorRows.filter((r: any) => {
    const b = demoById.get(String(r.reference));
    return (r.isDemo === true) !== (b.isDemo === true) || (r.createdByDemoUser === true) !== (b.createdByDemoUser === true);
  });
  const demoInSpend = demoFix.filter((r: any) => r.status === "CONFIRMED" && r.isActive !== false);
  log(`1. demo flag: ${demoBookings.length} demo manual bookings · ${demoFix.length} mirror rows to flag as demo`);
  log(`   in Travel Spend today (CONFIRMED, live): ${demoInSpend.length} rows, ${inr(demoInSpend.reduce((a: number, r: any) => a + (Number(r.amount) || 0), 0))}`);

  /* 2 ── Book Now bookings with no mirror row ── */
  const queueBookings = await bookings.find({ source: "ADMIN_QUEUE" }).toArray();
  const mirrored = new Set(
    (
      await mirror
        .find({ referenceModel: "ManualBooking", reference: { $in: queueBookings.map((b) => b._id) } }, { projection: { reference: 1 } })
        .toArray()
    ).map((r: any) => String(r.reference)),
  );
  const toMirror = queueBookings.filter((b: any) => !mirrored.has(String(b._id)));
  const byStatus = toMirror.reduce((acc: Record<string, number>, b: any) => {
    const k = b.isActive === false ? "deleted" : b.isDemo === true ? "demo" : String(b.status || "?");
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const willCount = toMirror.filter((b: any) => b.isActive !== false && b.isDemo !== true && ["CONFIRMED", "INVOICED"].includes(b.status));
  log(`2. Book Now bookings: ${queueBookings.length} · ${toMirror.length} with no mirror row → create`);
  log(`   by status: ${JSON.stringify(byStatus)}`);
  log(`   will count in Travel Spend (CONFIRMED/INVOICED, live, not demo): ${willCount.length}, ${inr(willCount.reduce((a: number, b: any) => a + sellOf(b), 0))}`);

  /* 3 ── CONCIERGE rows superseded by a Book Now booking ── */
  const concierge = await mirror
    .find({ referenceModel: "ApprovalRequest", source: "CONCIERGE", ...LIVE }, { projection: { reference: 1, status: 1, amount: 1 } })
    .toArray();
  const linkedByRequest = new Map<string, any>();
  for (const b of queueBookings as any[]) {
    if (b.sourceBookingId) linkedByRequest.set(String(b.sourceBookingId), b);
  }
  const toRetire = concierge.filter((r: any) => linkedByRequest.has(String(r.reference)));
  const reasonOf = (r: any) => {
    const b = linkedByRequest.get(String(r.reference));
    if (b.isActive === false) return "booking deleted";
    if (b.status === "CANCELLED") return "booking cancelled";
    if (b.isDemo === true) return "booking is demo";
    if (b.status === "PENDING" || b.status === "WIP") return `booking ${b.status}`;
    return "booking CONFIRMED/INVOICED";
  };
  const reasons: Record<string, { n: number; amount: number }> = {};
  for (const r of toRetire as any[]) {
    const k = reasonOf(r);
    reasons[k] = reasons[k] || { n: 0, amount: 0 };
    reasons[k].n += 1;
    reasons[k].amount += r.status === "CONFIRMED" ? Number(r.amount) || 0 : 0;
  }
  log(`3. CONCIERGE rows: ${concierge.length} live · ${toRetire.length} superseded by a Book Now booking → retire (isActive:false)`);
  for (const [k, v] of Object.entries(reasons)) log(`   ${k.padEnd(28)} ${String(v.n).padStart(4)}  ${inr(v.amount)} CONFIRMED spend`);
  log(`   kept (Mark Done without a booking): ${concierge.length - toRetire.length}`);

  const report: Report = {
    db,
    apply,
    demoMirrorRowsToFlag: demoFix.length,
    queueBookingsToMirror: toMirror.length,
    queueBookingsToMirrorByStatus: byStatus,
    conciergeRowsToRetire: toRetire.length,
    conciergeRetireReasons: reasons,
    written: null,
  };

  if (!apply) {
    log("Dry run — nothing written. Re-run with --apply to write.");
    return report;
  }

  // Step 2 first: a booking's own mirror row must exist before the
  // request-keyed one is retired. (The sync retires it itself, too.)
  let created = 0;
  for (const b of toMirror) {
    await syncManualBookingToMirror(b);
    created += 1;
  }
  let flagged = 0;
  for (const r of demoFix as any[]) {
    const b = demoById.get(String(r.reference));
    const w = await mirror.updateOne(
      { _id: r._id },
      { $set: { isDemo: b.isDemo === true, createdByDemoUser: b.createdByDemoUser === true } },
    );
    flagged += w.modifiedCount;
  }
  let retired = 0;
  for (const r of toRetire as any[]) {
    const b = linkedByRequest.get(String(r.reference));
    // LIVE repeated in the write: a row already retired (by step 2's sync or
    // a live save meanwhile) is left alone and not counted twice.
    const w = await mirror.updateOne(
      { _id: r._id, ...LIVE },
      { $set: { isActive: false, "metadata.supersededByManualBooking": String(b._id) } },
    );
    retired += w.modifiedCount;
  }
  log(`Written: demo-flagged ${flagged} · mirror rows created ${created} · CONCIERGE rows retired ${retired} (+ ${toRetire.length - retired} by the sync).`);
  report.written = { flagged, created, retired };
  return report;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
    await backfillBookingMetrics({ expectDb, apply: process.argv.includes("--apply") });
  } finally {
    await mongoose.disconnect();
  }
}

// Run only when executed directly — importing it (the test) must not connect.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/backfill-booking-metrics.ts");

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
