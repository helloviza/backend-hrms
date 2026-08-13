// apps/backend/src/services/visaHolding.service.ts
//
// The two things anything outside the wallet needs from VisaHolding:
//
//   syncVisaHoldingFromApplication  — turn an ISSUED visa application into
//                                     a holding (the AUTO half of Tab 3);
//   resolveVisaWalletSummary        — the counts the wallet tab and the
//                                     dossier header both render.
//
// Kept out of the routes because BOTH callers are in different files
// (routes/admin.visa.ts records the outcome; routes/workspace.travellers.ts
// renders the wallet) and the honesty rules below are rules about what may
// be CLAIMED — they belong in one place, not copied into each surface.
//
// ── WHAT COUNTS AS "ISSUED" ──────────────────────────────────────────────
// VisaApplication.outcome, enum ["APPROVED", "REJECTED", "WITHDRAWN"].
// APPROVED is the only value that means a visa exists; there is no separate
// ISSUED/GRANTED state anywhere in the model or its routes. The single
// writer is PATCH /admin/visa/applications/:id/outcome, which on APPROVED
// already requires visaNumber, visaIssuedAt and visaExpiresAt (it 400s
// without them) — so every field this sync needs is guaranteed present by
// the time it runs, and no branch here has to invent one.
import mongoose from "mongoose";
import VisaHolding, {
  deriveVisaHoldingStatus,
  isSchengenIso2,
  istToday,
  type VisaHoldingStatus,
} from "../models/VisaHolding.js";
import VisaRule from "../models/VisaRule.js";
import { normaliseToIso2, getCountryByIso2 } from "../utils/countryCodes.js";
import logger from "../utils/logger.js";

const holdingLogger = logger.child({ module: "visa-holding" });

export type VisaHoldingSyncResult =
  | { action: "created"; holdingId: string }
  | { action: "updated"; holdingId: string }
  | { action: "not_issued"; holdingId: null }
  | { action: "skipped_no_traveller"; holdingId: null }
  | { action: "skipped_unresolved_country"; holdingId: null; detail: string };

/**
 * The destination as an ISO2 code, or null.
 *
 * VisaApplication.ruleSnapshot deliberately does NOT carry destinationIso2
 * — it holds destinationName and isSchengen but not the code — so this
 * reads it back off the VisaRule the snapshot was captured from.
 * destinationIso2 is part of that rule's identity key
 * ({nationality, destinationIso2, purpose, entryType, serviceTier}), so
 * reading it live is not the retro-application problem the snapshot exists
 * to prevent: a rule whose destination changed would be a different rule.
 *
 * The fallback resolves the snapshot's own destinationName through the
 * country table, for the case where the rule row is gone. If BOTH fail we
 * return null and the caller refuses to write a holding at all — a visa
 * filed under a country we could not identify would sit in the wallet
 * unfilterable, uncountable in "N countries", and invisible to the Schengen
 * grouping, which is worse than a logged skip a concierge can act on.
 */
async function resolveDestinationIso2(
  ruleSnapshot: any,
): Promise<{ iso2: string | null; via: "rule" | "name" | "none" }> {
  const ruleId = ruleSnapshot?.ruleId;
  if (ruleId && mongoose.isValidObjectId(ruleId)) {
    const rule: any = await VisaRule.findById(ruleId).select("destinationIso2").lean();
    const iso2 = normaliseToIso2(rule?.destinationIso2);
    if (iso2) return { iso2, via: "rule" };
  }
  const byName = normaliseToIso2(ruleSnapshot?.destinationName);
  if (byName) return { iso2: byName, via: "name" };
  return { iso2: null, via: "none" };
}

/**
 * The visa "type" for an AUTO holding, in words a traveller would use.
 *
 * TWO fields feed it and neither is the answer on its own. `purpose`
 * (TOURIST / BUSINESS / TRANSIT) is what a person means by the type of
 * visa they hold; `visaCategory` (STICKER / STAMP / E_VISA / VOA /
 * VISA_FREE) is the FORM it takes, which is worth saying because a sticker
 * in a passport and an e-visa in an inbox are different things to go
 * looking for. So: "Tourist (e-visa)".
 *
 * They are humanised rather than passed through raw, because this lands in
 * the SAME free-text field a person types into by hand — a wallet listing
 * "B1/B2" beside "SHORT_STAY" reads as a bug, and the raw token is our
 * internal vocabulary rather than anything printed on their visa. Stored
 * humanised (not humanised at render) so the one field means one thing
 * wherever it is read, including a CSV export.
 *
 * Returns undefined rather than a placeholder when the snapshot carries
 * neither — an absent type renders as "No visa type recorded", which is
 * true, where "Unknown" would look like a value.
 */
const VISA_PURPOSE_LABELS: Record<string, string> = {
  TOURIST: "Tourist",
  BUSINESS: "Business",
  TOURIST_OR_BUSINESS: "Tourist or business",
  TRANSIT: "Transit",
};

const VISA_CATEGORY_LABELS: Record<string, string> = {
  STICKER: "sticker",
  STAMP: "stamp",
  E_VISA: "e-visa",
  VOA: "visa on arrival",
  VISA_FREE: "visa-free",
};

export function describeVisaType(ruleSnapshot: any): string | undefined {
  const purposeRaw = String(ruleSnapshot?.purpose ?? "").toUpperCase();
  const categoryRaw = String(ruleSnapshot?.visaCategory ?? "").toUpperCase();

  const purpose = VISA_PURPOSE_LABELS[purposeRaw];
  const category = VISA_CATEGORY_LABELS[categoryRaw];

  if (purpose && category) return `${purpose} (${category})`;
  if (purpose) return purpose;
  if (category) return category.charAt(0).toUpperCase() + category.slice(1);
  // An unrecognised token is dropped, not echoed: a raw enum in a
  // user-facing field is worse than an honest blank, and this runs on a
  // vocabulary we own — an unmapped value means the vocabulary changed and
  // this map needs the new entry.
  return undefined;
}

/**
 * Create or refresh the AUTO holding for an application that reached
 * APPROVED. Safe to call on any outcome — a non-APPROVED one returns
 * "not_issued" and writes nothing, so the caller does not need its own
 * branch and a later REJECTED/WITHDRAWN can never mint a visa.
 *
 * IDEMPOTENT BY THE DATABASE, not by a pre-read: the upsert keys on
 * {workspaceId, sourceApplicationId}, which carries a unique index. Two
 * concurrent outcome recordings converge on one holding rather than two
 * visas for one decision.
 *
 * RE-RECORDING UPDATES, it does not append. A concierge correcting a
 * mistyped visa number is fixing the same visa; a second row would leave
 * the wallet asserting the person holds two.
 *
 * Never throws at the caller: the outcome itself is already saved by the
 * time this runs, and a wallet write failing must not fail the decision or
 * leave it half-recorded. Same best-effort posture as the billing sync that
 * already runs beside it in that route.
 */
export async function syncVisaHoldingFromApplication(
  application: any,
  actorUserId: any,
): Promise<VisaHoldingSyncResult> {
  if (application?.outcome !== "APPROVED") {
    return { action: "not_issued", holdingId: null };
  }
  // Erased travellers keep their case skeleton but lose the applicant
  // reference (VisaApplication.travellerErasedAt). There is nobody to hold
  // the visa, so there is nothing to write.
  if (!application?.travellerProfileId) {
    return { action: "skipped_no_traveller", holdingId: null };
  }

  const { iso2, via } = await resolveDestinationIso2(application?.ruleSnapshot);
  if (!iso2) {
    const detail = `Could not resolve an ISO2 country for "${application?.ruleSnapshot?.destinationName ?? ""}"`;
    holdingLogger.warn("visa holding sync skipped — unresolved destination", {
      applicationId: String(application?._id ?? ""),
      destinationName: application?.ruleSnapshot?.destinationName ?? null,
    });
    return { action: "skipped_unresolved_country", holdingId: null, detail };
  }

  const country = getCountryByIso2(iso2);

  // ISO date strings, taken from the Dates the outcome route validated.
  // toISOString().slice(0,10) is UTC — correct here because these were
  // parsed from a caller-supplied date with no time component, so the UTC
  // day IS the day that was entered.
  const asIsoDate = (v: any): string | undefined => {
    if (!v) return undefined;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
  };

  const set: Record<string, any> = {
    travellerProfileId: application.travellerProfileId,
    countryIso2: iso2,
    countryName: country?.name || application?.ruleSnapshot?.destinationName || iso2,
    visaType: describeVisaType(application?.ruleSnapshot),
    entryType: application?.ruleSnapshot?.entryType || undefined,
    visaNumber: application?.visaNumber || undefined,
    issueDate: asIsoDate(application?.visaIssuedAt),
    expiryDate: asIsoDate(application?.visaExpiresAt),
    source: "AUTO",
    updatedBy: actorUserId || undefined,
    // A holding that was soft-deleted and whose issuing application is then
    // re-recorded comes back: the application says the visa exists, and
    // that outranks an earlier removal.
    deletedAt: null,
    deletedBy: null,
  };
  for (const k of Object.keys(set)) if (set[k] === undefined) delete set[k];

  try {
    const existing = await VisaHolding.findOne({
      workspaceId: application.workspaceId,
      sourceApplicationId: application._id,
    })
      .select("_id")
      .lean();

    const doc: any = await VisaHolding.findOneAndUpdate(
      { workspaceId: application.workspaceId, sourceApplicationId: application._id },
      {
        $set: set,
        $setOnInsert: {
          workspaceId: application.workspaceId,
          sourceApplicationId: application._id,
          createdBy: actorUserId,
        },
      },
      { new: true, upsert: true },
    );

    holdingLogger.info("visa holding synced from application", {
      applicationId: String(application._id),
      holdingId: String(doc?._id ?? ""),
      countryIso2: iso2,
      resolvedVia: via,
      action: existing ? "updated" : "created",
    });

    return existing
      ? { action: "updated", holdingId: String(doc._id) }
      : { action: "created", holdingId: String(doc._id) };
  } catch (err: any) {
    // A concurrent upsert losing the unique-index race is not a failure —
    // the other call created exactly the row this one wanted.
    if (err?.code === 11000) {
      const winner: any = await VisaHolding.findOne({
        workspaceId: application.workspaceId,
        sourceApplicationId: application._id,
      })
        .select("_id")
        .lean();
      if (winner) return { action: "updated", holdingId: String(winner._id) };
    }
    throw err;
  }
}

/* ── The read side ──────────────────────────────────────────────────── */

export interface VisaWalletRow {
  _id: string;
  countryIso2: string;
  countryName: string;
  visaType: string | null;
  visaNumber: string | null;
  entryType: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  status: VisaHoldingStatus;
  source: "AUTO" | "MANUAL";
  sourceApplicationId: string | null;
  isSchengen: boolean;
  /**
   * AUTO rows are read-only wherever they appear — they restate a decision
   * recorded against a real application, and editing them here would leave
   * the wallet and the case disagreeing with no record of it. Sent as a
   * per-row flag rather than left to the client to infer from `source`, so
   * a disabled control and a refused write can never disagree about why.
   */
  editable: boolean;
  stampDocId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface VisaWalletSummary {
  /** Rows on file. THE denominator for every other number here. */
  recorded: number;
  /**
   * Active/expired/unknown counts — meaningful only because `recorded` is
   * beside them. Zero active out of three recorded is a real fact; zero
   * active out of zero recorded is not, and `activeVisas` below is what
   * keeps the two apart.
   */
  active: number;
  expired: number;
  unknownExpiry: number;
  /** distinct(countryIso2) over recorded rows — §7.3's "N countries". */
  countries: number;
  /**
   * THE HEADER FIGURE, and the one place the honest-empty rule bites.
   *
   * null when NOTHING is recorded, because the truthful answer there is
   * "we don't know what this person holds" — not 0, which asserts they hold
   * no visa. Once even one holding exists we know something, and 0 active
   * out of 2 recorded is then a real, defensible zero.
   */
  activeVisas: number | null;
  /** Rendered verbatim wherever activeVisas is null. */
  activeVisasReason: string | null;
}

export function summariseVisaWallet(rows: VisaWalletRow[]): VisaWalletSummary {
  const recorded = rows.length;
  const active = rows.filter((r) => r.status === "ACTIVE").length;
  const expired = rows.filter((r) => r.status === "EXPIRED").length;
  const unknownExpiry = rows.filter((r) => r.status === "UNKNOWN").length;
  const countries = new Set(rows.map((r) => r.countryIso2)).size;

  return {
    recorded,
    active,
    expired,
    unknownExpiry,
    countries,
    activeVisas: recorded === 0 ? null : active,
    activeVisasReason: recorded === 0 ? "No visas recorded yet" : null,
  };
}

export function mapVisaHoldingRow(h: any, today: string = istToday()): VisaWalletRow {
  return {
    _id: String(h._id),
    countryIso2: h.countryIso2,
    countryName: h.countryName,
    visaType: h.visaType ?? null,
    visaNumber: h.visaNumber ?? null,
    entryType: h.entryType ?? null,
    issueDate: h.issueDate ?? null,
    expiryDate: h.expiryDate ?? null,
    status: deriveVisaHoldingStatus(h.expiryDate, today),
    source: h.source,
    sourceApplicationId: h.sourceApplicationId ? String(h.sourceApplicationId) : null,
    isSchengen: isSchengenIso2(h.countryIso2),
    editable: h.source === "MANUAL",
    stampDocId: h.stampDocId ? String(h.stampDocId) : null,
    createdAt: h.createdAt ?? null,
    updatedAt: h.updatedAt ?? null,
  };
}

/**
 * Every live holding for one traveller, newest expiry first, plus the
 * counts. The dossier header calls this for `activeVisas` alone; the wallet
 * tab renders the rows. One function so the tab and the header can never
 * show different numbers for the same person.
 */
export async function resolveVisaWallet(
  travellerProfileId: any,
  workspaceId: any,
): Promise<{ rows: VisaWalletRow[]; summary: VisaWalletSummary }> {
  const docs: any[] = await VisaHolding.find({
    workspaceId,
    travellerProfileId,
    deletedAt: null,
  })
    .sort({ expiryDate: -1, createdAt: -1 })
    .lean();

  const today = istToday();
  const rows = docs.map((d) => mapVisaHoldingRow(d, today));
  return { rows, summary: summariseVisaWallet(rows) };
}

/**
 * THE SCHENGEN BLOCK — a GROUPING, never a calculation.
 *
 * §7.4 is the hardest rule in the design and this is where it is enforced:
 * a 90/180 allowance is a function of ENTRY AND EXIT DATES, which holdings
 * do not carry and v1 deliberately does not add. Knowing somebody holds a
 * Schengen visa says nothing whatever about how many of their 90 days are
 * left.
 *
 * So this returns the Schengen holdings and a reason, and there is
 * deliberately NO field here for a client to render a number from: no
 * daysUsed, no daysRemaining, no percentage, no window. A wrong figure
 * here can put a real person in overstay — a consular and immigration
 * consequence, not a UI blemish — so an honest empty is categorically
 * better than a plausible number, and the payload does not contain the
 * ingredients for one.
 */
export function resolveSchengenBlock(rows: VisaWalletRow[]): {
  holdings: VisaWalletRow[];
  trackerAvailable: false;
  trackerReason: string;
} {
  return {
    holdings: rows.filter((r) => r.isSchengen),
    trackerAvailable: false,
    trackerReason:
      "A 90/180 allowance is counted from entry and exit dates, which aren't recorded anywhere yet — holding a Schengen visa doesn't tell us how many days you have left.",
  };
}
