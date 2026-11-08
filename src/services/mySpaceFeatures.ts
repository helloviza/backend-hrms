// apps/backend/src/services/mySpaceFeatures.ts
//
// "Would the real route serve this caller?" — as a boolean, for the My Space
// aggregate endpoints, which must not surface data from a feature the
// caller's workspace doesn't have.
//
// featureOn mirrors middleware/requireFeature.ts branch-for-branch
// (SUPERADMIN bypass → TBO cert bypass → HOUSE workspace bypass → workspace
// ACTIVE + flag). plumboxOnly mirrors the server.ts mounts that exist only
// when DEPLOYMENT_MODE === "plumbox" (SBT, approvals, proposals).
import type { Request } from "express";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { env } from "../config/env.js";

export const PLUMTRIPS_HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";

export function featureOn(req: Request, ws: any, key: string): boolean {
  if (isSuperAdmin(req)) return true;
  const email = String((req as any).user?.email || "").toLowerCase();
  if (email === "tbocertification@plumtrips.com") return true;
  if (String(ws?._id || "") === PLUMTRIPS_HOUSE_WORKSPACE_ID) return true;
  if (!ws || ws.status !== "ACTIVE") return false;
  return ws.config?.features?.[key] === true;
}

export function plumboxMounted(): boolean {
  return env.DEPLOYMENT_MODE === "plumbox";
}
