// apps/backend/src/utils/customerGst.ts
//
// Customer (recipient) GST status. Many Plumtrips clients — affiliates, agents,
// influencers, often individuals — hold no GST registration: Plumtrips pays the
// airline's GST inside the fare and the client pays Plumtrips in full, like any
// B2C customer. Such a company is UNREGISTERED and must work with no GSTIN,
// never be flagged or blocked for it. NOT_SET (or no value at all, which is
// every company until scripts/migrate-customer-gst-status.ts runs) behaves
// exactly as before this field existed.
//
// Tax calculation never reads this — CGST/SGST vs IGST stays state-based
// (utils/gstDetection.ts). It only decides what the client-GSTIN line shows,
// whether a GSTIN is validated, and whether GST details go to TBO.
import mongoose from "mongoose";
import { GSTIN_RE } from "../models/CompanySettings.js";
import Customer from "../models/Customer.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

export const GST_STATUSES = ["REGISTERED", "UNREGISTERED", "NOT_SET"] as const;
export type GstStatus = (typeof GST_STATUSES)[number];

export const UNREGISTERED_LABEL = "Unregistered (B2C)";

/** Missing or unknown → NOT_SET (today's behaviour). */
export function normalizeGstStatus(v: unknown): GstStatus {
  const s = String(v ?? "").trim().toUpperCase();
  return (GST_STATUSES as readonly string[]).includes(s) ? (s as GstStatus) : "NOT_SET";
}

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** GSTIN check digit (15th character), mod-36 weighted sum. */
export function gstinChecksumValid(gstin: string): boolean {
  const g = String(gstin || "").toUpperCase();
  if (g.length !== 15) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(g[i]);
    if (v < 0) return false;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === g[14];
}

/** Validation for a REGISTERED company's GSTIN: format, check digit, and —
 *  when a PAN is on record — that the GSTIN carries that PAN (chars 3-12).
 *  Returns an error message, or null when valid. */
export function validateRegisteredGstin(gstinRaw: unknown, panRaw?: unknown): string | null {
  const gstin = String(gstinRaw ?? "").trim().toUpperCase();
  if (!gstin) return "A registered company needs a GSTIN. Enter it, or set the GST status to Unregistered.";
  if (!GSTIN_RE.test(gstin)) return `GSTIN "${gstin}" is not in the right format (15 characters, e.g. 22AAAAA0000A1Z5).`;
  if (!gstinChecksumValid(gstin)) return `GSTIN "${gstin}" fails the check-digit test — please re-check it for a typo.`;
  const pan = String(panRaw ?? "").trim().toUpperCase();
  if (pan && gstin.slice(2, 12) !== pan) {
    return `GSTIN "${gstin}" does not belong to PAN "${pan}" (characters 3–12 of a GSTIN are the PAN).`;
  }
  return null;
}

/** Status implied by an onboarding form: "Not registered" ticked or entity
 *  type URP (Unregistered Person) → UNREGISTERED; a GSTIN → REGISTERED;
 *  otherwise NOT_SET. An explicit formPayload.gstStatus (set by staff in
 *  Business Master before promote) wins. */
export function gstStatusFromForm(p: any): GstStatus {
  const f = p || {};
  if (f.gstStatus) return normalizeGstStatus(f.gstStatus);
  if (f.gstNotRegistered === true || String(f.entityType || "").toUpperCase() === "URP") return "UNREGISTERED";
  if (String(f.gstNumber || f.gstin || "").trim()) return "REGISTERED";
  return "NOT_SET";
}

/** One-time migration mapping (scripts/migrate-customer-gst-status.ts): a
 *  company with a GSTIN on its Customer record → REGISTERED, without →
 *  NOT_SET. Never UNREGISTERED — that is a staff decision, not a guess. */
export function migrationGstStatus(c: { gstNumber?: unknown; gstin?: unknown }): GstStatus {
  return String(c?.gstNumber || c?.gstin || "").trim() ? "REGISTERED" : "NOT_SET";
}

/** GST status of the company behind a CustomerWorkspace _id. */
export async function gstStatusForWorkspace(workspaceId: unknown): Promise<GstStatus> {
  const id = String(workspaceId || "");
  if (!mongoose.Types.ObjectId.isValid(id)) return "NOT_SET";
  const ws = await CustomerWorkspace.findById(id).select("customerId").lean();
  const customerId = String((ws as any)?.customerId || "");
  if (!mongoose.Types.ObjectId.isValid(customerId)) return "NOT_SET";
  const cust = await Customer.findById(customerId).select("gstStatus").lean();
  return normalizeGstStatus((cust as any)?.gstStatus);
}

const PAX_GST_KEYS = ["GSTNumber", "GSTCompanyName", "GSTCompanyAddress", "GSTCompanyContactNumber", "GSTCompanyEmail"];

/** SBT: an UNREGISTERED company sends no GST details to TBO. Drops them from
 *  the request before any handler (or the checkout fulfilment, which replays
 *  the same handlers with the stored request) reads it. Returns true when
 *  something was stripped. */
export async function stripSbtGstIfUnregistered(req: any): Promise<boolean> {
  if ((await gstStatusForWorkspace(req?.workspaceObjectId || req?.workspaceId)) !== "UNREGISTERED") return false;
  const b = req.body || {};
  for (const list of [b.Passengers, b.returnPassengers]) {
    if (!Array.isArray(list)) continue;
    for (const p of list) for (const k of PAX_GST_KEYS) if (p && k in p) delete p[k];
  }
  delete b.gstInfo;
  delete b.GSTCompanyInfo;
  return true;
}
