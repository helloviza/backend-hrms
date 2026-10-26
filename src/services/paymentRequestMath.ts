// apps/backend/src/services/paymentRequestMath.ts
//
// The arithmetic of a payment request, kept pure so every rule is provable
// from a test: integer paise, 1–3 links, bases that sum to the target
// exactly, every link at least Razorpay's ₹1 minimum, and a PG charge
// computed once per link on top of its base.

/** Razorpay's minimum Payment Link amount for INR, in paise. */
export const MIN_LINK_PAISE = 100;
export const MAX_LINKS = 3;
export const MAX_PG_PCT = 10;

/** Razorpay: expire_by at least 15 minutes ahead, at most 6 months. */
export const MIN_EXPIRY_MS = 15 * 60 * 1000;
/** Margin over the 15 minutes so the request does not race Razorpay's clock. */
const EXPIRY_MARGIN_MS = 60 * 1000;
export const DEFAULT_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

export type SplitInput =
  | { mode: "EQUAL"; parts: number }
  | { mode: "PERCENT"; percents: number[] }
  | { mode: "AMOUNTS"; amountsPaise: number[] };

export class PaymentMathError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Rupees (as stored on bookings / invoices) → integer paise. */
export function rupeesToPaise(rupees: unknown): number {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

/**
 * Split `targetPaise` into link bases. EQUAL and PERCENT floor each share and
 * give the remainder to the last link, so the bases always sum to the target.
 * AMOUNTS must already sum to it. Every base must be ≥ MIN_LINK_PAISE.
 */
export function splitBases(targetPaise: number, split: SplitInput): { bases: number[]; pattern: string } {
  if (!Number.isInteger(targetPaise) || targetPaise < MIN_LINK_PAISE) {
    throw new PaymentMathError("BAD_TARGET", `The amount to collect must be at least ₹${MIN_LINK_PAISE / 100}.`);
  }

  let bases: number[];
  let pattern: string;

  if (split?.mode === "EQUAL") {
    const n = Number(split.parts);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LINKS) {
      throw new PaymentMathError("BAD_SPLIT", `Choose 1 to ${MAX_LINKS} links.`);
    }
    const each = Math.floor(targetPaise / n);
    bases = Array.from({ length: n }, (_, i) => (i === n - 1 ? targetPaise - each * (n - 1) : each));
    pattern = n === 1 ? "100" : `EQUAL:${n}`;
  } else if (split?.mode === "PERCENT") {
    const p = Array.isArray(split.percents) ? split.percents.map(Number) : [];
    if (p.length < 1 || p.length > MAX_LINKS) throw new PaymentMathError("BAD_SPLIT", `Choose 1 to ${MAX_LINKS} links.`);
    if (p.some((x) => !Number.isFinite(x) || x <= 0)) throw new PaymentMathError("BAD_SPLIT", "Each share must be more than 0%.");
    // Compare in hundredths of a percent so 33.33 + 33.33 + 33.34 is exact.
    const total = p.reduce((s, x) => s + Math.round(x * 100), 0);
    if (total !== 10000) throw new PaymentMathError("BAD_SPLIT", "The shares must add up to 100%.");
    const shares = p.map((x) => Math.floor((targetPaise * Math.round(x * 100)) / 10000));
    shares[shares.length - 1] = targetPaise - shares.slice(0, -1).reduce((s, x) => s + x, 0);
    bases = shares;
    pattern = p.map((x) => String(x)).join(":");
  } else if (split?.mode === "AMOUNTS") {
    const a = Array.isArray(split.amountsPaise) ? split.amountsPaise.map(Number) : [];
    if (a.length < 1 || a.length > MAX_LINKS) throw new PaymentMathError("BAD_SPLIT", `Choose 1 to ${MAX_LINKS} links.`);
    if (a.some((x) => !Number.isInteger(x))) throw new PaymentMathError("BAD_SPLIT", "Link amounts must be whole paise.");
    const sum = a.reduce((s, x) => s + x, 0);
    if (sum !== targetPaise) {
      throw new PaymentMathError("SUM_MISMATCH", `The links add up to ₹${(sum / 100).toFixed(2)}, not ₹${(targetPaise / 100).toFixed(2)}.`);
    }
    bases = a;
    pattern = "AMOUNTS";
  } else {
    throw new PaymentMathError("BAD_SPLIT", "Choose how to split the amount.");
  }

  if (bases.some((b) => b < MIN_LINK_PAISE)) {
    throw new PaymentMathError("LINK_TOO_SMALL", `Each link must be at least ₹${MIN_LINK_PAISE / 100}.`);
  }
  return { bases, pattern };
}

/** PG charge %: 0–10, at most two decimals. Returns the normalised number. */
export function parsePgPct(raw: unknown): number {
  const v = raw === undefined || raw === null || raw === "" ? 0 : Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > MAX_PG_PCT) {
    throw new PaymentMathError("BAD_PG_PCT", `PG charge must be between 0% and ${MAX_PG_PCT}%.`);
  }
  if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-9) {
    throw new PaymentMathError("BAD_PG_PCT", "PG charge can have at most two decimals.");
  }
  return Math.round(v * 100) / 100;
}

/** round(base × pct / 100) — computed once, stored on the link, never re-derived. */
export function pgChargePaise(basePaise: number, pct: number): number {
  return Math.round((basePaise * Math.round(pct * 100)) / 10000);
}

/** Clamp the RM's expiry into Razorpay's window; default is +3 days. */
export function clampExpiry(raw: unknown, now: Date = new Date()): Date {
  const min = now.getTime() + MIN_EXPIRY_MS + EXPIRY_MARGIN_MS;
  const max = new Date(now);
  max.setMonth(max.getMonth() + 6);
  const maxMs = max.getTime() - EXPIRY_MARGIN_MS;
  if (raw === undefined || raw === null || raw === "") return new Date(now.getTime() + DEFAULT_EXPIRY_MS);
  const t = new Date(raw as any).getTime();
  if (!Number.isFinite(t)) throw new PaymentMathError("BAD_EXPIRY", "Choose a valid expiry date.");
  return new Date(Math.min(Math.max(t, min), maxMs));
}

type LinkLike = { _id?: unknown; basePaise: number; status: string; replacesLinkId?: unknown };

/**
 * The sum rule: live links plus not-yet-replaced dead (cancelled / expired)
 * links cover the target exactly.
 */
export function coveredBasePaise(links: LinkLike[]): number {
  const replaced = new Set(links.filter((l) => l.replacesLinkId).map((l) => String(l.replacesLinkId)));
  return links.reduce((s, l) => {
    const dead = l.status === "CANCELLED" || l.status === "EXPIRED";
    if (!dead) return s + l.basePaise;
    return replaced.has(String(l._id)) ? s : s + l.basePaise;
  }, 0);
}

/** Request status from its links. */
export function deriveRequestStatus(links: LinkLike[], targetBasePaise: number): "OPEN" | "PARTLY_PAID" | "PAID" | "CANCELLED" {
  const paid = links.filter((l) => l.status === "PAID").reduce((s, l) => s + l.basePaise, 0);
  if (paid >= targetBasePaise) return "PAID";
  if (paid > 0) return "PARTLY_PAID";
  const anyPending = links.some((l) => l.status === "CREATED" || l.status === "FAILED_CREATE");
  return anyPending ? "OPEN" : "CANCELLED";
}
