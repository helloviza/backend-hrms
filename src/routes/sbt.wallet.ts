import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { getAgencyBalance } from "../services/tbo.auth.service.js";

const router = express.Router();

router.use(requireAuth, requireWorkspace);

// GET /api/sbt/wallet/check?amount=XXXX
router.get("/check", async (req: any, res: any) => {
  try {
    const amount = parseFloat(req.query.amount as string);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // 1. Check per-workspace official booking config
    const workspace = await CustomerWorkspace.findById(req.workspaceObjectId).lean();
    const officialBooking = (workspace as any)?.sbtOfficialBooking;

    if (!officialBooking?.enabled) {
      return res.json({ sufficient: false, reason: "wallet_disabled" });
    }

    // 2. Monthly limit check — auto-reset on new month
    const monthKey = new Date().toISOString().slice(0, 7); // "2026-03"
    let currentMonthSpend = officialBooking.currentMonthSpend ?? 0;

    if (officialBooking.lastResetMonth !== monthKey) {
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

    const monthlyLimit: number = officialBooking.monthlyLimit ?? 0;

    if (monthlyLimit > 0 && currentMonthSpend + amount > monthlyLimit) {
      return res.json({
        sufficient: false,
        reason: "limit_exceeded",
        bookingAmount: amount,
        currentSpend: currentMonthSpend,
        limit: monthlyLimit,
        remaining: monthlyLimit - currentMonthSpend,
      });
    }

    // 3. TBO agency balance check
    const balanceRes = (await getAgencyBalance()) as any;
    const cashBalance: number = balanceRes?.CashBalance ?? 0;

    if (cashBalance < amount) {
      return res.json({
        sufficient: false,
        reason: "low_balance",
        bookingAmount: amount,
      });
    }

    return res.json({ sufficient: true, bookingAmount: amount });
  } catch (err: any) {
    console.error("[SBT Wallet Check]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
