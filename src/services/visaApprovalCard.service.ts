// apps/backend/src/services/visaApprovalCard.service.ts
//
// THE EVIDENCE AN APPROVER DECIDES ON — the enrichment behind
// GET /api/visa/requests?queue=approvals (routes/visa.ts).
//
// Until this file existed, the approvals queue showed a destination, a
// requestor's name and a submitted-date. An approver could see WHO asked and
// WHERE they were going, and nothing else: not whether the person travelling
// is on the workspace roster at all, not whether the request can actually
// proceed, not even when the trip is. Approval was an act of faith. Every
// field below is a signal that already existed in the data and simply had no
// path to the one screen where somebody has to judge it.
//
// ── PASSPORT NUMBERS NEVER TRAVEL ON THIS PAYLOAD ───────────────────────
// The approvals queue is routed to whoever the approval chain resolved to —
// a line manager, not necessarily a workspace leader, and NOT the traveller.
// Before this change the queue shipped TravellerProfile.passportNo in full to
// that approver (routes/visa.ts's hydrateApplicationsWithTravellers projects
// it for the requestor's own tracking view, and the approvals variant reused
// that shape verbatim). An approver never needs the number to approve: what
// they need is "is a passport on file, and is it valid for these dates".
// So this module emits `passportMasked` (utils/piiMask.ts's maskTailId, the
// same mask the traveller roster and the CSV export already use) plus a
// computed validity state, and the route REPLACES the hydrated traveller
// object wholesale with this shape — it never deletes a key off it, because
// a shape that is rebuilt cannot leak a field somebody adds upstream later.
//
// The requestor's own view of their own passport is untouched: this module is
// only ever called for the approvals queue variant.
//
// ── EVERY SIGNAL IS COMPUTED, NONE IS ASSERTED ──────────────────────────
// There is no "verified" state here, because nothing in this data verifies
// anything. Each signal carries an honest UNKNOWN branch for the case where
// the underlying fact is genuinely absent:
//
//   rosterStatus     UNKNOWN when there is no TravellerProfile to look at.
//   filedFor         UNKNOWN when no traveller on the request resolves to a
//                    login at all, so "is this the requestor themselves?"
//                    cannot be answered either way. NEVER guessed from an
//                    email match — models/TravellerProfile.ts forbids
//                    inferring identity from a string comparison, and a
//                    display signal that used one would be asserting an
//                    identity link the rest of the module refuses to make.
//   passportValidity UNKNOWN when no expiry date is on file.
//
// See infra/design/visa-approval-flow-2026-08-10.md for the gate this queue
// belongs to.

import { maskTailId } from "../utils/piiMask.js";
import { computeOutstandingRequirements } from "../utils/visaChecklistHydration.js";
import { getVisaDocumentCodeDef } from "../config/visaDocumentCodes.js";
import { VISA_CONSENT_CLAUSE_IDS } from "../config/visaConsent.js";

/* ── Signal vocabularies ──────────────────────────────────────────────── */

/**
 * Is the person travelling one of this workspace's people?
 *
 * MEMBER is a RESOLVED link, not a non-null pointer: either the profile has
 * been claimed by a user who still exists (CLAIMED_LOGIN — they have a login
 * here and proved the profile is theirs), or it carries a CustomerMember link
 * written by the admin-side link flow (ROSTER_LINK).
 *
 * OFF_ROSTER means the profile exists and carries NEITHER link. That is the
 * infosec signal this queue exists to surface: a visa being filed, on the
 * company's account, for somebody who has never been tied to the company's
 * roster. It is not an accusation — a spouse on a family trip is a perfectly
 * ordinary OFF_ROSTER traveller — but it must not blend in as just another
 * name in a list.
 */
export type VisaRosterStatus = "MEMBER" | "OFF_ROSTER" | "UNKNOWN";
export type VisaRosterBasis =
  | "CLAIMED_LOGIN"
  | "ROSTER_LINK"
  | "CLAIM_UNRESOLVED"
  | "NO_LINK"
  | "NO_PROFILE";

/**
 * Passport validity, judged against the trip — not against a fabricated
 * "six months' validity" rule. Six-month remaining-validity requirements are
 * destination-specific and are not carried on VisaRule, so asserting one here
 * would be inventing a requirement. What IS checkable is checked:
 *
 *   EXPIRED                 expiry is already in the past.
 *   EXPIRES_BEFORE_TRAVEL   expiry falls before the trip's last day.
 *   VALID                   expiry is on or after the trip's last day (or,
 *                           with no travel dates on the request, after today).
 *   UNKNOWN                 no expiry date on file — the honest answer, and
 *                           itself a completeness gap.
 */
export type VisaPassportValidity = "VALID" | "EXPIRES_BEFORE_TRAVEL" | "EXPIRED" | "UNKNOWN";

/**
 * Did the requestor file this for themselves, or for somebody else?
 *
 * Resolved through TravellerProfile.claimedBy ONLY — the same key
 * routes/visa.ts's OWN visibility scope uses, so "this is my own request" on
 * the tracking screen and "this is a self-application" here can never
 * disagree.
 *
 *   SELF              every traveller on the request is the requestor.
 *   SELF_AND_OTHERS   the requestor is travelling, and so are other people.
 *   ON_BEHALF         no traveller is the requestor, and at least one is
 *                     PROVABLY somebody else (claimed by a different user).
 *   UNKNOWN           no traveller resolves to any login, so there is nothing
 *                     to compare the requestor against. Stated, not guessed.
 */
export type VisaFiledFor = "SELF" | "SELF_AND_OTHERS" | "ON_BEHALF" | "UNKNOWN";

/**
 * One reason a request is not ready to file.
 *
 * BLOCKING vs ADVISORY is not a style choice — it mirrors what the routes
 * actually enforce. Identity facts (a passport, a date of birth, a resolvable
 * nationality) are what a lodgement cannot proceed without. Outstanding
 * CHECKLIST documents are ADVISORY because POST /requests/:id/submit
 * deliberately does not check the checklist ("concierge chases whatever's
 * missing after submission" — see that route) and this card must not claim a
 * block the product does not impose.
 */
export type VisaApprovalGapSeverity = "BLOCKING" | "ADVISORY";

export interface VisaApprovalGap {
  code:
    | "TRAVELLER_PROFILE_MISSING"
    | "PASSPORT_NUMBER_MISSING"
    | "PASSPORT_EXPIRY_MISSING"
    | "PASSPORT_EXPIRED"
    | "PASSPORT_EXPIRES_BEFORE_TRAVEL"
    | "DOB_MISSING"
    | "NATIONALITY_UNRESOLVED"
    | "CONSENT_MISSING"
    | "DOCUMENTS_OUTSTANDING";
  label: string;
  severity: VisaApprovalGapSeverity;
  /** Which traveller this gap is about; null for request-level gaps. */
  travellerName: string | null;
}

/** Documents ATTACHED, counted and named. Never the files, never a key. */
export interface VisaApprovalDocumentSummary {
  count: number;
  /** Distinct doc codes present, e.g. ["DOC-01", "PHOTOGRAPH"]. */
  docCodes: string[];
  /** Human names for those codes, catalogue-resolved; falls back to the code. */
  docNames: string[];
}

export interface VisaApprovalCardTraveller {
  applicationId: string;
  travellerProfileId: string | null;
  /** Name as held on the traveller record — i.e. as-per-passport. */
  name: string | null;
  /** "YYYY-MM-DD" as stored on TravellerProfile. */
  dob: string | null;
  nationality: string | null;
  /** VisaApplication.nationalityUnresolved — the ISO2 resolve failed. */
  nationalityUnresolved: boolean;

  passportOnFile: boolean;
  /** maskTailId output, e.g. "****1203". NEVER the full number. */
  passportMasked: string | null;
  passportExpiry: string | null;
  passportValidity: VisaPassportValidity;

  rosterStatus: VisaRosterStatus;
  rosterBasis: VisaRosterBasis;
  /** This traveller IS the person who raised the request. */
  isRequestor: boolean;

  documents: VisaApprovalDocumentSummary;
  /** Gaps attributable to this traveller, repeated in the card rollup. */
  gaps: VisaApprovalGap[];
}

export interface VisaApprovalCard {
  filedFor: VisaFiledFor;
  travellerCount: number;
  /** How many travellers came back OFF_ROSTER — the collapsed-card signal. */
  offRosterCount: number;
  travellers: VisaApprovalCardTraveller[];
  consent: {
    /** Every clause in config/visaConsent.ts is recorded on the request. */
    accepted: boolean;
    acceptedAt: string | Date | null;
    version: string | null;
    missingClauseIds: string[];
  };
  /** Request-level rollup of everything attached across every traveller. */
  documents: VisaApprovalDocumentSummary;
  completeness: {
    /**
     * No BLOCKING gap — the request can proceed. Advisory gaps (outstanding
     * checklist documents) may still be listed: they are the concierge's to
     * chase after filing, and the submit route does not block on them.
     */
    ready: boolean;
    gaps: VisaApprovalGap[];
  };
}

/* ── Date handling ────────────────────────────────────────────────────── */

/**
 * TravellerProfile.dob and .passportExpiry are STRINGS ("YYYY-MM-DD" — see
 * that model's schema), while VisaRequest.travelDateFrom/To are real Dates.
 * Both are reduced to a UTC midnight Date here so the comparisons below are
 * date-to-date and never accidentally time-of-day sensitive.
 *
 * Returns null for anything unparseable rather than an Invalid Date, so a
 * malformed stored value degrades to UNKNOWN (an honest gap) instead of
 * silently comparing as NaN and reporting VALID.
 */
export function parseVisaDateOnly(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const str = String(value).trim();
  if (!str) return null;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (ymd) {
    const d = new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()),
  );
}

/**
 * A passport is valid THROUGH its expiry date, so every comparison here is
 * strictly-before, never before-or-equal: an expiry of exactly the last day of
 * travel is VALID, not EXPIRES_BEFORE_TRAVEL.
 *
 * `travelDateTo` falls back to `travelDateFrom` (a one-day trip records only
 * the start), and with neither on the request the only honest question left is
 * "has it already expired", judged against `now`.
 */
export function resolvePassportValidity(params: {
  passportExpiry: unknown;
  travelDateFrom?: unknown;
  travelDateTo?: unknown;
  now: Date;
}): VisaPassportValidity {
  const expiry = parseVisaDateOnly(params.passportExpiry);
  if (!expiry) return "UNKNOWN";

  const today = parseVisaDateOnly(params.now);
  if (today && expiry.getTime() < today.getTime()) return "EXPIRED";

  const travelEnd =
    parseVisaDateOnly(params.travelDateTo) ?? parseVisaDateOnly(params.travelDateFrom);
  if (travelEnd && expiry.getTime() < travelEnd.getTime()) return "EXPIRES_BEFORE_TRAVEL";

  return "VALID";
}

/* ── Roster status ────────────────────────────────────────────────────── */

/**
 * `knownUserIds` is the set of claimedBy ids that were confirmed to still
 * resolve to a User. Passing it is what makes MEMBER a fact rather than a
 * dangling pointer: a profile claimed by a since-deleted account reports
 * CLAIM_UNRESOLVED, and CLAIM_UNRESOLVED is UNKNOWN — not MEMBER (we cannot
 * show a link we could not resolve) and not OFF_ROSTER (a claim was made).
 */
export function resolveRosterStatus(
  profile: any | null | undefined,
  knownUserIds: ReadonlySet<string>,
): { rosterStatus: VisaRosterStatus; rosterBasis: VisaRosterBasis } {
  if (!profile) return { rosterStatus: "UNKNOWN", rosterBasis: "NO_PROFILE" };

  if (profile.claimedBy) {
    if (knownUserIds.has(String(profile.claimedBy))) {
      return { rosterStatus: "MEMBER", rosterBasis: "CLAIMED_LOGIN" };
    }
    // A claim we cannot resolve is worse than no claim: report it as such.
    if (!profile.linkedMemberId) {
      return { rosterStatus: "UNKNOWN", rosterBasis: "CLAIM_UNRESOLVED" };
    }
  }

  if (profile.linkedMemberId) return { rosterStatus: "MEMBER", rosterBasis: "ROSTER_LINK" };

  return { rosterStatus: "OFF_ROSTER", rosterBasis: "NO_LINK" };
}

/* ── Requestor vs traveller ───────────────────────────────────────────── */

/**
 * `travellers` is this request's shaped travellers, each already carrying
 * `isRequestor` and the profile's own claim state (`hasResolvedClaim` — a
 * claim that resolves to SOMEBODY, whether or not it is the requestor).
 *
 * ON_BEHALF requires positive proof: at least one traveller provably belongs
 * to a different person. Without that, an unclaimed traveller might BE the
 * requestor under a profile they never claimed, and UNKNOWN says so.
 */
export function resolveFiledFor(
  travellers: Array<{ isRequestor: boolean; hasResolvedClaim: boolean }>,
): VisaFiledFor {
  if (travellers.length === 0) return "UNKNOWN";
  const selfCount = travellers.filter((t) => t.isRequestor).length;
  if (selfCount === travellers.length) return "SELF";
  if (selfCount > 0) return "SELF_AND_OTHERS";
  // Nobody is the requestor. Only claim it was filed for someone else when
  // at least one traveller is demonstrably someone else.
  return travellers.some((t) => t.hasResolvedClaim) ? "ON_BEHALF" : "UNKNOWN";
}

/* ── Documents ────────────────────────────────────────────────────────── */

/** Distinct doc codes across a set of VisaDocument rows, catalogue-named. */
export function summariseDocuments(docs: Array<{ docCode?: string }>): VisaApprovalDocumentSummary {
  const docCodes = [...new Set(docs.map((d) => d?.docCode).filter(Boolean) as string[])].sort();
  return {
    count: docs.length,
    docCodes,
    docNames: docCodes.map((code) => getVisaDocumentCodeDef(code)?.name ?? code),
  };
}

/* ── Consent ──────────────────────────────────────────────────────────── */

/**
 * A submitted request always carries all three clauses (POST
 * /requests/:id/submit pushes them in one atomic write or writes nothing), so
 * `accepted: false` here means something is genuinely wrong with the row —
 * a hand-built fixture, a legacy request, or a seed. Reporting the missing
 * clause ids rather than a bare boolean is what makes that diagnosable
 * instead of merely alarming.
 */
export function summariseConsent(consents: any[] | null | undefined): VisaApprovalCard["consent"] {
  const rows = Array.isArray(consents) ? consents : [];
  const present = new Set(rows.map((c) => String(c?.clauseId)));
  const missingClauseIds = VISA_CONSENT_CLAUSE_IDS.filter((id) => !present.has(id));
  const first = rows[0] ?? null;
  return {
    accepted: rows.length > 0 && missingClauseIds.length === 0,
    acceptedAt: first?.acceptedAt ?? null,
    version: first?.version ?? null,
    missingClauseIds,
  };
}

/* ── The card ─────────────────────────────────────────────────────────── */

const GAP_LABELS: Record<VisaApprovalGap["code"], string> = {
  TRAVELLER_PROFILE_MISSING: "Traveller record is missing",
  PASSPORT_NUMBER_MISSING: "No passport number on file",
  PASSPORT_EXPIRY_MISSING: "No passport expiry on file",
  PASSPORT_EXPIRED: "Passport has expired",
  PASSPORT_EXPIRES_BEFORE_TRAVEL: "Passport expires before the travel dates",
  DOB_MISSING: "No date of birth on file",
  NATIONALITY_UNRESOLVED: "Nationality could not be resolved",
  CONSENT_MISSING: "Consent is not recorded on this request",
  DOCUMENTS_OUTSTANDING: "Required documents not uploaded yet",
};

function gap(
  code: VisaApprovalGap["code"],
  severity: VisaApprovalGapSeverity,
  travellerName: string | null,
  labelOverride?: string,
): VisaApprovalGap {
  return { code, label: labelOverride ?? GAP_LABELS[code], severity, travellerName };
}

function travellerName(profile: any): string | null {
  const name = [profile?.firstName, profile?.middleName, profile?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || null;
}

/**
 * Everything the card needs that is not on the request document itself,
 * loaded ONCE by the route and handed in. Keeping this a plain input (rather
 * than having the builder query) is what makes every rule above unit-testable
 * without a database.
 */
export interface VisaApprovalCardContext {
  /** TravellerProfile._id -> lean doc, including claimedBy/linkedMemberId. */
  profilesById: Map<string, any>;
  /** VisaApplication._id -> that application's live (non-deleted) documents. */
  documentsByApplicationId: Map<string, Array<{ docCode?: string }>>;
  /** claimedBy ids confirmed to still resolve to a User — see resolveRosterStatus. */
  knownUserIds: ReadonlySet<string>;
  now: Date;
}

/**
 * Build one request's approvals card.
 *
 * `applications` are this request's VisaApplication docs — the RAW ones, not
 * the hydrated payload: this builder reads ruleSnapshot/applicantProfile/
 * linkedBookings for the outstanding-documents check and nothing else from
 * them, and reading the raw doc keeps it independent of whatever the
 * tracking-view hydration happens to project.
 */
export function buildVisaApprovalCard(params: {
  request: any;
  applications: any[];
  ctx: VisaApprovalCardContext;
}): VisaApprovalCard {
  const { request, applications, ctx } = params;
  const raisedBy = request?.raisedByUserId ? String(request.raisedByUserId) : null;

  const shaped = applications.map((app) => {
    const profileId = app?.travellerProfileId ? String(app.travellerProfileId) : null;
    const profile = profileId ? ctx.profilesById.get(profileId) ?? null : null;
    const name = travellerName(profile);
    const docs = ctx.documentsByApplicationId.get(String(app?._id)) ?? [];

    const { rosterStatus, rosterBasis } = resolveRosterStatus(profile, ctx.knownUserIds);
    const claimedBy = profile?.claimedBy ? String(profile.claimedBy) : null;
    const hasResolvedClaim = !!claimedBy && ctx.knownUserIds.has(claimedBy);
    const isRequestor = !!raisedBy && hasResolvedClaim && claimedBy === raisedBy;

    const passportOnFile = !!String(profile?.passportNo ?? "").trim();
    const passportValidity = resolvePassportValidity({
      passportExpiry: profile?.passportExpiry,
      travelDateFrom: request?.travelDateFrom,
      travelDateTo: request?.travelDateTo,
      now: ctx.now,
    });

    const gaps: VisaApprovalGap[] = [];
    if (!profile) {
      gaps.push(gap("TRAVELLER_PROFILE_MISSING", "BLOCKING", null));
    } else {
      if (!passportOnFile) gaps.push(gap("PASSPORT_NUMBER_MISSING", "BLOCKING", name));
      if (passportValidity === "UNKNOWN") gaps.push(gap("PASSPORT_EXPIRY_MISSING", "BLOCKING", name));
      if (passportValidity === "EXPIRED") gaps.push(gap("PASSPORT_EXPIRED", "BLOCKING", name));
      if (passportValidity === "EXPIRES_BEFORE_TRAVEL") {
        gaps.push(gap("PASSPORT_EXPIRES_BEFORE_TRAVEL", "BLOCKING", name));
      }
      if (!String(profile?.dob ?? "").trim()) gaps.push(gap("DOB_MISSING", "BLOCKING", name));
    }
    if (app?.nationalityUnresolved) gaps.push(gap("NATIONALITY_UNRESOLVED", "BLOCKING", name));

    // Checklist shortfall — ADVISORY, see VisaApprovalGapSeverity. Counted in
    // REQUIREMENTS, not documents: a four-document proof-of-occupation group
    // is one outstanding requirement, which is what computeOutstandingRequirements
    // already guarantees and why it is reused rather than re-counted here.
    const outstanding = computeOutstandingRequirements(app?.ruleSnapshot || {}, app?.applicantProfile, {
      uploadedDocCodes: new Set(docs.map((d) => d?.docCode).filter(Boolean) as string[]),
      linkedServices: new Set(
        (Array.isArray(app?.linkedBookings) ? app.linkedBookings : []).map((lb: any) => lb?.service),
      ),
    });
    if (outstanding.length > 0) {
      gaps.push(
        gap(
          "DOCUMENTS_OUTSTANDING",
          "ADVISORY",
          name,
          `${outstanding.length} required document${outstanding.length === 1 ? "" : "s"} not uploaded yet`,
        ),
      );
    }

    const traveller: VisaApprovalCardTraveller = {
      applicationId: String(app?._id),
      travellerProfileId: profileId,
      name,
      dob: profile?.dob ?? null,
      // The application's RESOLVED ISO2 (routes/visa.ts sets it at creation),
      // falling back to the profile's free-text value when the resolve failed
      // — paired with nationalityUnresolved so the UI can show the raw text
      // AND say it didn't resolve, rather than showing a blank.
      nationality: app?.nationality ?? profile?.nationality ?? null,
      nationalityUnresolved: !!app?.nationalityUnresolved,
      passportOnFile,
      passportMasked: passportOnFile ? maskTailId(profile?.passportNo) ?? null : null,
      passportExpiry: profile?.passportExpiry ?? null,
      passportValidity,
      rosterStatus,
      rosterBasis,
      isRequestor,
      documents: summariseDocuments(docs),
      gaps,
    };

    return { traveller, hasResolvedClaim };
  });

  const consent = summariseConsent(request?.consents);
  const requestGaps: VisaApprovalGap[] = shaped.flatMap((s) => s.traveller.gaps);
  if (!consent.accepted) requestGaps.push(gap("CONSENT_MISSING", "BLOCKING", null));

  const allDocs = shaped.flatMap(
    (s) => ctx.documentsByApplicationId.get(s.traveller.applicationId) ?? [],
  );

  return {
    filedFor: resolveFiledFor(
      shaped.map((s) => ({ isRequestor: s.traveller.isRequestor, hasResolvedClaim: s.hasResolvedClaim })),
    ),
    travellerCount: shaped.length,
    offRosterCount: shaped.filter((s) => s.traveller.rosterStatus === "OFF_ROSTER").length,
    travellers: shaped.map((s) => s.traveller),
    consent,
    documents: summariseDocuments(allDocs),
    completeness: {
      ready: !requestGaps.some((g) => g.severity === "BLOCKING"),
      gaps: requestGaps,
    },
  };
}
