// apps/backend/src/services/itineraryAssembly.ts
//
// Phase 5 (Assemble) — PURE itinerary assembly + policy rollup. Reuses the
// Phase 2 policy annotation already attached to each selected object (does NOT
// re-evaluate). Same-kind adds REPLACE (one outbound, one inbound, one hotel).

export type ItineraryItemKind = "FLIGHT_OUTBOUND" | "FLIGHT_INBOUND" | "HOTEL";
export type PolicyStatus = "IN_POLICY" | "NEEDS_APPROVAL" | "OUT_OF_POLICY";

const KIND_ORDER: ItineraryItemKind[] = ["FLIGHT_OUTBOUND", "FLIGHT_INBOUND", "HOTEL"];
const VALID_KINDS = new Set<string>(KIND_ORDER);

// Worst-of ranking for the itinerary policy rollup.
const POLICY_RANK: Record<PolicyStatus, number> = { IN_POLICY: 0, NEEDS_APPROVAL: 1, OUT_OF_POLICY: 2 };
const RANK_STATUS: PolicyStatus[] = ["IN_POLICY", "NEEDS_APPROVAL", "OUT_OF_POLICY"];

export interface ItineraryItemInput {
  kind: ItineraryItemKind;
  payload: any;
  policy?: { status?: string; reasons?: string[] } | null;
  priceINR?: number;
}

export interface AssembledItem {
  kind: ItineraryItemKind;
  payload: any;
  policy: { status: PolicyStatus; reasons: string[] };
  priceINR: number;
}

/** Normalise a Phase-2 policy annotation into a stable {status, reasons}. */
export function normalizeItemPolicy(policy: any): { status: PolicyStatus; reasons: string[] } {
  const raw = String(policy?.status || "").toUpperCase();
  const status: PolicyStatus = (POLICY_RANK as any)[raw] != null ? (raw as PolicyStatus) : "IN_POLICY";
  const reasons = Array.isArray(policy?.reasons) ? policy.reasons.map(String) : [];
  return { status, reasons };
}

/** Worst-of rollup across items. No items → IN_POLICY (nothing violates). */
export function rollupPolicy(items: Array<{ policy: { status: PolicyStatus } }>): PolicyStatus {
  let worst = 0;
  for (const it of items) worst = Math.max(worst, POLICY_RANK[it.policy.status] ?? 0);
  return RANK_STATUS[worst];
}

export function computeTotal(items: Array<{ priceINR: number }>): number {
  return items.reduce((sum, it) => sum + (Number(it.priceINR) || 0), 0);
}

/** Normalise one incoming selection into an AssembledItem. Loud on bad kind. */
export function assembleItem(input: ItineraryItemInput): AssembledItem {
  if (!input || !VALID_KINDS.has(input.kind)) {
    throw new Error(`Invalid itinerary item kind: ${JSON.stringify(input?.kind)}`);
  }
  return {
    kind: input.kind,
    payload: input.payload ?? null,
    policy: normalizeItemPolicy(input.policy),
    priceINR: Number(input.priceINR) || 0,
  };
}

/**
 * Merge incoming selections into existing items: same-kind REPLACES, so a DRAFT
 * always holds at most one outbound + one inbound + one hotel. Output is ordered
 * FLIGHT_OUTBOUND → FLIGHT_INBOUND → HOTEL. Returns the merged items plus the
 * recomputed total and worst-of policy summary.
 */
export function assembleItinerary(
  existing: AssembledItem[] = [],
  incoming: ItineraryItemInput[] = [],
): { items: AssembledItem[]; totalPriceINR: number; policySummary: PolicyStatus } {
  const byKind = new Map<ItineraryItemKind, AssembledItem>();
  for (const it of existing) {
    if (VALID_KINDS.has(it.kind)) byKind.set(it.kind, assembleItem(it));
  }
  for (const it of incoming) byKind.set(it.kind, assembleItem(it)); // replace same kind

  const items = KIND_ORDER.filter((k) => byKind.has(k)).map((k) => byKind.get(k)!);
  return { items, totalPriceINR: computeTotal(items), policySummary: rollupPolicy(items) };
}
