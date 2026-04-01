// apps/backend/src/routes/customers.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireRoles } from "../middleware/roles.js";
import Customer from "../models/Customer.js";
import Vendor from "../models/Vendor.js";
import User from "../models/User.js";
import Employee from "../models/Employee.js";
import { scopedFindById } from "../middleware/scopedFindById.js";

const router = Router();

router.get("/", requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const docs = await Customer.find({})
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    res.json({
      items: docs.map((c: any) => ({
        id: String(c._id),
        name: c.name,
        email: c.email,
        type: "Business",
        status: c.status || "ACTIVE",
        isActive: c.status !== "INACTIVE",
        customerCode: c.customerCode,
        onboardingId: c.onboardingId,
        updatedAt: c.updatedAt,
        submittedAt: c.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/customers/admin/all
 * Admin: list all customers + vendors with accountTeam info.
 */
router.get(
  "/admin/all",
  requireAuth,
  requireRoles("ADMIN", "SUPERADMIN") as any,
  async (_req, res, next) => {
    try {
      const customers = await Customer.find({}).sort({ updatedAt: -1 }).lean().exec();
      const vendors = await Vendor.find({}).sort({ updatedAt: -1 }).lean().exec();

      const items = [
        ...customers.map((c: any) => ({
          id: String(c._id),
          name: c.name || c.legalName || "",
          email: c.email || "",
          type: "Customer" as const,
          status: c.status || "ACTIVE",
          accountTeam: c.accountTeam || null,
        })),
        ...vendors.map((v: any) => ({
          id: String(v._id),
          name: v.name || "",
          email: v.email || "",
          type: "Vendor" as const,
          status: v.status || "NEW",
          accountTeam: v.accountTeam || null,
        })),
      ];

      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/customers/account-team
 * Returns the account team for the calling customer/vendor user.
 */
router.get("/account-team", requireAuth, async (req: any, res, next) => {
  try {
    const user = req.user || {};
    const customerId = user.customerId || user.businessId;
    const email = (user.email || "").toLowerCase();

    // Try Customer first
    let record: any = null;
    if (customerId) {
      record = await Customer.findById(customerId).lean().exec();
    }
    if (!record && email) {
      record = await Customer.findOne({ email }).lean().exec();
    }
    // Try Vendor
    if (!record && customerId) {
      record = await Vendor.findById(customerId).lean().exec();
    }
    if (!record && email) {
      record = await Vendor.findOne({ email }).lean().exec();
    }

    if (!record) {
      return res.json({ accountTeam: null });
    }

    res.json({ accountTeam: record.accountTeam || null });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/customers/:id/account-team
 * Admin assigns account team members to a customer or vendor.
 */
router.patch(
  "/:id/account-team",
  requireAuth,
  requireWorkspace,
  requireRoles("ADMIN", "SUPERADMIN", "HR") as any,
  async (req: any, res, next) => {
    try {
      const { id } = req.params;
      const { accountManager, escalationManager, supportContact } =
        req.body || {};

      async function resolveContact(input: any) {
        if (!input?.userId) return null;

        // 1. Try User collection directly (in case a User _id was passed)
        let u: any = await User.findOne({ _id: input.userId, workspaceId: req.workspaceObjectId })
          .select("name fullName firstName lastName email phone mobile contactNo personalContact")
          .lean()
          .exec();

        // 2. If not found, try Employee collection → then find linked User by email
        if (!u) {
          const emp: any = await Employee.findOne({ _id: input.userId, workspaceId: req.workspaceObjectId })
            .select("email officialEmail companyEmail")
            .lean()
            .exec();
          if (emp) {
            const empEmail = (emp.officialEmail || emp.companyEmail || emp.email || "").toLowerCase();
            if (empEmail) {
              u = await User.findOne({ email: empEmail })
                .select("name fullName firstName lastName email phone mobile contactNo personalContact")
                .lean()
                .exec();
            }
          }
        }

        if (!u) return null;

        return {
          userId: u._id,
          name:
            u.name ||
            u.fullName ||
            [u.firstName, u.lastName].filter(Boolean).join(" ") ||
            "",
          email: u.email || "",
          phone: u.phone || u.mobile || u.contactNo || u.personalContact || "",
        };
      }

      const team: any = {};
      if (accountManager) team.accountManager = await resolveContact(accountManager);
      if (escalationManager) team.escalationManager = await resolveContact(escalationManager);
      if (supportContact) team.supportContact = await resolveContact(supportContact);

      // Try Customer
      let doc: any = await Customer.findByIdAndUpdate(
        id,
        { $set: { accountTeam: team } },
        { new: true },
      )
        .lean()
        .exec();

      // Fallback to Vendor
      if (!doc) {
        doc = await Vendor.findByIdAndUpdate(
          id,
          { $set: { accountTeam: team } },
          { new: true },
        )
          .lean()
          .exec();
      }

      if (!doc) {
        return res.status(404).json({ error: "Customer/Vendor not found" });
      }

      res.json({ ok: true, accountTeam: (doc as any).accountTeam });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
