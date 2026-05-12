// apps/backend/src/routes/hrPolicies.ts
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

import Policy from "../models/Policy.js";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import { uploadBufferToS3 } from "../utils/s3Upload.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { env } from "../config/env.js";

const router = express.Router();

/* -----------------------------------------------------------
   Role helpers
----------------------------------------------------------- */

function normRoles(user: any): string[] {
  const raw: string[] = [];
  if (Array.isArray(user?.roles)) raw.push(...user.roles);
  if (user?.role) raw.push(user.role);
  if (user?.hrmsAccessRole) raw.push(user.hrmsAccessRole);
  return raw
    .filter(Boolean)
    .map((r) => String(r).toUpperCase().replace(/[\s_-]+/g, ""));
}

function isStaffAdmin(user: any): boolean {
  const nr = normRoles(user);
  return nr.includes("HR") || nr.includes("ADMIN") || nr.includes("SUPERADMIN");
}

function isL0(user: any): boolean {
  if (isStaffAdmin(user)) return false;
  const nr = normRoles(user);
  const accessRole = String(user?.hrmsAccessRole || "")
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
  return nr.includes("CUSTOMERADMIN") || accessRole === "L0";
}

function isVendorUser(user: any): boolean {
  const at = String(user?.accountType || "").toUpperCase();
  const ut = String(user?.userType || "").toUpperCase();
  return at === "VENDOR" || ut === "VENDOR";
}

function resolveUserCustomerId(user: any): string | null {
  return user?.customerId || user?.businessId || null;
}

/** Returns 'ADMIN' | 'L0' | false depending on management capability */
function canManage(user: any): "ADMIN" | "L0" | false {
  if (isStaffAdmin(user)) return "ADMIN";
  // SaaS HRMS workspace owners — they administer their own workspace
  // and have no customerId/businessId, so the L0 branch (which requires
  // those fields) cannot serve them. Promote to ADMIN tier.
  const nr = normRoles(user);
  if (nr.includes("TENANTADMIN") || nr.includes("WORKSPACELEADER")) return "ADMIN";
  if (isL0(user)) return "L0";
  return false;
}

/* -----------------------------------------------------------
   Policy query filter based on user role
----------------------------------------------------------- */

function buildPolicyFilter(user: any, req?: any): Record<string, any> {
  // SaaS HRMS tenants are isolated to their own workspace's policies plus
  // any platform-wide GLOBAL announcements (created by HOUSE). They never
  // see other tenants' WORKSPACE policies or HOUSE ORG policies.
  if (req?.workspace?.tenantType === "SAAS_HRMS") {
    return {
      $or: [
        { scope: "WORKSPACE", workspaceId: req.workspaceObjectId },
        { scope: "GLOBAL" },
      ],
    };
  }

  // HOUSE staff admin sees everything
  if (isStaffAdmin(user)) return {};

  const custId = resolveUserCustomerId(user);
  const conditions: any[] = [];

  // Determine which visibility values this user can see
  // null included so existing policies without visibility field are visible
  const visibleTo: (string | null)[] = ["ALL", null];
  if (isVendorUser(user)) {
    visibleTo.push("VENDOR");
  } else if (custId) {
    visibleTo.push("CUSTOMER");
  } else {
    visibleTo.push("INTERNAL");
  }

  // GLOBAL / unset scope policies with matching visibility
  conditions.push({
    scope: { $in: ["GLOBAL", null] },
    visibility: { $in: visibleTo },
  });

  // ORG-scoped policies for their own org (not for vendors)
  if (custId && !isVendorUser(user)) {
    conditions.push({ scope: "ORG", customerId: custId });
  }

  return { $or: conditions };
}

/* -----------------------------------------------------------
   File upload setup for policy PDFs (memory → S3, voucher pattern)
----------------------------------------------------------- */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB
  },
  fileFilter(_req, file, cb) {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and Word documents are allowed for policy uploads."));
    }
  },
});

/* -----------------------------------------------------------
   GET /api/hr/policies
   Root list endpoint — the frontend calls api.get("/hr/policies").
   Returns policies scoped to the caller's role / org.
----------------------------------------------------------- */
router.get("/", requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    const filter = buildPolicyFilter(req.user, req);
    const items = await Policy.find(filter)
      .sort({ createdAt: 1 })
      .lean()
      .exec();

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/* -----------------------------------------------------------
   GET /api/hr/policies/list
   Legacy alias — same logic as GET /.
----------------------------------------------------------- */
router.get("/list", requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    const filter = buildPolicyFilter(req.user, req);
    const items = await Policy.find(filter)
      .sort({ createdAt: 1 })
      .lean()
      .exec();

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/* -----------------------------------------------------------
   POST /api/hr/policies
   Admin/HR: create GLOBAL or ORG-specific URL policy.
   L0: create ORG-scoped policy for own org only.
   L1/L2/Employee: 403.
----------------------------------------------------------- */
router.post("/", requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    const mgmt = canManage(req.user);
    if (!mgmt) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const { title, url, category, tags, scope, customerId, visibility } =
      req.body || {};
    if (!title || !url) {
      return res.status(400).json({
        error: "Both title and URL are required for a URL-based policy.",
      });
    }

    const tagArray: string[] = Array.isArray(tags)
      ? tags
      : typeof tags === "string"
        ? tags
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
        : [];

    let finalScope = scope || "ORG";
    let finalCustomerId = customerId || null;

    if (mgmt === "L0") {
      // L0 can only create ORG-scoped for their own org
      finalScope = "ORG";
      finalCustomerId = resolveUserCustomerId(req.user);
      if (!finalCustomerId) {
        return res
          .status(403)
          .json({ error: "Cannot determine your organization" });
      }
    }

    // Defensive: silently coerce GLOBAL writes to ORG. We've stopped
    // surfacing GLOBAL in the UI; this is the safety net for older
    // clients still posting scope=GLOBAL.
    if (finalScope === "GLOBAL") {
      finalScope = "ORG";
    }

    // SaaS tenants are forced to WORKSPACE scope so policies never leak
    // across tenants. Must run before the ORG/customerId validation below.
    const isSaasTenant = req.workspace?.tenantType === "SAAS_HRMS";
    if (isSaasTenant) {
      finalScope = "WORKSPACE";
      finalCustomerId = null;
    }

    if (finalScope === "ORG" && !finalCustomerId && mgmt === "ADMIN") {
      return res
        .status(400)
        .json({ error: "customerId is required for ORG-scoped policies" });
    }

    const policy = await Policy.create({
      title: String(title).trim(),
      url: String(url).trim(),
      category: category ? String(category).trim() : undefined,
      tags: tagArray,
      kind: "URL",
      scope: finalScope,
      customerId: finalScope === "ORG" ? finalCustomerId : undefined,
      workspaceId: req.workspaceObjectId,
      visibility: visibility || "ALL",
      uploadedBy: req.user?._id,
      createdBy: req.user?._id,
      updatedBy: req.user?._id,
    });

    res.json(policy);
  } catch (err) {
    next(err);
  }
});

/* -----------------------------------------------------------
   POST /api/hr/policies/upload
   Admin/HR: upload PDF/Word and auto-create a FILE policy.
   L0: upload for own org only.
   L1/L2/Employee: 403.
----------------------------------------------------------- */
router.post(
  "/upload",
  requireAuth,
  requireWorkspace,
  upload.single("file"),
  async (req: any, res, next) => {
    try {
      const mgmt = canManage(req.user);
      if (!mgmt) {
        return res.status(403).json({ error: "Not allowed" });
      }

      const file = req.file;
      if (!file || !file.buffer) {
        return res.status(400).json({ error: "File is required" });
      }

      const { title, category, tags, scope, customerId, visibility } =
        req.body || {};
      const effectiveTitle =
        (title && String(title).trim()) || file.originalname;

      const tagArray: string[] = Array.isArray(tags)
        ? tags
        : typeof tags === "string"
          ? tags
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          : [];

      let finalScope = scope || "ORG";
      let finalCustomerId = customerId || null;

      if (mgmt === "L0") {
        finalScope = "ORG";
        finalCustomerId = resolveUserCustomerId(req.user);
        if (!finalCustomerId) {
          return res
            .status(403)
            .json({ error: "Cannot determine your organization" });
        }
      }

      // Defensive: silently coerce GLOBAL writes to ORG so we stop
      // accumulating new GLOBAL docs. Existing GLOBAL docs in Mongo are
      // untouched and remain visible to HOUSE staff admins.
      if (finalScope === "GLOBAL") {
        finalScope = "ORG";
      }

      // SaaS tenants are forced to WORKSPACE scope so policies never leak
      // across tenants. Must run before any ORG/customerId validation.
      const isSaasTenant = req.workspace?.tenantType === "SAAS_HRMS";
      if (isSaasTenant) {
        finalScope = "WORKSPACE";
        finalCustomerId = null;
      }

      const uploaderId = String(req.user?._id || req.user?.id || req.user?.sub || "");
      const tenantBucketScope = String(req.workspaceObjectId || uploaderId || "policies");

      const uploaded = await uploadBufferToS3({
        buffer: file.buffer,
        mime: file.mimetype,
        originalName: file.originalname,
        customerId: tenantBucketScope,
        createdBy: uploaderId,
      });

      const policy = await Policy.create({
        title: effectiveTitle,
        category: category ? String(category).trim() : undefined,
        tags: tagArray,
        kind: "FILE",
        scope: finalScope,
        customerId: finalScope === "ORG" ? finalCustomerId : undefined,
        workspaceId: req.workspaceObjectId,
        visibility: visibility || "ALL",
        fileName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        s3: { bucket: uploaded.bucket, key: uploaded.key },
        uploadedBy: req.user?._id,
        createdBy: req.user?._id,
        updatedBy: req.user?._id,
      });

      res.json(policy);
    } catch (err) {
      next(err);
    }
  },
);

/* -----------------------------------------------------------
   GET /api/hr/policies/:id/open
   Returns a short-lived signed S3 URL the frontend uses for the
   iframe / "Open in new tab" / download. Visibility is re-checked
   against the same filter the list endpoint applies — a user can
   only open a policy they're allowed to see.

   For kind === "URL" we return the stored external link as-is.
   Legacy disk-storage FILE policies (no `s3` sub-doc) return 410
   with code "LEGACY_POLICY" so the UI can show a re-upload prompt.
----------------------------------------------------------- */
router.get(
  "/:id/open",
  requireAuth,
  requireWorkspace,
  async (req: any, res, next) => {
    try {
      const filter = buildPolicyFilter(req.user, req);
      const policy: any = await Policy.findOne({
        _id: req.params.id,
        ...filter,
      }).lean();

      if (!policy) {
        return res.status(404).json({ error: "Policy not found" });
      }

      if (policy.kind === "URL") {
        const externalUrl = String(policy.url || "").trim();
        if (!externalUrl) {
          return res.status(404).json({ error: "Policy has no URL" });
        }
        return res.json({ url: externalUrl });
      }

      const bucket = policy?.s3?.bucket;
      const key = policy?.s3?.key;
      if (!bucket || !key) {
        return res.status(410).json({
          error:
            "This policy file was uploaded under the old storage system. Please re-upload it.",
          code: "LEGACY_POLICY",
        });
      }

      const signedUrl = await presignGetObject({
        bucket,
        key,
        filename: policy.fileName || "policy.pdf",
        expiresInSeconds: env.PRESIGN_TTL || 900,
      });

      return res.json({ url: signedUrl });
    } catch (err) {
      next(err);
    }
  },
);

/* -----------------------------------------------------------
   PUT /api/hr/policies/:id
   Admin/HR: can edit any policy.
   L0: can only edit their own org's policies.
   L1/L2/Employee: 403.
----------------------------------------------------------- */
router.put("/:id", requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    const mgmt = canManage(req.user);
    if (!mgmt) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const policy = await scopedFindById(Policy, req.params.id, req.workspaceObjectId);
    if (!policy) {
      return res.status(404).json({ error: "Policy not found" });
    }

    // L0 can only edit their own org's policies
    if (mgmt === "L0") {
      const custId = resolveUserCustomerId(req.user);
      if (
        !custId ||
        policy.scope !== "ORG" ||
        policy.customerId !== custId
      ) {
        return res
          .status(403)
          .json({ error: "You can only edit your own organization's policies" });
      }
    }

    const { title, url, category, tags, scope, customerId, visibility } =
      req.body || {};

    if (title !== undefined) policy.title = String(title).trim();
    if (url !== undefined) policy.url = String(url).trim();
    if (category !== undefined) policy.category = String(category).trim() as any;
    if (visibility !== undefined) policy.visibility = visibility;

    if (tags !== undefined) {
      policy.tags = Array.isArray(tags)
        ? tags
        : typeof tags === "string"
          ? tags
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          : [];
    }

    // L0 cannot change scope to GLOBAL or reassign to another org
    if (mgmt === "ADMIN") {
      if (scope !== undefined) policy.scope = scope;
      if (customerId !== undefined) policy.customerId = customerId;
    }

    policy.updatedBy = req.user?._id;
    await policy.save();

    res.json(policy);
  } catch (err) {
    next(err);
  }
});

/* -----------------------------------------------------------
   DELETE /api/hr/policies/:id
   Admin/HR: can delete any policy.
   L0: can only delete their own org's policies.
   L1/L2/Employee: 403.
----------------------------------------------------------- */
router.delete("/:id", requireAuth, requireWorkspace, async (req: any, res, next) => {
  try {
    const mgmt = canManage(req.user);
    if (!mgmt) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const { id } = req.params;
    const policy = await scopedFindById(Policy, id, req.workspaceObjectId);

    if (!policy) {
      return res.status(404).json({ error: "Policy not found" });
    }

    // L0 can only delete their own org's policies
    if (mgmt === "L0") {
      const custId = resolveUserCustomerId(req.user);
      if (
        !custId ||
        policy.scope !== "ORG" ||
        policy.customerId !== custId
      ) {
        return res
          .status(403)
          .json({ error: "You can only delete your own organization's policies" });
      }
    }

    const storagePath =
      (policy as any).storagePath || (policy as any).url || null;

    if (
      storagePath &&
      typeof storagePath === "string" &&
      storagePath.startsWith("/uploads/policies/")
    ) {
      const fullPath = path.join(
        process.cwd(),
        storagePath.replace(/^\/+/, ""),
      );
      fs.unlink(fullPath, () => {
        // Ignore unlink errors
      });
    }

    await policy.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
