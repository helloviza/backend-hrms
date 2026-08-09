// apps/backend/src/utils/cstepAccess.ts
//
// CSTEP Travel & Claim Portal — shared "CSTEP Admin" role check, used by both
// routes/cstep.ts (approve/return/queue gating) and workspace.travellers.ts
// (Tour Approver assignment gating), so the two files don't hand-maintain
// separate copies of the same role list. Also the home of
// resolveOwnTravellerProfile (Phase 6), the shared self-filing resolver.
//
// CSTEP Admin is a ROLE check — SUPERADMIN, ADMIN, HR, or WORKSPACE_LEADER —
// NOT a per-person capability toggle (unlike the Expense module's
// per-employee Admin/Finance grants). WORKSPACE_LEADER IS included: a
// workspace leader is superior to Admin (they run the whole workspace) and
// must have full CSTEP Admin access — the Approver/Official user/Finance
// user mapping columns, every queue, approve/return, all of it. (An earlier
// version of this file deliberately excluded WORKSPACE_LEADER here — that
// was wrong and has been reversed.) This is still separate from Tour
// Approver, the narrower per-traveller assignment stored on
// TravellerProfile.tourApproverId and checked independently at the call
// site for non-Admin approvers.

import mongoose from "mongoose";
import TravellerProfile, { type TravellerProfileDocument } from "../models/TravellerProfile.js";
import { normalizeEmail } from "./travellerMatch.js";

export function ownerId(req: any): string {
  return String(req.user?.id || req.user?._id || req.user?.sub || "");
}

/** CSTEP Admin gate — SUPERADMIN, ADMIN, HR, or WORKSPACE_LEADER role.
 * Workspace leader is checked both ways a workspace-side role can reach
 * req.user: normalized into req.user.roles[] (e.g. "Workspace Leader",
 * "WORKSPACE-LEADER" all fold to "WORKSPACELEADER"), or as the separate
 * req.user.customerMemberRole field the JWT sets from CustomerMember.role
 * (routes/auth.ts's buildAuthSafeUser) — literal value "WORKSPACE_LEADER".
 * Mirrors the exact same dual check routes/travelForm.ts's isPrivileged()
 * already uses for this same role. */
export function isCstepAdmin(req: any): boolean {
  const roles = (req.user?.roles || []).map((r: string) =>
    String(r).toUpperCase().replace(/[\s_-]/g, ""),
  );
  return (
    roles.includes("SUPERADMIN") ||
    roles.includes("ADMIN") ||
    roles.includes("HR") ||
    roles.includes("WORKSPACELEADER") ||
    req.user?.customerMemberRole === "WORKSPACE_LEADER"
  );
}

export type OwnTravellerResolution =
  | { status: "linked"; traveller: TravellerProfileDocument }
  | { status: "none" }
  | { status: "ambiguous" };

/**
 * Resolves a logged-in user's own TravellerProfile in a workspace — the
 * shared self-filing resolver (Phase 6), reused by POST /requests and
 * GET /my-traveller in routes/cstep.ts.
 *
 * 1. An existing explicit link (claimedBy === user) always wins — no email
 *    re-check needed, that link was already verified when it was made.
 * 2. Otherwise, an EXACT match on normalizeEmail(traveller.email) ===
 *    normalizeEmail(user.email) — the identical normalization
 *    (trim + lowercase) the "Is this you?" claim route uses
 *    (workspace.travellers.ts POST /:id/claim), reused here rather than
 *    reimplemented. No fuzzy matching, no name matching, ever.
 * 3. If more than one active profile in the workspace shares that email,
 *    the match is AMBIGUOUS — never auto-link; the caller falls back to
 *    the manual claim flow. Logged via console.warn for visibility.
 * 4. On an unambiguous email match, if that profile has no claimedBy yet,
 *    this is a safe one-time upgrade: set claimedBy (+ claimedAt) so future
 *    lookups hit step 1 directly. If it's already claimedBy a DIFFERENT
 *    user, it is never reassigned — treated as no match for this caller.
 *
 * Deliberately does NOT touch linkedMemberId (the CustomerMember link the
 * manual claim route also sets) — Phase 6 only asked for claimedBy, and
 * CSTEP's own self-filing logic never reads linkedMemberId.
 */
export async function resolveOwnTravellerProfile(
  workspaceId: any,
  user: any,
): Promise<OwnTravellerResolution> {
  const uid = String(user?.id || user?._id || user?.sub || "");
  if (!uid) return { status: "none" };

  const claimed = await TravellerProfile.findOne({
    workspaceId,
    claimedBy: new mongoose.Types.ObjectId(uid),
    isActive: true,
  }).sort({ claimedAt: -1 });
  if (claimed) return { status: "linked", traveller: claimed };

  const email = normalizeEmail(user?.email);
  if (!email) return { status: "none" };

  // TravellerProfile.email is schema-normalized (lowercase + trim) on save,
  // so querying with the already-normalized value matches directly.
  const matches = await TravellerProfile.find({ workspaceId, isActive: true, email }).limit(2);
  if (matches.length === 0) return { status: "none" };
  if (matches.length > 1) {
    console.warn(
      `[cstepAccess] Ambiguous traveller email match: user ${uid} / workspace ${workspaceId} — ` +
        `${matches.length}+ active TravellerProfiles share email ${email}. Not auto-linking.`,
    );
    return { status: "ambiguous" };
  }

  const traveller = matches[0];
  if (!traveller.claimedBy) {
    traveller.claimedBy = new mongoose.Types.ObjectId(uid);
    traveller.claimedAt = new Date();
    await traveller.save();
  } else if (String(traveller.claimedBy) !== uid) {
    // Already claimed by someone else — never reassign. Not a match for
    // THIS caller (their real profile, if any, would already have been
    // found via claimedBy above).
    return { status: "none" };
  }

  return { status: "linked", traveller };
}
