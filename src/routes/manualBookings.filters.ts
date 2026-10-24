// apps/backend/src/routes/manualBookings.filters.ts
//
// THE non-gate query builder for /admin/manual-bookings — everything the
// CALLER asks for (status, type, source, sub-status, assignment, date ranges,
// free text), and nothing about what they are ALLOWED to see.
//
// WHY THIS IS ITS OWN FILE: the access gates and the field masking that live
// in manualBookings.ts are security code, and this is not. Keeping them in one
// file meant every filter tweak produced a diff in a security-sensitive file
// and had to be reviewed (and staged) as though it were one. Split, the two
// concerns land in separate commits and a reviewer can tell at a glance which
// kind of change they are looking at.
//
// THE CONTRACT, and the reason the gates are NOT here: this builder returns a
// filter that is deliberately UNGATED. It must never be handed to a query on
// its own — every read path calls applyBookingReadGates(req, filter) after it.
// See that function's doc comment in manualBookings.ts for the three gates and
// the $and trap.
//
// Shared verbatim by GET / and GET /export, which is what keeps "export what
// I'm filtering" true; manualBookings.filters.test.ts asserts both paths build
// the identical filter from the identical query string.

import mongoose from "mongoose";
import Invoice from "../models/Invoice.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import PartnerLink from "../models/PartnerLink.js";
import {
  MANUAL_BOOKING_TYPES,
  ALL_SUB_STATUSES,
} from "../models/ManualBooking.js";
import { parseISTStart, parseISTEnd } from "../utils/dateIST.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import { enumFilter } from "../utils/filterParams.js";
import { BOOKING_STATUSES, demoClause } from "../utils/bookingMetrics.js";

const BOOKING_SOURCES = ["MANUAL", "SBT", "ADMIN_QUEUE", "SBT_AUTO"] as const;
const ASSIGNMENT_STATUSES = ["PENDING_TO_ASSIGN", "ASSIGNED"] as const;

export function buildSearchFilter(query: Record<string, any>, user?: any) {
  const filter: Record<string, any> = {};

  // Bug 5 fix: explicit ObjectId cast so the query is always typed correctly
  if (query.workspaceId) {
    try {
      filter.workspaceId = new mongoose.Types.ObjectId(query.workspaceId);
    } catch {
      filter._id = { $in: [] }; // invalid id → force empty result
    }
  }

  // Multi-select, enum-validated. A CSV of values becomes $in; unknown values
  // are dropped; an all-unknown list matches nothing rather than everything
  // (see enumFilter's contract). This is also what retires the old `DONE`
  // status option — it was never in the enum, so it now lands in the
  // match-nothing branch explicitly instead of by accident.
  const statusF = enumFilter(query.status, BOOKING_STATUSES);
  if (statusF !== undefined) filter.status = statusF;

  const typeF = enumFilter(query.type, MANUAL_BOOKING_TYPES);
  if (typeF !== undefined) filter.type = typeF;

  const sourceF = enumFilter(query.source, BOOKING_SOURCES);
  if (sourceF !== undefined) filter.source = sourceF;

  // subStatus — the "why is this stuck" dimension. Only the real values (ALL_SUB_STATUSES)
  // are accepted; the enum's "" default is not a filterable choice.
  const subStatusF = enumFilter(query.subStatus, ALL_SUB_STATUSES);
  if (subStatusF !== undefined) filter.subStatus = subStatusF;

  const assignmentF = enumFilter(query.assignmentStatus, ASSIGNMENT_STATUSES);
  if (assignmentF !== undefined) filter.assignmentStatus = assignmentF;

  // assignPerson is a User._id. An unparseable id matches nothing rather than
  // being dropped — same fail-closed choice as workspaceId above.
  if (query.assignPerson) {
    filter.assignPerson = mongoose.Types.ObjectId.isValid(String(query.assignPerson))
      ? new mongoose.Types.ObjectId(String(query.assignPerson))
      : null;
  }

  if (query.givenBy) filter.givenBy = new RegExp(escapeRegex(String(query.givenBy)), "i");
  if (query.sector) filter.sector = new RegExp(escapeRegex(String(query.sector)), "i");
  if (query.week) filter.bookingWeek = parseInt(query.week);
  if (query.month) filter.bookingMonth = query.month;
  if (query.sourceBookingId) filter.sourceBookingId = query.sourceBookingId;

  // createdBy is stored as a plain string (String(user._id))
  if (query.createdBy) filter.createdBy = String(query.createdBy);

  // Filter bookingDate (what the UI column shows). YYYY-MM-DD inputs are
  // interpreted as IST calendar days; full last day is included.
  if (query.dateFrom || query.dateTo) {
    filter.bookingDate = {};
    if (query.dateFrom) filter.bookingDate.$gte = parseISTStart(query.dateFrom);
    if (query.dateTo)   filter.bookingDate.$lte = parseISTEnd(query.dateTo);
  }

  // Travel-date range — a SEPARATE range from bookingDate above, which is why
  // both are labelled on screen. This is the one the existing (previously
  // unused) {workspaceId:1, travelDate:-1} index can serve, so it is cheap
  // whenever a client is also selected.
  if (query.travelFrom || query.travelTo) {
    filter.travelDate = {};
    if (query.travelFrom) filter.travelDate.$gte = parseISTStart(query.travelFrom);
    if (query.travelTo)   filter.travelDate.$lte = parseISTEnd(query.travelTo);
  }

  if (query.search) {
    // ESCAPED: unescaped input throws inside new RegExp on a bare "(" — which
    // surfaced as an HTTP 500 the moment the search box was actually rendered.
    const re = new RegExp(escapeRegex(String(query.search)), "i");
    filter.$or = [
      { bookingRef: re },
      { sourceBookingRef: re },
      { supplierPNR: re },
      { "passengers.name": re },
      { sector: re },
      { givenBy: re },
    ];
  }

  // Demo Platform — session-aware: a demo session sees only demo bookings,
  // everyone else never sees one (utils/bookingMetrics.ts).
  Object.assign(filter, demoClause(user));

  return filter;
}

// Bug 3 fix: async invoice-number filter applied after buildSearchFilter
/**
 * ?partner=<CustomerWorkspace._id>: only bookings made for that partner's
 * partner lead cases (Book Now on a PARTNER_LINK case — source ADMIN_QUEUE,
 * sourceBookingId = the case, on the partner's own Customer._id). ANDed onto
 * whatever else the filter says, so it narrows like any other filter. An
 * unknown / invalid partner, or one with no cases, matches nothing.
 */
export async function applyPartnerFilter(filter: Record<string, any>, partner: unknown) {
  const id = String(partner ?? "").trim();
  if (!id) return;
  const none = () => {
    filter._id = { $in: [] };
  };
  if (!mongoose.isValidObjectId(id)) return none();
  const ws: any = await CustomerWorkspace.findById(id).select("_id customerId").lean();
  if (!ws || !mongoose.isValidObjectId(String(ws.customerId || ""))) return none();
  const cases = await ApprovalRequest.find({ workspaceId: ws._id, "meta.source": "PARTNER_LINK" }).select("_id").lean();
  if (!cases.length) return none();
  filter.$and = [
    ...(Array.isArray(filter.$and) ? filter.$and : []),
    {
      workspaceId: new mongoose.Types.ObjectId(String(ws.customerId)),
      source: "ADMIN_QUEUE",
      sourceBookingId: { $in: cases.map((c: any) => c._id) },
    },
  ];
}

/** The Partner filter's options: every workspace with at least one partner link (active or not), A–Z. */
export async function partnerFilterOptions(): Promise<Array<{ workspaceId: string; name: string }>> {
  const ids = await PartnerLink.distinct("workspaceId");
  if (!ids.length) return [];
  const rows: any[] = await CustomerWorkspace.find({ _id: { $in: ids } }).select("_id companyName").lean();
  return rows
    .map((w) => ({ workspaceId: String(w._id), name: String(w.companyName || "").trim() || "Partner" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function applyInvoiceFilter(filter: Record<string, any>, invoiceNo: string) {
  const matches = await Invoice.find({
    invoiceNo: { $regex: invoiceNo, $options: "i" },
  }).select("_id").lean();
  const ids = matches.map((inv: any) => inv._id);
  if (ids.length === 0) {
    filter._id = { $in: [] };
  } else {
    filter.invoiceId = { $in: ids };
  }
}
