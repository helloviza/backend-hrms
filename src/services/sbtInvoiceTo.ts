// apps/backend/src/services/sbtInvoiceTo.ts
//
// "Invoice to" at SBT checkout (docs/specs/sbt-to-manual-booking-spec.md §3.7,
// P4; decisions D-8, D-10). Behind SBTConfig "global".invoiceToEnabled
// (default OFF): while off nothing here runs and no bill-to is stored, so
// bookings are invoiced to the company exactly as before.
//
//   My company   one of the company's ACTIVE GST registrations (the default
//                one when none is named), or — a company with none — its
//                legal name and state.
//   My name      name, state, address (both required); optional GSTIN —
//                validated, and when given the state is DERIVED from it (the
//                browser's state is ignored).
//
//   Official (wallet) → always My company; "My name" is refused (D-8).
//   Personal (Razorpay) → My name by default; My company only when the
//   company allows it (CustomerWorkspace.sbtBilling.allowPersonalInvoiceToCompany,
//   staff-only, default OFF — D-10). Otherwise 400 INVOICE_TO_NOT_ALLOWED.
//
// The result is the bill-to SNAPSHOT (models/billToSchema.ts) stored on the
// payment row before any money moves; the booking and its linked Manual
// Booking copy it from there. Nothing re-reads the live company later.
//
// No choice sent while the switch is on (an older browser) = no bill-to:
// invoiced to the company as before. Never a reason to refuse a booking.
import mongoose from "mongoose";
import SBTConfig from "../models/SBTConfig.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Customer from "../models/Customer.js";
import User from "../models/User.js";
import type { BillTo } from "../models/billToSchema.js";
import { normalizeGstin, stateFromGstin, stateCodeForName } from "../utils/gstinState.js";
import { validateRegisteredGstin } from "../utils/customerGst.js";
import { resolveCustomerState } from "../utils/invoiceClient.js";
import { sbtBillingOf } from "./sbtWalletMode.js";

type AnyObj = Record<string, any>;
export type CheckoutMode = "official" | "personal";
export interface InvoiceToRefusal { ok: false; status: number; code: string; error: string }

/* ── switch ─────────────────────────────────────────────────────── */

let cache: { at: number; enabled: boolean } | null = null;
const TTL_MS = 30_000;

export async function invoiceToEnabled(): Promise<boolean> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.enabled;
  const doc: any = await SBTConfig.findOne({ key: "global" }).select("invoiceToEnabled").lean();
  cache = { at: Date.now(), enabled: doc?.invoiceToEnabled === true };
  return cache.enabled;
}
export function resetInvoiceToCache(): void {
  cache = null;
}

/* ── the company behind the caller's workspace ──────────────────── */

async function companyFor(workspaceObjectId: unknown) {
  if (!workspaceObjectId || !mongoose.Types.ObjectId.isValid(String(workspaceObjectId))) return null;
  const ws = (await CustomerWorkspace.findById(String(workspaceObjectId)).select("customerId companyName sbtBilling").lean()) as AnyObj | null;
  if (!ws) return null;
  const cid = String(ws.customerId || "");
  const customer = mongoose.Types.ObjectId.isValid(cid)
    ? ((await Customer.findById(cid).select("legalName name companyName gstRegistrations gstNumber gstStatus address gstRegisteredState email contacts").lean()) as AnyObj | null)
    : null;
  return { ws, customer };
}

function activeRegistrations(customer: AnyObj | null) {
  return ((customer?.gstRegistrations || []) as AnyObj[]).filter((r) => r && r.active !== false && r.gstin);
}

function companyName(c: { ws: AnyObj; customer: AnyObj | null }) {
  return String(c.customer?.legalName || c.customer?.companyName || c.customer?.name || c.ws.companyName || "").trim();
}

/** What the checkout shows (GET /api/sbt/invoice-to/options). */
export async function invoiceToOptions(req: AnyObj) {
  const enabled = await invoiceToEnabled();
  if (!enabled) return { enabled: false as const };
  const c = await companyFor(req.workspaceObjectId);
  const regs = activeRegistrations(c?.customer ?? null);
  const userId = req.user?._id ?? req.user?.id ?? req.user?.sub;
  const user: AnyObj | null = userId && mongoose.Types.ObjectId.isValid(String(userId))
    ? ((await User.findById(String(userId)).select("name firstName lastName email").lean()) as AnyObj | null)
    : null;
  return {
    enabled: true as const,
    allowPersonalToCompany: sbtBillingOf(c?.ws).allowPersonalInvoiceToCompany,
    company: {
      name: c ? companyName(c) : "",
      state: c?.customer ? resolveCustomerState(c.customer).state : "",
      registrations: regs.map((r) => ({
        id: String(r._id),
        gstin: r.gstin,
        state: r.state || stateFromGstin(r.gstin)?.state || "",
        label: r.label || r.tradeName || r.legalName || "",
        isDefault: r.isDefault === true,
      })),
    },
    me: {
      name: String(user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "").trim(),
      email: String(user?.email || req.user?.email || ""),
    },
  };
}

/* ── validate the choice → the snapshot ─────────────────────────── */

const refuse = (status: number, code: string, error: string): InvoiceToRefusal => ({ ok: false, status, code, error });
const text = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * The bill-to snapshot for this checkout, or a refusal. `{ ok: true }` with no
 * billTo = nothing to store (switch off, or no choice sent).
 */
export async function resolveCheckoutBillTo(
  req: AnyObj,
  mode: CheckoutMode,
  input: unknown,
): Promise<{ ok: true; billTo?: BillTo } | InvoiceToRefusal> {
  if (!(await invoiceToEnabled())) return { ok: true };
  if (!input || typeof input !== "object") return { ok: true };
  const inv = input as AnyObj;
  const kind = String(inv.kind || "").toUpperCase();

  if (kind === "INDIVIDUAL") {
    if (mode === "official") {
      return refuse(400, "INVOICE_TO_NOT_ALLOWED", "A company-paid (Official) booking is always invoiced to the company.");
    }
    const legalName = text(inv.name, 120);
    if (legalName.length < 2) return refuse(400, "INVOICE_TO_INVALID", "Enter the name to invoice");
    const addr = (inv.address && typeof inv.address === "object" ? inv.address : {}) as AnyObj;
    const address = {
      line1: text(addr.line1), line2: text(addr.line2), city: text(addr.city, 80), pincode: text(addr.pincode, 12), country: "India",
    };
    if (!address.line1) return refuse(400, "INVOICE_TO_INVALID", "Enter the address to invoice");
    const gstinRaw = normalizeGstin(inv.gstin);
    let state = text(inv.state, 60);
    let stateCode = "";
    let gstin: string | null = null;
    if (gstinRaw) {
      const bad = validateRegisteredGstin(gstinRaw);
      if (bad) return refuse(400, "INVOICE_TO_INVALID", bad);
      const st = stateFromGstin(gstinRaw);
      if (!st) return refuse(400, "INVOICE_TO_INVALID", `GSTIN "${gstinRaw}" does not start with a current GST state code`);
      gstin = gstinRaw;
      state = st.state; // derived and locked
      stateCode = st.stateCode;
    } else {
      stateCode = stateCodeForName(state);
      if (!state || !stateCode) return refuse(400, "INVOICE_TO_INVALID", "Choose the state to invoice (it sets the GST)");
    }
    return {
      ok: true,
      billTo: {
        kind: "INDIVIDUAL", registrationId: null, gstin, stateCode, state, legalName, address,
        email: text(inv.email, 160) || null, source: "SBT_CHECKOUT", at: new Date(),
      },
    };
  }

  if (kind === "COMPANY") {
    const c = await companyFor(req.workspaceObjectId);
    if (!c) return refuse(400, "INVOICE_TO_INVALID", "No company found for this booking");
    if (mode === "personal" && !sbtBillingOf(c.ws).allowPersonalInvoiceToCompany) {
      return refuse(400, "INVOICE_TO_NOT_ALLOWED", "A personal booking can't be invoiced to the company. Choose your name, or book as Official.");
    }
    const regs = activeRegistrations(c.customer);
    if (regs.length) {
      const wanted = text(inv.registrationId, 40);
      const reg = wanted ? regs.find((r) => String(r._id) === wanted) : regs.find((r) => r.isDefault === true) || regs[0];
      if (!reg) return refuse(400, "INVOICE_TO_INVALID", "That GST registration is not active for your company");
      const st = stateFromGstin(reg.gstin);
      return {
        ok: true,
        billTo: {
          kind: "COMPANY",
          registrationId: String(reg._id),
          gstin: normalizeGstin(reg.gstin),
          stateCode: reg.stateCode || st?.stateCode || "",
          state: reg.state || st?.state || "",
          legalName: String(reg.legalName || companyName(c)),
          address: {
            line1: reg.address?.line1 || "", line2: reg.address?.line2 || "", city: reg.address?.city || "",
            pincode: reg.address?.pincode || "", country: reg.address?.country || "India",
          },
          email: reg.billingEmail || null,
          source: "SBT_CHECKOUT",
          at: new Date(),
        },
      };
    }
    // No registrations (a company that predates them): its legal name, state
    // and — unless it is Unregistered — the GSTIN on file. B2C only when it
    // has none.
    const state = c.customer ? resolveCustomerState(c.customer).state : "";
    if (!state) return refuse(400, "INVOICE_TO_INVALID", "Your company has no state on file — ask Plumtrips to complete its billing profile");
    const legacyGstin = c.customer?.gstStatus === "UNREGISTERED" ? "" : normalizeGstin(c.customer?.gstNumber);
    return {
      ok: true,
      billTo: {
        kind: "COMPANY", registrationId: null, gstin: legacyGstin || null,
        stateCode: (legacyGstin && stateFromGstin(legacyGstin)?.stateCode) || stateCodeForName(state) || null, state,
        legalName: companyName(c), source: "SBT_CHECKOUT", at: new Date(),
      },
    };
  }

  return refuse(400, "INVOICE_TO_INVALID", "Choose who to invoice: your company or your name");
}
