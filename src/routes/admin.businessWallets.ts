// apps/backend/src/routes/admin.businessWallets.ts
//
// House "Business Wallets" (SUPERADMIN only, enforced here on every route):
//   GET  /                         every company's credit line (?q, ?format=csv|xlsx)
//   GET  /:workspaceId             one company: balance + full statement with staff
//                                  extras (entered by, internal note); ?from&to, ?types,
//                                  ?q, ?format=csv|xlsx
//   POST /:workspaceId/payments    payment received (amount, date, mode, reference, note)
//   POST /:workspaceId/adjustments credit / debit with a required reason
//   PUT  /:workspaceId/limit       change the credit limit, with a required reason
// Every action is an SBTWalletLedger entry carrying who and when (services/sbtWallet.ts).
import express from "express";
import ExcelJS from "exceljs";
import { requireAuth } from "../middleware/auth.js";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import {
  walletState,
  statement,
  statementCsv,
  statementXlsx,
  recordPayment,
  adjust,
  changeLimit,
  USAGE_ALERT_RATIO,
  type ActionResult,
} from "../services/sbtWallet.js";
import { parseTypes } from "./sbt.wallet.js";
import { dateRangeOr400 } from "../utils/dateRange.js";
import { HOUSE_WORKSPACE_ID } from "../utils/bookingAccess.js";

const router = express.Router();
router.use(requireAuth, requireSuperAdmin);

const actorOf = (req: any) => String(req.user?._id ?? req.user?.id ?? req.user?.sub ?? "");
const nameOf = (w: any) => String(w?.companyName || "").trim() || String(w?.customerId || "") || "Unnamed company";

function companyRow(w: any) {
  const s = walletState(w);
  return {
    workspaceId: String(w._id),
    companyName: nameOf(w),
    isHouse: String(w._id) === HOUSE_WORKSPACE_ID,
    enabled: s.enabled,
    creditLimit: s.creditLimit,
    used: s.used,
    available: s.available,
    usagePct: s.usagePct,
    nearLimit: s.creditLimit > 0 ? s.used >= s.creditLimit * USAGE_ALERT_RATIO : s.used > 0,
    lastPaymentAt: s.lastPaymentAt,
  };
}

// GET /api/admin/business-wallets
router.get("/", async (req: any, res: any) => {
  try {
    const filter: any = {
      status: { $ne: "DELETED" },
      $or: [
        { "sbtOfficialBooking.enabled": true },
        { "sbtOfficialBooking.creditLimit": { $gt: 0 } },
        { "sbtOfficialBooking.used": { $ne: 0, $exists: true } },
      ],
    };
    const q = String(req.query?.q || "").trim().slice(0, 80);
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$and = [{ $or: [{ companyName: rx }, { customerId: rx }] }];
    }
    const rows = ((await CustomerWorkspace.find(filter).select("companyName customerId sbtOfficialBooking").lean()) as any[])
      .map(companyRow)
      .sort((a, b) => b.usagePct - a.usagePct || a.companyName.localeCompare(b.companyName));

    const format = String(req.query.format || "");
    if (format === "csv" || format === "xlsx") {
      const head = ["Company", "Wallet on", "Credit limit (₹)", "Used (₹)", "Available (₹)", "% used", "Last payment"];
      const body = rows.map((r) => [
        r.companyName, r.enabled ? "Yes" : "No", r.creditLimit, r.used, r.available, r.usagePct,
        r.lastPaymentAt ? new Date(r.lastPaymentAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }) : "",
      ]);
      const base = `business-wallets-${new Date().toISOString().slice(0, 10)}`;
      if (format === "csv") {
        const cell = (v: unknown) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
        return res.send("﻿" + [head, ...body].map((l) => l.map(cell).join(",")).join("\r\n"));
      }
      const wb = new ExcelJS.Workbook();
      const sh = wb.addWorksheet("Business Wallets");
      sh.addRow(head).font = { bold: true };
      for (const b of body) sh.addRow(b);
      sh.columns.forEach((c, i) => { c.width = [30, 10, 16, 16, 16, 10, 14][i] || 14; });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.xlsx"`);
      return res.send(Buffer.from(await wb.xlsx.writeBuffer()));
    }
    res.json({ ok: true, companies: rows });
  } catch (err: any) {
    console.error("[Business Wallets list]", err.message);
    res.status(500).json({ error: "Could not load business wallets" });
  }
});

// GET /api/admin/business-wallets/:workspaceId
router.get("/:workspaceId", async (req: any, res: any) => {
  try {
    const range = dateRangeOr400(req, res);
    if (range === false) return;
    const id = String(req.params.workspaceId || "");
    if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(404).json({ error: "Unknown company" });
    const ws = (await CustomerWorkspace.findById(id).select("companyName customerId sbtOfficialBooking").lean()) as any;
    if (!ws) return res.status(404).json({ error: "Unknown company" });
    const rows = await statement(id, {
      from: range?.from, to: range?.to, types: parseTypes(req.query.types), q: String(req.query.q || ""), staff: true,
    });
    const format = String(req.query.format || "");
    if (format === "csv" || format === "xlsx") {
      const base = `business-wallet-${nameOf(ws).replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}`;
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
        return res.send(statementCsv(rows, true));
      }
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.xlsx"`);
      return res.send(await statementXlsx(rows, `Business Wallet statement — ${nameOf(ws)}`, true));
    }
    res.json({ ok: true, company: companyRow(ws), rows });
  } catch (err: any) {
    console.error("[Business Wallet statement]", err.message);
    res.status(500).json({ error: "Could not load the statement" });
  }
});

function send(res: any, r: ActionResult) {
  if ("error" in r) return res.status(r.status).json({ ok: false, error: r.error });
  return res.json({ ok: true, entryId: r.entryId, wallet: r.state });
}

router.post("/:workspaceId/payments", async (req: any, res: any) => {
  try {
    send(res, await recordPayment(req.params.workspaceId, req.body || {}, actorOf(req)));
  } catch (err: any) {
    console.error("[Business Wallet payment]", err.message);
    res.status(500).json({ error: "Could not record the payment" });
  }
});

router.post("/:workspaceId/adjustments", async (req: any, res: any) => {
  try {
    send(res, await adjust(req.params.workspaceId, req.body || {}, actorOf(req)));
  } catch (err: any) {
    console.error("[Business Wallet adjustment]", err.message);
    res.status(500).json({ error: "Could not record the adjustment" });
  }
});

router.put("/:workspaceId/limit", async (req: any, res: any) => {
  try {
    send(res, await changeLimit(req.params.workspaceId, req.body || {}, actorOf(req)));
  } catch (err: any) {
    console.error("[Business Wallet limit]", err.message);
    res.status(500).json({ error: "Could not change the limit" });
  }
});

export default router;
