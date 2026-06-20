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
import ExpenseCategory from "../models/ExpenseCategory.js";
import { seedDefaultCategories } from "../services/expenseCategories.service.js";
import { isAdmin } from "../services/expense.access.js";

const router = express.Router();

// Lazy-seed defaults (first GET for a workspace with none). The default list +
// seed now live in services/expenseCategories.service.ts so the WhatsApp worker
// shares them — see seedDefaultCategories.

/* ── Expense-admin gate ───────────────────────────────────────────────────
 * Category management is gated by the EXPENSE-LOCAL isAdmin() (expense.access.ts)
 * — the SAME predicate the Team/policy surface (expenseAdmin.ts) uses — NOT the
 * platform-wide requireAdmin (middleware/rbac.ts). Deliberate: it keeps category
 * management in lock-step with the rest of the expense module (so WORKSPACE_LEADER,
 * now a full expense-admin for THEIR OWN workspace, can manage categories) WITHOUT
 * elevating workspace leaders on any platform requireAdmin surface. Tenant scoping
 * (req.workspaceObjectId on every query) confines that authority to own workspace.
 * The previous local ADMIN_ROLES copy is gone — isAdmin() is the single source. */
function requireExpenseAdmin(req: any, res: any, next: any) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: "Admin access required" });
  }
  return next();
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
    const includeInactive = String(req.query.all || "") === "1" && isAdmin(req.user);
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
router.post("/", requireExpenseAdmin, async (req: any, res: any) => {
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
router.patch("/:id", requireExpenseAdmin, async (req: any, res: any) => {
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
