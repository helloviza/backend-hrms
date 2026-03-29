import type { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { isSuperAdmin } from "./isSuperAdmin.js";

/* ── Extend Express Request with workspace fields ───────────────── */
declare global {
  namespace Express {
    interface Request {
      workspaceId: string;
      workspaceObjectId: mongoose.Types.ObjectId;
      workspace?: any; // populated later by requireFeature
    }
  }
}

/**
 * requireWorkspace — extracts workspaceId from the authenticated user
 * and attaches it to `req.workspaceId` (string) and
 * `req.workspaceObjectId` (ObjectId).
 *
 * SUPERADMIN bypass: skips the user-JWT extraction entirely.
 * Instead reads workspaceId from body / query / params / header.
 * If none provided, continues without workspace context.
 *
 * Priority (normal users): workspaceId > customerId > businessId
 * Returns 403 if none found (non-SUPERADMIN only).
 */
export const requireWorkspace = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const user = (req as any).user;
  if (!user) {
    res.status(403).json({ success: false, error: "Workspace context required" });
    return;
  }

  // ── SUPERADMIN bypass ──
  if (isSuperAdmin(req)) {
    // Try to pick up workspaceId from explicit sources
    const explicit =
      (req.body as any)?.workspaceId ||
      (req.query as any)?.workspaceId ||
      req.params?.workspaceId ||
      req.headers["x-workspace-id"] ||
      // Also fall back to JWT fields if present (SUPERADMIN may still have one)
      user.workspaceId ||
      user.customerId ||
      user.businessId ||
      null;

    if (explicit) {
      const id = String(explicit);
      req.workspaceId = id;
      try {
        req.workspaceObjectId = new mongoose.Types.ObjectId(id);
      } catch {
        req.workspaceObjectId = id as any;
      }
    }
    // If no workspaceId at all — that's fine for SUPERADMIN, continue anyway
    return next();
  }

  // ── TBO certification bypass ──
  const userEmail = (user.email || "").toLowerCase();
  if (userEmail === "tbocertification@plumtrips.com") {
    const certWsId = "69679a7628330a58d29f2254";
    req.workspaceId = certWsId;
    req.workspaceObjectId = new mongoose.Types.ObjectId(certWsId);
    return next();
  }

  // ── Normal users ──
  const raw =
    user.workspaceId ?? user.customerId ?? user.businessId ?? null;

  if (!raw) {
    res.status(403).json({ success: false, error: "Workspace context required" });
    return;
  }

  const id = String(raw);
  req.workspaceId = id;

  try {
    req.workspaceObjectId = new mongoose.Types.ObjectId(id);
  } catch {
    req.workspaceObjectId = id as any;
  }

  next();
};
