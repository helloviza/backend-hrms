// apps/backend/src/utils/plutoBudget.ts
//
// Budget extraction for concierge hotel follow-ups. Parses natural-language
// budget qualifiers ("under USD 200", "beyond USD 500", "between ₹5000 and
// ₹8000", "under 15k", "around $300") into a structured, LOCKABLE band, and
// resolves RELATIVE follow-ups ("cheaper", "something more premium") off an
// existing budget. The result is written to conversationContext.locked.budget so
// the AI sees it in LOCKED DECISIONS and respects it in hotel suggestions.
//
// Currency: this is an INR platform, so a bare number defaults to INR. A USD
// budget is preserved as USD (the prompt then instructs the model to state the
// indicative conversion) — we never silently treat USD as INR.

export type BudgetCurrency = "USD" | "INR";

export interface Budget {
  min?: number;
  max?: number;
  currency: BudgetCurrency;
}

// A number token with optional thousands "k" and optional commas/decimals.
const NUM = String.raw`(?:USD|US\$|\$|INR|₹|Rs\.?|rupees?|dollars?)?\s*(\d[\d,]*(?:\.\d+)?)\s*([kK])?`;

function parseAmount(digits: string, kSuffix?: string): number {
  const n = parseFloat(digits.replace(/,/g, ""));
  if (isNaN(n)) return NaN;
  return kSuffix ? Math.round(n * 1000) : Math.round(n);
}

function detectCurrency(prompt: string): BudgetCurrency {
  if (/\bUSD\b|US\$|\$|dollars?/i.test(prompt)) return "USD";
  if (/₹|\bINR\b|\bRs\.?\b|rupees?/i.test(prompt)) return "INR";
  return "INR"; // platform default
}

const RELATIVE_DOWN = /\b(cheaper|cheap|budget|affordable|less expensive|lower|economical|save money)\b/i;
const RELATIVE_UP = /\b(more premium|premium|luxur\w*|nicer|upscale|higher[- ]?end|fancier|better hotels?|splurge)\b/i;

/**
 * Parse a budget from the prompt. Absolute statements override any existing
 * budget (a restatement wins). A relative term ("cheaper"/"more premium") with
 * no absolute number adjusts off `existing`. Returns null when the prompt
 * carries no budget signal (the caller then keeps the existing budget).
 */
export function parseBudget(prompt: string, existing?: Budget | null): Budget | null {
  const currency = detectCurrency(prompt);

  // between X and Y  (also "from X to Y")
  const between = prompt.match(
    new RegExp(String.raw`\b(?:between|from)\s+${NUM}\s*(?:and|to|-|–|—)\s*${NUM}`, "i"),
  );
  if (between) {
    const a = parseAmount(between[1], between[2]);
    const b = parseAmount(between[3], between[4]);
    if (!isNaN(a) && !isNaN(b)) {
      return { min: Math.min(a, b), max: Math.max(a, b), currency };
    }
  }

  // around / about X  → a band centred on X (±15%)
  const around = prompt.match(
    new RegExp(String.raw`\b(?:around|about|approx(?:imately)?|roughly|near|~)\s*${NUM}`, "i"),
  );
  if (around) {
    const x = parseAmount(around[1], around[2]);
    if (!isNaN(x)) return { min: Math.round(x * 0.85), max: Math.round(x * 1.15), currency };
  }

  // under / below X  → max
  const under = prompt.match(
    new RegExp(String.raw`\b(?:under|below|less than|up ?to|within|max(?:imum)?|no more than|cheaper than|beneath)\s+${NUM}`, "i"),
  );
  if (under) {
    const x = parseAmount(under[1], under[2]);
    if (!isNaN(x)) return { max: x, currency };
  }

  // beyond / above X  → min
  const above = prompt.match(
    new RegExp(String.raw`\b(?:beyond|above|over|more than|at least|min(?:imum)?|starting (?:from|at)|north of)\s+${NUM}`, "i"),
  );
  if (above) {
    const x = parseAmount(above[1], above[2]);
    if (!isNaN(x)) return { min: x, currency };
  }

  // Relative follow-ups — adjust off the existing budget (no absolute number).
  if (existing) {
    const cur = existing.currency;
    if (RELATIVE_UP.test(prompt)) {
      // Go more premium: lift the floor above the current ceiling (or budget).
      const base = existing.max ?? existing.min ?? 0;
      return { min: Math.round(base * 1.3), currency: cur };
    }
    if (RELATIVE_DOWN.test(prompt)) {
      // Go cheaper: cap below the current floor/ceiling.
      const base = existing.min ?? existing.max ?? 0;
      const cap = base > 0 ? Math.round(base * 0.7) : 0;
      return cap > 0 ? { max: cap, currency: cur } : null;
    }
  }

  return null;
}

/** Human-readable one-liner for prompt guidance / system messages. */
export function describeBudget(b: Budget): string {
  const sym = b.currency === "USD" ? "USD " : "₹";
  if (b.min != null && b.max != null) return `${sym}${b.min}–${sym}${b.max}`;
  if (b.max != null) return `under ${sym}${b.max}`;
  if (b.min != null) return `above ${sym}${b.min}`;
  return `${b.currency} budget`;
}
