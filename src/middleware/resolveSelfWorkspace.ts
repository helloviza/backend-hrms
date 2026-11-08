// apps/backend/src/middleware/resolveSelfWorkspace.ts
//
// "Which workspace is the caller's OWN?" for the My Space read endpoints.
//
// requireWorkspace lets a SUPERADMIN through with req.workspaceObjectId unset
// when no explicit workspace is supplied (requireWorkspace.ts SUPERADMIN
// bypass). Feeding that unset value into a workspace-wide query widens it to
// every tenant (find({ workspaceId: undefined }) === find({})) — audit H6.
//
// This resolves the caller's HOME workspace instead (same shared resolver
// requireWorkspace uses for normal users, which falls back to User.workspaceId
// from the DB), so every workspace-wide query on My Space is bound to one
// concrete workspace. If nothing resolves, the caller gets 403 — never an
// unscoped query.
//
// Must be mounted AFTER requireAuth + requireWorkspace.
import type { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { resolveWorkspaceForUser } from "./requireWorkspace.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const SELF_WS_SELECT = "_id customerId status config travelMode tenantType companyName";

/**
 * Returns the resolved workspace document for the caller (or null).
 * Side effect: sets req.workspaceId / req.workspaceObjectId / req.workspace
 * when they were unset.
 */
export async function resolveSelfWorkspaceFor(req: Request): Promise<any | null> {
  if (req.workspaceObjectId) {
    if (!req.workspace || !req.workspace.config) {
      const ws = await CustomerWorkspace.findById(req.workspaceObjectId).select(SELF_WS_SELECT).lean();
      if (ws) req.workspace = ws;
    }
    return req.workspace || { _id: req.workspaceObjectId };
  }
  const ws: any = await resolveWorkspaceForUser((req as any).user, SELF_WS_SELECT);
  if (!ws?._id) return null;
  req.workspace = ws;
  req.workspaceId = String(ws._id);
  req.workspaceObjectId = new mongoose.Types.ObjectId(String(ws._id));
  return ws;
}

export async function resolveSelfWorkspace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ws = await resolveSelfWorkspaceFor(req);
    if (!ws) {
      res.status(403).json({ success: false, error: "Workspace context required" });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
