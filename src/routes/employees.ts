// apps/backend/src/routes/employees.ts
import { Router } from "express";
import multer from "multer";
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
import { parseCsv } from "../utils/csv.js";
import * as XLSX from "xlsx";
import crypto from "crypto";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";
import { HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const router = Router();

const bulkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const ok =
      /\.(csv|xlsx|xls)$/i.test(file.originalname || "") ||
      /text\/csv|spreadsheet|excel/i.test(file.mimetype || "");
    cb(null, ok);
  },
});

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
    ["ADMIN", "SUPERADMIN", "SUPER_ADMIN", "HR", "HR_MANAGER", "HR_ADMIN", "TENANT_ADMIN"].includes(r)
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
      // ── ASSETS / NOTES / MISC (Assets tab) ───────────────────────
      companyAssets:        userMap.get(e.email)?.companyAssets        || (e as any).companyAssets        || "",
      assetReturnRecords:   userMap.get(e.email)?.assetReturnRecords   || (e as any).assetReturnRecords   || "",
      employeeNotes:        userMap.get(e.email)?.employeeNotes        || (e as any).employeeNotes        || "",
      portalAccessDetails:  userMap.get(e.email)?.portalAccessDetails  || (e as any).portalAccessDetails  || "",
      bankLoanDetails:      userMap.get(e.email)?.bankLoanDetails      || (e as any).bankLoanDetails      || "",
      travelExpenseRecords: userMap.get(e.email)?.travelExpenseRecords || (e as any).travelExpenseRecords || "",
      exitInterviewDetails: userMap.get(e.email)?.exitInterviewDetails || (e as any).exitInterviewDetails || "",
      documentRepository:   userMap.get(e.email)?.documentRepository   || (e as any).documentRepository   || "",
      // ── TAX (Bank tab — distinct from Personal tab `pan`) ────────
      taxPan:               userMap.get(e.email)?.taxPan               || (e as any).taxPan               || "",
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
 * Bulk-import column dictionary. Order here defines column order in the Excel
 * template. Aliases let HR upload mildly different header casings/snake_case
 * variants without manual normalization.
 */
const BULK_COLUMNS: Array<{ field: string; aliases: string[] }> = [
  // ── Core identity (8) ──
  { field: "email",           aliases: ["email", "Email", "EMAIL", "officialEmail", "official_email"] },
  { field: "firstName",       aliases: ["firstName", "first_name", "FirstName", "firstname"] },
  { field: "lastName",        aliases: ["lastName", "last_name", "LastName", "lastname"] },
  { field: "phone",           aliases: ["phone", "Phone", "PHONE", "mobile", "Mobile"] },
  { field: "personalEmail",   aliases: ["personalEmail", "personal_email", "PersonalEmail"] },
  { field: "personalContact", aliases: ["personalContact", "personal_contact", "personalMobile", "personal_mobile"] },
  { field: "name",            aliases: ["name", "Name", "fullName", "full_name"] },
  { field: "middleName",      aliases: ["middleName", "middle_name", "MiddleName"] },

  // ── Employment (10) ──
  { field: "employeeCode",       aliases: ["employeeCode", "employee_code", "EmployeeCode", "empCode"] },
  { field: "designation",        aliases: ["designation", "Designation", "jobTitle", "job_title"] },
  { field: "department",         aliases: ["department", "Department"] },
  { field: "dateOfJoining",      aliases: ["dateOfJoining", "date_of_joining", "DateOfJoining", "DOJ", "doj", "joiningDate", "joining_date"] },
  { field: "employeeType",       aliases: ["employeeType", "employee_type", "EmployeeType", "employmentType", "employment_type"] },
  { field: "employmentStatus",   aliases: ["employmentStatus", "employment_status", "EmploymentStatus"] },
  { field: "jobLocation",        aliases: ["jobLocation", "job_location", "JobLocation", "location", "Location"] },
  { field: "hrmsAccessRole",     aliases: ["hrmsAccessRole", "hrms_access_role", "HrmsAccessRole", "accessRole"] },
  { field: "dateOfConfirmation", aliases: ["dateOfConfirmation", "date_of_confirmation", "DateOfConfirmation"] },
  { field: "probationPeriod",    aliases: ["probationPeriod", "probation_period", "ProbationPeriod"] },

  // ── Reporting (3) ──
  { field: "managerEmail", aliases: ["managerEmail", "manager_email", "ManagerEmail", "reportingManagerEmail"] },
  { field: "reportingL1",  aliases: ["reportingL1", "reporting_l1", "ReportingL1", "managerName", "manager_name"] },
  { field: "reportingL2",  aliases: ["reportingL2", "reporting_l2", "ReportingL2"] },

  // ── Personal (6) ──
  { field: "dateOfBirth",      aliases: ["dateOfBirth", "date_of_birth", "DateOfBirth", "DOB", "dob"] },
  { field: "gender",           aliases: ["gender", "Gender"] },
  { field: "maritalStatus",    aliases: ["maritalStatus", "marital_status", "MaritalStatus"] },
  { field: "nationality",      aliases: ["nationality", "Nationality"] },
  { field: "bloodGroup",       aliases: ["bloodGroup", "blood_group", "BloodGroup"] },
  { field: "disabilityStatus", aliases: ["disabilityStatus", "disability_status", "DisabilityStatus"] },

  // ── Identity documents (4) ──
  { field: "pan",            aliases: ["pan", "PAN", "Pan", "panNumber", "pan_number"] },
  { field: "aadhaar",        aliases: ["aadhaar", "Aadhaar", "AADHAAR", "aadhar", "Aadhar", "aadhaarNumber"] },
  { field: "voterId",        aliases: ["voterId", "voter_id", "VoterId", "VoterID"] },
  { field: "passportNumber", aliases: ["passportNumber", "passport_number", "PassportNumber", "passport"] },

  // ── Bank (4) ──
  { field: "bankName",          aliases: ["bankName", "bank_name", "BankName"] },
  { field: "bankAccountNumber", aliases: ["bankAccountNumber", "bank_account_number", "BankAccountNumber", "accountNumber", "account_number"] },
  { field: "bankIfsc",          aliases: ["bankIfsc", "bank_ifsc", "BankIfsc", "ifsc", "IFSC", "Ifsc"] },
  { field: "bankBranch",        aliases: ["bankBranch", "bank_branch", "BankBranch", "branch", "Branch"] },

  // ── Address (2) ──
  { field: "currentAddress",   aliases: ["currentAddress", "current_address", "CurrentAddress"] },
  { field: "permanentAddress", aliases: ["permanentAddress", "permanent_address", "PermanentAddress"] },

  // ── Emergency contact (3) ──
  { field: "emergencyContactName",     aliases: ["emergencyContactName", "emergency_contact_name", "EmergencyContactName"] },
  { field: "emergencyContactNumber",   aliases: ["emergencyContactNumber", "emergency_contact_number", "EmergencyContactNumber"] },
  { field: "emergencyContactRelation", aliases: ["emergencyContactRelation", "emergency_contact_relation", "EmergencyContactRelation"] },

  // ── Education (2) ──
  { field: "highestDegree", aliases: ["highestDegree", "highest_degree", "HighestDegree"] },
  { field: "institution",   aliases: ["institution", "Institution", "school", "college", "university"] },

  // ── Statutory (3) ──
  { field: "pfNumber",  aliases: ["pfNumber", "pf_number", "PfNumber", "PF"] },
  { field: "uanNumber", aliases: ["uanNumber", "uan_number", "UanNumber", "UAN"] },
  { field: "esiNumber", aliases: ["esiNumber", "esi_number", "EsiNumber", "ESI"] },
];

const COLUMN_ALIASES: Record<string, string[]> = Object.fromEntries(
  BULK_COLUMNS.map((c) => [c.field, c.aliases]),
);

/**
 * Fields on User schema that we set during bulk import.
 * managerEmail is resolved to managerId in pass 2 and not written directly.
 * email/officialEmail/hrmsAccessRole/hrmsAccessLevel are set explicitly
 * outside this list.
 */
const USER_BULK_WRITE_FIELDS = [
  "firstName", "middleName", "lastName", "name", "phone",
  "personalEmail", "personalContact",
  "department", "designation", "employeeCode", "employeeType", "employmentStatus",
  "jobLocation",
  "dateOfJoining", "dateOfConfirmation", "probationPeriod",
  "reportingL1", "reportingL2",
  "dateOfBirth", "gender", "maritalStatus", "nationality", "bloodGroup", "disabilityStatus",
  "pan", "aadhaar", "voterId", "passportNumber",
  "bankName", "bankAccountNumber", "bankIfsc", "bankBranch",
  "currentAddress", "permanentAddress",
  "emergencyContactName", "emergencyContactNumber", "emergencyContactRelation",
  "highestDegree", "institution",
  "pfNumber", "uanNumber", "esiNumber",
];

function getCol(row: Record<string, string>, fieldName: string): string {
  const aliases = COLUMN_ALIASES[fieldName] || [fieldName];
  for (const alias of aliases) {
    const v = (row as any)[alias];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return "";
}

/**
 * GET /api/employees/bulk/template
 * Returns an Excel workbook with a header row, two example rows, and a Notes sheet
 * describing each column. Admin-only.
 */
router.get(
  "/bulk/template",
  requireAuth,
  requireWorkspace,
  async (req: any, res, next) => {
    try {
      if (!isAdminish(req.user)) return res.status(403).json({ error: "Forbidden" });

      const wb = XLSX.utils.book_new();

      const headers = BULK_COLUMNS.map((c) => c.field);
      const sample1: Record<string, string> = {
        email: "rohan.sharma@plumtrips.com", firstName: "Rohan", lastName: "Sharma",
        phone: "9876543210", personalEmail: "rohan.personal@gmail.com", personalContact: "9988776655",
        name: "Rohan Sharma", middleName: "",
        employeeCode: "PTS001031", designation: "Software Engineer", department: "Engineering",
        dateOfJoining: "2026-04-01", employeeType: "Permanent", employmentStatus: "Active",
        jobLocation: "Mumbai", hrmsAccessRole: "EMPLOYEE",
        dateOfConfirmation: "2026-07-01", probationPeriod: "3 months",
        managerEmail: "priya.iyer@plumtrips.com", reportingL1: "Priya Iyer", reportingL2: "",
        dateOfBirth: "1995-08-15", gender: "Male", maritalStatus: "Single",
        nationality: "Indian", bloodGroup: "B+", disabilityStatus: "",
        pan: "ABCDE1234F", aadhaar: "123456789012", voterId: "", passportNumber: "M9876543",
        bankName: "HDFC Bank", bankAccountNumber: "50100123456789", bankIfsc: "HDFC0001234", bankBranch: "Andheri East",
        currentAddress: "Flat 12, Andheri West, Mumbai 400058", permanentAddress: "Same as current",
        emergencyContactName: "Anita Sharma", emergencyContactNumber: "9123456780", emergencyContactRelation: "Mother",
        highestDegree: "B.Tech", institution: "IIT Bombay",
        pfNumber: "MH/PUN/12345/678", uanNumber: "100123456789", esiNumber: "1234567890",
      };
      const sample2: Record<string, string> = {
        email: "priya.iyer@plumtrips.com", firstName: "Priya", lastName: "Iyer",
        phone: "9876543211", personalEmail: "priya.personal@gmail.com", personalContact: "9988776644",
        name: "Priya Iyer", middleName: "",
        employeeCode: "PTS001032", designation: "HR Manager", department: "HR",
        dateOfJoining: "2026-03-15", employeeType: "Permanent", employmentStatus: "Active",
        jobLocation: "Bengaluru", hrmsAccessRole: "HR",
        dateOfConfirmation: "2026-06-15", probationPeriod: "3 months",
        managerEmail: "", reportingL1: "", reportingL2: "",
        dateOfBirth: "1990-12-10", gender: "Female", maritalStatus: "Married",
        nationality: "Indian", bloodGroup: "O+", disabilityStatus: "",
        pan: "FGHIJ5678K", aadhaar: "987654321012", voterId: "", passportNumber: "P1234567",
        bankName: "ICICI Bank", bankAccountNumber: "002701123456", bankIfsc: "ICIC0000027", bankBranch: "Indiranagar",
        currentAddress: "23, Indiranagar 5th Stage, Bengaluru 560038",
        permanentAddress: "23, Indiranagar 5th Stage, Bengaluru 560038",
        emergencyContactName: "Ravi Iyer", emergencyContactNumber: "9123456790", emergencyContactRelation: "Spouse",
        highestDegree: "MBA HR", institution: "XLRI Jamshedpur",
        pfNumber: "KA/BLR/54321/123", uanNumber: "100987654321", esiNumber: "9876543210",
      };
      const data: any[][] = [
        headers,
        headers.map((h) => sample1[h] ?? ""),
        headers.map((h) => sample2[h] ?? ""),
      ];
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws["!cols"] = headers.map((h) => {
        if (h === "email" || h === "personalEmail" || h === "managerEmail") return { wch: 32 };
        if (h === "currentAddress" || h === "permanentAddress") return { wch: 40 };
        if (h === "emergencyContactName" || h === "emergencyContactRelation") return { wch: 22 };
        return { wch: 18 };
      });
      XLSX.utils.book_append_sheet(wb, ws, "Employees");

      const notes: any[][] = [["Column", "Required?", "Description"]];
      const sep = (label: string) => notes.push(["", "", `── ${label} ──`]);
      const add = (col: string, req: string, desc: string) => notes.push([col, req, desc]);

      sep("Core identity");
      add("email", "Yes", "Employee's official email — must be unique within workspace");
      add("firstName", "Yes", "First name");
      add("lastName", "No", "Last name");
      add("phone", "No", "Mobile number (10 digits, no country code)");
      add("personalEmail", "No", "Personal/private email address");
      add("personalContact", "No", "Personal mobile number");
      add("name", "No", "Full name (auto-derived from firstName + lastName if blank)");
      add("middleName", "No", "Middle name");

      notes.push(["", "", ""]);
      sep("Employment");
      add("employeeCode", "No", "Internal employee code (auto-generated if blank)");
      add("designation", "No", "Job title");
      add("department", "No", "Department name (e.g. Engineering, HR, Sales)");
      add("dateOfJoining", "No", "ISO date format YYYY-MM-DD");
      add("employeeType", "No", "Permanent / Contract / Intern / Consultant");
      add("employmentStatus", "No", "Active / Probation / Resigned / Terminated");
      add("jobLocation", "No", "Office location or city");
      add("hrmsAccessRole", "No", "EMPLOYEE (default), MANAGER, or HR");
      add("dateOfConfirmation", "No", "ISO date YYYY-MM-DD — confirmation after probation");
      add("probationPeriod", "No", "Probation duration (e.g. '3 months', '6 months')");

      notes.push(["", "", ""]);
      sep("Reporting");
      add("managerEmail", "No", "Email of reporting manager. Resolved to managerId after import. If manager not found, row still succeeds and a warning is logged.");
      add("reportingL1", "No", "L1 manager name (display string)");
      add("reportingL2", "No", "L2 manager name (display string)");

      notes.push(["", "", ""]);
      sep("Personal");
      add("dateOfBirth", "No", "ISO date YYYY-MM-DD");
      add("gender", "No", "Male / Female / Other");
      add("maritalStatus", "No", "Single / Married / Divorced / Widowed");
      add("nationality", "No", "Country of nationality");
      add("bloodGroup", "No", "A+, A-, B+, B-, O+, O-, AB+, AB-");
      add("disabilityStatus", "No", "Disability status if applicable");

      notes.push(["", "", ""]);
      sep("Identity documents");
      add("pan", "No", "10 chars uppercase alphanumeric (Indian PAN)");
      add("aadhaar", "No", "12 digits, no spaces (Indian Aadhaar)");
      add("voterId", "No", "Voter ID number");
      add("passportNumber", "No", "Passport number");

      notes.push(["", "", ""]);
      sep("Bank");
      add("bankName", "No", "Bank name");
      add("bankAccountNumber", "No", "Account number");
      add("bankIfsc", "No", "11-char IFSC code (e.g. HDFC0001234)");
      add("bankBranch", "No", "Branch name (kept on profile snapshot)");

      notes.push(["", "", ""]);
      sep("Address");
      add("currentAddress", "No", "Current residential address (full)");
      add("permanentAddress", "No", "Permanent address (full)");

      notes.push(["", "", ""]);
      sep("Emergency contact");
      add("emergencyContactName", "No", "Emergency contact full name");
      add("emergencyContactNumber", "No", "Emergency contact phone number");
      add("emergencyContactRelation", "No", "Relation (e.g. Spouse, Parent, Sibling)");

      notes.push(["", "", ""]);
      sep("Education");
      add("highestDegree", "No", "Highest degree completed (e.g. B.Tech, M.Sc, MBA)");
      add("institution", "No", "Name of college/university");

      notes.push(["", "", ""]);
      sep("Statutory");
      add("pfNumber", "No", "Provident Fund number");
      add("uanNumber", "No", "Universal Account Number");
      add("esiNumber", "No", "ESI number");

      const notesWs = XLSX.utils.aoa_to_sheet(notes);
      notesWs["!cols"] = [{ wch: 26 }, { wch: 12 }, { wch: 80 }];
      XLSX.utils.book_append_sheet(wb, notesWs, "Notes");

      const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", 'attachment; filename="employees-template.xlsx"');
      return res.send(buf);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/employees/bulk
 * Bulk-create HRMS employees from a CSV or Excel (.xlsx/.xls) upload
 * (multipart/form-data, field `file`).
 *
 * Columns: see BULK_COLUMNS above (45 columns).
 *   Required: email, firstName
 *   All others optional. Header aliases (snake_case / TitleCase / common
 *   variants) are accepted via getCol().
 *
 * Per-row behavior:
 *   - Idempotent on (email, workspaceId) — re-uploading the same file updates
 *     existing rows instead of creating duplicates.
 *   - Each row creates/updates a User, an Employee doc, and a UserPermission
 *     (L1/Employee template) — same triple as the single-create endpoint.
 *   - Each row is wrapped in try/catch; one bad row does not abort the batch.
 *
 * Manager resolution: managerEmail is resolved to managerId in a second pass
 * (after every row is upserted) so a manager listed later in the same file
 * can still be referenced. Unresolved managerEmails surface as warnings (not
 * errors); the row itself still imports.
 *
 * Limits: 5MB upload, 500 rows.
 * Tenant isolation: workspaceId is taken from req.workspaceObjectId, never
 * from the request body.
 */
router.post(
  "/bulk",
  requireAuth,
  requireWorkspace,
  bulkUpload.single("file"),
  async (req: any, res, next) => {
    try {
      if (!isAdminish(req.user)) {
        return res.status(403).json({ error: "Only admins can bulk-import employees" });
      }
      if (!req.file?.buffer) {
        return res.status(400).json({ error: "CSV or Excel file required (field name: 'file')" });
      }
      if (!req.workspaceObjectId) {
        return res.status(400).json({ error: "Workspace context required" });
      }

      const filename = String(req.file.originalname || "").toLowerCase();
      const mime = String(req.file.mimetype || "").toLowerCase();
      const isExcel =
        filename.endsWith(".xlsx") ||
        filename.endsWith(".xls") ||
        mime.includes("spreadsheet") ||
        mime.includes("excel");

      let rows: Record<string, string>[];

      if (isExcel) {
        // raw:true keeps numbers as numbers (so 12-digit Aadhaar / 14-digit
        // bank accounts don't get clobbered into "5.01001E+13" scientific
        // notation by SheetJS' string formatter). cellDates:true returns
        // date cells as Date instances which we then ISO-format below.
        const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
        const sheetName = wb.SheetNames[0];
        const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
        if (!sheet) {
          return res.status(400).json({ error: "Excel file has no sheets" });
        }
        const json = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, {
          raw: true,
          defval: "",
        });
        rows = json.map((row) => {
          const out: Record<string, string> = {};
          for (const [key, val] of Object.entries(row)) {
            let str: string;
            if (val instanceof Date) {
              const yyyy = val.getFullYear();
              const mm = String(val.getMonth() + 1).padStart(2, "0");
              const dd = String(val.getDate()).padStart(2, "0");
              str = `${yyyy}-${mm}-${dd}`;
            } else if (val === null || val === undefined) {
              str = "";
            } else {
              str = String(val);
            }
            out[String(key).trim()] = str.trim();
          }
          return out;
        });
      } else {
        const csvText = req.file.buffer.toString("utf-8");
        rows = parseCsv(csvText).rows;
      }

      if (rows.length === 0) {
        return res.status(400).json({ error: isExcel ? "Excel file is empty" : "CSV is empty" });
      }
      if (rows.length > 500) {
        return res.status(400).json({ error: "Max 500 rows per upload" });
      }

      const workspaceId = req.workspaceObjectId;
      const workspaceIdStr = String(workspaceId);
      const grantedBy = req.user?.email || String(req.user?._id || "system");

      const results = {
        imported: 0,
        updated: 0,
        skipped: 0,
        errors: [] as Array<{ row: number; email: string; reason: string }>,
        warnings: [] as Array<{ row: number; email: string; reason: string }>,
      };

      // Hash the temp password once — all new accounts share the same starter.
      const tempPasswordHash = await bcrypt.hash("Welcome@123", 10);

      const VALID_ROLES = new Set(["EMPLOYEE", "MANAGER", "HR"]);
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      // ── Pre-flight: collect every email referenced (subjects + managers) and
      // build an emailToUserId map for the workspace. The map gets updated
      // after each Pass-1 upsert so a manager created earlier in the same
      // file is still resolvable in Pass 2.
      const lookupEmails = new Set<string>();
      for (const row of rows) {
        const e = getCol(row, "email").toLowerCase();
        const me = getCol(row, "managerEmail").toLowerCase();
        if (e) lookupEmails.add(e);
        if (me) lookupEmails.add(me);
      }
      const emailToUserId = new Map<string, string>();
      if (lookupEmails.size > 0) {
        const existing = await User.find({
          workspaceId,
          email: { $in: [...lookupEmails] },
        }).select("_id email").lean();
        for (const u of existing as any[]) {
          if (u?.email) emailToUserId.set(String(u.email).toLowerCase(), String(u._id));
        }
      }

      // ── Pass 1: upsert User + Employee + UserPermission for each row.
      // managerId is intentionally deferred to Pass 2 so forward references
      // (manager listed below subject) still resolve.
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2; // header is row 1

        const email = getCol(row, "email").toLowerCase();

        try {
          if (!email) {
            results.errors.push({ row: rowNum, email: "", reason: "Missing email" });
            results.skipped++;
            continue;
          }
          if (!EMAIL_RE.test(email)) {
            results.errors.push({ row: rowNum, email, reason: "Invalid email format" });
            results.skipped++;
            continue;
          }

          const firstName = getCol(row, "firstName");
          if (!firstName) {
            results.errors.push({ row: rowNum, email, reason: "Missing firstName" });
            results.skipped++;
            continue;
          }
          const lastName = getCol(row, "lastName");

          // Build a payload of only User-schema fields with non-empty values.
          const userExtras: Record<string, string> = {};
          for (const f of USER_BULK_WRITE_FIELDS) {
            const v = getCol(row, f);
            if (v) userExtras[f] = v;
          }
          const fullName =
            getCol(row, "name") ||
            [firstName, lastName].filter(Boolean).join(" ");
          userExtras.firstName = firstName;
          if (lastName) userExtras.lastName = lastName;
          userExtras.name = fullName;

          // Mirror reportingL1 → managerName (existing single-create convention)
          const reportingL1 = getCol(row, "reportingL1");
          if (reportingL1) (userExtras as any).managerName = reportingL1;

          const rawRole = getCol(row, "hrmsAccessRole").toUpperCase() || "EMPLOYEE";
          const finalRole = VALID_ROLES.has(rawRole) ? rawRole : "EMPLOYEE";

          const phone = userExtras.phone || "";
          const department = userExtras.department || "";
          const designation = userExtras.designation || "";
          const dateOfJoining = userExtras.dateOfJoining || "";
          const employeeCode = userExtras.employeeCode || "";

          // ── Upsert User (scoped by email + workspaceId for tenant isolation) ──
          let user: any = await User.findOne({ email, workspaceId }).exec();
          const isNew = !user;

          if (!user) {
            user = await User.create({
              email,
              officialEmail: email,
              workspaceId,
              passwordHash: tempPasswordHash,
              tempPassword: true,
              status: "ACTIVE",
              roles: finalRole === "EMPLOYEE" ? ["EMPLOYEE"] : ["EMPLOYEE", finalRole],
              role: finalRole,
              hrmsAccessRole: finalRole,
              hrmsAccessLevel: finalRole,
              activatedByAdmin: true,
              ...userExtras,
            });
          } else {
            // Non-destructive update: only overwrite fields the row supplied.
            Object.assign(user, userExtras);
            // hrmsAccessRole on existing rows is only changed when the import
            // explicitly provided one (not when defaulted).
            if (getCol(row, "hrmsAccessRole")) {
              user.hrmsAccessRole = finalRole;
              user.hrmsAccessLevel = finalRole;
              user.roles =
                finalRole === "EMPLOYEE" ? ["EMPLOYEE"] : ["EMPLOYEE", finalRole];
              user.markModified("roles");
            }
            await user.save();
          }

          // Track this email's user id for Pass 2 manager resolution.
          emailToUserId.set(email, String(user._id));

          // ── Upsert Employee doc (lean schema — minimal subset only) ──
          // The Employee model is intentionally lean (see models/Employee.ts).
          // Identity / bank / address / education / statutory / personal fields
          // live on User and are merged into the read response by the list
          // endpoint via userMap. Expanding Employee to mirror those fields is
          // tracked separately as a schema-expansion ticket; for now User is
          // canonical and Mongoose strict mode would silently drop any fields
          // we tried to write here that don't exist on the schema.
          await Employee.updateOne(
            { email, workspaceId },
            {
              $set: {
                email,
                workspaceId,
                ownerId: user._id,
                name: fullName,
                fullName,
                firstName,
                lastName,
                phone: phone || undefined,
                department: department || undefined,
                designation: designation || undefined,
                joiningDate: dateOfJoining || undefined,
                employeeCode: employeeCode || undefined,
                status: "ACTIVE",
                isActive: true,
              },
            },
            { upsert: true }
          );

          // ── Auto-create UserPermission (L1/Employee template) if missing ──
          const existingPerm = await UserPermission.findOne({
            userId: String(user._id),
          }).lean();
          if (!existingPerm) {
            await UserPermission.create({
              userId: String(user._id),
              email,
              workspaceId: workspaceIdStr,
              universe: "STAFF",
              level: { code: "L1", name: "Employee", designation: designation || "" },
              modules: { ...LEVEL_TEMPLATES["L1"] },
              tier: 1,
              roleType: "EMPLOYEE",
              source: "system",
              status: "active",
              grantedBy,
              grantedAt: new Date(),
            });
          }

          if (isNew) results.imported++;
          else results.updated++;
        } catch (err: any) {
          console.error("[employees:bulk]", rowNum, email, err?.message);
          results.errors.push({
            row: rowNum,
            email,
            reason: err?.message || "Unknown error",
          });
          results.skipped++;
        }
      }

      // ── Pass 2: resolve managerEmail → managerId (User.managerId always;
      // Employee.managerId only when the manager has an Employee record, since
      // that field refs the Employee collection).
      const managerEmployeeIds = new Map<string, string>();
      const resolvableManagerEmails = new Set<string>();
      for (const row of rows) {
        const me = getCol(row, "managerEmail").toLowerCase();
        if (me && emailToUserId.has(me)) resolvableManagerEmails.add(me);
      }
      if (resolvableManagerEmails.size > 0) {
        const empDocs = await Employee.find({
          workspaceId,
          email: { $in: [...resolvableManagerEmails] },
        }).select("_id email").lean();
        for (const e of empDocs as any[]) {
          if (e?.email) managerEmployeeIds.set(String(e.email).toLowerCase(), String(e._id));
        }
      }

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2;
        const email = getCol(row, "email").toLowerCase();
        const managerEmail = getCol(row, "managerEmail").toLowerCase();
        if (!email || !managerEmail) continue;
        // Self-manager guard
        if (managerEmail === email) {
          results.warnings.push({
            row: rowNum,
            email,
            reason: `managerEmail "${managerEmail}" equals subject email — managerId not set`,
          });
          continue;
        }
        const managerUserId = emailToUserId.get(managerEmail);
        if (!managerUserId) {
          results.warnings.push({
            row: rowNum,
            email,
            reason: `managerEmail "${managerEmail}" not found in workspace or batch — managerId not set`,
          });
          continue;
        }
        try {
          await User.updateOne(
            { email, workspaceId },
            { $set: { managerId: managerUserId } }
          );
          const managerEmployeeId = managerEmployeeIds.get(managerEmail);
          if (managerEmployeeId) {
            await Employee.updateOne(
              { email, workspaceId },
              { $set: { managerId: managerEmployeeId } }
            );
          }
        } catch (err: any) {
          console.error("[employees:bulk:pass2]", rowNum, email, err?.message);
          results.warnings.push({
            row: rowNum,
            email,
            reason: `managerId update failed: ${err?.message || "unknown error"}`,
          });
        }
      }

      return res.json({ ok: true, ...results, total: rows.length });
    } catch (err) {
      next(err);
    }
  }
);

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
