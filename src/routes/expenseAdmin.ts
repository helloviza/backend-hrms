// apps/backend/src/routes/expenseAdmin.ts
//
// Expense administration — the assignment surface.
//
// A FOCUSED, workspace-scoped, expense-Admin-gated console for the operability
// levers the expense module needs:
//   • EXPENSE CAPABILITIES — finance / expense-admin / approver flag / personal
//     limit / department scope, held in the per-person GRANT store
//     (models/ExpenseApproverGrant.ts). Since approval-engine sub-step 1
//     (2026-09-16) this NEVER writes User.roles[]: the old behaviour wrote the
//     literal platform `ADMIN` (audit F-01, Red — a customer WORKSPACE_LEADER
//     could mint platform admin) and `FINANCE` tokens, which AccessConsole
//     level changes then wiped (F-21).
//   • MANAGER — set User.managerId (the approver-routing source) from a picker
//     of THIS workspace's users; surfaces who has NO manager (the routing gap).
//   • POLICY — base currency + the (legacy) escalation scalars.
//
// Mounted at /api/expense-admin behind requireAuth + requireWorkspace +
// attachExpenseGrant (server.ts).
//
// TENANT SAFETY (non-negotiable): EVERY user read/write is constrained to
// req.workspaceObjectId. A tenant admin can therefore only ever see/edit users
// in their OWN workspace — never cross-workspace.
//
// Gating: isAdmin() from services/expense.access.ts — the SAME predicate the
// expense routes use (structural workspace roles OR an expenseAdmin grant).

import express from "express";
import mongoose from "mongoose";
import { isAdmin, isFinance, userIdOf } from "../services/expense.access.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Department from "../models/Department.js";
import { activeUserFilter } from "../utils/userActiveStatus.js";
import Expense from "../models/Expense.js";
import { getWorkspaceBaseCurrency, normalizeCurrency } from "../services/expenseFx.service.js";
import {
  grantsByUserId,
  resolveDepartmentIds,
  upsertGrant,
  grantView,
} from "../services/expenseGrants.service.js";
import {
  RANKS,
  getRankTable,
  setRankRow,
  getEffectiveLimitForUser,
  getEffectiveLimitsForUsers,
  effectiveApprovalLimit,
  type EffectiveLimit,
} from "../services/expenseAuthority.service.js";
import CustomerMember from "../models/CustomerMember.js";
import ExpenseCategory from "../models/ExpenseCategory.js";
import { getPolicy, updatePolicy, validatePolicyPatch } from "../services/expensePolicy.service.js";
import { routeClaim } from "../services/expenseRouting.service.js";
import { buildRoutingInput } from "../services/expenseRoutingInput.service.js";

const router = express.Router();

function employeeNameOf(u: any): string {
  if (!u || typeof u !== "object") return "";
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return full || u.name || u.email || "";
}

/* ── Router-level gate: expense Admin within the workspace ─────────────── */
router.use((req: any, res: any, next: any) => {
  if (!req.workspaceObjectId) {
    return res.status(400).json({ error: "Workspace context required" });
  }
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Expense admin access required" });
  }
  return next();
});

/** One user row for the Team page: identity + manager + the grant view + the
 *  resolved approval limit (sub-step 3). */
function teamRow(
  u: any,
  grant: ReturnType<typeof grantView>,
  nameById: Map<string, string>,
  limit?: EffectiveLimit | null,
) {
  const managerId = u.managerId ? String(u.managerId) : null;
  const withGrant = { ...u, expenseGrant: grant };
  return {
    // ── Authority (sub-step 3): rank + resolved limit, base currency ──
    bandNumber: u.bandNumber ?? null,
    rankLabel: limit?.rankLabel ?? null,
    rankDefaultLimitBase: limit?.rankDefaultLimitBase ?? null,
    effectiveLimitBase: limit?.effectiveLimitBase ?? 0,
    limitSource: limit?.limitSource ?? "none",
    id: String(u._id),
    name: employeeNameOf(u),
    email: u.email || "",
    designation: u.designation || "",
    department: u.department || "",
    roles: Array.isArray(u.roles) ? u.roles : [],
    // Togglable capability state — from the GRANT store, never roles[].
    finance: !!grant?.finance,
    admin: !!grant?.expenseAdmin,
    approver: !!grant?.approver,
    limitBase: grant?.limitBase ?? null,
    departmentIds: grant?.departmentIds ?? [],
    // Effective predicate (structural roles / superadmin flag / grant), for an
    // honest hint when a capability is conferred by a role we don't toggle here.
    effectiveFinance: isFinance(withGrant),
    effectiveAdmin: isAdmin(withGrant),
    managerId,
    managerName: (managerId && nameById.get(managerId)) || u.managerName || u.reportingL1 || "",
    hasManager: !!managerId,
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expense-admin/users
 * Every user in THIS workspace with their expense capabilities (grant) +
 * manager. Also returns the workspace's active departments for the scope
 * picker. `noManagerCount` surfaces the routing gap.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/users", async (req: any, res: any) => {
  try {
    const ws = req.workspaceObjectId;
    const docs: any[] = await User.find({ workspaceId: ws, ...activeUserFilter() })
      .select(
        "firstName lastName name email designation department roles role userType accountType hrmsAccessRole hrmsAccessLevel isSuperAdmin managerId managerName reportingL1 status bandNumber",
      )
      .sort({ name: 1, firstName: 1 })
      .lean();

    const [grants, departments, limits, ranks, baseCurrency] = await Promise.all([
      grantsByUserId(ws, docs.map((u) => u._id)),
      Department.find({ workspaceId: ws, isActive: true }).select("_id name code").sort({ name: 1 }).lean(),
      getEffectiveLimitsForUsers(ws, docs),
      getRankTable(ws),
      getWorkspaceBaseCurrency(ws),
    ]);

    // Resolve manager display names from WITHIN the workspace pool only.
    const nameById = new Map<string, string>();
    for (const u of docs) nameById.set(String(u._id), employeeNameOf(u));

    const users = docs.map((u: any) => teamRow(u, grants.get(String(u._id)) ?? null, nameById, limits.get(String(u._id))));
    const noManagerCount = users.filter((u) => !u.hasManager).length;
    res.json({
      ok: true,
      users,
      total: users.length,
      noManagerCount,
      departments: departments.map((d: any) => ({ id: String(d._id), name: d.name, code: d.code || "" })),
      ranks,
      baseCurrency,
    });
  } catch (err: any) {
    console.error("[ExpenseAdmin users]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load workspace users" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /api/expense-admin/users/:id/capabilities
 *   { finance?, admin?, approver?, limitBase?, departmentIds? }
 * Upserts the user's GRANT. Only the keys present are touched; every change
 * is appended to the grant's history with the actor. Self-lockout guard: an
 * admin may not strip their OWN expense-admin capability. Nothing here
 * touches User.roles[] — a grant confers nothing outside the expense module.
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/users/:id/capabilities", async (req: any, res: any) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: "User not found" });
    }

    const b = req.body || {};
    const wantFinance = "finance" in b ? !!b.finance : undefined;
    const wantAdmin = "admin" in b ? !!b.admin : undefined;
    const wantApprover = "approver" in b ? !!b.approver : undefined;
    let wantLimit: number | null | undefined = undefined;
    if ("limitBase" in b) {
      if (b.limitBase === null || b.limitBase === undefined || String(b.limitBase).trim() === "") {
        wantLimit = null;
      } else {
        const n = Number(b.limitBase);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ error: "limitBase must be a non-negative number, or null to clear." });
        }
        wantLimit = n;
      }
    }
    const dept = await resolveDepartmentIds(req.workspaceObjectId, "departmentIds" in b ? b.departmentIds : undefined);
    if (dept.error) return res.status(400).json({ error: dept.error });

    if (
      wantFinance === undefined &&
      wantAdmin === undefined &&
      wantApprover === undefined &&
      wantLimit === undefined &&
      dept.value === undefined
    ) {
      return res.status(400).json({
        error: "Nothing to change (pass finance, admin, approver, limitBase and/or departmentIds)",
      });
    }

    // Self-lockout guard: never let an admin remove their own expense-admin capability.
    if (wantAdmin === false && userIdOf(req.user) === String(id)) {
      return res.status(403).json({
        error: "You can't remove your own Admin capability. Ask another admin.",
        code: "SELF_DEMOTION_DENIED",
      });
    }

    // Tenant scope: the target MUST be in the actor's workspace.
    const user: any = await User.findOne({
      _id: new mongoose.Types.ObjectId(id),
      workspaceId: req.workspaceObjectId,
    })
      .select(
        "firstName lastName name email designation department roles role userType accountType hrmsAccessRole hrmsAccessLevel isSuperAdmin managerId managerName reportingL1",
      )
      .lean();
    if (!user) return res.status(404).json({ error: "User not found" });

    const grant = await upsertGrant({
      workspaceId: req.workspaceObjectId,
      userId: user._id,
      actorId: userIdOf(req.user),
      patch: {
        finance: wantFinance,
        expenseAdmin: wantAdmin,
        approver: wantApprover,
        limitBase: wantLimit,
        departmentObjectIds: dept.value,
      },
    });

    const view = grantView(grant.toObject());
    const nameById = new Map<string, string>();
    const rankTable = await getRankTable(req.workspaceObjectId);
    const limit = effectiveApprovalLimit({ bandNumber: (user as any).bandNumber ?? null, rankTable, grant: view });
    res.json({ ok: true, user: teamRow(user, view, nameById, limit) });
  } catch (err: any) {
    console.error("[ExpenseAdmin capabilities]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update capabilities" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * RANK DEFAULTS + PER-PERSON LIMITS (approval-engine sub-step 3)
 *
 * GET  /api/expense-admin/ranks                — the 10-row rank table
 * PUT  /api/expense-admin/ranks/:bandNumber    — { label?, defaultApprovalLimitBase? }
 * PUT  /api/expense-admin/ranks                — { ranks: [{ bandNumber, label?, defaultApprovalLimitBase? }] }
 * PATCH /api/expense-admin/users/:id/rank      — { bandNumber: 1..10 | null }
 * GET  /api/expense-admin/users/:id/authority  — the resolved effective limit
 *
 * All behind the router-level isAdmin() gate (structural workspace roles —
 * incl. WORKSPACE_LEADER — or an expenseAdmin grant): "admin / leadership"
 * per D6. Limits are in the workspace base currency. The table ships EMPTY.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/ranks", async (req: any, res: any) => {
  try {
    const [ranks, baseCurrency] = await Promise.all([
      getRankTable(req.workspaceObjectId),
      getWorkspaceBaseCurrency(req.workspaceObjectId),
    ]);
    res.json({ ok: true, ranks, baseCurrency });
  } catch (err: any) {
    console.error("[ExpenseAdmin ranks GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load ranks" });
  }
});

// Flat shape (this package compiles with strictNullChecks:false, where a
// boolean-literal discriminant does not narrow): branch on `ok`, read `error`.
function parseRankPatch(b: any): { ok: boolean; error?: string; label?: string | null; limit?: number | null } {
  const out: { ok: boolean; error?: string; label?: string | null; limit?: number | null } = { ok: true };
  if ("label" in (b || {})) {
    const l = b.label == null ? "" : String(b.label).trim();
    if (l.length > 60) return { ok: false, error: "label must be 60 characters or fewer" };
    out.label = l;
  }
  if ("defaultApprovalLimitBase" in (b || {})) {
    const raw = b.defaultApprovalLimitBase;
    if (raw === null || raw === undefined || String(raw).trim() === "") {
      out.limit = null;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: "defaultApprovalLimitBase must be a non-negative number, or null to clear" };
      out.limit = n;
    }
  }
  return out;
}

router.put("/ranks/:bandNumber", async (req: any, res: any) => {
  try {
    const n = parseInt(String(req.params.bandNumber), 10);
    if (!RANKS.includes(n as any)) return res.status(400).json({ error: "bandNumber must be 1-10" });
    const p = parseRankPatch(req.body);
    if (!p.ok) return res.status(400).json({ error: p.error });
    if (p.label === undefined && p.limit === undefined) {
      return res.status(400).json({ error: "Nothing to change (pass label and/or defaultApprovalLimitBase)" });
    }
    const row = await setRankRow({
      workspaceId: req.workspaceObjectId,
      bandNumber: n,
      label: p.label,
      defaultApprovalLimitBase: p.limit,
    });
    res.json({ ok: true, rank: row, baseCurrency: await getWorkspaceBaseCurrency(req.workspaceObjectId) });
  } catch (err: any) {
    console.error("[ExpenseAdmin ranks PUT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update rank" });
  }
});

router.put("/ranks", async (req: any, res: any) => {
  try {
    const list = Array.isArray(req.body?.ranks) ? req.body.ranks : null;
    if (!list || list.length === 0) return res.status(400).json({ error: "ranks[] is required" });
    // Validate everything first — an all-or-nothing table write.
    const parsed: { n: number; label?: string | null; limit?: number | null }[] = [];
    for (const item of list) {
      const n = parseInt(String(item?.bandNumber), 10);
      if (!RANKS.includes(n as any)) return res.status(400).json({ error: `bandNumber must be 1-10 (got ${item?.bandNumber})` });
      const p = parseRankPatch(item);
      if (!p.ok) return res.status(400).json({ error: `Rank ${n}: ${p.error}` });
      parsed.push({ n, label: p.label, limit: p.limit });
    }
    for (const p of parsed) {
      await setRankRow({ workspaceId: req.workspaceObjectId, bandNumber: p.n, label: p.label, defaultApprovalLimitBase: p.limit });
    }
    res.json({ ok: true, ranks: await getRankTable(req.workspaceObjectId), baseCurrency: await getWorkspaceBaseCurrency(req.workspaceObjectId) });
  } catch (err: any) {
    console.error("[ExpenseAdmin ranks bulk PUT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update ranks" });
  }
});

router.patch("/users/:id/rank", async (req: any, res: any) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ error: "User not found" });
    const raw = req.body?.bandNumber;
    let bandNumber: number | null = null;
    if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
      const n = Number(raw);
      if (!Number.isInteger(n) || !RANKS.includes(n as any)) return res.status(400).json({ error: "bandNumber must be an integer 1-10, or null" });
      bandNumber = n;
    }
    const user: any = await User.findOne({ _id: new mongoose.Types.ObjectId(id), workspaceId: req.workspaceObjectId })
      .select("email customerId bandNumber")
      .lean();
    if (!user) return res.status(404).json({ error: "User not found" });

    await User.updateOne({ _id: user._id }, { $set: { bandNumber } });
    // Mirror to CustomerMember exactly as routes/expenseBands.ts does (same
    // customerId + email key) so the two writers never disagree.
    const customerId = req.workspace?.customerId || user.customerId;
    if (customerId && user.email) {
      await CustomerMember.findOneAndUpdate({ customerId, email: user.email }, { $set: { bandNumber } });
    }
    const authority = await getEffectiveLimitForUser(req.workspaceObjectId, user._id);
    res.json({ ok: true, user: { id: String(user._id), bandNumber }, authority });
  } catch (err: any) {
    console.error("[ExpenseAdmin rank PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to set rank" });
  }
});

router.get("/users/:id/authority", async (req: any, res: any) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ error: "User not found" });
    const exists = await User.exists({ _id: new mongoose.Types.ObjectId(id), workspaceId: req.workspaceObjectId });
    if (!exists) return res.status(404).json({ error: "User not found" });
    const authority = await getEffectiveLimitForUser(req.workspaceObjectId, id);
    res.json({ ok: true, userId: id, authority, baseCurrency: await getWorkspaceBaseCurrency(req.workspaceObjectId) });
  } catch (err: any) {
    console.error("[ExpenseAdmin authority GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to resolve authority" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /api/expense-admin/users/:id/manager  { managerId: string | null }
 * Set (or clear) User.managerId — the approver-routing source. The manager must
 * be another user in THIS workspace; null/"" clears it. Mirrors the
 * managerId + managerName + reportingL1 trio the create flow writes.
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/users/:id/manager", async (req: any, res: any) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: "User not found" });
    }

    const user: any = await User.findOne({
      _id: new mongoose.Types.ObjectId(id),
      workspaceId: req.workspaceObjectId,
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    const raw = req.body?.managerId;
    const clearing = raw === null || raw === undefined || String(raw).trim() === "";

    if (clearing) {
      user.managerId = null;
      user.managerName = "";
      user.reportingL1 = "";
      await user.save();
      return res.json({ ok: true, user: { id: String(user._id), managerId: null, managerName: "", hasManager: false } });
    }

    const mid = String(raw);
    if (!mongoose.Types.ObjectId.isValid(mid)) {
      return res.status(400).json({ error: "Invalid managerId" });
    }
    if (mid === String(id)) {
      return res.status(400).json({ error: "A user can't be their own manager." });
    }

    // The manager MUST be a user in the same workspace (never cross-workspace).
    const mgr: any = await User.findOne({
      _id: new mongoose.Types.ObjectId(mid),
      workspaceId: req.workspaceObjectId,
    })
      .select("firstName lastName name email")
      .lean();
    if (!mgr) return res.status(400).json({ error: "Manager must be a user in this workspace." });

    user.managerId = mgr._id;
    user.managerName = employeeNameOf(mgr);
    user.reportingL1 = String(mgr.email || "").trim().toLowerCase();
    await user.save();

    res.json({
      ok: true,
      user: {
        id: String(user._id),
        managerId: String(mgr._id),
        managerName: user.managerName,
        hasManager: true,
      },
    });
  } catch (err: any) {
    console.error("[ExpenseAdmin manager]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update manager" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expense-admin/policy
 * The Team page's settings block: base currency + the LEGACY escalation
 * scalars (expenseEscalationThreshold / advanceEscalationThreshold /
 * seniorApproverId). Since approval-engine sub-step 4 those three live on
 * the ExpenseApprovalPolicy document (legacyEscalation), NOT on
 * CustomerWorkspace.config — one settings home. The response keys are kept
 * so the existing Team page works unchanged.
 * ───────────────────────────────────────────────────────────────────── */
async function legacyPolicyView(workspaceId: any) {
  const [pol, baseCurrency, expenseCount] = await Promise.all([
    getPolicy(workspaceId),
    getWorkspaceBaseCurrency(workspaceId),
    Expense.countDocuments({ workspaceId }),
  ]);
  return {
    baseCurrency,
    baseCurrencyLocked: expenseCount > 0,
    expenseEscalationThreshold: pol.legacyEscalation.claimThresholdBase,
    seniorApproverId: pol.legacyEscalation.seniorApproverId,
    advanceEscalationThreshold: pol.legacyEscalation.advanceThresholdBase,
    policyVersion: pol.version,
    engineEnabled: pol.engineEnabled,
  };
}

router.get("/policy", async (req: any, res: any) => {
  try {
    res.json({ ok: true, policy: await legacyPolicyView(req.workspaceObjectId) });
  } catch (err: any) {
    console.error("[ExpenseAdmin policy GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load policy" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /api/expense-admin/policy
 *   { baseCurrency?, expenseEscalationThreshold?, advanceEscalationThreshold?, seniorApproverId? }
 * Only the keys present are touched. baseCurrency stays on the workspace
 * (locked once expenses exist); the three legacy scalars are written to the
 * policy document's legacyEscalation block.
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/policy", async (req: any, res: any) => {
  try {
    const b = req.body || {};

    if ("baseCurrency" in b) {
      const next = normalizeCurrency(b.baseCurrency);
      if (!next) {
        return res.status(400).json({ error: "baseCurrency must be a 3-letter ISO code (e.g. INR, USD)." });
      }
      const current = await getWorkspaceBaseCurrency(req.workspaceObjectId);
      if (next !== current) {
        const n = await Expense.countDocuments({ workspaceId: req.workspaceObjectId });
        if (n > 0) {
          return res.status(409).json({
            error: `Base currency is locked at ${current}: this workspace already has ${n} expense${n === 1 ? "" : "s"} converted into it.`,
            code: "BASE_CURRENCY_LOCKED",
          });
        }
        await CustomerWorkspace.updateOne({ _id: req.workspaceObjectId }, { $set: { "config.baseCurrency": next } });
      }
    }

    const legacy: Record<string, any> = {};
    if ("expenseEscalationThreshold" in b) legacy.claimThresholdBase = b.expenseEscalationThreshold;
    if ("advanceEscalationThreshold" in b) legacy.advanceThresholdBase = b.advanceEscalationThreshold;
    if ("seniorApproverId" in b) legacy.seniorApproverId = b.seniorApproverId;

    if (Object.keys(legacy).length === 0 && !("baseCurrency" in b)) {
      return res.status(400).json({
        error: "Nothing to change (pass baseCurrency, expenseEscalationThreshold, advanceEscalationThreshold and/or seniorApproverId).",
      });
    }
    if (Object.keys(legacy).length > 0) {
      const errors = await validatePolicyPatch(req.workspaceObjectId, { legacyEscalation: legacy });
      if (errors.length) return res.status(400).json({ error: errors[0], errors });
      await updatePolicy({ workspaceId: req.workspaceObjectId, patch: { legacyEscalation: legacy }, actorId: userIdOf(req.user) });
    }
    res.json({ ok: true, policy: await legacyPolicyView(req.workspaceObjectId) });
  } catch (err: any) {
    console.error("[ExpenseAdmin policy PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update policy" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * THE RULEBOOK (approval-engine sub-step 4)
 *
 * GET  /api/expense-admin/approval-policy   — the full policy (defaults when none)
 * PUT  /api/expense-admin/approval-policy   — partial update; validated against
 *                                             THIS workspace's categories/users
 * POST /api/expense-admin/approval-policy/simulate — "test a claim": pure
 *      what-if through the SAME routeClaim() the live engine will use.
 *      Creates and submits NOTHING.
 *
 * Admin / leadership gated (router-level isAdmin). Amounts in base currency.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/approval-policy", async (req: any, res: any) => {
  try {
    const [policy, baseCurrency, categories] = await Promise.all([
      getPolicy(req.workspaceObjectId),
      getWorkspaceBaseCurrency(req.workspaceObjectId),
      ExpenseCategory.find({ workspaceId: req.workspaceObjectId }).select("_id name active").sort({ name: 1 }).lean(),
    ]);
    res.json({
      ok: true,
      policy,
      baseCurrency,
      categories: categories.map((c: any) => ({ id: String(c._id), name: c.name, active: c.active !== false })),
    });
  } catch (err: any) {
    console.error("[ExpenseAdmin approval-policy GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load approval policy" });
  }
});

router.put("/approval-policy", async (req: any, res: any) => {
  try {
    const patch = req.body || {};
    const allowed = ["engineEnabled", "bot", "managerAllowance", "categoryRules", "departmentScopeEnforced", "topOfChain", "firstStep", "legacyEscalation"];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (keys.length === 0) return res.status(400).json({ error: `Nothing to change (pass any of ${allowed.join(", ")})` });
    const errors = await validatePolicyPatch(req.workspaceObjectId, patch);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    const policy = await updatePolicy({ workspaceId: req.workspaceObjectId, patch, actorId: userIdOf(req.user) });
    res.json({ ok: true, policy, baseCurrency: await getWorkspaceBaseCurrency(req.workspaceObjectId) });
  } catch (err: any) {
    console.error("[ExpenseAdmin approval-policy PUT]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update approval policy" });
  }
});

router.post("/approval-policy/simulate", async (req: any, res: any) => {
  try {
    const b = req.body || {};
    const built = await buildRoutingInput({
      workspaceId: req.workspaceObjectId,
      kind: b.kind === "advance" ? "advance" : "claim",
      reportId: b.reportId ? String(b.reportId) : undefined,
      submitterId: b.submitterId ? String(b.submitterId) : undefined,
      amountBase: b.amountBase != null ? Number(b.amountBase) : undefined,
      categoryIds: Array.isArray(b.categoryIds) ? b.categoryIds.map(String) : undefined,
      departmentId: b.departmentId === null ? null : b.departmentId ? String(b.departmentId) : undefined,
      checks: b.checks && typeof b.checks === "object" ? b.checks : undefined,
    });
    if (built.error) return res.status(built.status || 400).json({ error: built.error });
    const decision = routeClaim(built.input!);
    res.json({
      ok: true,
      simulated: true, // nothing was created, submitted or routed
      input: built.summary,
      decision,
    });
  } catch (err: any) {
    console.error("[ExpenseAdmin simulate]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to simulate" });
  }
});

export default router;
