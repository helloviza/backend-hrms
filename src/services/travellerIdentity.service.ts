// apps/backend/src/services/travellerIdentity.service.ts
//
// "Which TravellerProfile is the caller?" — the SINGLE implementation of the
// self-service identity rules, shared by the endpoint that OFFERS a link and
// the endpoint that PERFORMS it:
//
//   • GET  /api/visa/travellers/me                    (routes/visa.ts)
//   • GET  /api/visa/travellers/me/candidates         (routes/visa.ts)
//   • POST /api/workspace/travellers/:id/self-confirm (routes/workspace.travellers.ts)
//
// The offer and the action MUST agree. A candidates response that advertises
// NAME_UNIQUE for a profile the self-confirm guard then refuses is worse than
// offering nothing at all — the user taps a button that cannot work. So the
// nine-condition guard lives here once and both call it, the same way the
// approval chain's resolver is shared rather than reimplemented per caller.
//
// THE ONE RULE: identity is `claimedBy` — a User id. NEVER `linkedMemberId`.
// routes/visa.ts's resolveVisaRequestsFilter keys "which visa applications are
// mine" on claimedBy, and nothing in the visa module reads linkedMemberId for
// identity (it is only ever reduced to an `isWorkspaceMember` boolean).
// linkedMemberId is still WRITTEN on a successful link, because
// ensureTravellerWriteAccess keys REQUESTER self-edit rights on it — but it is
// never the key anything is resolved BY.
//
// NO SILENT EMAIL-LINKING. models/TravellerProfile.ts's header forbids
// inferring a link "silently from an email string match". Nothing in this file
// writes: it reads and it judges. Every link is created by an explicit user tap
// or an explicit admin action in the routes above.
//
// See infra/design/visa-self-service-identity-2026-08-10.md.

import mongoose from "mongoose";
import TravellerProfile from "../models/TravellerProfile.js";
import { normalizeEmail, normalizeName } from "../utils/travellerMatch.js";

/* ──────────────────────────────────────────────────────────────────────
 * Projections.
 *
 * Both are ALLOWLISTS, never the raw document. claimedBy / linkedMemberId /
 * createdBy and every other internal field stay server-side; membership is
 * surfaced only as the derived `isWorkspaceMember` boolean, matching what
 * routes/visa.ts's GET /travellers already does ("never the raw
 * linkedMemberId").
 * ────────────────────────────────────────────────────────────────────── */

/** Fields loaded for any profile this module shapes or matches on. */
export const IDENTITY_PROFILE_FIELDS =
  "travelerId firstName middleName lastName dob email mobile nationality " +
  "passportNo passportExpiry passportIssueCountry departmentId linkedMemberId claimedBy isActive";

export function travellerFullName(d: any): string {
  return [d?.firstName, d?.middleName, d?.lastName].filter(Boolean).join(" ").trim();
}

/**
 * The caller's OWN record — passport UNMASKED.
 *
 * Every other traveller read in the module masks the passport, because those
 * are other people's documents. A profile the caller has already claimed is
 * their own data: they are entitled to read it in full, and the confirm step
 * has to show them what is actually on file so they can correct it.
 */
export function shapeOwnProfile(d: any) {
  return {
    id: String(d._id),
    travelerId: d.travelerId ?? null,
    name: travellerFullName(d),
    firstName: d.firstName ?? null,
    middleName: d.middleName ?? null,
    lastName: d.lastName ?? null,
    dob: d.dob ?? null,
    email: d.email ?? null,
    mobile: d.mobile ?? null,
    nationality: d.nationality ?? null,
    passportNo: d.passportNo ?? null, // UNMASKED — see the doc comment above
    passportExpiry: d.passportExpiry ?? null,
    passportIssueCountry: d.passportIssueCountry ?? null,
    departmentId: d.departmentId ? String(d.departmentId) : null,
    isWorkspaceMember: !!d.linkedMemberId,
  };
}

/**
 * A CANDIDATE the caller has not yet proven is theirs — passport MASKED, and
 * deliberately thinner than shapeOwnProfile: just enough to recognise yourself
 * ("is this you?"), never enough to harvest somebody else's identity document.
 * maskTailId is injected so this module does not reach into utils/piiMask
 * independently of its callers.
 */
export function shapeCandidateProfile(d: any, maskTailId: (v: any) => string | null) {
  return {
    id: String(d._id),
    travelerId: d.travelerId ?? null,
    name: travellerFullName(d),
    dob: d.dob ?? null,
    email: d.email ?? null,
    nationality: d.nationality ?? null,
    passportMasked: maskTailId(d.passportNo) ?? null,
    passportExpiry: d.passportExpiry ?? null,
  };
}

/* ──────────────────────────────────────────────────────────────────────
 * Strict resolve — GET /travellers/me.
 * ────────────────────────────────────────────────────────────────────── */

export type ResolveMeResult =
  | { resolved: true; traveller: any }
  | { resolved: false; reason: "none" | "duplicate_claims"; travellers: any[] };

/**
 * claimedBy === callerUserId, in this workspace, active. NO fallback, no
 * inference, no repair — the same strictness routes/visa.ts's OWN scope
 * already applies, so "the profile /me resolves" and "the applications OWN
 * scope shows" can never disagree.
 *
 * More than one claimed profile is NOT an error and NOT something to guess at:
 * the same person can legitimately hold two (a bulk import plus a self-add),
 * and picking one silently would file a visa against the wrong passport. Both
 * are returned for the caller to disambiguate — a choice among their OWN
 * records, which is safe to ask.
 */
export async function resolveMyTravellerProfiles(
  workspaceId: mongoose.Types.ObjectId | string,
  userId: mongoose.Types.ObjectId | string,
): Promise<ResolveMeResult> {
  const docs: any[] = await TravellerProfile.find({
    workspaceId,
    isActive: true,
    claimedBy: userId,
  })
    .select(IDENTITY_PROFILE_FIELDS)
    .sort({ firstName: 1, lastName: 1 })
    .lean();

  if (docs.length === 1) return { resolved: true, traveller: shapeOwnProfile(docs[0]) };
  if (docs.length === 0) return { resolved: false, reason: "none", travellers: [] };
  return { resolved: false, reason: "duplicate_claims", travellers: docs.map(shapeOwnProfile) };
}

/* ──────────────────────────────────────────────────────────────────────
 * The nine-condition guard.
 * ────────────────────────────────────────────────────────────────────── */

export type SelfConfirmCode =
  | "not_found"
  | "already_claimed"
  | "email_mismatch"
  | "ambiguous_name"
  | "no_match";

/**
 * Flat shape (optional fields) rather than a discriminated union: this package
 * compiles with strictNullChecks:false, where boolean-literal discriminants do
 * NOT narrow — the same reason services/reports.service.ts's SubmitReportResult
 * is flat. Branch on `ok`; the relevant fields are populated per outcome.
 */
export type SelfConfirmVerdict = {
  ok: boolean;
  /** Populated when ok. */
  traveller?: any;
  /** Populated when !ok. */
  status?: number;
  code?: SelfConfirmCode;
  error?: string;
};

/** Unclaimed on BOTH keys — condition 4. */
function isFullyUnclaimed(d: any): boolean {
  return !d?.claimedBy && !d?.linkedMemberId;
}

/**
 * Does this profile carry the member's name?
 *
 * Matches EITHER the full name (first + middle + last) or the short form
 * (first + last), both normalized through the shared normalizeName. A member
 * row recorded as "Anna Eriksson" should match a profile stored as "Anna Marie
 * Eriksson", and vice versa — the middle name is exactly the kind of detail one
 * of the two sources routinely omits.
 *
 * Matching on either form is DELIBERATELY the loose end of this rule, and it is
 * safe precisely because ambiguity refuses: a looser match can only ever turn a
 * confident answer into "more than one matched", which condition 7 then rejects.
 * It can never turn a non-match into a false positive.
 */
function profileMatchesName(d: any, normalizedMemberName: string): boolean {
  if (!normalizedMemberName) return false;
  const full = normalizeName(travellerFullName(d));
  const short = normalizeName([d?.firstName, d?.lastName].filter(Boolean).join(" "));
  return full === normalizedMemberName || short === normalizedMemberName;
}

/**
 * Conditions 4-8 of the self-confirm guard — the DATA half, shared by the
 * candidates tier (which calls it with no targetId, to discover the match) and
 * the self-confirm route (which calls it WITH one, to verify it).
 *
 * Conditions 1-3 (not SUPERADMIN / active member / session workspace) and 9
 * (explicit confirm:true) are request-level and stay in the route — they are
 * the same gates every other handler in that router applies, and duplicating
 * them here would give two places to get the SUPERADMIN posture wrong.
 *
 *   4. traveller UNCLAIMED on both keys        -> 409 already_claimed
 *   5. no contradicting email                  -> 403 email_mismatch
 *   6. member has a non-blank name             -> 404 no_match
 *   7. exactly ONE active profile in the       -> 409 ambiguous_name
 *      workspace carries that name, counting
 *      claimed and unclaimed alike
 *   8. the re-derived match === targetId       -> 404 no_match
 *
 * ANTI-ENUMERATION (condition 8): targetId is never used to DECIDE, only to
 * VERIFY. The match is derived from the caller's own member name; the supplied
 * id must then equal it. So a probed id is indistinguishable from no match, and
 * :id cannot be walked to learn which profiles are unclaimed.
 */
export async function evaluateNameUniqueSelfConfirm(params: {
  workspaceId: mongoose.Types.ObjectId | string;
  callerEmail: string;
  memberName: string;
  /** Present on the ACTION (verify); absent on the OFFER (discover). */
  targetId?: string;
}): Promise<SelfConfirmVerdict> {
  const { workspaceId, callerEmail, memberName, targetId } = params;

  // ── 6. The member has a name to match on at all. ──
  // Checked before any query: a blank member name would otherwise match every
  // profile whose own name normalizes to blank.
  const normalizedMemberName = normalizeName(memberName);
  if (!normalizedMemberName) {
    return {
      ok: false,
      status: 404,
      code: "no_match",
      error: "We couldn't confirm automatically — ask your workspace leader to link you.",
    };
  }

  // Every active profile in the workspace, matched in JS through the SHARED
  // normalizer rather than a Mongo regex: the comparison is then provably the
  // same one findMatchingTraveller uses, with no escaping or collation to get
  // wrong. The scan is workspace-scoped and roster-sized — the same unbounded
  // {workspaceId, isActive} read admin.visa.roster.ts already performs.
  const all: any[] = await TravellerProfile.find({ workspaceId, isActive: true })
    .select(IDENTITY_PROFILE_FIELDS)
    .lean();

  // ── 7. Unambiguous across ALL profiles — claimed and unclaimed alike. ──
  // Counting only unclaimed rows would let a genuinely ambiguous name look
  // confident: if two "Anna Eriksson" profiles exist and one is already claimed
  // by somebody else, the name does not identify anyone. That the other is
  // merely still available does not make it demonstrably the caller.
  const named = all.filter((d) => profileMatchesName(d, normalizedMemberName));

  if (named.length === 0) {
    return {
      ok: false,
      status: 404,
      code: "no_match",
      error: "We couldn't confirm automatically — ask your workspace leader to link you.",
    };
  }
  if (named.length > 1) {
    return {
      ok: false,
      status: 409,
      code: "ambiguous_name",
      error:
        "More than one traveller here has your name, so we can't confirm which is you — " +
        "ask your workspace leader to link you.",
    };
  }

  const match = named[0];

  // ── 8. Re-derived match must be the one the caller named. ──
  if (targetId && String(match._id) !== String(targetId)) {
    return {
      ok: false,
      status: 404,
      code: "no_match",
      error: "We couldn't confirm automatically — ask your workspace leader to link you.",
    };
  }

  // ── 4. Unclaimed on BOTH keys. ──
  if (!isFullyUnclaimed(match)) {
    return {
      ok: false,
      status: 409,
      code: "already_claimed",
      error: "This traveller is already linked to someone.",
    };
  }

  // ── 5. No CONTRADICTING email. ──
  // A blank traveller email is the case this whole route exists for (the audit's
  // §3.5: a workspace leader created the profile and left it blank, so /claim's
  // exact-email test can never pass and the employee has no way forward).
  //
  // A NON-blank email that MATCHES the caller is not a contradiction and is not
  // refused here — but the candidates endpoint never routes such a profile to
  // this action either: it is the stronger EXACT_EMAIL tier and is offered the
  // existing /claim route instead. That split is what makes this
  // "blank-email-only" in practice while keeping the guard itself a literal
  // contradiction test, so the route stays correct if called directly.
  const travellerEmail = normalizeEmail(match.email);
  if (travellerEmail && travellerEmail !== normalizeEmail(callerEmail)) {
    return {
      ok: false,
      status: 403,
      code: "email_mismatch",
      error:
        "This traveller's record has a different email address, so we can't confirm it's you — " +
        "ask your workspace leader to link you.",
    };
  }

  return { ok: true, traveller: match };
}

/* ──────────────────────────────────────────────────────────────────────
 * Candidate discovery — the tier decision behind GET /me/candidates.
 * ────────────────────────────────────────────────────────────────────── */

export type CandidateTier = "EXACT_EMAIL" | "NAME_UNIQUE" | "NONE";

export type CandidatesResult = {
  tier: CandidateTier;
  /** Raw lean docs — the caller shapes/masks them. */
  candidates: any[];
};

/**
 * Which offer, if any, to make to a caller whose /me did not resolve.
 *
 * EXACT_EMAIL wins whenever it applies: it is the stronger key, and it maps to
 * POST /:id/claim, a route that already exists, is already tested, and already
 * enforces the same email equality server-side.
 *
 * NAME_UNIQUE is only reached when no unclaimed profile carries the caller's
 * email, and it re-runs the FULL self-confirm guard (via
 * evaluateNameUniqueSelfConfirm) rather than a lookalike of it — so the button
 * this tier renders is one the action will actually honour.
 */
export async function findIdentityCandidates(params: {
  workspaceId: mongoose.Types.ObjectId | string;
  callerEmail: string;
  memberName: string;
}): Promise<CandidatesResult> {
  const { workspaceId, callerEmail, memberName } = params;
  const mine = normalizeEmail(callerEmail);

  // ── EXACT_EMAIL — unclaimed, and carrying the caller's own address. ──
  // "Unclaimed on both keys" matches /claim's own posture: that route refuses a
  // profile already linked to a different member, so offering one here would
  // advertise a 409.
  if (mine) {
    const all: any[] = await TravellerProfile.find({ workspaceId, isActive: true })
      .select(IDENTITY_PROFILE_FIELDS)
      .lean();
    const exact = all.filter((d) => isFullyUnclaimed(d) && normalizeEmail(d.email) === mine);
    if (exact.length > 0) return { tier: "EXACT_EMAIL", candidates: exact };
  }

  // ── NAME_UNIQUE — the full guard, no targetId (discover, don't verify). ──
  const verdict = await evaluateNameUniqueSelfConfirm({ workspaceId, callerEmail, memberName });
  if (verdict.ok) return { tier: "NAME_UNIQUE", candidates: [verdict.traveller] };

  return { tier: "NONE", candidates: [] };
}
