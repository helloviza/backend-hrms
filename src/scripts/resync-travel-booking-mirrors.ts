// apps/backend/src/scripts/resync-travel-booking-mirrors.ts
//
// One-off repair of the TravelBooking mirror (the data behind Travel Spend)
// after the query-write hooks landed (utils/mirrorResyncHooks.ts; audit
// docs/audits/travel-spend-audit-2026-11.md N1 + N4). Before them, writes
// that bypassed save() left mirror rows stale:
//   - ManualBooking invoiced via updateMany while PENDING / CANCELLED → mirror
//     kept the old status (N1); 9 May bookings were never mirrored at all.
//   - SBTHotelBooking / SBTBooking status + fare via findOneAndUpdate /
//     updateOne → mirror PENDING / wrong fare / demo flag missing (N4).
//
// For every source booking it builds the row the live sync would write
// (build*Mirror — the same code), compares it with the current mirror row
// and selects rows whose dashboard-critical fields differ (status, amount,
// tenantId, isActive, isDemo, isTest) or that have no mirror row. --apply
// re-syncs exactly those rows through the live sync functions, so a repaired
// row is identical to one written live. Other drift (e.g. destinationCity)
// is counted but not targeted.
//
// DRY RUN by default: every driver write method is blocked for the whole
// run, and the report prints each targeted row before → after plus the
// Travel Spend totals (all-time, Oct 2026, Nov 2026) before and after.
//
//   MONGO_URI=… npx tsx src/scripts/resync-travel-booking-mirrors.ts --expect-db=<db> [--include-analytics] [--apply] [--json=<file>]
//
// --include-analytics (Phase B backfill, 2026-11-18): ALSO target rows whose
// analytics fields differ — destinationCity / destinationCountry /
// isInternational and the metadata blob (legs' times, flat flight no.,
// carrierShares, departTimeIST). The report then adds the Travel Spend
// Phase B panels before → after: Domestic / International, top airlines and
// departure-time coverage (services/flightInsights.ts, the endpoint's code).
//
// It reads MONGO_URI from the shell only (no dotenv): run it under a
// sanitised env with just MONGO_URI set.
import mongoose from "mongoose";
import fs from "node:fs";
import { buildManualBookingMirror, resyncManualBookingMirrors } from "../models/ManualBooking.js";
import { buildSBTBookingMirror, resyncSBTBookingMirrors } from "../models/SBTBooking.js";
import { buildSBTHotelBookingMirror, resyncSBTHotelBookingMirrors } from "../models/SBTHotelBooking.js";
import { computeFlightInsights, type FlightInsights } from "../services/flightInsights.js";

export const CRITICAL_FIELDS = ["status", "amount", "tenantId", "isActive", "isDemo", "isTest"] as const;
export const COMPARED_FIELDS = [
  ...CRITICAL_FIELDS,
  "service", "userId", "paymentMode", "bookedAt", "travelDate", "travelDateEnd", "workspaceId",
  "destinationCity", "destinationCountry", "isInternational", "travellerName", "createdByDemoUser",
] as const;

/** Targeted only with --include-analytics. "metadata" is compared as a whole. */
export const ANALYTICS_FIELDS = ["destinationCity", "destinationCountry", "isInternational", "metadata"] as const;

type Source = "ManualBooking" | "SBTBooking" | "SBTHotelBooking";

export type RowDiff = {
  source: Source;
  id: string;
  ref: string; // bookingRef / pnr / TBO ref — for humans
  sourceStatus: string;
  missing: boolean;
  changes: Record<string, { before: unknown; after: unknown }>;
  before: { status: string | null; amount: number; counted: boolean; bookedAt: string | null };
  after: { status: string; amount: number; counted: boolean; bookedAt: string | null };
  retiresConciergeRow?: { id: string; amount: number; counted: boolean; bookedAt: string | null };
};

export type Totals = { spend: number; trips: number; cancelledSpend: number; pendingTrips: number };
export type Window = { label: string; from: Date | null; to: Date | null };

export type ResyncReport = {
  db: string;
  host: string;
  apply: boolean;
  scanned: Record<Source, number>;
  targeted: Record<Source, number>;
  categories: Record<string, { rows: number; beforeAmount: number; afterAmount: number }>;
  nonCriticalDrift: Record<string, number>;
  rows: RowDiff[];
  totals: Record<string, { before: Totals; after: Totals }>;
  insights: Record<string, { before: FlightInsights; after: FlightInsights }> | null;
  written: Record<Source, { synced: number; failed: number; missing: number }> | null;
};

export const WINDOWS: Window[] = [
  { label: "All time", from: null, to: null },
  // What the fixed "This month" preset sends: calendar days, to = T23:59:59Z
  // (admin.unified.billing.ts buildScopedMatch).
  { label: "Oct 2026", from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-31T23:59:59Z") },
  { label: "Nov 2026", from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-30T23:59:59Z") },
];

export const INSIGHT_WINDOWS: Window[] = [
  { label: "All time", from: null, to: null },
  { label: "Since 1 Jul 2026", from: new Date("2026-07-01T00:00:00Z"), to: null },
];

/* ── comparison helpers ── */
function norm(v: unknown): unknown {
  if (v === undefined || v === null || v === "") return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && v && typeof (v as any).toHexString === "function") return (v as any).toHexString();
  if (typeof v === "number") return Math.round(v * 100) / 100;
  return v;
}
const isoOrNull = (v: unknown) => (v ? new Date(v as any).toISOString() : null);

/** Does this row count in Total Spend's live filter (buildScopedMatch)? */
const isLive = (r: any) => r && r.isDemo !== true && r.isTest !== true && r.isActive !== false;

/** Key-order-independent JSON (dates as ISO), for comparing the metadata blob. */
export function stableJson(v: unknown): string {
  const walk = (x: any): any => {
    if (x === undefined) return null;
    if (x instanceof Date) return x.toISOString();
    if (x && typeof x === "object" && typeof x.toHexString === "function") return x.toHexString();
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => [k, walk(x[k])]));
    return x;
  };
  return JSON.stringify(walk(v ?? {}));
}

function diffRow(expected: Record<string, any>, current: Record<string, any> | null, analytics = false) {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  if (analytics) {
    for (const f of ANALYTICS_FIELDS) {
      if (!(f in expected)) continue;
      if (f === "metadata") {
        if (stableJson(expected.metadata) !== stableJson(current?.metadata)) changes.metadata = { before: "(differs)", after: "(rebuilt)" };
        continue;
      }
      const a = norm(expected[f]);
      const b = norm(current ? current[f] : undefined);
      if (a !== b) changes[f] = { before: b, after: a };
    }
  }
  for (const f of COMPARED_FIELDS) {
    if (analytics && (ANALYTICS_FIELDS as readonly string[]).includes(f)) continue;
    if (!(f in expected)) continue; // sync doesn't write it (e.g. workspaceId unresolved) → apply won't change it
    let after = expected[f];
    if (f === "isActive" && after === undefined) after = true;
    let before = current ? current[f] : undefined;
    if (current && f === "isActive" && before === undefined) before = true; // schema default
    if (current && (f === "isDemo" || f === "isTest" || f === "createdByDemoUser") && before === undefined) before = false;
    const a = norm(after);
    const b = norm(before);
    if (a !== b) changes[f] = { before: b, after: a };
  }
  return changes;
}

function inWindow(bookedAt: string | null, w: Window): boolean {
  if (!w.from && !w.to) return true;
  if (!bookedAt) return false;
  const t = new Date(bookedAt).getTime();
  return (!w.from || t >= w.from.getTime()) && (!w.to || t <= w.to.getTime());
}

async function currentTotals(mirror: any, w: Window): Promise<Totals> {
  const match: any = { isDemo: { $ne: true }, isTest: { $ne: true }, isActive: { $ne: false } };
  if (w.from || w.to) match.bookedAt = { ...(w.from ? { $gte: w.from } : {}), ...(w.to ? { $lte: w.to } : {}) };
  const rows = await mirror.aggregate([{ $match: match }, { $group: { _id: "$status", n: { $sum: 1 }, amt: { $sum: "$amount" } } }]).toArray();
  const by = Object.fromEntries(rows.map((r: any) => [r._id, r]));
  return {
    spend: by.CONFIRMED?.amt ?? 0,
    trips: by.CONFIRMED?.n ?? 0,
    cancelledSpend: by.CANCELLED?.amt ?? 0,
    pendingTrips: by.PENDING?.n ?? 0,
  };
}

/** Apply one row's contribution (sign ±1) to a totals bucket. */
function bump(t: Totals, status: string | null, amount: number, sign: 1 | -1) {
  if (status === "CONFIRMED") { t.spend += sign * amount; t.trips += sign; }
  else if (status === "CANCELLED") t.cancelledSpend += sign * amount;
  else if (status === "PENDING") t.pendingTrips += sign;
}

/** Ids → the same refs the dashboard shows. */
function refOf(source: Source, doc: any): string {
  if (source === "ManualBooking") return String(doc.bookingRef || "");
  if (source === "SBTBooking") return String(doc.pnr || doc.bookingId || "");
  return String(doc.bookingRefNo || doc.confirmationNo || doc.clientReferenceId || doc.hotelName || "");
}

export async function resyncTravelBookingMirrors(opts: {
  apply: boolean;
  expectDb?: string;
  /** Also target analytics-field drift and report the Phase B panels. */
  includeAnalytics?: boolean;
  log?: (line: string) => void;
}): Promise<ResyncReport> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const conn = mongoose.connection;
  const db = conn.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  const host = (conn as any).host || "";
  const analytics = opts.includeAnalytics === true;
  log(`host ${host} · db ${db} · ${opts.apply ? "APPLY" : "DRY RUN"}${analytics ? " · include analytics" : ""}`);

  const mirror = conn.collection("travelbookings");
  const mirrorRows = await mirror.find({ referenceModel: { $in: ["ManualBooking", "SBTBooking", "SBTHotelBooking"] } }).toArray();
  const mirrorByRef = new Map(mirrorRows.map((r: any) => [String(r.reference), r]));

  const report: ResyncReport = {
    db, host, apply: opts.apply,
    scanned: { ManualBooking: 0, SBTBooking: 0, SBTHotelBooking: 0 },
    targeted: { ManualBooking: 0, SBTBooking: 0, SBTHotelBooking: 0 },
    categories: {}, nonCriticalDrift: {}, rows: [], totals: {}, insights: null, written: null,
  };
  // ref → the row the live sync would write; used for the insights "after".
  const expectedByRef = new Map<string, Record<string, any>>();

  const sources: { source: Source; coll: string; filter: any; build: (d: any) => Promise<any> | any }[] = [
    { source: "ManualBooking", coll: "manualbookings", filter: { source: { $nin: ["SBT", "SBT_AUTO"] } }, build: buildManualBookingMirror },
    { source: "SBTBooking", coll: "sbtbookings", filter: {}, build: buildSBTBookingMirror },
    { source: "SBTHotelBooking", coll: "sbthotelbookings", filter: {}, build: buildSBTHotelBookingMirror },
  ];

  for (const s of sources) {
    const docs = await conn.collection(s.coll).find(s.filter).toArray();
    report.scanned[s.source] = docs.length;
    for (const doc of docs) {
      const expected = await s.build(doc);
      if (!expected) continue;
      expectedByRef.set(String(doc._id), expected);
      const current = mirrorByRef.get(String(doc._id)) ?? null;
      const changes = diffRow(expected, current, analytics);
      const critical = !current || CRITICAL_FIELDS.some((f) => f in changes)
        || (analytics && ANALYTICS_FIELDS.some((f) => f in changes));
      if (!critical) {
        for (const f of Object.keys(changes)) report.nonCriticalDrift[`${s.source}.${f}`] = (report.nonCriticalDrift[`${s.source}.${f}`] ?? 0) + 1;
        continue;
      }
      const afterActive = expected.isActive === undefined ? true : expected.isActive;
      const row: RowDiff = {
        source: s.source,
        id: String(doc._id),
        ref: refOf(s.source, doc),
        sourceStatus: String(doc.status ?? ""),
        missing: !current,
        changes,
        before: {
          status: current?.status ?? null,
          amount: Number(current?.amount) || 0,
          counted: !!current && isLive(current),
          bookedAt: isoOrNull(current?.bookedAt),
        },
        after: {
          status: expected.status,
          amount: Number(expected.amount) || 0,
          counted: isLive({ ...expected, isActive: afterActive }),
          bookedAt: isoOrNull(expected.bookedAt),
        },
      };
      // The live ManualBooking sync also retires the request-keyed CONCIERGE row.
      if (s.source === "ManualBooking" && doc.source === "ADMIN_QUEUE" && doc.sourceBookingId) {
        const c: any = await mirror.findOne({ reference: doc.sourceBookingId, referenceModel: "ApprovalRequest", source: "CONCIERGE", isActive: { $ne: false } });
        if (c) row.retiresConciergeRow = { id: String(c._id), amount: Number(c.amount) || 0, counted: isLive(c) && c.status === "CONFIRMED", bookedAt: isoOrNull(c.bookedAt) };
      }
      report.rows.push(row);
      report.targeted[s.source] += 1;
      const cat = row.missing
        ? `${s.source}: not mirrored (source ${row.sourceStatus})`
        : CRITICAL_FIELDS.some((f) => f in changes)
          ? `${s.source}: source ${row.sourceStatus} → mirror ${row.before.status}${changes.status ? "" : " (" + Object.keys(changes).filter((f) => (CRITICAL_FIELDS as readonly string[]).includes(f)).join(", ") + ")"}`
          : `${s.source}: analytics only (${Object.keys(changes).filter((f) => (ANALYTICS_FIELDS as readonly string[]).includes(f)).join(", ")})`;
      const c = (report.categories[cat] ??= { rows: 0, beforeAmount: 0, afterAmount: 0 });
      c.rows += 1;
      c.beforeAmount += row.before.amount;
      c.afterAmount += row.after.amount;
    }
  }

  // Totals before (live mirror) and after (targeted rows swapped for their rebuilt values).
  for (const w of WINDOWS) {
    const before = await currentTotals(mirror, w);
    const after = { ...before };
    for (const r of report.rows) {
      if (r.before.counted && inWindow(r.before.bookedAt, w)) bump(after, r.before.status, r.before.amount, -1);
      if (r.after.counted && inWindow(r.after.bookedAt, w)) bump(after, r.after.status, r.after.amount, 1);
      const cr = r.retiresConciergeRow;
      if (cr?.counted && inWindow(cr.bookedAt, w)) bump(after, "CONFIRMED", cr.amount, -1);
    }
    report.totals[w.label] = { before, after };
  }

  if (analytics) {
    // Every live CONFIRMED mirror row, as it is now and as it would be after
    // the apply (targeted rows replaced by their rebuilt values, new rows
    // added, retired CONCIERGE rows dropped).
    const targeted = new Set(report.rows.map((r) => r.id));
    const retired = new Set(report.rows.map((r) => r.retiresConciergeRow?.id).filter(Boolean) as string[]);
    const otherRows = await mirror.find({ referenceModel: { $nin: ["ManualBooking", "SBTBooking", "SBTHotelBooking"] } }).toArray();
    const afterRows: any[] = [];
    for (const m of mirrorRows as any[]) {
      const e = targeted.has(String(m.reference)) ? expectedByRef.get(String(m.reference)) : null;
      afterRows.push(e ? { ...m, ...e } : m);
    }
    for (const r of report.rows) if (r.missing) afterRows.push(expectedByRef.get(r.id));
    const afterOther = (otherRows as any[]).filter((m) => !retired.has(String(m._id)));
    const live = (rows: any[], w: Window) => rows.filter((r) => r && r.status === "CONFIRMED" && isLive(r) && inWindow(isoOrNull(r.bookedAt), w));
    report.insights = {};
    for (const w of INSIGHT_WINDOWS) {
      report.insights[w.label] = {
        before: computeFlightInsights(live([...mirrorRows, ...otherRows], w)),
        after: computeFlightInsights(live([...afterRows, ...afterOther], w)),
      };
    }
  }

  if (opts.apply) {
    const idsOf = (src: Source) => report.rows.filter((r) => r.source === src).map((r) => new mongoose.Types.ObjectId(r.id));
    report.written = {
      ManualBooking: await resyncManualBookingMirrors(idsOf("ManualBooking")),
      SBTBooking: await resyncSBTBookingMirrors(idsOf("SBTBooking")),
      SBTHotelBooking: await resyncSBTHotelBookingMirrors(idsOf("SBTHotelBooking")),
    };
  }
  return report;
}

/* ── printing ── */
function printInsights(ins: NonNullable<ResyncReport["insights"]>, log: (l: string) => void) {
  const lakh = (n: number) => "₹" + (n / 1e5).toFixed(2) + " L";
  for (const [label, { before, after }] of Object.entries(ins)) {
    log("\n── Phase B panels · " + label + " (live CONFIRMED) ──");
    for (const svc of ["FLIGHT", "HOTEL"] as const) {
      const f = (d: FlightInsights) => {
        const x = d.domesticInternational[svc];
        return "dom " + x.domestic.count + " " + lakh(x.domestic.spend) + " · intl " + x.international.count + " " + lakh(x.international.spend) + " · unknown " + x.unknown.count + " " + lakh(x.unknown.spend);
      };
      log("  " + svc.padEnd(6) + " before  " + f(before));
      log("  " + "".padEnd(6) + " after   " + f(after));
    }
    const air = (d: FlightInsights) => d.airlines.rows.map((a) => a.name + " " + a.countPct + "%/" + a.spendPct + "%").join(" · ");
    log("  Airlines (count% / spend%) before: " + air(before));
    log("  Airlines (count% / spend%) after:  " + air(after));
    const cov = (d: FlightInsights) => {
      const t = d.departureSlots;
      const p = t.total ? ((100 * t.timed) / t.total).toFixed(1) : "0";
      return t.timed + " of " + t.total + " flights (" + p + "%, " + (t.fromTicket ?? 0) + " from ticket) · " + t.slots.map((x) => x.slot + " " + x.pct + "%").join(" ");
    };
    log("  Time slots before: " + cov(before));
    log("  Time slots after:  " + cov(after));
    // Cabin class (Phase B additions): real cabins only; fare codes stay unknown.
    const cab = (d: FlightInsights) => {
      const c = d.cabins;
      if (!c) return "(not in mirror yet)";
      const p = c.total ? ((100 * c.known) / c.total).toFixed(1) : "0";
      return c.known + " of " + c.total + " flights (" + p + "%, " + c.fromTicket + " from ticket) · " + c.rows.map((x) => x.cabin + " " + x.count).join(" · ");
    };
    log("  Cabin before: " + cab(before));
    log("  Cabin after:  " + cab(after));
  }
}
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const fmt = (v: unknown) => (v === null ? "∅" : typeof v === "number" ? String(v) : String(v));

export function printReport(r: ResyncReport, log: (l: string) => void = console.log) {
  log(`\nscanned  ManualBooking ${r.scanned.ManualBooking} · SBTBooking ${r.scanned.SBTBooking} · SBTHotelBooking ${r.scanned.SBTHotelBooking}`);
  log(`targeted ManualBooking ${r.targeted.ManualBooking} · SBTBooking ${r.targeted.SBTBooking} · SBTHotelBooking ${r.targeted.SBTHotelBooking}`);
  log(`\n── categories ──`);
  for (const [k, v] of Object.entries(r.categories).sort((a, b) => b[1].rows - a[1].rows)) {
    log(`  ${String(v.rows).padStart(4)}  ${k}   amount ${inr(v.beforeAmount)} → ${inr(v.afterAmount)}`);
  }
  log(`\n── rows (before → after) ──`);
  for (const row of r.rows) {
    const ch = Object.entries(row.changes).map(([f, c]) => `${f} ${fmt(c.before)}→${fmt(c.after)}`).join("; ");
    const cr = row.retiresConciergeRow ? ` · retires CONCIERGE ${row.retiresConciergeRow.id} (${inr(row.retiresConciergeRow.amount)})` : "";
    log(`  ${row.source.padEnd(15)} ${row.ref.padEnd(18)} ${row.id}  src ${row.sourceStatus.padEnd(14)} ${row.missing ? "[NEW ROW] " : ""}${ch}${cr}`);
  }
  log(`\n── not targeted (non-critical drift only) ──`);
  const nc = Object.entries(r.nonCriticalDrift);
  if (!nc.length) log("  none");
  for (const [k, n] of nc.sort((a, b) => b[1] - a[1])) log(`  ${String(n).padStart(4)}  ${k}`);
  log(`\n── Travel Spend totals (GLOBAL, bookedAt, live rows) ──`);
  for (const [label, { before, after }] of Object.entries(r.totals)) {
    const d = after.spend - before.spend;
    log(`  ${label.padEnd(9)} Total Spend ${inr(before.spend)} → ${inr(after.spend)} (${d >= 0 ? "+" : ""}${inr(d)}) · trips ${before.trips} → ${after.trips} · cancelled ${inr(before.cancelledSpend)} → ${inr(after.cancelledSpend)} · pending ${before.pendingTrips} → ${after.pendingTrips}`);
  }
  if (r.insights) printInsights(r.insights, log);
  if (r.written) log(`\nwritten ${JSON.stringify(r.written)}`);
  else log(`\nDRY RUN — nothing written. Re-run with --apply to write.`);
}

/** Make every driver write throw (dry-run safety net for a prod run). */
export function blockDriverWrites() {
  const proto: any = (mongoose as any).mongo.Collection.prototype;
  for (const m of ["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany",
    "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete", "bulkWrite", "createIndex", "createIndexes", "drop", "dropIndex", "rename"]) {
    proto[m] = function () { throw new Error(`WRITE BLOCKED (dry run): ${m} on ${this.collectionName}`); };
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const includeAnalytics = process.argv.includes("--include-analytics");
  const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const jsonOut = process.argv.find((a) => a.startsWith("--json="))?.split("=").slice(1).join("=");
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const hostPart = uri.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, "").split("/")[0];
  console.log(`target host ${hostPart}`);
  if (!apply) blockDriverWrites();
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const report = await resyncTravelBookingMirrors({ apply, expectDb, includeAnalytics });
    printReport(report);
    if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && /resync-travel-booking-mirrors\.(ts|js)$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((e) => { console.error(e?.message || e); process.exit(1); });
}
