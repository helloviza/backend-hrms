// apps/backend/src/routes/employees.ts
import { Router } from "express";
import bcrypt from "bcryptjs";
import { requireAuth } from "../middleware/auth.js";
import User from "../models/User.js";
import Employee from "../models/Employee.js";

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
 * List all HRMS employees (for TeamProfiles page).
 */
router.get("/", requireAuth, async (_req, res, next) => {
  try {
    const employees = await Employee.find({})
      .sort({ employeeCode: 1, createdAt: 1 })
      .lean();

    const emails = employees.map((e: any) => e.email).filter(Boolean);
    const users = await User.find({ email: { $in: emails } })
      .select("email roles hrmsAccessRole isActive activatedByAdmin tempPassword avatarKey avatarUrl")
      .lean();

    const userMap = new Map(users.map((u: any) => [u.email, u]));

    // Debug: log raw User fields for role verification
    for (const u of users) {
      console.log("[GET /employees] User →", {
        email: (u as any).email,
        roles: (u as any).roles,
        hrmsAccessRole: (u as any).hrmsAccessRole,
      });
    }

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
    }));

    const flattened = enriched.map((e: any) => {
      const snap = e.onboardingSnapshot || {};
      const nameParts = (e.fullName || snap.fullName || e.name || "").trim().split(" ");

      return {
        ...e,
        // Name fields
        firstName: e.firstName || nameParts[0] || "",
        lastName: e.lastName || nameParts.slice(1).join(" ") || "",
        name: e.fullName || snap.fullName || e.name || "",

        // Contact
        personalContact: e.personalContact || snap.contact?.personalMobile || e.phone || "",
        personalEmail: e.personalEmail || snap.contact?.personalEmail || "",
        officialEmail: e.officialEmail || e.email || "",

        // Emergency
        emergencyContactName: e.emergencyContactName || snap.emergency?.name || "",
        emergencyContactNumber: e.emergencyContactNumber || snap.emergency?.mobile || "",
        emergencyContactRelation: e.emergencyContactRelation || snap.emergency?.relationship || "",

        // IDs
        pan: e.pan || snap.ids?.pan || "",
        aadhaar: e.aadhaar || snap.ids?.aadhaar || "",
        voterId: e.voterId || snap.ids?.voterId || "",
        passportNumber: e.passportNumber || snap.ids?.passport || "",

        // Personal
        dateOfBirth: e.dateOfBirth || snap.dateOfBirth || "",
        gender: e.gender || snap.gender || "",
        maritalStatus: e.maritalStatus || snap.employment?.maritalStatus || "",

        // Address
        currentAddress: e.currentAddress || snap.address?.current || "",
        permanentAddress: e.permanentAddress || snap.address?.permanent || "",

        // Bank
        bankAccountNumber: e.bankAccountNumber || snap.bank?.accountNumber || "",
        bankName: e.bankName || snap.bank?.bankName || "",
        ifsc: e.ifsc || snap.bank?.ifsc || "",
        bankBranch: e.bankBranch || snap.bank?.branch || "",

        // Education
        highestDegree: e.highestDegree || snap.education?.highestDegree || "",
        institution: e.institution || snap.education?.institution || "",

        // Employment
        joiningDate: e.joiningDate || snap.employment?.dateOfJoining || "",
      };
    });

    return res.json(flattened);
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
    return res.status(201).json(sanitise(created));
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
    const employeeDoc = await Employee.findById(id).exec();
    const userId = employeeDoc?.ownerId ?? id;
    const existing: AnyUser | null = await User.findById(userId).exec();
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
