import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import DocumentModel from "../models/Document.js";

const router = Router();

/* ── Helpers ─────────────────────────────────────────────────────── */

function isHrAdmin(user: any): boolean {
  if (!user) return false;
  const roles: string[] = [
    ...(Array.isArray(user.roles) ? user.roles : []),
    ...(user.role ? [user.role] : []),
    ...(user.hrmsAccessRole ? [user.hrmsAccessRole] : []),
  ].map((r) => String(r || "").toUpperCase());
  return (
    roles.includes("ADMIN") ||
    roles.includes("SUPERADMIN") ||
    roles.includes("HR") ||
    roles.includes("HR_ADMIN")
  );
}

function getUserId(req: any): string {
  const u = req.user;
  return String(u?._id ?? u?.id ?? u?.sub ?? "");
}

const ALLOWED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

function sanitizeFileName(name: string): string {
  return String(name || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "");
}

/* ── GET /:userId — list documents for an employee ─────────────── */
router.get(
  "/:userId",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const currentUserId = getUserId(req);
      const admin = isHrAdmin((req as any).user) || isSuperAdmin(req);
      const isSelf = currentUserId === userId;

      if (!isSelf && !admin) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const filter: any = {
        userId: new mongoose.Types.ObjectId(userId),
        workspaceId: req.workspaceObjectId,
      };

      // Non-admin can't see confidential documents
      if (!admin) {
        filter.isConfidential = { $ne: true };
      }

      const { category } = req.query as { category?: string };
      if (category && category !== "ALL") filter.category = category;

      const docs = await DocumentModel.find(filter)
        .sort({ category: 1, createdAt: -1 })
        .lean();

      res.json(docs);
    } catch (err) {
      console.error("[documents] GET /:userId error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ── POST /upload-url — generate presigned S3 upload URL ────────── */
router.post(
  "/upload-url",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      const { userId, category, name, contentType, fileSize, isConfidential, description } = req.body as any;

      if (!userId || !name || !contentType) {
        res.status(400).json({ error: "userId, name, and contentType are required" });
        return;
      }

      if (!ALLOWED_TYPES.includes(contentType)) {
        res.status(400).json({ error: "File type not allowed. Use PDF, PNG, JPG, or DOCX." });
        return;
      }

      const bytes = Number(fileSize) || 0;
      if (bytes > MAX_FILE_SIZE) {
        res.status(413).json({ error: "File too large. Max 20 MB." });
        return;
      }

      const currentUserId = getUserId(req);
      const admin = isHrAdmin((req as any).user) || isSuperAdmin(req);
      const isSelf = currentUserId === userId;
      if (!isSelf && !admin) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const wsId = String(req.workspaceObjectId);
      const safeName = sanitizeFileName(name);
      const key = `${wsId}/${userId}/docs/${category || "OTHER"}/${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${safeName}`;

      // Pre-create document record
      const doc = await DocumentModel.create({
        workspaceId: req.workspaceObjectId,
        userId: new mongoose.Types.ObjectId(userId),
        uploadedBy: new mongoose.Types.ObjectId(currentUserId),
        category: category || "OTHER",
        name: String(name).trim(),
        description: description ? String(description).trim() : undefined,
        key,
        contentType,
        fileSize: bytes || undefined,
        isConfidential: Boolean(isConfidential),
        verificationStatus: "PENDING",
      });

      const cmd = new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        ContentType: contentType,
        Metadata: { workspaceId: wsId, userId, documentId: String(doc._id) },
      });

      const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: env.PRESIGN_TTL || 300 });

      res.status(201).json({ uploadUrl, key, documentId: String(doc._id) });
    } catch (err) {
      console.error("[documents] POST /upload-url error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ── PUT /:documentId/confirm — confirm upload completed ────────── */
router.put(
  "/:documentId/confirm",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      const doc = await DocumentModel.findOne({
        _id: req.params.documentId,
        workspaceId: req.workspaceObjectId,
      });

      if (!doc) {
        res.status(404).json({ error: "Document not found" });
        return;
      }

      // Already confirmed — just return success
      res.json({ success: true, documentId: doc._id });
    } catch (err) {
      console.error("[documents] PUT /:documentId/confirm error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ── GET /:documentId/url — generate download URL ───────────────── */
router.get(
  "/:documentId/url",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      const doc = await DocumentModel.findOne({
        _id: req.params.documentId,
        workspaceId: req.workspaceObjectId,
      });

      if (!doc) {
        res.status(404).json({ error: "Document not found" });
        return;
      }

      const currentUserId = getUserId(req);
      const admin = isHrAdmin((req as any).user) || isSuperAdmin(req);
      const isSelf = String(doc.userId) === currentUserId;

      if (!isSelf && !admin) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      if (doc.isConfidential && !admin) {
        res.status(403).json({ error: "This document is confidential" });
        return;
      }

      const cmd = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: doc.key });
      const url = await getSignedUrl(s3, cmd, { expiresIn: 300 });

      res.json({ url });
    } catch (err) {
      console.error("[documents] GET /:documentId/url error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ── DELETE /:documentId ─────────────────────────────────────────── */
router.delete(
  "/:documentId",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      const doc = await DocumentModel.findOne({
        _id: req.params.documentId,
        workspaceId: req.workspaceObjectId,
      });

      if (!doc) {
        res.status(404).json({ error: "Document not found" });
        return;
      }

      const currentUserId = getUserId(req);
      const admin = isHrAdmin((req as any).user) || isSuperAdmin(req);
      const isSelf = String(doc.userId) === currentUserId;

      if (!isSelf && !admin) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      await DocumentModel.deleteOne({ _id: doc._id });
      res.json({ success: true });
    } catch (err) {
      console.error("[documents] DELETE /:documentId error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/* ── PUT /:documentId/verify — HR verifies a document ───────────── */
router.put(
  "/:documentId/verify",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      const admin = isHrAdmin((req as any).user) || isSuperAdmin(req);
      if (!admin) {
        res.status(403).json({ error: "Only HR/Admin can verify documents" });
        return;
      }

      const { status } = req.body as { status?: string };
      if (!status || !["VERIFIED", "REJECTED"].includes(status)) {
        res.status(400).json({ error: "status must be VERIFIED or REJECTED" });
        return;
      }

      const doc = await DocumentModel.findOne({
        _id: req.params.documentId,
        workspaceId: req.workspaceObjectId,
      });

      if (!doc) {
        res.status(404).json({ error: "Document not found" });
        return;
      }

      doc.verificationStatus = status as any;
      doc.verifiedBy = new mongoose.Types.ObjectId(getUserId(req));
      doc.verifiedAt = new Date();
      await doc.save();

      res.json(doc);
    } catch (err) {
      console.error("[documents] PUT /:documentId/verify error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
