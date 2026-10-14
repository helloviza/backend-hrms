// apps/backend/src/scripts/voucher-retention-dry-run.ts
//
// READ-ONLY. Prints what the FIRST real voucher retention run would do, using
// the same planner as the job (services/voucherRetention.ts):
//   - counts per rule, then one line per record: id / guest / trip end / files;
//   - the Legacy (Inactive) workspace's records in their own section;
//   - S3 objects under hrms/vouchers/ that no voucher record and no HR policy
//     points to (report only — retention never deletes these).
//
// Writes nothing anywhere: the raw driver only (no model is compiled, so
// mongoose can't build an index), autoIndex/autoCreate off, and S3 is only
// listed (ListObjectsV2), never written.
//
//   node --env-file=<env with MONGO_URI, S3_BUCKET, AWS_REGION> --import tsx \
//     src/scripts/voucher-retention-dry-run.ts [--at=2026-10-16T03:30:00+05:30]
import mongoose from "mongoose";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { planRecord, planRules, RETENTION_RULES, voucherTripEnd, type RecordPlan, type RetentionRule } from "../services/voucherRetention.js";

const LEGACY_WS = "69c8444b38fb14a93d0af308"; // "Legacy (Inactive)" — SUPERADMIN-only records
const PREFIX = "hrms/vouchers/";

const atArg = process.argv.find((a) => a.startsWith("--at="));
const now = atArg ? new Date(atArg.slice(5)) : new Date();
if (isNaN(now.getTime())) throw new Error("bad --at");

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");
const short = (k: string) => k.replace(PREFIX, "…/");

function fileList(p: RecordPlan): string[] {
  if (p.deleteRecord) return p.deleteRecord.files.map((f) => `file ${short(f.key)}`).concat(["RECORD (JSON)"]);
  const out: string[] = [];
  if (p.purgeRaw) {
    const freeze = p.purgeRaw.refundability !== undefined ? `; refundability frozen → ${p.purgeRaw.refundability}` : "";
    out.push(`rawModelResponse+errorDetails${p.purgeRaw.keepStage ? ` (keep stage ${p.purgeRaw.keepStage})` : ""}${freeze}`);
  }
  if (p.flagTripUnknown) out.push("FLAG trip date unknown — files kept");
  if (p.deleteSource) out.push(`source ${short(p.deleteSource.key)}`);
  if (p.deleteRender) out.push(`pdf ${short(p.deleteRender.key)}`);
  for (const s of p.deleteSuperseded) out.push(`superseded pdf ${short(s.key)}`);
  return out;
}

function printSection(title: string, plans: RecordPlan[], scanned: number, keptNoTrip: number) {
  const counts: Record<RetentionRule, number> = { raw: 0, files: 0, superseded: 0, record: 0, flag: 0 };
  let sources = 0, pdfs = 0, superseded = 0, filesInRecords = 0;
  for (const p of plans) {
    for (const r of planRules(p)) counts[r]++;
    if (p.deleteSource) sources++;
    if (p.deleteRender) pdfs++;
    superseded += p.deleteSuperseded.length;
    if (p.deleteRecord) filesInRecords += p.deleteRecord.files.length;
  }
  console.log(`\n=== ${title} — ${scanned} records scanned, ${plans.length} with something due ===`);
  console.log(`  rule 1  raw purge (48h SUCCESS / 30d FAILED) : ${counts.raw} records`);
  console.log(`  rule 2  files (trip end +7d)                  : ${counts.files} records — ${sources} source files, ${pdfs} rendered PDFs`);
  console.log(`          no trip date → files KEPT         : ${keptNoTrip} records (${counts.flag} get the "Trip date unknown" flag; the rest are FAILED or already flagged)`);
  console.log(`  rule 3  superseded PDFs                      : ${counts.superseded} records — ${superseded} files`);
  console.log(`  rule 4  whole record (12 months)             : ${counts.record} records — ${filesInRecords} files`);
  if (!plans.length) return;
  console.log("  id                       | status  | type   | uploaded   | trip end   | files due  | guest | what");
  for (const p of plans.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    console.log(
      `  ${p.id} | ${p.status.padEnd(7)} | ${p.docType.padEnd(6)} | ${day(p.createdAt)} | ${day(p.tripEnd)} | ${day(p.filesDueAt)} | ${p.guest ?? "—"} | ${fileList(p).join("; ")}`,
    );
  }
}

async function listS3(bucket: string, region: string) {
  const s3 = new S3Client({ region });
  const out: { key: string; size: number; lastModified: Date | undefined }[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

const uri = process.env.MONGO_URI;
if (!uri) throw new Error("MONGO_URI missing");
await mongoose.connect(uri, { autoIndex: false, autoCreate: false, readPreference: "secondaryPreferred" });
const db = mongoose.connection.db!;

console.log(`Voucher retention DRY RUN — as of ${now.toISOString()} (nothing is written or deleted)`);
console.log(`Rules: raw ${RETENTION_RULES.rawAfterSuccessMs / 3_600_000}h after SUCCESS, ${RETENTION_RULES.rawAfterFailedMs / 86_400_000}d after FAILED; files ${RETENTION_RULES.filesAfterTripEndMs / 86_400_000}d after trip end (no trip date → kept + flagged); superseded PDFs every run; record ${RETENTION_RULES.recordMonths} months after upload; PROCESSING never.`);

const records = await db.collection("voucherextractions").find({}).toArray();
const processing = records.filter((r: any) => r.status === "PROCESSING").length;
const main: RecordPlan[] = [];
const legacy: RecordPlan[] = [];
let mainScanned = 0, legacyScanned = 0, mainKept = 0, legacyKept = 0;
const yearAgo = new Date(now); yearAgo.setUTCMonth(yearAgo.getUTCMonth() - RETENTION_RULES.recordMonths);
for (const r of records) {
  const isLegacy = String(r.workspaceId) === LEGACY_WS;
  if (isLegacy) legacyScanned++;
  else mainScanned++;
  if (r.status !== "PROCESSING" && !voucherTripEnd(r) && new Date(r.createdAt) > yearAgo) {
    if (isLegacy) legacyKept++;
    else mainKept++;
  }
  const p = planRecord(r, now);
  if (p) (isLegacy ? legacy : main).push(p);
}
console.log(`\n${records.length} voucher records in total; ${processing} PROCESSING (skipped by every rule).`);
printSection("All workspaces except Legacy (Inactive)", main, mainScanned, mainKept);
printSection(`Legacy (Inactive) workspace ${LEGACY_WS}`, legacy, legacyScanned, legacyKept);

// Superseded PDFs made before supersededRenders[] existed can't be tied to a
// record by key; renderedRevision says how many there were.
const historical = records.reduce((n: number, r: any) => n + Math.max(0, (Number(r.renderedRevision) || 0) - 1), 0);
console.log(`\nHistorical re-renders (renderedRevision − 1, summed): ${historical}. Their old PDFs are not tracked by any record; they show up below as orphans.`);

// ── Orphans (report only) ──
const bucket = process.env.S3_BUCKET || "";
const region = process.env.AWS_REGION || "ap-south-1";
try {
  const objects = await listS3(bucket, region);
  const referenced = new Set<string>();
  for (const r of records as any[]) {
    if (r.s3?.key) referenced.add(r.s3.key);
    if (r.renderedS3?.key) referenced.add(r.renderedS3.key);
    for (const s of r.supersededRenders ?? []) if (s?.key) referenced.add(s.key);
  }
  const policies = await db.collection("policies").find({ "s3.key": { $regex: `^${PREFIX}` } }, { projection: { "s3.key": 1 } }).toArray();
  for (const p of policies as any[]) referenced.add(p.s3.key);

  const orphans = objects.filter((o) => !referenced.has(o.key));
  const bytes = orphans.reduce((n, o) => n + o.size, 0);
  console.log(`\n=== S3 ${bucket}/${PREFIX} — REPORT ONLY, retention never deletes these ===`);
  console.log(`  ${objects.length} objects; ${referenced.size} keys referenced (${policies.length} by HR policies); ${orphans.length} orphans, ${(bytes / 1048576).toFixed(1)} MB`);
  const byExt = new Map<string, number>();
  for (const o of orphans) byExt.set(o.key.split(".").pop() || "?", (byExt.get(o.key.split(".").pop() || "?") ?? 0) + 1);
  console.log(`  orphans by extension: ${[...byExt].map(([e, n]) => `${e} ${n}`).join(", ") || "—"}`);
  for (const o of orphans.sort((a, b) => (a.lastModified?.getTime() ?? 0) - (b.lastModified?.getTime() ?? 0))) {
    console.log(`  ${o.lastModified?.toISOString().slice(0, 10) ?? "—"}  ${(o.size / 1024).toFixed(0).padStart(6)} KB  ${o.key}`);
  }
} catch (err: any) {
  console.log(`\nS3 listing failed (${err?.name}: ${err?.message}) — orphan report skipped.`);
}

await mongoose.disconnect();
