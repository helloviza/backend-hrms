// apps/backend/src/scripts/count-partner-closed-with-confirmed-booking.ts
//
// READ ONLY. Lists partner lead cases that ops closed while a booking on them
// is still Confirmed / Invoiced. Student Cases shows these as "Request closed"
// and counts them under Booking dropped (services/partnerLeadTracker.ts
// outcomeOf) — by design, nothing is fixed here; this is how many there are.
//
// Same reads as GET /api/partner/cases: the case's live ADMIN_QUEUE bookings
// under its own customer (bookingsOfCases), the step from partnerCaseRow.
// Also prints each partner workspace's five Student Cases counts.
//
// Writes nothing: find() only, no autoIndex / autoCreate.
//
//   npx tsx src/scripts/count-partner-closed-with-confirmed-booking.ts --expect-db=<db>
import "dotenv/config";
import mongoose from "mongoose";
import ApprovalRequest from "../models/ApprovalRequest.js";
import { bookingsOfCases } from "../services/partnerLeadBooking.js";
import { PARTNER_LINK_SOURCE } from "../services/partnerLeadCase.js";
import { TRACKER_CASE_FIELDS, partnerCaseRow, trackerCounts } from "../services/partnerLeadTracker.js";

type AnyObj = Record<string, any>;
const DONE = new Set(["CONFIRMED", "INVOICED"]);

/** Ops closed the case ("Request closed") while a booking is Confirmed / Invoiced. */
export function closedWithConfirmedBooking(row: { currentStep: { state: string } }, bookings: AnyObj[]): boolean {
  return row.currentStep.state === "closed" && bookings.some((b) => b?.isActive !== false && DONE.has(String(b?.status ?? "").toUpperCase()));
}

export async function countPartnerClosedWithConfirmed(opts: { expectDb?: string; log?: (line: string) => void }) {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  log(`db ${db} · READ ONLY`);

  const cases: AnyObj[] = await ApprovalRequest.find({ "meta.source": PARTNER_LINK_SOURCE })
    .select(`${TRACKER_CASE_FIELDS} workspaceId customerId`)
    .sort({ createdAt: -1 })
    .lean();
  const byWorkspace = new Map<string, AnyObj[]>();
  for (const c of cases) {
    const k = `${String(c.workspaceId || "")}|${String(c.customerId || "")}`;
    byWorkspace.set(k, [...(byWorkspace.get(k) || []), c]);
  }

  const hits: AnyObj[] = [];
  for (const [k, list] of byWorkspace) {
    const [workspaceId, customerId] = k.split("|");
    const bookings = await bookingsOfCases(customerId, list.map((c) => c._id));
    const of = new Map<string, AnyObj[]>();
    for (const b of bookings) of.set(String(b.sourceBookingId), [...(of.get(String(b.sourceBookingId)) || []), b]);
    const rows = list.map((c) => ({ c, b: of.get(String(c._id)) || [], row: partnerCaseRow(c, of.get(String(c._id)) || []) }));
    const n = trackerCounts(rows.map((r) => r.row));
    log(
      `  workspace ${workspaceId || "—"} (customer ${customerId || "—"}): registered ${n.registered} · pending action ${n.pendingAction} · in progress ${n.inProgress} · booking done ${n.bookingDone} · booking dropped ${n.bookingDropped}`,
    );
    for (const r of rows) {
      if (!closedWithConfirmedBooking(r.row, r.b)) continue;
      hits.push({
        caseNumber: r.row.caseNumber,
        workspaceId,
        customerId,
        adminState: String(r.c.adminState || ""),
        closedAt: r.row.currentStep.at,
        bookings: r.b.map((b) => `${b.bookingRef || String(b._id)} ${String(b.status || "").toUpperCase()}`).join(", "),
      });
    }
  }

  log(`partner cases: ${cases.length} in ${byWorkspace.size} workspace(s)`);
  log(`closed by ops with a Confirmed / Invoiced booking (shown as Booking dropped): ${hits.length}`);
  for (const h of hits) log(`  ${h.caseNumber} · workspace ${h.workspaceId} · adminState ${h.adminState} · closed ${h.closedAt || "—"} · ${h.bookings}`);
  return { db, cases: cases.length, hits };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
    await countPartnerClosedWithConfirmed({ expectDb });
  } finally {
    await mongoose.disconnect();
  }
}

// Run only when executed directly — importing it (the tests) must not connect.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/count-partner-closed-with-confirmed-booking.ts");
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
