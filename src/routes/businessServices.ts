// apps/backend/src/routes/businessServices.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import mongoose from "mongoose";
import ServiceCapability from "../models/ServiceCapability.js";
import { Onboarding } from "../models/Onboarding.js";
import { isHouseUser } from "../middleware/requirePlatformAdmin.js";

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
  if (!currentUser._demoImpersonation && (upper.includes("SUPERADMIN") || upper.includes("SUPER_ADMIN"))) return true;
  // Vendor / business capabilities are Plumtrips' records: a customer
  // company's own ADMIN cannot edit them.
  if (!isHouseUser(currentUser)) return false;
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
 * Every ownerId a business's mappings may be stored under. Business Profiles
 * used to key an onboarding-sourced business by its invite token (the
 * master-data list returned it); the list no longer exposes tokens, so the
 * page now sends the onboarding _id — rows saved under the token stay found.
 */
async function ownerAliases(ownerId: string): Promise<string[]> {
  const ids = [String(ownerId)];
  if (mongoose.isValidObjectId(ownerId)) {
    const ob: any = await Onboarding.findById(ownerId).select("token").lean();
    if (ob?.token) ids.push(String(ob.token));
  }
  return ids;
}

/**
 * GET /api/business-services/:ownerId
 * List all service mappings for a business customer.
 */
router.get("/:ownerId", requireAuth, async (req, res, next) => {
  try {
    const { ownerId } = req.params;
    const items = await ServiceCapability.find({
      ownerType: "BUSINESS",
      ownerId: { $in: await ownerAliases(String(ownerId)) },
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

    // Update the row already stored under an alias (token) instead of
    // creating a second one for the same kind.
    const existing: any = await ServiceCapability.findOne({
      ownerType: "BUSINESS",
      ownerId: { $in: await ownerAliases(String(ownerId)) },
      kind: String(kind),
    })
      .select("_id")
      .lean();
    const doc = await ServiceCapability.findOneAndUpdate(
      existing
        ? { _id: existing._id }
        : {
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
        ownerId: { $in: await ownerAliases(String(ownerId)) },
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
