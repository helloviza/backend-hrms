// apps/backend/src/scripts/mark-sbt-test-data.ts
//
// ══════════════════════════════════════════════════════════════════════
// Mark internal SBT test data as isTest so it never reaches invoices,
// billing/analytics, payment reconciliation or customer booking history.
// Context: before go-live SBT has carried only internal tests.
//
// DRY RUN BY DEFAULT — reads and reports, writes nothing. --apply writes.
//
// WHAT IS MARKED
//   SBTBooking, SBTHotelBooking   created before --before, not demo (isDemo
//                                 rows belong to the Demo Platform and keep
//                                 their own flag), not already isTest
//                                 + MOCK rows at ANY date: hotelCode MOCK…,
//                                 or a PNR / confirmation / booking ref with
//                                 "MOCK" in it
//   TravelBooking                 the mirror rows of the bookings above
//                                 (reference = booking _id) — the save hooks
//                                 do not run on a bulk update, so the mirror
//                                 is updated here explicitly
//   SBTPayment                    payment / checkout rows created before --before
//   PaymentOrphan                 unresolved (no resolvedAt), created before
//                                 --before, AND captured on a Razorpay account
//                                 named in --sbt-account. PaymentOrphan has no
//                                 channel field and the D2C (helloviza) webhook
//                                 writes the same collection — D2C orphans are
//                                 real customer money and are never touched.
//                                 Without --sbt-account no orphan is marked;
//                                 the dry run lists the account ids it found.
//
// REQUIRED
//   --expect-db=<name>   must equal the connected database, or nothing is read
//   --before=<ISO date>  only data created before this instant (explicit, so a
//                        later run can never sweep up live bookings)
// OPTIONAL
//   --sbt-account=acc_X[,acc_Y]   Razorpay account id(s) of the SBT MID
//   --apply                       write (default: dry run)
//
// USAGE
//   npx tsx --env-file=.env src/scripts/mark-sbt-test-data.ts --expect-db=plumbox --before=2026-10-05T00:00:00+05:30
//   npx tsx --env-file=.env src/scripts/mark-sbt-test-data.ts --expect-db=plumbox --before=2026-10-05T00:00:00+05:30 --sbt-account=acc_ABC --apply
//
// No passenger names, emails or phone numbers are printed.
// ══════════════════════════════════════════════════════════════════════

import "dotenv/config";
import mongoose from "mongoose";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import SBTPayment from "../models/SBTPayment.js";
import PaymentOrphan from "../models/PaymentOrphan.js";
import TravelBooking from "../models/TravelBooking.js";

export type Options = {
  expectDb: string | undefined;
  before: string | undefined;
  sbtAccounts?: string[];
  apply?: boolean;
  log?: (line: string) => void;
};

export type Report = {
  db: string;
  applied: boolean;
  flights: number;
  hotels: number;
  travelBookings: number;
  payments: number;
  orphans: number;
  orphansSkipped: number;
  orphanAccounts: Record<string, number>;
};

const MOCK_RX = /mock/i;

export async function markSbtTestData(opts: Options): Promise<Report> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  const before = opts.before ? new Date(opts.before) : null;
  if (!before || Number.isNaN(before.getTime())) {
    throw new Error("REFUSING: --before=<ISO date> is required (e.g. --before=2026-10-05T00:00:00+05:30).");
  }
  const apply = opts.apply === true;
  const accounts = (opts.sbtAccounts || []).map((a) => a.trim()).filter(Boolean);

  log(`[mark-sbt-test] db=${db} before=${before.toISOString()} ${apply ? "APPLY — WRITING" : "DRY RUN — nothing written"}`);

  const notDemoNotTest = { isDemo: { $ne: true }, isTest: { $ne: true } };
  const flightFilter = {
    ...notDemoNotTest,
    $or: [{ createdAt: { $lt: before } }, { pnr: MOCK_RX }],
  };
  const hotelFilter = {
    ...notDemoNotTest,
    $or: [
      { createdAt: { $lt: before } },
      { hotelCode: /^mock/i }, { confirmationNo: MOCK_RX }, { bookingRefNo: MOCK_RX },
    ],
  };

  const [flights, hotels] = await Promise.all([
    SBTBooking.find(flightFilter).select("_id pnr status totalFare workspaceId createdAt").sort({ createdAt: 1 }).lean(),
    SBTHotelBooking.find(hotelFilter).select("_id confirmationNo hotelCode status totalFare workspaceId createdAt").sort({ createdAt: 1 }).lean(),
  ]);
  log("");
  log(`SBT flight bookings to mark: ${flights.length}`);
  for (const f of flights as any[]) {
    log(`  FLIGHT ${f._id} ${new Date(f.createdAt).toISOString().slice(0, 10)} pnr=${f.pnr || "-"} ${f.status} ₹${f.totalFare ?? 0} ws=${f.workspaceId}`);
  }
  log(`SBT hotel bookings to mark: ${hotels.length}`);
  for (const h of hotels as any[]) {
    log(`  HOTEL  ${h._id} ${new Date(h.createdAt).toISOString().slice(0, 10)} conf=${h.confirmationNo || "-"}${MOCK_RX.test(String(h.hotelCode || "")) ? " [MOCK]" : ""} ${h.status} ₹${h.totalFare ?? 0} ws=${h.workspaceId}`);
  }

  const refIds = [...(flights as any[]), ...(hotels as any[])].map((d) => d._id);
  const travelBookings = refIds.length
    ? await TravelBooking.countDocuments({ reference: { $in: refIds }, isTest: { $ne: true } })
    : 0;
  log(`TravelBooking mirror rows to mark: ${travelBookings}`);

  const paymentFilter = { createdAt: { $lt: before }, isTest: { $ne: true } };
  const payments = await SBTPayment.countDocuments(paymentFilter);
  log(`SBTPayment rows to mark: ${payments}`);

  // Orphans: grouped by Razorpay account so the SBT MID can be told from D2C.
  const orphans = (await PaymentOrphan.find({
    resolvedAt: { $exists: false }, createdAt: { $lt: before }, isTest: { $ne: true },
  }).select("_id razorpayOrderId amount createdAt webhookPayload.account_id").lean()) as any[];
  const orphanAccounts: Record<string, number> = {};
  for (const o of orphans) {
    const acc = String(o.webhookPayload?.account_id || "<none>");
    orphanAccounts[acc] = (orphanAccounts[acc] || 0) + 1;
  }
  const sbtOrphans = orphans.filter((o) => accounts.includes(String(o.webhookPayload?.account_id || "")));
  log("");
  log(`Unresolved PaymentOrphans before cutoff: ${orphans.length}, by Razorpay account:`);
  for (const [acc, n] of Object.entries(orphanAccounts)) {
    log(`  ${acc}: ${n}${accounts.includes(acc) ? "  ← SBT (will mark)" : ""}`);
  }
  if (!accounts.length && orphans.length) {
    log("  (no --sbt-account given — NO orphan will be marked; D2C orphans are real customer money)");
  }
  for (const o of sbtOrphans) {
    log(`  ORPHAN ${o._id} ${new Date(o.createdAt).toISOString().slice(0, 10)} order=${o.razorpayOrderId} amountPaise=${o.amount}`);
  }

  if (apply) {
    if (flights.length) await SBTBooking.updateMany({ _id: { $in: (flights as any[]).map((d) => d._id) } }, { $set: { isTest: true } });
    if (hotels.length) await SBTHotelBooking.updateMany({ _id: { $in: (hotels as any[]).map((d) => d._id) } }, { $set: { isTest: true } });
    if (refIds.length) await TravelBooking.updateMany({ reference: { $in: refIds } }, { $set: { isTest: true } });
    if (payments) await SBTPayment.updateMany(paymentFilter, { $set: { isTest: true } });
    if (sbtOrphans.length) await PaymentOrphan.updateMany({ _id: { $in: sbtOrphans.map((o) => o._id) } }, { $set: { isTest: true } });
    log("");
    log("[mark-sbt-test] APPLIED.");
  } else {
    log("");
    log("[mark-sbt-test] dry run — nothing written. Re-run with --apply to mark.");
  }

  return {
    db, applied: apply, flights: flights.length, hotels: hotels.length, travelBookings, payments,
    orphans: sbtOrphans.length, orphansSkipped: orphans.length - sbtOrphans.length, orphanAccounts,
  };
}

function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  try {
    await markSbtTestData({
      expectDb: argValue("expect-db"),
      before: argValue("before"),
      sbtAccounts: (argValue("sbt-account") || "").split(","),
      apply: process.argv.includes("--apply"),
    });
  } finally {
    await mongoose.connection.close();
  }
}

// Run only when executed directly — importing it (the test) must not connect.
const invokedDirectly = process.argv[1]
  ?.replace(/\\/g, "/")
  .endsWith("scripts/mark-sbt-test-data.ts");

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
