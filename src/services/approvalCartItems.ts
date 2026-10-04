// apps/backend/src/services/approvalCartItems.ts
//
// The last step before an approval request's cart is stored (POST and PUT
// /api/approvals/requests): after travellers are rebuilt, every item is
// normalised and validated with the same rules the request form runs
// (approvalItemRules.ts). Anything the form would refuse is refused here too,
// so a client that skips the form gets the same answer.

import { normalizeItem, validateCart, todayIST, type Issue } from "./approvalItemRules.js";
import { maskTailId } from "../utils/piiMask.js";

export class CartItemError extends Error {
  status = 400;
  constructor(
    public code: string,
    message: string,
    public itemIndex: number,
    public field: string,
    public issues: Array<Issue & { itemIndex: number }>,
  ) {
    super(message);
  }
}

/**
 * Customers get a forex PAN back masked (last 4), so an edit sends "******234F"
 * for an unchanged PAN. Put the stored one back when an existing forex item
 * holds a PAN with that mask; otherwise ask for it again.
 */
function restoreMaskedPans(items: any[], existing: any[]): any[] {
  const stored = (Array.isArray(existing) ? existing : [])
    .filter((it) => String(it?.type || "").toLowerCase() === "forex")
    .map((it) => String(it?.meta?.pan || "").trim().toUpperCase())
    .filter((p) => p && !p.includes("*"));
  return items.map((it, itemIndex) => {
    const pan = String(it?.meta?.pan || "").trim().toUpperCase();
    if (String(it?.type || "").toLowerCase() !== "forex" || !pan.includes("*")) return it;
    const real = stored.find((p) => maskTailId(p) === pan);
    if (!real) {
      throw new CartItemError("PAN_REENTER", "Forex: please re-enter the full PAN.", itemIndex, "pan", [
        { itemIndex, field: "pan", code: "PAN_REENTER", message: "Forex: please re-enter the full PAN." },
      ]);
    }
    return { ...it, meta: { ...it.meta, pan: real } };
  });
}

/**
 * Normalised, validated cart items, or a CartItemError naming the first
 * problem (and listing all of them). `existingCartItems` is the stored cart
 * on an edit, for restoring masked PANs.
 */
export function checkCartItems(items: any[], opts: { existingCartItems?: any[]; now?: Date } = {}): any[] {
  const restored = restoreMaskedPans(Array.isArray(items) ? items : [], opts.existingCartItems || []);
  const normalized = restored.map((it) => normalizeItem(it));
  const issues = validateCart(normalized, { today: todayIST(opts.now) });
  if (issues.length) {
    const first = issues[0];
    throw new CartItemError(first.code, first.message, first.itemIndex, first.field, issues);
  }
  return normalized;
}
