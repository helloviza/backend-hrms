// apps/backend/src/services/sbtWalletMode.ts
//
// SBT Business Wallet billing mode + SBT invoicing settings
// (docs/specs/sbt-to-manual-booking-spec.md §3.6 / §3.7, P4; decisions D-6, D-7, D-10).
//
// Billing mode (CustomerWorkspace.sbtOfficialBooking.billingMode)
//   POSTPAID  (absent = POSTPAID) today's credit line: book up to creditLimit,
//             Finance invoices in the normal cycle.
//   PREPAID   the company spends only what it paid in. The credit limit is HELD
//             AT 0, so reserveOfficial's `used + amount ≤ creditLimit` passes
//             only while `used` is negative (an advance — recordPayment pushes
//             it there). No new balance field, no change to the reserve maths.
//             The limit in force at the switch waits in prepaidSavedLimit and
//             comes back on the switch to Postpaid.
//   Postpaid → Prepaid while the company owes money (used > 0) is refused
//   unless forced with a reason (D-6): the debt would otherwise block every
//   booking with no explanation.
//   Every switch is one SBTWalletLedger MODE_CHANGE row (type NONE: moves
//   nothing): before → after, limit before → after, reason, actor, forced,
//   idempotency key — shown on both statements.
//
// Who (D-7, D-10): the Access Console key walletBillingMode at FULL, HOUSE
// staff only (a tenant admin never passes, even with the key stored);
// SuperAdmin always passes. Same key for the company's SBT invoicing setting
// "allow personal bookings invoiced to company".
//
// Snapshot: SBTPayment.walletMode is written at checkout from billingModeOf()
// (services/sbtFulfil.ts, services/sbtPaymentGate.ts); a later switch never
// moves an existing booking.
import mongoose from "mongoose";
import type { Request, Response, NextFunction } from "express";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import SBTWalletLedger, { type WalletBillingMode, WALLET_BILLING_MODES } from "../models/SBTWalletLedger.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { isHouseUser } from "../middleware/requirePlatformAdmin.js";
import { holdsCapability } from "./capabilityProbe.js";
import { walletState, walletStateOf, type WalletState } from "./sbtWallet.js";

type AnyObj = Record<string, any>;

export const WALLET_BILLING_KEY = "walletBillingMode";
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v) || 0;
const MAX_TEXT = 500;
const cleanText = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "");
const inr = (n: number) => `₹${round2(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** The company's billing mode; absent = POSTPAID. */
export function billingModeOf(ws: AnyObj | null | undefined): WalletBillingMode {
  return ws?.sbtOfficialBooking?.billingMode === "PREPAID" ? "PREPAID" : "POSTPAID";
}

export async function billingModeOfWorkspace(workspaceId: unknown): Promise<WalletBillingMode> {
  if (!workspaceId || !mongoose.Types.ObjectId.isValid(String(workspaceId))) return "POSTPAID";
  const ws = await CustomerWorkspace.findById(String(workspaceId)).select("sbtOfficialBooking.billingMode").lean();
  return billingModeOf(ws as AnyObj | null);
}

/* ── who ─────────────────────────────────────────────────────────── */

export async function canManageWalletBilling(req: unknown): Promise<boolean> {
  if (isSuperAdmin(req as any)) return true;
  const user = (req as any)?.user;
  if (!user || user._demoImpersonation || !isHouseUser(user)) return false;
  return holdsCapability(req, WALLET_BILLING_KEY, "FULL");
}

export async function requireWalletBillingAccess(req: Request, res: Response, next: NextFunction) {
  try {
    if (await canManageWalletBilling(req)) return next();
    return res.status(403).json({
      error: "Changing a company's wallet billing needs the Wallet billing mode grant (Access Console, Full).",
      code: "WALLET_BILLING_ACCESS_REQUIRED",
      module: WALLET_BILLING_KEY,
      required: "FULL",
    });
  } catch (err) {
    return next(err);
  }
}

/* ── switch ──────────────────────────────────────────────────────── */

export type ModeResult =
  | { ok: true; entryId: string; billingMode: WalletBillingMode; state: WalletState }
  | { ok: false; status: number; error: string; code: string; owed?: number };
const fail = (status: number, code: string, error: string, extra: AnyObj = {}): ModeResult => ({ ok: false, status, code, error, ...extra });

export async function changeBillingMode(
  workspaceId: unknown,
  input: { mode: unknown; reason: unknown; force?: unknown; clientKey?: unknown; internalNote?: unknown },
  actorUserId: string,
): Promise<ModeResult> {
  if (!mongoose.Types.ObjectId.isValid(String(workspaceId))) return fail(404, "UNKNOWN_COMPANY", "Unknown company");
  const ws = (await CustomerWorkspace.findById(String(workspaceId)).select("sbtOfficialBooking").lean()) as AnyObj | null;
  if (!ws) return fail(404, "UNKNOWN_COMPANY", "Unknown company");
  const to = String(input.mode || "").toUpperCase() as WalletBillingMode;
  if (!WALLET_BILLING_MODES.includes(to)) return fail(400, "BAD_MODE", "Choose Postpaid or Prepaid");
  const reason = cleanText(input.reason);
  if (!reason) return fail(400, "REASON_REQUIRED", "A reason is required");
  const from = billingModeOf(ws);
  if (from === to) return fail(400, "SAME_MODE", `This company is already ${to === "PREPAID" ? "Prepaid" : "Postpaid"}`);
  const s = walletState(ws);
  const force = input.force === true;

  let update: AnyObj;
  let limitAfter: number;
  if (to === "PREPAID") {
    if (s.used > 0 && !force) {
      return fail(409, "BALANCE_OWED",
        `The company owes ${inr(s.used)}. Prepaid holds its credit at ₹0, so every booking would be refused until that is paid. Record the payment first, or switch anyway with a reason.`,
        { owed: s.used });
    }
    limitAfter = 0;
    update = {
      $set: {
        "sbtOfficialBooking.billingMode": "PREPAID",
        "sbtOfficialBooking.prepaidSavedLimit": s.creditLimit,
        "sbtOfficialBooking.creditLimit": 0,
      },
    };
  } else {
    limitAfter = round2(num(ws.sbtOfficialBooking?.prepaidSavedLimit));
    update = {
      $set: { "sbtOfficialBooking.billingMode": "POSTPAID", "sbtOfficialBooking.creditLimit": limitAfter },
      $unset: { "sbtOfficialBooking.prepaidSavedLimit": "" },
    };
  }

  // Conditional on the mode we read: two staff switching at once can't both
  // win, and a double submit finds the mode already changed.
  const modeFilter = from === "PREPAID"
    ? { "sbtOfficialBooking.billingMode": "PREPAID" }
    : { "sbtOfficialBooking.billingMode": { $in: [null, "POSTPAID"] } };
  const r = await CustomerWorkspace.updateOne({ _id: ws._id, ...modeFilter }, update, { runValidators: false });
  if (r.modifiedCount !== 1) return fail(409, "MODE_CHANGED", "Someone else changed this company's billing just now — reload and try again");

  const entry = await SBTWalletLedger.create({
    workspaceId: String(ws._id), type: "NONE", entryType: "MODE_CHANGE", amount: 0,
    monthKey: new Date().toISOString().slice(0, 7), usedAfter: s.used,
    reason: "MODE_CHANGE", remark: reason, internalNote: cleanText(input.internalNote),
    modeBefore: from, modeAfter: to, limitBefore: s.creditLimit, limitAfter,
    ...(to === "PREPAID" && s.used > 0 ? { forced: true } : {}),
    actorUserId, idempotencyKey: `mode:${cleanText(input.clientKey) || new mongoose.Types.ObjectId()}`,
  });
  return { ok: true, entryId: String(entry._id), billingMode: to, state: await walletStateOf(ws._id) };
}

/* ── SBT invoicing settings (D-10) ───────────────────────────────── */

export function sbtBillingOf(ws: AnyObj | null | undefined) {
  return { allowPersonalInvoiceToCompany: ws?.sbtBilling?.allowPersonalInvoiceToCompany === true };
}

export async function setSbtBilling(
  workspaceId: unknown,
  input: { allowPersonalInvoiceToCompany: unknown },
  actorUserId: string,
): Promise<{ ok: true; settings: ReturnType<typeof sbtBillingOf> } | { ok: false; status: number; error: string; code: string }> {
  if (!mongoose.Types.ObjectId.isValid(String(workspaceId))) return { ok: false, status: 404, code: "UNKNOWN_COMPANY", error: "Unknown company" };
  if (typeof input.allowPersonalInvoiceToCompany !== "boolean") {
    return { ok: false, status: 400, code: "BAD_SETTING", error: "allowPersonalInvoiceToCompany (true/false) is required" };
  }
  const ws = (await CustomerWorkspace.findOneAndUpdate(
    { _id: String(workspaceId) },
    { $set: {
      "sbtBilling.allowPersonalInvoiceToCompany": input.allowPersonalInvoiceToCompany,
      "sbtBilling.updatedBy": actorUserId,
      "sbtBilling.updatedAt": new Date(),
    } },
    { new: true, runValidators: false },
  ).select("sbtBilling").lean()) as AnyObj | null;
  if (!ws) return { ok: false, status: 404, code: "UNKNOWN_COMPANY", error: "Unknown company" };
  console.log(`[SBT billing] allowPersonalInvoiceToCompany=${input.allowPersonalInvoiceToCompany} on ${String(workspaceId)} by ${actorUserId}`);
  return { ok: true, settings: sbtBillingOf(ws) };
}
