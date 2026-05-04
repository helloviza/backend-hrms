// apps/backend/src/routes/users.ts
import { Router, Request, Response, NextFunction } from "express";
import User from "../models/User.js";
import { Onboarding } from "../models/Onboarding.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireRoles } from "../middleware/roles.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import bcrypt from "bcryptjs";
import { sendCredentialsEmail } from "../utils/credentialsEmail.js";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const r = Router();

/**
 * Tenant isolation (multi-domain / multi-account safe)
 * We derive tenantId from JWT claims already present in your system.
 */
function resolveTenantId(req: any) {
  const u = req.user || {};
  // Prefer customer/business first, then vendor, else fallback
  return String(u.customerId || u.businessId || u.vendorId || "staff");
}

/**
 * In-memory cache for signed avatar URLs to reduce signing overhead.
 * Keyed by S3 object key.
 */
type CacheEntry = { url: string; expAt: number };
const AVATAR_URL_CACHE = new Map<string, CacheEntry>();

/**
 * Create a short-lived signed URL for S3 avatar key.
 * - Uses a small in-memory cache to reduce AWS signing calls.
 * - Falls back to empty string if key is missing.
 */
async function signAvatarUrl(key?: string) {
  if (!key) return "";

  const now = Date.now();
  const cached = AVATAR_URL_CACHE.get(key);
  if (cached && cached.expAt > now + 30_000) {
    // keep 30s safety buffer
    return cached.url;
  }

  const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 900 }); // 15 minutes

  // cache for ~14 minutes (buffer before real expiry)
  AVATAR_URL_CACHE.set(key, { url, expAt: now + 14 * 60 * 1000 });
  return url;
}

/**
 * Best-effort delete an older avatar object.
 * Requires s3:DeleteObject on avatars/* (optional).
 */
async function tryDeleteOldAvatar(oldKey?: string) {
  if (!oldKey) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: oldKey }));
  } catch {
    // ignore (no permission or already deleted)
  }
}

/* ─────────────── ROUTES ─────────────── */

/**
 * GET /api/users
 * List workspace-scoped users (for payroll, salary structure, etc.)
 *
 * SUPERADMIN: may not have workspaceId in JWT. Resolves from
 * query param, x-workspace-id header, or falls back to the
 * first active workspace in the DB.
 */
r.get(
  "/",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let workspaceId: mongoose.Types.ObjectId | null = req.workspaceObjectId || null;

      // SUPERADMIN fallback: resolve from query / header / first active workspace
      if (!workspaceId && isSuperAdmin(req)) {
        const explicit =
          (req.query as any).workspaceId ||
          req.headers["x-workspace-id"];
        if (explicit) {
          workspaceId = new mongoose.Types.ObjectId(String(explicit));
        } else {
          const ws = await CustomerWorkspace.findOne({ status: "ACTIVE" })
            .select("_id")
            .lean();
          if (ws) {
            console.warn(
              `[SUPERADMIN AUTO-RESOLVE] No workspaceId provided. ` +
              `Falling back to first active workspace: ${ws._id}. ` +
              `User: ${(req as any).user?.email}. Path: ${req.path}`
            );
            workspaceId = ws._id as mongoose.Types.ObjectId;
          }
        }
      }

      if (!workspaceId) {
        return res.status(400).json({ success: false, error: "workspaceId required" });
      }

      const { limit = "500", department, status, search } = req.query as any;

      const filter: any = { workspaceId };
      if (status !== "all") filter.status = { $ne: "INACTIVE" };
      if (department) filter.department = department;
      if (search) {
        filter.$or = [
          { name: { $regex: search, $options: "i" } },
          { firstName: { $regex: search, $options: "i" } },
          { lastName: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ];
      }

      const lim = Math.min(1000, Math.max(1, parseInt(limit, 10) || 500));

      const users = await User.find(filter)
        .select("_id name firstName lastName email employeeCode designation department status dateOfJoining ctc workspaceId")
        .limit(lim)
        .sort({ name: 1 })
        .lean();

      return res.json({ success: true, users, total: users.length });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /api/users/profile
 * Get current user profile
 *
 * ✅ Returns:
 * - avatarKey (source of truth)
 * - avatarUrl (short-lived signed URL for display)
 */
r.get(
  "/profile",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.sub;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const user = await User.findById(userId).select("-passwordHash").lean();
      if (!user) return res.status(404).json({ error: "User not found" });

      const u: any = user;
      const avatarKey = u.avatarKey || "";
      const avatarUrl = avatarKey ? await signAvatarUrl(avatarKey) : "";

      res.json({
        // Identity
        _id:              u._id,
        email:            u.email,
        officialEmail:    u.officialEmail || "",
        roles:            u.roles || [],

        // Name
        name:             u.name || u.firstName || u.email?.split("@")[0] || "",
        firstName:        u.firstName || "",
        middleName:       u.middleName || "",
        lastName:         u.lastName || "",

        // Personal
        dateOfBirth:      u.dateOfBirth || null,
        gender:           u.gender || "",
        maritalStatus:    u.maritalStatus || "",
        nationality:      u.nationality || "",
        bloodGroup:       u.bloodGroup || "",

        // Contact
        phone:            u.phone || u.personalContact || "",
        personalContact:  u.personalContact || "",
        personalEmail:    u.personalEmail || "",

        // Address
        currentAddress:   u.currentAddress || "",
        permanentAddress: u.permanentAddress || "",

        // Emergency Contact
        emergencyContactName:     u.emergencyContactName || "",
        emergencyContactNumber:   u.emergencyContactNumber || "",
        emergencyContactRelation: u.emergencyContactRelation || "",

        // Identity Documents
        pan:              u.pan || "",
        aadhaar:          u.aadhaar || "",
        passportNumber:   u.passportNumber || "",
        passportExpiry:   u.passportExpiry || null,
        voterId:          u.voterId || "",
        disabilityStatus: u.disabilityStatus || "",

        // Employment
        department:         u.department || "",
        designation:        u.designation || "",
        employeeCode:       u.employeeCode || "",
        employeeType:       u.employeeType || "",
        dateOfJoining:      u.dateOfJoining || null,
        dateOfConfirmation: u.dateOfConfirmation || null,
        probationPeriod:    u.probationPeriod || "",
        contractStartDate:  u.contractStartDate || null,
        contractEndDate:    u.contractEndDate || null,
        exitDate:           u.exitDate || null,
        exitReason:         u.exitReason || "",
        jobLocation:        u.jobLocation || "",
        employmentStatus:   u.employmentStatus || "",
        shiftDetails:       u.shiftDetails || "",

        // Reporting Chain
        managerName:       u.managerName || u.reportingL1 || "",
        reportingL1:       u.reportingL1 || u.managerName || "",
        reportingL2:       u.reportingL2 || "",
        reportingL3:       u.reportingL3 || "",
        supervisorDetails: u.supervisorDetails || "",

        // Bank & Statutory
        bankName:          u.bankName || "",
        bankAccountNumber: u.bankAccountNumber || "",
        bankIfsc:          u.bankIfsc || "",
        pfNumber:          u.pfNumber || "",
        uanNumber:         u.uanNumber || "",
        esiNumber:         u.esiNumber || "",
        salaryPaymentMode: u.salaryPaymentMode || "",

        // Attendance & Leave
        attendanceNotes:           u.attendanceNotes || "",
        leaveHistoryNotes:         u.leaveHistoryNotes || "",
        wfhRecords:                u.wfhRecords || "",
        shiftPatterns:             u.shiftPatterns || "",
        timesheetDetails:          u.timesheetDetails || "",
        holidayCalendarReference:  u.holidayCalendarReference || "",
        leaveEntitlements:         u.leaveEntitlements || "",

        // Learning & Performance
        educationalQualifications: u.educationalQualifications || "",
        professionalCertifications: u.professionalCertifications || "",
        trainingHistory:           u.trainingHistory || "",
        skills:                    u.skills || "",
        performanceAppraisals:     u.performanceAppraisals || "",
        promotionsTransfers:       u.promotionsTransfers || "",
        disciplinaryRecords:       u.disciplinaryRecords || "",
        rewardsRecognition:        u.rewardsRecognition || "",
        employmentContracts:       u.employmentContracts || "",
        ndaOrNonCompete:           u.ndaOrNonCompete || "",
        backgroundVerification:    u.backgroundVerification || "",
        medicalHealthRecords:      u.medicalHealthRecords || "",
        workPermits:               u.workPermits || "",
        legalNotices:              u.legalNotices || "",

        // Avatar
        avatarKey,
        avatarUrl, // ✅ signed (use directly in <img src>)
        photoUrl:  u.photoUrl || avatarUrl || "",

        // HRMS Access
        hrmsAccessRole:  u.hrmsAccessRole || "EMPLOYEE",
        hrmsAccessLevel: u.hrmsAccessLevel || "EMPLOYEE",
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/users/profile/update
 * Update profile fields (no upload here)
 *
 * ✅ Supports updating profile basics.
 * ✅ If you pass avatarKey, it will validate & save it (optional convenience).
 */
r.post(
  "/profile/update",
  requireAuth,
  requirePermission("people", "WRITE"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.sub;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { name, phone, department, location, avatarKey } = req.body || {};

      const $set: any = {};
      if (name !== undefined) $set.name = name;
      if (phone !== undefined) $set.phone = phone;
      if (department !== undefined) $set.department = department;
      if (location !== undefined) $set.location = location;

      // Optional: allow avatarKey update via this endpoint too
      if (avatarKey) {
        const tenantId = resolveTenantId(req);
        const expectedPrefix = `avatars/${tenantId}/${userId}/`;
        if (!String(avatarKey).startsWith(expectedPrefix)) {
          return res.status(403).json({ error: "Forbidden" });
        }

        // ensure object exists (better error)
        try {
          await s3.send(
            new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: avatarKey }),
          );
        } catch {
          return res.status(404).json({ error: "Avatar object not found on S3" });
        }

        $set.avatarKey = avatarKey;
        $set.avatarUpdatedAt = new Date();
        // legacy field: do not store signed urls
        $set.avatarUrl = "";
      }

      const updated = await User.findByIdAndUpdate(userId, { $set }, { new: true })
        .select("-passwordHash")
        .lean();

      if (!updated) return res.status(404).json({ error: "User not found" });

      // attach signed avatar url for convenience
      const out: any = updated;
      out.avatarUrl = out.avatarKey ? await signAvatarUrl(out.avatarKey) : "";

      res.json(out);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/users/profile/avatar/confirm
 * Body: { key: "avatars/<tenantId>/<userId>/..." }
 *
 * Frontend flow:
 * 1) POST /api/uploads/presign-avatar-upload -> { key, uploadUrl }
 * 2) PUT file to S3 using uploadUrl
 * 3) POST /api/users/profile/avatar/confirm -> saves avatarKey & returns signed avatarUrl
 */
r.post(
  "/profile/avatar/confirm",
  requireAuth,
  requirePermission("people", "WRITE"),
  requireWorkspace,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user?.sub;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { key } = req.body || {};
      if (!key || typeof key !== "string") {
        return res.status(400).json({ error: "key is required" });
      }

      const tenantId = resolveTenantId(req);
      const expectedPrefix = `avatars/${tenantId}/${userId}/`;

      // tenant + user isolation
      if (!key.startsWith(expectedPrefix)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // ensure object exists (nicer UX)
      try {
        await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
      } catch {
        return res.status(404).json({ error: "Avatar object not found on S3" });
      }

      // load current user to optionally delete old avatar object
      const current = await User.findOne({ _id: userId, workspaceId: (req as any).workspaceObjectId }).select("avatarKey").lean();
      const oldKey = (current as any)?.avatarKey || "";

      await User.findByIdAndUpdate(userId, {
        $set: {
          avatarKey: key,
          avatarUpdatedAt: new Date(),
          avatarUrl: "", // legacy local/signed url must not be stored
        },
      });

      // best-effort cleanup old avatar
      if (oldKey && oldKey !== key) {
        await tryDeleteOldAvatar(oldKey);
        AVATAR_URL_CACHE.delete(oldKey);
      }

      const avatarUrl = await signAvatarUrl(key);
      res.json({ avatarKey: key, avatarUrl });
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────── POST /create-staff (mounted at /api/admin/create-staff) ─────────────── */

r.post(
  "/create-staff",
  requireAuth,
  requireWorkspace,
  requireRoles("ADMIN", "SUPERADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, email, password, role, department, phone } = req.body as {
        name?: string;
        email?: string;
        password?: string;
        role?: string;
        department?: string;
        phone?: string;
      };

      if (!name || !email || !password || !role) {
        return res.status(400).json({ error: "name, email, password and role are required." });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters." });
      }

      const existing = await User.findOne({ email: email.trim().toLowerCase() });
      if (existing) {
        return res.status(409).json({ error: "A user with this email already exists." });
      }

      const hashed = await bcrypt.hash(password, 10);

      const newUser = await User.create({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        passwordHash: hashed,
        roles: [role.toUpperCase()],
        ...(department ? { department: department.trim() } : {}),
        ...(phone ? { phone: phone.trim() } : {}),
        isActive: true,
        workspaceId: (req as any).workspaceObjectId,
      });

      return res.status(201).json({
        success: true,
        user: {
          _id: newUser._id,
          name: newUser.name,
          email: newUser.email,
          roles: newUser.roles,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ─────────────── GET /admin/onboarded-without-access ─────────────── */

r.get(
  "/admin/onboarded-without-access",
  requireAuth,
  requireWorkspace,
  requireRoles("ADMIN", "SUPERADMIN", "HR"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const users = await User.find({
        $or: [
          { tempPassword: true },
          { tempPassword: { $exists: false } },
        ],
        roles: { $in: ["EMPLOYEE", "MANAGER", "HR"] },
        workspaceId: (req as any).workspaceObjectId,
      })
        .select("name email officialEmail roles employeeCode createdAt tempPassword activatedByAdmin")
        .lean();

      res.json(users);
    } catch (err) {
      next(err);
    }
  }
);

/* ─────────────── POST /admin/grant-access ─────────────── */

r.post(
  "/admin/grant-access",
  requireAuth,
  requireWorkspace,
  requireRoles("ADMIN", "SUPERADMIN", "HR"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, onboardingId, role, password, officialEmail } = req.body as {
        userId?: string;
        onboardingId?: string;
        role?: string;
        password?: string;
        officialEmail?: string;
      };

      if (!role || !password) {
        return res.status(400).json({ error: "role and password are required." });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters." });
      }

      const hashed = await bcrypt.hash(password, 10);
      const activation = {
        passwordHash: hashed,
        roles: [role.toUpperCase()],
        tempPassword: false,
        activatedByAdmin: true,
        isActive: true,
        activatedAt: new Date(),
      };

      // Path A: grant access to an existing User doc (from tempPassword flow)
      if (userId) {
        const target = await scopedFindById(User, userId, (req as any).workspaceObjectId);
        if (!target) return res.status(404).json({ error: "User not found." });
        Object.assign(target, activation, ...(officialEmail ? [{ officialEmail }] : []));
        await (target as any).save();
        const loginUrl = (process.env.FRONTEND_ORIGIN || "https://plumbox.plumtrips.com").replace(/\/+$/, "") + "/login";
        sendCredentialsEmail({
          to: (target as any).officialEmail || (target as any).email,
          name: (target as any).name || (target as any).email,
          officialEmail: (target as any).officialEmail || (target as any).email,
          tempPassword: password,
          loginUrl,
          employeeCode: (target as any).employeeCode || undefined,
        }).catch(err => console.error("[grant-access] credentials email failed:", err));
        return res.json({
          success: true,
          user: { _id: target._id, name: (target as any).name, email: (target as any).email, roles: (target as any).roles },
        });
      }

      // Path B: create from onboarding doc (no User exists yet)
      if (!onboardingId) {
        return res.status(400).json({ error: "userId or onboardingId is required." });
      }

      const onboarding = await (Onboarding as any).findOne({ _id: onboardingId, workspaceId: (req as any).workspaceObjectId }).lean();
      if (!onboarding) {
        return res.status(404).json({ error: "Onboarding record not found." });
      }

      const email = (onboarding as any).email?.trim().toLowerCase();
      if (!email) {
        return res.status(400).json({ error: "Onboarding record has no email." });
      }

      const o = onboarding as any;
      const payload = o.formPayload || {};
      const name =
        o.inviteeName ||
        payload.name ||
        payload.fullName ||
        [payload.firstName, payload.lastName].filter(Boolean).join(" ") ||
        email;

      const existing = await User.findOne({ email, workspaceId: (req as any).workspaceObjectId });
      if (existing) {
        Object.assign(existing, activation, ...(officialEmail ? [{ officialEmail }] : []));
        await (existing as any).save();
        const loginUrlB = (process.env.FRONTEND_ORIGIN || "https://plumbox.plumtrips.com").replace(/\/+$/, "") + "/login";
        sendCredentialsEmail({
          to: officialEmail || (existing as any).email,
          name: (existing as any).name || (existing as any).email,
          officialEmail: officialEmail || (existing as any).email,
          tempPassword: password,
          loginUrl: loginUrlB,
          employeeCode: (existing as any).employeeCode || undefined,
        }).catch(err => console.error("[grant-access] credentials email failed:", err));
        return res.json({
          success: true,
          user: { _id: existing._id, name: (existing as any).name, email: (existing as any).email, roles: (existing as any).roles },
        });
      }

      const newUser = await User.create({ name, email, isActive: true, ...activation, ...(officialEmail && { officialEmail }), workspaceId: (req as any).workspaceObjectId });
      const loginUrlC = (process.env.FRONTEND_ORIGIN || "https://plumbox.plumtrips.com").replace(/\/+$/, "") + "/login";
      sendCredentialsEmail({
        to: (newUser as any).officialEmail || (newUser as any).email,
        name: (newUser as any).name || (newUser as any).email,
        officialEmail: (newUser as any).officialEmail || (newUser as any).email,
        tempPassword: password,
        loginUrl: loginUrlC,
        employeeCode: (newUser as any).employeeCode || undefined,
      }).catch(err => console.error("[grant-access] credentials email failed:", err));

      return res.status(201).json({
        success: true,
        user: {
          _id: newUser._id,
          name: (newUser as any).name,
          email: (newUser as any).email,
          roles: (newUser as any).roles,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

r.patch("/admin/users/:id/sbt", requireAuth, requireWorkspace, async (req: any, res: any) => {
  try {
    const actor = req.user || {};
    const actorRoles = (Array.isArray(actor.roles) ? actor.roles : [actor.role]).map((r: any) =>
      String(r || "").trim().toUpperCase().replace(/[\s\-_]/g, "")
    );
    const isAdmin = actorRoles.some((r: string) => ["ADMIN", "SUPERADMIN", "HR"].includes(r));
    const isLeader = actorRoles.some((r: string) => ["WORKSPACELEADER", "WORKSPACE_LEADER"].includes(r));

    if (!isAdmin && !isLeader) {
      return res.status(403).json({ error: "Access denied" });
    }

    const { sbtEnabled, sbtBookingType } = req.body;

    const targetUser: any = await User.findOne({
      _id: req.params.id,
      ...(req.workspaceObjectId && { workspaceId: req.workspaceObjectId }),
    }).lean();
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    // Step 2: authorization check for WORKSPACE_LEADER callers
    if (isLeader && !isAdmin) {
      const actorCustomerId = String(actor.customerId || actor.businessId || "");
      const targetCustomerId = String(targetUser.customerId || "");

      // Cannot modify users outside their own company
      if (!actorCustomerId || actorCustomerId !== targetCustomerId) {
        return res.status(403).json({ error: "You can only manage users in your own company" });
      }

      // Cannot modify their own SBT
      const actorId = String(actor.sub || actor.id || actor._id || "");
      const targetId = String(req.params.id);
      const actorEmail = String(actor.email || "").trim().toLowerCase();
      const targetEmail = String(targetUser.email || "").trim().toLowerCase();
      if ((actorId && actorId === targetId) || (actorEmail && actorEmail === targetEmail)) {
        return res.status(403).json({
          error: "You cannot modify your own permissions. Contact Plumtrips Admin.",
          code: "SELF_MODIFICATION_DENIED",
        });
      }
    }
    // Staff admins (ADMIN/SUPERADMIN/HR) can update anyone — no additional check needed

    // If enabling SBT, check workspace travelMode for conflicts
    if (sbtEnabled) {
      if (targetUser?.customerId) {
        const CustomerWorkspace = (await import("../models/CustomerWorkspace.js")).default;
        const ws: any = await CustomerWorkspace.findOne({ customerId: targetUser.customerId })
          .select("travelMode")
          .lean();
        if (ws?.travelMode === "APPROVAL_FLOW") {
          return res.status(409).json({
            error: "Cannot enable SBT for this user. Company travel mode is set to Approval Flow.",
            code: "APPROVAL_FLOW_CONFLICT",
          });
        }
      }
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { sbtEnabled, sbtBookingType },
      { new: true }
    ).select("name email sbtEnabled sbtBookingType");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default r;
