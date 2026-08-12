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
// Neither alone is enough AS AN END STATE. Permission-only leaves the
// assignment slot as decorative as it is today, so an audit line saying
// "screened by X" still would not mean X was the person accountable.
// Assignment-only lets anyone with visaApplication WRITE be dropped into the
// screening slot regardless of competence, which is exactly the hole this
// unit exists to close.
//
// But they are enforced in ORDER, not together, because they carry very
// different operational cost. Requiring the capability only changes WHO may
// screen — a grant fixes it. Requiring per-case assignment changes HOW OPS
// WORKS. The tier in config/visaScreening.ts is what lets the first ship
// without the second.
//
// RULING 1 (auto-claim) IS BUILT — an unassigned case is taken by the
// screener who acts on it, logged. RULING 2 (lead override) is NOT: a case
// assigned to someone else is refused, and the ways through are a concierge
// reassigning it or the SuperAdmin break-glass.
//
// NOT A MIDDLEWARE, on purpose: the per-case half needs the application
// already loaded, and every caller has loaded it by the time it reaches
// here (the document-review route resolves the owning application for its
// erasure guard anyway). A middleware would have to re-fetch it.
import mongoose from "mongoose";
import { UserPermission, hasAccess } from "../models/UserPermission.js";
import VisaApplication from "../models/VisaApplication.js";
import { logVisaActivity } from "../models/VisaActivityLog.js";
import { visaScreeningTier, type VisaScreeningAct } from "../config/visaScreening.js";

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
 * ⚠ IT CAN WRITE. At tier "assignment" only, on an UNASSIGNED case, and only
 * for a caller who already holds the capability, this claims the case for the
 * actor and logs SCREENING_OFFICER_AUTO_CLAIMED (Ruling 1). Every other tier
 * and branch is a pure read. The claim lives here rather than in the three
 * routes because one implementation cannot drift into three; the trade-off is
 * that a claim is recorded for an act that could still fail downstream (a
 * 404 on the document, say). That is the right way round: assignment records
 * who took responsibility for the case, not that a particular edit landed.
 *
 * Returns null IMMEDIATELY at tier "off" — which is the default, and today's
 * behaviour exactly. Nothing about the caller, the application, or the
 * database is consulted in that state, so a dormant gate cannot slow a route
 * down or fail it in a way today's code would not.
 *
 * The two checks are gated independently by tier:
 *   off         → neither runs.
 *   capability  → the capability check runs; assignment is NOT consulted.
 *   assignment  → both run, and an unassigned case is auto-claimed.
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
  const tier = visaScreeningTier();
  if (tier === "off") return null;

  const isSuperAdmin = Array.isArray(opts.roles) && opts.roles.includes("SUPERADMIN");

  if (!(await userHoldsScreeningCapability(opts.userId, opts.roles))) {
    return {
      status: 403,
      reason: "NOT_A_SCREENER",
      error:
        "This is a screening action — it needs the visaScreening capability, which this account does not hold.",
    };
  }

  // Tier "capability" stops here: holding the capability is the whole test,
  // so a screener may work any case they can already reach. This is the
  // point of the split — it makes screening a real capability without also
  // demanding that every case be assigned before it can be touched.
  if (tier === "capability") return null;

  // SUPERADMIN clears the per-case check too, for the same reason it clears
  // every other one: it is the break-glass account. Note this returns BEFORE
  // auto-claim: a break-glass action must not quietly make the SuperAdmin the
  // accountable officer on someone else's case.
  if (isSuperAdmin) return null;

  const assigned = (opts.application as any)?.assignedScreeningOfficerId;

  // ── RULING 1 — AUTO-CLAIM ON UNASSIGNED ─────────────────────────────
  // A screener acting on a case nobody owns becomes its officer, rather than
  // being refused into a dead end. Refusing here would have been the strict
  // reading and the wrong one: at this tier NOTHING could then be screened
  // until a coordinator assigned it, which turns every queue pickup into a
  // two-person handshake and would have people assigning cases to themselves
  // by hand anyway — the same outcome, with an extra step and no audit trail
  // saying it happened.
  //
  // It satisfies the ASSIGNMENT half ONLY. The capability check above has
  // already run and is not weakened by this: a non-screener never reaches
  // here, so nobody can claim their way into an authority they were not
  // granted.
  if (!assigned) {
    return claimUnassignedCase(opts);
  }

  if (String(assigned) !== String(opts.userId)) {
    return {
      status: 403,
      reason: "NOT_ASSIGNED",
      // Ruling 2 (lead override) is deliberately NOT decided — a case owned
      // by someone else is refused, and reassignment by a concierge or the
      // SuperAdmin break-glass are the ways through today.
      error: "This case is assigned to a different screening officer.",
    };
  }

  return null;
}

/**
 * Takes ownership of an unassigned case for this actor, then allows the act.
 *
 * CONDITIONAL WRITE, NOT read-then-write. Two screeners working the same
 * queue can hit an unassigned case within milliseconds of each other, and a
 * plain update would let the second silently overwrite the first — leaving an
 * audit trail that names the wrong officer, which is the exact failure this
 * whole unit exists to prevent. The update matches only while the case is
 * STILL unassigned, so exactly one caller can win.
 *
 * The loser is not a special case: they re-read and fall through the ordinary
 * rule. If the winner was themselves (a double-submit) they proceed; if it
 * was someone else the case now belongs to that person and they are refused
 * exactly as they would have been had it been assigned all along.
 */
async function claimUnassignedCase(opts: {
  act: VisaScreeningAct;
  userId: unknown;
  application: { assignedScreeningOfficerId?: unknown } | null | undefined;
}): Promise<ScreeningAuthorityRefusal | null> {
  const app: any = opts.application;
  const applicationId = app?._id;
  if (!applicationId) {
    // No id to claim against. Refuse rather than allow an unattributable
    // screening act — this tier's whole promise is that the trail names the
    // person accountable.
    return {
      status: 403,
      reason: "NOT_ASSIGNED",
      error: "This case has no assigned screening officer, and could not be claimed.",
    };
  }

  const claimed = await VisaApplication.findOneAndUpdate(
    {
      _id: applicationId,
      $or: [{ assignedScreeningOfficerId: null }, { assignedScreeningOfficerId: { $exists: false } }],
    },
    { $set: { assignedScreeningOfficerId: opts.userId } },
    { new: true },
  ).lean();

  if (!claimed) {
    // Lost the race — someone claimed it between our read and this write.
    const fresh: any = await VisaApplication.findById(applicationId)
      .select("assignedScreeningOfficerId")
      .lean();
    const now = fresh?.assignedScreeningOfficerId;
    if (now && String(now) === String(opts.userId)) {
      if (app) app.assignedScreeningOfficerId = now;
      return null;
    }
    return {
      status: 403,
      reason: "NOT_ASSIGNED",
      error: "This case is assigned to a different screening officer.",
    };
  }

  // Keep the caller's in-memory copy honest — several routes read the
  // application again after this point, and a stale null there would
  // describe a case that no longer exists in that state.
  if (app) app.assignedScreeningOfficerId = opts.userId;

  await logVisaActivity({
    applicationId,
    requestId: (claimed as any).requestId,
    workspaceId: (claimed as any).workspaceId,
    eventType: "SCREENING_OFFICER_AUTO_CLAIMED",
    actorUserId: opts.userId as any,
    actorType: "STAFF",
    // No PII — an act name and the fact it was self-taken, which is what
    // makes this row answer "how did this person come to own the case".
    detail: { act: opts.act, autoClaimed: true },
  });

  return null;
}
