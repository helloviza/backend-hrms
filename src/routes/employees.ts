// apps/backend/src/routes/employees.ts
import { Router } from "express";
import bcrypt from "bcryptjs";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import User from "../models/User.js";
import Employee from "../models/Employee.js";
import WorkspaceInvite from "../models/WorkspaceInvite.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { sendEmployeeInvite } from "../services/email.service.js";
import crypto from "crypto";

const router = Router();

type AnyUser = any;

/**
 * Generate next employee code, starting from PTS001031
 * PTS001031 is considered the 1st employee.
 */
async function generateNextEmployeeCode(): Promise<string> {
  const PREFIX = "PTS";
  const START_NUM = 1031; // 001031 → first employee
  const re = /^PTS(\d{6})$/;

  const docs: AnyUser[] = await User.find({
    employeeCode: { $regex: /^PTS\d{6}$/ },
  })
    .select("employeeCode")
    .lean()
    .exec();

  let max = 0;
  for (const d of docs) {
    const code = (d as any).employeeCode || "";
    const m = re.exec(code);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > max) {
        max = n;
      }
    }
  }

  const next = max === 0 ? START_NUM : max + 1;
  const suffix = String(next).padStart(6, "0");
  return `${PREFIX}${suffix}`;
}

function isAdminish(user: any): boolean {
  if (!user) return false;

  const roles: string[] = [
    ...(Array.isArray(user.roles) ? user.roles : []),
    ...(user.role ? [user.role] : []),
    ...(user.hrmsAccessRole ? [user.hrmsAccessRole] : []),
  ].map((r) => String(r || "").toUpperCase());

  return roles.includes("ADMIN") || roles.includes("SUPERADMIN");
}

function sanitise(user: AnyUser) {
  if (!user) return user;
  const obj = user.toObject ? user.toObject() : { ...user };
  delete (obj as any).passwordHash;
  delete (obj as any).__v;
  return obj;
}

/**
 * GET /api/employees
 * List HRMS employees with search, filtering, and pagination.
 * Query params: search, department, designation, status (active|inactive|all), page, limit
 */
router.get("/", requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    const search = String(req.query.search || "").trim();
    const department = String(req.query.department || "").trim();
    const designation = String(req.query.designation || "").trim();
    const statusParam = String(req.query.status || "active").toLowerCase();
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10)));

    const filter: any = {};
    // SUPERADMIN sees all employees across workspaces
    if (!isSuperAdmin(req) && req.workspaceObjectId) filter.workspaceId = req.workspaceObjectId;

    if (statusParam === "inactive") {
      filter.status = "INACTIVE";
    } else if (statusParam !== "all") {
      filter.status = { $ne: "INACTIVE" };
    }
    if (department) filter.department = department;
    if (designation) filter.designation = designation;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { fullName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { employeeCode: { $regex: search, $options: "i" } },
      ];
    }

    const [employees, total] = await Promise.all([
      Employee.find(filter)
        .sort({ employeeCode: 1, createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Employee.countDocuments(filter),
    ]);

    const emails = employees.map((e: any) => e.email).filter(Boolean);
    const users = await User.find({ email: { $in: emails } })
      .select("email roles hrmsAccessRole isActive activatedByAdmin tempPassword avatarKey avatarUrl lastLoginAt")
      .lean();

    const userMap = new Map(users.map((u: any) => [u.email, u]));

    // Look up pending invites for invite status badges
    const pendingInvites = req.workspaceObjectId
      ? await WorkspaceInvite.find({
          workspaceId: req.workspaceObjectId,
          status: "pending",
          expiresAt: { $gt: new Date() },
        })
          .select("email")
          .lean()
      : [];
    const pendingEmails = new Set(pendingInvites.map((i: any) => i.email));

    const enriched = employees.map((e: any) => ({
      ...e,
      roles: userMap.get(e.email)?.roles || ["EMPLOYEE"],
      hrmsAccessRole: userMap.get(e.email)?.hrmsAccessRole || "EMPLOYEE",
      isActive: userMap.get(e.email)?.isActive ?? e.isActive,
      avatarKey: userMap.get(e.email)?.avatarKey || "",
      avatarUrl: userMap.get(e.email)?.avatarUrl || "",
      hasLogin: userMap.has(e.email),
      activatedByAdmin: userMap.get(e.email)?.activatedByAdmin || false,
      tempPassword: userMap.get(e.email)?.tempPassword || false,
      lastLoginAt: userMap.get(e.email)?.lastLoginAt || null,
      inviteStatus: userMap.get(e.email)?.lastLoginAt
        ? "ACTIVE"
        : pendingEmails.has(e.email)
          ? "INVITE_PENDING"
          : "NOT_INVITED",
    }));

    const flattened = enriched.map((e: any) => {
      const snap = e.onboardingSnapshot || {};
      const nameParts = (e.fullName || snap.fullName || e.name || "").trim().split(" ");

      return {
        ...e,
        firstName: e.firstName || nameParts[0] || "",
        lastName: e.lastName || nameParts.slice(1).join(" ") || "",
        name: e.fullName || snap.fullName || e.name || "",
        personalContact: e.personalContact || snap.contact?.personalMobile || e.phone || "",
        personalEmail: e.personalEmail || snap.contact?.personalEmail || "",
        officialEmail: e.officialEmail || e.email || "",
        emergencyContactName: e.emergencyContactName || snap.emergency?.name || "",
        emergencyContactNumber: e.emergencyContactNumber || snap.emergency?.mobile || "",
        emergencyContactRelation: e.emergencyContactRelation || snap.emergency?.relationship || "",
        pan: e.pan || snap.ids?.pan || "",
        aadhaar: e.aadhaar || snap.ids?.aadhaar || "",
        voterId: e.voterId || snap.ids?.voterId || "",
        passportNumber: e.passportNumber || snap.ids?.passport || "",
        dateOfBirth: e.dateOfBirth || snap.dateOfBirth || "",
        gender: e.gender || snap.gender || "",
        maritalStatus: e.maritalStatus || snap.employment?.maritalStatus || "",
        currentAddress: e.currentAddress || snap.address?.current || "",
        permanentAddress: e.permanentAddress || snap.address?.permanent || "",
        bankAccountNumber: e.bankAccountNumber || snap.bank?.accountNumber || "",
        bankName: e.bankName || snap.bank?.bankName || "",
        ifsc: e.ifsc || snap.bank?.ifsc || "",
        bankBranch: e.bankBranch || snap.bank?.branch || "",
        highestDegree: e.highestDegree || snap.education?.highestDegree || "",
        institution: e.institution || snap.education?.institution || "",
        joiningDate: e.joiningDate || snap.employment?.dateOfJoining || "",
      };
    });

    return res.json({
      employees: flattened,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/employees/bulk-update
 * Bulk update department, designation, or status for selected employees.
 */
router.post("/bulk-update", requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    if (!isAdminish(req.user)) {
      return res.status(403).json({ error: "Only admins can bulk update employees" });
    }

    const { userIds, updates } = req.body || {};
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: "userIds array is required" });
    }
    if (!updates || typeof updates !== "object") {
      return res.status(400).json({ error: "updates object is required" });
    }

    const $set: any = {};
    if (updates.department !== undefined) $set.department = String(updates.department).trim();
    if (updates.designation !== undefined) $set.designation = String(updates.designation).trim();
    if (updates.status !== undefined) $set.status = String(updates.status).toUpperCase();

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ error: "No valid updates provided" });
    }

    // Update User records — SUPERADMIN can update across workspaces
    const wsScope = !isSuperAdmin(req) && req.workspaceObjectId ? { workspaceId: req.workspaceObjectId } : {};
    const userResult = await User.updateMany(
      { _id: { $in: userIds }, ...wsScope },
      { $set },
    );

    // Also update Employee records (by ownerId match)
    const employeeSet: any = {};
    if ($set.department) employeeSet.department = $set.department;
    if ($set.designation) employeeSet.designation = $set.designation;
    if ($set.status) employeeSet.status = $set.status;

    if (Object.keys(employeeSet).length > 0) {
      await Employee.updateMany(
        { ownerId: { $in: userIds }, ...wsScope },
        { $set: employeeSet },
      );
    }

    return res.json({ updated: userResult.modifiedCount });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/employees
 * Create a new HRMS employee record.
 * - Requires Admin / SuperAdmin.
 * - officialEmail/email is mandatory.
 * - If a user already exists with same email, we update that record instead.
 */
router.post("/", requireAuth, async (req: any, res, next) => {
  try {
    if (!isAdminish(req.user)) {
      return res.status(403).json({ error: "Only admins can create employees" });
    }

    const body = req.body || {};
    const officialEmail: string = String(
      body.officialEmail || body.email || body.personalEmail || ""
    )
      .trim()
      .toLowerCase();

    if (!officialEmail) {
      return res
        .status(400)
        .json({ error: "Official email is required for employee" });
    }

    // Try to find existing user by company email
    let user: AnyUser | null = await User.findOne({ email: officialEmail }).exec();

    const fullName: string =
      body.name ||
      [body.firstName, body.middleName, body.lastName].filter(Boolean).join(" ");

    let employeeCode: string =
      body.employeeCode ||
      (user as any)?.employeeCode ||
      (await generateNextEmployeeCode());

    const hrmsAccessRole: string =
      body.hrmsAccessRole || (user as any)?.hrmsAccessRole || "EMPLOYEE";

    // Build common fields – explicit overrides come AFTER spreading body
    const commonFields: any = {
      ...body,
      name: fullName || undefined,
      firstName: body.firstName || undefined,
      middleName: body.middleName || undefined,
      lastName: body.lastName || undefined,
      employeeCode,
      department: body.department || undefined,
      designation: body.designation || undefined,
      managerName: body.reportingL1 || body.managerName || undefined,
      jobLocation: body.jobLocation || undefined,
      employmentStatus: body.employmentStatus || undefined,
      employeeType: body.employeeType || undefined,
      hrmsAccessRole,
      officialEmail,
      email: officialEmail,
      personalEmail: body.personalEmail || body.personalEmailId || undefined,
    };

    if (user) {
      // UPDATE existing user
      Object.assign(user, commonFields);
      const saved = await user.save();
      return res.json(sanitise(saved));
    }

    // CREATE new user – we must provide a passwordHash.
    const tempPassword =
      "HRMS-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const payload: any = {
      ...commonFields,
      roles:
        Array.isArray(body.roles) && body.roles.length
          ? body.roles
          : ["EMPLOYEE"],
      role: body.role || "EMPLOYEE",
      passwordHash,
      status: "ACTIVE",
    };

    const created = await User.create(payload);

    // ── Optional: send workspace invite ──
    let inviteSent = false;
    if (body.sendInvite && officialEmail && req.workspaceObjectId) {
      try {
        // Check for existing pending invite
        const existingInvite = await WorkspaceInvite.findOne({
          workspaceId: req.workspaceObjectId,
          email: officialEmail,
          status: "pending",
          expiresAt: { $gt: new Date() },
        });

        if (!existingInvite) {
          const token = crypto.randomBytes(32).toString("hex");
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

          await WorkspaceInvite.create({
            workspaceId: req.workspaceObjectId,
            email: officialEmail,
            name: fullName || undefined,
            role: hrmsAccessRole,
            department: body.department || undefined,
            designation: body.designation || undefined,
            invitedBy: req.user._id ?? req.user.id ?? req.user.sub,
            token,
            expiresAt,
            status: "pending",
          });

          const workspace = await CustomerWorkspace.findById(req.workspaceObjectId).select("companyName").lean();
          const inviteUrl = `https://plumbox.plumtrips.com/join?token=${token}`;
          await sendEmployeeInvite(officialEmail, {
            companyName: (workspace as any)?.companyName || "your company",
            inviterName: req.user.name || req.user.email || "HR",
            inviteUrl,
            expiresAt,
          });
          inviteSent = true;
        }
      } catch (inviteErr: any) {
        console.error("[POST /employees] invite send failed:", inviteErr?.message);
      }
    }

    return res.status(201).json({ ...sanitise(created), inviteSent, inviteEmail: officialEmail });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/employees/:id
 * Update an existing employee record.
 * - Requires Admin / SuperAdmin.
 * - Does not allow direct passwordHash changes here.
 */
router.put("/:id", requireAuth, async (req: any, res, next) => {
  try {
    if (!isAdminish(req.user)) {
      return res.status(403).json({ error: "Only admins can edit employees" });
    }

    const { id } = req.params;
    const body = { ...(req.body || {}) };

    // Never allow passwordHash updates from this endpoint
    delete (body as any).passwordHash;

    // First try to find by Employee doc to get ownerId
    const empQuery: any = { _id: id };
    if (!isSuperAdmin(req) && req.workspaceObjectId) empQuery.workspaceId = req.workspaceObjectId;
    const employeeDoc = await Employee.findOne(empQuery).exec();
    const userId = employeeDoc?.ownerId ?? id;
    const existing: AnyUser | null = isSuperAdmin(req)
      ? await User.findById(userId)
      : await scopedFindById(User, userId, req.workspaceObjectId);
    if (!existing) {
      return res.status(404).json({ error: "Employee not found" });
    }

    const officialEmail: string = String(
      body.officialEmail || body.email || existing.email || ""
    )
      .trim()
      .toLowerCase();

    if (!officialEmail) {
      return res
        .status(400)
        .json({ error: "Official email is required for employee" });
    }

    existing.email = officialEmail;
    (existing as any).officialEmail = officialEmail;

    if (body.personalEmail) {
      (existing as any).personalEmail = body.personalEmail;
    }

    if (body.employeeCode) existing.employeeCode = body.employeeCode;

    const {
      _id: _employeeId,
      id: _id,
      __v: _v,
      email: _email,
      officialEmail: _officialEmail,
      passwordHash: _passwordHash,
      refreshToken: _refreshToken,
      roles: _roles,
      role: _role,
      ownerId: _ownerId,
      onboardingId: _onboardingId,
      onboardingSnapshot: _onboardingSnapshot,
      ...safeBody
    } = body;

    Object.assign(existing, safeBody);

    // Sync roles AFTER Object.assign so nothing can overwrite them
    if (body.hrmsAccessRole) {
      const canonical = String(body.hrmsAccessRole).toUpperCase();
      existing.hrmsAccessRole = canonical;
      existing.roles =
        canonical === "EMPLOYEE" ? ["EMPLOYEE"] : ["EMPLOYEE", canonical];
      existing.markModified("roles");
    }

    console.log("[PUT /employees/:id] PRE-SAVE →", {
      id: existing._id?.toString(),
      email: existing.email,
      roles: existing.roles,
      hrmsAccessRole: existing.hrmsAccessRole,
    });

    const saved = await existing.save();

    console.log("[PUT /employees/:id] POST-SAVE →", {
      id: saved._id?.toString(),
      roles: saved.roles,
      hrmsAccessRole: saved.hrmsAccessRole,
    });

    res.json(sanitise(saved));
  } catch (err) {
    next(err);
  }
});

export default router;
