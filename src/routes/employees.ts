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
import { validateObjectId } from "../middleware/validateObjectId.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { sendEmployeeInvite } from "../services/email.service.js";
import { UserPermission } from "../models/UserPermission.js";
import { LEVEL_TEMPLATES } from "../config/levelTemplates.js";
import { sendCredentialsEmail } from "../utils/credentialsEmail.js";
import crypto from "crypto";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";
import { HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
    ...(user.hrmsAccessLevel ? [user.hrmsAccessLevel] : []),
  ]
    .filter(Boolean)
    .map((r) => String(r).toUpperCase());

  return roles.some((r) =>
    ["ADMIN", "SUPERADMIN", "SUPER_ADMIN", "HR", "HR_MANAGER", "HR_ADMIN"].includes(r)
  );
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
    const limit = req.query.rmEligible === "true"
      ? 200
      : Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10)));

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
    if (req.query.rmEligible === "true") filter["relationshipManager.isEligible"] = true;
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
      .select("-passwordHash -resetTokenHash -resetTokenExpiry")
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
      firstName: userMap.get(e.email)?.firstName || e.firstName || "",
      lastName:  userMap.get(e.email)?.lastName  || e.lastName  || "",
      name:      userMap.get(e.email)?.name      || e.fullName  || e.name || "",
      // ── PERSONAL ─────────────────────────────────────────────────
      middleName:               userMap.get(e.email)?.middleName               || e.middleName               || "",
      dateOfBirth:              userMap.get(e.email)?.dateOfBirth              || e.dateOfBirth              || "",
      gender:                   userMap.get(e.email)?.gender                   || e.gender                   || "",
      maritalStatus:            userMap.get(e.email)?.maritalStatus            || e.maritalStatus            || "",
      nationality:              userMap.get(e.email)?.nationality              || e.nationality              || "",
      bloodGroup:               userMap.get(e.email)?.bloodGroup               || e.bloodGroup               || "",
      permanentAddress:         userMap.get(e.email)?.permanentAddress         || e.permanentAddress         || "",
      currentAddress:           userMap.get(e.email)?.currentAddress           || e.currentAddress           || "",
      phone:                    userMap.get(e.email)?.phone                    || e.phone                    || "",
      personalContact:          userMap.get(e.email)?.personalContact          || e.personalContact          || "",
      personalEmail:            userMap.get(e.email)?.personalEmail            || e.personalEmail            || "",
      emergencyContactName:     userMap.get(e.email)?.emergencyContactName     || e.emergencyContactName     || "",
      emergencyContactNumber:   userMap.get(e.email)?.emergencyContactNumber   || e.emergencyContactNumber   || "",
      emergencyContactRelation: userMap.get(e.email)?.emergencyContactRelation || e.emergencyContactRelation || "",
      photoUrl:                 userMap.get(e.email)?.photoUrl                 || e.photoUrl                 || "",
      pan:                      userMap.get(e.email)?.pan                      || e.pan                      || "",
      aadhaar:                  userMap.get(e.email)?.aadhaar                  || e.aadhaar                  || "",
      passportNumber:           userMap.get(e.email)?.passportNumber           || e.passportNumber           || "",
      passportExpiry:           userMap.get(e.email)?.passportExpiry           || e.passportExpiry           || "",
      voterId:                  userMap.get(e.email)?.voterId                  || e.voterId                  || "",
      disabilityStatus:         userMap.get(e.email)?.disabilityStatus         || e.disabilityStatus         || "",
      // ── EMPLOYMENT ───────────────────────────────────────────────
      officialEmail:            userMap.get(e.email)?.officialEmail            || e.officialEmail            || "",
      employeeCode:             userMap.get(e.email)?.employeeCode             || e.employeeCode             || "",
      department:               userMap.get(e.email)?.department               || e.department               || "",
      designation:              userMap.get(e.email)?.designation              || e.designation              || "",
      employeeType:             userMap.get(e.email)?.employeeType             || e.employeeType             || "",
      dateOfJoining:            userMap.get(e.email)?.dateOfJoining            || e.dateOfJoining            || "",
      dateOfConfirmation:       userMap.get(e.email)?.dateOfConfirmation       || e.dateOfConfirmation       || "",
      reportingL1:              userMap.get(e.email)?.reportingL1              || e.reportingL1              || "",
      reportingL2:              userMap.get(e.email)?.reportingL2              || e.reportingL2              || "",
      reportingL3:              userMap.get(e.email)?.reportingL3              || e.reportingL3              || "",
      managerName:              userMap.get(e.email)?.managerName              || e.managerName              || "",
      jobLocation:              userMap.get(e.email)?.jobLocation              || e.jobLocation              || "",
      employmentStatus:         userMap.get(e.email)?.employmentStatus         || e.employmentStatus         || "",
      shiftDetails:             userMap.get(e.email)?.shiftDetails             || e.shiftDetails             || "",
      probationPeriod:          userMap.get(e.email)?.probationPeriod          || e.probationPeriod          || "",
      contractStartDate:        userMap.get(e.email)?.contractStartDate        || e.contractStartDate        || "",
      contractEndDate:          userMap.get(e.email)?.contractEndDate          || e.contractEndDate          || "",
      exitDate:                 userMap.get(e.email)?.exitDate                 || e.exitDate                 || "",
      exitReason:               userMap.get(e.email)?.exitReason               || e.exitReason               || "",
      supervisorDetails:        userMap.get(e.email)?.supervisorDetails        || e.supervisorDetails        || "",
      // ── BANK & STATUTORY ─────────────────────────────────────────
      bankName:                 userMap.get(e.email)?.bankName                 || e.bankName                 || "",
      bankAccountNumber:        userMap.get(e.email)?.bankAccountNumber        || e.bankAccountNumber        || "",
      bankIfsc:                 userMap.get(e.email)?.bankIfsc                 || e.bankIfsc                 || "",
      pfNumber:                 userMap.get(e.email)?.pfNumber                 || e.pfNumber                 || "",
      uanNumber:                userMap.get(e.email)?.uanNumber                || e.uanNumber                || "",
      esiNumber:                userMap.get(e.email)?.esiNumber                || e.esiNumber                || "",
      salaryPaymentMode:        userMap.get(e.email)?.salaryPaymentMode        || e.salaryPaymentMode        || "",
      // ── ATTENDANCE & LEAVE ───────────────────────────────────────
      attendanceNotes:          userMap.get(e.email)?.attendanceNotes          || e.attendanceNotes          || "",
      wfhRecords:               userMap.get(e.email)?.wfhRecords               || e.wfhRecords               || "",
      shiftPatterns:            userMap.get(e.email)?.shiftPatterns            || e.shiftPatterns            || "",
      timesheetDetails:         userMap.get(e.email)?.timesheetDetails         || e.timesheetDetails         || "",
      holidayCalendarReference: userMap.get(e.email)?.holidayCalendarReference || e.holidayCalendarReference || "",
      leaveEntitlements:        userMap.get(e.email)?.leaveEntitlements        || e.leaveEntitlements        || "",
      leaveHistoryNotes:        userMap.get(e.email)?.leaveHistoryNotes        || e.leaveHistoryNotes        || "",
      // ── LEARNING & PERFORMANCE ───────────────────────────────────
      educationalQualifications:  userMap.get(e.email)?.educationalQualifications  || e.educationalQualifications  || "",
      professionalCertifications: userMap.get(e.email)?.professionalCertifications || e.professionalCertifications || "",
      trainingHistory:            userMap.get(e.email)?.trainingHistory            || e.trainingHistory            || "",
      skills:                     userMap.get(e.email)?.skills                     || e.skills                     || "",
      performanceAppraisals:      userMap.get(e.email)?.performanceAppraisals      || e.performanceAppraisals      || "",
      promotionsTransfers:        userMap.get(e.email)?.promotionsTransfers        || e.promotionsTransfers        || "",
      disciplinaryRecords:        userMap.get(e.email)?.disciplinaryRecords        || e.disciplinaryRecords        || "",
      rewardsRecognition:         userMap.get(e.email)?.rewardsRecognition         || e.rewardsRecognition         || "",
      employmentContracts:        userMap.get(e.email)?.employmentContracts        || e.employmentContracts        || "",
      ndaOrNonCompete:            userMap.get(e.email)?.ndaOrNonCompete            || e.ndaOrNonCompete            || "",
      backgroundVerification:     userMap.get(e.email)?.backgroundVerification     || e.backgroundVerification     || "",
      medicalHealthRecords:       userMap.get(e.email)?.medicalHealthRecords       || e.medicalHealthRecords       || "",
      workPermits:                userMap.get(e.email)?.workPermits                || e.workPermits                || "",
      legalNotices:               userMap.get(e.email)?.legalNotices               || e.legalNotices               || "",
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

      return {
        ...e,
        firstName: e.firstName || "",
        lastName: e.lastName || "",
        name: e.fullName || [e.firstName, e.lastName].filter(Boolean).join(" ") || e.name || "",
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
router.post("/", requireAuth, requireWorkspace, async (req: any, res, next) => {
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

    // Try to find existing user by company email — scoped to workspace to prevent cross-tenant contamination
    let user: AnyUser | null = await User.findOne({ email: officialEmail, workspaceId: req.workspaceObjectId }).exec();

    const fullName: string =
      body.name ||
      [body.firstName, body.middleName, body.lastName].filter(Boolean).join(" ");

    let employeeCode: string =
      body.employeeCode ||
      (user as any)?.employeeCode ||
      (await generateNextEmployeeCode());

    const hrmsAccessRole: string =
      body.hrmsAccessRole || (user as any)?.hrmsAccessRole || "EMPLOYEE";

    // Build common fields – whitelist allowed fields
    const ALLOWED_EMPLOYEE_FIELDS = [
      "firstName", "middleName", "lastName", "name",
      "phone", "personalContact", "personalEmail", "personalEmailId",
      "department", "designation", "dateOfJoining", "dateOfBirth",
      "employmentType", "employeeType", "employmentStatus",
      "reportingManager", "reportingL1", "managerName",
      "jobLocation", "gender", "maritalStatus",
      "currentAddress", "permanentAddress",
      "pan", "aadhaar", "voterId", "passportNumber",
      "bankAccountNumber", "bankName", "ifsc", "bankBranch",
      "highestDegree", "institution",
      "emergencyContactName", "emergencyContactNumber", "emergencyContactRelation",
      "sendInvite",
    ] as const;
    const commonFields: any = {};
    for (const field of ALLOWED_EMPLOYEE_FIELDS) {
      if (body[field] !== undefined) commonFields[field] = body[field];
    }
    // Always set these derived fields
    commonFields.name = fullName || undefined;
    commonFields.firstName = body.firstName || undefined;
    commonFields.middleName = body.middleName || undefined;
    commonFields.lastName = body.lastName || undefined;
    commonFields.employeeCode = employeeCode;
    commonFields.department = body.department || undefined;
    commonFields.designation = body.designation || undefined;
    commonFields.managerName = body.reportingL1 || body.managerName || undefined;
    commonFields.jobLocation = body.jobLocation || undefined;
    commonFields.employmentStatus = body.employmentStatus || undefined;
    commonFields.employeeType = body.employeeType || undefined;
    commonFields.hrmsAccessRole = hrmsAccessRole;
    commonFields.officialEmail = officialEmail;
    commonFields.email = officialEmail;
    commonFields.personalEmail = body.personalEmail || body.personalEmailId || undefined;
    commonFields.workspaceId = req.workspaceObjectId;

    if (user) {
      // UPDATE existing user
      Object.assign(user, commonFields);
      const saved = await user.save();

      // Create UserPermission if this user doesn't have one yet
      try {
        const existingPerm = await UserPermission.findOne({ userId: String(user._id) }).lean();
        if (!existingPerm) {
          await UserPermission.create({
            userId: String(user._id),
            email: officialEmail,
            workspaceId: String(req.workspaceObjectId),
            universe: "STAFF",
            level: { code: "L1", name: "Employee", designation: "" },
            modules: { ...LEVEL_TEMPLATES["L1"] },
            tier: 1,
            roleType: "EMPLOYEE",
            source: "system",
            status: "active",
            grantedBy: req.user?.email || String(req.user?._id || "system"),
            grantedAt: new Date(),
          });
        }
      } catch (permErr: any) {
        console.error("[POST /employees] UserPermission create for existing user failed:", permErr?.message);
      }

      return res.json(sanitise(saved));
    }

    // CREATE new user – we must provide a passwordHash.
    const tempPassword = "Welcome@123";
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

    // ── Auto-create UserPermission with L1 (Employee) defaults ──
    try {
      const existingPerm = await UserPermission.findOne({ userId: String(created._id) }).lean();
      if (!existingPerm) {
        await UserPermission.create({
          userId: String(created._id),
          email: officialEmail,
          workspaceId: String(req.workspaceObjectId),
          universe: "STAFF",
          level: { code: "L1", name: "Employee", designation: "" },
          modules: { ...LEVEL_TEMPLATES["L1"] },
          tier: 1,
          roleType: "EMPLOYEE",
          source: "system",
          status: "active",
          grantedBy: req.user?.email || String(req.user?._id || "system"),
          grantedAt: new Date(),
        });
      }
    } catch (permErr: any) {
      console.error("[POST /employees] UserPermission auto-create failed:", permErr?.message);
    }

    // ── Send welcome email with credentials ──
    try {
      const loginUrl = String(process.env.FRONTEND_ORIGIN || "http://localhost:5173").replace(/\/+$/, "");
      await sendCredentialsEmail({
        to: officialEmail,
        name: fullName || officialEmail,
        officialEmail,
        tempPassword,
        loginUrl,
        employeeCode: (created as any).employeeCode || employeeCode || "",
      });
    } catch (emailErr: any) {
      console.error("[POST /employees] welcome email failed:", emailErr?.message);
    }

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
 * POST /api/employees/:id/avatar/confirm
 * Saves an uploaded S3 avatar key to a specific employee's User record.
 * Requires Admin / HR. Called after frontend PUT-to-S3 presign flow.
 * Body: { key: "avatars/..." }
 * Returns: { avatarKey, avatarUrl }
 */
router.post("/:id/avatar/confirm", validateObjectId("id"), requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    if (!isAdminish(req.user)) {
      return res.status(403).json({ error: "Only admins or HR can update employee avatars" });
    }

    const { id } = req.params;
    const { key } = req.body || {};
    if (!key || typeof key !== "string" || !key.startsWith("avatars/")) {
      return res.status(400).json({ error: "key is required and must begin with avatars/" });
    }

    // Resolve employee → user
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

    // Verify object exists in S3 before committing
    try {
      await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    } catch {
      return res.status(404).json({ error: "Avatar object not found on S3" });
    }

    await User.findByIdAndUpdate(userId, {
      $set: { avatarKey: key, avatarUpdatedAt: new Date(), avatarUrl: "" },
    });

    const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
    const avatarUrl = await getSignedUrl(s3, cmd, { expiresIn: env.PRESIGN_TTL || 3600 });

    res.json({ avatarKey: key, avatarUrl });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/employees/:id
 * Update an existing employee record.
 * - Requires Admin / HR.
 * - Does not allow direct passwordHash changes here.
 */
router.put("/:id", validateObjectId("id"), requireAuth, requireWorkspace, async (req: any, res, next) => {
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
    let employeeDoc = await Employee.findOne(empQuery).exec();

    // Fallback for docs with missing workspaceId (SuperAdmin only)
    if (!employeeDoc && isSuperAdmin(req)) {
      employeeDoc = await Employee.findOne({ _id: id }).exec();
    }

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

    // Mirror reporting fields — keep both in sync
    if (safeBody.reportingL1 !== undefined) {
      existing.managerName = safeBody.reportingL1;
    }
    if (safeBody.managerName !== undefined && !safeBody.reportingL1) {
      existing.reportingL1 = safeBody.managerName;
    }
    if (safeBody.managerL1 !== undefined) {
      existing.reportingL1 = safeBody.managerL1;
      existing.managerName = safeBody.managerL1;
    }

    // Sync roles AFTER Object.assign so nothing can overwrite them
    if (body.hrmsAccessRole) {
      const canonical = String(body.hrmsAccessRole).toUpperCase();
      existing.hrmsAccessRole = canonical;
      existing.roles =
        canonical === "EMPLOYEE" ? ["EMPLOYEE"] : ["EMPLOYEE", canonical];
      existing.markModified("roles");
    }

    const saved = await existing.save();

    // Update Employee doc for fields that live on Employee schema
    const employeeFields: any = {};

    if (safeBody.relationshipManager !== undefined) {
      employeeFields.relationshipManager = safeBody.relationshipManager;
    }

    if (employeeDoc && Object.keys(employeeFields).length > 0) {
      await Employee.findByIdAndUpdate(
        employeeDoc._id,
        { $set: employeeFields },
        { new: true }
      );
    }

    res.json(sanitise(saved));
  } catch (err) {
    next(err);
  }
});

export default router;
