import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import { getAgencyBalance } from "../services/tbo.auth.service.js";

const router = express.Router();

router.use(requireAuth, requireWorkspace);

async function requireSBT(req: any, res: any, next: any) {
  try {
    const roles = (req.user?.roles || []).map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""));
    if (roles.includes("SUPERADMIN") || roles.includes("ADMIN") || roles.includes("HR") ||
        roles.includes("WORKSPACELEADER") || req.user?.customerMemberRole === "WORKSPACE_LEADER") {
      return next();
    }
    const userId = req.user?.id || req.user?._id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const user = await User.findById(userId).select("sbtEnabled").lean();
    if (!user || !(user as any).sbtEnabled) {
      return res.status(403).json({ error: "SBT access not enabled for this account" });
    }
    next();
  } catch {
    return res.status(500).json({ error: "Authorization check failed" });
  }
}

// GET /api/sbt/wallet/check?amount=XXXX
router.get("/check", requireSBT, async (req: any, res: any) => {
  try {
    const amount = parseFloat(req.query.amount as string);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // 1. Check per-workspace official booking config
    const roles = (req.user?.roles || []).map((r: string) => String(r).toUpperCase());
    const isAdminUser = roles.some((r: string) => ["ADMIN", "SUPERADMIN", "HR_ADMIN"].includes(r));

    const workspace = await CustomerWorkspace.findById(req.workspaceObjectId).lean();
    const officialBooking = (workspace as any)?.sbtOfficialBooking ?? {};

    if (!isAdminUser && !officialBooking?.enabled) {
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
