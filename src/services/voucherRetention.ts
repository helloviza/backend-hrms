// apps/backend/src/services/voucherRetention.ts
//
// Retention for voucher extractions (audit F-15, F-08). ONE planner decides
// what is due for every record; the daily job (jobs/voucherRetentionCron.ts)
// applies the plan and the read-only dry run (scripts/voucher-retention-dry-run.ts)
// prints it, so the two can't disagree about what a real run would delete.
//
// Rules (`now` = the run's time):
//   1. rawModelResponse + errorDetails: purged 48h after upload on SUCCESS,
//      30 days after upload on FAILED (kept that long for debugging).
//      errorDetails keeps only its `stage` — the Needs-review "render failed"
//      reason reads errorDetails.stage. Before the purge, the refundability the
//      raw response implies is written into extractedJson (statedNonRefundable)
//      so an older record renders the same once the raw text is gone.
//   2. Source file + rendered PDF in S3: deleted 7 days after the trip ends
//      (hotel check-out / last flight arrival, resolved with voucherDates the
//      way the PDF resolves them). A PDF regenerated after that point is
//      deleted again by the next run. When NO trip date can be resolved the
//      files are kept (until rule 4) and an extracted record is flagged with
//      TRIP_DATE_UNKNOWN_WARNING in meta.renderWarnings, which puts it in
//      Needs review. Nothing is deleted on a guess.
//   3. Superseded rendered PDFs (supersededRenders[]): deleted in every run.
//   4. The whole record (JSON included) and every file it points to: deleted
//      12 months after upload.
// A PROCESSING record is never touched by any rule.
//
// S3 objects under hrms/vouchers/ that no record points to (F-02 orphans, and
// renders superseded before supersededRenders[] existed) are REPORTED by the
// dry run, never deleted. That prefix is shared with HR Policies uploads.

import { buildDateContext, resolveStayDates, resolveVoucherDate } from "./voucherDates.js";
import { statedNonRefundable } from "./voucherNormalize.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const RETENTION_RULES = {
  rawAfterSuccessMs: 48 * HOUR_MS,
  rawAfterFailedMs: 30 * DAY_MS,
  filesAfterTripEndMs: 7 * DAY_MS,
  recordMonths: 12,
} as const;

/** Off unless VOUCHER_RETENTION_ENABLED is true. Shipped disabled. */
export function retentionEnabled(): boolean {
  return /^(1|true|yes)$/i.test(String(process.env.VOUCHER_RETENTION_ENABLED || "").trim());
}

export type S3Ref = { bucket: string; key: string };

/** The "Check before sending" line on a record whose trip date can't be resolved. */
export const TRIP_DATE_UNKNOWN_WARNING = "Trip date unknown — files kept until reviewed";

function s3Ref(x: any): S3Ref | null {
  const key = typeof x?.key === "string" ? x.key.trim() : "";
  if (!key) return null;
  return { bucket: String(x?.bucket || ""), key };
}

/**
 * When the trip ends, as a UTC calendar day (the voucher's own day, no time):
 * the hotel check-out, or the last flight's arrival (its departure when the
 * arrival has no date). Resolved exactly as the adapter resolves them — same
 * date context, flight legs in order, each not before the one before it.
 * null when the voucher gives no readable date.
 */
export function voucherTripEnd(record: any): Date | null {
  const v = record?.extractedJson;
  if (!v || typeof v !== "object") return null;
  const dctx = buildDateContext(v?.booking_info?.booking_date, record?.createdAt, []);
  if (record?.docType === "flight") {
    const segs: any[] = Array.isArray(v?.flight_details?.segments) ? v.flight_details.segments : [];
    let prev: Date | null = null;
    let last: Date | null = null;
    segs.forEach((seg, i) => {
      const n = segs.length > 1 ? ` (segment ${i + 1})` : "";
      const dep = resolveVoucherDate(seg?.origin?.date, dctx, { label: `Departure date${n}`, notBefore: prev });
      const arr = resolveVoucherDate(seg?.destination?.date, dctx, { label: `Arrival date${n}`, notBefore: dep ?? prev });
      prev = arr ?? dep ?? prev;
      if (arr ?? dep) last = arr ?? dep;
    });
    return last;
  }
  const stay = v?.stay_details || {};
  const { checkIn, checkOut } = resolveStayDates(stay.check_in_date, stay.check_out_date, stay.total_nights, dctx);
  return checkOut ?? checkIn ?? null;
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

export type RetentionRule = "raw" | "files" | "superseded" | "record" | "flag";

export interface RecordPlan {
  id: string;
  status: string;
  docType: string;
  workspaceId: string;
  createdAt: Date;
  guest: string | null;
  tripEnd: Date | null;
  /** When the source + PDF fall due (trip end + 7d); null = no trip date, files kept. */
  filesDueAt: Date | null;
  /** No trip date on an extracted record that doesn't carry the warning yet: add it. */
  flagTripUnknown: boolean;
  /** Rule 4: delete the record and every file it points to. Excludes the others. */
  deleteRecord: { files: S3Ref[] } | null;
  /** Rule 1. `refundability` is set when extractedJson must be frozen first. */
  purgeRaw: { refundability?: boolean | null; keepStage: string | null } | null;
  /** Rule 2. */
  deleteSource: S3Ref | null;
  deleteRender: S3Ref | null;
  /** Rule 3. */
  deleteSuperseded: S3Ref[];
}

function guestOf(record: any): string | null {
  const v = record?.extractedJson || {};
  const name = record?.docType === "flight" ? v?.passengers?.[0]?.name : v?.guest_details?.primary_guest;
  const s = typeof name === "string" ? name.trim() : "";
  return s || null;
}

function hasValue(x: unknown): boolean {
  if (x === undefined || x === null) return false;
  if (typeof x === "object") return Object.keys(x as object).length > 0;
  return true;
}

/**
 * What a run at `now` does to this record. Pure: reads the document, writes
 * nothing. Returns null when nothing is due (or the record is PROCESSING).
 */
export function planRecord(record: any, now: Date): RecordPlan | null {
  if (!record || record.status === "PROCESSING") return null;
  const createdAt = new Date(record.createdAt);
  if (isNaN(createdAt.getTime())) return null;
  const t = now.getTime();

  const source = record.sourceDeletedAt ? null : s3Ref(record.s3);
  const render = s3Ref(record.renderedS3);
  const superseded: S3Ref[] = (Array.isArray(record.supersededRenders) ? record.supersededRenders : [])
    .filter((r: any) => !r?.deletedAt)
    .map(s3Ref)
    .filter((r: S3Ref | null): r is S3Ref => !!r);

  const tripEnd = voucherTripEnd(record);
  const filesDueAt = tripEnd
    ? new Date(tripEnd.getTime() + DAY_MS + RETENTION_RULES.filesAfterTripEndMs) // end of the trip's last day + 7d
    : null;
  const warnings: unknown[] = Array.isArray(record?.meta?.renderWarnings) ? record.meta.renderWarnings : [];
  // FAILED records are in Needs review already; only an extracted record needs the flag.
  const flagTripUnknown = !tripEnd && record.status === "SUCCESS" && !warnings.includes(TRIP_DATE_UNKNOWN_WARNING);

  const base = {
    id: String(record._id),
    status: String(record.status),
    docType: String(record.docType),
    workspaceId: String(record.workspaceId || ""),
    createdAt,
    guest: guestOf(record),
    tripEnd,
    filesDueAt,
  };

  if (t >= addMonths(createdAt, RETENTION_RULES.recordMonths).getTime()) {
    const files = [source, render, ...superseded].filter((r): r is S3Ref => !!r);
    return { ...base, flagTripUnknown: false, deleteRecord: { files }, purgeRaw: null, deleteSource: null, deleteRender: null, deleteSuperseded: [] };
  }

  let purgeRaw: RecordPlan["purgeRaw"] = null;
  const rawAge = record.status === "FAILED" ? RETENTION_RULES.rawAfterFailedMs : RETENTION_RULES.rawAfterSuccessMs;
  const errorStage = typeof record?.errorDetails?.stage === "string" ? record.errorDetails.stage : null;
  const errorIsSlim = hasValue(record.errorDetails) && Object.keys(record.errorDetails).every((k) => k === "stage");
  const rawLeft = hasValue(record.rawModelResponse) || (hasValue(record.errorDetails) && !errorIsSlim);
  if (rawLeft && t >= createdAt.getTime() + rawAge) {
    purgeRaw = { keepStage: errorStage };
    if (record.extractedJson?.policies) {
      const stated = statedNonRefundable(record);
      const stored = record.extractedJson.policies.is_non_refundable;
      if (stated !== (typeof stored === "boolean" ? stored : null)) purgeRaw.refundability = stated;
    }
  }

  const filesDue = !!filesDueAt && t >= filesDueAt.getTime();
  const plan: RecordPlan = {
    ...base,
    flagTripUnknown,
    deleteRecord: null,
    purgeRaw,
    deleteSource: filesDue ? source : null,
    deleteRender: filesDue ? render : null,
    deleteSuperseded: superseded,
  };
  const anything = plan.purgeRaw || plan.deleteSource || plan.deleteRender || plan.deleteSuperseded.length || plan.flagTripUnknown;
  return anything ? plan : null;
}

/** The rules a plan applies, for counting. */
export function planRules(p: RecordPlan): RetentionRule[] {
  if (p.deleteRecord) return ["record"];
  const out: RetentionRule[] = [];
  if (p.purgeRaw) out.push("raw");
  if (p.deleteSource || p.deleteRender) out.push("files");
  if (p.deleteSuperseded.length) out.push("superseded");
  if (p.flagTripUnknown) out.push("flag");
  return out;
}
