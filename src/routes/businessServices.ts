// apps/backend/src/routes/businessServices.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import ServiceCapability from "../models/ServiceCapability.js";

const router = Router();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isHrmsAdmin(currentUser: any): boolean {
  if (!currentUser) return false;
  const roles: string[] = [];

  if (Array.isArray(currentUser.roles)) roles.push(...currentUser.roles);
  if (currentUser.role) roles.push(currentUser.role);
  if (currentUser.hrmsAccessLevel) roles.push(currentUser.hrmsAccessLevel);
  if (currentUser.hrmsAccessRole) roles.push(currentUser.hrmsAccessRole);

  const upper = roles.map((r) => String(r).toUpperCase());
  return (
    upper.includes("ADMIN") ||
    upper.includes("SUPER_ADMIN") ||
    upper.includes("SUPERADMIN") ||
    upper.includes("HR_ADMIN")
  );
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/business-services/:ownerId
 * List all service mappings for a business customer.
 */
router.get("/:ownerId", requireAuth, async (req, res, next) => {
  try {
    const { ownerId } = req.params;
    const items = await ServiceCapability.find({
      ownerType: "BUSINESS",
      ownerId: String(ownerId),
    })
      .sort({ kind: 1 })
      .lean()
      .exec();

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/business-services/:ownerId
 * Create or upsert a mapping for a given service kind.
 */
router.post("/:ownerId", requireAuth, async (req: any, res, next) => {
  try {
    if (!isHrmsAdmin(req.user)) {
      return res.status(403).json({
        error: "Only HR / Admin / Super Admin can modify business services",
      });
    }

    const { ownerId } = req.params;
    const { kind, enabled, meta } = req.body || {};

    if (!kind) {
      return res.status(400).json({ error: "Service kind is required" });
    }

    const doc = await ServiceCapability.findOneAndUpdate(
      {
        ownerType: "BUSINESS",
        ownerId: String(ownerId),
        kind: String(kind),
      },
      {
        $set: {
          enabled: enabled !== false,
          ...(meta ? { meta } : {}),
        },
      },
      {
        new: true,
        upsert: true,
      },
    ).exec();

    res.json(doc);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/business-services/:ownerId/:id
 * Update an existing mapping (toggle enabled, update meta, etc.).
 */
router.patch("/:ownerId/:id", requireAuth, async (req: any, res, next) => {
  try {
    if (!isHrmsAdmin(req.user)) {
      return res.status(403).json({
        error: "Only HR / Admin / Super Admin can modify business services",
      });
    }

    const { ownerId, id } = req.params;
    const { enabled, meta } = req.body || {};

    const update: any = {};
    if (typeof enabled !== "undefined") update.enabled = !!enabled;
    if (typeof meta !== "undefined") update.meta = meta;

    const doc = await ServiceCapability.findOneAndUpdate(
      {
        _id: id,
        ownerType: "BUSINESS",
        ownerId: String(ownerId),
      },
      { $set: update },
      { new: true },
    ).exec();

    if (!doc) {
      return res
        .status(404)
        .json({ error: "Business service mapping not found" });
    }

    res.json(doc);
  } catch (err) {
    next(err);
  }
});

export default router;
