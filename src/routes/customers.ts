// apps/backend/src/routes/customers.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireRoles } from "../middleware/roles.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import Customer from "../models/Customer.js";
import Vendor from "../models/Vendor.js";
import User from "../models/User.js";
import Employee from "../models/Employee.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import { validateObjectId } from "../middleware/validateObjectId.js";

const router = Router();

router.get("/", requireAuth, requireWorkspace, requireAdmin, async (_req: any, res, next) => {
  try {
    const custFilter = isSuperAdmin(_req) ? {} : { workspaceId: _req.workspaceObjectId };
    const docs = await Customer.find(custFilter)
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
        phone: c.phone || c.mobile || "",
        mobile: c.mobile || "",
        gstNumber: c.gstNumber || "",
        legalName: c.legalName || c.name,
        website: c.website || "",
        address: c.address || {},
        subType: c.subType || "",
        source: c.source || "",
        workspaceId: c.workspaceId || "",
        customerType: c.customerType || "BUSINESS",
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
  requireWorkspace,
  requireRoles("ADMIN", "SUPERADMIN") as any,
  async (_req: any, res, next) => {
    try {
      const allFilter = isSuperAdmin(_req) ? {} : { workspaceId: _req.workspaceObjectId };
      const customers = await Customer.find(allFilter).sort({ updatedAt: -1 }).lean().exec();
      const vendors = await Vendor.find(allFilter).sort({ updatedAt: -1 }).lean().exec();

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
 * GET /api/customers/workspace-members
 * Returns all users in the same customer workspace (same customerId).
 */
router.get("/workspace-members", requireAuth, async (req: any, res) => {
  try {
    const userId = String(req.user._id || req.user.id);
    const user = await User.findById(userId, "customerId workspaceId").lean() as any;

    if (!user?.customerId) {
      return res.json({ ok: true, members: [] });
    }

    const members = await User.find(
      { customerId: user.customerId, isActive: { $ne: false } },
      "name firstName lastName email roles customerMemberRole bandNumber",
    ).lean();

    const mapped = (members as any[]).map((m) => ({
      userId: String(m._id),
      name:
        m.name ||
        `${m.firstName || ""} ${m.lastName || ""}`.trim() ||
        m.email,
      email: m.email,
      role: m.customerMemberRole || m.roles?.[0] || "Member",
      bandNumber: m.bandNumber ?? null,
    }));

    return res.json({ ok: true, members: mapped });
  } catch {
    return res.status(500).json({ error: "Failed to fetch members" });
  }
});

/**
 * GET /api/customers/:id
 * Returns the full Customer document by _id, scoped to the workspace.
 * No role check — a CUSTOMER user needs to read their own record.
 * Workspace scope is sufficient isolation.
 */
router.get("/:id", validateObjectId("id"), requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    const wsId = String(req.workspaceObjectId);
    const customer = await Customer.findOne({ _id: req.params.id, workspaceId: wsId }).lean().exec();
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    return res.json({ ok: true, customer });
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
  validateObjectId("id"),
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

      // Try Customer (workspace-scoped)
      const acctQuery: any = { _id: id };
      if (!isSuperAdmin(req) && req.workspaceObjectId) acctQuery.workspaceId = req.workspaceObjectId;

      let doc: any = await Customer.findOneAndUpdate(
        acctQuery,
        { $set: { accountTeam: team } },
        { new: true },
      )
        .lean()
        .exec();

      // Fallback to Vendor
      if (!doc) {
        doc = await Vendor.findOneAndUpdate(
          acctQuery,
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

// ── PATCH /api/customers/:id ─────────────────────────────────────────────────
// Generic field update for Zoho-imported business records (no onboarding doc).
router.patch(
  "/:id",
  validateObjectId("id"),
  requireAuth,
  requireWorkspace,
  requireRoles("ADMIN", "SUPERADMIN", "HR") as any,
  async (req: any, res, next) => {
    try {
      const { id } = req.params;
      const wsId = String(req.workspaceObjectId);

      const updated = await Customer.findOneAndUpdate(
        { _id: id, workspaceId: wsId },
        { $set: { ...req.body, updatedAt: new Date() } },
        { new: true },
      ).lean();

      if (!updated) {
        return res.status(404).json({ error: "Customer not found" });
      }

      // Sync to Onboarding formPayload if onboardingId exists
      if ((updated as any).onboardingId) {
        try {
          const syncFields: Record<string, any> = {};

          // Legal name — sent as name/companyName
          if (req.body.companyName !== undefined || req.body.name !== undefined) {
            syncFields["formPayload.legalName"] = req.body.companyName || req.body.name;
          }

          // GST — sent as gstin
          if (req.body.gstin !== undefined) {
            syncFields["formPayload.gstNumber"] = req.body.gstin;
          }

          // PAN — sent as pan
          if (req.body.pan !== undefined) {
            syncFields["formPayload.panNumber"] = req.body.pan;
          }

          // Direct field mappings (same name)
          const directFields = [
            "registeredAddress",
            "entityType",
            "industry",
            "website",
            "employeesCount",
            "incorporationDate",
            "description",
            "officialEmail",
          ];
          directFields.forEach((f) => {
            if (req.body[f] !== undefined) {
              syncFields[`formPayload.${f}`] = req.body[f];
            }
          });

          // Bank — sent as flat fields
          if (req.body.bankName !== undefined) {
            syncFields["formPayload.bank.bankName"] = req.body.bankName;
          }
          if (req.body.bankAccountNumber !== undefined) {
            syncFields["formPayload.bank.accountNumber"] = req.body.bankAccountNumber;
          }
          if (req.body.bankIfsc !== undefined) {
            syncFields["formPayload.bank.ifsc"] = req.body.bankIfsc;
          }
          if (req.body.bankBranch !== undefined) {
            syncFields["formPayload.bank.branch"] = req.body.bankBranch;
          }

          if (Object.keys(syncFields).length > 0) {
            const { default: Onboarding } = await import("../models/Onboarding.js");
            await Onboarding.findByIdAndUpdate((updated as any).onboardingId, { $set: syncFields });
            console.log(
              "[PATCH /customers/:id] synced",
              Object.keys(syncFields).length,
              "fields to Onboarding",
              (updated as any).onboardingId,
            );
          }
        } catch (err) {
          console.error("[PATCH /customers/:id] onboarding sync failed:", err);
        }
      }

      return res.json({ ok: true, customer: updated });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
