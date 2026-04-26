import express from "express";
import { UserPermission } from "../models/UserPermission.js";
import logger from "./logger.js";

type AnyObj = Record<string, any>;

export function requireCRMAccess(module: string): express.RequestHandler {
  return async function (req, res, next): Promise<void> {
    try {
      const user = (req as any).user as AnyObj | undefined;
      if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const roles = ((user.roles || []) as string[]).map((r) => r.toUpperCase());
      const isAdminOrSuper = roles.includes("ADMIN") || roles.includes("SUPERADMIN");

      if (isAdminOrSuper) {
        (req as any).crmAccess = "FULL";
        (req as any).crmScope = "ALL";
        next();
        return;
      }

      const perm = (await UserPermission.findOne({
        $or: [{ userId: user.sub }, { userId: user.id }],
      })
        .select("modules")
        .lean()) as any;

      const mod = (perm?.modules as any)?.[module];
      if (!mod || mod.access === "NONE") {
        res.status(403).json({ error: "No CRM access" });
        return;
      }

      (req as any).crmAccess = mod.access;
      (req as any).crmScope = mod.scope;
      next();
    } catch (err) {
      logger.error("requireCRMAccess error", { err, module });
      res.status(500).json({ error: "Permission check failed" });
    }
  };
}
