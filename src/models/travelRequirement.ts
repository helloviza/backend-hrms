// apps/backend/src/models/travelRequirement.ts
//
// The Travel Requirement sub-document (gap analysis §5, decision (b):
// EMBEDDED and PROMOTABLE). One schema shared by Lead (intake snapshot,
// captured once) and Opportunity (working copy). Deliberately NOT its own
// collection — nothing in Phase 1 needs a requirement to exist apart from the
// opportunity it belongs to. Promote to `travelrequirements` only when one
// must be shared across opportunities, versioned independently of quotes, or
// handed to Operations before a booking exists.
//
// Service vocabulary = TravelBooking.service (via models/crmTaxonomy.ts) so a
// requirement, an opportunity's service mix and a booking share one word per
// service. Service LINES (qty / est. amount) live on Opportunity only — line
// pricing belongs to the Quote, and a lead-grain intake never has it.
//
// No PII beyond what a sales rep types into a requirement (risk D8: no
// passport, DOB or traveller identity here — travellers are TravellerProfile
// rows linked by association).

import { Schema } from "mongoose";
import { TRAVEL_SERVICES, URGENCY_LEVELS, type TravelService, type UrgencyLevel } from "./crmTaxonomy.js";

export interface TravelRequirement {
  serviceMix: TravelService[];
  travelDate?: Date | null;
  travelDateEnd?: Date | null;
  origin: string;
  destination: string;
  /** ISO-2 when known ("" otherwise) — same resolver lineage as
   *  TravelBooking.destinationCountry. */
  destinationCountry: string;
  travellerCount?: number | null;
  urgency?: UrgencyLevel | null;
  notes: string;
}

export const TravelRequirementSchema = new Schema<TravelRequirement>(
  {
    serviceMix: { type: [{ type: String, enum: TRAVEL_SERVICES }], default: [] },
    travelDate: { type: Date, default: null },
    travelDateEnd: { type: Date, default: null },
    origin: { type: String, trim: true, default: "" },
    destination: { type: String, trim: true, default: "" },
    destinationCountry: { type: String, trim: true, uppercase: true, default: "" },
    travellerCount: { type: Number, min: 0, default: null },
    urgency: { type: String, enum: [...URGENCY_LEVELS, null], default: null },
    notes: { type: String, default: "" },
  },
  { _id: false },
);

/** True when a requirement carries anything a human typed. Used so an empty
 *  default sub-doc is never mistaken for a captured requirement. */
export function hasTravelRequirement(r: Partial<TravelRequirement> | null | undefined): boolean {
  if (!r) return false;
  return !!(
    (r.serviceMix && r.serviceMix.length) ||
    r.travelDate ||
    r.travelDateEnd ||
    (r.origin && r.origin.trim()) ||
    (r.destination && r.destination.trim()) ||
    (r.destinationCountry && r.destinationCountry.trim()) ||
    (r.travellerCount != null && r.travellerCount > 0) ||
    r.urgency ||
    (r.notes && r.notes.trim())
  );
}
