// apps/backend/src/services/visaPassportExtraction.ts
//
// Phase 4b orchestration: Stage 1 (services/extractPassportGemini.ts, the
// raw MRZ lines) -> Stage 2 (utils/mrz.ts, deterministic parse + check-digit
// validation) -> persist onto the VisaDocument.
//
// Runs asynchronously, fire-and-forget, from routes/visa.ts's upload route
// — the HTTP response for the upload must never wait on this. A failure
// here NEVER blocks the application; it is recorded on the document and
// swallowed. Extraction alone NEVER writes to TravellerProfile — that only
// happens via the user-confirmed PATCH route in routes/visa.ts.
//
// Screen 4 review (diagnosed 2026-07-29): every FAILED document already had
// SOME error text stored via markFailed, but two real gaps existed —
//   1. Every failure landed as FAILED with no way to tell "the document/MRZ
//      itself couldn't be read" (UNREADABLE_DOCUMENT — no MRZ found at all)
//      apart from "Gemini/the extraction pipeline itself errored"
//      (SERVICE_ERROR — the outer catch, e.g. the model call threw). The
//      frontend showed the same "Couldn't be read automatically" copy
//      either way, which is misleading for a service error (implies the
//      customer's file was bad) and unhelpful for an unreadable document
//      (doesn't say what to check). markFailed now also stores a
//      `failureCategory` field so the UI (ExtractionCard.tsx) can split the
//      copy without parsing free-text messages.
//   2. The two markFailed call sites INSIDE the try block never logged
//      anything — only the outer catch did. An ops engineer grepping logs
//      for extraction failures would miss the most common failure modes
//      entirely. All paths now log via extractionLogger before calling
//      markFailed.
//
// Follow-up (same date, after querying the 3 real FAILED documents):  all
// three had Gemini find AND transcribe the MRZ, then drop 2 trailing "<"
// filler characters off line 1 — a lossy transcription the deterministic
// parser correctly rejected (see utils/mrz.ts's LINE1_PAD_TOLERANCE, which
// now recovers this). When padding still isn't enough to parse cleanly,
// this now retries the Gemini call ONCE with a prompt stressing exact
// character counts before giving up — and gives that outcome its OWN
// category (MALFORMED_MRZ), distinct from UNREADABLE_DOCUMENT: an MRZ was
// genuinely found and read, just not cleanly enough to parse, which is a
// different situation from "no MRZ was found at all" and calls for
// different user guidance (re-photographing helps but isn't the fix here —
// see ExtractionCard.tsx).
//
// VIZ (Visual Inspection Zone) follow-up (same date): the MRZ never carries
// date of issue / place of birth / place of issue, and the panel used to
// make the user hunt for and type an issue date that's plainly printed on
// the very image already sent to Gemini. extractPassportGemini.ts now reads
// the printed bio-data fields in the SAME call as the MRZ. These fields have
// no check digit — VIZ confidence is always "unverified", full stop, never
// blurred with the MRZ's check-digit-derived confidence. Where a field
// exists in both zones, the MRZ value is what gets stored (it's the
// verified one); the VIZ read is only used to cross-check against it
// (utils/passportCrossCheck.ts) — any disagreement is recorded on the
// document (mismatch_<field>_mrz / mismatch_<field>_viz) for the user to
// see, never auto-rejected. Fields with no TravellerProfile home
// (placeOfBirth, placeOfIssue) are stored under a `viz_` key for concierge
// visibility only — routes/visa.ts's PASSPORT_FIELD_CONVERTERS never reads
// a `viz_`-prefixed key, so nothing here is ever written back without
// explicit user confirmation through the normal flow.
import VisaDocument from "../models/VisaDocument.js";
import VisaApplication from "../models/VisaApplication.js";
import TravellerProfile from "../models/TravellerProfile.js";
import { extractPassportMrzViaGemini } from "./extractPassportGemini.js";
import { getObjectBuffer } from "../utils/s3Upload.js";
import { parseTD3MrzWithRepair, maskMrzLine, deriveConfidence, type MrzCheckField } from "../utils/mrz.js";
import { crossCheckPassportFields, crossCheckPassportIdentity } from "../utils/passportCrossCheck.js";
import logger from "../utils/logger.js";
import { logVisaActivity } from "../models/VisaActivityLog.js";

const extractionLogger = logger.child({ module: "visa-extraction" });

// The only docCode extraction ever runs for — see config/visaDocumentCodes.ts.
// Every other document type stays PENDING with no extraction, per the PRD:
// we validate those rather than pretending to read them.
export const PASSPORT_DOC_CODE = "DOC-01";

// The three UI-facing failure buckets (routes/visa.ts's mapDocumentSummary
// carries this straight through; ExtractionCard.tsx renders different copy
// per value):
//   - UNREADABLE_DOCUMENT — no MRZ found at all. The document/image itself,
//     not the reader — "check the machine-readable zone is in frame".
//   - MALFORMED_MRZ — an MRZ WAS found and read, but still failed the
//     deterministic parse after the retry below. Different guidance from
//     UNREADABLE_DOCUMENT: the zone was in frame and readable enough to
//     find, so telling someone to re-photograph is the wrong ask.
//   - SERVICE_ERROR — the outer catch (the model call itself throwing, or
//     any other unexpected exception). The one case where the reader, not
//     the document, is actually at fault.
export type VisaExtractionFailureCategory = "UNREADABLE_DOCUMENT" | "MALFORMED_MRZ" | "SERVICE_ERROR";

// The one-and-only retry after a parse failure now sends a PLAIN
// re-request — no repairHint. A previous version of this retry passed a
// prompt stressing "preserve every trailing < / exactly 44 characters per
// line", diagnosed here on 2026-07-30 as demonstrably making things WORSE:
// re-running extraction on the SAME image that had previously succeeded
// produced line1=43/line2=45 on the first attempt, then line1=48/line2=48
// on the hinted retry — MORE filler padding, not less. Gemini's
// transcription of "<" runs is non-deterministic call-to-call regardless of
// prompt; a plain second sample has a real chance of landing cleanly, and
// carries no risk of biasing the model into the same failure mode again.
// See utils/mrz.ts's parseTD3MrzWithRepair for the other half of this fix
// (candidate repairs verified by check digits, replacing the old blind
// line-1 pad).

async function markFailed(
  documentId: string,
  category: VisaExtractionFailureCategory,
  message: string,
  ctx: { applicationId: any; requestId: any; workspaceId: any },
) {
  try {
    await VisaDocument.findByIdAndUpdate(documentId, {
      $set: {
        extractionStatus: "FAILED",
        extractedFields: [
          { key: "failureCategory", value: category },
          { key: "error", value: message.slice(0, 500) },
        ],
      },
    });
  } catch (err: any) {
    // Never let a failure-to-record-a-failure escape this fire-and-forget
    // path — the caller already isn't awaiting this function.
    extractionLogger.error("failed to persist FAILED extraction status", {
      documentId,
      error: err?.message,
    });
  }

  // detail is deliberately just the failure category, never the raw
  // message — see VisaActivityLog.ts's no-PII rule for `detail`.
  if (ctx.requestId && ctx.workspaceId) {
    await logVisaActivity({
      applicationId: ctx.applicationId,
      requestId: ctx.requestId,
      workspaceId: ctx.workspaceId,
      eventType: "EXTRACTION_FAILED",
      actorUserId: null,
      actorType: "SYSTEM",
      detail: { documentId, failureCategory: category },
    });
  }
}

export async function runVisaPassportExtraction(documentId: string): Promise<void> {
  let doc;
  try {
    doc = await VisaDocument.findById(documentId);
  } catch (err: any) {
    extractionLogger.error("failed to load document for extraction", { documentId, error: err?.message });
    return;
  }
  if (!doc) return;

  // Defense in depth — the caller (routes/visa.ts) already gates on
  // docCode before invoking this, but this function must be safe to call
  // on its own too.
  if (doc.docCode !== PASSPORT_DOC_CODE) return;

  // Fetched once, up front — feeds the activity-log calls below (STARTED/
  // COMPLETED/FAILED all need requestId) and is reused later for the
  // identity cross-check, rather than fetched a second time there.
  const application = await VisaApplication.findById(doc.applicationId)
    .select("requestId workspaceId travellerProfileId")
    .lean();
  const activityCtx = {
    applicationId: doc.applicationId,
    requestId: (application as any)?.requestId,
    workspaceId: (application as any)?.workspaceId,
  };

  doc.extractionStatus = "PROCESSING";
  await doc.save();

  await logVisaActivity({
    applicationId: activityCtx.applicationId,
    requestId: activityCtx.requestId,
    workspaceId: activityCtx.workspaceId,
    eventType: "EXTRACTION_STARTED",
    actorUserId: null,
    actorType: "SYSTEM",
    detail: { documentId: String(doc._id) },
  });

  try {
    const buffer = await getObjectBuffer(doc.s3Key);
    let mrz = await extractPassportMrzViaGemini({ buffer, mimeType: doc.mimeType });

    if (!mrz.found || !mrz.line1 || !mrz.line2) {
      extractionLogger.warn("visa passport extraction: no MRZ found", {
        documentId: String(doc._id),
        model: mrz.model,
        rawTextPreview: mrz.rawText?.slice(0, 300),
      });
      await markFailed(String(doc._id), "UNREADABLE_DOCUMENT", "No MRZ found on this document.", activityCtx);
      return;
    }

    // parseResult is narrowed via "error" in parseResult rather than
    // !parseResult.ok — this repo's tsconfig runs with strictNullChecks:
    // false, under which TS fails to narrow a boolean-literal ("ok: true" |
    // "ok: false") discriminated union into its false branch (confirmed via
    // isolated repro); "in" narrowing is unaffected and works both ways.
    // Kept as its OWN direct `let` binding (not read through `repair.result`
    // inline) specifically so that narrowing works — TS's control-flow
    // analysis tracks a reassigned local reliably, but not a nested
    // property read off a reassigned object.
    //
    // parseTD3MrzWithRepair (utils/mrz.ts) tries the raw lines as-received
    // first, then a small set of candidate filler repairs, accepting the
    // first whose check digits ALL pass — so parseResult only comes back
    // structurally invalid (the "error" branch below) when NOTHING,
    // repaired or not, produced a fully-verified MRZ. A candidate that
    // parses but fails a check digit never reaches here as a success; it's
    // the same "fail as now" outcome as an unparseable one.
    let repair = parseTD3MrzWithRepair(mrz.line1, mrz.line2);
    let parseResult = repair.result;

    if ("error" in parseResult) {
      extractionLogger.warn("visa passport extraction: MRZ parse failed, retrying once", {
        documentId: String(doc._id),
        model: mrz.model,
        error: parseResult.error.message,
        line1Length: mrz.line1.length,
        line2Length: mrz.line2.length,
        // Structure, not data — every alphanumeric replaced with "X", every
        // "<" kept in place, so this shows exactly where the filler count
        // went wrong without a passport number ever reaching the logs.
        line1Masked: maskMrzLine(mrz.line1),
        line2Masked: maskMrzLine(mrz.line2),
      });

      // ONE retry, only for a parse failure — never for "no MRZ found" (Stage
      // 1 already found nothing, a stricter prompt won't invent an MRZ) and
      // never for a service error (the outer catch below, which is a
      // completely separate exception path this branch never reaches). A
      // PLAIN re-request, no repairHint — see the comment above this
      // function for why.
      const retryMrz = await extractPassportMrzViaGemini({ buffer, mimeType: doc.mimeType });
      const retryRepair =
        retryMrz.found && retryMrz.line1 && retryMrz.line2
          ? parseTD3MrzWithRepair(retryMrz.line1, retryMrz.line2)
          : null;
      const retryParseResult = retryRepair ? retryRepair.result : null;

      if (retryParseResult && !("error" in retryParseResult)) {
        extractionLogger.warn("visa passport extraction: retry parsed successfully", {
          documentId: String(doc._id),
          model: retryMrz.model,
          repairedVia: retryRepair!.repairedVia,
        });
        mrz = retryMrz;
        repair = retryRepair!;
        parseResult = retryParseResult;
      } else {
        const retryOutcome =
          retryParseResult && "error" in retryParseResult
            ? `retry also failed to parse: ${retryParseResult.error.message}`
            : "retry found no MRZ";
        extractionLogger.warn("visa passport extraction: MRZ parse still failing after retry", {
          documentId: String(doc._id),
          model: retryMrz.model,
          retryOutcome,
          line1Masked: retryMrz.line1 ? maskMrzLine(retryMrz.line1) : null,
          line2Masked: retryMrz.line2 ? maskMrzLine(retryMrz.line2) : null,
        });
        // An MRZ WAS genuinely found and read (both attempts) — this is not
        // "no MRZ found", so it gets its own category with different user
        // guidance. See VisaExtractionFailureCategory above.
        await markFailed(
          String(doc._id),
          "MALFORMED_MRZ",
          `MRZ could not be parsed after retry: ${parseResult.error.message}`,
          activityCtx,
        );
        return;
      }
    }

    const { result } = parseResult;

    // Diagnostics only — never affects extractionStatus/confidence, which
    // stay entirely check-digit-derived regardless of whether a repair was
    // needed. Lets a later log query answer "how often is repair actually
    // firing" without waiting for the next diagnosis session.
    if (repair.repairedVia && repair.repairedVia !== "as_received") {
      extractionLogger.info("visa passport extraction: MRZ recovered via filler repair, check digits verified", {
        documentId: String(doc._id),
        repairedVia: repair.repairedVia,
        adjustment: repair.adjustment,
      });
    }

    const confidence = deriveConfidence(result.checks);
    const allChecksPassed = result.checks.every((c) => c.passed);

    const fieldEntries: Array<{ key: string; value: string }> = [
      { key: "documentType", value: result.documentType },
      { key: "issuingState", value: result.issuingState },
      { key: "surname", value: result.surname },
      { key: "givenNames", value: result.givenNames },
      { key: "documentNumber", value: result.documentNumber },
      { key: "nationality", value: result.nationality },
      { key: "dateOfBirth", value: result.dateOfBirth },
      { key: "sex", value: result.sex },
      { key: "dateOfExpiry", value: result.dateOfExpiry },
    ];

    // Per-check pass/fail, stored alongside the fields — this is what lets
    // review show what is actually suspect rather than flagging the whole
    // document (see build report §2).
    const checkKeyByField: Record<MrzCheckField, string> = {
      documentNumber: "check_documentNumber",
      dateOfBirth: "check_dateOfBirth",
      dateOfExpiry: "check_dateOfExpiry",
      optionalData: "check_optionalData",
      composite: "check_composite",
    };
    for (const check of result.checks) {
      fieldEntries.push({ key: checkKeyByField[check.field], value: check.passed ? "passed" : "failed" });
    }

    // VIZ (visual inspection zone) — printed bio-data-page fields with no
    // check digit, always unverified regardless of model confidence. `viz_`
    // is the provenance marker: routes/visa.ts's PASSPORT_FIELD_CONVERTERS
    // never reads a `viz_`-prefixed key, so nothing here is ever written
    // back without the user seeing and confirming it first (dateOfIssue
    // does have a TravellerProfile home — passportIssueDate — but only via
    // the existing confirm flow, using the PLAIN "dateOfIssue"->
    // "passportIssueDate" conversion once the user submits it; placeOfBirth/
    // placeOfIssue have no TravellerProfile field at all and are stored here
    // for concierge visibility only).
    //
    // Wrapped in its own try/catch — a bug here (unexpected VIZ shape, a
    // cross-check throwing) must never turn an otherwise-successful MRZ
    // extraction into a failure. A VIZ miss (mrz.vizFound === false) is the
    // normal, expected case whenever the bio-data area wasn't legible/in
    // frame, and just means no viz_*/mismatch_* entries get added below —
    // the MRZ-derived fields above are entirely unaffected either way.
    try {
      if (mrz.vizFound && mrz.viz) {
        const viz = mrz.viz;
        if (viz.dateOfIssue) fieldEntries.push({ key: "viz_dateOfIssue", value: viz.dateOfIssue });
        if (viz.placeOfBirth) fieldEntries.push({ key: "viz_placeOfBirth", value: viz.placeOfBirth });
        if (viz.placeOfIssue) fieldEntries.push({ key: "viz_placeOfIssue", value: viz.placeOfIssue });

        const mismatches = crossCheckPassportFields(result, viz);
        for (const m of mismatches) {
          fieldEntries.push({ key: `mismatch_${m.field}_mrz`, value: m.mrzValue });
          fieldEntries.push({ key: `mismatch_${m.field}_viz`, value: m.vizValue });
        }
        if (mismatches.length) {
          extractionLogger.warn("visa passport extraction: MRZ/VIZ cross-check mismatch", {
            documentId: String(doc._id),
            fields: mismatches.map((m) => m.field),
          });
        }
      }
    } catch (err: any) {
      extractionLogger.warn("visa passport extraction: VIZ processing failed, MRZ result kept as-is", {
        documentId: String(doc._id),
        error: err?.message,
      });
    }

    // Identity cross-check — does this passport belong to the traveller it
    // was uploaded against? A different question from the MRZ-vs-VIZ
    // compare above (self-consistency of the document) — this compares the
    // check-digit-verified MRZ result against the TravellerProfile on the
    // application. Own try/catch, same reasoning as the VIZ block: a bug
    // here (traveller lookup failing, unexpected profile shape) must never
    // turn an otherwise-successful MRZ extraction into a failure, and never
    // blocks confirmation either way (utils/passportCrossCheck.ts's own
    // header) — this only ever adds informational fields.
    try {
      if (application) {
        const traveller = await TravellerProfile.findOne({
          _id: (application as any).travellerProfileId,
          workspaceId: (application as any).workspaceId,
        })
          .select("firstName middleName lastName dob passportNo")
          .lean();
        if (traveller) {
          const identityMismatches = crossCheckPassportIdentity(result, traveller as any);
          for (const m of identityMismatches) {
            // `identity_mismatch_` — distinct prefix from the MRZ-vs-VIZ
            // `mismatch_` keys above, so the two are never confused by a
            // consumer scanning extractedFields. Source suffixes mirror
            // that pattern (_passport/_profile, parallel to _mrz/_viz).
            fieldEntries.push({ key: `identity_mismatch_${m.field}_passport`, value: m.passportValue });
            fieldEntries.push({ key: `identity_mismatch_${m.field}_profile`, value: m.profileValue });
            fieldEntries.push({ key: `identity_mismatch_${m.field}_severity`, value: m.severity });
          }
          if (identityMismatches.length) {
            extractionLogger.warn("visa passport extraction: identity cross-check mismatch", {
              documentId: String(doc._id),
              applicationId: String(doc.applicationId),
              fields: identityMismatches.map((m) => `${m.field}:${m.severity}`),
            });
          }
        }
      }
    } catch (err: any) {
      extractionLogger.warn("visa passport extraction: identity cross-check failed, MRZ result kept as-is", {
        documentId: String(doc._id),
        error: err?.message,
      });
    }

    doc.extractionStatus = allChecksPassed ? "COMPLETED" : "NEEDS_REVIEW";
    doc.extractionConfidence = confidence;
    doc.extractedFields = fieldEntries;
    await doc.save();

    await logVisaActivity({
      applicationId: activityCtx.applicationId,
      requestId: activityCtx.requestId,
      workspaceId: activityCtx.workspaceId,
      eventType: "EXTRACTION_COMPLETED",
      actorUserId: null,
      actorType: "SYSTEM",
      detail: { documentId: String(doc._id), extractionStatus: doc.extractionStatus, confidence },
    });
  } catch (err: any) {
    extractionLogger.error("visa passport extraction failed", {
      documentId: String(doc._id),
      error: err?.message,
    });
    await markFailed(String(doc._id), "SERVICE_ERROR", err?.message || "Passport extraction failed.", activityCtx);
  }
}
