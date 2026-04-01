// apps/backend/src/routes/hrPolicies.ts
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

import Policy from "../models/Policy.js";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { scopedFindById } from "../middleware/scopedFindById.js";

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
  if (isL0(user)) return "L0";
  return false;
}

/* -----------------------------------------------------------
   Policy query filter based on user role
----------------------------------------------------------- */

function buildPolicyFilter(user: any): Record<string, any> {
  // Staff admin sees everything
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
   File upload setup for policy PDFs
----------------------------------------------------------- */

const POLICY_UPLOAD_DIR = path.join(process.cwd(), "uploads", "policies");
fs.mkdirSync(POLICY_UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, POLICY_UPLOAD_DIR);
  },
  filename(_req, file, cb) {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_\s]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15 MB
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
router.get("/", requireAuth, async (req: any, res, next) => {
  try {
    const filter = buildPolicyFilter(req.user);
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
router.get("/list", requireAuth, async (req: any, res, next) => {
  try {
    const filter = buildPolicyFilter(req.user);
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
router.post("/", requireAuth, async (req: any, res, next) => {
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

    let finalScope = scope || "GLOBAL";
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
  upload.single("file"),
  async (req: any, res, next) => {
    try {
      const mgmt = canManage(req.user);
      if (!mgmt) {
        return res.status(403).json({ error: "Not allowed" });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: "File is required" });
      }

      const { title, category, tags, scope, customerId, visibility } =
        req.body || {};
      const effectiveTitle =
        (title && String(title).trim()) || file.originalname;

      const relativePath = `/uploads/policies/${file.filename}`;

      const tagArray: string[] = Array.isArray(tags)
        ? tags
        : typeof tags === "string"
          ? tags
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
          : [];

      let finalScope = scope || "GLOBAL";
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

      const policy = await Policy.create({
        title: effectiveTitle,
        url: relativePath,
        fileUrl: relativePath,
        storagePath: relativePath,
        category: category ? String(category).trim() : undefined,
        tags: tagArray,
        kind: "FILE",
        scope: finalScope,
        customerId: finalScope === "ORG" ? finalCustomerId : undefined,
        visibility: visibility || "ALL",
        fileName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
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
