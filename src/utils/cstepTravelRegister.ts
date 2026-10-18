// apps/backend/src/utils/cstepTravelRegister.ts
//
// CSTEP Travel Register — the finance team's per-expense-line register
// ("TRAVEL REGISTER FY 2026-2027"), built as an .xlsx that reproduces the
// layout of CSTEP's own sheet (docs/design/cstep-travel-register/sample.xlsx):
// row 1 the merged A:R title, row 2 the blue header, then one block of rows
// per trip with Month/TIN/TYPE/NAME/REASON/Project repeated on every row and
// a yellow "Submitted on … | TOTAL | Cost of the Tour" summary row closing it.
//
// Pure: takes already-loaded, already-scoped data and returns a workbook — no
// DB access, so GET /cstep/reports/travel-register (routes/cstep.ts) owns the
// queries and the Admin/Finance scoping, and this file owns only the layout.
//
// What a trip contributes depends on how far it has got:
//   - no real arrangements yet (DRAFT/SUBMITTED/RETURNED/REJECTED, or an
//     approved trip nobody has arranged): ONE row — the trip's own columns
//     plus a grey status cell in the summary position.
//   - arrangements but no settlement (APPROVED…REPORT_SUBMITTED, or a trip
//     CANCELLED after arranging): one row per real arrangement, amounts in
//     the arrangement's OWN currency (never summed — the frozen INR figure
//     goes in a cell note), then the grey status row. No TOTAL.
//   - a settlement exists: one row per settlement line (CSTEP-paid lines
//     first, then the traveller's "Travel Claim" lines), a per-diem "Travel
//     Claim" row, then the summary row — "TOTAL / Cost of the Tour" once the
//     settlement is FINALIZED, "TOTAL (prov.)" while it is still VERIFYING
//     ("PROVISIONAL" is one word too wide for column L, so it would clip).
//     The personal lines are itemised, so there is no separate summary
//     Travel-Claim row (that would count them twice).
//
// Local Travel Claims (claims addition) are in the register too — TYPE
// "LOCAL", TIN = the claim's own reference, filed under the claim period's
// start (departureDate). A claim has no arrangements; once approved it has a
// settlement seeded from its own lines, so it renders as one row per claim
// line (route and date from the line) + the TOTAL row ("Total claimed").
// Expense Claims are not travel and never reach this file — the route
// filters them out.
//
// Reconciliation guard: the TOTAL shown is the stored totalCostOfTour, and it
// is re-derived here as Σ line.amountInr + perDiem.amountInr (the same sum
// recomputeSettlementTotals stores). A gap over ₹0.01 is highlighted with a
// note carrying both figures — never silently resolved either way.
//
// Dates follow the sample's convention: day.month typed as a number (5.04 =
// 5 April), shown with a 0.00 format so 30.10 doesn't collapse to 30.1.

import ExcelJS from "exceljs";

/* ── Inputs ─────────────────────────────────────────────────────────── */

export interface RegisterArrangement {
  arrangedType: string;
  details?: string;
  currency?: string;
  amount?: number;
  exchangeRate?: number;
  rateDate?: string;
  amountInr?: number;
  rateSource?: string;
  status: string;
  // Vendor + payment addition — fill Agency / Paid / Cheque & Date.
  vendorName?: string;
  paymentStatus?: string; // "UNPAID" | "PAID"
  paymentRef?: string;
  paidAt?: Date | string;
}

export interface RegisterLeg {
  fromLocation?: string;
  toLocation?: string;
  fromDate?: string;
  toDate?: string;
}

export interface RegisterSettlementLine {
  source: string; // "ARRANGEMENT" | "REPORT_LEG" | "CLAIM_LINE"
  mode: string;
  description?: string;
  amountInr?: number;
  classification: string; // "OFFICIAL" | "PERSONAL"
  leg?: RegisterLeg; // the REPORT_LEG (or claim line) this line came from, when there is one
  arrangement?: RegisterArrangement; // the ARRANGEMENT this line came from — its vendor + payment
}

export interface RegisterSettlement {
  status: string; // "VERIFYING" | "FINALIZED"
  perDiem?: { days?: number; rate?: number; amountInr?: number };
  totalCostOfTour?: number;
}

export interface RegisterRequest {
  formType: string;
  type?: string;
  purpose?: string;
  project?: string;
  projectDebitable?: string;
  stations?: Array<{ from?: string; to?: string }>;
  countries?: Array<{ country?: string }>;
  departureDate?: string;
  returnDate?: string;
  eventLocation?: string;
  eventVenue?: string;
  travelLines?: Array<{ date?: string; from?: string; to?: string }>; // LOCAL_TRAVEL_CLAIM
  status: string;
  claimReference?: string;
  createdAt?: Date | string;
}

export interface RegisterTrip {
  request: RegisterRequest;
  travellerName: string;
  /** Latest SUBMIT / RESUBMIT of the request (ISO). */
  submittedAt?: string;
  /** Latest SUBMIT_REPORT — the traveller's claim date (ISO). */
  reportSubmittedAt?: string;
  /** Real arrangements only (arrangementIsReal), in display order. */
  arrangements: RegisterArrangement[];
  settlement?: RegisterSettlement;
  settlementLines: RegisterSettlementLine[];
}

export interface RegisterPeriod {
  kind: "week" | "month" | "quarter" | "fy" | "custom";
  from: string; // "YYYY-MM-DD", inclusive, IST calendar date
  to: string; // "YYYY-MM-DD", inclusive
  title: string; // row-1 title
  fileTag: string; // goes into cstep-travel-register-<fileTag>.xlsx
}

/* ── Period resolution ──────────────────────────────────────────────── */

const IST_OFFSET_MS = 330 * 60 * 1000;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CUSTOM_DAYS = 731; // 24 months

/** The IST calendar date of an instant, as "YYYY-MM-DD". */
export function istDate(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Parse a "YYYY-MM-DD" as a UTC-midnight Date for calendar arithmetic. */
function parseIso(s: string): Date | null {
  if (!ISO_DATE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}

/** "2026-10-05" -> "05.10.2026" */
function dottedFull(s: string): string {
  return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
}

function fyLabel(startYear: number): { title: string; tag: string } {
  return {
    title: `FY ${startYear}-${startYear + 1}`,
    tag: `FY${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
  };
}

/**
 * Resolve the export period from the query string. `period` is one of
 * week | month | quarter | fy | custom (default fy); `anchor` is any date
 * inside the wanted week/month/quarter/FY (default: today, IST); custom
 * takes `from` + `to` and is capped at 24 months. Weeks run Monday–Sunday
 * and quarters are Indian-FY quarters (Q1 = Apr–Jun).
 */
export function resolveRegisterPeriod(
  query: { period?: unknown; anchor?: unknown; from?: unknown; to?: unknown },
  now: Date,
): RegisterPeriod | { error: string } {
  const kind = String(query.period || "fy").toLowerCase();

  if (kind === "custom") {
    const from = parseIso(String(query.from || ""));
    const to = parseIso(String(query.to || ""));
    if (!from || !to) return { error: "A custom range needs valid from and to dates (YYYY-MM-DD)" };
    if (to < from) return { error: "The range's end date is before its start date" };
    if ((to.getTime() - from.getTime()) / 86400000 + 1 > MAX_CUSTOM_DAYS) {
      return { error: "A custom range can cover at most 24 months" };
    }
    const f = iso(from);
    const t = iso(to);
    return {
      kind: "custom",
      from: f,
      to: t,
      title: `TRAVEL REGISTER ${dottedFull(f)} – ${dottedFull(t)}`,
      fileTag: `${f}_to_${t}`,
    };
  }

  const anchorRaw = query.anchor ? String(query.anchor) : istDate(now);
  const anchor = parseIso(anchorRaw);
  if (!anchor) return { error: "anchor must be a valid date (YYYY-MM-DD)" };
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth(); // 0-based

  if (kind === "week") {
    const mondayOffset = (anchor.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
    const start = addDays(anchor, -mondayOffset);
    const end = addDays(start, 6);
    return {
      kind: "week",
      from: iso(start),
      to: iso(end),
      title: `TRAVEL REGISTER WEEK ${dottedFull(iso(start))} – ${dottedFull(iso(end))}`,
      fileTag: `week-${iso(start)}`,
    };
  }

  if (kind === "month") {
    const start = new Date(Date.UTC(y, m, 1));
    const end = new Date(Date.UTC(y, m + 1, 0));
    return {
      kind: "month",
      from: iso(start),
      to: iso(end),
      title: `TRAVEL REGISTER ${MONTHS_LONG[m]} ${y}`,
      fileTag: `${y}-${String(m + 1).padStart(2, "0")}`,
    };
  }

  const fyStart = m >= 3 ? y : y - 1;
  const fy = fyLabel(fyStart);

  if (kind === "quarter") {
    const q = Math.floor(((m + 12 - 3) % 12) / 3); // Apr–Jun = 0
    const startMonth = 3 + q * 3; // months since Jan of fyStart
    const start = new Date(Date.UTC(fyStart, startMonth, 1));
    const end = new Date(Date.UTC(fyStart, startMonth + 3, 0));
    return {
      kind: "quarter",
      from: iso(start),
      to: iso(end),
      title: `TRAVEL REGISTER Q${q + 1} ${fy.title}`,
      fileTag: `Q${q + 1}-${fy.tag}`,
    };
  }

  if (kind !== "fy") return { error: "period must be one of week, month, quarter, fy, custom" };
  return {
    kind: "fy",
    from: `${fyStart}-04-01`,
    to: `${fyStart + 1}-03-31`,
    title: `TRAVEL REGISTER ${fy.title}`,
    fileTag: fy.tag,
  };
}

/* ── Cell values ────────────────────────────────────────────────────── */

const MODE_LABEL: Record<string, string> = {
  FLIGHT: "Air",
  HOTEL: "Stay",
  CAB: "CAB",
  TRAIN: "Rail",
  BUS: "Bus",
  VISA: "Visa",
  FOREX: "Forex",
  STATIONERY: "Stationery",
  OTHER: "Other",
};
export function modeLabel(mode: string): string {
  return MODE_LABEL[mode] || "Other";
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Awaiting approval",
  RETURNED: "Returned to traveller",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  APPROVED: "Approved — to be arranged",
  ARRANGING: "Being arranged",
  ARRANGED: "Arranged",
  REPORT_PENDING: "Travel report pending",
  REPORT_SUBMITTED: "Travel report submitted",
  TRANSFERRED_TO_FINANCE: "With Finance",
  SETTLED: "Settled",
  REIMBURSED: "Reimbursed",
};

// A claim reuses the request statuses but has no arrangement stage — its
// APPROVED means "with the CSTEP Admin for verification".
const CLAIM_STATUS_LABEL: Record<string, string> = {
  ...STATUS_LABEL,
  APPROVED: "Approved — awaiting verification",
};

function isLocalClaim(r: RegisterRequest): boolean {
  return r.formType === "LOCAL_TRAVEL_CLAIM";
}

function statusLabel(r: RegisterRequest): string {
  return (isLocalClaim(r) ? CLAIM_STATUS_LABEL : STATUS_LABEL)[r.status] || r.status;
}

/** "YYYY-MM-DD" -> the sample's day.month number (5.04 = 5 April). */
function dayMonth(s?: string): number | null {
  if (!s || !ISO_DATE.test(s)) return null;
  return Number(`${Number(s.slice(8, 10))}.${s.slice(5, 7)}`);
}

/** ISO instant -> IST "dd.mm" text, for "Submitted on dd.mm". */
function dottedShort(isoInstant?: string): string {
  if (!isoInstant) return "";
  const d = new Date(isoInstant);
  if (Number.isNaN(d.getTime())) return "";
  const s = istDate(d);
  return `${s.slice(8, 10)}.${s.slice(5, 7)}`;
}

/** Agency / Paid / Cheque & Date for a row booked with a vendor. Paid holds
 * the INR figure paid, as the sample does (falls back to "Paid" when the
 * line has no INR amount); an unpaid line leaves Paid and Cheque blank.
 * Cheque & Date = "<UTR / cheque no.> dd.mm.yy". */
function vendorCols(
  a: RegisterArrangement | undefined,
  paidInr: number,
): Pick<RowSpec, "agency" | "paid" | "cheque"> {
  if (!a) return {};
  const out: Pick<RowSpec, "agency" | "paid" | "cheque"> = { agency: a.vendorName || undefined };
  if (a.paymentStatus === "PAID") {
    out.paid = paidInr > 0 ? round2(paidInr) : "Paid";
    const d = a.paidAt ? new Date(a.paidAt) : null;
    const on = d && !Number.isNaN(d.getTime()) ? istDate(d) : "";
    out.cheque = [a.paymentRef || "", on ? `${on.slice(8, 10)}.${on.slice(5, 7)}.${on.slice(2, 4)}` : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  }
  return out;
}

function inr(n: number): string {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The date a trip is filed under: departureDate, else its IST creation date. */
export function tripEffectiveDate(r: RegisterRequest): string {
  if (r.departureDate && ISO_DATE.test(r.departureDate)) return r.departureDate;
  const c = r.createdAt ? new Date(r.createdAt) : null;
  return c && !Number.isNaN(c.getTime()) ? istDate(c) : "";
}

function tripType(r: RegisterRequest): string {
  switch (r.formType) {
    case "EVENT_REQUEST":
      return "EVENT";
    case "LOCAL_TRAVEL_CLAIM":
      return "LOCAL";
    case "TOUR_PROPOSAL":
      return r.type === "INTERNATIONAL" ? "INT" : "DOM";
    default:
      return r.formType;
  }
}

function tripRoute(r: RegisterRequest): { from: string; to: string } {
  if (r.formType === "EVENT_REQUEST") {
    return { from: "", to: r.eventLocation || r.eventVenue || "" };
  }
  if (isLocalClaim(r)) {
    const lines = r.travelLines || [];
    const to = [...new Set(lines.map((l) => (l.to || "").trim()).filter(Boolean))].join(", ");
    return { from: (lines[0]?.from || "").trim(), to };
  }
  if (r.type === "INTERNATIONAL") {
    // The international form captures destination countries only — no origin.
    const to = [...new Set((r.countries || []).map((c) => (c.country || "").trim()).filter(Boolean))].join(", ");
    return { from: "", to };
  }
  const stations = r.stations || [];
  const to = [...new Set(stations.map((s) => (s.to || "").trim()).filter(Boolean))].join(", ");
  return { from: (stations[0]?.from || "").trim(), to };
}

/* ── Layout (from sample.xlsx) ──────────────────────────────────────── */

const HEADERS = [
  "Month", "TIN", "TYPE", "NAME", "REASON", "From", "Destination", "From", "To", "Mode ",
  "Agency", "Invoice date", "Invoice No", "Amount", "TDS", "Paid", "Project ", "Cheque & Date",
];
// Sample widths; undefined = the sheet's default width, as in the sample.
const WIDTHS: Array<number | undefined> = [
  6.44140625, 11.33203125, undefined, 16, 42.88671875, 11.44140625, 15, undefined, undefined, 14.21875,
  14.109375, undefined, 22.21875, undefined, 5.44140625, 5.44140625, undefined, undefined,
];
const COLS = 18;
const FONT = "Trebuchet MS";
const RED = "FFFF0000";
const YELLOW = "FFFFFF00";
const PROVISIONAL_FILL = "FFFFF2CC";
const STATUS_FILL = "FFD9D9D9";
const MISMATCH_FILL = "FFFFC7CE";
const HEADER_FILL = "FF0070C0";
const INR_FMT = "#,##0";
const DAY_MONTH_FMT = "0.00";

const C = {
  month: 1, tin: 2, type: 3, name: 4, reason: 5, from: 6, dest: 7, fromDate: 8, toDate: 9, mode: 10,
  agency: 11, invDate: 12, invNo: 13, amount: 14, tds: 15, paid: 16, project: 17, cheque: 18,
} as const;

type SummaryKind = "total" | "provisional" | "status";

interface RowSpec {
  from?: string;
  to?: string;
  fromDate?: string;
  toDate?: string;
  mode?: string;
  agency?: string;
  invDate?: number | null;
  invNo?: string;
  amount?: number | null;
  amountFmt?: string;
  modeNote?: string;
  amountNote?: string;
  paid?: number | string;
  cheque?: string;
  summary?: SummaryKind;
  mismatch?: boolean;
}

function fill(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

/* ── Builder ────────────────────────────────────────────────────────── */

export interface RegisterBuildResult {
  workbook: ExcelJS.Workbook;
  stats: {
    trips: number;
    rows: number;
    finalizedTrips: number;
    grandTotal: number;
    mismatches: number;
  };
}

export function buildTravelRegisterWorkbook(
  trips: RegisterTrip[],
  period: RegisterPeriod,
  generatedAt: Date,
): RegisterBuildResult {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Plumbox — CSTEP Travel Register";
  wb.created = generatedAt;
  const ws = wb.addWorksheet("Travel Register", {
    views: [{ zoomScale: 91, zoomScaleNormal: 91 }],
    properties: { defaultRowHeight: 15.05 },
  });
  WIDTHS.forEach((w, i) => {
    if (w !== undefined) ws.getColumn(i + 1).width = w;
  });

  // Row 1 — merged title.
  const title = ws.getRow(1);
  title.getCell(1).value = period.title;
  ws.mergeCells(1, 1, 1, COLS);
  title.getCell(1).font = { name: FONT, size: 14, bold: true, color: { argb: "FF000000" } };
  title.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
  title.height = 18.2;

  // Row 2 — blue header. NAME / REASON / Destination are not wrapped in the sample.
  const header = ws.getRow(2);
  HEADERS.forEach((h, i) => {
    const cell = header.getCell(i + 1);
    cell.value = h;
    cell.font = { name: FONT, size: 10, bold: true, ...(i + 1 === C.name ? { color: { argb: "FF000000" } } : {}) };
    cell.fill = fill(HEADER_FILL);
    const wrap = ![C.name, C.reason, C.dest].includes(i + 1 as any);
    cell.alignment = { horizontal: "center", vertical: "middle", ...(wrap ? { wrapText: true } : {}) };
  });
  header.height = 30.05;

  let rowNo = 3;
  let grandTotal = 0;
  let finalizedTrips = 0;
  let mismatches = 0;

  const sorted = [...trips].sort((a, b) => {
    const da = tripEffectiveDate(a.request);
    const db = tripEffectiveDate(b.request);
    if (da !== db) return da < db ? -1 : 1;
    const ta = a.request.claimReference || "";
    const tb = b.request.claimReference || "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return String(a.request.createdAt || "") < String(b.request.createdAt || "") ? -1 : 1;
  });

  for (const trip of sorted) {
    const r = trip.request;
    const eff = tripEffectiveDate(r);
    const identity = {
      month: eff ? MONTHS_SHORT[Number(eff.slice(5, 7)) - 1] : "",
      // TIN for a Tour Proposal, the claim reference for a Local Travel
      // Claim, the EVR reference for an Event Request (none before approval,
      // or on one approved before EVR references existed).
      tin: r.claimReference || "—",
      type: tripType(r),
      name: trip.travellerName,
      reason: r.purpose || "",
      project: [r.project, r.projectDebitable].filter((p) => p && String(p).trim()).join(" / "),
    };
    const route = tripRoute(r);
    const tripCols = { from: route.from, to: route.to, fromDate: r.departureDate, toDate: r.returnDate };
    // The claim date: the travel report's submission — or, for a Local
    // Travel Claim (no report), the claim's own submission.
    const claimDateIso = isLocalClaim(r) ? trip.submittedAt : trip.reportSubmittedAt;
    const reportDm = (() => {
      if (!claimDateIso) return null;
      const d = new Date(claimDateIso);
      return Number.isNaN(d.getTime()) ? null : dayMonth(istDate(d));
    })();

    const specs: RowSpec[] = [];

    if (trip.settlement) {
      // Stage C — settlement lines (CSTEP-paid first, then the traveller's
      // claim lines), the per-diem claim row, then TOTAL / PROVISIONAL.
      const official = trip.settlementLines.filter((l) => l.classification !== "PERSONAL");
      const personal = trip.settlementLines.filter((l) => l.classification === "PERSONAL");
      for (const l of official) {
        specs.push({
          from: l.leg?.fromLocation || tripCols.from,
          to: l.leg?.toLocation || tripCols.to,
          fromDate: l.leg?.fromDate || tripCols.fromDate,
          toDate: l.leg?.toDate || tripCols.toDate,
          mode: modeLabel(l.mode),
          amount: round2(Number(l.amountInr || 0)),
          amountFmt: INR_FMT,
          modeNote: l.description || undefined,
          ...vendorCols(l.arrangement, Number(l.amountInr || 0)),
        });
      }
      for (const l of personal) {
        specs.push({
          from: l.leg?.fromLocation || tripCols.from,
          to: l.leg?.toLocation || tripCols.to,
          fromDate: l.leg?.fromDate || tripCols.fromDate,
          toDate: l.leg?.toDate || tripCols.toDate,
          mode: "Travel Claim",
          agency: "Claim",
          invDate: reportDm,
          // A claim line's description already names its own mode ("Metro:
          // A → B"), which is finer than the bucketed service type.
          invNo:
            l.source === "CLAIM_LINE"
              ? l.description || modeLabel(l.mode)
              : l.description
                ? `${modeLabel(l.mode)} – ${l.description}`
                : modeLabel(l.mode),
          amount: round2(Number(l.amountInr || 0)),
          amountFmt: INR_FMT,
        });
      }
      const pd = trip.settlement.perDiem || {};
      const perDiemInr = round2(Number(pd.amountInr || 0));
      if (perDiemInr > 0) {
        specs.push({
          ...tripCols,
          mode: "Travel Claim",
          agency: "Claim",
          invDate: reportDm,
          invNo: "Per diem",
          amount: perDiemInr,
          amountFmt: INR_FMT,
          amountNote: `${Number(pd.days || 0)} day(s) × ${inr(Number(pd.rate || 0))}`,
        });
      }

      const stored = round2(Number(trip.settlement.totalCostOfTour || 0));
      const derived = round2(trip.settlementLines.reduce((s, l) => s + Number(l.amountInr || 0), 0) + perDiemInr);
      const mismatch = Math.abs(stored - derived) > 0.01;
      if (mismatch) mismatches++;
      const finalized = trip.settlement.status === "FINALIZED";
      if (finalized) {
        finalizedTrips++;
        grandTotal = round2(grandTotal + stored);
      }
      specs.push({
        ...tripCols,
        summary: finalized ? "total" : "provisional",
        amount: stored,
        amountFmt: INR_FMT,
        mismatch,
        amountNote: mismatch
          ? `Does not reconcile: stored Cost of the Tour ${inr(stored)} vs line items + per diem ${inr(derived)} (difference ${inr(round2(stored - derived))}). Check the settlement before relying on this figure.`
          : undefined,
      });
    } else {
      // Stages A/B — arrangement rows (own currency, never totalled), then
      // the grey status row. A trip with no real arrangement is the status
      // row alone.
      for (const a of trip.arrangements) {
        const cur = (a.currency || "INR").toUpperCase();
        const hasAmount = Number(a.amount) > 0;
        const notes: string[] = [];
        if (a.details) notes.push(a.details);
        if (a.status !== "ARRANGED") notes.push("Not yet marked arranged");
        let amountNote: string | undefined;
        if (hasAmount && cur !== "INR") {
          amountNote =
            Number(a.amountInr) > 0 && Number(a.exchangeRate) > 0
              ? `≈ ${inr(round2(Number(a.amountInr)))} at ${a.exchangeRate} INR/${cur}` +
                (a.rateDate ? ` on ${dottedFull(a.rateDate)}` : "") +
                (a.rateSource ? ` (${a.rateSource === "LIVE" ? "live rate" : "manual rate"})` : "") +
                ". Not final — shown in the booked currency, not included in any INR total."
              : `No INR rate recorded yet. Shown in the booked currency, not included in any INR total.`;
        }
        specs.push({
          ...tripCols,
          mode: modeLabel(a.arrangedType),
          amount: hasAmount ? round2(Number(a.amount)) : null,
          amountFmt: cur === "INR" ? INR_FMT : `"${cur} "#,##0.00`,
          modeNote: notes.length ? notes.join(" · ") : undefined,
          amountNote,
          ...vendorCols(a, Number(a.amountInr || 0)),
        });
      }
      specs.push({ ...tripCols, summary: "status" });
    }

    specs.forEach((spec, idx) => {
      writeRow(ws.getRow(rowNo), spec, identity, idx === 0, trip, generatedAt);
      rowNo++;
    });
  }

  // Grand total — FINALIZED trips only.
  rowNo++;
  const gt = ws.getRow(rowNo);
  gt.getCell(C.agency).value = "Settled trips only";
  gt.getCell(C.invDate).value = "GRAND TOTAL";
  gt.getCell(C.invNo).value = "Cost of the Tour";
  gt.getCell(C.amount).value = grandTotal;
  for (let c: number = C.agency; c <= C.amount; c++) {
    const cell = gt.getCell(c);
    cell.font = { name: FONT, size: 10, bold: true, ...(c === C.agency ? { color: { argb: RED } } : {}) };
    cell.fill = fill(YELLOW);
    cell.alignment = { horizontal: c === C.amount ? "right" : "center", vertical: "middle", wrapText: true };
  }
  gt.getCell(C.amount).numFmt = INR_FMT;
  gt.getCell(C.amount).note =
    `Sum of Cost of the Tour for ${finalizedTrips} finalized trip(s). Trips still in progress or being verified are not included.` +
    (mismatches ? ` ${mismatches} trip(s) in this register do not reconcile — see the highlighted totals.` : "");
  gt.height = 30.05;

  // Footer — generation stamp, below the data so rows 1–2 stay as in the sample.
  rowNo += 2;
  const ft = ws.getRow(rowNo).getCell(1);
  const stamp = new Date(generatedAt.getTime() + IST_OFFSET_MS).toISOString();
  ft.value =
    `Generated ${dottedFull(stamp.slice(0, 10))} ${stamp.slice(11, 16)} IST · period ${dottedFull(period.from)} – ${dottedFull(period.to)} by departure date · ${sorted.length} trip(s). ` +
    `Grey rows are trips still in progress; their amounts are in each booking's own currency and are not totalled.`;
  ft.font = { name: FONT, size: 9, italic: true };

  return {
    workbook: wb,
    stats: { trips: sorted.length, rows: rowNo, finalizedTrips, grandTotal, mismatches },
  };
}

function writeRow(
  row: ExcelJS.Row,
  spec: RowSpec,
  identity: { month: string; tin: string; type: string; name: string; reason: string; project: string },
  firstOfTrip: boolean,
  trip: RegisterTrip,
  generatedAt: Date,
) {
  const set = (col: number, v: any) => {
    if (v !== undefined && v !== null && v !== "") row.getCell(col).value = v;
  };
  set(C.month, identity.month);
  set(C.tin, identity.tin);
  set(C.type, identity.type);
  set(C.name, identity.name);
  set(C.reason, identity.reason);
  set(C.from, spec.from);
  set(C.dest, spec.to);
  set(C.fromDate, dayMonth(spec.fromDate));
  set(C.toDate, dayMonth(spec.toDate));
  set(C.mode, spec.mode);
  set(C.agency, spec.agency);
  set(C.invDate, spec.invDate);
  set(C.invNo, spec.invNo);
  set(C.project, identity.project);
  set(C.paid, spec.paid);
  set(C.cheque, spec.cheque);

  if (spec.summary === "total" || spec.summary === "provisional") {
    const claim = isLocalClaim(trip.request);
    const on = dottedShort(claim ? trip.submittedAt : trip.reportSubmittedAt);
    set(C.agency, on ? `Submitted on ${on}` : "Submitted");
    set(C.invDate, spec.summary === "total" ? "TOTAL" : "TOTAL (prov.)");
    const what = claim ? "Total claimed" : "Cost of the Tour";
    set(C.invNo, spec.summary === "total" ? what : `${what} (being verified)`);
  } else if (spec.summary === "status") {
    const label = statusLabel(trip.request);
    const on = dottedShort(trip.submittedAt);
    // Same slots as the sample's summary row: K = "Submitted on dd.mm" (when it was),
    // L = STATUS in place of TOTAL, M (the wide column) = where the trip is now.
    set(C.agency, on && trip.request.status !== "DRAFT" ? `Submitted on ${on}` : "Not submitted");
    set(C.invDate, "STATUS");
    const asOf = istDate(generatedAt);
    set(C.invNo, `${label} · as of ${asOf.slice(8, 10)}.${asOf.slice(5, 7)}.${asOf.slice(2, 4)}`);
  }
  if (spec.amount !== undefined && spec.amount !== null) row.getCell(C.amount).value = spec.amount;

  // Base style — every cell A..R, as the sample formats the whole row.
  for (let c = 1; c <= COLS; c++) {
    const cell = row.getCell(c);
    const bold = c === C.type || (firstOfTrip && (c === C.month || c === C.tin));
    const red = firstOfTrip && (c === C.month || c === C.tin);
    cell.font = { name: FONT, size: 10, ...(bold ? { bold: true } : {}), ...(red ? { color: { argb: RED } } : {}) };
    cell.alignment =
      c === C.amount
        ? { horizontal: "right", vertical: "middle", wrapText: true }
        : c === C.reason
          ? { horizontal: "center", vertical: "middle" }
          : { horizontal: "center", vertical: "middle", wrapText: true };
  }
  for (const c of [C.fromDate, C.toDate, C.invDate]) {
    if (typeof row.getCell(c).value === "number") row.getCell(c).numFmt = DAY_MONTH_FMT;
  }
  row.getCell(C.amount).numFmt = spec.amountFmt || INR_FMT;
  if (typeof spec.paid === "number") row.getCell(C.paid).numFmt = INR_FMT;
  row.height = spec.summary === "status" ? 45.1 : spec.summary ? 30.05 : 15.65;

  if (spec.summary) {
    const bg = spec.summary === "total" ? YELLOW : spec.summary === "provisional" ? PROVISIONAL_FILL : STATUS_FILL;
    for (let c: number = C.agency; c <= C.amount; c++) {
      const cell = row.getCell(c);
      cell.fill = fill(bg);
      cell.font = {
        name: FONT,
        size: 10,
        bold: true,
        ...(c === C.agency ? { color: { argb: RED } } : {}),
      };
    }
  }
  if (spec.mismatch) {
    const cell = row.getCell(C.amount);
    cell.fill = fill(MISMATCH_FILL);
    cell.font = { name: FONT, size: 10, bold: true, color: { argb: "FF9C0006" } };
  }
  if (spec.modeNote) row.getCell(C.mode).note = spec.modeNote;
  if (spec.amountNote) row.getCell(C.amount).note = spec.amountNote;
}
