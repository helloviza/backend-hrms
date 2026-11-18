// apps/backend/src/scripts/mark-house-sbt-test-bookings.ts
//
// Travel Spend Phase B, N5 (docs/audits/travel-spend-audit-2026-11.md).
// Imran classified these HOUSE SBT bookings as TEST (2026-11-18). They were
// booked by Plumtrips staff during the TBO certification period and count in
// every all-companies Travel Spend figure.
//
// GROUPS — a booking is marked only if it matches one, and is not already
// isTest and not isDemo (Demo Platform rows keep their own flag). "Booked"
// means bookedAt, else createdAt (the mirror's bookedAt), in IST.
//   A  SBT flights, no customerId (mirror tenant "default"), booked March 2026,
//      booker email @plumtrips.com
//   B  SBT hotels, no customerId, booked March 2026, booker @plumtrips.com
//      (or a booker account that no longer exists — 1 row on 2026-11-18)
//   C  SBT flights booked 1 Apr – 30 Jun 2026 by admin@ / tbocertification@ /
//      neelb@plumtrips.com (neelb's 3: test unless Imran says otherwise)
//   D  SBT hotels booked 1 Apr – 30 Jun 2026 by admin@ / tbocertification@
//      plumtrips.com — every status, incl. the 6 HELD holds
//
// WHAT IT WRITES (--apply only)
//   isTest = true on the selected source bookings. The query-write hook
//   (utils/mirrorResyncHooks.ts) re-syncs their TravelBooking mirror rows;
//   the script re-syncs them again explicitly and checks every mirror row
//   now carries isTest:true.
//
// DRY RUN by default: every driver write is blocked for the whole run.
//
// REQUIRED                 --expect-db=<name>  must equal the connected database
// REQUIRED WITH --apply    --expect-count=<n>  must equal the rows selected
//                          --backup=<file>     source + mirror rows are saved here first
//
//   MONGO_URI=… npx tsx src/scripts/mark-house-sbt-test-bookings.ts --expect-db=<db> [--json=<file>]
//   MONGO_URI=… npx tsx src/scripts/mark-house-sbt-test-bookings.ts --expect-db=<db> --expect-count=<n> --backup=<f> --apply
//
// Reads MONGO_URI from the shell only (no dotenv). No passenger names,
// emails or phone numbers are printed; the booker (a staff account) is.
import mongoose from "mongoose";
import fs from "node:fs";
import SBTBooking, { resyncSBTBookingMirrors } from "../models/SBTBooking.js";
import SBTHotelBooking, { resyncSBTHotelBookingMirrors } from "../models/SBTHotelBooking.js";
import TravelBooking from "../models/TravelBooking.js";
import { blockDriverWrites } from "./resync-travel-booking-mirrors.js";

const ist = (d: string) => new Date(`${d}T00:00:00+05:30`);
export const MARCH = { from: ist("2026-03-01"), to: ist("2026-04-01") };
export const APR_JUN = { from: ist("2026-04-01"), to: ist("2026-07-01") };
const HOUSE_EMAIL = /@plumtrips\.com$/i;
const C_BOOKERS = new Set(["admin@plumtrips.com", "tbocertification@plumtrips.com", "neelb@plumtrips.com"]);
const D_BOOKERS = new Set(["admin@plumtrips.com", "tbocertification@plumtrips.com"]);

export type Group = "A" | "B" | "C" | "D";
export const GROUP_LABEL: Record<Group, string> = {
  A: "March flights, tenant default, HOUSE booker",
  B: "March hotels, tenant default, HOUSE booker",
  C: "Apr–Jun flights by admin@ / tbocertification@ / neelb@",
  D: "Apr–Jun hotels by admin@ / tbocertification@",
};

const inWin = (at: Date, w: { from: Date; to: Date }) => at >= w.from && at < w.to;

/**
 * Pure classification — exported for the test. `booker` is the booker's
 * email, or null when the userId matches no account.
 */
export function classifyHouseTestBooking(kind: "FLIGHT" | "HOTEL", doc: any, booker: string | null): Group | null {
  if (doc.isTest === true || doc.isDemo === true) return null;
  const at = new Date(doc.bookedAt || doc.createdAt);
  if (Number.isNaN(at.getTime())) return null;
  const email = String(booker ?? "").trim().toLowerCase();
  const noCustomer = !String(doc.customerId ?? "").trim();
  if (inWin(at, MARCH) && noCustomer) {
    if (kind === "FLIGHT" && HOUSE_EMAIL.test(email)) return "A";
    if (kind === "HOTEL" && (HOUSE_EMAIL.test(email) || booker === null)) return "B";
  }
  if (inWin(at, APR_JUN)) {
    if (kind === "FLIGHT" && C_BOOKERS.has(email)) return "C";
    if (kind === "HOTEL" && D_BOOKERS.has(email)) return "D";
  }
  return null;
}

export type PickedRow = {
  group: Group; kind: "FLIGHT" | "HOTEL"; id: string; ref: string; bookedAt: string; status: string; fare: number;
  what: string; booker: string;
  mirror: { status: string | null; amount: number; tenantId: string | null; isTest: boolean } | null;
};

const LIVE_CONFIRMED = { status: "CONFIRMED", isDemo: { $ne: true }, isTest: { $ne: true }, isActive: { $ne: false } };

async function liveTotals(excludeRefs: mongoose.Types.ObjectId[]) {
  const sum = async (extra: Record<string, unknown>) => {
    const [r] = await TravelBooking.aggregate([
      { $match: { ...LIVE_CONFIRMED, ...extra, reference: { $nin: excludeRefs } } },
      { $group: { _id: null, spend: { $sum: "$amount" }, trips: { $sum: 1 } } },
    ]);
    return { spend: Math.round((r?.spend ?? 0) * 100) / 100, trips: r?.trips ?? 0 };
  };
  // Months as the dashboard's calendar-month preset sends them (UTC days).
  const month = (m: string, last: string) => sum({ bookedAt: { $gte: new Date(`${m}-01T00:00:00Z`), $lte: new Date(`${m}-${last}T23:59:59Z`) } });
  return {
    "All time": await sum({}),
    "Mar 2026": await month("2026-03", "31"),
    "Apr 2026": await month("2026-04", "30"),
    "May 2026": await month("2026-05", "31"),
    "Jun 2026": await month("2026-06", "30"),
  };
}

export async function markHouseSbtTestBookings(opts: {
  expectDb?: string; expectCount?: number; backup?: string; apply?: boolean; log?: (l: string) => void;
}) {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  const apply = opts.apply === true;
  log(`[mark-house-sbt-test] db=${db} ${apply ? "APPLY — WRITING" : "DRY RUN — nothing written"}`);

  const notFlagged = { isTest: { $ne: true }, isDemo: { $ne: true } };
  const [flights, hotels] = await Promise.all([
    SBTBooking.find(notFlagged).select("_id pnr status totalFare userId bookedAt createdAt customerId isTest isDemo origin destination").lean(),
    SBTHotelBooking.find(notFlagged).select("_id confirmationNo bookingRefNo status totalFare netAmount userId bookedAt createdAt customerId isTest isDemo hotelName cityName").lean(),
  ]) as [any[], any[]];
  const userIds = [...new Set([...flights, ...hotels].map((d) => String(d.userId)))].filter((x) => mongoose.isValidObjectId(x));
  const users = await mongoose.connection.db!.collection("users")
    .find({ _id: { $in: userIds.map((x) => new mongoose.Types.ObjectId(x)) } }, { projection: { email: 1 } }).toArray();
  const emailOf = new Map(users.map((u: any) => [String(u._id), String(u.email || "")]));
  const bookerOf = (d: any) => (emailOf.has(String(d.userId)) ? emailOf.get(String(d.userId))! : null);

  const picked: { kind: "FLIGHT" | "HOTEL"; group: Group; doc: any }[] = [];
  for (const d of flights) { const g = classifyHouseTestBooking("FLIGHT", d, bookerOf(d)); if (g) picked.push({ kind: "FLIGHT", group: g, doc: d }); }
  for (const d of hotels) { const g = classifyHouseTestBooking("HOTEL", d, bookerOf(d)); if (g) picked.push({ kind: "HOTEL", group: g, doc: d }); }
  picked.sort((a, b) => a.group.localeCompare(b.group) || +new Date(a.doc.bookedAt || a.doc.createdAt) - +new Date(b.doc.bookedAt || b.doc.createdAt));

  const ids = picked.map((p) => p.doc._id as mongoose.Types.ObjectId);
  const mirrors = new Map((await TravelBooking.find({ reference: { $in: ids } })
    .select("reference status amount tenantId isTest").lean() as any[]).map((m) => [String(m.reference), m]));

  const rows: PickedRow[] = picked.map(({ kind, group, doc: d }) => {
    const m = mirrors.get(String(d._id));
    return {
      group, kind, id: String(d._id),
      ref: kind === "FLIGHT" ? d.pnr || "-" : d.confirmationNo || d.bookingRefNo || "-",
      bookedAt: new Date(d.bookedAt || d.createdAt).toISOString(), status: d.status,
      fare: d.totalFare || d.netAmount || 0,
      what: kind === "FLIGHT" ? `${d.origin?.code || "?"}-${d.destination?.code || "?"}` : `${d.hotelName || "?"} / ${d.cityName || "?"}`,
      booker: bookerOf(d) ?? "(no account)",
      mirror: m ? { status: m.status, amount: m.amount || 0, tenantId: m.tenantId ?? null, isTest: m.isTest === true } : null,
    };
  });

  const summary: Record<string, { rows: number; byMirrorStatus: Record<string, { rows: number; amount: number }> }> = {};
  for (const r of rows) {
    const g = (summary[r.group] ??= { rows: 0, byMirrorStatus: {} });
    g.rows += 1;
    const k = r.mirror?.status ?? "NO MIRROR";
    const c = (g.byMirrorStatus[k] ??= { rows: 0, amount: 0 });
    c.rows += 1;
    c.amount = Math.round((c.amount + (r.mirror?.amount ?? 0)) * 100) / 100;
  }

  for (const g of ["A", "B", "C", "D"] as Group[]) {
    const list = rows.filter((r) => r.group === g);
    log(`\nGroup ${g} — ${GROUP_LABEL[g]}: ${list.length}`);
    for (const r of list) {
      log(`  ${r.bookedAt.slice(0, 10)} ${r.kind.padEnd(6)} ${r.id} ${r.ref} ${r.what} ${r.status} ₹${r.fare} booker=${r.booker} mirror=${r.mirror ? `${r.mirror.status}/₹${r.mirror.amount}/tenant=${r.mirror.tenantId}` : "MISSING"}`);
    }
  }
  log(`\nSummary (mirror status → rows, amount):`);
  for (const [g, v] of Object.entries(summary)) {
    log(`  ${g}: ${v.rows} — ${Object.entries(v.byMirrorStatus).map(([k, c]) => `${k} ${c.rows} (₹${c.amount})`).join(", ")}`);
  }
  log(`  TOTAL selected: ${rows.length}`);

  const before = await liveTotals([]);
  const after = await liveTotals(ids);
  log(`\nLive Travel Spend (all companies, CONFIRMED):`);
  for (const k of Object.keys(before) as (keyof typeof before)[]) {
    log(`  ${k.padEnd(9)} ₹${before[k].spend} / ${before[k].trips} trips → ₹${after[k].spend} / ${after[k].trips} trips`);
  }

  let written: { flagged: number; synced: number; failed: number; mirrorsTest: number } | null = null;
  if (apply) {
    if (opts.expectCount == null || opts.expectCount !== rows.length) {
      throw new Error(`REFUSING: --expect-count=${opts.expectCount ?? "<missing>"} but ${rows.length} rows are selected.`);
    }
    if (!opts.backup) throw new Error("REFUSING: --backup=<file.json> is required with --apply.");
    const mirrorRows = await TravelBooking.find({ reference: { $in: ids } }).lean();
    fs.writeFileSync(opts.backup, JSON.stringify({ at: new Date().toISOString(), db, picked, mirrors: mirrorRows }, null, 2));
    log(`\nBackup written: ${opts.backup}`);
    const fIds = picked.filter((p) => p.kind === "FLIGHT").map((p) => p.doc._id);
    const hIds = picked.filter((p) => p.kind === "HOTEL").map((p) => p.doc._id);
    const fr = fIds.length ? await SBTBooking.updateMany({ _id: { $in: fIds }, isTest: { $ne: true } }, { $set: { isTest: true } }) : { modifiedCount: 0 };
    const hr = hIds.length ? await SBTHotelBooking.updateMany({ _id: { $in: hIds }, isTest: { $ne: true } }, { $set: { isTest: true } }) : { modifiedCount: 0 };
    const fs1 = await resyncSBTBookingMirrors(fIds);
    const hs1 = await resyncSBTHotelBookingMirrors(hIds);
    const mirrorsTest = await TravelBooking.countDocuments({ reference: { $in: ids }, isTest: true });
    written = { flagged: fr.modifiedCount + hr.modifiedCount, synced: fs1.synced + hs1.synced, failed: fs1.failed + hs1.failed, mirrorsTest };
    log(`APPLIED: ${JSON.stringify(written)}`);
    if (mirrorsTest !== ids.length) throw new Error(`VERIFY FAILED: ${mirrorsTest}/${ids.length} mirror rows carry isTest.`);
  } else {
    log(`\nDRY RUN — nothing written.`);
  }
  return { db, apply, rows, summary, totalsBefore: before, totalsAfter: after, written };
}

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
  const apply = process.argv.includes("--apply");
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  console.log(`target host ${uri.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, "").split("/")[0]}`);
  if (!apply) blockDriverWrites();
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const report = await markHouseSbtTestBookings({
      expectDb: arg("expect-db"),
      expectCount: arg("expect-count") != null ? Number(arg("expect-count")) : undefined,
      backup: arg("backup"),
      apply,
    });
    const json = arg("json");
    if (json) fs.writeFileSync(json, JSON.stringify(report, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && /mark-house-sbt-test-bookings\.(ts|js)$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((e) => { console.error(e?.message || e); process.exit(1); });
}
