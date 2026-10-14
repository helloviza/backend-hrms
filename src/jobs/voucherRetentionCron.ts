// apps/backend/src/jobs/voucherRetentionCron.ts
//
// Daily voucher retention run (rules: services/voucherRetention.ts).
//
// Scheduled the way the other in-process jobs are (taskDigestCron,
// orphan-pending-cleanup): node-cron in the backend process, registered from
// server.ts on the primary host only (not the WA host), Asia/Kolkata time.
// The deletions run only when VOUCHER_RETENTION_ENABLED=true — shipped OFF;
// with it off a run only logs that it skipped.
//
// Every key deleted comes from a VoucherExtraction record (s3, renderedS3,
// supersededRenders) and is removed with ALL its versions and delete markers
// (deleteAllObjectVersions; the bucket is versioned with no lifecycle rule).
// Per record: S3 objects are deleted first, then the record is stamped
// (sourceDeletedAt / renderDeletedAt / rawPurgedAt / supersededRenders[].deletedAt)
// or removed. An S3 failure leaves that part unstamped, so the next run
// retries it. Every update re-checks status ≠ PROCESSING.
import cron from "node-cron";
import VoucherExtraction from "../models/VoucherExtraction.js";
import { deleteAllObjectVersions } from "../utils/s3Upload.js";
import logger from "../utils/logger.js";
import { planRecord, retentionEnabled, TRIP_DATE_UNKNOWN_WARNING, type RecordPlan, type S3Ref } from "../services/voucherRetention.js";
import { stuckProcessingFilter, timedOutUpdate } from "../services/voucherQueue.js";

export type RetentionRunSummary = {
  /** Records failed as "Timed out" (F-05) — runs whether or not retention is enabled. */
  timedOut: number;
  enabled: boolean;
  scanned: number;
  rawPurged: number;
  sourcesDeleted: number;
  rendersDeleted: number;
  supersededDeleted: number;
  recordsDeleted: number;
  /** Records flagged "Trip date unknown — files kept until reviewed". */
  flaggedTripUnknown: number;
  s3Failures: number;
};

const NOT_PROCESSING = { status: { $ne: "PROCESSING" } };

async function deleteFiles(files: S3Ref[], recordId: string): Promise<S3Ref[]> {
  const done: S3Ref[] = [];
  for (const f of files) {
    try {
      // The bucket is versioned: remove every version and delete marker of
      // this exact key, or the bytes would stay behind a delete marker.
      await deleteAllObjectVersions(f.key, f.bucket);
      done.push(f);
    } catch (err: any) {
      logger.error("[VoucherRetention] S3 delete failed; left for the next run", { recordId, key: f.key, message: err?.message });
    }
  }
  return done;
}

async function applyPlan(p: RecordPlan, now: Date, sum: RetentionRunSummary): Promise<void> {
  const filter = { _id: p.id, ...NOT_PROCESSING };

  if (p.deleteRecord) {
    const done = await deleteFiles(p.deleteRecord.files, p.id);
    sum.s3Failures += p.deleteRecord.files.length - done.length;
    // Keep the record while any of its files is still in the bucket, so the
    // next run can still find them.
    if (done.length === p.deleteRecord.files.length) {
      const r = await VoucherExtraction.deleteOne(filter);
      sum.recordsDeleted += r.deletedCount ?? 0;
    }
    return;
  }

  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ""> = {};
  const $addToSet: Record<string, unknown> = {};

  if (p.flagTripUnknown) {
    $addToSet["meta.renderWarnings"] = TRIP_DATE_UNKNOWN_WARNING;
    sum.flaggedTripUnknown++;
  }

  if (p.purgeRaw) {
    $unset.rawModelResponse = "";
    if (p.purgeRaw.keepStage) $set.errorDetails = { stage: p.purgeRaw.keepStage };
    else $unset.errorDetails = "";
    if (p.purgeRaw.refundability !== undefined) $set["extractedJson.policies.is_non_refundable"] = p.purgeRaw.refundability;
    $set.rawPurgedAt = now;
    sum.rawPurged++;
  }

  if (p.deleteSource) {
    const ok = (await deleteFiles([p.deleteSource], p.id)).length === 1;
    if (ok) {
      $set.sourceDeletedAt = now;
      sum.sourcesDeleted++;
    } else sum.s3Failures++;
  }
  if (p.deleteRender) {
    const ok = (await deleteFiles([p.deleteRender], p.id)).length === 1;
    if (ok) {
      $unset.renderedS3 = "";
      $set.renderDeletedAt = now;
      sum.rendersDeleted++;
    } else sum.s3Failures++;
  }

  const update: Record<string, unknown> = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;
  if (Object.keys($addToSet).length) update.$addToSet = $addToSet;
  if (Object.keys(update).length) {
    await VoucherExtraction.updateOne(
      // A PDF deleted here must still be the current one when the stamp lands.
      p.deleteRender ? { ...filter, "renderedS3.key": p.deleteRender.key } : filter,
      update,
    );
  }

  if (p.deleteSuperseded.length) {
    const done = await deleteFiles(p.deleteSuperseded, p.id);
    sum.s3Failures += p.deleteSuperseded.length - done.length;
    for (const f of done) {
      await VoucherExtraction.updateOne(
        { _id: p.id },
        { $set: { "supersededRenders.$[r].deletedAt": now } },
        { arrayFilters: [{ "r.key": f.key, "r.deletedAt": null }] },
      );
      sum.supersededDeleted++;
    }
  }
}

/**
 * One daily pass. First, records stuck in PROCESSING for 15+ minutes are
 * failed as "Timed out" (F-05) — always, it deletes nothing. Then retention,
 * only when enabled; disabled, it scans nothing.
 */
export async function runVoucherRetention(now: Date = new Date()): Promise<RetentionRunSummary> {
  const timedOut = await VoucherExtraction.updateMany(stuckProcessingFilter(now), timedOutUpdate(now));
  const sum: RetentionRunSummary = {
    timedOut: timedOut.modifiedCount ?? 0,
    enabled: retentionEnabled(),
    scanned: 0,
    rawPurged: 0,
    sourcesDeleted: 0,
    rendersDeleted: 0,
    supersededDeleted: 0,
    recordsDeleted: 0,
    flaggedTripUnknown: 0,
    s3Failures: 0,
  };
  if (!sum.enabled) return sum;

  // Every non-PROCESSING record: trip end is computed from extractedJson, so
  // what is due can't be expressed as one query. The collection is small
  // (hundreds of rows); a cursor keeps memory flat regardless.
  // A record this run just timed out was PROCESSING when the run began: it is
  // left for the next run rather than deleted in the same breath.
  const cursor = VoucherExtraction.find({ ...NOT_PROCESSING, timedOutAt: { $ne: now } }).lean().cursor();
  for await (const rec of cursor) {
    sum.scanned++;
    const plan = planRecord(rec, now);
    if (!plan) continue;
    try {
      await applyPlan(plan, now, sum);
    } catch (err: any) {
      logger.error("[VoucherRetention] record failed; continuing", { recordId: plan.id, message: err?.message });
    }
  }
  return sum;
}

/** Daily at 03:30 IST. */
export function startVoucherRetentionCron(): void {
  cron.schedule(
    "30 3 * * *",
    async () => {
      try {
        const sum = await runVoucherRetention();
        if (!sum.enabled) logger.info("[VoucherRetention] VOUCHER_RETENTION_ENABLED is off — nothing deleted", { timedOut: sum.timedOut });
        else logger.info("[VoucherRetention] run complete", sum);
      } catch (err: any) {
        logger.error("[VoucherRetention] run failed", { message: err?.message });
      }
    },
    { timezone: "Asia/Kolkata" },
  );
  logger.info(
    `[VoucherRetention] Cron scheduled — daily 03:30 IST (retention ${retentionEnabled() ? "ENABLED" : "disabled"})`,
  );
}
