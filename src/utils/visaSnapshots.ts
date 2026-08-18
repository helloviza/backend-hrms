// apps/backend/src/utils/visaSnapshots.ts
//
// The two point-in-time snapshots every VisaApplication is created with,
// in ONE place.
//
// ══════════════════════════════════════════════════════════════════════
// MOVED, NOT REWRITTEN.
// ══════════════════════════════════════════════════════════════════════
// Both functions lived as module-private helpers in routes/visa.ts
// (buildRuleSnapshot at :1202, buildIndicativeCostSnapshot at :1247) and
// are reproduced here with their logic and their comments intact. The B2B
// route now imports them. The ONLY change to either is the new `channel`
// parameter below, which defaults to "B2B" — so the B2B call site passes
// nothing and gets byte-identical output.
//
// They moved because the D2C consumer create endpoint needs the same two
// snapshots, and a second implementation of "what we froze about the rule
// at creation" is the kind of duplicate that silently diverges: the day
// someone adds a field to VisaRuleSnapshot, one copy gets it.
//
// ── WHY A SNAPSHOT AT ALL ────────────────────────────────────────────
// A VisaRule is live reference data that ops edits. An application must
// remember the terms it was created under — the price quoted, the
// checklist promised — even after the rule moves underneath it. Arrays are
// CLONED here rather than referenced for exactly that reason.
import type {
  VisaIndicativeCostSnapshot,
  VisaRuleSnapshot,
} from "../models/VisaApplication.js";
import { computeVisaFeeBlock, type VisaFeeChannel } from "./visaFee.js";

export function buildRuleSnapshot(rule: any): VisaRuleSnapshot {
  return {
    ruleId: rule._id,
    capturedAt: new Date(),
    destinationName: rule.destinationName,
    isSchengen: rule.isSchengen,
    productClass: rule.productClass,
    visaCategory: rule.visaCategory,
    purpose: rule.purpose,
    entryType: rule.entryType,
    serviceTier: rule.serviceTier,
    validityDays: rule.validityDays,
    maxStayDays: rule.maxStayDays,
    isExtension: rule.isExtension,
    etaMinDays: rule.etaMinDays,
    etaMaxDays: rule.etaMaxDays,
    etaBasis: rule.etaBasis,
    appointmentRequired: rule.appointmentRequired,
    biometricsRequired: rule.biometricsRequired,
    // Cloned, not the source array by reference — this is an embedded
    // POINT-IN-TIME copy (see VisaApplication.ts file header); the source
    // VisaRule must be free to change later without that ever being
    // visible through an application already created from it.
    documentRequirements: (rule.documentRequirements || []).map((d: any) => ({
      ...d,
    })),
    // Phase 10b — captured alongside documentRequirements above so a NEW
    // application preserves group/appliesWhen fidelity going forward
    // (existing applications' snapshots are immutable history and never
    // gain this retroactively — see VisaRuleSnapshot's own doc comment).
    // undefined (not []) when the rule itself has no groups, so "old-shape"
    // and "legacy-only rule" both resolve identically downstream.
    documentGroups:
      rule.documentGroups && rule.documentGroups.length > 0
        ? rule.documentGroups.map((g: any) => ({
            ...g,
            docTypeCodes: [...(g.docTypeCodes || [])],
            appliesWhen: g.appliesWhen ? g.appliesWhen.map((c: any) => ({ ...c })) : undefined,
          }))
        : undefined,
  };
}

// Same computeVisaFeeBlock the read route (GET /rules) uses — never a
// separately-maintained pricing calculation for the write path.
//
// ── THE CHANNEL PARAMETER IS THE ONE ADDITION ────────────────────────
// It defaults to "B2B", which is also computeVisaFeeBlock's own default,
// so the existing call (routes/visa.ts, no second argument) produces
// exactly what it always did: the block priced off plumtripsServiceFeeInr.
//
// D2C MUST pass "D2C", and the difference is not cosmetic. On Thailand the
// B2B block totals ₹354 and the D2C block totals ₹1,770 — the figure the
// consumer was actually quoted on the public surface. Storing the B2B
// total on a consumer's application would put a number in the frozen
// record that the consumer was never shown, which is the one thing a
// snapshot exists to prevent.
export function buildIndicativeCostSnapshot(
  rule: any,
  channel: VisaFeeChannel = "B2B",
): VisaIndicativeCostSnapshot {
  const fee = computeVisaFeeBlock(rule, channel);
  return {
    embassyFeeInr: rule.embassyFeeInr,
    vfsFeeInr: rule.vfsFeeInr,
    // The B2B margin field, carried on the snapshot as it always was. Note
    // this is the FIELD, not the figure the total was computed from under
    // a D2C channel — `totalInr` below is the authoritative amount for the
    // channel this application was priced in.
    plumtripsServiceFeeInr: rule.plumtripsServiceFeeInr,
    indicativeVisaCostInr: rule.indicativeVisaCostInr,
    displayMode: fee.displayMode,
    totalInr: fee.totalInr,
    priceNote: fee.priceNote,
  };
}
