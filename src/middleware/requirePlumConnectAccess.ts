// apps/backend/src/middleware/requirePlumConnectAccess.ts
//
// PlumConnect Slice 4b — the access gate for /api/plumconnect, in the exact
// shape of requireLeadsAccess (routes/leads.ts). Slice 7 makes it LINE-AWARE:
// instead of one `plumconnect` grant it resolves the caller's {access, scope}
// on each of the four lines (services/plumconnect/access.ts — plumtrips /
// helloviza / concierge / support) and stamps the whole map on the request
// as `req.plumconnectLines`. ADMIN / SUPERADMIN are FULL / ALL on every line
// by role. Holding nothing at READ or above on ANY line is a 403 here; a
// route then checks the specific line its conversation belongs to
// (routes/plumconnect.ts loadVisible) — the UI hiding a queue is not the
// control, the per-conversation check is.
//
// Sits behind requireAuth (req.user), requireWorkspace, requireFeature
// ("plumconnectEnabled") and requireHouse at the mount (server.ts), and
// behind the PLUMCONNECT_ENABLED runtime flag in the router itself.

import type express from "express";
import { resolveLineGrants, heldLines } from "../services/plumconnect/access.js";
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

    const grants = await resolveLineGrants(user);
    if (heldLines(grants).length === 0) {
      res.status(403).json({ error: "You do not have access to PlumConnect." });
      return;
    }

    (req as any).plumconnectLines = grants;
    next();
  } catch (err) {
    logger.error("requirePlumConnectAccess error", { err });
    res.status(500).json({ error: "Permission check failed" });
  }
}
