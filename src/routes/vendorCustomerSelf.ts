// apps/backend/src/routes/vendorCustomerSelf.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import Vendor from "../models/Vendor.js";
import Customer from "../models/Customer.js";

const r = Router();

/**
 * Vendor self profile
 * GET /api/vendors/me
 */
r.get("/vendors/me", requireAuth, async (req: any, res, next) => {
  try {
    const userId = req.user?.sub;
    const email = (req.user?.email || "").toLowerCase();

    // Do NOT cache this – always fresh
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    if (!userId && !email) {
      return res.json({ vendor: null });
    }

    const vendor = await Vendor.findOne({
      $or: [{ ownerId: userId }, { email }],
    })
      .lean()
      .exec();

    return res.json({ vendor });
  } catch (err) {
    next(err);
  }
});

/**
 * Customer self profile
 * GET /api/customers/me
 */
r.get("/customers/me", requireAuth, async (req: any, res, next) => {
  try {
    const userId = req.user?.sub;
    const email = (req.user?.email || "").toLowerCase();

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    if (!userId && !email) {
      return res.json({ customer: null });
    }

    const customer = await Customer.findOne({
      $or: [{ ownerId: userId }, { email }],
    })
      .lean()
      .exec();

    return res.json({ customer });
  } catch (err) {
    next(err);
  }
});

export default r;
