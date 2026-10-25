// apps/backend/src/models/cstep/expenseCategories.ts
//
// Finance a+b Stage 1 — the expense category every settlement item carries,
// so Finance can see (and, later, map to a Tally ledger) what each
// traveller-paid amount was for. One list, one set of source → category
// rules, shared by the two places settlement lines are created
// (routes/cstep.ts buildSeedSettlementLines / buildClaimSettlementLines),
// the Expense Claim form's head picker, the Finance "Traveller-paid
// expenses" view and the backfill (scripts/backfill-cstep-settlement-
// categories.ts). Every rule reads the SOURCE record's own field — a travel
// mode, the claim array a line sits in, an Expense Claim line's head — never
// a description.
//
//   FLIGHT … STATIONERY, OTHER   a Tour's arranged service / report-leg travel mode
//   CAB / TRAIN / BUS / OWN_VEHICLE   a Local Travel Claim travel line (its mode)
//   FOOD                          a Local Travel Claim food line
//   OTHER                         a Local Travel Claim's "Other expenses"
//   (the line's head)             an Expense Claim line with a head picked
//   EXPENSE_LINE                  an Expense Claim line filed before the picker (no head)
//   TAX                           an Expense Claim's tax (IGST) amount
//   PER_DIEM                      the per diem (on the settlement, not a line)

export const CSTEP_EXPENSE_CATEGORIES = [
  "FLIGHT",
  "HOTEL",
  "CAB",
  "TRAIN",
  "BUS",
  "OWN_VEHICLE",
  "FOOD",
  "PER_DIEM",
  "VISA",
  "FOREX",
  "STATIONERY",
  "TAX",
  "OTHER",
  "EXPENSE_LINE",
] as const;
export type CstepExpenseCategory = (typeof CSTEP_EXPENSE_CATEGORIES)[number];

export const CSTEP_EXPENSE_CATEGORY_LABEL: Record<CstepExpenseCategory, string> = {
  FLIGHT: "Flight",
  HOTEL: "Hotel",
  CAB: "Cab",
  TRAIN: "Train",
  BUS: "Bus",
  OWN_VEHICLE: "Own vehicle",
  FOOD: "Food",
  PER_DIEM: "Per diem",
  VISA: "Visa",
  FOREX: "Forex",
  STATIONERY: "Stationery",
  TAX: "Tax",
  OTHER: "Other",
  EXPENSE_LINE: "Expense (no head)",
};

/** The heads a claimant can pick on an Expense Claim line (default OTHER).
 * Per diem and tax are never a line's head, and EXPENSE_LINE is only what a
 * line filed before the picker existed is called. */
export const CSTEP_EXPENSE_LINE_HEADS = [
  "FLIGHT",
  "HOTEL",
  "CAB",
  "TRAIN",
  "BUS",
  "OWN_VEHICLE",
  "FOOD",
  "VISA",
  "FOREX",
  "STATIONERY",
  "OTHER",
] as const satisfies readonly CstepExpenseCategory[];
export type CstepExpenseLineHead = (typeof CSTEP_EXPENSE_LINE_HEADS)[number];

export const isExpenseLineHead = (v: any): v is CstepExpenseLineHead =>
  (CSTEP_EXPENSE_LINE_HEADS as readonly string[]).includes(String(v));

/** A Tour's service type (arrangedType / a report leg's travelMode) is its
 * category one-for-one. */
const SERVICE_TYPE_CATEGORY: Record<string, CstepExpenseCategory> = {
  FLIGHT: "FLIGHT",
  HOTEL: "HOTEL",
  CAB: "CAB",
  TRAIN: "TRAIN",
  BUS: "BUS",
  VISA: "VISA",
  FOREX: "FOREX",
  STATIONERY: "STATIONERY",
  OTHER: "OTHER",
};
export function categoryOfServiceType(mode: any): CstepExpenseCategory {
  return SERVICE_TYPE_CATEGORY[String(mode)] || "OTHER";
}

/** A Local Travel Claim travel line's mode. Own vehicle is its own category
 * (mileage), not folded into Other the way the settlement mode is. */
const CLAIM_TRAVEL_MODE_CATEGORY: Record<string, CstepExpenseCategory> = {
  CAB: "CAB",
  LOCAL_TAXI: "CAB",
  METRO: "TRAIN",
  BUS: "BUS",
  OWN_VEHICLE: "OWN_VEHICLE",
};
export function categoryOfClaimTravelMode(mode: any): CstepExpenseCategory {
  return CLAIM_TRAVEL_MODE_CATEGORY[String(mode)] || "OTHER";
}

/** An Expense Claim line: its picked head, or EXPENSE_LINE when it has none. */
export function categoryOfExpenseLine(line: any): CstepExpenseCategory {
  return isExpenseLineHead(line?.category) ? line.category : "EXPENSE_LINE";
}
