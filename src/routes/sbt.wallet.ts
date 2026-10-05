import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import { WALLET_ENTRY_TYPES, type WalletEntryType } from "../models/SBTWalletLedger.js";
import { getAgencyBalance } from "../services/tbo.auth.service.js";
import { sbtBookerGuards } from "../services/sbtPaymentGate.js";
import { walletState, statement, statementCsv, statementXlsx } from "../services/sbtWallet.js";
import { dateRangeOr400 } from "../utils/dateRange.js";

// The company's SBT Business Wallet — a credit line (services/sbtWallet.ts).
//   GET /check?amount=     can this booking be paid from the wallet?
//   GET /summary           credit limit · used · available
//   GET /statement         the ledger as a statement (?from&to, ?types, ?q,
//                          ?format=csv|xlsx). Workspace Leaders (and Plumtrips
//                          admins) see the whole company; everyone else only
//                          their own bookings' entries. Selling amounts only —
//                          never our net, margin or commission.
const router = express.Router();

router.use(requireAuth, requireWorkspace);

async function requireSBT(req: any, res: any, next: any) {
  try {
    const roles = (req.user?.roles || []).map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""));
    if (roles.includes("SUPERADMIN") || roles.includes("ADMIN") || roles.includes("HR") ||
        roles.includes("WORKSPACELEADER") || req.user?.customerMemberRole === "WORKSPACE_LEADER") {
      return next();
    }
    const userId = req.user?.id || req.user?._id || req.user?.sub;
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

/** Sees the whole company's statement: a Workspace Leader, or a Plumtrips admin on their own workspace. */
function seesWholeCompany(req: any): boolean {
  const roles = (req.user?.roles || []).map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""));
  return roles.includes("WORKSPACELEADER") || req.user?.customerMemberRole === "WORKSPACE_LEADER" ||
    roles.includes("SUPERADMIN") || roles.includes("ADMIN") || roles.includes("HRADMIN");
}

// GET /api/sbt/wallet/check?amount=XXXX
// Read-only availability check; the reservation itself happens at checkout
// (services/sbtPaymentGate.ts reserveOfficial, conditional on available).
router.get("/check", requireSBT, ...sbtBookerGuards, async (req: any, res: any) => {
  try {
    const amount = parseFloat(req.query.amount as string);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const roles = (req.user?.roles || []).map((r: string) => String(r).toUpperCase());
    const isAdminUser = roles.some((r: string) => ["ADMIN", "SUPERADMIN", "HR_ADMIN"].includes(r));
    const workspace = await CustomerWorkspace.findById(req.workspaceObjectId).select("sbtOfficialBooking").lean();
    const s = walletState(workspace as any);

    if (!isAdminUser && !s.enabled) {
      return res.json({ sufficient: false, reason: "wallet_disabled" });
    }

    if (amount > s.available) {
      return res.json({
        sufficient: false,
        reason: "limit_exceeded",
        bookingAmount: amount,
        creditLimit: s.creditLimit,
        used: s.used,
        available: Math.max(0, s.available),
        // Old names, same numbers.
        currentSpend: s.used,
        limit: s.creditLimit,
        remaining: Math.max(0, s.available),
      });
    }

    // Demo users never reach TBO.
    if (req.user?.isDemoUser === true) return res.json({ sufficient: true, bookingAmount: amount, isDemo: true });

    // TBO agency balance — Plumtrips' own deposit with the supplier.
    const balanceRes = (await getAgencyBalance()) as any;
    const cashBalance: number = balanceRes?.CashBalance ?? 0;
    if (cashBalance < amount) {
      return res.json({ sufficient: false, reason: "low_balance", bookingAmount: amount });
    }

    return res.json({ sufficient: true, bookingAmount: amount });
  } catch (err: any) {
    console.error("[SBT Wallet Check]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/wallet/summary
router.get("/summary", requireSBT, async (req: any, res: any) => {
  try {
    const ws = (await CustomerWorkspace.findById(req.workspaceObjectId).select("sbtOfficialBooking companyName").lean()) as any;
    const s = walletState(ws);
    res.json({
      ok: true,
      companyName: ws?.companyName || "",
      enabled: s.enabled,
      creditLimit: s.creditLimit,
      used: s.used,
      available: s.available,
      usagePct: s.usagePct,
      lastPaymentAt: s.lastPaymentAt,
      wholeCompany: seesWholeCompany(req),
    });
  } catch (err: any) {
    console.error("[SBT Wallet Summary]", err.message);
    res.status(500).json({ error: "Could not load the wallet" });
  }
});

export function parseTypes(v: unknown): WalletEntryType[] {
  return String(v || "")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t): t is WalletEntryType => (WALLET_ENTRY_TYPES as string[]).includes(t));
}

// GET /api/sbt/wallet/statement
router.get("/statement", requireSBT, async (req: any, res: any) => {
  try {
    const range = dateRangeOr400(req, res);
    if (range === false) return;
    const whole = seesWholeCompany(req);
    const rows = await statement(req.workspaceObjectId, {
      from: range?.from,
      to: range?.to,
      types: parseTypes(req.query.types),
      q: String(req.query.q || ""),
      ownerUserId: whole ? null : String(req.user?.sub || req.user?._id || req.user?.id || "") || "none",
      staff: false,
    });
    const format = String(req.query.format || "");
    if (format === "csv" || format === "xlsx") {
      const ws = (await CustomerWorkspace.findById(req.workspaceObjectId).select("companyName").lean()) as any;
      const base = `business-wallet-${new Date().toISOString().slice(0, 10)}`;
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
        return res.send(statementCsv(rows));
      }
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.xlsx"`);
      return res.send(await statementXlsx(rows, `Business Wallet statement — ${ws?.companyName || ""}`));
    }
    res.json({ ok: true, wholeCompany: whole, rows });
  } catch (err: any) {
    console.error("[SBT Wallet Statement]", err.message);
    res.status(500).json({ error: "Could not load the statement" });
  }
});

export default router;
