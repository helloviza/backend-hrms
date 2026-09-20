// apps/backend/src/middleware/requirePlumConnectAccess.ts
//
// PlumConnect Slice 4b — the access gate for /api/plumconnect, in the exact
// shape of requireLeadsAccess (routes/leads.ts): ADMIN / SUPERADMIN are
// FULL / ALL by role; everyone else is whatever their UserPermission row's
// `modules.plumconnect` says, and NONE is a 403. The verb grant and the
// scope are stamped on the request for the route to turn into a Mongo
// filter (services/plumconnect/inboxScope.ts).
//
// Sits behind requireAuth (req.user), requireWorkspace, requireFeature
// ("plumconnectEnabled") and requireHouse at the mount (server.ts), and
// behind the PLUMCONNECT_ENABLED runtime flag in the router itself.

import type express from "express";
import { UserPermission } from "../models/UserPermission.js";
import logger from "../utils/logger.js";

type AnyObj = Record<string, any>;

export async function requirePlumConnectAccess(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  try {
    const user = (req as any).user as AnyObj | undefined;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const roles = ((user.roles || []) as string[]).map((r) => r.toUpperCase());
    if (roles.includes("SUPERADMIN") || roles.includes("ADMIN")) {
      (req as any).plumconnectAccess = "FULL";
      (req as any).plumconnectScope = "ALL";
      next();
      return;
    }

    const perm = (await UserPermission.findOne({
      $or: [{ userId: user.sub }, { userId: user.id }],
    })
      .select("modules")
      .lean()) as any;

    const mod = perm?.modules?.plumconnect;
    const access: string = mod?.access || "NONE";
    const scope: string = mod?.scope || "NONE";

    if (access === "NONE") {
      res.status(403).json({ error: "You do not have access to PlumConnect." });
      return;
    }

    (req as any).plumconnectAccess = access;
    (req as any).plumconnectScope = scope;
    next();
  } catch (err) {
    logger.error("requirePlumConnectAccess error", { err });
    res.status(500).json({ error: "Permission check failed" });
  }
}
