// apps/backend/src/routes/billingPermissions.ts
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import BillingPermission from "../models/BillingPermission.js";
import User from "../models/User.js";
import logger from "../utils/logger.js";

const router = express.Router();

/* ── GET /api/billing-permissions/my-access ─────────────────────────────
   Accessible to ALL authenticated users — not super admin only.
   Super admin gets { all: true }.
   Others get boolean flags per page.
*/
router.get("/my-access", requireAuth, async (req: any, res: any) => {
  try {
    if (isSuperAdmin(req)) {
      return res.json({ all: true });
    }

    const userId = String(req.user._id || req.user.id || req.user.sub || "");
    if (!userId) {
      return res.json({ manualBookings: false, invoices: false, reports: false, companySettings: false });
    }

    const doc = await BillingPermission.findOne({ userId }).lean();

    if (!doc) {
      return res.json({ manualBookings: false, invoices: false, reports: false, companySettings: false });
    }

    const pages: string[] = Array.isArray(doc.pages) ? doc.pages : [];
    return res.json({
      manualBookings: pages.includes("manualBookings"),
      invoices: pages.includes("invoices"),
      reports: pages.includes("reports"),
      companySettings: pages.includes("companySettings"),
    });
  } catch (err: any) {
    logger.error("[BILLING_ACCESS] my-access error", { error: err.message });
    return res.status(500).json({ success: false, message: "Error fetching access" });
  }
});

/* ── All remaining routes — super admin only ─────────────────────────── */
router.use(requireAuth, requireSuperAdmin);

/* POST /api/billing-permissions/grant */
router.post("/grant", async (req: any, res: any) => {
  try {
    const { userId, email, workspaceId, pages } = req.body;

    if (!email || !workspaceId || !Array.isArray(pages)) {
      return res.status(400).json({ success: false, message: "email, workspaceId and pages[] are required" });
    }

    const normalizedEmail = String(email).toLowerCase();

    // Resolve the canonical User._id — guards against Employee _id or email being passed as userId
    const orClauses: object[] = [
      { email: normalizedEmail },
      { officialEmail: normalizedEmail },
    ];
    if (userId) orClauses.unshift({ _id: userId });

    const userDoc = await (User as any).findOne({ $or: orClauses }).lean();

    if (!userDoc) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const resolvedUserId = String(userDoc._id);

    // Migration: remove any stale doc stored under the wrong userId for this email
    await BillingPermission.deleteMany({ email: normalizedEmail, userId: { $ne: resolvedUserId } });

    const doc = await BillingPermission.findOneAndUpdate(
      { userId: resolvedUserId },
      {
        $set: {
          email: normalizedEmail,
          workspaceId: String(workspaceId),
          pages,
          grantedBy: String(req.user._id || req.user.id || req.user.sub),
          grantedAt: new Date(),
        },
      },
      { new: true, upsert: true }
    );

    logger.info(`[BILLING_ACCESS] GRANT ${email} → ${pages.join(",")} by ${req.user.email}`);
    return res.json({ success: true, doc });
  } catch (err: any) {
    logger.error("[BILLING_ACCESS] grant error", { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* POST /api/billing-permissions/revoke */
router.post("/revoke", async (req: any, res: any) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, message: "userId is required" });
    }

    const existing = await BillingPermission.findOne({ userId: String(userId) }).lean();
    const email = existing?.email || userId;

    await BillingPermission.deleteOne({ userId: String(userId) });

    logger.info(`[BILLING_ACCESS] REVOKE ${email} by ${req.user.email}`);
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("[BILLING_ACCESS] revoke error", { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* PATCH /api/billing-permissions/update */
router.patch("/update", async (req: any, res: any) => {
  try {
    const { userId, pages } = req.body;

    if (!userId || !Array.isArray(pages)) {
      return res.status(400).json({ success: false, message: "userId and pages[] are required" });
    }

    const doc = await BillingPermission.findOneAndUpdate(
      { userId: String(userId) },
      {
        $set: {
          pages,
          updatedBy: String(req.user._id || req.user.id || req.user.sub),
          updatedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!doc) {
      return res.status(404).json({ success: false, message: "Grant not found" });
    }

    logger.info(`[BILLING_ACCESS] UPDATE ${doc.email} → ${pages.join(",")} by ${req.user.email}`);
    return res.json({ success: true, doc });
  } catch (err: any) {
    logger.error("[BILLING_ACCESS] update error", { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* GET /api/billing-permissions/search-users */
router.get("/search-users", async (req: any, res: any) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q || q.length < 2) return res.json({ users: [] });

    const re = new RegExp(q, "i");
    const users = await (User as any)
      .find(
        { $or: [{ email: re }, { name: re }, { officialEmail: re }] },
        { _id: 1, name: 1, email: 1, officialEmail: 1 }
      )
      .limit(20)
      .lean();

    return res.json({
      users: users.map((u: any) => ({ ...u, userId: String(u._id) })),
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* GET /api/billing-permissions/list */
router.get("/list", async (req: any, res: any) => {
  try {
    const filter: Record<string, any> = {};
    if (req.query.workspaceId) filter.workspaceId = req.query.workspaceId;

    const docs = await BillingPermission.find(filter).sort({ grantedAt: -1 }).lean();

    // Populate display names from User collection where possible
    const userIds = docs.map((d) => d.userId).filter(Boolean);
    let userMap: Record<string, string> = {};
    if (userIds.length > 0) {
      const users = await (User as any)
        .find({ _id: { $in: userIds } }, { _id: 1, name: 1, email: 1 })
        .lean();
      for (const u of users) {
        userMap[String(u._id)] = u.name || u.email || "";
      }
    }

    const enriched = docs.map((d) => ({
      ...d,
      displayName: userMap[d.userId] || "",
    }));

    return res.json({ success: true, docs: enriched });
  } catch (err: any) {
    logger.error("[BILLING_ACCESS] list error", { error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
