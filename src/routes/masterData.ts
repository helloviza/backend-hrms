// apps/backend/src/routes/masterData.ts
import { Router, Request } from "express";
import { randomBytes } from "crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import Onboarding from "../models/Onboarding.js";
import MasterData from "../models/MasterData.js";
import User from "../models/User.js";
import Vendor from "../models/Vendor.js";
import Customer from "../models/Customer.js";
import Employee from "../models/Employee.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import { validateObjectId } from "../middleware/validateObjectId.js";
import { sendMail } from "../utils/mailer.js";
import { sendCredentialsEmail } from "../utils/credentialsEmail.js";
import { sendOnboardingWelcomeEmail } from "../utils/onboardingWelcomeEmail.js";
import { sendEmployeeWelcomeEmail, sendClientWelcomeEmail } from "../utils/employeeWelcomeEmail.js";
import { UserPermission } from "../models/UserPermission.js";


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
/* ✅ PASTE syncEmployeeRecord RIGHT HERE                                     */
/* -------------------------------------------------------------------------- */

async function syncEmployeeRecord({
  user,
  onboardingDoc,
  form,
}: {
  user: any;
  onboardingDoc: any;
  form: any;
}) {
  if (!user?._id) return;

  const base: any = {
    name: user.name || user.fullName,
    fullName: user.name || user.fullName,
    email: user.email,
    phone: user.phone,

    employeeCode: user.employeeCode,
    employeeId: user.employeeCode,

    department: user.department || "",
    designation: user.designation || "",
    location: user.jobLocation || "",

    status: user.status || "ACTIVE",
    isActive: true,

    joiningDate:
      user.dateOfJoining ? new Date(user.dateOfJoining) : undefined,

    onboardingId: onboardingDoc._id,
    onboardingSnapshot: form,

    ownerId: user._id,
    workspaceId: user.workspaceId || user.customerId || user.businessId || null,
  };

  const existing = await Employee.findOne({
    $or: [
      { onboardingId: onboardingDoc._id },
      { email: user.email },
      { employeeCode: user.employeeCode },
    ],
  }).exec();

  if (existing) {
    Object.assign(existing, base);
    await existing.save();
  } else {
    await Employee.create(base);
  }
}

/**
 * Generate next employee code, starting from PTS001031.
 */
async function generateNextEmployeeCode(): Promise<string> {
  const lastDocs = await User.find({
    employeeCode: /^PTS\d{6}$/i,
  })
    .sort({ employeeCode: -1 })
    .limit(1)
    .lean()
    .exec();

  if (!lastDocs.length) {
    return "PTS001031";
  }

  const lastAny: any = lastDocs[0];
  const current = String(lastAny.employeeCode || "");
  const prefix = current.slice(0, 3) || "PTS";
  const numericPart = current.slice(3);
  const num = Number.parseInt(numericPart || "1031", 10) || 1031;
  const next = num + 1;

  return prefix + String(next).padStart(6, "0");
}

/**
 * Generate next Vendor code, starting from V_PTS00501.
 * Pattern: V_PTS + 5 digits (e.g. V_PTS00501).
 */
async function generateNextVendorCode(): Promise<string> {
  const lastDocs = await Vendor.find({
    vendorCode: /^V_PTS\d{5}$/i,
  })
    .sort({ vendorCode: -1 })
    .limit(1)
    .lean()
    .exec();

  if (!lastDocs.length) {
    return "V_PTS00501";
  }

  const last: any = lastDocs[0];
  const current = String(last.vendorCode || "");
  const prefix = current.slice(0, 5) || "V_PTS"; // "V_PTS"
  const numericPart = current.slice(5); // last 5 digits
  const num = Number.parseInt(numericPart || "0501", 10) || 501;
  const next = num + 1;

  return prefix + String(next).padStart(5, "0");
}

/**
 * Generate next Customer code, starting from B_PTS00801.
 * Pattern: B_PTS + 5 digits (e.g. B_PTS00801).
 */
async function generateNextCustomerCode(): Promise<string> {
  const lastDocs = await Customer.find({
    customerCode: /^B_PTS\d{5}$/i,
  })
    .sort({ customerCode: -1 })
    .limit(1)
    .lean()
    .exec();

  if (!lastDocs.length) {
    return "B_PTS00801";
  }

  const last: any = lastDocs[0];
  const current = String(last.customerCode || "");
  const prefix = current.slice(0, 5) || "B_PTS"; // "B_PTS"
  const numericPart = current.slice(5); // last 5 digits
  const num = Number.parseInt(numericPart || "0801", 10) || 801;
  const next = num + 1;

  return prefix + String(next).padStart(5, "0");
}

/**
 * Resolve workspaceObjectId from req, with SUPERADMIN fallback to first active workspace.
 */
async function resolveWorkspaceId(req: Request): Promise<mongoose.Types.ObjectId | null> {
  if ((req as any).workspaceObjectId) return (req as any).workspaceObjectId;

  if (isSuperAdmin(req)) {
    const explicit =
      (req.body as any)?.workspaceId ||
      (req.query as any)?.workspaceId ||
      req.headers["x-workspace-id"];
    if (explicit) return new mongoose.Types.ObjectId(String(explicit));

    // SUPERADMIN must provide explicit workspaceId — no auto-fallback
    return null;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Routes – Master list                                                       */
/* -------------------------------------------------------------------------- */

/**
 * List approved onboardings (Master Data)
 */
router.get("/", requireAuth, requireWorkspace, async (req, res, next) => {
  try {
    const { type, status } = req.query as Record<string, string>;
    const wsFilter = isSuperAdmin(req)
      ? {}
      : { workspaceId: (req as any).workspaceObjectId };

    // --- Onboarding collection ---
    const obFilter: any = { status: { $in: ["approved", "submitted", "verified"] }, ...wsFilter };
    if (type && type !== "All") obFilter.type = new RegExp(`^${type}$`, "i");
    if (status && /inactive/i.test(status)) obFilter.isActive = false;
    else if (status && /active/i.test(status) && !/inactive/i.test(status)) obFilter.isActive = true;

    const obDocs = await Onboarding.find(obFilter)
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    const obItems = obDocs.map((d: any) => ({
      id: String(d._id),
      name: d.name || d.inviteeName || "",
      inviteeName: d.inviteeName || "",
      email: d.email || d.inviteeEmail || "",
      type: d.type || "unknown",
      status: d.status || "approved",
      isActive: d.isActive !== false,
      updatedAt: d.updatedAt,
      submittedAt: d.submittedAt,
      token: d.token || "",
      source: "onboarding" as const,
    }));

    // --- MasterData collection ---
    const mdFilter: any = { ...wsFilter };
    if (type && type !== "All") mdFilter.type = new RegExp(`^${type}$`, "i");
    if (status && /inactive/i.test(status)) mdFilter.isActive = false;
    else if (status && /active/i.test(status) && !/inactive/i.test(status)) mdFilter.isActive = true;

    const mdDocs = await MasterData.find(mdFilter)
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    const mdItems = mdDocs.map((d: any) => ({
      id: String(d._id),
      name: d.name || d.companyName || d.businessName || d.contactName || "",
      inviteeName: d.inviteeName || "",
      email: d.email || d.officialEmail || d.personalEmail || "",
      type: d.type || "unknown",
      status: d.status || "Active",
      isActive: d.isActive !== false,
      updatedAt: d.updatedAt,
      submittedAt: d.submittedAt,
      token: d.token || "",
      source: "masterdata" as const,
    }));

    // --- Merge and sort by updatedAt descending ---
    const items = [...obItems, ...mdItems].sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    });

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/**
 * Create a simple master record (Vendor / Business) directly from HRMS.
 * Used by "+ New Vendor" / "+ New Business" buttons.
 */
router.post("/", requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    if (!isHrmsAdmin(req.user)) {
      return res
        .status(403)
        .json({ error: "Only HR Admin / Admin can create master records" });
    }

    const workspaceId = await resolveWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: "Workspace context required" });
    }

    const body = req.body || {};
    const rawType = String(body.type || "Vendor");
    const type = rawType[0].toUpperCase() + rawType.slice(1).toLowerCase();

    const companyName =
      body.companyName ||
      body.businessName ||
      body.name ||
      "Unnamed Account";

    const emailRaw: string | undefined =
      body.officialEmail || body.email || body.contactEmail || undefined;
    const email =
      (emailRaw && String(emailRaw).trim().toLowerCase()) || undefined;

    const contactName = body.contactName || "";
    const contactEmail = body.contactEmail || "";
    const contactMobile = body.contactMobile || body.phone || "";

    const industry = body.industry || body.segment || "";
    const segment = body.segment || body.industry || "";

    const gstin = body.gstin || "";
    const pan = body.pan || "";

    const billingAddress = body.billingAddress || "";
    const creditLimit = body.creditLimit || "";
    const paymentTerms = body.paymentTerms || "";

    const isActive = body.isActive !== false;

    const payload: any = {
      type,
      companyName,
      businessName: companyName,
      name: companyName,
      officialEmail: email,
      email,
      contact: {
        name: contactName,
        email: contactEmail || email,
        mobile: contactMobile,
      },
      industry,
      segment,
      gstin,
      pan,
      billingAddress,
      creditLimit,
      paymentTerms,
    };

    // Duplicate check — same email + type + workspaceId
    if (email) {
      const existing = await Onboarding.findOne({
        email,
        type,
        workspaceId,
      }).lean();
      if (existing) {
        return res.status(409).json({
          error: "A record with this email already exists",
          existingId: existing._id,
          token: (existing as any).token,
        });
      }
    }

    const onboarding = await Onboarding.create({
      type,
      workspaceId,
      status: "approved",
      isActive,
      token: randomBytes(20).toString("hex"),
      expiresAt: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000),
      name: companyName,
      companyName,
      businessName: companyName,
      email,
      officialEmail: email,
      contactName,
      contactEmail: contactEmail || email,
      contactMobile,
      industry,
      segment,
      gstin,
      pan,
      billingAddress,
      creditLimit,
      paymentTerms,
      payload,
    });

    return res.json({
      ok: true,
      id: String(onboarding._id),
      type: onboarding.type,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Toggle Active/Inactive state
 */
router.patch("/:id/status", validateObjectId("id"), requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    if (!isHrmsAdmin(req.user)) {
      return res.status(403).json({ error: "Only HR Admin / Admin can toggle status" });
    }

    const { id } = req.params;
    const { status } = req.body as { status: string };
    const isActive = !/inactive/i.test(status);

    const query: any = { _id: id };
    if (!isSuperAdmin(req) && req.workspaceObjectId) query.workspaceId = req.workspaceObjectId;
    const doc = await Onboarding.findOneAndUpdate(
      query,
      { isActive },
      { new: true },
    ).exec();

    if (!doc) return res.status(404).json({ error: "Record not found" });

    res.json({ ok: true, id, isActive });
  } catch (err) {
    next(err);
  }
});

/**
 * Generic PATCH – update Vendor / Business master fields.
 * This is what VendorProfiles.tsx & BusinessProfiles.tsx call.
 */
router.patch("/:id", validateObjectId("id"), requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    if (!isHrmsAdmin(req.user)) {
      return res
        .status(403)
        .json({ error: "Only HR Admin / Admin can edit master records" });
    }

    const { id } = req.params;
    const body = req.body || {};
    const workspaceId = await resolveWorkspaceId(req);
    const query: any = { _id: id };
    if (workspaceId) query.workspaceId = workspaceId;
    const onboardingDoc: any = await Onboarding.findOne(query).exec();
    if (!onboardingDoc) {
      return res.status(404).json({ error: "Master record not found" });
    }

    const originalType = String(onboardingDoc.type || body.type || "").toLowerCase();

    const companyName =
      body.companyName ||
      body.businessName ||
      body.name ||
      onboardingDoc.companyName ||
      onboardingDoc.businessName ||
      onboardingDoc.name ||
      "";

    const emailRaw: string | undefined =
      body.officialEmail ||
      body.email ||
      onboardingDoc.officialEmail ||
      onboardingDoc.email ||
      onboardingDoc.inviteeEmail ||
      undefined;
    const email =
      (emailRaw && String(emailRaw).trim().toLowerCase()) || undefined;

    const contactName =
      body.contactName ||
      onboardingDoc.contactName ||
      onboardingDoc.accountOwner ||
      (onboardingDoc.contact && onboardingDoc.contact.name) ||
      "";

    const contactEmail =
      body.contactEmail ||
      (onboardingDoc.contact && onboardingDoc.contact.email) ||
      onboardingDoc.contactEmail ||
      email ||
      "";

    const contactMobile =
      body.contactMobile ||
      (onboardingDoc.contact && onboardingDoc.contact.mobile) ||
      onboardingDoc.contactMobile ||
      onboardingDoc.phone ||
      "";

    const industry =
      body.industry ||
      body.segment ||
      onboardingDoc.industry ||
      onboardingDoc.segment ||
      "";

    const segment =
      body.segment ||
      body.industry ||
      onboardingDoc.segment ||
      onboardingDoc.industry ||
      "";

    const gstin = body.gstin || onboardingDoc.gstin || onboardingDoc.gstNumber;
    const pan =
      body.pan ||
      onboardingDoc.pan ||
      (onboardingDoc.tax && onboardingDoc.tax.pan) ||
      "";

    const billingAddress =
      body.billingAddress ||
      onboardingDoc.billingAddress ||
      (onboardingDoc.address && onboardingDoc.address.billing) ||
      "";

    const creditLimit =
      body.creditLimit || onboardingDoc.creditLimit || "";

    const paymentTerms =
      body.paymentTerms ||
      onboardingDoc.paymentTerms ||
      onboardingDoc.payment_terms ||
      "";

    const isActive =
      typeof body.isActive === "boolean" ? body.isActive : onboardingDoc.isActive;

    // ----- apply to onboarding doc top-level -----
    if (companyName) {
      onboardingDoc.name = companyName;
      onboardingDoc.companyName = companyName;
      onboardingDoc.businessName = companyName;
    }
    if (email) {
      onboardingDoc.email = email;
      onboardingDoc.officialEmail = email;
    }
    onboardingDoc.contactName = contactName;
    onboardingDoc.contactEmail = contactEmail;
    onboardingDoc.contactMobile = contactMobile;
    onboardingDoc.phone = contactMobile;

    onboardingDoc.industry = industry;
    onboardingDoc.segment = segment;

    onboardingDoc.gstin = gstin;
    onboardingDoc.pan = pan;
    onboardingDoc.billingAddress = billingAddress;
    onboardingDoc.creditLimit = creditLimit;
    onboardingDoc.paymentTerms = paymentTerms;
    onboardingDoc.isActive = isActive;

    // ----- also merge into payload for detail views -----
    const payload: any = { ...(onboardingDoc.payload || {}) };

    if (companyName) {
      payload.companyName = companyName;
      payload.businessName = companyName;
      payload.name = companyName;
    }
    if (email) {
      payload.officialEmail = email;
      payload.email = email;
      payload.companyEmail = email;
    }

    payload.contact = {
      ...(payload.contact || {}),
      name: contactName || (payload.contact && payload.contact.name),
      email: contactEmail || (payload.contact && payload.contact.email),
      mobile: contactMobile || (payload.contact && payload.contact.mobile),
    };

    payload.industry = industry || payload.industry;
    payload.segment = segment || payload.segment;
    payload.gstin = gstin || payload.gstin;
    payload.pan = pan || payload.pan;
    payload.billingAddress = billingAddress || payload.billingAddress;
    payload.creditLimit = creditLimit || payload.creditLimit;
    payload.paymentTerms = paymentTerms || payload.paymentTerms;
    payload.legalName = body.legalName || body.companyName || body.name || payload.legalName;

    onboardingDoc.payload = payload;

    // ----- also sync to formPayload (used by detail panel display) -----
    if (!onboardingDoc.formPayload) {
      onboardingDoc.formPayload = {};
    }

    const syncToFormPayload: Record<string, any> = {
      legalName: body.legalName || body.companyName || body.name,
      companyName: body.companyName || body.name,
      gstNumber: body.gstNumber || body.gstin,
      panNumber: body.panNumber || body.pan,
      entityType: body.entityType,
      registeredAddress: body.registeredAddress,
      website: body.website,
      industry: body.industry,
      employeesCount: body.employeesCount,
      incorporationDate: body.incorporationDate,
      description: body.description,
      officialEmail: body.officialEmail || body.email,
      cin: body.cin,
    };

    Object.entries(syncToFormPayload).forEach(([key, val]) => {
      if (val !== undefined && val !== null) {
        onboardingDoc.formPayload[key] = val;
      }
    });

    // Mark formPayload as modified (Mongoose won't detect nested changes)
    onboardingDoc.markModified('formPayload');

    const saved = await onboardingDoc.save();

    // ----- sync linked Vendor / Customer, if present -----
    if (originalType === "vendor") {
      const vendor = await Vendor.findOne({ onboardingId: saved._id }).exec();
      if (vendor) {
        if (companyName) vendor.name = companyName;
        if (email) vendor.email = email;
        if (contactMobile) vendor.phone = contactMobile;
        await vendor.save();
      }
    } else if (originalType === "business" || originalType === "customer") {
      const customer = await Customer.findOne({
        onboardingId: saved._id,
      }).exec();
      if (customer) {
        if (companyName) customer.name = companyName;
        if (email) customer.email = email;
        if (contactMobile) customer.phone = contactMobile;
        await customer.save();
      }
    }

    return res.json({
      ok: true,
      id: String(saved._id),
    });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/* Promotion routes                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Promote an approved Employee-type onboarding record into a real HRMS User.
 */
router.post(
  "/:id/promote-employee",
  requireAuth,
  requireWorkspace,
  async (req: any, res, next) => {
    try {
      if (!isHrmsAdmin(req.user)) {
        return res
          .status(403)
          .json({ error: "Only HR Admin / Admin can promote employees" });
      }

      const { id } = req.params;

      const workspaceId = await resolveWorkspaceId(req);
      const query: any = { _id: id };
      if (workspaceId) query.workspaceId = workspaceId;
      const onboardingDoc: any = await Onboarding.findOne(query).exec();
      if (!onboardingDoc) {
        return res.status(404).json({ error: "Onboarding record not found" });
      }

      const type = String(onboardingDoc.type || "").toLowerCase();
      if (type !== "employee") {
        return res.status(400).json({
          error: "Only Employee-type records can be promoted to HRMS users",
        });
      }

      // Read structured form payload (employee onboarding form)
      const form =
        onboardingDoc.formPayload ||
        onboardingDoc.payload ||
        onboardingDoc.extras_json ||
        {};
      const address = form.address || {};
      const contact = form.contact || {};
      const emergency = form.emergency || {};
      const ids = form.ids || {};
      const bank = form.bank || {};
      const education = form.education || {};
      const employment = form.employment || {};

      // prefer official email coming from MasterData popup (req.body)
      const bodyOfficialRaw: string | undefined =
        (req.body &&
          (req.body.officialEmail ||
            req.body.official_email ||
            req.body.email)) ||
        undefined;

      // Previous logic (onboarding emails), now used only as fallback
      const onboardingEmailRaw: string | undefined =
        onboardingDoc.officialEmail ||
        onboardingDoc.workEmail ||
        onboardingDoc.email ||
        onboardingDoc.inviteeEmail ||
        contact.companyEmail ||
        contact.workEmail ||
        undefined;

      const emailRaw: string | undefined = bodyOfficialRaw || onboardingEmailRaw;
      const email =
        (emailRaw && String(emailRaw).trim().toLowerCase()) || undefined;

      if (!email) {
        return res.status(400).json({
          error: "Official company email is required to promote employee",
        });
      }

      let existingUser: any = await User.findOne({
        $or: [{ onboardingId: onboardingDoc._id }, { email }],
      }).exec();

      // Decide employee code
      let employeeCode =
        (existingUser && existingUser.employeeCode) ||
        (onboardingDoc as any).employeeCode ||
        (req.body as any)?.employeeCode ||
        (await generateNextEmployeeCode());

      // Common base fields (from onboarding header)
      const baseName =
        onboardingDoc.name ||
        onboardingDoc.inviteeName ||
        form.fullName ||
        `${onboardingDoc.firstName || ""} ${
          onboardingDoc.lastName || ""
        }`.trim();

      const firstName =
        onboardingDoc.firstName ||
        (typeof form.fullName === "string"
          ? form.fullName.split(" ")[0]
          : undefined);

      const lastName =
        onboardingDoc.lastName ||
        (typeof form.fullName === "string"
          ? form.fullName.split(" ").slice(1).join(" ")
          : undefined);

      const payload: any = {
        // core identity
        name: baseName || undefined,
        firstName: firstName || undefined,
        lastName: lastName || undefined,

        // official + login email – both from the chosen company email
        officialEmail: email,
        email, // schema lowercases this field

        personalEmail:
          contact.personalEmail || onboardingDoc.personalEmail || undefined,
        phone: contact.personalMobile || onboardingDoc.phone || undefined,
        personalContact: contact.personalMobile || undefined,

        // HR flags / roles
        employeeCode,
        department: onboardingDoc.department || form.department || "",
        designation: onboardingDoc.designation || form.designation || "",
        managerName:
          onboardingDoc.managerName ||
          form.reportingL1 ||
          form.managerName ||
          "",
        jobLocation:
          onboardingDoc.workLocation ||
          onboardingDoc.location ||
          onboardingDoc.baseLocation ||
          form.jobLocation ||
          "",
        role: "EMPLOYEE",
        roles: ["EMPLOYEE"],
        hrmsAccessLevel: "EMPLOYEE",
        hrmsAccessRole: "EMPLOYEE",
        employmentStatus:
          employment.employmentStatus || onboardingDoc.employmentStatus || "",
        employeeType:
          employment.employeeType || onboardingDoc.employeeType || "",

        // personal details
        dateOfBirth: form.dateOfBirth || "",
        gender: form.gender || "",
        maritalStatus: employment.maritalStatus || form.maritalStatus || "",
        nationality: form.nationality || "",
        bloodGroup: form.bloodGroup || "",

        permanentAddress: address.permanent || "",
        currentAddress: address.current || "",

        emergencyContactName: emergency.name || "",
        emergencyContactRelation: emergency.relationship || "",
        emergencyContactNumber: emergency.mobile || "",

        pan: ids.pan || "",
        aadhaar: ids.aadhaar || "",

        passportNumber: form.passportNumber || "",
        passportExpiry: form.passportExpiry || "",
        voterId: form.voterId || "",
        disabilityStatus: form.disabilityStatus || "",

        // bank / payroll
        bankAccountNumber: bank.accountNumber || "",
        bankName: bank.bankName || "",
        bankIfsc: bank.ifsc || "",

        dateOfJoining:
          employment.dateOfJoining || onboardingDoc.dateOfJoining || "",
        // basic education snapshot
        educationalQualifications: education.highestDegree
          ? `${education.highestDegree} – ${education.institution || ""} (${
              education.year || ""
            })`.trim()
          : "",

        onboardingId: onboardingDoc._id,
        status: "ACTIVE",
      };

      if (existingUser) {
  if (!existingUser.workspaceId && (workspaceId || req.workspaceObjectId)) {
    existingUser.workspaceId = workspaceId || req.workspaceObjectId;
  }
  Object.assign(existingUser, payload);
  const saved = await existingUser.save();
  await syncEmployeeRecord({
  user: saved,
  onboardingDoc,
  form,
});


  (onboardingDoc as any).employeeCode = employeeCode;
  (onboardingDoc as any).linkedUserId = saved._id;

  // 🔒 Send welcome email ONLY ONCE — use warm employee template
  if (!(onboardingDoc as any).welcomeEmailSent) {
    try {
      const loginUrl = (process.env.FRONTEND_ORIGIN || "https://hrms.plumtrips.com").replace(/\/+$/, "") + "/login";
      await sendEmployeeWelcomeEmail({
        name: baseName || "Employee",
        email: email!,
        loginUrl,
        effectiveDate: new Date(
          employment.dateOfJoining ||
          onboardingDoc.dateOfJoining ||
          Date.now()
        ),
      });
    } catch (empEmailErr) {
      console.error("[promote-employee] welcome email failed:", empEmailErr);
    }
    (onboardingDoc as any).welcomeEmailSent = true;
  }

  // Auto-create UserPermission at Tier 0
  try {
    await UserPermission.findOneAndUpdate(
      { email: email.toLowerCase() },
      {
        $setOnInsert: {
          userId:     String(saved._id),
          email:      email.toLowerCase(),
          workspaceId: String(workspaceId || req.workspaceObjectId),
          universe:   'STAFF' as const,
          level: {
            code:        'L1',
            name:        'Employee',
            designation: (req.body as any)?.jobTitle || 'Employee',
          },
          status:        'active',
          tier:          0,
          roleType:      'EMPLOYEE',
          grantedModules: [],
          modules:       {},
          source:        'onboarding',
          grantedBy:     'system',
          grantedAt:     new Date(),
        },
      },
      { upsert: true, new: true },
    )
  } catch (permErr) {
    console.warn('[promote-employee] UserPermission upsert failed:', permErr)
  }

  await onboardingDoc.save();

  return res.json({
    ok: true,
    alreadyExists: true,
    employeeCode,
    user: saved,
  });
}

      const tempPassword =
        "HRMS-" +
        Math.random().toString(36).slice(2) +
        Date.now().toString(36);
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      const newPayload: any = {
        ...payload,
        passwordHash,
        workspaceId: workspaceId || req.workspaceObjectId,
      };

      const user = await User.create(newPayload);
      await syncEmployeeRecord({
  user,
  onboardingDoc,
  form,
});


(onboardingDoc as any).employeeCode = employeeCode;
(onboardingDoc as any).linkedUserId = user._id;

// 🔒 Send employee welcome + credentials email only once
if (!(onboardingDoc as any).welcomeEmailSent) {
  try {
    const loginUrl = (process.env.FRONTEND_ORIGIN || "https://hrms.plumtrips.com").replace(/\/+$/, "") + "/login";
    await sendEmployeeWelcomeEmail({
      name: baseName || "Employee",
      email: email!,
      loginUrl,
      effectiveDate: new Date(
        employment.dateOfJoining ||
        onboardingDoc.dateOfJoining ||
        Date.now()
      ),
      tempPassword,
    });
  } catch (empEmailErr) {
    console.error("[promote-employee] welcome email failed:", empEmailErr);
  }
  (onboardingDoc as any).welcomeEmailSent = true;
}

// Auto-create UserPermission at Tier 0
try {
  await UserPermission.findOneAndUpdate(
    { email: email.toLowerCase() },
    {
      $setOnInsert: {
        userId:     String(user._id),
        email:      email.toLowerCase(),
        workspaceId: String(workspaceId || req.workspaceObjectId),
        universe:   'STAFF' as const,
        level: {
          code:        'L1',
          name:        'Employee',
          designation: (req.body as any)?.jobTitle || 'Employee',
        },
        status:        'active',
        tier:          0,
        roleType:      'EMPLOYEE',
        grantedModules: [],
        modules:       {},
        source:        'onboarding',
        grantedBy:     'system',
        grantedAt:     new Date(),
      },
    },
    { upsert: true, new: true },
  )
} catch (permErr) {
  console.warn('[promote-employee] UserPermission upsert failed:', permErr)
}

await onboardingDoc.save();

return res.json({
  ok: true,
  employeeCode,
  user,
});
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Promote Vendor-type onboarding into real Vendor record.
 */
router.post(
  "/:id/promote-vendor",
  requireAuth,
  requireWorkspace,
  async (req: any, res, next) => {
    try {
      if (!isHrmsAdmin(req.user)) {
        return res
          .status(403)
          .json({ error: "Only HR Admin / Admin can promote vendors" });
      }

      const { id } = req.params;
      const workspaceId = await resolveWorkspaceId(req);
      const query: any = { _id: id };
      if (workspaceId) query.workspaceId = workspaceId;
      const onboardingDoc: any = await Onboarding.findOne(query).exec();
      if (!onboardingDoc) {
        return res
          .status(404)
          .json({ error: "Onboarding record not found for vendor" });
      }

      const type = String(onboardingDoc.type || "").toLowerCase();
      if (type !== "vendor") {
        return res.status(400).json({
          error: "Only Vendor-type records can be promoted to Vendor profiles",
        });
      }

      const form =
        onboardingDoc.formPayload ||
        onboardingDoc.payload ||
        onboardingDoc.extras_json ||
        {};

      const headerName =
        onboardingDoc.businessName ||
        onboardingDoc.name ||
        onboardingDoc.inviteeName ||
        "";
      const formName =
        form.businessName || form.companyName || form.vendorName || "";
      const name =
        String(headerName || formName || "").trim() || "Unnamed Vendor";

      const emailRaw: string | undefined =
        (req.body &&
          (req.body.officialEmail ||
            req.body.official_email ||
            req.body.email)) ||
        onboardingDoc.email ||
        onboardingDoc.inviteeEmail ||
        form.contactEmail ||
        form.companyEmail ||
        undefined;

      const email =
        (emailRaw && String(emailRaw).trim().toLowerCase()) || undefined;

      if (!email) {
        return res
          .status(400)
          .json({ error: "Vendor email is required to promote vendor" });
      }

      const phone =
        onboardingDoc.phone || form.contactMobile || form.phone || "";

      const baDirect = Array.isArray(onboardingDoc.businessAssociations)
        ? onboardingDoc.businessAssociations
        : [];
      const baForm = Array.isArray(form.businessAssociations)
        ? form.businessAssociations
        : [];
      const businessAssociations = (baDirect.length ? baDirect : baForm).map(
        (v: any) => String(v).toUpperCase(),
      );

      let existingVendor: any = await Vendor.findOne({
        $or: [{ onboardingId: onboardingDoc._id }, { email }],
      }).exec();

      let vendorCode =
        (existingVendor && existingVendor.vendorCode) ||
        (onboardingDoc as any).vendorCode ||
        (await generateNextVendorCode());

      const base: any = {
  name,
  email,
  phone,
  vendorCode,
  businessAssociations,
  status: "APPROVED",
  onboardingId: onboardingDoc._id,

  // 🔐 IMPORTANT – snapshot like Customer
  onboardingSnapshot: form,
};


      let vendor: any;
      if (existingVendor) {
        Object.assign(existingVendor, base);
        vendor = await existingVendor.save();
      } else {
        // Check if Vendor already exists for this email + workspace
        const dupVendor = await Vendor.findOne({ email, workspaceId }).lean();
        if (dupVendor) {
          return res.status(409).json({
            error: "Vendor already exists for this email",
            vendorId: dupVendor._id,
          });
        }
        vendor = await Vendor.create(base);
      }

      (onboardingDoc as any).vendorCode = vendorCode;
(onboardingDoc as any).linkedVendorId = vendor._id;

// 🔒 Send welcome email only once
if (!(onboardingDoc as any).welcomeEmailSent) {
  await sendOnboardingWelcomeEmail({
    to: email,
    counterpartyName: name,
    effectiveDate: new Date().toISOString().slice(0, 10),
    relationshipType: "Vendor",
  });

  (onboardingDoc as any).welcomeEmailSent = true;
}

await onboardingDoc.save();

// Create User account + UserPermission for vendor
if (email) {
  let vendorUser: any = await User.findOne({ email: email.toLowerCase() }).lean()

  if (!vendorUser) {
    const tempPassword =
      'PLMX-' + Math.random().toString(36).slice(2, 10).toUpperCase()
    const passwordHash = await bcrypt.hash(tempPassword, 10)

    vendorUser = await User.create({
      email:          email.toLowerCase(),
      name:           form.companyName || name,
      passwordHash,
      roles:          ['VENDOR'],
      role:           'VENDOR',
      hrmsAccessRole: 'VENDOR',
      status:         'ACTIVE',
      workspaceId:    workspaceId || req.workspaceObjectId,
      tempPassword:   true,
    })

    try {
      await sendClientWelcomeEmail({
        to:        email,
        name:      (vendorUser as any).name,
        tempPassword,
        loginUrl:  'https://plumbox.plumtrips.com',
      })
    } catch (emailErr) {
      console.warn('[promote-vendor] Welcome email failed:', emailErr)
    }
  }

  try {
    await UserPermission.findOneAndUpdate(
      { email: email.toLowerCase() },
      {
        $setOnInsert: {
          userId:     String((vendorUser as any)._id),
          email:      email.toLowerCase(),
          workspaceId: String(workspaceId || req.workspaceObjectId),
          universe:   'VENDOR' as const,
          level: {
            code:        'VENDOR',
            name:        'Vendor',
            designation: 'Vendor Partner',
          },
          status:        'active',
          tier:          1,
          roleType:      'VENDOR',
          grantedModules: ['profile', 'myServices'],
          modules:       {},
          source:        'onboarding',
          grantedBy:     'system',
          grantedAt:     new Date(),
        },
      },
      { upsert: true, new: true },
    )
  } catch (permErr) {
    console.warn('[promote-vendor] UserPermission upsert failed:', permErr)
  }

  await Vendor.findByIdAndUpdate(vendor._id, {
    linkedUserId: String((vendorUser as any)._id),
  })
}

return res.json({
  ok: true,
  alreadyExists: !!existingVendor,
  vendorCode,
  vendor,
});
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Promote Business-type onboarding into real Customer record.
 * (We treat "Business" as "Customer" in HRMS).
 */
router.post(
  "/:id/promote-customer",
  requireAuth,
  requireWorkspace,
  async (req: any, res, next) => {
    try {
      if (!isHrmsAdmin(req.user)) {
        return res
          .status(403)
          .json({ error: "Only HR Admin / Admin can promote customers" });
      }

      const { id } = req.params;
      const workspaceId = await resolveWorkspaceId(req);
      const query: any = { _id: id };
      if (workspaceId) query.workspaceId = workspaceId;
      const onboardingDoc: any = await Onboarding.findOne(query).exec();
      if (!onboardingDoc) {
        return res
          .status(404)
          .json({ error: "Onboarding record not found for customer" });
      }

      const rawType = String(onboardingDoc.type || "").toLowerCase();
      if (rawType !== "business" && rawType !== "customer") {
        return res.status(400).json({
          error:
            "Only Business/Customer-type records can be promoted to Customer profiles",
        });
      }

      const form =
        onboardingDoc.formPayload ||
        onboardingDoc.payload ||
        onboardingDoc.extras_json ||
        {};

      const headerName =
        onboardingDoc.companyName ||
        onboardingDoc.businessName ||
        onboardingDoc.name ||
        onboardingDoc.inviteeName ||
        "";
      const formName =
        form.companyName ||
        form.businessName ||
        form.customerName ||
        form.accountName ||
        "";
      const name =
        String(headerName || formName || "").trim() || "Unnamed Customer";

      const emailRaw: string | undefined =
        (req.body &&
          (req.body.officialEmail ||
            req.body.official_email ||
            req.body.email)) ||
        onboardingDoc.email ||
        onboardingDoc.inviteeEmail ||
        form.billingEmail ||
        form.contactEmail ||
        undefined;

      const email =
        (emailRaw && String(emailRaw).trim().toLowerCase()) || undefined;

      if (!email) {
        return res.status(400).json({
          error: "Customer email is required to promote customer",
        });
      }

      const phone =
        onboardingDoc.phone ||
        form.contactMobile ||
        form.phone ||
        form.billingPhone ||
        "";

      const segment =
        form.segment ||
        form.customerSegment ||
        onboardingDoc.segment ||
        "CUSTOMER";

      let existingCustomer: any = await Customer.findOne({
        $or: [{ onboardingId: onboardingDoc._id }, { email }],
      }).exec();

      let customerCode =
        (existingCustomer && existingCustomer.customerCode) ||
        (onboardingDoc as any).customerCode ||
        (await generateNextCustomerCode());

      const base: any = {
  // Core identity
  name,
  legalName:
    form.legalName ||
    form.companyName ||
    name,

  email,
  phone,

  // Classification
  customerCode,
  type: "CUSTOMER",
  status: "ACTIVE",
  segment,

  // Business details
  industry:
    form.industry ||
    onboardingDoc.industry ||
    "",

  website:
    form.website ||
    "",

  // Tax identifiers
  gstNumber:
    form.gstNumber ||
    onboardingDoc.gstNumber ||
    onboardingDoc.gstin ||
    "",

  panNumber:
    form.panNumber ||
    onboardingDoc.pan ||
    "",

  // Addresses
  registeredAddress:
    form.registeredAddress ||
    "",

  operationalAddress:
    form.operationalAddress ||
    "",

  // Banking
  bank: form.bank || {},

  // Contacts
  contacts: {
    primaryPhone:
      form.contacts?.primaryPhone ||
      phone,
    officialEmail:
      form.officialEmail ||
      email,
  },

  keyContacts:
    Array.isArray(form.keyContacts)
      ? form.keyContacts
      : [],

  // Compliance / metadata
  incorporationDate:
    form.incorporationDate ||
    null,

  entityType:
    form.entityType ||
    "UNKNOWN",

  employeesCount:
    form.employeesCount ||
    "",

  description:
    form.description ||
    "",

  // Link back
  onboardingId: onboardingDoc._id,

  // 🔐 Optional but HIGHLY recommended
  onboardingSnapshot: form,

  workspaceId: workspaceId || String(req.workspaceObjectId),
};


      let customer: any;
      if (existingCustomer) {
        Object.assign(existingCustomer, {
          ...base,
          workspaceId: workspaceId || String(req.workspaceObjectId),
        });
        customer = await existingCustomer.save();
      } else {
        // Check if Customer already exists for this email + workspace
        const dupCustomer = await Customer.findOne({ email, workspaceId }).lean();
        if (dupCustomer) {
          return res.status(409).json({
            error: "Customer already exists for this email",
            customerId: dupCustomer._id,
          });
        }
        customer = await Customer.create(base);
      }

      (onboardingDoc as any).customerCode = customerCode;
(onboardingDoc as any).linkedCustomerId = customer._id;

// 🔒 Send welcome email only once
if (!(onboardingDoc as any).welcomeEmailSent) {
  await sendOnboardingWelcomeEmail({
    to: email,
    counterpartyName: name,
    effectiveDate: new Date().toISOString().slice(0, 10),
    relationshipType: "Customer",
  });

  (onboardingDoc as any).welcomeEmailSent = true;
}

await onboardingDoc.save();

// Create User account + UserPermission for business client
if (email) {
  let clientUser: any = await User.findOne({ email: email.toLowerCase() }).lean()

  if (!clientUser) {
    const tempPassword =
      'PLMX-' + Math.random().toString(36).slice(2, 10).toUpperCase()
    const passwordHash = await bcrypt.hash(tempPassword, 10)

    clientUser = await User.create({
      email:          email.toLowerCase(),
      officialEmail:  email.toLowerCase(),
      name:           form.legalName || name,
      passwordHash,
      roles:          ['CUSTOMER'],
      role:           'CUSTOMER',
      hrmsAccessRole: 'CUSTOMER',
      status:         'ACTIVE',
      workspaceId:    workspaceId || req.workspaceObjectId,
      tempPassword:   true,
    })

    try {
      await sendClientWelcomeEmail({
        to:        email,
        name:      (clientUser as any).name,
        tempPassword,
        loginUrl:  'https://plumbox.plumtrips.com',
      })
    } catch (emailErr) {
      console.warn('[promote-customer] Welcome email failed:', emailErr)
    }
  }

  try {
    await UserPermission.findOneAndUpdate(
      { email: email.toLowerCase() },
      {
        $setOnInsert: {
          userId:     String((clientUser as any)._id),
          email:      email.toLowerCase(),
          workspaceId: String(workspaceId || req.workspaceObjectId),
          universe:   'CUSTOMER' as const,
          level: {
            code:        'CUSTOMER_APPROVAL',
            name:        'Business Client',
            designation: 'Client',
          },
          status:        'active',
          tier:          1,
          roleType:      'CLIENT',
          grantedModules: ['profile', 'myBookings', 'myInvoices'],
          modules:       {},
          source:        'onboarding',
          grantedBy:     'system',
          grantedAt:     new Date(),
        },
      },
      { upsert: true, new: true },
    )
  } catch (permErr) {
    console.warn('[promote-customer] UserPermission upsert failed:', permErr)
  }

  await Customer.findByIdAndUpdate(customer._id, {
    linkedUserId: String((clientUser as any)._id),
  })
}

return res.json({
  ok: true,
  alreadyExists: !!existingCustomer,
  customerCode,
  customer,
});
    } catch (err) {
      next(err);
    }
  },
);

export default router;
