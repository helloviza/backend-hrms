import type { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "./isSuperAdmin.js";

// HOUSE (Plumtrips internal) workspace _id. The repo convention is a per-file
// literal — there is no shared exported constant — so this mirrors the value
// already used in requireFeature.ts:7 and requireWorkspace.ts. NEVER write to it.
const PLUMTRIPS_HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";

/**
 * requireHouse — restricts a route to the Plumtrips HOUSE workspace.
 *
 * CRM (leads, contacts, companies) is a HOUSE-only product. Tenant CRM, if it
 * is ever built, will be a separate isolated track. This middleware MUST run
 * after `requireWorkspace`, which resolves and attaches `req.workspaceId`
 * (string _id). We compare it to the HOUSE id, coercing both sides to string
 * to avoid an ObjectId-vs-string mismatch.
 *
 * SUPERADMIN bypass: Plumtrips ops staff may not carry a resolved workspaceId
 * (requireWorkspace skips the DB lookup for them), so we let them through —
 * mirroring requireFeature's SUPERADMIN bypass.
 */
export const requireHouse = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // ── SUPERADMIN bypass ──
  if (isSuperAdmin(req)) {
    next();
    return;
  }

  const wsId = String(
    (req as any).workspaceId ||
    (req as any).workspace?._id ||
    "",
  );

  if (wsId !== PLUMTRIPS_HOUSE_WORKSPACE_ID) {
    res.status(403).json({ error: "CRM is restricted to the Plumtrips workspace" });
    return;
  }

  next();
};

export default requireHouse;
