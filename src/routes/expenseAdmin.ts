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

/** One user row for the Team page: identity + manager + the grant view. */
function teamRow(u: any, grant: ReturnType<typeof grantView>, nameById: Map<string, string>) {
  const managerId = u.managerId ? String(u.managerId) : null;
  const withGrant = { ...u, expenseGrant: grant };
  return {
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
        "firstName lastName name email designation department roles role userType accountType hrmsAccessRole hrmsAccessLevel isSuperAdmin managerId managerName reportingL1 status",
      )
      .sort({ name: 1, firstName: 1 })
      .lean();

    const [grants, departments] = await Promise.all([
      grantsByUserId(ws, docs.map((u) => u._id)),
      Department.find({ workspaceId: ws, isActive: true }).select("_id name code").sort({ name: 1 }).lean(),
    ]);

    // Resolve manager display names from WITHIN the workspace pool only.
    const nameById = new Map<string, string>();
    for (const u of docs) nameById.set(String(u._id), employeeNameOf(u));

    const users = docs.map((u: any) => teamRow(u, grants.get(String(u._id)) ?? null, nameById));
    const noManagerCount = users.filter((u) => !u.hasManager).length;
    res.json({
      ok: true,
      users,
      total: users.length,
      noManagerCount,
      departments: departments.map((d: any) => ({ id: String(d._id), name: d.name, code: d.code || "" })),
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
    res.json({ ok: true, user: teamRow(user, view, nameById) });
  } catch (err: any) {
    console.error("[ExpenseAdmin capabilities]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update capabilities" });
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
 * The workspace's expense approval-escalation policy (Phase 2). null threshold
 * = OFF (single-approver). Workspace-scoped; isAdmin gate (router-level).
 * ───────────────────────────────────────────────────────────────────── */
router.get("/policy", async (req: any, res: any) => {
  try {
    const ws: any = await CustomerWorkspace.findById(req.workspaceObjectId)
      .select("config.expenseEscalationThreshold config.seniorApproverId config.advanceEscalationThreshold")
      .lean();
    // baseCurrency (slice 0) is the unit of both thresholds below. It can only
    // be changed while the workspace has no expenses (see PATCH), so the
    // response also says whether it is still editable.
    const baseCurrency = await getWorkspaceBaseCurrency(req.workspaceObjectId);
    const expenseCount = await Expense.countDocuments({ workspaceId: req.workspaceObjectId });
    res.json({
      ok: true,
      policy: {
        baseCurrency,
        baseCurrencyLocked: expenseCount > 0,
        expenseEscalationThreshold: ws?.config?.expenseEscalationThreshold ?? null,
        seniorApproverId: ws?.config?.seniorApproverId ? String(ws.config.seniorApproverId) : null,
        advanceEscalationThreshold: ws?.config?.advanceEscalationThreshold ?? null,
      },
    });
  } catch (err: any) {
    console.error("[ExpenseAdmin policy GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load policy" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /api/expense-admin/policy  { expenseEscalationThreshold?, seniorApproverId? }
 * Only the keys present are touched. Threshold: a non-negative number, or
 * null/"" to turn escalation OFF. seniorApproverId: a user in THIS workspace,
 * or null/"" to clear. Workspace-scoped; isAdmin gate (router-level).
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/policy", async (req: any, res: any) => {
  try {
    const b = req.body || {};
    const update: Record<string, any> = {};

    // Base currency (slice 0): ISO-4217, and ONLY while no expense exists —
    // every stored amountBase is frozen in the old base, so a later switch
    // would silently mis-state every total. Not a migration path; a workspace
    // that needs to change base after capturing expenses is a separate task.
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
        update["config.baseCurrency"] = next;
      }
    }

    if ("expenseEscalationThreshold" in b) {
      const raw = b.expenseEscalationThreshold;
      if (raw === null || raw === undefined || String(raw).trim() === "") {
        update["config.expenseEscalationThreshold"] = null; // OFF
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          return res
            .status(400)
            .json({ error: "expenseEscalationThreshold must be a non-negative number, or null to disable." });
        }
        update["config.expenseEscalationThreshold"] = n;
      }
    }

    if ("advanceEscalationThreshold" in b) {
      const raw = b.advanceEscalationThreshold;
      if (raw === null || raw === undefined || String(raw).trim() === "") {
        update["config.advanceEscalationThreshold"] = null; // OFF
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          return res
            .status(400)
            .json({ error: "advanceEscalationThreshold must be a non-negative number, or null to disable." });
        }
        update["config.advanceEscalationThreshold"] = n;
      }
    }

    if ("seniorApproverId" in b) {
      const raw = b.seniorApproverId;
      if (raw === null || raw === undefined || String(raw).trim() === "") {
        update["config.seniorApproverId"] = null;
      } else {
        if (!mongoose.Types.ObjectId.isValid(String(raw))) {
          return res.status(400).json({ error: "Invalid seniorApproverId" });
        }
        // Must be a user in THIS workspace (never cross-workspace).
        const u: any = await User.findOne({
          _id: new mongoose.Types.ObjectId(String(raw)),
          workspaceId: req.workspaceObjectId,
        })
          .select("_id")
          .lean();
        if (!u) return res.status(400).json({ error: "Senior approver must be a user in this workspace." });
        update["config.seniorApproverId"] = u._id;
      }
    }

    if (Object.keys(update).length === 0) {
      // A baseCurrency equal to the current one is a legitimate no-op PATCH.
      if (!("baseCurrency" in b)) {
        return res.status(400).json({
          error:
            "Nothing to change (pass baseCurrency, expenseEscalationThreshold, advanceEscalationThreshold and/or seniorApproverId).",
        });
      }
    }

    const ws: any = Object.keys(update).length
      ? await CustomerWorkspace.findOneAndUpdate(
          { _id: req.workspaceObjectId },
          { $set: update },
          { new: true },
        )
          .select("config.expenseEscalationThreshold config.seniorApproverId config.advanceEscalationThreshold config.baseCurrency")
          .lean()
      : await CustomerWorkspace.findById(req.workspaceObjectId)
          .select("config.expenseEscalationThreshold config.seniorApproverId config.advanceEscalationThreshold config.baseCurrency")
          .lean();
    if (!ws) return res.status(404).json({ error: "Workspace not found" });

    res.json({
      ok: true,
      policy: {
        baseCurrency: normalizeCurrency(ws?.config?.baseCurrency) || "INR",
        baseCurrencyLocked: (await Expense.countDocuments({ workspaceId: req.workspaceObjectId })) > 0,
        expenseEscalationThreshold: ws?.config?.expenseEscalationThreshold ?? null,
        seniorApproverId: ws?.config?.seniorApproverId ? String(ws.config.seniorApproverId) : null,
        advanceEscalationThreshold: ws?.config?.advanceEscalationThreshold ?? null,
      },
    });
  } catch (err: any) {
    console.error("[ExpenseAdmin policy PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update policy" });
  }
});

export default router;
