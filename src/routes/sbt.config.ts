import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import { walletState } from "../services/sbtWallet.js";

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

// GET /api/sbt/config/wallet — the company's Business Wallet (a credit line:
// services/sbtWallet.ts). monthlyLimit / currentMonthSpend / remaining are the
// same numbers under their old names, for screens not yet updated.
router.get("/wallet", requireSBT, async (req: any, res: any) => {
  try {
    const roles = (req.user?.roles || []).map((r: string) => String(r).toUpperCase());
    const isAdminUser = roles.some((r: string) => ["ADMIN", "SUPERADMIN", "HR_ADMIN"].includes(r));

    const workspace = await CustomerWorkspace.findById(req.workspaceObjectId)
      .select("sbtOfficialBooking")
      .lean();
    const s = walletState(workspace as any);

    return res.json({
      tboWalletEnabled: isAdminUser || s.enabled,
      creditLimit: s.creditLimit,
      used: s.used,
      available: s.available,
      monthlyLimit: s.creditLimit,
      currentMonthSpend: s.used,
      remaining: Math.max(0, s.available),
    });
  } catch (err: any) {
    console.error("[SBT Config Wallet]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
