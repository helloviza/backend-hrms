// apps/backend/src/scripts/report-sbt-payment-reconciliation.ts
//
// ══════════════════════════════════════════════════════════════════════
// READ-ONLY report: for every SBT flight and hotel booking, what the customer
// was charged and what payment evidence we hold for it.
//
// WHAT WE HOLD TODAY (and why the verdicts are what they are)
//   - Every payment field on a booking was written from the BROWSER at
//     /bookings/save: totalFare, paymentMode, paymentStatus, razorpayOrderId,
//     razorpayPaymentId / paymentId, razorpayAmount. None is re-checked on the
//     server. So a matching pair here only proves the browser was consistent
//     with itself — a tampered checkout sets totalFare AND the order amount
//     to ₹1 together. The Razorpay dashboard is the only source of what was
//     actually captured: match the CSV this writes against its export.
//   - razorpayAmount is the Razorpay ORDER amount in PAISE (SBTPaymentMode
//     stores create-order's `amount`, which Razorpay returns in paise).
//   - Hotels: /bookings/save overwrites paymentId with "" (the browser sends
//     razorpayPaymentId, which is not a hotel schema path), so most hotel
//     rows carry only razorpayOrderId.
//   - "Business wallet" (paymentMode = official) has no balance: it is a
//     monthly spend counter on CustomerWorkspace.sbtOfficialBooking. Bookings
//     made through the checkout (services/sbtFulfil.ts) reserve it BEFORE TBO
//     and leave a DEBIT in SBTWalletLedger → OK. Older official bookings have no
//     ledger entry → WALLET_NOT_DEBITED. The per-workspace table compares this
//     month's official bookings with the counter.
//   - netAmount (supplier net) comes from the TBO response the browser posted
//     (flights) or the browser's bookingPayload (hotels). Charged < net is the
//     strongest signal of an edited amount, so it is its own verdict.
//
// VERDICTS (one per booking)
//   SKIPPED_TEST        internal test data (isTest — scripts/mark-sbt-test-data.ts)
//   SKIPPED_NOT_BOOKED  supplier never booked/ticketed it (failed, held, pending)
//   NO_PAYMENT_RECORD   personal booking with no Razorpay order or payment id
//   AMOUNT_MISMATCH     order amount ≠ totalFare (both in rupees)
//   BELOW_COST          totalFare < supplier net (we paid TBO more than we took)
//   WALLET_NOT_DEBITED  official booking — no wallet ledger entry exists
//   OK                  personal, order amount == totalFare, not below cost
// FLAGS (any number per booking)
//   SHARED_ORDER / SHARED_PAYMENT  the same Razorpay id is on >1 booking
//   ORPHAN_ON_FILE                 a PaymentOrphan row exists for the order
//   AMOUNT_IN_RUPEES               razorpayAmount equals totalFare, not ×100
//   DEMO                           isDemo booking (counted, never refunded)
//
// --expect-db=<name> is REQUIRED and must equal the database the URI
// connects to, or the script refuses before reading a row. It never writes to
// the database. It writes ONE local CSV (--csv=<path>, default
// ./sbt-payment-recon-<db>-<YYYY-MM-DD>.csv) for matching against a Razorpay
// dashboard export by order id / payment id.
//
// USAGE
//   npx tsx --env-file=.env src/scripts/report-sbt-payment-reconciliation.ts --expect-db=plumbox_dev
//   npx tsx --env-file=.env src/scripts/report-sbt-payment-reconciliation.ts --expect-db=plumbox_dev --csv=out.csv
//
// No emails or passenger names are printed or written.
// ══════════════════════════════════════════════════════════════════════

import "dotenv/config";
import { writeFileSync } from "fs";
import mongoose from "mongoose";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import PaymentOrphan from "../models/PaymentOrphan.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import SBTPayment from "../models/SBTPayment.js";
import SBTWalletLedger from "../models/SBTWalletLedger.js";

export type Verdict =
  | "OK"
  | "NO_PAYMENT_RECORD"
  | "AMOUNT_MISMATCH"
  | "BELOW_COST"
  | "WALLET_NOT_DEBITED"
  | "SKIPPED_NOT_BOOKED"
  | "SKIPPED_TEST";

export type Row = {
  product: "FLIGHT" | "HOTEL";
  id: string;
  workspaceId: string;
  bookedAt: string;
  ref: string; // PNR (flight) / confirmation no (hotel)
  status: string;
  paymentMode: string;
  paymentStatus: string; // browser-written, shown not trusted
  totalFare: number; // rupees, charged to the customer
  netAmount: number; // rupees, supplier net (0 = unknown)
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpayAmountPaise: number;
  verdict: Verdict;
  flags: string[];
};

export type Options = {
  expectDb: string | undefined;
  csvPath?: string;
  log?: (line: string) => void;
};

export type Report = {
  db: string;
  rows: Row[];
  counts: Record<Verdict, number>;
  orphansWithoutBooking: number;
  csvPath: string;
};

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown) => (v == null ? "" : String(v));

/** Was this booking actually booked at the supplier (so someone owes us)? */
export function wasBooked(product: "FLIGHT" | "HOTEL", doc: any): boolean {
  if (product === "FLIGHT") {
    return doc?.ticketingStatus === "TICKETED" || doc?.status === "CONFIRMED" || doc?.status === "REISSUED"
      || (doc?.status === "CANCELLED" && doc?.ticketingStatus === "TICKETED");
  }
  if (doc?.status === "HELD" || doc?.status === "FAILED" || doc?.status === "EXPIRED" || doc?.status === "ORPHAN_CLEANED") return false;
  if (doc?.status === "PENDING") return false;
  return doc?.isVouchered === true || ["CONFIRMED", "CANCELLED", "CANCEL_PENDING", "CLOSED"].includes(doc?.status);
}

/** The verdict for one booking, from its stored fields only. Pure — the test
 *  and the report share it. */
export function classify(product: "FLIGHT" | "HOTEL", doc: any): { verdict: Verdict; flags: string[] } {
  const flags: string[] = [];
  if (doc?.isDemo === true) flags.push("DEMO");
  if (doc?.isTest === true) return { verdict: "SKIPPED_TEST", flags: [...flags, "TEST"] };
  if (!wasBooked(product, doc)) return { verdict: "SKIPPED_NOT_BOOKED", flags };

  const totalFare = num(doc?.totalFare);
  const net = num(doc?.netAmount);
  const paise = num(doc?.razorpayAmount);

  if (doc?.paymentMode === "official") {
    if (net > 0 && totalFare + 0.5 < net) flags.push("BELOW_COST");
    return { verdict: "WALLET_NOT_DEBITED", flags };
  }

  const orderId = str(doc?.razorpayOrderId);
  const paymentId = str(product === "FLIGHT" ? doc?.razorpayPaymentId : doc?.paymentId);
  if (!orderId && !paymentId) return { verdict: "NO_PAYMENT_RECORD", flags };

  if (paise > 0) {
    const inPaise = Math.round(totalFare * 100);
    if (paise === Math.round(totalFare)) flags.push("AMOUNT_IN_RUPEES");
    else if (Math.abs(paise - inPaise) > 100) return { verdict: "AMOUNT_MISMATCH", flags };
  }
  if (net > 0 && totalFare + 0.5 < net) return { verdict: "BELOW_COST", flags };
  return { verdict: "OK", flags };
}

function csvCell(v: unknown): string {
  const s = str(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Row[]): string {
  const head = [
    "product", "bookingDocId", "workspaceId", "bookedAt", "ref", "status", "paymentMode",
    "paymentStatus(browser)", "totalFareInr", "supplierNetInr", "razorpayOrderId",
    "razorpayPaymentId", "razorpayOrderAmountPaise", "verdict", "flags",
  ];
  const lines = rows.map((r) => [
    r.product, r.id, r.workspaceId, r.bookedAt, r.ref, r.status, r.paymentMode, r.paymentStatus,
    r.totalFare, r.netAmount, r.razorpayOrderId, r.razorpayPaymentId, r.razorpayAmountPaise,
    r.verdict, r.flags.join("|"),
  ].map(csvCell).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}

export async function reportSbtPaymentReconciliation(opts: Options): Promise<Report> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;

  if (!opts.expectDb) {
    throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  }
  if (opts.expectDb !== db) {
    throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  }

  log(`[sbt-pay-recon] db=${db}  READ-ONLY`);

  const flightFields =
    "_id workspaceId bookedAt pnr status ticketingStatus paymentMode paymentStatus totalFare netAmount " +
    "razorpayOrderId razorpayPaymentId razorpayAmount isDemo isTest";
  const hotelFields =
    "_id workspaceId bookedAt confirmationNo bookingId status isVouchered paymentMode paymentStatus totalFare " +
    "netAmount razorpayOrderId paymentId razorpayAmount isDemo isTest";

  const [flights, hotels, orphans] = await Promise.all([
    SBTBooking.find({}).select(flightFields).sort({ _id: 1 }).lean(),
    SBTHotelBooking.find({}).select(hotelFields).sort({ _id: 1 }).lean(),
    PaymentOrphan.find({ isTest: { $ne: true } }).select("razorpayOrderId razorpayPaymentId amount resolvedAt").lean(),
  ]);

  const orphanOrders = new Set(orphans.map((o: any) => str(o.razorpayOrderId)).filter(Boolean));

  const rows: Row[] = [];
  for (const d of flights as any[]) {
    const { verdict, flags } = classify("FLIGHT", d);
    rows.push({
      product: "FLIGHT", id: str(d._id), workspaceId: str(d.workspaceId),
      bookedAt: d.bookedAt ? new Date(d.bookedAt).toISOString() : "",
      ref: str(d.pnr), status: str(d.status), paymentMode: str(d.paymentMode),
      paymentStatus: str(d.paymentStatus), totalFare: num(d.totalFare), netAmount: num(d.netAmount),
      razorpayOrderId: str(d.razorpayOrderId), razorpayPaymentId: str(d.razorpayPaymentId),
      razorpayAmountPaise: num(d.razorpayAmount), verdict, flags,
    });
  }
  for (const d of hotels as any[]) {
    const { verdict, flags } = classify("HOTEL", d);
    rows.push({
      product: "HOTEL", id: str(d._id), workspaceId: str(d.workspaceId),
      bookedAt: d.bookedAt ? new Date(d.bookedAt).toISOString() : "",
      ref: str(d.confirmationNo || d.bookingId), status: str(d.status), paymentMode: str(d.paymentMode),
      paymentStatus: str(d.paymentStatus), totalFare: num(d.totalFare), netAmount: num(d.netAmount),
      razorpayOrderId: str(d.razorpayOrderId), razorpayPaymentId: str(d.paymentId),
      razorpayAmountPaise: num(d.razorpayAmount), verdict, flags,
    });
  }

  // Business wallet: since the checkout rebuild every official booking has a
  // payment row (bookingDocIds) with a ledger DEBIT. One that does is OK.
  const officialIds = rows.filter((r) => r.verdict === "WALLET_NOT_DEBITED").map((r) => r.id);
  if (officialIds.length) {
    const payRows = (await SBTPayment.find({ mode: "OFFICIAL", bookingDocIds: { $in: officialIds } })
      .select("_id bookingDocIds").lean()) as any[];
    const debited = new Set(
      ((await SBTWalletLedger.find({ type: "DEBIT", paymentId: { $in: payRows.map((p) => String(p._id)) } })
        .select("paymentId").lean()) as any[]).map((l) => String(l.paymentId)),
    );
    const debitedBooking = new Set<string>();
    for (const p of payRows) if (debited.has(String(p._id))) for (const b of p.bookingDocIds || []) debitedBooking.add(String(b));
    for (const r of rows) if (r.verdict === "WALLET_NOT_DEBITED" && debitedBooking.has(r.id)) r.verdict = "OK";
  }

  // Same Razorpay id on more than one booking = one payment buying two bookings.
  const byOrder = new Map<string, number>();
  const byPayment = new Map<string, number>();
  for (const r of rows) {
    if (r.razorpayOrderId) byOrder.set(r.razorpayOrderId, (byOrder.get(r.razorpayOrderId) ?? 0) + 1);
    if (r.razorpayPaymentId) byPayment.set(r.razorpayPaymentId, (byPayment.get(r.razorpayPaymentId) ?? 0) + 1);
  }
  for (const r of rows) {
    if (r.razorpayOrderId && (byOrder.get(r.razorpayOrderId) ?? 0) > 1) r.flags.push("SHARED_ORDER");
    if (r.razorpayPaymentId && (byPayment.get(r.razorpayPaymentId) ?? 0) > 1) r.flags.push("SHARED_PAYMENT");
    if (r.razorpayOrderId && orphanOrders.has(r.razorpayOrderId)) r.flags.push("ORPHAN_ON_FILE");
  }

  const counts = {
    OK: 0, NO_PAYMENT_RECORD: 0, AMOUNT_MISMATCH: 0, BELOW_COST: 0, WALLET_NOT_DEBITED: 0, SKIPPED_NOT_BOOKED: 0, SKIPPED_TEST: 0,
  } as Record<Verdict, number>;
  for (const r of rows) counts[r.verdict]++;

  log("");
  log(`flights=${flights.length} hotels=${hotels.length}`);
  for (const v of Object.keys(counts) as Verdict[]) log(`  ${v.padEnd(20)} ${counts[v]}`);

  const show = (v: Verdict) => {
    const hit = rows.filter((r) => r.verdict === v && !r.flags.includes("DEMO"));
    if (!hit.length) return;
    log("");
    log(`── ${v} (${hit.length}, demo excluded) ──`);
    for (const r of hit) {
      log(`  ${r.product.padEnd(6)} ${r.id} ws=${r.workspaceId} ${r.bookedAt.slice(0, 10)} ref=${r.ref || "-"} ` +
        `charged=${r.totalFare} net=${r.netAmount} order=${r.razorpayOrderId || "-"} ` +
        `amountPaise=${r.razorpayAmountPaise}${r.flags.length ? " [" + r.flags.join(",") + "]" : ""}`);
    }
  };
  show("BELOW_COST");
  show("AMOUNT_MISMATCH");
  show("NO_PAYMENT_RECORD");

  const shared = rows.filter((r) => r.flags.includes("SHARED_ORDER") || r.flags.includes("SHARED_PAYMENT"));
  if (shared.length) {
    log("");
    log(`── one Razorpay id on several bookings (${shared.length}) ──`);
    for (const r of shared) log(`  ${r.product} ${r.id} order=${r.razorpayOrderId} payment=${r.razorpayPaymentId}`);
  }

  // Captured by Razorpay, matched to no booking (webhook PaymentOrphan rows).
  const bookedOrders = new Set(rows.map((r) => r.razorpayOrderId).filter(Boolean));
  const loose = orphans.filter((o: any) => !o.resolvedAt && !bookedOrders.has(str(o.razorpayOrderId)));
  if (loose.length) {
    log("");
    log(`── PaymentOrphan: captured, no booking, unresolved (${loose.length}) ──`);
    for (const o of loose as any[]) log(`  order=${o.razorpayOrderId} payment=${o.razorpayPaymentId} amountPaise=${o.amount}`);
  }

  // Business wallet: this month's official bookings vs the workspace counter.
  // Only the current month is comparable — the counter resets lazily each month.
  const monthKey = new Date().toISOString().slice(0, 7);
  const officialThisMonth = new Map<string, number>();
  for (const r of rows) {
    if (r.paymentMode !== "official" || r.verdict === "SKIPPED_NOT_BOOKED" || r.flags.includes("DEMO")) continue;
    if (r.bookedAt.slice(0, 7) !== monthKey) continue;
    officialThisMonth.set(r.workspaceId, (officialThisMonth.get(r.workspaceId) ?? 0) + r.totalFare);
  }
  if (officialThisMonth.size) {
    const wss = await CustomerWorkspace.find({ _id: { $in: [...officialThisMonth.keys()] } })
      .select("_id sbtOfficialBooking")
      .lean();
    log("");
    log(`── business wallet ${monthKey}: official bookings vs currentMonthSpend ──`);
    for (const w of wss as any[]) {
      const ob = w.sbtOfficialBooking ?? {};
      const counter = ob.lastResetMonth === monthKey ? num(ob.currentMonthSpend) : 0;
      const booked = officialThisMonth.get(str(w._id)) ?? 0;
      log(`  ws=${w._id} bookedTotal=${booked} counter=${counter} limit=${num(ob.monthlyLimit)} diff=${booked - counter}`);
    }
  }

  const csvPath = opts.csvPath || `sbt-payment-recon-${db}-${new Date().toISOString().slice(0, 10)}.csv`;
  writeFileSync(csvPath, toCsv(rows), "utf8");
  log("");
  log(`[sbt-pay-recon] CSV for Razorpay matching: ${csvPath} (${rows.length} rows)`);
  log("[sbt-pay-recon] read-only — nothing written to the database.");

  return { db, rows, counts, orphansWithoutBooking: loose.length, csvPath };
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
    await reportSbtPaymentReconciliation({ expectDb: argValue("expect-db"), csvPath: argValue("csv") });
  } finally {
    await mongoose.connection.close();
  }
}

// Run only when executed directly — importing it (a test) must not connect.
const invokedDirectly = process.argv[1]
  ?.replace(/\\/g, "/")
  .endsWith("scripts/report-sbt-payment-reconciliation.ts");

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
