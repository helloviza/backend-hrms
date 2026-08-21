// apps/backend/src/scripts/rerun-visa-passport-extraction.ts
//
// Re-runs runVisaPassportExtraction() against currently-FAILED passport
// (DOC-01) documents — the same base query as diag-visa-passport-
// failures.ts — to verify a fix (line-1 padding, the retry-once-on-parse-
// failure, and now the transient-upstream 429/5xx retry, utils/
// geminiRetry.ts) actually resolves previously-diagnosed failures. Real
// writes: this genuinely re-triggers extraction (fresh S3 fetch + Gemini
// call) and updates each document's status for real, not a dry run.
//
// --category=<UNREADABLE_DOCUMENT|MALFORMED_MRZ|SERVICE_ERROR> — optional,
// scopes the re-run to only that failureCategory (see models/VisaDocument.ts
// / services/visaPassportExtraction.ts's VisaExtractionFailureCategory).
// Added specifically for SERVICE_ERROR: that category is transient by
// definition (a busy/unavailable upstream, not a bad document), so it's the
// one most worth re-running in isolation without also re-touching documents
// that genuinely need a sharper photo (UNREADABLE_DOCUMENT) or a different
// fix (MALFORMED_MRZ). Omit the flag to re-run every FAILED document,
// exactly as before this option existed.
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaDocument from "../models/VisaDocument.js";
import { runVisaPassportExtraction, type VisaExtractionFailureCategory } from "../services/visaPassportExtraction.js";

const KNOWN_CATEGORIES: readonly VisaExtractionFailureCategory[] = [
  "UNREADABLE_DOCUMENT",
  "MALFORMED_MRZ",
  "SERVICE_ERROR",
];

function parseCategoryArg(): VisaExtractionFailureCategory | undefined {
  const arg = process.argv.find((a) => a.startsWith("--category="));
  if (!arg) return undefined;
  const value = arg.slice("--category=".length).trim();
  if (!KNOWN_CATEGORIES.includes(value as VisaExtractionFailureCategory)) {
    console.error(`Unknown --category "${value}". Expected one of: ${KNOWN_CATEGORIES.join(", ")}.`);
    process.exit(1);
  }
  return value as VisaExtractionFailureCategory;
}

async function main() {
  const category = parseCategoryArg();

  console.log("Connecting to MongoDB...");
  await mongoose.connect(env.MONGO_URI);

  const filter: Record<string, any> = { docCode: "DOC-01", extractionStatus: "FAILED" };

  /* ── WHY THIS FILTERS IN MEMORY ────────────────────────────────────
   * failureCategory lives inside extractedFields (a flat {key,value}[]),
   * not as its own indexed schema field — see models/VisaDocument.ts. This
   * used to be an `$elemMatch: { key: "failureCategory", value: category }`.
   *
   * That query CANNOT work any more, and would have failed silently rather
   * than loudly: extractedFields[].value is now encrypted with a RANDOMIZED
   * IV, so the same category produces different ciphertext in every row and
   * matches nothing. An $elemMatch on it returns zero documents and reads
   * exactly like "no failures of this category" — the worst possible
   * failure mode for an ops tool.
   *
   * So the category filter moved to after the read, where the plugin has
   * already decrypted. The candidate set is bounded by
   * extractionStatus: "FAILED" (single-digit-to-dozens in practice), so
   * this is a small scan, not a collection sweep. The `key` half of each
   * pair is NOT encrypted, but filtering on key alone is not what this
   * needs — it is the VALUE that names the category.
   * ────────────────────────────────────────────────────────────────── */
  const candidates = await VisaDocument.find(filter)
    .select("_id applicationId extractedFields subjectType subjectId")
    .lean();

  const before = (
    category
      ? candidates.filter((d: any) =>
          (d.extractedFields ?? []).some(
            (f: any) => f?.key === "failureCategory" && f?.value === category,
          ),
        )
      : candidates
  ).map((d: any) => ({ _id: d._id, applicationId: d.applicationId }));

  if (!before.length) {
    console.log(
      category
        ? `No FAILED passport extractions with failureCategory=${category} found — nothing to re-run.`
        : "No FAILED passport extractions found — nothing to re-run.",
    );
    await mongoose.connection.close();
    return;
  }

  console.log(
    `Re-running extraction for ${before.length} FAILED passport document(s)${category ? ` (failureCategory=${category})` : ""}...\n`,
  );

  for (const d of before as any[]) {
    const id = String(d._id);
    console.log(`----------------------------------------`);
    console.log("documentId:", id);
    try {
      await runVisaPassportExtraction(id);
    } catch (err: any) {
      console.error("  runVisaPassportExtraction threw (unexpected — it should never throw):", err?.message);
    }

    const after: any = await VisaDocument.findById(id)
      // subjectType/subjectId: required to decrypt extractedFields — see
      // models/VisaDocument.ts. Without them this read throws.
      .select("extractionStatus extractionConfidence extractedFields subjectType subjectId")
      .lean();

    if (!after) {
      console.log("  result: document no longer exists?!");
      continue;
    }
    const errorEntry = (after.extractedFields || []).find((f: any) => f.key === "error");
    const categoryEntry = (after.extractedFields || []).find((f: any) => f.key === "failureCategory");
    console.log("  new status:    ", after.extractionStatus);
    console.log("  confidence:    ", after.extractionConfidence ?? "(n/a)");
    if (after.extractionStatus === "FAILED") {
      console.log("  failureCategory:", categoryEntry?.value ?? "(none)");
      console.log("  error:          ", errorEntry?.value ?? "(none)");
    }
  }
  console.log(`----------------------------------------\n`);

  // Scoped to the SAME documents targeted above (by _id), not re-applying
  // the original --category filter — a re-run can land on a different
  // failureCategory than it started with (e.g. SERVICE_ERROR -> COMPLETED,
  // or SERVICE_ERROR -> MALFORMED_MRZ if the upstream recovered but the
  // image itself is also flawed), so "still FAILED" should count any of
  // those originally-targeted documents that are still FAILED at all.
  const stillFailed = await VisaDocument.countDocuments({
    _id: { $in: before.map((d: any) => d._id) },
    extractionStatus: "FAILED",
  });
  console.log(`Summary: ${before.length} re-run, ${before.length - stillFailed} now parse cleanly, ${stillFailed} still FAILED.`);

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  await mongoose.connection.close();
  process.exit(1);
});
