// apps/backend/src/services/policyEvaluator.ts
//
// PURE travel-policy evaluation. No Mongo, no I/O, no side effects.
//
// The evaluators take a plain PolicyRules interface (NOT a Mongoose document)
// so a future layer can compose caps from multiple sources (e.g. ExpenseBand)
// into PolicyRules without touching this logic. Use policyRulesFromDoc() to
// derive PolicyRules from a TravelPolicy document.

import type { FareType } from "../models/TravelPolicy.js";

export type PolicyStatus = "IN_POLICY" | "NEEDS_APPROVAL" | "OUT_OF_POLICY";

export interface PolicyResult {
  status: PolicyStatus;
  reasons: string[];
}

export interface PolicyRules {
  allowedFareTypes?: FareType[];
  cabinClassCap?: number | null;
  maxFlightPriceINR?: number | null;
  hotelStarCap?: number | null;
  maxHotelPricePerNightINR?: number | null;
  approvalAbovePriceINR?: number | null;
  requireRefundable?: boolean | null;
  allowLCC?: boolean | null;
  active?: boolean;
}

// Normalised inputs — Step 2 adapters build these from each search path's shape.
export interface FlightForPolicy {
  priceINR: number;
  cabinClass?: number | null; // TBO numeric (2=Economy … 6=First)
  fareType?: FareType;
  isLCC?: boolean;
  isRefundable?: boolean;
}

export interface HotelForPolicy {
  pricePerNightINR?: number | null;
  starRating?: number | null;
}

const NO_POLICY: PolicyResult = { status: "IN_POLICY", reasons: ["no_policy_configured"] };

function isNoPolicy(policy?: PolicyRules | null): boolean {
  return !policy || policy.active === false;
}

// Hard reasons → OUT_OF_POLICY (and still surfaced alongside soft ones).
// Soft reasons only → NEEDS_APPROVAL. None → IN_POLICY.
function combine(hard: string[], soft: string[]): PolicyResult {
  if (hard.length > 0) return { status: "OUT_OF_POLICY", reasons: [...hard, ...soft] };
  if (soft.length > 0) return { status: "NEEDS_APPROVAL", reasons: soft };
  return { status: "IN_POLICY", reasons: [] };
}

export function evaluateFlightPolicy(
  flight: FlightForPolicy,
  policy?: PolicyRules | null,
): PolicyResult {
  if (isNoPolicy(policy)) return NO_POLICY;
  const p = policy as PolicyRules;
  const hard: string[] = [];
  const soft: string[] = [];

  if (Array.isArray(p.allowedFareTypes) && p.allowedFareTypes.length > 0) {
    const ft: FareType = flight.fareType ?? "RETAIL";
    if (!p.allowedFareTypes.includes(ft)) hard.push("fare_type_not_allowed");
  }
  if (p.cabinClassCap != null && flight.cabinClass != null && flight.cabinClass > p.cabinClassCap) {
    hard.push("cabin_above_cap");
  }
  if (p.maxFlightPriceINR != null && flight.priceINR > p.maxFlightPriceINR) {
    hard.push("price_above_cap");
  }
  if (p.requireRefundable === true && flight.isRefundable !== true) {
    hard.push("not_refundable");
  }
  if (p.allowLCC === false && flight.isLCC === true) {
    hard.push("lcc_not_allowed");
  }
  if (p.approvalAbovePriceINR != null && flight.priceINR > p.approvalAbovePriceINR) {
    soft.push("needs_approval_price");
  }

  return combine(hard, soft);
}

export function evaluateHotelPolicy(
  hotel: HotelForPolicy,
  policy?: PolicyRules | null,
): PolicyResult {
  if (isNoPolicy(policy)) return NO_POLICY;
  const p = policy as PolicyRules;
  const hard: string[] = [];
  const soft: string[] = [];

  if (p.hotelStarCap != null && hotel.starRating != null && hotel.starRating > p.hotelStarCap) {
    hard.push("star_above_cap");
  }
  if (
    p.maxHotelPricePerNightINR != null &&
    hotel.pricePerNightINR != null &&
    hotel.pricePerNightINR > p.maxHotelPricePerNightINR
  ) {
    hard.push("price_above_cap");
  }
  if (
    p.approvalAbovePriceINR != null &&
    hotel.pricePerNightINR != null &&
    hotel.pricePerNightINR > p.approvalAbovePriceINR
  ) {
    soft.push("needs_approval_price");
  }

  return combine(hard, soft);
}

// Derive a plain PolicyRules from a TravelPolicy document (or lean object).
// Returns null when no doc — callers then get the "no_policy_configured" path.
export function policyRulesFromDoc(doc: any): PolicyRules | null {
  if (!doc) return null;
  return {
    allowedFareTypes: doc.allowedFareTypes ?? [],
    cabinClassCap: doc.cabinClassCap ?? null,
    maxFlightPriceINR: doc.maxFlightPriceINR ?? null,
    hotelStarCap: doc.hotelStarCap ?? null,
    maxHotelPricePerNightINR: doc.maxHotelPricePerNightINR ?? null,
    approvalAbovePriceINR: doc.approvalAbovePriceINR ?? null,
    requireRefundable: doc.requireRefundable ?? null,
    allowLCC: doc.allowLCC ?? null,
    active: doc.active ?? true,
  };
}
