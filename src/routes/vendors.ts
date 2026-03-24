// apps/backend/src/routes/vendors.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import MasterData from "../models/MasterData.js";
import Vendor from "../models/Vendor.js";

const router = Router();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function upperRoles(user: any): string[] {
  const roles: string[] = [];
  if (!user) return roles;

  if (Array.isArray(user.roles)) roles.push(...user.roles);
  if (user.role) roles.push(user.role);
  if (user.hrmsAccessLevel) roles.push(user.hrmsAccessLevel);
  if (user.hrmsAccessRole) roles.push(user.hrmsAccessRole);
  if (user.accountType) roles.push(user.accountType);
  if (user.userType) roles.push(user.userType);

  return roles.map((r) => String(r).toUpperCase()).filter(Boolean);
}

function isHrmsAdmin(user: any): boolean {
  const r = upperRoles(user);
  return (
    r.includes("ADMIN") ||
    r.includes("SUPER_ADMIN") ||
    r.includes("SUPERADMIN") ||
    r.includes("HR_ADMIN") ||
    r.includes("HR")
  );
}

function isVendorUser(user: any): boolean {
  const r = upperRoles(user);
  return r.includes("VENDOR");
}

function normEmail(v: any): string {
  return String(v || "").trim().toLowerCase();
}

function buildKeysFromUser(user: any) {
  const emails = [user?.officialEmail, user?.email]
    .filter(Boolean)
    .map(normEmail)
    .filter(Boolean);

  const ownerId = String(user?.sub || user?.id || "").trim();
  const vendorId = String(user?.vendorId || "").trim();

  return { emails, ownerId, vendorId };
}

function buildMasterDataQuery(emails: string[], ownerId: string) {
  const base: any = { type: "Vendor" };
  const or: any[] = [];

  for (const email of emails) {
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

  if (or.length > 0) base.$or = or;

  return { query: base, hasMatchKeys: or.length > 0 };
}

function buildVendorCollectionQuery(emails: string[], ownerId: string) {
  const or: any[] = [];

  for (const email of emails) {
    // some deployments store vendor emails as email or officialEmail
    or.push({ email }, { officialEmail: email });
  }

  // Vendor.ownerId is ObjectId; mongoose will cast if ownerId looks valid.
  if (ownerId) or.push({ ownerId });

  if (or.length === 0) return { query: null, hasMatchKeys: false };
  return { query: { $or: or }, hasMatchKeys: true };
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/vendors/me
 *
 * ✅ Vendor user:
 *  - Resolve ONLY from Vendor collection
 *  - Never leak MasterData vendor profiles
 *
 * ✅ Admin/HR:
 *  - Resolve from vendorId (JWT) OR MasterData(type=Vendor) OR Vendor collection
 *  - Preview fallback allowed (latest MasterData Vendor)
 *
 * Never 404; returns { vendor: null } when not found.
 */
router.get("/me", requireAuth, async (req: any, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    const user = req.user || {};
    const { emails, ownerId, vendorId } = buildKeysFromUser(user);

    // 0) vendorId from JWT is most deterministic
    if (vendorId) {
      const v = await Vendor.findById(vendorId).lean().exec();
      if (v) return res.json({ vendor: v });
      // fall through if stale
    }

    // Vendor login: ONLY Vendor collection lookup
    if (isVendorUser(user)) {
      if (emails.length === 0 && !ownerId) return res.json({ vendor: null });

      const { query: vQuery, hasMatchKeys: vHasKeys } = buildVendorCollectionQuery(
        emails,
        ownerId
      );

      if (!vHasKeys || !vQuery) return res.json({ vendor: null });

      const v = await Vendor.findOne(vQuery).lean().exec();
      return res.json({ vendor: v || null });
    }

    // Admin/HR path
    if (emails.length === 0 && !ownerId) {
      // if no keys and admin, allow preview fallback
      if (isHrmsAdmin(user)) {
        const preview = await MasterData.findOne({ type: "Vendor" })
          .sort({ updatedAt: -1, createdAt: -1 })
          .lean()
          .exec();
        return res.json({ vendor: preview || null });
      }
      return res.json({ vendor: null });
    }

    let doc: any = null;

    // 1) MasterData first for admin workflows
    const { query: mdQuery, hasMatchKeys: mdHasKeys } = buildMasterDataQuery(
      emails,
      ownerId
    );
    if (mdHasKeys) {
      doc = await MasterData.findOne(mdQuery).lean().exec();
    }

    // 2) fallback to Vendor collection
    if (!doc) {
      const { query: vQuery, hasMatchKeys: vHasKeys } = buildVendorCollectionQuery(
        emails,
        ownerId
      );
      if (vHasKeys && vQuery) {
        doc = await Vendor.findOne(vQuery).lean().exec();
      }
    }

    // 3) preview fallback for admin
    if (!doc && isHrmsAdmin(user)) {
      doc = await MasterData.findOne({ type: "Vendor" })
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean()
        .exec();
    }

    return res.json({ vendor: doc || null });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/vendors/:id
 *
 * ✅ Admin/HR only.
 * Vendor users are forbidden.
 */
router.get("/:id", requireAuth, async (req: any, res, next) => {
  try {
    const user = req.user || {};

    // Vendor should never be able to fetch arbitrary vendor by id
    if (isVendorUser(user) && !isHrmsAdmin(user)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { id } = req.params;

    // Try MasterData
    let doc: any = await MasterData.findOne({ _id: id, type: "Vendor" })
      .lean()
      .exec();
    if (doc) return res.json({ vendor: doc });

    // Fallback to Vendor collection
    doc = await Vendor.findOne({ _id: id }).lean().exec();
    if (doc) return res.json({ vendor: doc });

    return res.status(404).json({ error: "Vendor profile not found" });
  } catch (err) {
    next(err);
  }
});

export default router;
