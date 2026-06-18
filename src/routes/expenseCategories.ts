// apps/backend/src/routes/expenseCategories.ts
//
// Expense Categories — Layer 1. Tenant-scoped managed category list backing the
// Expense module. Mounted at /api/expense-categories behind requireAuth +
// requireWorkspace (see server.ts).
//
// Scoping discipline (NON-NEGOTIABLE): EVERY query stamps workspaceId explicitly
// — the workspaceScope plugin is not ambient, so a missing workspaceId is a
// cross-tenant leak. req.workspaceObjectId is the single tenant key here.

import express from "express";
import mongoose from "mongoose";
import { requireAdmin } from "../middleware/rbac.js";
import ExpenseCategory from "../models/ExpenseCategory.js";
import { seedDefaultCategories } from "../services/expenseCategories.service.js";

const router = express.Router();

// Lazy-seed defaults (first GET for a workspace with none). The default list +
// seed now live in services/expenseCategories.service.ts so the WhatsApp worker
// shares them — see seedDefaultCategories.

/* ── Admin predicate (mirrors requireAdmin role set, as a boolean) ───── */
function norm(v: any) {
  return String(v ?? "").trim().toUpperCase().replace(/[\s\-_]/g, "");
}
const ADMIN_ROLES = [
  "ADMIN", "SUPERADMIN", "SUPER_ADMIN", "HR", "HR_ADMIN",
  "OPS", "OPS_ADMIN", "TENANT_ADMIN", "WORKSPACE_ADMIN",
].map(norm);
function isAdminReq(req: any): boolean {
  const u = req.user || {};
  const signals: any[] = [];
  if (Array.isArray(u.roles)) signals.push(...u.roles);
  if (u.role) signals.push(u.role);
  if (u.userType) signals.push(u.userType);
  if (u.accountType) signals.push(u.accountType);
  if (u.hrmsAccessRole) signals.push(u.hrmsAccessRole);
  if (u.hrmsAccessLevel) signals.push(u.hrmsAccessLevel);
  return signals.map(norm).some((r) => ADMIN_ROLES.includes(r));
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expense-categories
 * Workspace-scoped, sorted. Lazy-seeds 10 defaults when the workspace has none.
 * ?all=1 (admin only) includes inactive categories; everyone else: active only.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/", async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    if (!workspaceId) return res.status(400).json({ error: "Missing workspace context" });

    const count = await ExpenseCategory.countDocuments({ workspaceId });
    if (count === 0) await seedDefaultCategories(workspaceId);

    const filter: Record<string, any> = { workspaceId }; // explicit tenant scope
    const includeInactive = String(req.query.all || "") === "1" && isAdminReq(req);
    if (!includeInactive) filter.active = true;

    const categories = await ExpenseCategory.find(filter)
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    res.json({ ok: true, categories });
  } catch (err: any) {
    console.error("[ExpenseCategories GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to list categories" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-categories  (admin)
 * ───────────────────────────────────────────────────────────────────── */
router.post("/", requireAdmin, async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    if (!workspaceId) return res.status(400).json({ error: "Missing workspace context" });

    const b = req.body || {};
    const name = String(b.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });

    // Dup check is per-tenant (unique index also enforces it at the DB).
    const existing = await ExpenseCategory.findOne({ workspaceId, name }).lean();
    if (existing) return res.status(409).json({ error: "A category with this name already exists" });

    const category = await ExpenseCategory.create({
      workspaceId, // explicit tenant scope
      name,
      glCode: b.glCode ? String(b.glCode).trim() : null,
      sortOrder: Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : 0,
      active: true,
      isDefault: false,
    });

    res.status(201).json({ ok: true, category });
  } catch (err: any) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: "A category with this name already exists" });
    }
    console.error("[ExpenseCategories POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to create category" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /api/expense-categories/:id  (admin)
 * Rename / glCode / sortOrder / active toggle. NO hard delete (soft via active).
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/:id", requireAdmin, async (req: any, res: any) => {
  try {
    const workspaceId = req.workspaceObjectId;
    if (!workspaceId) return res.status(400).json({ error: "Missing workspace context" });

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: "Category not found" });
    }

    const b = req.body || {};
    const update: Record<string, any> = {};
    if (typeof b.name === "string" && b.name.trim()) update.name = b.name.trim();
    if (b.glCode !== undefined) update.glCode = b.glCode ? String(b.glCode).trim() : null;
    if (b.sortOrder !== undefined && Number.isFinite(Number(b.sortOrder))) {
      update.sortOrder = Number(b.sortOrder);
    }
    if (b.active !== undefined) update.active = !!b.active;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    // Scoped find: _id AND workspaceId — an admin can only touch their tenant.
    const category = await ExpenseCategory.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(id), workspaceId },
      { $set: update },
      { new: true, runValidators: true },
    ).lean();

    if (!category) return res.status(404).json({ error: "Category not found" });

    res.json({ ok: true, category });
  } catch (err: any) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: "A category with this name already exists" });
    }
    console.error("[ExpenseCategories PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update category" });
  }
});

export default router;
