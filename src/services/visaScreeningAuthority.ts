// apps/backend/src/services/visaScreeningAuthority.ts
//
// The screening-authority check the three screening-act routes consult
// (routes/admin.visa.ts). Two questions, deliberately separate:
//
//   1. IS THIS PERSON A SCREENER AT ALL?  — the visaScreening capability, an
//      organisational fact an admin grants. Checked with the same
//      grant-based rules requirePermission uses (active UserPermission,
//      hasAccess >= WRITE, SUPERADMIN bypass) — never requireRoles, which
//      would let any tenant-side admin role through (the TENANT_ADMIN trap).
//
//   2. IS THIS SCREENER ACCOUNTABLE FOR THIS CASE? — assignedScreeningOfficerId
//      on the application itself.
//
// Neither alone is enough. Permission-only leaves the assignment slot as
// decorative as it is today, so an audit line saying "screened by X" still
// would not mean X was the person accountable. Assignment-only lets anyone
// with visaApplication WRITE be dropped into the screening slot regardless
// of competence, which is exactly the hole this unit exists to close.
//
// NOT A MIDDLEWARE, on purpose: the per-case half needs the application
// already loaded, and every caller has loaded it by the time it reaches
// here (the document-review route resolves the owning application for its
// erasure guard anyway). A middleware would have to re-fetch it.
import mongoose from "mongoose";
import { UserPermission, hasAccess } from "../models/UserPermission.js";
import { isVisaScreeningEnforced, type VisaScreeningAct } from "../config/visaScreening.js";

export interface ScreeningAuthorityRefusal {
  status: number;
  error: string;
  reason: "NOT_A_SCREENER" | "NOT_ASSIGNED";
}

/**
 * True when this user holds the visaScreening capability at WRITE or above.
 * Mirrors requirePermission's own gate exactly, including the SUPERADMIN
 * bypass — an L8 who bypasses every other check must not be stopped here
 * either, or turning the flag on would lock out the one account that can
 * currently fix anything.
 */
export async function userHoldsScreeningCapability(
  userId: unknown,
  roles?: unknown,
): Promise<boolean> {
  if (Array.isArray(roles) && roles.includes("SUPERADMIN")) return true;
  const id = String(userId || "");
  if (!mongoose.isValidObjectId(id)) return false;

  const perm = await UserPermission.findOne({ userId: id, status: "active" })
    .select("modules.visaScreening")
    .lean();
  const access = (perm as any)?.modules?.visaScreening?.access || "NONE";
  return hasAccess(access, "WRITE");
}

/**
 * The gate. Returns null when the act may proceed, or a refusal to return
 * verbatim.
 *
 * Returns null IMMEDIATELY when enforcement is off — which is the default,
 * and today's behaviour exactly. Nothing about the caller, the application,
 * or the database is consulted in that state, so a dormant gate cannot slow
 * a route down or fail it in a way today's code would not.
 *
 * `act` is accepted for the refusal message and for future per-act
 * divergence; all three acts share one rule today, and saying so explicitly
 * beats three call sites each passing the same thing for no reason.
 */
export async function checkScreeningAuthority(opts: {
  act: VisaScreeningAct;
  userId: unknown;
  roles?: unknown;
  application: { assignedScreeningOfficerId?: unknown } | null | undefined;
}): Promise<ScreeningAuthorityRefusal | null> {
  if (!isVisaScreeningEnforced()) return null;

  const isSuperAdmin = Array.isArray(opts.roles) && opts.roles.includes("SUPERADMIN");

  if (!(await userHoldsScreeningCapability(opts.userId, opts.roles))) {
    return {
      status: 403,
      reason: "NOT_A_SCREENER",
      error:
        "This is a screening action — it needs the visaScreening capability, which this account does not hold.",
    };
  }

  // SUPERADMIN clears the per-case check too, for the same reason it clears
  // every other one: it is the break-glass account.
  if (isSuperAdmin) return null;

  const assigned = (opts.application as any)?.assignedScreeningOfficerId;
  if (!assigned || String(assigned) !== String(opts.userId)) {
    return {
      status: 403,
      reason: "NOT_ASSIGNED",
      error: assigned
        ? "This case is assigned to a different screening officer."
        : "This case has no assigned screening officer — assign one before screening it.",
    };
  }

  return null;
}
