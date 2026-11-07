// apps/backend/src/utils/gstinState.ts
//
// A client GSTIN carries its state and its PAN:
//   chars 1-2  = GST state code ("06" Haryana, "29" Karnataka, …)
//   chars 3-12 = the PAN of the legal entity
// Client GST registrations never take a typed state — it is derived here, so
// the tax state on an invoice can't disagree with the GSTIN it is billed to.
import { GST_STATE_CODES } from "./gstDetection.js";

const STATE_BY_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(GST_STATE_CODES).map(([state, code]) => [code, state]),
);

export function normalizeGstin(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, "").toUpperCase();
}

/** State name + code from a GSTIN's first two digits; null when the code is
 *  not a current GST state (e.g. 25, the pre-2020 Daman & Diu code, or 97). */
export function stateFromGstin(gstin: unknown): { stateCode: string; state: string } | null {
  const code = normalizeGstin(gstin).slice(0, 2);
  const state = STATE_BY_CODE[code];
  return state ? { stateCode: code, state } : null;
}

/** The PAN embedded in a GSTIN (characters 3–12). */
export function panFromGstin(gstin: unknown): string {
  const g = normalizeGstin(gstin);
  return g.length >= 12 ? g.slice(2, 12) : "";
}

/** Code for a state NAME (as stored in gstRegisteredState); "" if unknown. */
export function stateCodeForName(state: unknown): string {
  return GST_STATE_CODES[String(state ?? "").trim()] || "";
}
