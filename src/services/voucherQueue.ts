// apps/backend/src/services/voucherQueue.ts
//
// The voucher queue's filters and list-card shape, in ONE place.
//
// "Needs review" is the card ops act on, and it is also a list filter. Both
// read NEEDS_REVIEW_REASONS below — the stat-card count, the list filter and
// the per-card flag are all Mongo queries built from these same filters, so
// they cannot disagree. There is deliberately no JavaScript re-statement of
// the rule anywhere.
//
// Needs review = FAILED, OR the render failed, OR the last render left
// warnings. "Not rendered" (SUCCESS with no rendered PDF) is a separate
// filter and is NOT part of Needs review.

/** A record whose extraction failed. */
const FAILED = { status: "FAILED" };

/**
 * Extracted, but the render failed and there is no PDF. The render paths
 * record the failure in errorDetails.stage (RENDER_PDF_FAILED on upload,
 * RENDER_PDF_FAILED_MANUAL on a re-render) and never clear it, so the stage
 * alone would keep flagging a record that a later re-render fixed — hence
 * "and no PDF".
 */
const RENDER_FAILED = {
  status: "SUCCESS",
  "errorDetails.stage": /RENDER/,
  "renderedS3.key": { $in: [null, ""] },
};

/** The last render left "Check before sending" warnings. */
const HAS_WARNINGS = { "meta.renderWarnings.0": { $exists: true } };

export const NEEDS_REVIEW_REASONS = {
  failed: FAILED,
  render_failed: RENDER_FAILED,
  warnings: HAS_WARNINGS,
} as const;

export type ReviewReason = keyof typeof NEEDS_REVIEW_REASONS;

/** The single Needs-review rule, as a Mongo filter. */
export function needsReviewFilter(): Record<string, unknown> {
  return { $or: Object.values(NEEDS_REVIEW_REASONS) };
}

/** Extracted, with no rendered PDF. Separate from Needs review. */
export function notRenderedFilter(): Record<string, unknown> {
  return { status: "SUCCESS", "renderedS3.key": { $in: [null, ""] } };
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** Fields the list search runs over: the card summary plus the file name. */
const SEARCH_PATHS = [
  "file.originalName",
  "extractedJson.hotel_details.name",
  "extractedJson.hotel_details.city",
  "extractedJson.guest_details.primary_guest",
  "extractedJson.guest_details.all_guest_names",
  "extractedJson.passengers.name",
  "extractedJson.booking_info.pnr",
  "extractedJson.booking_info.booking_id",
  "extractedJson.booking_info.voucher_no",
  "extractedJson.booking_info.supplier_conf_no",
  "extractedJson.flight_details.segments.flight_no",
  "extractedJson.flight_details.segments.airline",
  "extractedJson.flight_details.segments.origin.code",
  "extractedJson.flight_details.segments.origin.city",
  "extractedJson.flight_details.segments.destination.code",
  "extractedJson.flight_details.segments.destination.city",
];

export function searchFilter(q: string): Record<string, unknown> | null {
  const term = String(q || "").trim().slice(0, 80);
  if (!term) return null;
  const rx = new RegExp(term.replace(ESCAPE, "\\$&"), "i");
  return { $or: SEARCH_PATHS.map((p) => ({ [p]: rx })) };
}

export type QueueQuery = {
  status?: string;
  type?: string;
  review?: string;
  q?: string;
};

/** The list filters, ANDed onto the caller's scope. Unknown values are ignored. */
export function queueFilter(scope: Record<string, unknown>, query: QueueQuery) {
  const and: Record<string, unknown>[] = [scope];
  if (query.status === "PROCESSING" || query.status === "SUCCESS" || query.status === "FAILED") {
    and.push({ status: query.status });
  }
  if (query.type === "hotel" || query.type === "flight") and.push({ docType: query.type });
  if (query.review === "needs_review") and.push(needsReviewFilter());
  if (query.review === "not_rendered") and.push(notRenderedFilter());
  const search = searchFilter(String(query.q || ""));
  if (search) and.push(search);
  return and.length === 1 ? scope : { $and: and };
}

/** What the list cards read. Everything else (extractedJson, rawModelResponse, errorDetails) stays out. */
export const LIST_PROJECTION = {
  _id: 1,
  workspaceId: 1,
  createdBy: 1,
  status: 1,
  docType: 1,
  error: 1,
  "file.originalName": 1,
  "file.size": 1,
  "file.mime": 1,
  createdAt: 1,
  "renderedS3.key": 1,
  "meta.renderWarnings": 1,
  "extractedJson.hotel_details.name": 1,
  "extractedJson.hotel_details.city": 1,
  "extractedJson.stay_details.check_in_date": 1,
  "extractedJson.stay_details.check_out_date": 1,
  "extractedJson.stay_details.total_nights": 1,
  "extractedJson.guest_details.primary_guest": 1,
  "extractedJson.guest_details.total_pax": 1,
  "extractedJson.booking_info.pnr": 1,
  "extractedJson.booking_info.booking_id": 1,
  "extractedJson.booking_info.voucher_no": 1,
  "extractedJson.flight_details.segments.flight_no": 1,
  "extractedJson.flight_details.segments.origin.code": 1,
  "extractedJson.flight_details.segments.origin.city": 1,
  "extractedJson.flight_details.segments.origin.date": 1,
  "extractedJson.flight_details.segments.destination.code": 1,
  "extractedJson.flight_details.segments.destination.city": 1,
  "extractedJson.passengers.name": 1,
};

function str(x: any): string | null {
  if (x === null || x === undefined) return null;
  const s = String(x).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  return lower === "null" || lower === "n/a" || lower === "-" ? null : s;
}

/** The card's domain facts, as extracted. A field the voucher didn't state is null, never a placeholder. */
export function listSummary(row: any) {
  const v = row?.extractedJson || {};
  const bi = v.booking_info || {};
  const common = {
    pnr: str(bi.pnr),
    bookingRef: str(bi.booking_id) || str(bi.voucher_no),
  };
  if (row?.docType === "flight") {
    const segs: any[] = Array.isArray(v.flight_details?.segments) ? v.flight_details.segments : [];
    const first = segs[0];
    const last = segs[segs.length - 1];
    const end = (p: any) => str(p?.code) || str(p?.city);
    const pax: any[] = Array.isArray(v.passengers) ? v.passengers : [];
    // Every stop in order (origin of each segment, then the last arrival), so a
    // round trip reads BOM → GOI → BOM rather than BOM → BOM.
    const route: string[] = [];
    for (const p of [...segs.map((x) => x?.origin), last?.destination]) {
      const code = end(p);
      if (code && route[route.length - 1] !== code) route.push(code);
    }
    return {
      ...common,
      from: end(first?.origin),
      to: end(last?.destination),
      route,
      flightNos: segs.map((s) => str(s?.flight_no)).filter(Boolean) as string[],
      departDate: str(first?.origin?.date),
      leadGuest: str(pax[0]?.name),
      paxCount: pax.length || null,
    };
  }
  const nights = Number(v.stay_details?.total_nights);
  const pax = Number(v.guest_details?.total_pax);
  return {
    ...common,
    hotel: str(v.hotel_details?.name),
    city: str(v.hotel_details?.city),
    checkIn: str(v.stay_details?.check_in_date),
    checkOut: str(v.stay_details?.check_out_date),
    nights: Number.isFinite(nights) && nights > 0 ? nights : null,
    leadGuest: str(v.guest_details?.primary_guest),
    paxCount: Number.isFinite(pax) && pax > 0 ? pax : null,
  };
}
