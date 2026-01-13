// apps/backend/src/routes/vendors.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import MasterData from "../models/MasterData.js";

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

function buildVendorQueryFromUser(user: any) {
  const email = String(
    user?.officialEmail || user?.email || user?.sub || ""
  )
    .toLowerCase()
    .trim();

  const ownerId = String(user?.sub || user?.id || "").trim();

  const base: any = {
    type: "Vendor",
  };

  const or: any[] = [];

  if (email) {
    or.push(
      { email },
      { officialEmail: email },
      { "payload.email": email },
      { "payload.officialEmail": email },
      { "payload.contact.email": email }
    );
  }

  if (ownerId) {
    or.push({ ownerId }, { "payload.ownerId": ownerId });
  }

  if (or.length > 0) {
    base.$or = or;
  }

  return { base, hasMatchKeys: or.length > 0 };
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/vendors/me
 * Resolve the vendor record linked to the current user.
 * - Vendor login: matches by email / ownerId.
 * - HR/Admin: if not found, returns the most recently updated Vendor as preview.
 * - Never returns 404; instead { vendor: null }.
 */
router.get("/me", requireAuth, async (req: any, res, next) => {
  try {
    const { base, hasMatchKeys } = buildVendorQueryFromUser(req.user || {});
    let doc = null;

    if (hasMatchKeys) {
      doc = await MasterData.findOne(base).lean().exec();
    }

    // Admin / HR preview fallback – pick any vendor if user is HR/admin.
    if (!doc && isHrmsAdmin(req.user)) {
      doc = await MasterData.findOne({ type: "Vendor" })
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean()
        .exec();
    }

    if (!doc) {
      return res.json({ vendor: null });
    }

    return res.json({ vendor: doc });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/vendors/:id
 * Simple fetch by master-data id (used by admin screens if needed).
 */
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const doc = await MasterData.findOne({ _id: id, type: "Vendor" })
      .lean()
      .exec();

    if (!doc) {
      return res.status(404).json({ error: "Vendor profile not found" });
    }

    res.json({ vendor: doc });
  } catch (err) {
    next(err);
  }
});

export default router;
