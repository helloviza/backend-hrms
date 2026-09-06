// apps/backend/src/services/consumerPassportExtraction.ts
//
// Reads a passport in the CONSUMER apply flow and RETURNS what it read.
//
// ══════════════════════════════════════════════════════════════════════
// THIS FUNCTION NEVER WRITES ANYTHING. NOT ONE FIELD, NOT ONE DOCUMENT.
// ══════════════════════════════════════════════════════════════════════
// It loads bytes, calls the reader, parses, cross-checks, and returns a
// value. There is no model import in this file that could persist — that
// is not an accident of the current implementation, it is the design:
//
//   - The B2B path (services/visaPassportExtraction.ts) stores its result
//     on the VisaDocument because a concierge needs to see it later, on a
//     different day, without re-running Gemini. That storage is why the
//     VisaDocument had to grow encryption-at-rest for `extractedFields`.
//   - The consumer path has no such reader. The one and only consumer of
//     this result is the form the person is looking at RIGHT NOW. Storing
//     it would create a second copy of a passport number, at rest, with
//     its own key management and its own erasure obligation, to serve
//     nobody. So it is returned and forgotten.
//
// The extracted values reach the database exactly once, later, through the
// path they already travel when someone types them by hand: the reader
// looks at the populated fields, corrects them, and the existing
// PATCH /profile/personal + passport routes write them (encrypted at rest
// by ConsumerProfile's own field markers). No new write path exists.
//
// ── WHAT IS REUSED, AND WHAT IS NEW ──────────────────────────────────
// Reused, unmodified:
//   - services/extractPassportGemini.ts — Stage 1. Takes a buffer and a
//     mime type; has no idea what a VisaDocument is. Nothing to adapt.
//   - utils/mrz.ts — Stage 2. Pure TD3 parse, ICAO check digits, filler
//     repair, confidence, date century resolution, log masking. Zero
//     imports of its own.
//   - utils/passportCrossCheck.ts — the MRZ-vs-VIZ compare.
//   - utils/countryCodes.ts's normaliseToIso2 + utils/mrz.ts's
//     resolveMrzDate — THE converters. routes/visa.ts's
//     PASSPORT_FIELD_CONVERTERS is a thin table over these same two
//     functions; this file calls them directly rather than copying that
//     table, so the century window and the ISO3→ISO2 mapping are the one
//     tested implementation and not a second one that can drift.
//
// New here, and only this:
//   - reading the bytes through services/consumerDocumentStorage.ts (the
//     driver abstraction — S3 in production, local disk in dev) instead of
//     utils/s3Upload.ts's getObjectBuffer. This is the ONE genuine
//     incompatibility with the B2B orchestrator: a consumer document row
//     may legitimately live on a developer's disk, and getObjectBuffer
//     would build an S3 key out of a local path and 404.
//   - the mapping from MRZ/VIZ field names to the consumer Applicant
//     shape, with a provenance tier per field.
import { extractPassportMrzViaGemini } from "./extractPassportGemini.js";
import { openConsumerDocument } from "./consumerDocumentStorage.js";
import {
  parseTD3MrzWithRepair,
  maskMrzLine,
  deriveConfidence,
  resolveMrzDate,
  type MrzConfidence,
  type ParsedMrz,
} from "../utils/mrz.js";
import { normaliseToIso2 } from "../utils/countryCodes.js";
import { crossCheckPassportFields } from "../utils/passportCrossCheck.js";
import type { ConsumerDocumentDriver } from "../models/ConsumerDocument.js";
import logger from "../utils/logger.js";

const extractionLogger = logger.child({ module: "consumer-passport-extraction" });

/**
 * The same three buckets as the B2B path, and deliberately the same names
 * — one vocabulary for one engine. See visaPassportExtraction.ts for what
 * each one means and why they are distinguished.
 */
export type ConsumerExtractionFailureCategory =
  | "UNREADABLE_DOCUMENT"
  | "MALFORMED_MRZ"
  | "SERVICE_ERROR";

/**
 * How much a value is actually worth, borrowed verbatim from the B2B
 * review card (pages/visa/documents/ExtractionCard.tsx) because the
 * distinction it draws is real and re-deriving it would be how the
 * consumer flow ends up claiming "verified" for a guess:
 *
 *   VERIFIED     — from the MRZ, and the MRZ carries a check digit for
 *                  THIS field which passed. Arithmetically self-consistent.
 *   MACHINE_READ — from the MRZ, but TD3 has no check digit for this field
 *                  (names, the two country codes, sex). Machine-read, and
 *                  a misread is undetectable — which is exactly why it
 *                  must not wear the verified badge.
 *   PRINTED      — read off the printed page (the VIZ), which has no check
 *                  digits at all. The issue date is the only one of these
 *                  the consumer form has a home for.
 *
 * A check digit that FAILED is not a fourth tier — it is a flag on top of
 * VERIFIED (`checkDigitFailed` below), and it outranks the badge.
 */
export type ConsumerPassportProvenance = "VERIFIED" | "MACHINE_READ" | "PRINTED";

/** One field the reader may accept, correct, or ignore. */
export interface ConsumerPassportField {
  value: string;
  provenance: ConsumerPassportProvenance;
  /**
   * True only when this field HAS its own MRZ check digit and that digit
   * did not match. Absent (not `false`) on every field with no check digit
   * to fail, so "no flag" never gets misread as "check passed".
   */
  checkDigitFailed?: true;
}

/** The consumer Applicant shape, one entry per field the form holds. */
export interface ConsumerPassportApplicantFields {
  firstName: ConsumerPassportField | null;
  middleName: ConsumerPassportField | null;
  lastName: ConsumerPassportField | null;
  dateOfBirth: ConsumerPassportField | null;
  gender: ConsumerPassportField | null;
  nationality: ConsumerPassportField | null;
  passportNumber: ConsumerPassportField | null;
  passportIssuingCountry: ConsumerPassportField | null;
  passportIssueDate: ConsumerPassportField | null;
  passportExpiryDate: ConsumerPassportField | null;
}

export interface ConsumerPassportMismatch {
  field: string;
  mrzValue: string;
  vizValue: string;
}

export type ConsumerPassportExtraction =
  | {
      ok: true;
      /** Check-digit-derived, never influenced by the VIZ. See deriveConfidence. */
      confidence: MrzConfidence;
      fields: ConsumerPassportApplicantFields;
      /**
       * Where the printed page disagrees with the machine-readable zone.
       * Never auto-resolved: the MRZ value is what lands in `fields` (it is
       * the checked one), and the disagreement is handed to the reader to
       * judge rather than hidden.
       */
      mismatches: ConsumerPassportMismatch[];
      /**
       * A field the MRZ carried but this code could not convert — an ISO3
       * country code not in the table, a YYMMDD that is not a real calendar
       * date. Surfaced rather than silently dropped, so a reader is told
       * "we couldn't read your nationality" instead of quietly getting a
       * blank box back.
       */
      unconverted: Array<{ field: string; reason: string }>;
    }
  | { ok: false; category: ConsumerExtractionFailureCategory; message: string };

/**
 * MRZ sex character -> the consumer profile's gender vocabulary
 * (models/ConsumerProfile.ts's GENDERS, which is UPPERCASE and therefore
 * NOT the B2B TravellerProfile's "Male"/"Female" — same mapping, different
 * target vocabulary, so it is written out here rather than imported).
 *
 * "<" ("not stated") is deliberately absent and maps to nothing. A
 * document declining to state a sex is not the same claim as the person
 * choosing OTHER, and inventing that distinction on their behalf would be
 * worse than leaving the select untouched.
 */
const MRZ_SEX_TO_CONSUMER_GENDER: Record<string, string> = {
  M: "MALE",
  F: "FEMALE",
};

/** Which MRZ fields carry their own check digit, i.e. can be VERIFIED. */
function checkFor(mrz: ParsedMrz, field: "documentNumber" | "dateOfBirth" | "dateOfExpiry") {
  return mrz.checks.find((c) => c.field === field) ?? null;
}

/**
 * A VERIFIED field: MRZ value plus its own check digit's verdict. The flag
 * is set only on failure, so a passing check produces a bare
 * { value, provenance } with no third key to misinterpret.
 */
function verified(value: string, passed: boolean): ConsumerPassportField {
  return passed
    ? { value, provenance: "VERIFIED" }
    : { value, provenance: "VERIFIED", checkDigitFailed: true };
}

function machineRead(value: string): ConsumerPassportField {
  return { value, provenance: "MACHINE_READ" };
}

function printed(value: string): ConsumerPassportField {
  return { value, provenance: "PRINTED" };
}

/**
 * MRZ + VIZ -> the ten fields the consumer Applicant form holds.
 *
 * ── ON NAMES ──────────────────────────────────────────────────────────
 * TD3 has exactly two name parts: a surname and everything else. It has no
 * concept of a middle name, and no delimiter that distinguishes "MARIA
 * TERESA" (one given name, two words) from "JOHN PAUL" (two given names).
 * So the WHOLE of givenNames becomes firstName, and middleName is not
 * emitted at all.
 *
 * Not emitted, rather than emitted as "": the form is populated from this
 * result, and an empty middleName would CLEAR a middle name the person had
 * already entered or that came from their profile. Deleting real data on
 * the strength of a format that cannot represent it is a worse failure
 * than leaving a box unfilled, and it would be invisible — the reader
 * would have to notice the absence. A null here means "this reader has
 * nothing to say about middleName", which is the true statement.
 */
function mapToApplicantFields(
  mrz: ParsedMrz,
  viz: { dateOfIssue: string | null } | null,
): { fields: ConsumerPassportApplicantFields; unconverted: Array<{ field: string; reason: string }> } {
  const unconverted: Array<{ field: string; reason: string }> = [];

  // ── The three MRZ fields that carry a check digit ──────────────────
  const docCheck = checkFor(mrz, "documentNumber");
  const dobCheck = checkFor(mrz, "dateOfBirth");
  const expCheck = checkFor(mrz, "dateOfExpiry");

  const passportNumber = mrz.documentNumber.trim()
    ? verified(mrz.documentNumber.trim(), docCheck ? docCheck.passed : true)
    : null;

  // resolveMrzDate — utils/mrz.ts, the one implementation of the century
  // window. "dob" and "expiry" resolve DIFFERENTLY on purpose (a birth
  // date cannot be in the future; an expiry is always this century), which
  // is precisely the logic this file must not reinvent.
  let dateOfBirth: ConsumerPassportField | null = null;
  if (mrz.dateOfBirth) {
    const iso = resolveMrzDate(mrz.dateOfBirth, "dob");
    if (iso) dateOfBirth = verified(iso, dobCheck ? dobCheck.passed : true);
    else unconverted.push({ field: "dateOfBirth", reason: "not a valid date in the machine-readable zone" });
  }

  let passportExpiryDate: ConsumerPassportField | null = null;
  if (mrz.dateOfExpiry) {
    const iso = resolveMrzDate(mrz.dateOfExpiry, "expiry");
    if (iso) passportExpiryDate = verified(iso, expCheck ? expCheck.passed : true);
    else unconverted.push({ field: "passportExpiryDate", reason: "not a valid date in the machine-readable zone" });
  }

  // ── MRZ fields with NO check digit ─────────────────────────────────
  // normaliseToIso2 — utils/countryCodes.ts, the same function
  // routes/visa.ts's converters call. The MRZ carries ISO3 ("IND"); every
  // country field in this product stores ISO2 ("IN").
  let nationality: ConsumerPassportField | null = null;
  if (mrz.nationality) {
    const iso2 = normaliseToIso2(mrz.nationality);
    if (iso2) nationality = machineRead(iso2);
    else unconverted.push({ field: "nationality", reason: "not a country code we recognise" });
  }

  let passportIssuingCountry: ConsumerPassportField | null = null;
  if (mrz.issuingState) {
    const iso2 = normaliseToIso2(mrz.issuingState);
    if (iso2) passportIssuingCountry = machineRead(iso2);
    else unconverted.push({ field: "passportIssuingCountry", reason: "not a country code we recognise" });
  }

  const gender = MRZ_SEX_TO_CONSUMER_GENDER[String(mrz.sex ?? "").trim().toUpperCase()] ?? null;

  // ── VIZ: the printed page. No check digit exists for any of this ───
  // dateOfIssue is the only VIZ field the consumer form has a home for.
  // extractPassportGemini is instructed to return it already as
  // "YYYY-MM-DD"; anything else is rejected rather than coerced, because a
  // date input silently rejecting a malformed value looks identical to the
  // model having found nothing.
  let passportIssueDate: ConsumerPassportField | null = null;
  const rawIssue = viz?.dateOfIssue?.trim();
  if (rawIssue) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawIssue)) passportIssueDate = printed(rawIssue);
    else unconverted.push({ field: "passportIssueDate", reason: "the printed issue date was not readable as a date" });
  }

  return {
    fields: {
      firstName: mrz.givenNames.trim() ? machineRead(mrz.givenNames.trim()) : null,
      // See the header comment on this function. Never "".
      middleName: null,
      lastName: mrz.surname.trim() ? machineRead(mrz.surname.trim()) : null,
      dateOfBirth,
      gender: gender ? machineRead(gender) : null,
      nationality,
      passportNumber,
      passportIssuingCountry,
      passportIssueDate,
      passportExpiryDate,
    },
    unconverted,
  };
}

/**
 * Read a consumer's passport document and return what it says.
 *
 * The caller (routes/consumer.profile.ts) has ALREADY proved the document
 * belongs to the calling consumer by loading it with consumerId in the
 * query. This function takes the loaded row's storage coordinates, not an
 * id it would have to look up — so there is no way to call it that skips
 * the ownership clause.
 *
 * Never throws: every failure comes back as { ok: false } with a category,
 * so the route can answer 200/422 with something the reader can act on
 * rather than a 500 that says "an error occurred" about their passport.
 */
export async function extractConsumerPassport(doc: {
  driver: ConsumerDocumentDriver;
  storageKey: string;
  mimeType: string;
  /** For log correlation only. Never a passport field. */
  documentId: string;
}): Promise<ConsumerPassportExtraction> {
  try {
    // ── The one real adaptation ────────────────────────────────────
    // openConsumerDocument dispatches on the driver RECORDED ON THE ROW,
    // so a document written to a developer's disk is read from that disk
    // even though the same code in production reads S3. getObjectBuffer
    // (the B2B path) cannot do this.
    const stream = await openConsumerDocument(doc);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const buffer = Buffer.concat(chunks);

    let mrz = await extractPassportMrzViaGemini({ buffer, mimeType: doc.mimeType });

    if (!mrz.found || !mrz.line1 || !mrz.line2) {
      // rawText is the MODEL's reply, which on this branch is a "no MRZ
      // here" object — but it is a reply about a passport image, so it is
      // not logged even in preview form. The B2B path logs a 300-char
      // preview; this one deliberately does not, because the consumer
      // route's whole posture is that nothing about this document lands
      // anywhere durable, and a log line is durable.
      extractionLogger.warn("consumer passport extraction: no MRZ found", {
        documentId: doc.documentId,
        model: mrz.model,
      });
      return {
        ok: false,
        category: "UNREADABLE_DOCUMENT",
        message: "No machine-readable zone was found on this document.",
      };
    }

    // "error" in parseResult rather than !parseResult.ok — this repo runs
    // strictNullChecks:false, under which TS will not narrow a
    // boolean-literal discriminated union into its false branch. Same
    // workaround, same reason, as visaPassportExtraction.ts.
    let parseResult = parseTD3MrzWithRepair(mrz.line1, mrz.line2).result;

    if ("error" in parseResult) {
      extractionLogger.warn("consumer passport extraction: MRZ parse failed, retrying once", {
        documentId: doc.documentId,
        model: mrz.model,
        error: parseResult.error.message,
        line1Length: mrz.line1.length,
        line2Length: mrz.line2.length,
        // maskMrzLine — every alphanumeric becomes "X", every "<" stays put.
        // Shows exactly where the filler count went wrong without a
        // passport number, name or date of birth ever reaching a log.
        line1Masked: maskMrzLine(mrz.line1),
        line2Masked: maskMrzLine(mrz.line2),
      });

      // ONE retry, plain — no repairHint. The B2B path measured that a
      // prompt stressing character counts made transcription WORSE; a
      // second plain sample is the fix. See visaPassportExtraction.ts's
      // comment above runVisaPassportExtraction for the measurement.
      const retryMrz = await extractPassportMrzViaGemini({ buffer, mimeType: doc.mimeType });
      const retryResult =
        retryMrz.found && retryMrz.line1 && retryMrz.line2
          ? parseTD3MrzWithRepair(retryMrz.line1, retryMrz.line2).result
          : null;

      if (retryResult && !("error" in retryResult)) {
        mrz = retryMrz;
        parseResult = retryResult;
      } else {
        extractionLogger.warn("consumer passport extraction: MRZ still unparseable after retry", {
          documentId: doc.documentId,
          model: retryMrz.model,
          line1Masked: retryMrz.line1 ? maskMrzLine(retryMrz.line1) : null,
          line2Masked: retryMrz.line2 ? maskMrzLine(retryMrz.line2) : null,
        });
        // An MRZ WAS found and read — twice. That is a different situation
        // from "no MRZ found", and calls for different guidance, so it
        // gets its own category rather than being folded into the one above.
        return {
          ok: false,
          category: "MALFORMED_MRZ",
          message: "The machine-readable zone was found but could not be read cleanly.",
        };
      }
    }

    const { result } = parseResult;
    const confidence = deriveConfidence(result.checks);
    const { fields, unconverted } = mapToApplicantFields(result, mrz.viz);

    // The MRZ-vs-VIZ compare. Own try/catch for the same reason the B2B
    // path has one: a bug in the cross-check (or an unexpected VIZ shape)
    // must never turn a successful MRZ read into a failure. A VIZ miss is
    // the ordinary case whenever the bio-data page was not legible.
    let mismatches: ConsumerPassportMismatch[] = [];
    try {
      if (mrz.vizFound && mrz.viz) {
        mismatches = crossCheckPassportFields(result, mrz.viz);
        if (mismatches.length) {
          // FIELD NAMES ONLY. The values are exactly the PII this route
          // exists to keep out of durable storage; naming which fields
          // disagreed is enough for anyone reading logs to act on.
          extractionLogger.warn("consumer passport extraction: MRZ/VIZ cross-check mismatch", {
            documentId: doc.documentId,
            fields: mismatches.map((m) => m.field),
          });
        }
      }
    } catch (err: any) {
      extractionLogger.warn("consumer passport extraction: VIZ compare failed, MRZ result kept", {
        documentId: doc.documentId,
        error: err?.message,
      });
    }

    return { ok: true, confidence, fields, mismatches, unconverted };
  } catch (err: any) {
    // The reader, not the document, is at fault here: the model call threw
    // after its own retries, the object store was unreachable, something
    // unexpected. Distinct from the two document-shaped failures above so
    // the UI can avoid telling someone their passport is bad when it isn't.
    extractionLogger.error("consumer passport extraction: service error", {
      documentId: doc.documentId,
      error: err?.message,
    });
    return {
      ok: false,
      category: "SERVICE_ERROR",
      message: "We couldn't read this document just now.",
    };
  }
}
