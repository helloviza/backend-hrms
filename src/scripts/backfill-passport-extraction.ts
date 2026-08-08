/**
 * backfill-passport-extraction.ts
 *
 * One-off recovery for the documents the DOC-01-gate bug left unextracted.
 *
 *   DRY RUN (default):  pnpm -C apps/backend tsx src/scripts/backfill-passport-extraction.ts
 *   APPLY (live calls): ... backfill-passport-extraction.ts --apply
 *
 * ── WHY THIS IS A SCRIPT, NOT A MIGRATION ────────────────────────────────
 * It calls a PAID EXTERNAL SERVICE. Each row is 1–2 live Gemini calls
 * (services/visaPassportExtraction.ts retries once on a parse failure), so
 * this must never run automatically as part of a deploy. Migrations are for
 * deterministic, free, self-contained data moves; this is neither.
 *
 * ── WHAT WENT WRONG ──────────────────────────────────────────────────────
 * The passport has two live codes — legacy "DOC-01" and catalogue
 * "PASSPORT_ORIGINAL" (Phase 10a/10b). routes/visa.ts's upload gate compared
 * raw-equal to the legacy one, so every passport uploaded against a
 * documentGroups application (which carries the catalogue code) silently
 * skipped extraction: runVisaPassportExtraction was never invoked at all, and
 * extractionStatus stayed at its "PENDING" creation default. Fixed by
 * isPassportDocCode (config/visaDocumentTypeCatalogue.ts). These rows are the
 * backlog that accumulated while the gate was wrong.
 *
 * ── WHY RE-RUN RATHER THAN ASK FOR A RE-UPLOAD ───────────────────────────
 * Nothing about these documents is damaged — they were simply never visited.
 * runVisaPassportExtraction is idempotent and self-contained: it re-reads the
 * S3 object by doc.s3Key and every write is a full overwrite (extractionStatus
 * / extractionConfidence / extractedFields are ASSIGNED, not merged). This
 * script therefore hand-mutates NOTHING — it only calls that function and
 * reads back the outcome. A re-upload would additionally mint version 2,
 * orphan the v1 rows, and charge the customer an action for our bug.
 *
 * ── SIDE EFFECTS OF --apply (per row) ────────────────────────────────────
 *   - 1–2 live Gemini calls.
 *   - EXTRACTION_STARTED + (EXTRACTION_COMPLETED | EXTRACTION_FAILED)
 *     VisaActivityLog entries, actorType SYSTEM, DATED NOW — not at the
 *     original upload time. These appear in the customer-visible timeline.
 *   - extractionStatus / extractionConfidence / extractedFields overwritten
 *     on the VisaDocument. Nothing else is touched; in particular
 *     TravellerProfile is NEVER written by extraction (only the user-confirmed
 *     PATCH route does that), and reviewStatus is left alone.
 *
 * A row that comes back FAILED is a genuine document problem (unreadable or
 * malformed MRZ), NOT this bug — those need the normal re-photograph path.
 *
 * Safe to re-run: rows that succeed leave PENDING and stop matching the
 * selector, so a second pass picks up only what still needs attention.
 */
import "dotenv/config";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");

// Deliberately a literal, not isPassportDocCode(): this is a ONE-OFF over a
// known, finite population. An auditable, greppable selector that matches
// exactly what was diagnosed beats a future-proof predicate that could widen
// the blast radius of a paid operation if the catalogue changes under it.
// Legacy DOC-01 rows are deliberately NOT included — none are stuck (all 10
// are COMPLETED or FAILED); the gate was only ever wrong for the new code.
const SELECTOR = { docCode: "PASSPORT_ORIGINAL", extractionStatus: "PENDING" } as const;

// Pause between rows. Not rate-limit avoidance (the volume is tiny) — it
// keeps the run readable as it lands, and leaves room to Ctrl-C mid-way
// without a queue of in-flight model calls still resolving behind you.
const DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fmtDate(d: any): string {
  const t = d ? new Date(d) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toISOString().slice(0, 19).replace("T", " ") : "—";
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is missing. Set it in apps/backend/.env.");

  // Dry run reads from a secondary; --apply must talk to the primary, since
  // runVisaPassportExtraction writes through the same connection.
  await mongoose.connect(uri, { readPreference: APPLY ? "primary" : "secondary" });
  const db = mongoose.connection.db!;

  console.log("");
  console.log("  Passport extraction backfill");
  console.log(`  mode      : ${APPLY ? "APPLY — live Gemini calls, writes documents" : "DRY RUN — no calls, no writes"}`);
  console.log(`  selector  : ${JSON.stringify(SELECTOR)}`);
  console.log("");

  // ── Report ────────────────────────────────────────────────────────────
  // Raw driver for the read side: no workspace scope (this is deliberately
  // cross-tenant recovery), and no risk of a model hook reshaping the rows
  // we are about to report on.
  const docsCol = db.collection("visadocuments");

  const matchedAll = await docsCol.find(SELECTOR as any).sort({ createdAt: 1 }).toArray();

  // Soft-deleted documents are excluded. The routes that serve screen 4 all
  // filter deletedAt: null, so a deleted row is invisible to the customer —
  // spending a paid call to populate a panel nobody can see is waste, and it
  // would silently resurrect extracted PII onto a record someone removed.
  // Reported separately rather than filtered silently, so the count you were
  // expecting is reconcilable against what this actually operates on.
  const deleted = matchedAll.filter((d: any) => d.deletedAt);
  const matched = matchedAll.filter((d: any) => !d.deletedAt);

  console.log(`  matched (selector)          : ${matchedAll.length}`);
  console.log(`  excluded — soft-deleted     : ${deleted.length}`);
  console.log(`  WILL RE-RUN                 : ${matched.length}`);
  console.log("");

  if (matchedAll.length === 0) {
    console.log("  Nothing matches. Either the backfill has already run or the selector is stale.");
    await mongoose.disconnect();
    return;
  }

  // Join up to the request for a human-readable reference. Done as two
  // batched lookups rather than per-row queries.
  const appIds = [...new Set(matched.map((d: any) => String(d.applicationId)))];
  const apps = await db
    .collection("visaapplications")
    .find({ _id: { $in: appIds.map((id) => new mongoose.Types.ObjectId(id)) } })
    .project({ requestId: 1, travellerProfileId: 1 })
    .toArray();
  const appById = new Map(apps.map((a: any) => [String(a._id), a]));

  const reqIds = [...new Set(apps.map((a: any) => String(a.requestId)).filter(Boolean))];
  const reqs = await db
    .collection("visarequests")
    .find({ _id: { $in: reqIds.map((id) => new mongoose.Types.ObjectId(id)) } })
    .project({ referenceNumber: 1 })
    .toArray();
  const refByReqId = new Map(reqs.map((r: any) => [String(r._id), r.referenceNumber]));

  function refFor(doc: any): string {
    const app = appById.get(String(doc.applicationId));
    return (app && refByReqId.get(String(app.requestId))) || "(no reference)";
  }

  // A row whose docCode already has a LATER version is not worth a paid call:
  // screen 4 only ever shows the latest version per docCode, so extracting an
  // older one populates a panel the customer will never look at. Flagged, not
  // auto-skipped — the operator decides.
  const supersededIds = new Set<string>();
  for (const d of matched) {
    const newer = await docsCol.findOne({
      applicationId: d.applicationId,
      docCode: d.docCode,
      version: { $gt: d.version },
      deletedAt: null,
    });
    if (newer) supersededIds.add(String(d._id));
  }

  console.log("  ── Matched documents ─────────────────────────────────────────────");
  console.log("");
  for (const d of matched) {
    const flag = supersededIds.has(String(d._id)) ? "  ⚠ SUPERSEDED by a later version" : "";
    console.log(`    ${refFor(d)}`);
    console.log(
      `      docId ${String(d._id)}  v${d.version}  ` +
        `${((d.sizeBytes ?? 0) / 1024).toFixed(1)} KB  uploaded ${fmtDate(d.createdAt)}${flag}`,
    );
  }
  console.log("");

  if (deleted.length) {
    console.log("  ── Excluded (soft-deleted) ───────────────────────────────────────");
    for (const d of deleted) {
      console.log(`    ${refFor(d)}  docId ${String(d._id)}  deleted ${fmtDate(d.deletedAt)}`);
    }
    console.log("");
  }

  // ── Dry run stops here ────────────────────────────────────────────────
  if (!APPLY) {
    console.log("  DRY RUN — nothing was called and nothing was written.");
    console.log("");
    console.log(`  Re-running these ${matched.length} would:`);
    console.log(`    · make ${matched.length}–${matched.length * 2} live Gemini calls (each row retries once on a parse failure)`);
    console.log("    · overwrite extractionStatus / extractionConfidence / extractedFields on each document");
    console.log("    · write EXTRACTION_STARTED + COMPLETED|FAILED activity-log entries per row,");
    console.log("      actorType SYSTEM, DATED NOW — visible in the customer's timeline,");
    console.log("      not backdated to the original upload");
    console.log("");
    console.log("  Re-run with --apply to execute.");
    console.log("");
    await mongoose.disconnect();
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────
  // Imported lazily so a DRY RUN never pulls in the extraction service (and
  // through it the Gemini client, which throws at construction when
  // GEMINI_API_KEY is absent). A dry run must work on any machine.
  const { runVisaPassportExtraction } = await import("../services/visaPassportExtraction.js");

  console.log("  ── Applying ──────────────────────────────────────────────────────");
  console.log("  Each row below writes a SYSTEM activity-log entry dated NOW.");
  console.log("");

  const outcomes: Record<string, number> = {};
  let i = 0;

  for (const d of matched) {
    i += 1;
    const id = String(d._id);
    const label = `[${i}/${matched.length}] ${refFor(d)} ${id}`;

    try {
      // The ONLY mutation this script performs is via this call. Nothing
      // below writes to the document — the read-back is purely to report.
      await runVisaPassportExtraction(id);
    } catch (err: any) {
      // runVisaPassportExtraction swallows its own errors by design (it is
      // normally fire-and-forget); this catch is for the genuinely
      // unexpected, so one bad row can't abandon the rest of the run.
      console.log(`    ${label}  ERROR ${err?.message || err}`);
      outcomes.ERROR = (outcomes.ERROR ?? 0) + 1;
      if (i < matched.length) await sleep(DELAY_MS);
      continue;
    }

    const after: any = await docsCol.findOne({ _id: d._id });
    const status = after?.extractionStatus ?? "(unknown)";
    outcomes[status] = (outcomes[status] ?? 0) + 1;

    if (status === "COMPLETED" || status === "NEEDS_REVIEW") {
      const fieldCount = (after?.extractedFields ?? []).length;
      console.log(`    ${label}  ${status} conf=${after?.extractionConfidence ?? "—"} fields=${fieldCount}`);
    } else if (status === "FAILED") {
      const fields = after?.extractedFields ?? [];
      const category = fields.find((f: any) => f.key === "failureCategory")?.value ?? "—";
      const message = fields.find((f: any) => f.key === "error")?.value ?? "";
      console.log(`    ${label}  FAILED reason=${category}${message ? ` — ${message}` : ""}`);
    } else {
      console.log(`    ${label}  ${status}`);
    }

    if (i < matched.length) await sleep(DELAY_MS);
  }

  console.log("");
  console.log("  ── Summary ───────────────────────────────────────────────────────");
  for (const [status, n] of Object.entries(outcomes).sort()) {
    console.log(`    ${status.padEnd(14)} ${n}`);
  }
  if (outcomes.FAILED) {
    console.log("");
    console.log("    FAILED rows are genuine document problems (unreadable / malformed");
    console.log("    MRZ), not the doc-code bug — they need the normal re-photograph path.");
  }
  console.log("");

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
