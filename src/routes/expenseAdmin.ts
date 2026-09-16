// apps/backend/src/routes/expenseAdmin.ts
//
// Expense administration — the assignment surface (Phase 1 / Step 3).
//
// A FOCUSED, workspace-scoped, expense-Admin-gated console for two operability
// levers the expense module needs:
//   • EXPENSE CAPABILITIES — add/remove the FINANCE / ADMIN role on a user's
//     User.roles[] (the dedicated finance capability + broad admin).
//   • MANAGER — set User.managerId (the approver-routing source) from a picker
//     of THIS workspace's users; surfaces who has NO manager (the routing gap).
//
// Mounted at /api/expense-admin behind requireAuth + requireWorkspace (server.ts).
//
// TENANT SAFETY (non-negotiable): EVERY user read/write is constrained to
// req.workspaceObjectId. A tenant admin can therefore only ever see/edit users
// in their OWN workspace — never cross-workspace. There is no ?customerId /
// MasterData indirection here (that's the customer-side console); this operates
// directly on workspace Users, mirroring the /users/admin/users/:id/sbt pattern.
//
// Gating: isAdmin() from services/expense.access.ts — the SAME predicate the
// expense routes use, so the broad admin set (incl. TENANT_ADMIN/WORKSPACE_ADMIN)
// can self-serve within their workspace. Does NOT touch sbtRole / CustomerMember.

import express from "express";
import mongoose from "mongoose";
import { isAdmin, isFinance, userIdOf } from "../services/expense.access.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { activeUserFilter } from "../utils/userActiveStatus.js";
import Expense from "../models/Expense.js";
import { getWorkspaceBaseCurrency, normalizeCurrency } from "../services/expenseFx.service.js";

const router = express.Router();

/** Normalize a role token the same way expense.access does (upper + strip sep). */
function normRole(v: any): string {
  return String(v ?? "").trim().toUpperCase().replace(/[\s\-_]/g, "");
}

/** The literal, togglable capability tokens (what we add to / remove from roles[]). */
const FINANCE_TOKEN = "FINANCE";
const ADMIN_TOKEN = "ADMIN";

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

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expense-admin/users
 * Every user in THIS workspace with their expense-capability flags + manager.
 * `finance`/`admin` are the LITERAL togglable tokens on roles[]; `effective*`
 * reflect the full predicate (e.g. an HR/SuperAdmin is an effective admin even
 * without the bare ADMIN token). `noManagerCount` surfaces the routing gap.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/users", async (req: any, res: any) => {
  try {
    const ws = req.workspaceObjectId;
    const docs: any[] = await User.find({ workspaceId: ws, ...activeUserFilter() })
      .select("firstName lastName name email designation department roles managerId managerName reportingL1 status")
      .sort({ name: 1, firstName: 1 })
      .lean();

    // Resolve manager display names from WITHIN the workspace pool only (a
    // manager outside this workspace falls back to the stored managerName so we
    // never read another tenant's user as a side effect).
    const nameById = new Map<string, string>();
    for (const u of docs) nameById.set(String(u._id), employeeNameOf(u));

    const users = docs.map((u: any) => {
      const roles: string[] = Array.isArray(u.roles) ? u.roles : [];
      const normed = roles.map(normRole);
      const managerId = u.managerId ? String(u.managerId) : null;
      return {
        id: String(u._id),
        name: employeeNameOf(u),
        email: u.email || "",
        designation: u.designation || "",
        department: u.department || "",
        roles,
        // Togglable capability state (literal tokens on roles[]):
        finance: normed.includes(FINANCE_TOKEN),
        admin: normed.includes(ADMIN_TOKEN),
        // Effective predicate (broad sets / superadmin flag), for an honest hint
        // when a capability is conferred by another role we don't toggle here.
        effectiveFinance: isFinance(u),
        effectiveAdmin: isAdmin(u),
        managerId,
        managerName: (managerId && nameById.get(managerId)) || u.managerName || u.reportingL1 || "",
        hasManager: !!managerId,
      };
    });

    const noManagerCount = users.filter((u) => !u.hasManager).length;
    res.json({ ok: true, users, total: users.length, noManagerCount });
  } catch (err: any) {
    console.error("[ExpenseAdmin users]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load workspace users" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /api/expense-admin/users/:id/capabilities  { finance?, admin? }
 * Add/remove the FINANCE / ADMIN role on roles[]. Only the keys present are
 * touched. Self-lockout guard: an admin may not strip their OWN admin token.
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
    if (wantFinance === undefined && wantAdmin === undefined) {
      return res.status(400).json({ error: "Nothing to change (pass finance and/or admin)" });
    }

    // Self-lockout guard: never let an admin remove their own ADMIN token.
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
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    const current: string[] = Array.isArray(user.roles) ? user.roles : [];
    // Drop the literal tokens we manage, then re-add per the requested state.
    // Other roles (SUPERADMIN, HR, MANAGER, EMPLOYEE, CUSTOMER, …) are preserved.
    const kept = current.filter((r) => {
      const n = normRole(r);
      if (n === FINANCE_TOKEN) return false;
      if (n === ADMIN_TOKEN) return false;
      return true;
    });

    const next = new Set(kept.map((r) => String(r).toUpperCase()));
    const hasFinanceNow = current.some((r) => normRole(r) === FINANCE_TOKEN);
    const hasAdminNow = current.some((r) => normRole(r) === ADMIN_TOKEN);
    if ((wantFinance === undefined ? hasFinanceNow : wantFinance)) next.add(FINANCE_TOKEN);
    if ((wantAdmin === undefined ? hasAdminNow : wantAdmin)) next.add(ADMIN_TOKEN);

    user.roles = Array.from(next); // schema setter uppercases + defaults to EMPLOYEE if empty
    await user.save();

    const normed = (user.roles as string[]).map(normRole);
    res.json({
      ok: true,
      user: {
        id: String(user._id),
        roles: user.roles,
        finance: normed.includes(FINANCE_TOKEN),
        admin: normed.includes(ADMIN_TOKEN),
        effectiveFinance: isFinance(user),
        effectiveAdmin: isAdmin(user),
      },
    });
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
