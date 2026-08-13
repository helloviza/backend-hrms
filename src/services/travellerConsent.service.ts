// apps/backend/src/services/travellerConsent.service.ts
//
// THE CONSENT LEDGER — Tab 6, the DPDP Privacy Control (2026-08-11).
//
// Reads REAL VisaRequest.consents[] rows and nothing else. There is no
// fabricated row anywhere in this file and no code path that can produce
// one: every field rendered comes off a stored VisaConsentRecord, and a
// traveller with no visa requests gets an empty array.
//
// ── THE RULE THIS FILE EXISTS TO ENFORCE (design §7.5) ──────────────────
//
// Consent here is REQUEST-SCOPED, and it must stay that way on the way to
// the screen. Every row names the request it was given for, and this module
// deliberately exposes NO aggregate — no `hasConsented`, no `consentHeld`,
// no count-as-status. Aggregating three real rows into "this traveller has
// consented" would convert a consent given for one visa application into a
// standing, blanket permission to hold a dossier, which is not what anybody
// agreed to and is exactly the claim a DPDP ledger would be read as making.
//
// THREE further honesty problems this resolves rather than papering over:
//
//  1. WHO ACCEPTED IS NOT NECESSARILY THE TRAVELLER. routes/visa.ts stamps
//     acceptedByUserId = the SUBMITTING actor. A workspace leader can raise
//     one request covering five colleagues, so the consent on a traveller's
//     own ledger may have been clicked by their manager. Every row therefore
//     names the accepting person, and `acceptedBySubject` says plainly
//     whether that was the traveller themselves. "You consented" is a
//     sentence this payload cannot support and never states.
//
//  2. A REQUEST CAN COVER SEVERAL TRAVELLERS. The consent belongs to the
//     request, not to this person's slice of it, so a row is presented as
//     "the consent recorded on request HV26-000123, which includes you" —
//     never as this traveller's individual act.
//
//  3. OLD VERSIONS' TEXT IS NOT RETAINED. config/visaConsent.ts holds only
//     the CURRENT clause wording (v2). A v1 row exists in production
//     (migrations/2026-08-01-migrate-visa-consent-array.ts back-filled
//     REPRESENTATION @ v1), and showing today's text beside a v1 stamp would
//     assert they accepted wording that did not exist when they clicked.
//     So the label is served ONLY when the stored version matches the
//     current one; otherwise the row keeps its clause name and its real
//     version, and says the exact wording of that version isn't retained.
import mongoose from "mongoose";
import VisaApplication from "../models/VisaApplication.js";
import VisaRequest from "../models/VisaRequest.js";
import User from "../models/User.js";
import {
  VISA_CONSENT_CLAUSES,
  CURRENT_VISA_CONSENT_VERSION,
} from "../config/visaConsent.js";

/** Clause id -> its CURRENT label. Only ever used for a current-version row. */
const CURRENT_CLAUSE_LABELS: Record<string, string> = Object.fromEntries(
  VISA_CONSENT_CLAUSES.map((c) => [c.id, c.label]),
);

/**
 * Human name for a clause id, independent of version. Safe to show on any
 * row because it names WHICH clause was accepted (a fact the record stores)
 * without asserting its wording.
 */
const CLAUSE_NAMES: Record<string, string> = {
  REPRESENTATION: "Authorisation to represent",
  DATA_PROCESSING: "Personal data processing",
  TERMS: "Terms of service",
};

export interface ConsentLedgerRow {
  clauseId: string;
  /** Which clause — never the wording, which is version-dependent. */
  clauseName: string;
  /**
   * The exact text accepted, or NULL when the stored version is not the
   * current one. Null is the honest answer: we did not keep that version's
   * wording, and today's text is not what they agreed to.
   */
  clauseText: string | null;
  version: string;
  /** True when `version` is the version whose text we still hold. */
  isCurrentVersion: boolean;
  acceptedAt: Date;
  /** Who clicked it — may not be the traveller. Null if unresolvable. */
  acceptedByName: string | null;
  acceptedByUserId: string | null;
  /**
   * Whether the accepting user is the traveller themselves. Decided here so
   * neither surface has to infer it, and so a row accepted by somebody else
   * can never be captioned as the traveller's own act.
   */
  acceptedBySubject: boolean;
}

export interface ConsentLedgerRequest {
  requestId: string;
  /** "HV26-000123" — what the row is scoped to, and what the UI must name. */
  referenceNumber: string | null;
  destinationIso2: string | null;
  purpose: string | null;
  submittedAt: Date | null;
  /** How many travellers this one request covers — see honesty note 2. */
  applicantCount: number;
  consents: ConsentLedgerRow[];
}

export interface ConsentLedger {
  /** Real rows, grouped by the request they belong to. Never synthesised. */
  requests: ConsentLedgerRequest[];
  /** Total rows across every request — a COUNT of records, not a status. */
  recordCount: number;
  /**
   * Deliberately absent from this shape, and listed here so the omission
   * reads as a decision rather than an oversight: there is no
   * `hasConsented`, `consentValid`, `dpdpCompliant` or equivalent. See the
   * file header — a profile-level consent claim is not derivable from
   * request-scoped rows, so this module does not offer one to derive it
   * from.
   */
  profileConsent: {
    /** Always false today — no profile-level consent flow exists. */
    captured: boolean;
    /** Why, in words the surface shows verbatim. */
    message: string;
  };
}

/**
 * Every consent record attached to a request this traveller is an applicant
 * on, newest request first.
 *
 * The linkage is traveller -> VisaApplication -> requestId -> VisaRequest,
 * the same path the passport vault's extraction lookup already walks, and
 * BOTH queries carry workspaceId so a stale cross-tenant id can never pull
 * another workspace's consent record.
 */
export async function resolveConsentLedger(
  travellerProfileId: any,
  workspaceId: any,
  opts: {
    /**
     * The User this profile is claimed by, if any — passed in because every
     * caller already holds the traveller document, and because it makes
     * "was this accepted by the subject themselves" a decision the caller
     * can see rather than a hidden second query.
     */
    subjectUserId?: string | null;
    /** Shown verbatim; see config/platformCapabilities.ts. */
    profileConsentMessage: string;
  },
): Promise<ConsentLedger> {
  const applications: any[] = await VisaApplication.find({
    travellerProfileId,
    workspaceId,
  })
    .select("requestId")
    .lean();

  const requestIds = [...new Set(applications.map((a) => String(a.requestId)))]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const emptyProfileConsent = {
    captured: false,
    message: opts.profileConsentMessage,
  };

  if (!requestIds.length) {
    return { requests: [], recordCount: 0, profileConsent: emptyProfileConsent };
  }

  const requests: any[] = await VisaRequest.find({
    _id: { $in: requestIds },
    workspaceId,
  })
    .select("referenceNumber destinationIso2 purpose consents submittedAt createdAt applicationIds")
    .sort({ createdAt: -1 })
    .lean();

  // One lookup for every accepting user across every row, rather than per
  // row. A name we cannot resolve stays null and renders as "a user who is
  // no longer on this workspace" — never silently attributed to the
  // traveller.
  const accepterIds = [
    ...new Set(
      requests
        .flatMap((r) => r.consents || [])
        .map((c: any) => (c.acceptedByUserId ? String(c.acceptedByUserId) : null))
        .filter(Boolean) as string[],
    ),
  ];
  const nameById = new Map<string, string>();
  if (accepterIds.length) {
    // NOT `fullName` — that is a Mongoose VIRTUAL, and .lean() does not
    // compute virtuals, so selecting it silently yields undefined and every
    // row would fall through to showing a raw email address where a person's
    // name belongs. Same leaf fields and same precedence as this router's
    // own describeLastEditor, so the two surfaces name people identically.
    const users: any[] = await User.find({ _id: { $in: accepterIds } })
      .select("_id firstName lastName name email")
      .lean();
    for (const u of users) {
      const name =
        u.name ||
        [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
        u.email ||
        "";
      if (name) nameById.set(String(u._id), name);
    }
  }

  // Who this traveller IS, as a login — so a row accepted by them can be
  // distinguished from one accepted on their behalf. Taken from the
  // profile's own claim link (never a name or email match, which is the
  // standard the rest of this model holds to); absent means every row reads
  // as accepted by somebody else, which is the safe direction to be wrong in.
  const subjectUserId = opts.subjectUserId ? String(opts.subjectUserId) : null;

  const mapped: ConsentLedgerRequest[] = requests.map((r) => ({
    requestId: String(r._id),
    referenceNumber: r.referenceNumber ?? null,
    destinationIso2: r.destinationIso2 ?? null,
    purpose: r.purpose ?? null,
    submittedAt: r.submittedAt ?? null,
    applicantCount: Array.isArray(r.applicationIds) ? r.applicationIds.length : 0,
    consents: (r.consents || []).map((c: any): ConsentLedgerRow => {
      const isCurrentVersion = String(c.version) === CURRENT_VISA_CONSENT_VERSION;
      const accepterId = c.acceptedByUserId ? String(c.acceptedByUserId) : null;
      return {
        clauseId: c.clauseId,
        clauseName: CLAUSE_NAMES[c.clauseId] || c.clauseId,
        // The one place version matters most: today's wording is served
        // ONLY against a row stamped with today's version.
        clauseText: isCurrentVersion ? CURRENT_CLAUSE_LABELS[c.clauseId] ?? null : null,
        version: c.version,
        isCurrentVersion,
        acceptedAt: c.acceptedAt,
        acceptedByName: accepterId ? nameById.get(accepterId) || null : null,
        acceptedByUserId: accepterId,
        acceptedBySubject: !!accepterId && !!subjectUserId && accepterId === subjectUserId,
      };
    }),
  }));

  // A request with no consent rows is dropped rather than rendered empty: a
  // draft that was never submitted has no consent to report, and an empty
  // group under a reference number reads as "consent missing" when the
  // truth is "never asked for yet".
  const withConsents = mapped.filter((r) => r.consents.length > 0);

  return {
    requests: withConsents,
    recordCount: withConsents.reduce((n, r) => n + r.consents.length, 0),
    profileConsent: emptyProfileConsent,
  };
}
