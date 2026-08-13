// apps/backend/src/models/VisaHolding.ts
//
// A VISA THIS PERSON ACTUALLY HOLDS — Tab 3, the Digital Visa Wallet
// (2026-08-11). The deferred "holdings model" the audit kept naming, built
// as Option B of infra/design/traveller-profile-tabs-2026-08-11.md §8: its
// own workspace-scoped collection rather than a sub-document array on
// TravellerProfile.
//
// WHY A COLLECTION, not `TravellerProfile.visas[]` (the doc's Option A):
//   - four surfaces need a CROSS-TRAVELLER query ("who in this workspace
//     holds a valid Schengen visa"), which a sub-doc array serves by
//     scanning every profile;
//   - each row carries sourceApplicationId, so a visa issued THROUGH the
//     platform populates itself from the outcome that issued it instead of
//     asking someone to retype what we already hold;
//   - both options start empty today, so now is the cheapest possible
//     moment to pick the real shape. Option A would mean migrating real
//     customer-entered visa records later.
//
// A HOLDING IS NOT AN APPLICATION. Nothing in this collection is derived
// from an application's existence, its status, or its progress — only from
// an outcome of APPROVED, which is the one value in
// VISA_APPLICATION_OUTCOMES that means a visa was issued. Counting
// applications as visas held is the specific mistake §7.3 exists to
// prevent, and this model is what makes it unnecessary.
//
// STATUS IS DERIVED, NEVER STORED. active/expired is a fact about today
// versus expiryDate, and a stored copy would be wrong the morning after it
// was written. deriveVisaHoldingStatus() below is the single derivation,
// and it has a THIRD state — a holding with no expiry on file is UNKNOWN,
// never "active": asserting somebody holds a currently-valid visa on the
// strength of a blank field is exactly the fabricated certainty this tab is
// built to avoid.
//
// NO ENTRY/EXIT STAMPS IN v1, deliberately. That is the Schengen 90/180
// prerequisite (§7.4) and it deserves its own decision once there is reason
// to believe travellers will enter them. Holdings alone cannot support a
// day counter, and this model must not be mistaken for one that can.
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";
import { VISA_ENTRY_TYPES, type VisaEntryType } from "./VisaRule.js";
import { getCountryByIso2 } from "../utils/countryCodes.js";

/**
 * Where the row came from, and therefore what may be done to it.
 *
 *   AUTO   — created from a VisaApplication that reached outcome APPROVED.
 *            READ-ONLY in every UI: the fields restate a real decision
 *            recorded by a concierge, and letting someone edit them here
 *            would produce a "visa" that no longer matches the application
 *            that issued it, with no record of the divergence.
 *   MANUAL — typed in by a traveller or an admin, for the visas obtained
 *            before/outside this platform. Editable, and never presented as
 *            anything but user-entered.
 */
export const VISA_HOLDING_SOURCES = ["AUTO", "MANUAL"] as const;
export type VisaHoldingSource = (typeof VISA_HOLDING_SOURCES)[number];

/** Derived from expiryDate against today — see deriveVisaHoldingStatus. */
export const VISA_HOLDING_STATUSES = ["ACTIVE", "EXPIRED", "UNKNOWN"] as const;
export type VisaHoldingStatus = (typeof VISA_HOLDING_STATUSES)[number];

export interface VisaHoldingDocument extends Document {
  workspaceId: mongoose.Types.ObjectId; // CustomerWorkspace._id, via workspaceScopePlugin
  travellerProfileId: mongoose.Types.ObjectId; // ref TravellerProfile

  /**
   * ISO 3166-1 alpha-2, resolved through utils/countryCodes.ts before it is
   * written — never a free-text country name. It is the key everything else
   * on this tab keys off: the Schengen grouping, the "N countries" count,
   * and any future "who holds a visa for X" query.
   */
  countryIso2: string;
  /**
   * The display name AT THE TIME OF WRITING, denormalised on purpose so a
   * row stays readable if the country table is later renamed — the same
   * reason ruleSnapshot exists on VisaApplication. countryIso2 remains the
   * key; this is only ever shown.
   */
  countryName: string;

  /**
   * Free text — "Tourist", "Schengen C", "B1/B2", "Work permit". A visa
   * "type" has no cross-border vocabulary: every mission names its own
   * categories, and an enum here would reject correct values printed on
   * real documents. VisaRule.visaCategory is NOT reused for the same
   * reason it is not reused on manual entry — it is our commercial product
   * taxonomy, not what the sticker says.
   */
  visaType?: string;
  visaNumber?: string;
  entryType?: VisaEntryType;

  issueDate?: string; // "YYYY-MM-DD" — string, never Date (timezone-shift history)
  expiryDate?: string; // "YYYY-MM-DD"

  source: VisaHoldingSource;
  /**
   * Set ONLY on an AUTO row, and it is what makes the auto-population
   * idempotent: the sync upserts on {workspaceId, sourceApplicationId}, so
   * re-recording an outcome updates the existing holding instead of minting
   * a second visa for the same decision.
   */
  sourceApplicationId?: mongoose.Types.ObjectId | null; // ref VisaApplication

  /**
   * The scanned/stamped copy — DECLARED, NOT YET CAPTURABLE (2026-08-11).
   *
   * The design's answer was a TravellerDocument with a VISA_STAMP kind, and
   * that collection is the right home. What does not fit yet is its
   * uniqueness index, {travellerProfileId, docKind, version}: one profile
   * holding two visas would file both stamps as versions of a single
   * VISA_STAMP "document", which is that index's word for "a replacement",
   * and the latest-per-kind listing would then hide the first visa's stamp
   * behind the second's. Expressing one stamp per HOLDING means adding the
   * holding id to that unique index — a live-collection index change, which
   * is its own migration and is outside this slice.
   *
   * So the pointer is declared (the shape is settled and the design is
   * recorded) and nothing writes it. The wallet says stamp copies are not
   * captured here yet rather than offering an upload that has nowhere
   * correct to land.
   */
  stampDocId?: mongoose.Types.ObjectId | null; // ref TravellerDocument

  createdBy: mongoose.Types.ObjectId; // ref User
  updatedBy?: mongoose.Types.ObjectId; // ref User

  // Soft delete only, matching TravellerDocument. A removed holding is a
  // claim someone withdrew about a real travel document; keeping the row
  // costs nothing and losing it silently rewrites the wallet's history.
  deletedAt?: Date | null;
  deletedBy?: mongoose.Types.ObjectId; // ref User

  createdAt?: Date;
  updatedAt?: Date;
}

const VisaHoldingSchema = new Schema<VisaHoldingDocument>(
  {
    travellerProfileId: {
      type: Schema.Types.ObjectId,
      ref: "TravellerProfile",
      required: true,
      index: true,
    },

    countryIso2: { type: String, required: true, uppercase: true, trim: true },
    countryName: { type: String, required: true, trim: true },

    visaType: { type: String, trim: true },
    visaNumber: { type: String, trim: true },
    entryType: { type: String, enum: VISA_ENTRY_TYPES },

    issueDate: { type: String },
    expiryDate: { type: String },

    source: { type: String, enum: VISA_HOLDING_SOURCES, required: true },
    sourceApplicationId: {
      type: Schema.Types.ObjectId,
      ref: "VisaApplication",
      default: null,
    },

    stampDocId: { type: Schema.Types.ObjectId, ref: "TravellerDocument", default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

VisaHoldingSchema.plugin(workspaceScopePlugin);

// The wallet's own listing.
VisaHoldingSchema.index({ workspaceId: 1, travellerProfileId: 1, deletedAt: 1 });
// One holding per issuing application — the idempotency guarantee the auto
// sync leans on, enforced by the DB rather than by the service remembering
// to check first. partialFilterExpression keeps MANUAL rows (which carry a
// null sourceApplicationId, all of them) out of the constraint entirely;
// without it the second manual holding in a workspace would collide.
VisaHoldingSchema.index(
  { workspaceId: 1, sourceApplicationId: 1 },
  { unique: true, partialFilterExpression: { sourceApplicationId: { $type: "objectId" } } },
);
// "Who in this workspace holds a visa for X" — the cross-traveller query
// that a sub-document array could not have served (see the file header).
VisaHoldingSchema.index({ workspaceId: 1, countryIso2: 1, deletedAt: 1 });

const VisaHolding: Model<VisaHoldingDocument> =
  mongoose.models.VisaHolding ||
  mongoose.model<VisaHoldingDocument>("VisaHolding", VisaHoldingSchema);

export default VisaHolding;

/**
 * Today in IST as "YYYY-MM-DD", the same en-CA/Asia-Kolkata form the cron
 * jobs and billing schedule already use.
 *
 * Deliberately not UTC: an India-based traveller reading "expired" on the
 * morning of the day their visa is still valid — or "active" on the day
 * after it lapsed — is a five-and-a-half-hour lie in the one direction that
 * matters at an immigration desk.
 */
export function istToday(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/**
 * THE ONE STATUS DERIVATION. Every surface calls this rather than comparing
 * dates itself, so the wallet, the header count and any future dashboard
 * can never disagree about whether a visa is live.
 *
 * UNKNOWN is not a failure state and is not "assume expired" — it is the
 * truthful answer when no expiry was recorded, and the UI renders it as
 * "no expiry on file" rather than folding it into either count. A holding
 * with no expiry is real evidence the person holds a visa; it is simply not
 * evidence about today.
 *
 * String comparison on "YYYY-MM-DD" is a correct chronological comparison
 * and needs no Date parsing (which is where the timezone shifts come from).
 */
export function deriveVisaHoldingStatus(
  expiryDate: string | null | undefined,
  today: string = istToday(),
): VisaHoldingStatus {
  const expiry = String(expiryDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return "UNKNOWN";
  // Expiring TODAY counts as active — a visa is valid through its expiry
  // date, not up to the morning of it.
  return expiry >= today ? "ACTIVE" : "EXPIRED";
}

/**
 * Whether this holding is for a Schengen state.
 *
 * Derived at READ time from the country table's own SCHENGEN region rather
 * than stored per row, so a correction to that table (an accession, a
 * mistake) propagates instead of leaving old rows asserting the old answer.
 * An unmapped ISO2 is NOT Schengen — declining to classify is the honest
 * output, and the Schengen section lists only what we can actually place.
 *
 * This says nothing about days remaining and cannot: see §7.4 and the file
 * header. It is a grouping, not a calculation.
 */
export function isSchengenIso2(iso2: string | null | undefined): boolean {
  const entry = getCountryByIso2(iso2);
  return entry?.region === "SCHENGEN";
}
