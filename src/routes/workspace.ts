// apps/backend/src/routes/workspace.ts
import express from "express";
import multer from "multer";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";

import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";
import WorkspaceBranding from "../models/WorkspaceBranding.js";

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* S3 client for logo uploads                                                 */
/* -------------------------------------------------------------------------- */

const s3Logo = new S3Client({
  region: env.AWS_REGION,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : undefined,
});

const s3LogoPublicBase = (process.env.S3_BASE_URL || process.env.AWS_S3_PUBLIC_BASE_URL || "").trim();

function buildLogoPublicUrl(key: string) {
  const bucket = env.S3_BUCKET;
  if (s3LogoPublicBase) return `${s3LogoPublicBase.replace(/\/+$/, "")}/${key}`;
  return `https://${bucket}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
}

function safeExtFromMimetype(mime: string) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  return "";
}

/* -------------------------------------------------------------------------- */
/* Logo presigned URL helper (identical pattern to signAvatarUrl in users.ts) */
/* -------------------------------------------------------------------------- */

type LogoUrlCacheEntry = { url: string; expAt: number };
const LOGO_URL_CACHE = new Map<string, LogoUrlCacheEntry>();

async function signLogoUrl(key?: string): Promise<string> {
  if (!key) return "";
  const now = Date.now();
  const cached = LOGO_URL_CACHE.get(key);
  if (cached && cached.expAt > now + 30_000) return cached.url;
  const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 900 }); // 15 minutes
  LOGO_URL_CACHE.set(key, { url, expAt: now + 14 * 60 * 1000 });
  return url;
}

// ✅ TS-safe: never pass Error to cb (avoids "Error | null not assignable to null")
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === "image/png" ||
      file.mimetype === "image/jpeg" ||
      file.mimetype === "image/webp";
    cb(null, ok);
  },
});

/* -------------------------------------------------------------------------- */
/* Auth helpers                                                               */
/* -------------------------------------------------------------------------- */

type AnyObj = Record<string, any>;

function pickFrom(obj: AnyObj, keys: string[]) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function getTokenFromReq(req: AnyObj): string | null {
  const auth = String(req.headers?.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m?.[1]) return m[1].trim();

  const cookies = req.cookies || {};
  const c =
    cookies.accessToken ||
    cookies.token ||
    cookies.jwt ||
    cookies.session ||
    cookies["hrms_token"];
  if (c) return String(c);

  return null;
}

function decodeUser(req: AnyObj): AnyObj | null {
  if (req.user) return req.user;

  const token = getTokenFromReq(req);
  if (!token) return null;

  try {
    const secret = (env as any).JWT_SECRET || process.env.JWT_SECRET;
    if (!secret) return null;

    const payload = jwt.verify(token, secret) as AnyObj;
    req.user = payload;
    return payload;
  } catch {
    return null;
  }
}

function requireAuth(req: AnyObj, res: express.Response): AnyObj | null {
  const u = decodeUser(req);
  if (!u) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return null;
  }
  return u;
}

function normalizeEmail(v: any) {
  const s = String(v || "").trim().toLowerCase();
  return s.includes("@") ? s : "";
}

function safeStr(v: any) {
  return String(v ?? "").trim();
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isValidObjectId(v: any) {
  return mongoose.isValidObjectId(v);
}

function isStaffish(user: AnyObj): boolean {
  if (user?.staff === true) return true;
  const rolesRaw =
    user?.roles || user?.role || user?.hrmsAccessRole || user?.hrmsAccessLevel;
  const roles = Array.isArray(rolesRaw) ? rolesRaw : [rolesRaw].filter(Boolean);
  const up = roles.map((r: any) => String(r).toUpperCase());
  return up.some((r: string) =>
    ["ADMIN", "HR", "SUPERADMIN", "SUPER_ADMIN", "OWNER", "MANAGER"].includes(r)
  );
}

function roleList(user: AnyObj): string[] {
  const raw = user?.roles || [];
  const arr = Array.isArray(raw) ? raw : [raw].filter(Boolean);
  return arr.map((x: any) => String(x || "").trim().toUpperCase()).filter(Boolean);
}

function looksCustomerish(user: AnyObj): boolean {
  const roles = roleList(user);
  const at = String(user?.accountType || user?.userType || "").toUpperCase();
  return at === "CUSTOMER" || roles.includes("CUSTOMER") || roles.includes("REQUESTER") || roles.includes("APPROVER");
}

function looksVendorish(user: AnyObj): boolean {
  const roles = roleList(user);
  const at = String(user?.accountType || user?.userType || "").toUpperCase();
  return at === "VENDOR" || roles.includes("VENDOR");
}

/* -------------------------------------------------------------------------- */
/* Workspace resolution (NO env defaults; DB-first)                            */
/* -------------------------------------------------------------------------- */

type ResolvedScope = {
  scopeType: "BUSINESS" | "CUSTOMER" | "VENDOR" | "USER";
  scopeId: string;        // IMPORTANT: for CUSTOMER, this will be customerId (string)
  customerId?: string;    // same as scopeId for CUSTOMER
  vendorId?: string;
  memberRole?: string;    // WORKSPACE_LEADER / APPROVER / REQUESTER (if found)
  workspaceMeta?: AnyObj; // small workspace details (domains/approvers)
  reason?: string;
  debug?: AnyObj;
};

async function resolveCustomerIdFromWorkspaceRef(ref: string): Promise<string | null> {
  const r = safeStr(ref);
  if (!r) return null;

  // A) by customerId string
  const byCustomerId = await CustomerWorkspace.findOne({ customerId: r }).lean().exec();
  if (byCustomerId?.customerId) return String(byCustomerId.customerId);

  // B) by _id (if someone passes workspace _id)
  if (isValidObjectId(r)) {
    const byId = await CustomerWorkspace.findById(r).lean().exec();
    if (byId?.customerId) return String(byId.customerId);
  }

  return null;
}

async function loadWorkspaceMeta(customerId: string) {
  const ws = await CustomerWorkspace.findOne({ customerId }).lean().exec();
  if (!ws) return null;
  return {
    allowedDomains: (ws as any).allowedDomains || [],
    allowedEmails: (ws as any).allowedEmails || [],
    defaultApproverEmails: (ws as any).defaultApproverEmails || [],
    canApproverCreateUsers: Boolean((ws as any).canApproverCreateUsers),
    status: (ws as any).status || "ACTIVE",
  };
}

async function resolveWorkspaceScope(user: AnyObj, req: AnyObj): Promise<ResolvedScope> {
  const staff = isStaffish(user);

  // 0) Staff override via query (ONLY for staff)
  const qCustomerId = safeStr(req.query?.customerId);
  if (qCustomerId && staff) {
    const cid = await resolveCustomerIdFromWorkspaceRef(qCustomerId);
    if (cid) {
      return {
        scopeType: "CUSTOMER",
        scopeId: cid,
        customerId: cid,
        workspaceMeta: (await loadWorkspaceMeta(cid)) || undefined,
        reason: "query:customerId",
        debug: { staff: true, queryCustomerId: qCustomerId, resolvedCustomerId: cid },
      };
    }
    // If query passed but no workspace exists, still return CUSTOMER scope (so UI can show mismatch)
    return {
      scopeType: "CUSTOMER",
      scopeId: qCustomerId,
      customerId: qCustomerId,
      reason: "query:customerId(no-workspace)",
      debug: { staff: true, queryCustomerId: qCustomerId },
    };
  }

  // 1) Token-based workspace references (customerId/businessId/workspaceId)
  const tokenWorkspaceRef = safeStr(
    pickFrom(user, [
      "customerId",
      "customer_id",
      "businessId",
      "business_id",
      "customerBusinessId",
      "customer_business_id",
      "workspaceId",
      "workspace_id",
    ])
  );
  if (tokenWorkspaceRef) {
    const cid = await resolveCustomerIdFromWorkspaceRef(tokenWorkspaceRef);
    if (cid) {
      return {
        scopeType: "CUSTOMER",
        scopeId: cid,
        customerId: cid,
        workspaceMeta: (await loadWorkspaceMeta(cid)) || undefined,
        reason: "token:customerRef->workspace",
        debug: { tokenWorkspaceRef, resolvedCustomerId: cid },
      };
    }

    // If token already carries the new-style string customerId (like dev_customer_workspace), accept it.
    return {
      scopeType: "CUSTOMER",
      scopeId: tokenWorkspaceRef,
      customerId: tokenWorkspaceRef,
      workspaceMeta: (await loadWorkspaceMeta(tokenWorkspaceRef)) || undefined,
      reason: "token:customerRef(raw)",
      debug: { tokenWorkspaceRef },
    };
  }

  // 2) Vendor id from token (if any)
  const tokenVendor = safeStr(pickFrom(user, ["vendorId", "vendor_id", "vendorProfileId"]));
  if (tokenVendor) {
    return { scopeType: "VENDOR", scopeId: tokenVendor, vendorId: tokenVendor, reason: "token:vendor" };
  }

  // 3) ✅ FIX: USER-scope token → load User doc → read user.customerId → map to customer workspace
  const sub = safeStr(pickFrom(user, ["sub", "id", "_id", "userId", "user_id"]));
  const actorEmail = normalizeEmail(pickFrom(user, ["email", "mail", "username", "userEmail"]));

  if (sub && isValidObjectId(sub)) {
    const u: any = await User.findOne({ _id: sub, workspaceId: req.workspaceId }).lean().exec();

    const dbEmail = normalizeEmail(u?.email || "");
    const mergedEmail = actorEmail || dbEmail;

    const userCustomerId = safeStr(u?.customerId || u?.businessId);
    const userVendorId = safeStr(u?.vendorId);

    // If user is customer-ish, prefer customerId
    if (userCustomerId && (looksCustomerish(u) || looksCustomerish(user) || !looksVendorish(u))) {
      // If someone mistakenly stored workspace _id in user.customerId, normalize it
      const cid = (await resolveCustomerIdFromWorkspaceRef(userCustomerId)) || userCustomerId;

      // Also attempt to fetch member role for this email in this workspace
      let memberRole: string | undefined;
      if (mergedEmail) {
        const rx = new RegExp(`^${escapeRegExp(mergedEmail)}$`, "i");
        const mem: any = await CustomerMember.findOne({
          customerId: cid,
          email: rx,
          $or: [{ isActive: { $exists: false } }, { isActive: true }],
        })
          .sort({ updatedAt: -1, createdAt: -1 })
          .lean()
          .exec();
        if (mem?.role) memberRole = String(mem.role);
      }

      return {
        scopeType: "CUSTOMER",
        scopeId: cid,
        customerId: cid,
        memberRole,
        workspaceMeta: (await loadWorkspaceMeta(cid)) || undefined,
        reason: "db:user.customerId",
        debug: { sub, dbEmail: dbEmail || null },
      };
    }

    // Vendor
    if (userVendorId && (looksVendorish(u) || looksVendorish(user))) {
      return {
        scopeType: "VENDOR",
        scopeId: userVendorId,
        vendorId: userVendorId,
        reason: "db:user.vendorId",
        debug: { sub },
      };
    }
  }

  // 4) Member lookup by email → use member.customerId (works even if User.customerId missing)
  if (actorEmail) {
    const rx = new RegExp(`^${escapeRegExp(actorEmail)}$`, "i");
    const mem: any = await CustomerMember.findOne({
      email: rx,
      $or: [{ isActive: { $exists: false } }, { isActive: true }],
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean()
      .exec();

    if (mem?.customerId) {
      const cid = String(mem.customerId);
      return {
        scopeType: "CUSTOMER",
        scopeId: cid,
        customerId: cid,
        memberRole: mem?.role ? String(mem.role) : undefined,
        workspaceMeta: (await loadWorkspaceMeta(cid)) || undefined,
        reason: "db:customermembers.email",
        debug: { actorEmail },
      };
    }
  }

  // 5) Fallback to USER scope
  const uid = sub || "unknown";
  return {
    scopeType: "USER",
    scopeId: uid,
    reason: "fallback:user",
    debug: { actorEmail: actorEmail || null, staff },
  };
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

router.get("/me", async (req: AnyObj, res) => {
  try {
  const user = requireAuth(req, res);
  if (!user) return;

  const scope = await resolveWorkspaceScope(user, req);

  const branding = (await WorkspaceBranding.findOne({
    subjectType: scope.scopeType,
    subjectId: scope.scopeId,
  }).lean()) as null | { logoKey?: string; logoUrl?: string };

  let logoUrl = branding?.logoUrl || "";
  if (branding?.logoKey) {
    try {
      logoUrl = await signLogoUrl(branding.logoKey);
    } catch {
      // S3 sign failure is non-fatal — return without logo
    }
  }

  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,

    // Backward compat + what approvals need
    customerId:
      scope.customerId ||
      (scope.scopeType === "CUSTOMER" ? scope.scopeId : undefined),

    workspaceId: scope.scopeId,

    workspace: {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      logoUrl,
    },

    // Extra helpful info (safe to ignore on frontend)
    memberRole: scope.memberRole,
    workspaceMeta: scope.workspaceMeta,

    hint:
      scope.scopeType === "USER"
        ? "You are in USER scope. Fix is: link this login to a Customer workspace via User.customerId OR a CustomerMember record (customermembers). No .env default is used."
        : undefined,

    debug:
      process.env.NODE_ENV !== "production"
        ? {
            reason: scope.reason,
            ...scope.debug,
            staff: isStaffish(user),
          }
        : undefined,
  });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to load workspace" });
  }
});

// Small guard to return a clean message when fileFilter rejects
function logoMimeGuard(_req: AnyObj, _res: express.Response, next: express.NextFunction) {
  // multer will still call next() with req.file undefined if rejected by fileFilter
  next();
}

router.post("/logo", logoMimeGuard, upload.single("logo"), async (req: AnyObj, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  // Allow workspace admins and customer/business users
  // (WORKSPACE_LEADER in roles[] OR customer account type via looksCustomerish)
  const logoRoles = roleList(user);
  if (
    !logoRoles.includes("SUPERADMIN") &&
    !logoRoles.includes("ADMIN") &&
    !logoRoles.includes("HR") &&
    !logoRoles.includes("WORKSPACE_LEADER") &&
    !looksCustomerish(user)
  ) {
    return res.status(403).json({ error: "Admin access required to upload logo" });
  }

  if (!req.file?.buffer?.length) {
    return res.status(400).json({
      ok: false,
      error: "Logo upload failed. Use field name 'logo' and upload PNG/JPG/WEBP (max 2MB).",
    });
  }

  const scope = await resolveWorkspaceScope(user, req);

  const ext =
    safeExtFromMimetype(req.file.mimetype) ||
    ("." + (req.file.originalname.split(".").pop() || "png"));
  const rand = crypto.randomBytes(10).toString("hex");
  const key = `workspace-logos/${scope.scopeId}/${Date.now()}-${rand}${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    })
  );

  await WorkspaceBranding.findOneAndUpdate(
    { subjectType: scope.scopeType, subjectId: scope.scopeId },
    { $set: { logoKey: key, logoUrl: "" } },
    { upsert: true, new: true }
  );

  const logoUrl = await signLogoUrl(key);

  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, logoUrl });
});

/* -------------------------------------------------------------------------- */
/* Workspace config (travelFlow / features / approval)                        */
/* -------------------------------------------------------------------------- */

const SBT_MODES = new Set(["SBT", "FLIGHTS_ONLY", "HOTELS_ONLY", "BOTH"]);

function deriveConfigFromLegacy(travelMode: string | undefined) {
  const mode = travelMode || "APPROVAL_FLOW";
  const isSBT = SBT_MODES.has(mode);
  return {
    travelFlow: isSBT ? "SBT" : "APPROVAL_FLOW",
    approval: { requireL2: true, requireL0: false, requireProposal: true },
    tokenExpiryHours: 12,
    features: {
      sbtEnabled: isSBT,
      approvalFlowEnabled: !isSBT,
      approvalDirectEnabled: false,
      flightBookingEnabled: true,
      hotelBookingEnabled: true,
      visaEnabled: false,
      miceEnabled: false,
      forexEnabled: false,
    },
  };
}

/**
 * GET /api/v1/workspace/config
 * Returns workspace config for the current user's workspace.
 */
router.get("/config", async (req: AnyObj, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  try {
    const scope = await resolveWorkspaceScope(user, req);
    const customerId = scope.customerId || scope.scopeId;

    if (scope.scopeType !== "CUSTOMER" || !customerId) {
      return res.status(400).json({ error: "No customer workspace found" });
    }

    const ws: any = await CustomerWorkspace.findOne({ customerId }).lean();
    if (!ws) {
      return res.status(404).json({ error: "Workspace not configured" });
    }

    // Use config subdocument if present, otherwise derive from legacy travelMode
    const config = ws.config?.travelFlow
      ? ws.config
      : deriveConfigFromLegacy(ws.travelMode);

    // Merge feature flags that may have been set directly on config.features
    // (e.g. payrollEnabled set via workspace.settings payroll-enable endpoint)
    if (ws.config?.features) {
      if (!config.features) config.features = {};
      if (ws.config.features.payrollEnabled !== undefined) {
        config.features.payrollEnabled = ws.config.features.payrollEnabled;
      }
    }

    // Attach per-user formTier from CustomerMember
    const userEmail = String(user.email || user.sub || "").toLowerCase().trim();
    if (userEmail && userEmail.includes("@")) {
      const member = await CustomerMember.findOne({
        customerId: String(customerId),
        email: userEmail,
      }).lean();
      (config as any).formTier = (member as any)?.formTier || "standard";
    } else {
      (config as any).formTier = "standard";
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, customerId, config });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to read workspace config", detail: err?.message });
  }
});

const VALID_TRAVEL_FLOWS = ["SBT", "APPROVAL_FLOW", "APPROVAL_DIRECT", "HYBRID"];

const FLOW_TO_FEATURES: Record<string, { sbtEnabled: boolean; approvalFlowEnabled: boolean; approvalDirectEnabled: boolean }> = {
  SBT:              { sbtEnabled: true,  approvalFlowEnabled: false, approvalDirectEnabled: false },
  APPROVAL_FLOW:    { sbtEnabled: false, approvalFlowEnabled: true,  approvalDirectEnabled: false },
  APPROVAL_DIRECT:  { sbtEnabled: false, approvalFlowEnabled: true,  approvalDirectEnabled: true  },
  HYBRID:           { sbtEnabled: true,  approvalFlowEnabled: true,  approvalDirectEnabled: false },
};

const FLOW_TO_LEGACY: Record<string, string> = {
  SBT:             "SBT",
  APPROVAL_FLOW:   "APPROVAL_FLOW",
  APPROVAL_DIRECT: "APPROVAL_FLOW",
  HYBRID:          "BOTH",
};

/**
 * PATCH /api/v1/workspace/config/travel-flow
 * Admin-only: update workspace travelFlow + sync features + bulk-update users.
 * Body: { customerId, travelFlow }
 */
router.patch("/config/travel-flow", async (req: AnyObj, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  // Admin-only
  const roles = roleList(user);
  if (!roles.includes("SUPERADMIN") && !roles.includes("ADMIN")) {
    return res.status(403).json({ error: "Admin access required" });
  }

  try {
    const travelFlow = safeStr(req.body?.travelFlow);
    const customerId = safeStr(req.body?.customerId);

    if (!VALID_TRAVEL_FLOWS.includes(travelFlow)) {
      return res.status(400).json({ error: `travelFlow must be one of: ${VALID_TRAVEL_FLOWS.join(", ")}` });
    }
    if (!customerId) {
      return res.status(400).json({ error: "customerId is required" });
    }

    const ws: any = await CustomerWorkspace.findOne({ customerId });
    if (!ws) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    // Update config.travelFlow and config.features
    const featureUpdate = FLOW_TO_FEATURES[travelFlow];
    const legacyMode = FLOW_TO_LEGACY[travelFlow] || "APPROVAL_FLOW";

    // Use updateOne with $set to avoid Mongoose full-document validation
    // (other fields like `industry` may hold values outside their enum if set
    // via older code paths — a full ws.save() would throw ValidationError for
    // those unrelated fields and block this config update)
    await CustomerWorkspace.updateOne(
      { customerId },
      {
        $set: {
          travelMode: legacyMode,
          "config.travelFlow": travelFlow,
          "config.features.sbtEnabled": featureUpdate.sbtEnabled,
          "config.features.approvalFlowEnabled": featureUpdate.approvalFlowEnabled,
          "config.features.approvalDirectEnabled": featureUpdate.approvalDirectEnabled,
        },
      },
    );

    // Bulk-update all workspace users
    const members = await CustomerMember.find({ customerId }).lean().exec();
    const memberEmails = members
      .filter((m: any) => !!m.email)
      .map((m: any) => normalizeEmail(m.email))
      .filter(Boolean);

    let updatedCount = 0;
    if (memberEmails.length) {
      if (featureUpdate.sbtEnabled) {
        const result = await User.updateMany(
          { email: { $in: memberEmails }, workspaceId: ws._id },
          { $set: { sbtEnabled: true, sbtBookingType: "both" } },
        );
        updatedCount = result.modifiedCount ?? 0;
      } else {
        const result = await User.updateMany(
          { email: { $in: memberEmails }, workspaceId: ws._id },
          { $set: { sbtEnabled: false } },
        );
        updatedCount = result.modifiedCount ?? 0;
      }
    }

    res.json({ ok: true, travelFlow, updatedCount });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to update travel flow", detail: err?.message });
  }
});

export default router;
