// apps/backend/src/services/travellerAutoCapture.ts
//
// Phase 4 of Traveller Profiles — flights only. Called after a flight
// ticket has actually been issued (never on hold/book, never on a failed
// or abandoned attempt — see call sites in routes/sbt.flights.ts). Runs
// each booked passenger through the SAME dedup rule bulk import uses
// (utils/travellerMatch.ts) — no second implementation of "does this match
// an existing profile":
//   - Tier 1 (email) or Tier 2 (name + DOB, past the conflict guard) →
//     link to the existing profile and apply any changed fields.
//   - Anything weaker → create a new profile, source: "BOOKING_AUTOCAPTURE".
//
// "Left unmodified" detection: there is no client-side "was this selected
// from the typeahead" flag to trust — the frontend never marks a passenger
// as linked, and a spoofed/buggy flag would defeat the point. Instead this
// re-discovers the match independently and applies the same
// non-blank-only field rule bulk import uses (applyTravellerFields), then
// checks the Mongoose document's own dirty-tracking (doc.isModified()).
// Mongoose's schema-level setters (trim/lowercase) already run before that
// comparison, so re-submitting a value unchanged — including one that only
// differs by stray whitespace — never marks the document modified, and the
// write is skipped entirely. This also correctly handles a passenger typed
// fresh (never touched the typeahead) whose details happen to already
// match a stored profile exactly: same outcome, no write, no special case
// needed for "was it selected."
//
// Never lets a capture failure affect the booking: this is only ever
// called after the ticket response has already been sent to the client
// (see the res.json wrapper pattern at each sbt.flights.ts call site), and
// every passenger is captured inside its own try/catch so one bad row
// can't stop the rest.
import TravellerProfile from "../models/TravellerProfile.js";
import { findMatchingTraveller, applyTravellerFields, type TravellerFieldCandidate } from "../utils/travellerMatch.js";
import { mintTravellerProfileId } from "../utils/travelerId.js";
import { sbtLogger } from "../utils/logger.js";

export interface BookingPassengerForCapture {
  Title?: string;
  FirstName?: string;
  LastName?: string;
  DateOfBirth?: string; // TBO ISO, e.g. "1990-01-01T00:00:00"
  Gender?: number; // 1 male, 2 female (SBTPassengers.tsx / SBTReview.tsx convention)
  Nationality?: string;
  PassportNo?: string;
  PassportExpiry?: string;
  PassportIssueCountryCode?: string;
  PassportIssueDate?: string;
  ContactNo?: string;
  Email?: string;
}

// TBO dates arrive as "YYYY-MM-DDT00:00:00" — keep only the date part, per
// the plain-date-string convention already used for TravellerProfile
// (never a Date/datetime — see the timezone-shift history noted on the
// schema).
function tboDateOnly(v?: string): string | undefined {
  if (!v) return undefined;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undefined;
}

function toCandidate(p: BookingPassengerForCapture): TravellerFieldCandidate & { _firstName: string; _lastName: string } {
  return {
    _firstName: String(p.FirstName || "").trim(),
    _lastName: String(p.LastName || "").trim(),
    title: p.Title,
    firstName: p.FirstName,
    lastName: p.LastName,
    gender: p.Gender === 2 ? "Female" : p.Gender === 1 ? "Male" : undefined,
    dob: tboDateOnly(p.DateOfBirth),
    nationality: p.Nationality,
    passportNo: p.PassportNo,
    passportExpiry: tboDateOnly(p.PassportExpiry),
    passportIssueCountry: p.PassportIssueCountryCode,
    passportIssueDate: tboDateOnly(p.PassportIssueDate),
    mobile: p.ContactNo,
    email: p.Email,
  };
}

export async function autoCaptureTravellersFromBooking(params: {
  workspaceId: any;
  customerId: any;
  createdBy: string;
  passengers: BookingPassengerForCapture[] | undefined | null;
}): Promise<void> {
  const { workspaceId, customerId, createdBy, passengers } = params;
  if (!workspaceId || !Array.isArray(passengers) || !passengers.length) return;

  for (const raw of passengers) {
    try {
      const candidate = toCandidate(raw);
      if (!candidate._firstName || !candidate._lastName) continue; // shouldn't happen — form requires these

      const match = await findMatchingTraveller(workspaceId, {
        email: candidate.email,
        firstName: candidate._firstName,
        lastName: candidate._lastName,
        dob: candidate.dob,
        nationality: candidate.nationality,
        passportIssueCountry: candidate.passportIssueCountry,
      });

      if (match) {
        const doc: any = match.profile;
        applyTravellerFields(doc, candidate);
        if (doc.isModified()) {
          await doc.save();
          sbtLogger.info("[auto-capture] updated traveller profile", { travelerId: doc.travelerId, tier: match.tier });
        }
        // else: matched (whether selected from the typeahead or typed
        // fresh) with no field actually different — nothing to write.
        continue;
      }

      const travelerId = await mintTravellerProfileId(workspaceId, customerId);
      const created: any = await TravellerProfile.create({
        workspaceId,
        travelerId,
        title: candidate.title || undefined,
        firstName: candidate._firstName,
        lastName: candidate._lastName,
        gender: candidate.gender || undefined,
        dob: candidate.dob || undefined,
        nationality: candidate.nationality || undefined,
        passportNo: candidate.passportNo || undefined,
        passportExpiry: candidate.passportExpiry || undefined,
        passportIssueCountry: candidate.passportIssueCountry || undefined,
        passportIssueDate: candidate.passportIssueDate || undefined,
        mobile: candidate.mobile || undefined,
        email: candidate.email || undefined,
        frequentFlyer: [],
        createdBy,
        source: "BOOKING_AUTOCAPTURE",
      });
      sbtLogger.info("[auto-capture] created traveller profile", { travelerId: created.travelerId });
    } catch (err: any) {
      // One bad passenger must never stop capture for the rest of the
      // booking, and must never be allowed to matter to the caller — the
      // ticket has already been issued and responded to the client by the
      // time this function is even invoked (see sbt.flights.ts).
      sbtLogger.warn("[auto-capture] failed for one passenger — skipping", { error: err?.message });
    }
  }
}
