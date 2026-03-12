// apps/backend/src/routes/customers.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import Customer from "../models/Customer.js";

const router = Router();

router.get("/", requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const docs = await Customer.find({})
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    res.json({
      items: docs.map((c: any) => ({
        id: String(c._id),
        name: c.name,
        email: c.email,
        type: "Business",
        status: c.status || "ACTIVE",
        isActive: c.status !== "INACTIVE",
        customerCode: c.customerCode,
        onboardingId: c.onboardingId,
        updatedAt: c.updatedAt,
        submittedAt: c.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
