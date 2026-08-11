// apps/backend/src/models/TravellerTrip.ts
//
// TRAVEL HISTORY — Tab 5 (2026-08-11). One row per trip this person says
// they took, entered BY HAND.
//
// MANUAL ONLY, AND THAT IS THE DESIGN, not a stopgap for a missing join.
// infra/design/traveller-profile-tabs-2026-08-11.md §6 established that no
// persisted booking↔traveller link exists: TravelBooking has destination
// fields but no travellerProfileId, SBTBooking/SBTHotelBooking carry no
// traveller reference at all, and SBTPassengers' `linkedTravelerId` is
// client-only React state that reaches no model. The tempting fix — match
// bookings to travellers by NAME — is explicitly ruled out, and the reason
// is what this file exists to hold on to:
//
//   A consular travel history is a document a government reads as this
//   person's own statement of where they have been. A name-similarity join
//   that puts a colleague's trip in it is not a display bug; it is a false
//   declaration made in somebody else's name.
//
// So every row here was typed by a human who was there, and the surface
// says "N trips recorded" — never "N trips", which would imply the list is
// complete. It never is; nothing in this system observes travel.
//
// WHY ITS OWN COLLECTION rather than a travelHistory sub-doc on
// TravellerProfile (which §6 sketched): a profile is read whole on hot
// paths (the SBT passenger typeahead, the visa "confirm your details"
// step, every dossier load) and a frequent traveller's log grows without
// bound; each row also needs its own createdBy/updatedBy, since "who
// entered this" is part of what makes the entry honest. Same shape as
// VisaHolding, which ships alongside it, so one access gate serves both.
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

/**
 * Why the person travelled. A fixed vocabulary — unlike VisaHolding's
 * free-text visaType, purpose IS a settled concept across missions, and the
 * value is aggregatable (a leader asking "how much of our travel is
 * conference travel" wants buckets, not prose).
 *
 * Deliberately NOT VisaRule's VISA_PURPOSES: that set exists to select a
 * visa PRODUCT and carries "TOURIST_OR_BUSINESS", a commercial category
 * that is meaningless as a statement about a trip somebody actually took.
 */
export const TRIP_PURPOSES = [
  "BUSINESS",
  "TOURIST",
  "CONFERENCE",
  "FAMILY",
  "MEDICAL",
  "STUDY",
  "TRANSIT",
  "OTHER",
] as const;
export type TripPurpose = (typeof TRIP_PURPOSES)[number];

/**
 * How precisely the traveller remembers the dates — and it is stored,
 * rather than inferred from which fields happen to be filled, because the
 * two states must render differently:
 *
 *   EXACT — startDate and endDate are real days. A duration can be counted
 *           from them, and it is a fact.
 *   MONTH — the person remembers "March 2019" and nothing finer, which is
 *           what a five-year-old trip usually is and what consular forms
 *           actually ask for. NO duration is shown, because inventing one
 *           from a month would put a made-up number of days into a record a
 *           government reads.
 */
export const TRIP_DATE_PRECISIONS = ["EXACT", "MONTH"] as const;
export type TripDatePrecision = (typeof TRIP_DATE_PRECISIONS)[number];

export interface TravellerTripDocument extends Document {
  workspaceId: mongoose.Types.ObjectId; // CustomerWorkspace._id, via workspaceScopePlugin
  travellerProfileId: mongoose.Types.ObjectId; // ref TravellerProfile

  /** ISO 3166-1 alpha-2, resolved through utils/countryCodes.ts on write. */
  countryIso2: string;
  /** Display name at write time — see VisaHolding.countryName. */
  countryName: string;

  purpose: TripPurpose;

  datePrecision: TripDatePrecision;
  /** EXACT only. "YYYY-MM-DD", string never Date. */
  startDate?: string;
  /** EXACT only. */
  endDate?: string;
  /** MONTH only. "YYYY-MM". */
  tripMonth?: string;

  /**
   * The visa this trip was taken on, as the traveller states it — free
   * text, and deliberately NOT a reference to a VisaHolding row.
   *
   * A reference would be a claim we cannot support: most trips in this log
   * predate the platform, their visa is long expired and was never
   * recorded, and offering a picker of current holdings would quietly
   * encourage attaching whichever visa happens to still be on file to a
   * trip it had nothing to do with. "Schengen C, single entry" typed by the
   * person who used it is worth more than a wrong link.
   */
  visaType?: string;

  notes?: string;

  createdBy: mongoose.Types.ObjectId; // ref User
  updatedBy?: mongoose.Types.ObjectId; // ref User

  // Soft delete, matching VisaHolding and TravellerDocument.
  deletedAt?: Date | null;
  deletedBy?: mongoose.Types.ObjectId; // ref User

  createdAt?: Date;
  updatedAt?: Date;
}

const TravellerTripSchema = new Schema<TravellerTripDocument>(
  {
    travellerProfileId: {
      type: Schema.Types.ObjectId,
      ref: "TravellerProfile",
      required: true,
      index: true,
    },

    countryIso2: { type: String, required: true, uppercase: true, trim: true },
    countryName: { type: String, required: true, trim: true },

    purpose: { type: String, enum: TRIP_PURPOSES, required: true },

    datePrecision: { type: String, enum: TRIP_DATE_PRECISIONS, required: true },
    startDate: { type: String },
    endDate: { type: String },
    tripMonth: { type: String },

    visaType: { type: String, trim: true },
    notes: { type: String, trim: true },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

TravellerTripSchema.plugin(workspaceScopePlugin);

// The log's own listing, newest trip first.
TravellerTripSchema.index({ workspaceId: 1, travellerProfileId: 1, deletedAt: 1 });
// "Who has been to X" — the same cross-traveller shape VisaHolding serves,
// and the index a future dated-Schengen-history feature would need.
TravellerTripSchema.index({ workspaceId: 1, countryIso2: 1, deletedAt: 1 });

const TravellerTrip: Model<TravellerTripDocument> =
  mongoose.models.TravellerTrip ||
  mongoose.model<TravellerTripDocument>("TravellerTrip", TravellerTripSchema);

export default TravellerTrip;

/**
 * Nights-inclusive duration in days, or null.
 *
 * NULL IS A REAL ANSWER and every caller renders it as "duration not
 * recorded" rather than 0 or "—" with a number nearby. It is returned for
 * every MONTH-precision trip (a month is not a duration) and for any EXACT
 * trip missing an end date, because the alternative is printing a day count
 * nobody stated on a form a consulate reads.
 *
 * Counts both endpoints: a trip out on the 1st and back on the 3rd is 3
 * days, which is how a visa application counts days of stay.
 */
export function deriveTripDurationDays(trip: {
  datePrecision?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}): number | null {
  if (trip?.datePrecision !== "EXACT") return null;
  const start = String(trip?.startDate ?? "").trim();
  const end = String(trip?.endDate ?? "").trim();
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  if (!ISO.test(start) || !ISO.test(end)) return null;
  // Parsed as UTC midnights (the "YYYY-MM-DD" form is spec'd as UTC), so
  // the subtraction is a whole number of days with no DST or offset drift.
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  if (endMs < startMs) return null; // an end before its start states nothing
  return Math.round((endMs - startMs) / 86_400_000) + 1;
}
