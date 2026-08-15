// apps/backend/src/utils/visaFee.ts
//
// Server-derived visa fee display block for the customer-facing rules
// endpoint (routes/visa.ts). displayMode is re-derived here independently
// of whatever VisaRule.displayMode holds in the DB — the same rule as the
// model's own pre-validate hook (VisaRule.ts), but self-contained so this
// works against in-memory test fixtures that were never saved through the
// model, and so pricing logic lives in exactly one place either way.
//
// Embassy and VFS fees are pass-through at actual, with no margin — GST
// applies ONLY to the Plumtrips service fee, never to embassy/VFS.

import type { VisaCategory, VisaRuleDisplayMode } from "../models/VisaRule.js";

// THE GST rate for this module — one definition, four consumers. It was
// written out five times before 2026-08-08: as this constant, as the digits
// inside the fee line's own label string, twice as `gstPercent: 18` in
// services/visaBillingSync.ts, and once in customer-facing legal copy
// (frontend VisaFooterBand.tsx, deliberately NOT wired to this — see below).
// The label was the dangerous one: changing the rate here alone produced a
// correct amount under a caption that still said 18%.
//
// Exported in two shapes because the two consumers genuinely need two:
// the multiplier for the arithmetic below, and the whole-number percent
// ManualBooking.pricing.gstPercent stores. PERCENT is derived, never a
// second literal, so they cannot disagree.
//
// NOT wired to this constant, on purpose:
//   - apps/frontend/src/components/visa/VisaFooterBand.tsx's footer
//     sentence. It is legal copy on a shared band, not a computed figure,
//     and it is a build artefact away from this module — a rate change
//     needs a human to re-read that sentence, not a template to silently
//     rewrite it.
//   - models/ManualBooking.ts's own `gstPercent` schema default and its
//     `?? 18` fallback. Those belong to the manual-booking module and apply
//     to every booking type, not just VISA; folding them into a visa
//     constant would invert the dependency.
export const VISA_GST_RATE = 0.18;
export const VISA_GST_PERCENT = Math.round(VISA_GST_RATE * 100);

export const VISA_FEE_DISCLAIMER =
  "Embassy and VFS charges are recovered at actual and invoiced on completion — the final billed amount may differ from this estimate.";

export interface VisaFeeInput {
  embassyFeeInr?: number | null;
  vfsFeeInr?: number | null;
  plumtripsServiceFeeInr?: number | null;
  // Phase 1b (2026-08-16) — the D2C service fee. Optional, so every existing
  // caller's input shape is unchanged.
  d2cServiceFeeInr?: number | null;
  indicativeVisaCostInr?: number | null;
  priceNote?: string | null;
  visaCategory?: VisaCategory | null;
}

/**
 * Which channel's service fee to price with.
 *
 * DEFAULTS TO "B2B" EVERYWHERE, and that default is load-bearing: all six
 * existing call sites (routes/visa.ts's /destinations, /rules, /rules/:id and
 * buildIndicativeCostSnapshot; services/visaBillingSync.ts's
 * computeIndicativeMarkupPricing) pass no channel and are not edited by this
 * phase. utils/visaFee.test.ts is likewise unmodified — it is the regression
 * witness that the B2B path is byte-identical.
 */
export type VisaFeeChannel = "B2B" | "D2C";

/**
 * The ONE place that decides which fee field a channel prices with.
 *
 * embassyFeeInr/vfsFeeInr are NOT channel-dependent — they are pass-throughs
 * at actual, identical for a consumer and a corporate buyer — so this
 * selects only the margin component.
 */
function selectServiceFee(rule: VisaFeeInput, channel: VisaFeeChannel): number | null | undefined {
  return channel === "D2C" ? rule.d2cServiceFeeInr : rule.plumtripsServiceFeeInr;
}

export type VisaFeeLineItemCode = "EMBASSY_FEE" | "VFS_FEE" | "SERVICE_FEE" | "GST" | "INDICATIVE";

export interface VisaFeeLineItem {
  code: VisaFeeLineItemCode;
  label: string;
  amountInr: number;
}

export interface VisaFeeBlock {
  displayMode: VisaRuleDisplayMode;
  lineItems: VisaFeeLineItem[];
  totalInr: number;
  // Optional, not always present — see the VISA_FREE omission below.
  disclaimer?: string;
  priceNote?: string;
}

export function computeVisaFeeBlock(
  rule: VisaFeeInput,
  channel: VisaFeeChannel = "B2B",
): VisaFeeBlock {
  const serviceFeeInr = selectServiceFee(rule, channel);

  // Evaluated against the SELECTED service fee, so the two channels are
  // internally consistent. Under the "B2B" default this expression resolves
  // to exactly what it always did (plumtripsServiceFeeInr), which is what
  // makes the default path byte-identical.
  const hasItemised =
    rule.embassyFeeInr != null || rule.vfsFeeInr != null || serviceFeeInr != null;

  const block = hasItemised ? computeItemised(rule, serviceFeeInr) : computeIndicative(rule);
  if (rule.priceNote) block.priceNote = rule.priceNote;

  // A visa-free rule has no embassy/VFS charges at all — the disclaimer
  // about those being "recovered at actual" would contradict the ₹0 total
  // directly beneath it. priceNote (the "entry is free of charge" line)
  // stays; only this disclaimer is omitted.
  if (rule.visaCategory === "VISA_FREE") {
    delete block.disclaimer;
  }

  return block;
}

// `serviceFeeInr` is the ALREADY-SELECTED channel fee (see selectServiceFee).
// Passing it in rather than re-reading a field off `rule` keeps the channel
// decision in exactly one place — this function cannot disagree with the
// caller about which fee it is pricing.
function computeItemised(rule: VisaFeeInput, serviceFeeInr: number | null | undefined): VisaFeeBlock {
  const lineItems: VisaFeeLineItem[] = [];
  let totalInr = 0;

  if (rule.embassyFeeInr != null) {
    lineItems.push({ code: "EMBASSY_FEE", label: "Embassy Fee", amountInr: rule.embassyFeeInr });
    totalInr += rule.embassyFeeInr;
  }
  if (rule.vfsFeeInr != null) {
    lineItems.push({ code: "VFS_FEE", label: "VFS Fee", amountInr: rule.vfsFeeInr });
    totalInr += rule.vfsFeeInr;
  }
  if (serviceFeeInr != null) {
    lineItems.push({
      code: "SERVICE_FEE",
      // Unchanged under both channels in this phase. The consumer brand is
      // Helloviza, so this label is arguably wrong for D2C — but it is
      // customer-visible copy on a surface that does not exist yet (Phase 2's
      // public endpoint), and changing it here would silently change what
      // every B2B customer already sees. Flagged in the Phase 1b design note,
      // deliberately not acted on.
      label: "Plumtrips Service Fee",
      amountInr: serviceFeeInr,
    });
    totalInr += serviceFeeInr;

    // GST base is the SELECTED service fee ONLY — embassy/VFS are
    // pass-through at actual and must never enter it, under either channel.
    const gstInr = Math.round(serviceFeeInr * VISA_GST_RATE);
    lineItems.push({
      code: "GST",
      // Interpolated, not written out: the caption cannot drift from the
      // multiplier applied on the line above it.
      label: `GST (${VISA_GST_PERCENT}% on service fee)`,
      amountInr: gstInr,
    });
    totalInr += gstInr;
  }

  return {
    displayMode: "ITEMISED",
    lineItems,
    totalInr,
    disclaimer: VISA_FEE_DISCLAIMER,
  };
}

function computeIndicative(rule: VisaFeeInput): VisaFeeBlock {
  const amountInr = rule.indicativeVisaCostInr ?? 0;
  return {
    displayMode: "INDICATIVE",
    lineItems: [{ code: "INDICATIVE", label: "Indicative Visa Cost", amountInr }],
    totalInr: amountInr,
    disclaimer: VISA_FEE_DISCLAIMER,
  };
}
