// apps/backend/src/services/panelCity.service.ts
//
// Resolves the person-scoped city for Pluto's right panel. The panel's FIRST
// tier — the current conversation's locked destination ("For your trip to
// <city>") — lives on the frontend, which already holds the locked bag; this
// service only answers the tiers below it.
//
// Resolution order (changed 2026-11-09):
//   1. User.address.city ("Where are you based?") — source "user", shown as
//      "For you in <city>".
//   2. The request IP's city (MaxMind via location.service), ONLY when the geo
//      DB genuinely looked it up (source "ip") and the city canonicalised
//      through the strict destinationLookup. Labelled "around you" — never
//      "For you in" as if it were home. Read-only: no ActorLocation row.
//   3. null — no city-scoped rail; the frontend offers the one-time inline
//      "Where are you based?" prompt instead of guessing.
//
// The response ALSO carries profileCity and currentCity separately: the
// panel's "Around you" section wants the IP city first and the profile city
// as its fallback (frontend panelRail.ts), which the single user-first
// `city` can't express.
//
// REMOVED, deliberately:
//   · Most recent TravelBooking.destinationCity. TravelBooking.userId is the
//     BOOKER/owner, not the traveller: ManualBooking mirrors set it to
//     doc.bookedBy (models/ManualBooking.ts, "NOT the displayed traveller"),
//     SBT hotels to the logged-in booker (routes/sbt.hotels.ts /bookings/save),
//     SBT flights to the booker or an L1 requester (routes/sbt.flights.ts
//     /bookings/save) whose request can name other passengers, and
//     ApprovalRequest rows to doc.frontlinerId (services/approvalProgress.ts).
//     A staff member who booked someone's Patna trip got "For you in Patna".
//     "The user's own past trips" needs a traveller = this-user link BY ID,
//     and no booking source persists one (SBT/manual passengers carry only
//     name/email — see models/TravellerTrip.ts's header). Matching by name or
//     email is ruled out, and booker = traveller is exactly the bug, so the
//     own-trips tier has NO eligible source today and is left out rather than
//     faked. Add it back only once a booking stores a traveller user id.
//   · CustomerWorkspace.address.city — that is the company's HQ, not where
//     the person is.

import User from "../models/User.js";
import { lookupDestination } from "../data/destinationLookup.js";
import { resolveCityFromIpBounded } from "./location.service.js";

export type PanelCitySource = "user" | "ip" | null;

/** The panel must never wait on geo: a cold instance's first lookup downloads
 * the database and simply times out here, falling through to null. */
const PANEL_IP_TIMEOUT_MS = 800;

export interface PanelCityResult {
  /** The single resolved city, order user → ip → null (unchanged). */
  city: string | null;
  source: PanelCitySource;
  /** User.address.city, independent of the IP. */
  profileCity: string | null;
  /** The genuinely-resolved IP city, independent of the profile — the
   * panel's "Around you" section prefers this over profileCity. */
  currentCity: string | null;
}

export async function resolvePanelCity(
  userId: string,
  opts: { ip?: string | null } = {},
): Promise<PanelCityResult> {
  const user = await User.findById(userId).select("address").lean();
  const profileCity = (user as any)?.address?.city?.trim() || null;

  // Looked up even when a profile city exists: "Around you" is about where
  // the device is now, which the profile can't answer. Bounded (800ms) and
  // local (MaxMind file), so it adds no external cost.
  let currentCity: string | null = null;
  if (opts.ip) {
    const loc = await resolveCityFromIpBounded(opts.ip, PANEL_IP_TIMEOUT_MS);
    if (loc.source === "ip" && loc.city) currentCity = loc.city;
  }

  if (profileCity) return { city: profileCity, source: "user", profileCity, currentCity };
  if (currentCity) return { city: currentCity, source: "ip", profileCity, currentCity };
  return { city: null, source: null, profileCity, currentCity };
}

/**
 * Writes a user-supplied city back to User.address.city (the inline "Where
 * are you based?" prompt). Soft-canonicalizes through the same known-city
 * table used for bookings when it recognizes the input (so "blr" saves as
 * "Bengaluru"), but — same rule as canonicalCity — trusts anything it
 * doesn't recognize rather than rejecting a real city that just isn't in a
 * small, India-travel-focused table.
 */
export async function setUserCity(userId: string, rawCity: string): Promise<string> {
  const trimmed = rawCity.trim().replace(/\s+/g, " ");
  const hit = lookupDestination(trimmed);
  const city = hit?.city || trimmed;
  await User.updateOne({ _id: userId }, { $set: { "address.city": city } });
  return city;
}
