// apps/backend/src/routes/holidays.ts
import { Router, Request, Response, NextFunction } from "express";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireRoles } from "../middleware/roles.js";
import Holiday from "../models/Holiday.js";

const router = Router();

// All holiday routes require auth + workspace context
router.use(requireAuth as any);
router.use(requireWorkspace);

/**
 * GET /api/holidays
 *
 * Returns holidays scoped to the current workspace.
 */
router.get(
  "/",
  async (req: any, res: Response, next: NextFunction) => {
    try {
      const docs = await Holiday.find({
        workspaceId: req.workspaceObjectId,
      }).sort({ date: 1 }).lean();

      const items = (docs as any[]).map((h: any) => ({
        _id: String(h._id),
        date: h.date || undefined,
        name: h.name || "Holiday",
        type: h.type || "GENERAL",
        description: h.description || "",
        region: h.region || "All locations / Company-wide",
      }));

      return res.json({ items, source: "db" });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * POST /api/holidays
 *
 * Create a new holiday. Admin/SuperAdmin only.
 */
router.post(
  "/",
  requireRoles("ADMIN", "SUPERADMIN", "HR") as any,
  async (req: any, res: Response, next: NextFunction) => {
    try {
      const { date, name, type, region, description } = req.body || {};

      if (!date || !name) {
        return res
          .status(400)
          .json({ error: "date and name are required" });
      }

      const doc = await Holiday.create({
        date: String(date).slice(0, 10),
        name: String(name).trim(),
        type: type || "GENERAL",
        region: region || "All locations / Company-wide",
        description: description || "",
        workspaceId: req.workspaceObjectId,
      });

      return res.status(201).json({ item: doc.toObject() });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * POST /api/holidays/bulk
 *
 * Bulk upsert holidays from Excel upload. Admin/SuperAdmin only.
 * Upserts by date+name+workspaceId combination.
 */
router.post(
  "/bulk",
  requireRoles("ADMIN", "SUPERADMIN", "HR") as any,
  async (req: any, res: Response, next: NextFunction) => {
    try {
      const { holidays } = req.body || {};

      if (!Array.isArray(holidays) || holidays.length === 0) {
        return res
          .status(400)
          .json({ error: "holidays array is required and must not be empty" });
      }

      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      let inserted = 0;
      let updated = 0;
      const skipped: Array<{
        row: number;
        date: string;
        name: string;
        reason: string;
      }> = [];

      for (let i = 0; i < holidays.length; i++) {
        const h = holidays[i];
        const rowNum = i + 1;
        const date = String(h.date || "").trim().slice(0, 10);
        const name = String(h.name || "").trim();

        // Validate date
        if (!date || !DATE_RE.test(date)) {
          skipped.push({
            row: rowNum,
            date,
            name,
            reason: "Invalid date format (expected YYYY-MM-DD)",
          });
          continue;
        }

        // Validate date is a real date
        const parsed = new Date(date + "T00:00:00Z");
        if (isNaN(parsed.getTime())) {
          skipped.push({
            row: rowNum,
            date,
            name,
            reason: "Invalid date value",
          });
          continue;
        }

        // Validate name
        if (!name) {
          skipped.push({
            row: rowNum,
            date,
            name,
            reason: "Holiday name is required",
          });
          continue;
        }

        // Normalize type
        const rawType = String(h.type || "General")
          .toUpperCase()
          .trim();
        const type =
          rawType === "OPTIONAL" ? "OPTIONAL" : "GENERAL";

        const region =
          String(h.location || h.region || "")
            .trim() || "All locations / Company-wide";

        const description = [
          String(h.shortNote || "").trim(),
          String(h.description || "").trim(),
        ]
          .filter(Boolean)
          .join(" ");

        // Upsert by date + name + workspaceId
        const existing = await Holiday.findOne({ date, name, workspaceId: req.workspaceObjectId }).lean();
        await Holiday.findOneAndUpdate(
          { date, name, workspaceId: req.workspaceObjectId },
          { date, name, type, region, description, workspaceId: req.workspaceObjectId },
          { upsert: true, new: true },
        );

        if (existing) {
          updated++;
        } else {
          inserted++;
        }
      }

      return res.json({ ok: true, inserted, updated, skipped });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * PUT /api/holidays/:id
 *
 * Update an existing holiday. Admin/SuperAdmin only.
 */
router.put(
  "/:id",
  requireRoles("ADMIN", "SUPERADMIN", "HR") as any,
  async (req: any, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { date, name, type, region, description } = req.body || {};

      if (!date || !name) {
        return res
          .status(400)
          .json({ error: "date and name are required" });
      }

      const doc = await Holiday.findOneAndUpdate(
        { _id: id, workspaceId: req.workspaceObjectId },
        {
          date: String(date).slice(0, 10),
          name: String(name).trim(),
          type: type || "GENERAL",
          region: region || "All locations / Company-wide",
          description: description || "",
        },
        { new: true },
      ).lean();

      if (!doc) {
        return res.status(404).json({ error: "Holiday not found" });
      }

      return res.json({ item: doc });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * DELETE /api/holidays/:id
 *
 * Delete a holiday. Admin/SuperAdmin only.
 */
router.delete(
  "/:id",
  requireRoles("ADMIN", "SUPERADMIN", "HR") as any,
  async (req: any, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const doc = await Holiday.findOneAndDelete({
        _id: id,
        workspaceId: req.workspaceObjectId,
      }).lean();

      if (!doc) {
        return res.status(404).json({ error: "Holiday not found" });
      }

      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
