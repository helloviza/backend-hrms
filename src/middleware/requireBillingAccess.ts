import type { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "./isSuperAdmin.js";
import BillingPermission from "../models/BillingPermission.js";

export function requireBillingAccess(page: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Super admin bypasses all billing access checks
    if (isSuperAdmin(req)) return next();

    const userId = (req as any).user?._id;
    if (!userId) {
      return res.status(403).json({ success: false, message: "Access not granted" });
    }

    try {
      const doc = await BillingPermission.findOne({ userId: String(userId) }).lean();

      if (!doc) {
        return res.status(403).json({ success: false, message: "Access not granted" });
      }

      if (!Array.isArray(doc.pages) || !doc.pages.includes(page as any)) {
        return res.status(403).json({ success: false, message: "Access not granted" });
      }

      return next();
    } catch (err) {
      return res.status(500).json({ success: false, message: "Internal error checking billing access" });
    }
  };
}
