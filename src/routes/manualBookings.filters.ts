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
import {
  MANUAL_BOOKING_TYPES,
  ALL_SUB_STATUSES,
} from "../models/ManualBooking.js";
import { parseISTStart, parseISTEnd } from "../utils/dateIST.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import { enumFilter } from "../utils/filterParams.js";

const BOOKING_STATUSES = ["PENDING", "WIP", "CONFIRMED", "INVOICED", "CANCELLED"] as const;
const BOOKING_SOURCES = ["MANUAL", "SBT", "ADMIN_QUEUE", "SBT_AUTO"] as const;
const ASSIGNMENT_STATUSES = ["PENDING_TO_ASSIGN", "ASSIGNED"] as const;

export function buildSearchFilter(query: Record<string, any>) {
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

  // subStatus — the "why is this stuck" dimension. Only the eight real values
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

  // Demo Platform — exclude demo bookings from admin manual-bookings views.
  filter.isDemo = { $ne: true };

  return filter;
}

// Bug 3 fix: async invoice-number filter applied after buildSearchFilter
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
