import type { Request, Response, NextFunction } from "express";
import CustomerWorkspace, { type CustomerWorkspaceDocument } from "../models/CustomerWorkspace.js";
import { isSuperAdmin } from "./isSuperAdmin.js";

type WorkspaceFeatures = NonNullable<CustomerWorkspaceDocument["config"]>["features"];

/**
 * requireFeature — factory that returns middleware checking whether a
 * specific feature flag is enabled for the current workspace.
 *
 * SUPERADMIN bypass: skips feature flag check entirely.
 *
 * Caches the workspace lookup on `req.workspace` so downstream
 * handlers don't re-fetch.
 */
export const requireFeature = (featureKey: keyof WorkspaceFeatures) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // ── SUPERADMIN bypass ──
    if (isSuperAdmin(req)) return next();

    // ── TBO certification bypass ──
    const userEmail = ((req as any).user?.email || "").toLowerCase();
    if (userEmail === "tbocertification@plumtrips.com") return next();

    try {
      // Workspace already resolved by requireWorkspace middleware
      const workspace = (req as any).workspace as CustomerWorkspaceDocument | null;

      if (!workspace || workspace.status !== "ACTIVE") {
        res.status(403).json({ success: false, error: "Workspace not active" });
        return;
      }

      if (!workspace.config?.features?.[featureKey]) {
        res.status(403).json({
          success: false,
          error: `Feature '${featureKey}' not enabled for this workspace`,
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
