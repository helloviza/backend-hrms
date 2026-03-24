import express from "express";
import { requireAuth } from "../middleware/auth.js";
import SBTConfig from "../models/SBTConfig.js";

const router = express.Router();

router.use(requireAuth);

// GET /api/sbt/config/wallet — public (any authenticated SBT user)
router.get("/wallet", async (_req: any, res: any) => {
  try {
    const doc = await SBTConfig.findOne({ key: "global" }).lean();
    res.json({ tboWalletEnabled: doc?.tboWalletEnabled ?? false });
  } catch (err: any) {
    console.error("[SBT Config Wallet]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
