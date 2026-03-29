import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const router = express.Router();

router.use(requireAuth, requireWorkspace);

// GET /api/sbt/config/wallet — per-workspace official booking config
router.get("/wallet", async (req: any, res: any) => {
  try {
    const workspace = await CustomerWorkspace.findById(req.workspaceObjectId)
      .select("sbtOfficialBooking")
      .lean();

    const ob = (workspace as any)?.sbtOfficialBooking;
    const monthKey = new Date().toISOString().slice(0, 7); // "2026-03"

    let currentMonthSpend = ob?.currentMonthSpend ?? 0;

    // Lazy reset if new month
    if (ob?.lastResetMonth && ob.lastResetMonth !== monthKey) {
      await CustomerWorkspace.findOneAndUpdate(
        { _id: req.workspaceObjectId },
        { $set: {
          'sbtOfficialBooking.currentMonthSpend': 0,
          'sbtOfficialBooking.lastResetMonth': monthKey,
        }},
        { runValidators: false },
      );
      currentMonthSpend = 0;
    }

    const monthlyLimit = ob?.monthlyLimit ?? 100000;

    return res.json({
      tboWalletEnabled: ob?.enabled ?? false,
      monthlyLimit,
      currentMonthSpend,
      remaining: Math.max(0, monthlyLimit - currentMonthSpend),
    });
  } catch (err: any) {
    console.error("[SBT Config Wallet]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
