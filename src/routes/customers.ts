// apps/backend/src/routes/customers.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { requireWorkspace, isCustomerUser } from "../middleware/requireWorkspace.js";
import { requireRoles } from "../middleware/roles.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import Customer from "../models/Customer.js";
import Vendor from "../models/Vendor.js";
import User from "../models/User.js";
import Employee from "../models/Employee.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import { validateObjectId } from "../middleware/validateObjectId.js";
import { getCompanySettings } from "../models/CompanySettings.js";
import { getCustomerMemberRoleMap, resolveMemberRole } from "../utils/customerMemberRoles.js";

const router = Router();

/**
 * Top-level Customer schema path names (e.g. "address.street" → "address"),
 * computed once. Used to reject any PATCH body key that doesn't map to
 * anything the schema knows about — Mongoose's default strict mode silently
 * deletes such keys during $set casting (verified against
 * node_modules/mongoose/lib/helpers/query/castUpdate.js), which is exactly
 * how CIN, the four flat bank fields, and several aliases were discarded on
 * save while the endpoint still reported success. See
 * docs/audits/business-form-persistence-audit.md.
 */
const CUSTOMER_TOP_LEVEL_SCHEMA_KEYS = new Set(
  Object.keys(Customer.schema.paths).map((p) => p.split(".")[0]),
);

function findUnrecognizedCustomerFields(body: Record<string, any>): string[] {
  return Object.keys(body || {}).filter((k) => !CUSTOMER_TOP_LEVEL_SCHEMA_KEYS.has(k));
}

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
      "name firstName lastName email roles role bandNumber",
    ).lean();

    // CustomerMember.role, not the nonexistent User.customerMemberRole —
    // see utils/customerMemberRoles.ts for why. Same helper Workspace
    // Permissions uses, so the two screens can't show different roles for
    // the same member again.
    const roleMap = await getCustomerMemberRoleMap(String(user.customerId));

    const mapped = (members as any[]).map((m) => ({
      userId: String(m._id),
      name:
        m.name ||
        `${m.firstName || ""} ${m.lastName || ""}`.trim() ||
        m.email,
      email: m.email,
      role: resolveMemberRole(roleMap, m.email, m.roles, m.role),
      bandNumber: m.bandNumber ?? null,
    }));

    return res.json({ ok: true, members: mapped });
  } catch {
    return res.status(500).json({ error: "Failed to fetch members" });
  }
});

/**
 * GET /api/customers/:id
 * Returns the full Customer document by _id.
 * No role check — a CUSTOMER user needs to read their own record.
 *
 * Scope is resolved the same way resolveWorkspaceForUser does it (see
 * requireWorkspace.ts): staff/admin/SUPERADMIN may load ANY customer record
 * (they already effectively could, since every staff caller happened to
 * resolve to the same internal workspace as most Customer.workspaceId values —
 * this just makes that explicit instead of accidental). A customer-portal
 * user may load ONLY their own record, resolved from their JWT customerId —
 * NOT by comparing against the target document's Customer.workspaceId field,
 * which is unreliable (see docs/audits/company-data-mismatch-audit.md) and
 * is exactly what caused this to silently 404 for real customers while
 * looking fine to staff.
 */
router.get("/:id", validateObjectId("id"), requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    const { id } = req.params;
    const user = req.user;

    if (!isSuperAdmin(req) && isCustomerUser(user)) {
      const ownCustomerId = String(user?.customerId ?? user?.businessId ?? "");
      if (!ownCustomerId || ownCustomerId !== String(id)) {
        return res.status(404).json({ error: "Customer not found" });
      }
    }

    const customer = await Customer.findOne({ _id: id }).lean().exec();
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
// requireRoles below already restricts this handler to staff (ADMIN/SUPERADMIN/HR) —
// no CUSTOMER-portal caller can ever reach it. Staff may edit ANY customer record
// (same "staff = platform-wide" scope as GET /:id above), so the update is no
// longer additionally scoped by the target document's (unreliable) workspaceId
// field — see docs/audits/company-data-mismatch-audit.md for why that equality
// check only ever "worked" by accident.
router.patch(
  "/:id",
  validateObjectId("id"),
  requireAuth,
  requireWorkspace,
  requireRoles("ADMIN", "SUPERADMIN", "HR") as any,
  async (req: any, res, next) => {
    try {
      const { id } = req.params;

      // A save that didn't persist must never report success. Reject up
      // front — before any write — rather than silently letting Mongoose's
      // strict-mode cast drop the offending keys and returning {ok:true}
      // regardless (see docs/audits/business-form-persistence-audit.md).
      const unrecognized = findUnrecognizedCustomerFields(req.body || {});
      if (unrecognized.length > 0) {
        return res.status(400).json({
          error: "UNRECOGNIZED_FIELDS",
          message:
            `These submitted fields don't match any Customer schema path and would be ` +
            `silently discarded rather than saved: ${unrecognized.join(", ")}`,
          unrecognizedFields: unrecognized,
        });
      }

      // Multi-GST: defaultSellerGstin, if provided, must match an ACTIVE
      // company gstProfile. Empty/absent is valid (means global default).
      // Not re-validated against later deactivation — resolveSellerGstProfile
      // falls through safely for a stale value.
      if (typeof req.body.defaultSellerGstin === "string" && req.body.defaultSellerGstin.trim() !== "") {
        const gstin = req.body.defaultSellerGstin.trim().toUpperCase();
        const companySettings = await getCompanySettings();
        const activeGstins = new Set(
          ((companySettings.gstProfiles || []) as any[])
            .filter((p) => p.active)
            .map((p) => String(p.gstin).toUpperCase()),
        );
        if (!activeGstins.has(gstin)) {
          return res.status(400).json({
            error: "DEFAULT_SELLER_GSTIN_NOT_FOUND",
            message: `defaultSellerGstin "${req.body.defaultSellerGstin}" does not match any active company GST registration`,
          });
        }
        req.body.defaultSellerGstin = gstin;
      }

      const updated = await Customer.findOneAndUpdate(
        { _id: id },
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

          // GST — canonical field is gstNumber; gstin kept as a fallback for
          // any caller still on the old alias.
          const gstIn = req.body.gstNumber ?? req.body.gstin;
          if (gstIn !== undefined) {
            syncFields["formPayload.gstNumber"] = gstIn;
          }

          // PAN — canonical field is panNumber; pan kept as a fallback.
          const panIn = req.body.panNumber ?? req.body.pan;
          if (panIn !== undefined) {
            syncFields["formPayload.panNumber"] = panIn;
          }

          // Official email — canonical field is email; officialEmail kept as
          // a fallback for any caller still on the old alias.
          const officialEmailIn = req.body.email ?? req.body.officialEmail;
          if (officialEmailIn !== undefined) {
            syncFields["formPayload.officialEmail"] = officialEmailIn;
          }

          // Direct field mappings (same name), with a nested req.body.address.*
          // fallback for the address fields now that the flat top-level
          // addressLine1/city/country/pincode keys are no longer sent.
          const directFields = [
            "registeredAddress",
            "entityType",
            "industry",
            "website",
            "employeesCount",
            "incorporationDate",
            "description",
          ];
          directFields.forEach((f) => {
            if (req.body[f] !== undefined) {
              syncFields[`formPayload.${f}`] = req.body[f];
            }
          });

          const addressFieldMap: Record<string, string> = {
            addressLine1: "street",
            addressLine2: "street2",
            city: "city",
            country: "country",
            pincode: "pincode",
          };
          Object.entries(addressFieldMap).forEach(([formPayloadKey, addressKey]) => {
            const val = req.body.address?.[addressKey] ?? req.body[formPayloadKey];
            if (val !== undefined) {
              syncFields[`formPayload.${formPayloadKey}`] = val;
            }
          });

          // Bank — sent nested today (req.body.bank.*), flat keys kept as a
          // fallback for any other caller still on the old shape.
          const bodyBank = req.body.bank || {};
          const bankNameIn = bodyBank.bankName ?? req.body.bankName;
          const bankAccountIn = bodyBank.accountNumber ?? req.body.bankAccountNumber;
          const bankIfscIn = bodyBank.ifsc ?? req.body.bankIfsc;
          const bankBranchIn = bodyBank.branch ?? req.body.bankBranch;
          if (bankNameIn !== undefined) {
            syncFields["formPayload.bank.bankName"] = bankNameIn;
          }
          if (bankAccountIn !== undefined) {
            syncFields["formPayload.bank.accountNumber"] = bankAccountIn;
          }
          if (bankIfscIn !== undefined) {
            syncFields["formPayload.bank.ifsc"] = bankIfscIn;
          }
          if (bankBranchIn !== undefined) {
            syncFields["formPayload.bank.branch"] = bankBranchIn;
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
