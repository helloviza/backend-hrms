import type { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "./isSuperAdmin.js";

/**
 * requireSuperAdmin — checks that req.user has SUPERADMIN role.
 * Must be used AFTER requireAuth.
 */
export const requireSuperAdmin = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (isSuperAdmin(req)) return next();
  res.status(403).json({ success: false, error: "SUPERADMIN access required" });
};
