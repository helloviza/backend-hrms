// apps/backend/src/routes/admin.walletBilling.ts
//
// A company's SBT wallet billing mode and SBT invoicing settings
// (docs/specs/sbt-to-manual-booking-spec.md §3.6 / §3.7, P4; D-6, D-7, D-10).
// Mounted at /api/admin/business-wallets BEFORE routes/admin.businessWallets.ts,
// whose router is SuperAdmin-only: these routes are for anyone holding the
// Access Console key walletBillingMode at FULL (HOUSE staff only; SuperAdmin
// always passes — services/sbtWalletMode.ts). Routes not matched here fall
// through to the SuperAdmin router unchanged.
//
//   GET /:workspaceId/billing       mode, saved limit, invoicing settings, canManage
//   PUT /:workspaceId/billing-mode  { mode: POSTPAID|PREPAID, reason, force?, clientKey? }
//   PUT /:workspaceId/sbt-billing   { allowPersonalInvoiceToCompany: boolean }
import express from "express";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { requireAuth } from "../middleware/auth.js";
import {
  billingModeOf,
  canManageWalletBilling,
  changeBillingMode,
  requireWalletBillingAccess,
  sbtBillingOf,
  setSbtBilling,
} from "../services/sbtWalletMode.js";
import { walletState } from "../services/sbtWallet.js";

const router = express.Router();
const actorOf = (req: any) => String(req.user?._id ?? req.user?.id ?? req.user?.sub ?? "");
const ID = /^[a-f0-9]{24}$/i;

router.get("/:workspaceId/billing", requireAuth, requireWalletBillingAccess, async (req: any, res: any) => {
  try {
    const id = String(req.params.workspaceId || "");
    if (!ID.test(id)) return res.status(404).json({ error: "Unknown company" });
    const ws = (await CustomerWorkspace.findById(id).select("sbtOfficialBooking sbtBilling").lean()) as any;
    if (!ws) return res.status(404).json({ error: "Unknown company" });
    const s = walletState(ws);
    res.json({
      ok: true,
      billingMode: billingModeOf(ws),
      creditLimit: s.creditLimit,
      used: s.used,
      advance: s.advance,
      prepaidSavedLimit: ws.sbtOfficialBooking?.prepaidSavedLimit ?? null,
      sbtBilling: sbtBillingOf(ws),
      canManage: await canManageWalletBilling(req),
    });
  } catch (err: any) {
    console.error("[Wallet billing GET]", err.message);
    res.status(500).json({ error: "Could not load the billing settings" });
  }
});

router.put("/:workspaceId/billing-mode", requireAuth, requireWalletBillingAccess, async (req: any, res: any) => {
  try {
    const r = await changeBillingMode(req.params.workspaceId, req.body || {}, actorOf(req));
    if ("error" in r) return res.status(r.status).json({ ok: false, error: r.error, code: r.code, ...(r.owed != null ? { owed: r.owed } : {}) });
    console.log(`[Wallet billing] ${String(req.params.workspaceId)} → ${r.billingMode} by ${actorOf(req)}`);
    res.json({ ok: true, entryId: r.entryId, billingMode: r.billingMode, wallet: r.state });
  } catch (err: any) {
    console.error("[Wallet billing mode]", err.message);
    res.status(500).json({ error: "Could not change the billing mode" });
  }
});

router.put("/:workspaceId/sbt-billing", requireAuth, requireWalletBillingAccess, async (req: any, res: any) => {
  try {
    const r = await setSbtBilling(req.params.workspaceId, req.body || {}, actorOf(req));
    if ("error" in r) return res.status(r.status).json({ ok: false, error: r.error, code: r.code });
    res.json({ ok: true, sbtBilling: r.settings });
  } catch (err: any) {
    console.error("[Wallet sbt-billing]", err.message);
    res.status(500).json({ error: "Could not save the setting" });
  }
});

export default router;
