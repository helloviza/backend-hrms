// apps/backend/src/routes/customerWorkspace.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";
import MasterData from "../models/MasterData.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import WorkspaceBranding from "../models/WorkspaceBranding.js";

const router = Router();

function normEmail(v: any) {
  return String(v || "").trim().toLowerCase();
}
function normalizeList(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}
function collectRoles(u: any): string[] {
  const roles: string[] = [];
  if (Array.isArray(u?.roles)) roles.push(...u.roles);
  if (u?.role) roles.push(u.role);
  if (u?.accountType) roles.push(u.accountType);
  if (u?.userType) roles.push(u.userType);
  if (u?.hrmsAccessRole) roles.push(u.hrmsAccessRole);
  if (u?.hrmsAccessLevel) roles.push(u.hrmsAccessLevel);
  return roles.map((r) => String(r).trim().toUpperCase()).filter(Boolean);
}
function isAdmin(u: any) {
  const r = collectRoles(u);
  return r.includes("ADMIN") || r.includes("SUPERADMIN") || r.includes("SUPER_ADMIN");
}
function isCustomerUser(u: any) {
  const r = collectRoles(u);
  return r.includes("CUSTOMER") || r.includes("BUSINESS");
}

async function resolveCustomerDocFromUser(user: any) {
  const rawEmail = normEmail(user?.email || user?.sub || "");
  const ownerId = String(user?.sub || user?._id || user?.id || "").trim();

  const base: any = { type: "Business" };
  const or: any[] = [];

  if (rawEmail) {
    or.push(
      { email: new RegExp(`^${rawEmail}$`, "i") },
      { officialEmail: new RegExp(`^${rawEmail}$`, "i") },
      { "payload.email": new RegExp(`^${rawEmail}$`, "i") },
      { "payload.officialEmail": new RegExp(`^${rawEmail}$`, "i") },
      { "payload.primaryEmail": new RegExp(`^${rawEmail}$`, "i") }
    );
  }
  if (ownerId) {
    or.push({ ownerId }, { "payload.ownerId": ownerId }, { "payload.createdBy": ownerId });
  }
  if (or.length) base.$or = or;

  return MasterData.findOne(base).sort({ updatedAt: -1, createdAt: -1 }).lean().exec();
}

async function getOrCreateWorkspace(customerId: string) {
  const existing = await CustomerWorkspace.findOne({ customerId }).lean().exec();
  if (existing) return existing;
  const created = await CustomerWorkspace.create({
    customerId,
    allowedDomains: [],
    allowedEmails: [],
    defaultApproverEmails: [],
    canApproverCreateUsers: true,
    status: "ACTIVE",
  });
  return created.toObject();
}

router.get("/me", requireAuth, async (req: any, res, next) => {
  try {
    if (!isCustomerUser(req.user) && !isAdmin(req.user)) {
      return res.status(403).json({ error: "Customer access required" });
    }

    const customer = await resolveCustomerDocFromUser(req.user);
    if (!customer) return res.status(400).json({ error: "Customer profile not found" });

    const ws = await getOrCreateWorkspace(String(customer._id));
    const branding = await WorkspaceBranding.findOne({
      subjectType: "CUSTOMER",
      subjectId: String(customer._id),
    }).lean() as null | { logoKey?: string; logoUrl?: string };
    const logoKey = branding?.logoKey || "";
    const logoUrl = logoKey
      ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: logoKey }), { expiresIn: 900 })
      : branding?.logoUrl || null;
    res.json({ ok: true, workspace: { ...ws, logoUrl }, customer });
  } catch (e) {
    next(e);
  }
});

router.put("/settings", requireAuth, async (req: any, res, next) => {
  try {
    if (!isCustomerUser(req.user) && !isAdmin(req.user)) {
      return res.status(403).json({ error: "Customer access required" });
    }

    const customer = await resolveCustomerDocFromUser(req.user);
    if (!customer) return res.status(400).json({ error: "Customer profile not found" });

    const customerId = String(customer._id);
    const patch: any = {};

    if ("allowedDomains" in (req.body || {})) patch.allowedDomains = normalizeList(req.body.allowedDomains).map((s) => s.toLowerCase());
    if ("allowedEmails" in (req.body || {})) patch.allowedEmails = normalizeList(req.body.allowedEmails).map(normEmail);
    if ("defaultApproverEmails" in (req.body || {})) patch.defaultApproverEmails = normalizeList(req.body.defaultApproverEmails).map(normEmail);
    if ("canApproverCreateUsers" in (req.body || {})) patch.canApproverCreateUsers = Boolean(req.body.canApproverCreateUsers);
    if ("status" in (req.body || {})) patch.status = String(req.body.status || "ACTIVE").toUpperCase();

    const ws = await CustomerWorkspace.findOneAndUpdate(
      { customerId },
      { $set: patch, $setOnInsert: { customerId } },
      { new: true, upsert: true }
    ).lean();

    res.json({ ok: true, workspace: ws });
  } catch (e) {
    next(e);
  }
});

export default router;
