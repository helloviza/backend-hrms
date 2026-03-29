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

    return res.json({
      tboWalletEnabled: ob?.enabled ?? false,
      monthlyLimit: ob?.monthlyLimit ?? 100000,
      currentMonthSpend: ob?.currentMonthSpend ?? 0,
    });
  } catch (err: any) {
    console.error("[SBT Config Wallet]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
