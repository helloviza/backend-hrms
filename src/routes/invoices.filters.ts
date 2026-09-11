// apps/backend/src/routes/invoices.filters.ts
//
// THE non-gate query builder for the admin invoice read paths (GET /,
// GET /export, GET /bulk-pdf) — everything the CALLER asks for, and nothing
// about what they are ALLOWED to see.
//
// WHY THIS IS ITS OWN FILE: the same reason as manualBookings.filters.ts. The
// tenant gate is security code and stayed in invoices.ts; this half is not,
// and a filter tweak should not produce a diff inside a security-sensitive
// file that then has to be reviewed line-by-line to prove the gate is intact.
//
// THE CONTRACT: what this returns is UNGATED and must never reach a query on
// its own. invoices.ts's buildInvoiceReadFilter is the only caller, and it
// ANDs invoiceTenantClause(req) on before handing the filter out.
//
// CLAUSE PLACEMENT IS LOAD-BEARING. The tenant gate (there) and the
// caller-supplied workspaceId narrowing (here) BOTH constrain `workspaceId`,
// so both go into `$and` as separate entries. Two sibling
// `filter.workspaceId = …` assignments would have the second silently
// overwrite the first — and since the narrowing is the one a caller controls,
// that ordering would let a tenant user pass ?workspaceId=<someone else's>
// and erase their own gate. Hence: push onto $and, never assign over it.

import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { parseISTStart, parseISTEnd } from "../utils/dateIST.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import { enumFilter, whitelistField } from "../utils/filterParams.js";

/* Enum value lists for the invoice multi-selects, restated from the schema's
 * own enum arrays in models/Invoice.ts. INVOICE_DATE_FIELDS is the whitelist
 * for the `dateField` param — the only two date paths a caller may aim the
 * range at. */
const INVOICE_STATUSES = ["DRAFT", "SENT", "PAYMENT_DECLARED", "PAID", "CANCELLED"] as const;
const SUPPLY_TYPES = ["IGST", "CGST_SGST", "CGST_UTGST", "EXPORT", "NONE"] as const;
const INVOICE_DATE_FIELDS = ["generatedAt", "invoiceDate"] as const;

/**
 * Invoice-number matcher for the admin list's search box.
 *
 * Two regexes under one `$in`, which Mongo ORs — so this stays a single scalar
 * key on `invoiceNo` and can be assigned as a sibling of the other filters,
 * with no $or/$and of its own to collide with the gate.
 *
 *  1. anchored + case-SENSITIVE against the upper-cased input. Invoice numbers
 *     are generated upper-case ("INV-20260299"), so this form can actually use
 *     the existing unique index on invoiceNo — a `/…/i` regex cannot.
 *  2. unanchored + case-insensitive, so a mid-string fragment ("0299") still
 *     finds the invoice. This one scans, but only ever as the fallback arm.
 *
 * Both arms are escaped: unescaped input throws inside `new RegExp` on a bare
 * "(" (HTTP 500 on a search box) and honours ".*" as a pattern.
 */
function invoiceNoMatcher(raw: string): Record<string, any> {
  const escaped = escapeRegex(raw);
  return {
    $in: [
      new RegExp(`^${escapeRegex(raw.toUpperCase())}`),
      new RegExp(escaped, "i"),
    ],
  };
}

export async function buildInvoiceQueryFilter(query: Record<string, any>): Promise<Record<string, any>> {
  const filter: Record<string, any> = {};
  const andClauses: any[] = [];


  // Caller-supplied client narrowing. The dropdown supplies a Customer._id, so
  // resolve its CustomerWorkspace too and accept either — unchanged behaviour,
  // just relocated and now AND-ed rather than owning `filter.workspaceId`.
  if (query.workspaceId) {
    const cws = await CustomerWorkspace
      .findOne({ customerId: query.workspaceId })
      .select("_id")
      .lean();
    andClauses.push({
      workspaceId: { $in: [query.workspaceId, ...(cws ? [cws._id] : [])] },
    });
  }

  // Multi-select, enum-validated. "Everything unpaid" (DRAFT,SENT,
  // PAYMENT_DECLARED) was three separate page loads before.
  const statusF = enumFilter(query.status, INVOICE_STATUSES);
  if (statusF !== undefined) filter.status = statusF;

  // GST type — exact match, 5 enum values, useful for filing season.
  const supplyF = enumFilter(query.supplyType, SUPPLY_TYPES);
  if (supplyF !== undefined) filter.supplyType = supplyF;

  // WHICH date the range applies to. Whitelisted, because passing the raw
  // string through would let a caller point the range at any field in the
  // document. Default stays generatedAt so existing links behave unchanged.
  //
  // generatedAt = when the row was created; invoiceDate = the document date,
  // which is settable at generation time and is what finance reconciles on.
  // A back-dated invoice sorts and filters differently under the two.
  const dateField = whitelistField(query.dateField, INVOICE_DATE_FIELDS, "generatedAt");

  // IST calendar days, inclusive of the full last day — same contract as the
  // bookings list. Was `new Date("YYYY-MM-DD")`, i.e. UTC midnight, which put
  // dateFrom at 05:30 IST and cut almost the whole of the dateTo day.
  if (query.dateFrom || query.dateTo) {
    const range: Record<string, Date> = {};
    if (query.dateFrom) range.$gte = parseISTStart(query.dateFrom);
    if (query.dateTo)   range.$lte = parseISTEnd(query.dateTo);
    filter[dateField] = range;
  }

  // The frontend has always sent this; the handler never read it, so the box
  // round-tripped and returned the unfiltered page. Matches invoiceNo only —
  // what the placeholder promises and what the customer route already does.
  const search = String(query.search ?? "").trim();
  if (search) filter.invoiceNo = invoiceNoMatcher(search);

  // Append, never reassign — reassigning $and is how the gate gets dropped.
  if (andClauses.length) filter.$and = [...(filter.$and ?? []), ...andClauses];

  return filter;
}

