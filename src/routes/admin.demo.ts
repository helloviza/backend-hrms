// apps/backend/src/routes/admin.demo.ts
//
// Demo Platform — JWT impersonation endpoints. /start-session and
// /available-seeds are gated on the caller's demoAccess.enabled flag, re-read
// from the DB on every request (NOT from the JWT — audit §4) — any role
// (including EMPLOYEE) with a demo grant may use them. /end-session remains
// requireAdmin-gated (unchanged).
//
// POST /start-session  — mint an impersonation JWT for a mapped seed user
// POST /end-session    — close out an ACTIVE DemoSession record
//
// All security checks (caller has demoAccess.enabled, target.isDemoUser=true,
// target is in caller.demoAccess.mappedSeedUsers, target schema is well-formed)
// run before any token is minted. SUPERADMIN role is defensively stripped from
// the impersonation token, and isSuperAdmin() refuses to honor the role while
// _demoImpersonation is set on the request user.
import { Router, type Request, type Response } from "express";
import { Types } from "mongoose";
import { authenticate } from "../middleware/authenticate.js";
import { requireAdmin } from "../middleware/rbac.js";
import User from "../models/User.js";
import Customer from "../models/Customer.js";
import DemoSession from "../models/DemoSession.js";
import { CUSTOMER_DEMO_SEED_EMAILS } from "../config/demoSeedAllowlist.js";
import {
  signAccessToken,
  signDemoRefresh,
  setDemoRefreshCookie,
  clearDemoRefreshCookie,
} from "./auth.js";

// Repo convention is a per-file literal for the HOUSE workspace id (see
// requireHouse.ts, requireFeature.ts). NEVER a valid impersonation target.
const PLUMTRIPS_HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";

const router = Router();
router.use(authenticate);

function isValidObjectId(id: any): boolean {
  return typeof id === "string" && Types.ObjectId.isValid(id);
}

/* ------------------------------------------------------------------ */
/* POST /start-session                                                */
/* ------------------------------------------------------------------ */
router.post("/start-session", async (req: Request, res: Response) => {
  try {
    const { targetUserId, reason } = (req.body || {}) as {
      targetUserId?: string;
      reason?: string;
    };

    // 1. Validate targetUserId
    if (!targetUserId || !isValidObjectId(targetUserId)) {
      return res.status(400).json({
        error: "invalid_target_user_id",
        message: "targetUserId must be a valid ObjectId.",
      });
    }

    // 2. Re-read caller from DB (NEVER trust JWT for demoAccess — audit §4)
    const callerId = (req as any).user?.sub;
    if (!callerId || !isValidObjectId(String(callerId))) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const caller: any = await User.findById(callerId).lean();
    if (!caller) {
      return res.status(401).json({
        error: "caller_not_found",
        message: "Caller not found.",
      });
    }

    // 3. Verify caller.demoAccess.enabled === true
    if (!caller.demoAccess || caller.demoAccess.enabled !== true) {
      return res.status(403).json({
        error: "demo_access_not_granted",
        message: "You do not have demo access. Contact a SuperAdmin to grant access.",
      });
    }

    // 4. Re-read target from DB
    const target: any = await User.findById(targetUserId).lean();
    if (!target) {
      return res.status(404).json({
        error: "target_not_found",
        message: "Target user not found.",
      });
    }

    // 4b. HARD-FAIL: HOUSE is never a valid impersonation target, regardless
    //     of isDemoUser/mappedSeedUsers state. Checked before those flags so
    //     a misconfigured record (isDemoUser flipped on a HOUSE-homed
    //     account) can never mint a HOUSE-scoped session.
    if (String(target.workspaceId || "") === PLUMTRIPS_HOUSE_WORKSPACE_ID) {
      console.warn(
        `[demo] refused HOUSE-workspace target: userId=${target._id} email=${target.email}`,
      );
      return res.status(422).json({
        error: "target_is_house_workspace",
        message: "Impersonation targets may never belong to the HOUSE workspace.",
      });
    }

    // 5. Target must be flagged isDemoUser
    if (target.isDemoUser !== true) {
      return res.status(403).json({
        error: "target_not_demo_user",
        message: "The specified user is not configured as a demo seed user.",
      });
    }

    // 5b. SECOND, INDEPENDENT check for plumtrips.com-domain CUSTOMER targets
    //     (the demo1/2/3@plumtrips.com pattern): even if isDemoUser is
    //     (mis)configured true on some other internal-domain customer record,
    //     it still can't be impersonated unless it's a literal allowlist
    //     member. External-domain demo customers (e.g. the Inteletek AI seed)
    //     are unaffected — they never carried this internal-domain ambiguity.
    const targetEmailLower = String(target.email || "").toLowerCase();
    if (
      target.accountType === "CUSTOMER" &&
      targetEmailLower.endsWith("@plumtrips.com") &&
      !(CUSTOMER_DEMO_SEED_EMAILS as readonly string[]).includes(targetEmailLower)
    ) {
      return res.status(403).json({
        error: "target_not_in_customer_demo_allowlist",
        message: "This plumtrips.com customer account is not an allowlisted demo seed.",
      });
    }

    // 6. Target must be in caller.demoAccess.mappedSeedUsers
    const mapped = (caller.demoAccess.mappedSeedUsers || []).some(
      (id: any) => String(id) === String(target._id),
    );
    if (!mapped) {
      return res.status(403).json({
        error: "target_not_mapped",
        message: "You are not authorized to impersonate this user.",
      });
    }

    // 7. SAFETY: refuse impersonation if target schema is malformed.
    //    Catches the known legacy admin@inteletekai.com (string workspaceId,
    //    missing accountType). Sprint 3 will create a clean replacement.
    //    .lean() preserves ObjectId instances — a string-typed workspaceId
    //    fails the instanceof check even if it's a valid 24-char hex.
    const workspaceIdIsObjectId =
      !!target.workspaceId && target.workspaceId instanceof Types.ObjectId;
    if (!workspaceIdIsObjectId || !target.accountType) {
      console.warn(
        `[demo] refused malformed target: userId=${target._id} email=${target.email} ` +
          `workspaceIdType=${typeof target.workspaceId} accountType=${target.accountType ?? "<missing>"}`,
      );
      return res.status(422).json({
        error: "target_data_malformed",
        message: "Target user has incomplete or malformed schema. Cannot impersonate.",
      });
    }

    // 8. Defensive — never propagate SUPERADMIN through impersonation
    const targetRoles: string[] = Array.isArray(target.roles) ? target.roles : [];
    const safeRoles = targetRoles.filter((r) => r !== "SUPERADMIN");
    if (safeRoles.length !== targetRoles.length) {
      console.warn(
        `[demo] stripped SUPERADMIN from target ${target.email} (id=${target._id}) during impersonation`,
      );
    }

    // 9. Token shape depends on target.accountType (audit §4)
    const isCustomer = target.accountType === "CUSTOMER";

    // 10. JTI for correlation between JWT and DemoSession row
    const tokenJti = `demo_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // 11. Mint impersonation token
    const token = signAccessToken({
      userId: String(target._id),
      email: target.email,
      roles: safeRoles,
      workspaceId: isCustomer
        ? undefined
        : (target.workspaceId ? String(target.workspaceId) : undefined),
      customerId: isCustomer && target.customerId ? String(target.customerId) : undefined,
      businessId: isCustomer && target.customerId ? String(target.customerId) : undefined,
      vendorId: undefined,
      customerMemberRole: target.customerMemberRole
        ? String(target.customerMemberRole)
        : undefined,
      isDemoUser: true,
      demoImpersonation: true,
    });

    // 11b. Demo refresh cookie — carries the same impersonation claims so a
    //      proactive /auth/refresh re-mints a demo token instead of reverting
    //      to the rep's real (SUPERADMIN) identity. 2h life bounds the window.
    const demoRefreshToken = signDemoRefresh({
      userId: String(target._id),
      email: target.email,
      roles: safeRoles,
      workspaceId: isCustomer
        ? undefined
        : (target.workspaceId ? String(target.workspaceId) : undefined),
      customerId: isCustomer && target.customerId ? String(target.customerId) : undefined,
      businessId: isCustomer && target.customerId ? String(target.customerId) : undefined,
      vendorId: undefined,
      customerMemberRole: target.customerMemberRole
        ? String(target.customerMemberRole)
        : undefined,
    });
    setDemoRefreshCookie(res, demoRefreshToken);

    // 12. Write audit row
    const session = await DemoSession.create({
      callerUserId: caller._id,
      targetUserId: target._id,
      callerEmail: caller.email,
      targetEmail: target.email,
      customerId: target.customerId ? String(target.customerId) : undefined,
      workspaceId: target.workspaceId ? String(target.workspaceId) : undefined,
      startedAt: new Date(),
      reason: typeof reason === "string" && reason.trim() ? reason.trim() : undefined,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent") || undefined,
      status: "ACTIVE",
      tokenJti,
    });

    // 13. Return — frontend owns the JWT swap; we do NOT setAccessCookie here
    return res.json({
      token,
      sessionId: session._id,
      impersonating: {
        userId: target._id,
        email: target.email,
        name: target.name,
        customerId: target.customerId,
        accountType: target.accountType,
      },
    });
  } catch (err: any) {
    console.error("[demo] start-session failed:", err?.message || err);
    return res.status(500).json({
      error: "internal_error",
      message: "Failed to start demo session.",
    });
  }
});

/* ------------------------------------------------------------------ */
/* POST /end-session                                                  */
/* ------------------------------------------------------------------ */
router.post("/end-session", requireAdmin, async (req: Request, res: Response) => {
  try {
    const { sessionId } = (req.body || {}) as { sessionId?: string };
    if (!sessionId || !isValidObjectId(sessionId)) {
      return res.status(400).json({
        error: "invalid_session_id",
        message: "sessionId must be a valid ObjectId.",
      });
    }

    const session: any = await DemoSession.findById(sessionId);
    if (!session) {
      return res.status(404).json({ error: "session_not_found" });
    }

    // Ownership check — accept either the original caller's JWT OR the
    // impersonation JWT issued from this session. Frontend may send either.
    const reqUser: any = (req as any).user;
    const reqSub = String(reqUser?.sub || "");
    const isImpersonating = reqUser?._demoImpersonation === true;
    const ownerOk = isImpersonating
      ? String(session.targetUserId) === reqSub
      : String(session.callerUserId) === reqSub;
    if (!ownerOk) {
      return res.status(403).json({ error: "not_session_owner" });
    }

    // Demo Platform — clear the impersonation refresh cookie so subsequent
    // /auth/refresh calls fall back to the rep's real refreshToken. Done for
    // any legitimate owner, regardless of current session status.
    clearDemoRefreshCookie(res);

    if (session.status !== "ACTIVE") {
      return res.status(400).json({ error: "already_ended" });
    }

    session.status = "ENDED";
    session.endedAt = new Date();
    session.endedReason = "MANUAL";
    await session.save();

    return res.json({ ended: true });
  } catch (err: any) {
    console.error("[demo] end-session failed:", err?.message || err);
    return res.status(500).json({
      error: "internal_error",
      message: "Failed to end demo session.",
    });
  }
});

/* ------------------------------------------------------------------ */
/* GET /available-seeds                                               */
/* Resolves the caller's demoAccess.mappedSeedUsers into a displayable*/
/* list (email, name, customer name, role) for the top-bar picker.    */
/* ------------------------------------------------------------------ */
router.get("/available-seeds", async (req: Request, res: Response) => {
  try {
    const callerId = (req as any).user?.sub;
    if (!callerId || !Types.ObjectId.isValid(String(callerId))) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const caller: any = await User.findById(callerId).lean();
    if (!caller) return res.status(401).json({ error: "Caller not found" });

    if (!caller.demoAccess?.enabled) {
      return res.status(403).json({ error: "demo_access_not_granted" });
    }

    const mappedIds: any[] = caller.demoAccess.mappedSeedUsers || [];
    if (mappedIds.length === 0) {
      return res.json({ seeds: [] });
    }

    // Find demo users + their customers
    const seedUsers: any[] = await User.find(
      { _id: { $in: mappedIds }, isDemoUser: true },
      { _id: 1, email: 1, name: 1, firstName: 1, lastName: 1, customerId: 1, accountType: 1, roles: 1 },
    ).lean();

    // Resolve customer names (avoid N+1 — single Customer.find)
    const customerIds = [
      ...new Set(seedUsers.map((u: any) => u.customerId).filter(Boolean)),
    ];
    const customers: any[] = await Customer.find(
      { _id: { $in: customerIds } },
      { _id: 1, name: 1 },
    ).lean();
    const customerNameMap = new Map(customers.map((c: any) => [String(c._id), c.name]));

    const seeds = seedUsers.map((u: any) => ({
      userId: String(u._id),
      email: u.email,
      name:
        u.name ||
        `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() ||
        u.email,
      customerId: u.customerId,
      customerName: customerNameMap.get(String(u.customerId)) || "Unknown",
      accountType: u.accountType,
      role:
        (u.roles || []).find((r: string) =>
          ["WORKSPACE_LEADER", "APPROVER", "REQUESTER"].includes(r),
        ) || "REQUESTER",
    }));

    return res.json({ seeds });
  } catch (err: any) {
    console.error("[available-seeds] error", err?.message || err);
    return res.status(500).json({ error: "fetch_failed", message: err?.message });
  }
});

export default router;
