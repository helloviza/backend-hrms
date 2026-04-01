// apps/backend/src/routes/onboarding.ts
// 🔥 FULL EXTENDED VERSION — pipeline, public viewer, S3 presign, admin decision, no-store caching
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import multer from "multer";
import bcrypt from "bcryptjs";

import mongoose from "mongoose";
import Onboarding from "../models/Onboarding.js";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { env } from "../config/env.js";
import User from "../models/User.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import { sendOnboardingEmail } from "../emails/index.js";
import { sendOnboardingWelcomeEmail } from "../utils/onboardingWelcomeEmail.js";
import { sendRejectionEmail } from "../utils/credentialsEmail.js";
import { sendEmployeeWelcomeEmail } from "../utils/employeeWelcomeEmail.js";
import { syncCustomerFromOnboarding } from "../services/syncCustomerFromOnboarding.js";

const router = Router();
const _require = createRequire(import.meta.url);
const upload = multer();

/* -------------------- Types -------------------- */
interface OnboardingDoc {
  _id: string;
  type?: string;
  email?: string;
  name?: string;
  status?: string;
  expiresAt?: Date | string | null;
  updatedAt?: Date | string | null;
  createdAt?: Date | string | null;
  token?: string;
  turnaroundHours?: number;
  inviteeName?: string;
  documents?: any[];
  formPayload?: any;
  payload?: any;
  extras_json?: any;
  submittedAt?: Date | string | null;
  ticket?: string;
  isActive?: boolean;
  remarks?: string;
  photoKey?: string;
}

/* -------------------- Helpers -------------------- */
function makeToken(): string {
  try {
    return crypto.randomBytes(16).toString("hex");
  } catch {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  }
}

function enumValues(pathName: string): string[] {
  const p: any = (Onboarding as any)?.schema?.path?.(pathName);
  return Array.isArray(p?.enumValues) ? p.enumValues : [];
}

function resolveType(val?: string): string | undefined {
  const allowed = enumValues("type");
  if (!allowed.length) return val;
  if (!val) return allowed[0];

  const lc = String(val).toLowerCase();

  // ✅ explicit Business Association handling
  if (
    lc.includes("businessassociation") ||
    lc.includes("business_association") ||
    lc === "ba"
  ) {
    return (
      allowed.find((v) =>
        v.toLowerCase().includes("businessassociation")
      ) || "BusinessAssociation"
    );
  }

  // Vendor
  if (lc.includes("vendor")) {
    return allowed.find((v) => v.toLowerCase().includes("vendor")) || "Vendor";
  }

  // Employee
  if (lc.includes("employee")) {
    return (
      allowed.find((v) => v.toLowerCase().includes("employee")) || "Employee"
    );
  }

  // Business (Customer)
  if (lc === "business") {
    return allowed.find((v) => v.toLowerCase() === "business") || "Business";
  }

  // fallback
  return allowed.find((v) => v.toLowerCase() === lc) || allowed[0];
}


function resolveStatus(val?: string): string | undefined {
  const allowed = enumValues("status");
  if (!allowed.length) return val;
  if (!val) return undefined;
  const lc = String(val).toLowerCase();
  const groups: Record<string, string[]> = {
    invited: ["invited", "invite", "new", "pending"],
    inprogress: ["inprogress", "in-progress", "progress", "started", "open"],
    submitted: ["submitted", "complete", "completed", "done"],
    approved: ["approved", "accept", "accepted", "verified"],
    rejected: ["rejected", "declined", "failed"],
    expired: ["expired"],
  };
  for (const v of allowed) {
    const av = v.toLowerCase();
    for (const syns of Object.values(groups)) {
      if (syns.some((s) => av.includes(s))) return v;
    }
  }
  return undefined;
}

function nowIso(d?: Date | string | number | null) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(+dt) ? null : dt.toISOString();
}

function isExpired(ts?: string | Date | null) {
  if (!ts) return false;
  const t = ts instanceof Date ? ts.getTime() : new Date(ts as any).getTime();
  return Number.isFinite(t) ? Date.now() > t : false;
}

function makeTicket(id: any, token?: string) {
  const base = String(id || "").slice(-6) || String(token || "").slice(0, 6);
  return (
    "OB-" +
    (base || Math.floor(Math.random() * 1e6).toString().padStart(6, "0"))
  );
}

/* --------- Employee code generator for HRMS User sync --------- */
async function generateNextEmployeeCode(): Promise<string> {
  const PREFIX = "PTS";
  const START_NUM = 1031; // 001031 → first employee
  const re = /^PTS(\d{6})$/;

  const docs: any[] = await (User as any).find({
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

/* --------- Sync onboarding → HRMS User (for TeamProfiles) --------- */
function parseEmployeeCore(doc: OnboardingDoc): any {
  let core = doc.formPayload;
  if (!core && doc.extras_json && typeof doc.extras_json === "object") {
    core = (doc.extras_json as any).core || doc.extras_json;
  }
  if (typeof core === "string") {
    try {
      core = JSON.parse(core);
    } catch {
      core = {};
    }
  }
  if (!core || typeof core !== "object") core = {};
  return core;
}

function buildEducationString(edu: any): string | undefined {
  if (!edu || typeof edu !== "object") return undefined;
  const parts = [
    edu.highestDegree,
    edu.institution,
    edu.year,
  ]
    .map((v: any) => (v ? String(v).trim() : ""))
    .filter(Boolean);
  if (!parts.length) return undefined;
  return parts.join(" · ");
}

async function syncEmployeeFromOnboarding(
  rawDoc: OnboardingDoc | any
): Promise<{ tempPassword: string; email: string } | null> {
  try {
    const doc = rawDoc as OnboardingDoc;
    const type = String(doc.type || "").toLowerCase();
    if (type !== "employee") return null;

    const core = parseEmployeeCore(doc);

    const emailCandidate =
      (doc.email && String(doc.email).trim()) ||
      (core.contact?.personalEmail &&
        String(core.contact.personalEmail).trim()) ||
      (core.personalEmail && String(core.personalEmail).trim()) ||
      "";

    const email = emailCandidate.toLowerCase();

    if (!email) {
      console.warn(
        "[onboarding:sync] no email found for onboarding doc",
        doc._id
      );
      return null;
    }

    const fullName =
      core.fullName ||
      doc.name ||
      [core.firstName, core.middleName, core.lastName]
        .filter(Boolean)
        .join(" ") ||
      "";

    let firstName = core.firstName;
    let middleName = core.middleName;
    let lastName = core.lastName;

    if (!firstName && fullName) {
      const parts = String(fullName).trim().split(/\s+/);
      firstName = parts[0];
      if (parts.length > 2) {
        middleName = parts.slice(1, parts.length - 1).join(" ");
        lastName = parts[parts.length - 1];
      } else if (parts.length === 2) {
        lastName = parts[1];
      }
    }

    const employment = core.employment || {};
    const ids = core.ids || {};
    const bank = core.bank || {};
    const address = core.address || {};
    const education = core.education || {};
    const emergency = core.emergency || {};

    const update: any = {
      name: fullName || undefined,
      firstName: firstName || undefined,
      middleName: middleName || undefined,
      lastName: lastName || undefined,

      officialEmail: email,
      email,
      personalEmail:
        core.contact?.personalEmail || core.personalEmail || undefined,

      personalContact:
        core.contact?.personalMobile || core.personalMobile || undefined,
      currentAddress: address.current || undefined,
      permanentAddress: address.permanent || undefined,

      dateOfBirth: core.dateOfBirth || undefined,
      gender: core.gender || undefined,
      maritalStatus:
        employment.maritalStatus || core.maritalStatus || undefined,
      casteCategory: employment.casteCategory || undefined,

      emergencyContactName: emergency.name || undefined,
      emergencyContactRelation: emergency.relationship || undefined,
      emergencyContactNumber: emergency.mobile || undefined,

      pan: ids.pan || undefined,
      aadhaar: ids.aadhaar || undefined,

      bankName: bank.bankName || undefined,
      bankAccountNumber: bank.accountNumber || undefined,
      bankIfsc: bank.ifsc || undefined,

      dateOfJoining: employment.dateOfJoining || undefined,
      educationalQualifications: buildEducationString(education),

      hrmsAccessRole: "EMPLOYEE",
    };

    if (doc.photoKey) {
      update.photoKey = doc.photoKey;
    }

    let user: any = await (User as any).findOne({ email }).exec();

    if (!user) {
      const tempPassword =
        "HRMS-" +
        Math.random().toString(36).slice(2) +
        Date.now().toString(36);
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      const employeeCode = await generateNextEmployeeCode();

      user = await (User as any).create({
        ...update,
        employeeCode,
        roles: ["EMPLOYEE"],
        role: "EMPLOYEE",
        status: "ACTIVE",
        passwordHash,
        tempPassword: true,
      });

      console.log(
        "[onboarding:sync] created employee from onboarding for",
        email
      );
      return { tempPassword, email };
    } else {
      Object.assign(user, update);
      if (!user.employeeCode) {
        user.employeeCode = await generateNextEmployeeCode();
      }
      await user.save();
    }

    console.log(
      "[onboarding:sync] updated employee from onboarding for",
      email
    );
    return null;
  } catch (err) {
    console.error("[onboarding:sync] error while syncing employee:", err);
    return null;
  }
}

/* -------------------- S3 Setup -------------------- */
const S3_REGION = env.AWS_REGION || process.env.AWS_REGION || "ap-south-1";
const S3_BUCKET = env.S3_BUCKET || process.env.S3_BUCKET;
const PRESIGN_TTL = Number(env.PRESIGN_TTL || process.env.PRESIGN_TTL || 60);
const s3 = new S3Client({ region: S3_REGION });

let createPresignedPostFn:
  | undefined
  | ((...args: any[]) => Promise<{ url: string; fields: Record<string, string> }>);
let getSignedUrl:
  | undefined
  | ((...args: any[]) => Promise<string>);

try {
  createPresignedPostFn = _require(
    "@aws-sdk/s3-presigned-post"
  ).createPresignedPost;
  console.log("[onboarding] ✅ Loaded @aws-sdk/s3-presigned-post");
} catch {
  console.warn("[onboarding] ⚠️ @aws-sdk/s3-presigned-post not installed");
}
try {
  getSignedUrl = _require(
    "@aws-sdk/s3-request-presigner"
  ).getSignedUrl;
  console.log("[onboarding] ✅ Loaded @aws-sdk/s3-request-presigner");
} catch {
  console.warn("[onboarding] ⚠️ @aws-sdk/s3-request-presigner not installed");
}

/* -------------------- Middleware -------------------- */
function noStore(_: Request, res: Response, next: NextFunction) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, private"
  );
  next();
}

/* -------------------- Validation Schemas -------------------- */
const inviteSchema = z.object({
  type: z.enum(["Business", "Vendor", "Employee", "BusinessAssociation"]),
  inviteeEmail: z.string().email(),
  inviteeName: z.string().min(1).max(200).optional(),
  turnaroundHours: z.number().min(1).max(720).optional(),
});

const decisionSchema = z.object({
  action: z.enum(["approved", "rejected", "hold"]),
  remarks: z.string().max(1000).optional(),
});

const presignQuerySchema = z.object({
  key: z.string().min(1).max(500),
});

/* -------------------- ROUTES -------------------- */
/** 📨 Create invite */
router.post("/invites", requireAuth, requireWorkspace, noStore, async (req, res, next) => {
  try {
    const validation = inviteSchema.safeParse(req.body);
    if (!validation.success)
      return res.status(400).json({
        error: "Validation failed",
        fields: validation.error.flatten().fieldErrors,
      });

    // ── Resolve workspaceId (SUPERADMIN fallback to first active workspace) ──
    let workspaceId: mongoose.Types.ObjectId | null =
      req.workspaceObjectId || null;

    if (!workspaceId && isSuperAdmin(req)) {
      const explicit =
        (req.body as any)?.workspaceId ||
        (req.query as any)?.workspaceId ||
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
      return res.status(400).json({ error: "workspaceId is required" });
    }

    const { type, inviteeEmail, inviteeName, turnaroundHours } = validation.data;
    const { email, name, status } = req.body ?? {};
    const normEmail = String(inviteeEmail ?? email ?? "").trim();
    const rawName = inviteeName;
const safeName =
  typeof rawName === "string" && rawName.trim().length > 0
    ? rawName.trim()
    : undefined;

    // ❌ Invalidate previous active invites for same type + email
await (Onboarding as any).updateMany(
  {
    email: normEmail,
    type: resolveType(type),
    status: { $in: ["started"] },
  },
  {
    $set: {
      status: "expired",
      updatedAt: new Date(),
    },
  }
);


    const token = makeToken();
    const now = new Date();
    const tat = Number.isFinite(+turnaroundHours) ? +turnaroundHours : 72;
    const expiresAt = new Date(now.getTime() + tat * 60 * 60 * 1000);

    const doc = await (Onboarding as any).create({
  type: resolveType(type),
  email: normEmail,
  workspaceId,

  // ✅ SOURCE OF TRUTH
 inviteeName: safeName,
name: safeName,


  token,
  turnaroundHours: tat,
  expiresAt,
  createdBy: (req as any).user?._id,
  createdAt: now,
  updatedAt: now,
  status: "started",
});


    const link = `/onboarding/${doc.token}`;
    const absoluteLink = (env.FRONTEND_ORIGIN ?? "").replace(/\/+$/, "") + link;


// ✉️ Send onboarding email (non-blocking)
try {
  await sendOnboardingEmail({
  type: String(doc.type).toLowerCase() as "vendor" | "business" | "employee",
  email: doc.email!,
  name: doc.inviteeName || doc.name,
  link: absoluteLink,
  expiresAt,
});

} catch (e) {
  console.error("[onboarding] email failed:", e);
  // invite is still valid; admin can resend
}


    res.json({
      id: String(doc._id),
      token: doc.token,
      link,
      absoluteLink,
      type: doc.type,
      email: doc.email,
      name: doc.name,
      status: doc.status,
      turnaroundHours: doc.turnaroundHours,
      expiresAt: doc.expiresAt,
    });
  } catch (err) {
    next(err);
  }
});

/** 📋 List invites */
router.get("/invites", requireAuth, noStore, async (req, res, next) => {
  try {
    const { type } = req.query as { type?: string };
    const filter: Record<string, any> = {};
    if (type) filter.type = resolveType(type);
    if ((req as any).workspaceObjectId) filter.workspaceId = (req as any).workspaceObjectId;
    const docs = (await (Onboarding as any).find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()
      .exec()) as OnboardingDoc[];
    // Lazy expiry — mark stale invites but protect submitted/verified/approved/rejected
    const protectedStatuses = ["submitted", "verified", "approved", "rejected"];
    for (const d of docs) {
      const expired = isExpired(d.expiresAt);
      if (expired && !protectedStatuses.includes(d.status) && d.status !== "expired") {
        await (Onboarding as any).updateOne(
          { _id: d._id },
          { $set: { status: "expired" } }
        ).exec();
        d.status = "expired";
      }
    }

    const statusMap: Record<string, string> = {
      sent: "Invited",
      started: "InProgress",
      submitted: "Submitted",
      approved: "Approved",
      rejected: "Rejected",
      expired: "Expired",
    };

    const items = docs.map((d) => ({
      id: String(d._id),
      type: d.type,
      inviteeEmail: d.email,
      inviteeName: d.inviteeName || d.name || "",
      status: statusMap[String(d.status)] || "Invited",

      turnaroundHours: d.turnaroundHours ?? 72,
      expiresAt: d.expiresAt
        ? new Date(d.expiresAt).toISOString()
        : null,
      createdAt: d.createdAt
        ? new Date(d.createdAt).toISOString()
        : null,
      token: d.token,
    }));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/** 🔁 Resend onboarding invite (Admin only — extend expiry, keep token) */
router.post(
  "/invites/:id/resend",
  requireAuth,
  requireWorkspace,
  noStore,
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const invite: any = await (Onboarding as any).findOne({ _id: id, workspaceId: (req as any).workspaceObjectId }).exec();
      if (!invite) {
        return res.status(404).json({ error: "Invite not found" });
      }

      // ❌ Do not resend completed invites
      const status = String(invite.status || "").toLowerCase();
      if (["submitted", "approved"].includes(status)) {
        return res.status(400).json({
          error: "Invite already completed",
        });
      }

      // ✅ SOURCE OF TRUTH FOR PERSONALIZATION
      const safeName =
        (invite.inviteeName && String(invite.inviteeName).trim()) ||
        (invite.name && String(invite.name).trim()) ||
        undefined;

      // ✅ Extend expiry (do NOT regenerate token)
      const tat = Number(invite.turnaroundHours || 72);
      invite.expiresAt = new Date(Date.now() + tat * 60 * 60 * 1000);
      invite.updatedAt = new Date();

      // ✅ Normalize + persist names (important)
      if (safeName) {
        invite.inviteeName = safeName;
        invite.name = safeName; // backward compatibility
      }

      await invite.save();

      const link = `/onboarding/${invite.token}`;
      const absoluteLink =
        (env.FRONTEND_ORIGIN ?? "").replace(/\/+$/, "") + link;

      // ✉️ Resend email with correct personalization
      await sendOnboardingEmail({
  type: String(invite.type).toLowerCase() as
    | "vendor"
    | "business"
    | "employee",
  email: invite.email!,
  name: invite.inviteeName || invite.name,
  link: absoluteLink,
  expiresAt: invite.expiresAt!,
});

      return res.json({
        ok: true,
        message: "Invite resent successfully",
        expiresAt: invite.expiresAt,
      });
    } catch (err) {
      next(err);
    }
  }
);



/** ✏️ Draft save — EMPLOYEE-aware name/email propagation */
router.post("/draft/:token", noStore, async (req, res) => {
  const { token } = req.params;
  const { core, attachments } = req.body ?? {};
  try {
    const invite = (await (Onboarding as any).findOne({ token })
      .lean()
      .exec()) as OnboardingDoc | null;
    if (!invite) return res.status(404).json({ error: "Invite not found" });
    if (isExpired(invite.expiresAt))
      return res.status(410).json({ error: "Invite expired" });

    const type = String(invite.type || "").toLowerCase();
    const updates: any = {
      payload: core ?? {},
      documents: Array.isArray(attachments) ? attachments : [],
      status: resolveStatus("in-progress") ?? "in-progress",
      updatedAt: new Date(),
    };

    // Mirror common name/email fields
    if (core && typeof core === "object") {
      if (type === "employee") {
        if (core.fullName && typeof core.fullName === "string")
          updates.name = core.fullName.trim();
        const personalEmail =
          core.contact?.personalEmail || core.personalEmail || core.email;
        if (personalEmail && typeof personalEmail === "string") {
          updates.email = String(personalEmail).trim();
        }
      } else if (type === "business") {
        const bizName = core.legalName || core.companyName || core.name;
        const bizEmail = core.contactEmail || core.email;
        if (bizName) updates.name = String(bizName).trim();
        if (bizEmail) updates.email = String(bizEmail).trim();
      } else if (type === "vendor") {
        const vendorName =
          core.companyName || core.legalName || core.contactName;
        const vendorEmail = core.contactEmail || core.email;
        if (vendorName) updates.name = String(vendorName).trim();
        if (vendorEmail) updates.email = String(vendorEmail).trim();
      }
    }

    await (Onboarding as any).updateOne({ token }, { $set: updates }).exec();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Draft save failed" });
  }
});

/** ✅ Final submit — EMPLOYEE validation + persist name/email/photoKey + sync to HRMS */
router.post("/submit/:token", upload.none(), noStore, async (req, res) => {
  const { token } = req.params;
  try {
    const invite: any = await (Onboarding as any).findOne({ token }).exec();
    if (!invite) return res.status(404).json({ error: "Invalid token" });

    const currentStatus = (invite.status || "").toLowerCase();
    if (["submitted", "verified", "approved"].includes(currentStatus)) {
      // Ensure we still push to HRMS in case previous sync failed
      await syncEmployeeFromOnboarding(invite);
      return res.json({
        ok: true,
        ticket: invite.ticket,
        message: "All required details have been submitted",
      });
    }

    // Auto-extend expiry if expired — allow the user to complete the form
    if (currentStatus === "expired" || isExpired(invite.expiresAt)) {
      invite.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      if (currentStatus === "expired") invite.status = "started";
    }

    const body = req.body || {};
    const core = (body as any).core || body || {};
    const attachments = Array.isArray((body as any).attachments)
      ? (body as any).attachments
      : [];
    const { core: _omit, attachments: _omit2, ...rest } = body as any;

    const type = String(invite.type || "").toLowerCase();

    if (type === "employee") {
      // Validate mandatory fields
      const required: Array<[string, any]> = [
        ["fullName", (core as any).fullName],
        ["fatherOrHusbandName", (core as any).fatherOrHusbandName],
        ["dateOfBirth", (core as any).dateOfBirth],
        ["gender", (core as any).gender],
        ["address.current", (core as any).address?.current],
        ["address.permanent", (core as any).address?.permanent],
        ["contact.personalMobile", (core as any).contact?.personalMobile],
        ["contact.personalEmail", (core as any).contact?.personalEmail],
        ["emergency.name", (core as any).emergency?.name],
        ["emergency.relationship", (core as any).emergency?.relationship],
        ["emergency.mobile", (core as any).emergency?.mobile],
        ["ids.aadhaar", (core as any).ids?.aadhaar],
        ["ids.pan", (core as any).ids?.pan],
        ["bank.accountNumber", (core as any).bank?.accountNumber],
        ["bank.bankName", (core as any).bank?.bankName],
        ["bank.ifsc", (core as any).bank?.ifsc],
        [
          "education.highestDegree",
          (core as any).education?.highestDegree,
        ],
        ["education.institution", (core as any).education?.institution],
        ["education.year", (core as any).education?.year],
        ["employment.dateOfJoining", (core as any).employment?.dateOfJoining],
      ];
      const missing = required
        .filter(([_, v]) => {
          if (v === undefined || v === null) return true;
          if (typeof v === "string" && v.trim() === "") return true;
          return false;
        })
        .map(([k]) => k);
      if (missing.length) {
        return res
          .status(400)
          .json({ error: "Missing required fields", fields: missing });
      }

      // Persist canonical name/email for dashboards & master data
      invite.name = String((core as any).fullName).trim();
      const personalEmail =
        (core as any).contact?.personalEmail ||
        (core as any).personalEmail ||
        (core as any).email;
      if (personalEmail) invite.email = String(personalEmail).trim();
      if ((core as any).photoKey)
        invite.photoKey = String((core as any).photoKey);
    } else if (type === "business") {
      const bizName =
        (core as any).legalName ||
        (core as any).companyName ||
        (core as any).name;
      const bizEmail = (core as any).contactEmail || (core as any).email;
      if (bizName) invite.name = String(bizName).trim();
      if (bizEmail) invite.email = String(bizEmail).trim();
    } else if (type === "vendor") {
      const vendorName =
        (core as any).companyName ||
        (core as any).legalName ||
        (core as any).contactName;
      const vendorEmail = (core as any).contactEmail || (core as any).email;
      if (vendorName) invite.name = String(vendorName).trim();
      if (vendorEmail) invite.email = String(vendorEmail).trim();
    }

invite.status = "submitted";
invite.submittedAt = new Date();
invite.documents = attachments;
invite.formPayload = core;
invite.extras_json = rest;
if (!invite.ticket) invite.ticket = makeTicket(invite._id, token);

await invite.save();

// 🔥 SYNC TO MASTER TABLES
await syncEmployeeFromOnboarding(invite);
await syncCustomerFromOnboarding(invite);

    res.json({
      ok: true,
      ticket: invite.ticket,
      message: "All required details have been submitted",
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

/** 🧾 Pipeline summary */
router.get("/pipeline", requireAuth, noStore, async (req, res, next) => {
  try {
    const { type } = req.query as { type?: string };
    const filter: Record<string, any> = {};
    if (type) filter.type = resolveType(type);
    if ((req as any).workspaceObjectId) filter.workspaceId = (req as any).workspaceObjectId;
    const docs = (await (Onboarding as any).find(filter)
      .sort({ updatedAt: -1 })
      .lean()
      .exec()) as OnboardingDoc[];

    const buckets: Record<string, any[]> = {
      Invited: [],
      InProgress: [],
      Submitted: [],
      Approved: [],
      Rejected: [],
      Expired: [],
    };

    const protectedStatuses = ["submitted", "verified", "approved", "rejected"];
    for (const d of docs) {
      const expired = isExpired(d.expiresAt);
      if (expired && !protectedStatuses.includes(d.status) && d.status !== "expired") {
        await (Onboarding as any).updateOne(
          { _id: d._id },
          { $set: { status: "expired" } }
        ).exec();
        d.status = "expired";
      }
      const s = String(d.status ?? "").toLowerCase();
      const normalized = s.includes("invite")
        ? "Invited"
        : s.includes("progress")
        ? "InProgress"
        : s.includes("submit")
        ? "Submitted"
        : s.includes("approve")
        ? "Approved"
        : s.includes("reject")
        ? "Rejected"
        : s.includes("expire")
        ? "Expired"
        : "Invited";

      buckets[normalized].push({
        id: String(d._id),
        type: d.type,
        inviteeEmail: d.email ?? "",
        inviteeName: d.inviteeName || d.name || "",
        expiresAt: nowIso(d.expiresAt),
        updatedAt: nowIso(d.updatedAt),
        token: d.token,
      });
    }

    res.json({ buckets });
  } catch (err) {
    next(err);
  }
});

/** 📤 S3 upload presign */
router.post("/upload/presign", noStore, async (req, res, next) => {
  try {
    if (!S3_BUCKET)
      return res.status(500).json({ message: "S3_BUCKET not configured" });

    const { type, kind, filename, contentType, size } = req.body || {};
    if (!type || !kind || !filename || !contentType || typeof size !== "number") {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const clean = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectKey = `onboarding/${String(type)
      .toLowerCase()}/${kind}/${Date.now()}-${crypto
      .randomBytes(8)
      .toString("hex")}-${clean}`;

    if (createPresignedPostFn) {
      const { url, fields } = await createPresignedPostFn(s3, {
        Bucket: S3_BUCKET,
        Key: objectKey,
        Expires: PRESIGN_TTL,
        Conditions: [["content-length-range", 0, 20 * 1024 * 1024]],
        Fields: { "Content-Type": contentType },
      });
      return res.json({ objectKey, upload: { method: "POST", url, fields } });
    }

    if (getSignedUrl) {
      const cmd = new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: objectKey,
        ContentType: contentType,
      });
      const url = await getSignedUrl(s3, cmd, { expiresIn: PRESIGN_TTL });
      return res.json({ objectKey, upload: { method: "PUT", url } });
    }

    res.status(500).json({
      message:
        "S3 presign helpers not installed. Install '@aws-sdk/s3-presigned-post' or '@aws-sdk/s3-request-presigner'.",
    });
  } catch (err) {
    next(err);
  }
});

/** 🧩 Aliases for vendor/business/employee doc upload */
for (const kind of ["vendors", "businesses", "employees"] as const) {
  router.post(`/${kind}/upload-doc`, async (req, res, next) => {
    try {
      (req.body as any).type = kind.slice(0, -1);
      // Delegate to /upload/presign
      const fakeReq: any = {
        ...req,
        url: "/upload/presign",
        method: "POST",
      };
      await (router as any).handle(fakeReq, res, next);
    } catch (e) {
      next(e);
    }
  });
}

/** 🌐 Public viewer (read-only details) */
router.get("/public/:token/details", noStore, async (req, res, next) => {
  try {
    const { token } = req.params;
    const doc = (await (Onboarding as any).findOne({ token })
      .lean()
      .exec()) as OnboardingDoc | null;
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (isExpired(doc.expiresAt))
      return res.status(410).json({ error: "Invite expired" });

    let formData: any = {};
    try {
      if (typeof doc.extras_json === "object" && doc.extras_json !== null)
        formData = doc.extras_json;
      else if (
        typeof doc.formPayload === "object" &&
        doc.formPayload !== null
      )
        formData = doc.formPayload;
      else if (
        typeof doc.formPayload === "string" &&
        (doc.formPayload as any).trim()
      )
        formData = JSON.parse(doc.formPayload as any);
    } catch {
      formData = {};
    }

    res.json({
      id: String(doc._id),
      token: doc.token,
      type: doc.type,
      email: doc.email,
      name: doc.name || doc.inviteeName,
      status: doc.status,
      payload: formData,
      submittedAt: doc.submittedAt,
      updatedAt: doc.updatedAt,
    });
  } catch (err) {
    next(err);
  }
});

/** 🌍 HTML redirector */
router.get("/view/:token", noStore, async (req, res) => {
  const { token } = req.params;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="Cache-Control" content="no-store">
<title>Onboarding Details</title>
<script>window.location.href='/onboarding-details.html?token=${token}'</script></head>
<body>Redirecting...</body></html>`);
});

/** 📎 Generate presigned GET URL for a private S3 document
 *  MUST be registered before /:token/details to avoid route interception
 */
router.get("/document/presign", requireAuth, noStore, async (req, res, next) => {
  try {
    console.log("[presign] HIT — key:", req.query.key);

    const validation = presignQuerySchema.safeParse(req.query);
    if (!validation.success)
      return res.status(400).json({
        error: "Validation failed",
        fields: validation.error.flatten().fieldErrors,
      });

    if (!S3_BUCKET)
      return res.status(500).json({ error: "S3_BUCKET not configured" });
    if (!getSignedUrl)
      return res.status(500).json({ error: "@aws-sdk/s3-request-presigner not installed — run: npm install @aws-sdk/s3-request-presigner" });

    const { key } = validation.data;

    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const cmd = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    });

    const url = await getSignedUrl(s3, cmd, { expiresIn: 300 }); // 5 min TTL
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

/** 🧑‍💼 Admin details (authed) – also triggers sync to HRMS */
router.get("/:token/details", requireAuth, requireWorkspace, noStore, async (req, res, next) => {
  try {
    const { token } = req.params;

    // Support lookup by MongoDB _id (24-char hex) OR by token string
    const isObjectId = /^[0-9a-f]{24}$/i.test(token);
    let doc: OnboardingDoc | null = null;
    if (isObjectId) {
      // findById correctly casts string → ObjectId
      doc = (await (Onboarding as any).findOne({ _id: token, workspaceId: (req as any).workspaceObjectId }).lean().exec()) as OnboardingDoc | null;
    }
    // If not found by _id (or not an ObjectId), try token string
    if (!doc) {
      doc = (await (Onboarding as any).findOne({ token }).lean().exec()) as OnboardingDoc | null;
    }
    if (!doc) return res.status(404).json({ error: "Not found" });
    console.log("[details] doc._id:", String(doc._id), "| documents field:", JSON.stringify(doc.documents), "| formPayload keys:", Object.keys(doc.formPayload || {}));

    // Ensure HRMS sync whenever admin opens details
    await syncEmployeeFromOnboarding(doc);
    await syncCustomerFromOnboarding(doc);


    let formData: any = {};
    try {
      if (typeof doc.extras_json === "object" && doc.extras_json !== null)
        formData = doc.extras_json;
      else if (
        typeof doc.formPayload === "object" &&
        doc.formPayload !== null
      )
        formData = doc.formPayload;
      else if (
        typeof doc.formPayload === "string" &&
        (doc.formPayload as any).trim()
      )
        formData = JSON.parse(doc.formPayload as any);
    } catch {
      formData = {};
    }

    const S3_BASE = process.env.S3_BUCKET
      ? `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION || "ap-south-1"}.amazonaws.com`
      : "";

    const documents = (doc.documents || []).map((d: any) => {
      // ✅ objectKey is what upload/presign stores — check it first
      const key = d.objectKey || d.key || d.Key || d.path || d.s3Key || "";
      const name = d.name || d.filename || d.originalName || key.split("/").pop() || "Document";
      const url = d.url || (S3_BASE && key ? `${S3_BASE}/${encodeURIComponent(key)}` : null);
      return { name, key, url };
    });

    res.json({
      id: String(doc._id),
      token: doc.token,
      name: doc.name,
      email: doc.email,
      type: doc.type,
      status: doc.status,
      ticket: doc.ticket,
      submittedAt: doc.submittedAt,
      updatedAt: doc.updatedAt,
      formPayload: formData,  // ✅ frontend reads this
      payload: formData,      // ✅ backward compat
      documents,
    });
  } catch (err) {
    next(err);
  }
});

/** 🔄 Extend expiry — admin manually extends an invite by 30 days */
router.post("/:id/extend-expiry", requireAuth, requireWorkspace, noStore, async (req, res, next) => {
  try {
    const { id } = req.params;
    const doc: any = await (Onboarding as any).findOne({ _id: id, workspaceId: (req as any).workspaceObjectId }).exec();
    if (!doc) return res.status(404).json({ error: "Onboarding record not found" });

    // Extend from current expiresAt if still in the future, otherwise from now
    const base = doc.expiresAt && new Date(doc.expiresAt).getTime() > Date.now()
      ? new Date(doc.expiresAt).getTime()
      : Date.now();
    doc.expiresAt = new Date(base + 30 * 24 * 60 * 60 * 1000);

    // If status is "expired", reset to a sensible prior status
    if (String(doc.status).toLowerCase() === "expired") {
      doc.status = doc.startedAt ? "started" : "sent";
    }

    doc.updatedAt = new Date();
    await doc.save();

    res.json({
      ok: true,
      id: String(doc._id),
      status: doc.status,
      expiresAt: doc.expiresAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/** 🧑‍💼 Admin decision – also sync on approval */
router.post("/:token/decision", requireAuth, noStore, async (req, res, next) => {
  try {
    const validation = decisionSchema.safeParse(req.body);
    if (!validation.success)
      return res.status(400).json({
        error: "Validation failed",
        fields: validation.error.flatten().fieldErrors,
      });

    const { token } = req.params;
    const { action, remarks } = validation.data;

    // Workspace-scope the lookup for non-SUPERADMIN
    const decisionQuery: any = { token };
    if (!isSuperAdmin(req) && (req as any).workspaceObjectId) {
      decisionQuery.workspaceId = (req as any).workspaceObjectId;
    }
    const doc: any = await (Onboarding as any).findOne(decisionQuery).exec();
    if (!doc) return res.status(404).json({ error: "Not found" });
    const newStatus =
      action === "approved"
        ? "approved"
        : action === "rejected"
        ? "rejected"
        : "in-progress";
    doc.status = newStatus;
    doc.remarks = remarks ?? "";
    doc.updatedAt = new Date();
    if (newStatus === "approved") doc.isActive = true;
    await doc.save();

    if (newStatus === "approved") {
      const syncResult = await syncEmployeeFromOnboarding(doc);
      await syncCustomerFromOnboarding(doc);

      // Send welcome email (non-blocking)
      const docType = String(doc.type || "").toLowerCase();
      if (!doc.welcomeEmailSent) {
        try {
          const loginUrl = (env.FRONTEND_ORIGIN || "https://hrms.plumtrips.com").replace(/\/+$/, "") + "/login";

          if (docType === "employee") {
            // Employee: warm welcome with credentials included
            const officialEmail =
              doc.formPayload?.contact?.companyEmail ||
              doc.formPayload?.contact?.workEmail ||
              doc.formPayload?.officialEmail ||
              syncResult?.email ||
              doc.email || "";
            await sendEmployeeWelcomeEmail({
              name: doc.inviteeName || doc.name || "Employee",
              email: officialEmail,
              loginUrl,
              effectiveDate: new Date(),
              tempPassword: syncResult?.tempPassword,
            });
          } else {
            // Vendor / Customer: formal welcome
            const relationshipType = docType === "vendor" ? "Vendor" : "Customer";
            await sendOnboardingWelcomeEmail({
              to: doc.email || "",
              counterpartyName: doc.inviteeName || doc.name || relationshipType,
              effectiveDate: new Date().toISOString().slice(0, 10),
              relationshipType,
            });
          }

          doc.welcomeEmailSent = true;
          await doc.save();
        } catch (welcErr) {
          console.error("[decision] welcome email failed:", welcErr);
        }
      }
    }

    // FIX 3: Send rejection notification email
    if (newStatus === "rejected") {
      try {
        await sendRejectionEmail({
          to: doc.email || "",
          name: doc.inviteeName || doc.name || "Applicant",
        });
      } catch (rejErr) {
        console.error("[decision] rejection email failed:", rejErr);
      }
    }

    res.json({ ok: true, token, status: newStatus, remarks: doc.remarks });
  } catch (err) {
    next(err);
  }
});

/** 🔗 Back-compat alias for Public UI: GET /api/onboarding/invite/:token */
router.get("/invite/:token", noStore, async (req, res) => {
  const { token } = req.params;
  try {
    const doc = (await (Onboarding as any).findOne({ token })
      .lean()
      .exec()) as OnboardingDoc | null;
    if (!doc) return res.status(404).json({ error: "Invite not found" });
    if (isExpired(doc.expiresAt))
      return res.status(410).json({ error: "Invite expired" });

    // Try to extract a fallback email from existing payload (older drafts)
    let fallbackEmail: string | undefined;
    try {
      const payload =
        typeof doc.formPayload === "string"
          ? JSON.parse(doc.formPayload)
          : (doc.formPayload ||
              doc.payload ||
              doc.extras_json ||
              {});
      fallbackEmail =
        (payload as any).email ||
        (payload as any).businessEmail ||
        (payload as any).contactEmail ||
        undefined;
    } catch {
      /* ignore */
    }

    const email = doc.email || fallbackEmail || "";
    const name = doc.name || doc.inviteeName || "";
    const expiresAtIso = doc.expiresAt
      ? new Date(doc.expiresAt).toISOString()
      : null;
    const type =
      (doc.type as any) ||
      (resolveType(doc.type) as any) ||
      "business";
    const status = doc.status || "invited";

    return res.json({
      ok: true,
      token: doc.token!,
      type,
      status,
      email,
      inviteeEmail: email,
      name,
      inviteeName: name,
      expiresAt: expiresAtIso,
      draftUrl: `/api/onboarding/draft/${doc.token}`,
      submitUrl: `/api/onboarding/submit/${doc.token}`,
      detailsUrl: `/api/onboarding/public/${doc.token}/details`,
      message:
        String(status).toLowerCase() === "submitted"
          ? "All required details have been submitted"
          : undefined,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

export default router;