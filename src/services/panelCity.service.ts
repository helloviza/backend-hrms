// apps/backend/src/services/panelCity.service.ts
//
// Resolves "the user's city" for Pluto's right panel ("For you in <city>" /
// "Get inspired"). Investigated 2026-08-06: of the 15 CUSTOMER-role users in
// prod, 0 had User.address.city set and only 2 resolved via
// CustomerWorkspace.address.city — a 13% hit rate. Most recent booking
// destination resolves 4 more (27% on its own, no overlap with the other
// two), so it goes first: for a travel assistant, where the user is GOING
// beats where they live, and it's the biggest single source besides.
//
// Resolution order:
//   1. Most recent TravelBooking.destinationCity (flight or hotel, whichever
//      is more recent — TravelBooking already mirrors both under one
//      collection with a shared bookedAt).
//   2. User.address.city
//   3. CustomerWorkspace.address.city
//   4. null — the caller must not render the two city-scoped sections, and
//      the frontend offers a one-time inline "Where are you based?" prompt
//      instead of guessing.

import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import TravelBooking from "../models/TravelBooking.js";
import { lookupDestination } from "../data/destinationLookup.js";

export type PanelCitySource = "booking" | "user" | "workspace" | null;

export interface PanelCityResult {
  city: string | null;
  source: PanelCitySource;
}

// How many of the user's most recent bookings to consider before giving up on
// this source. destinationCity is written from free-text hotel/flight data
// and isn't always clean (e.g. "Mumbai/Bombay,   Maharashtra" — the writer
// deliberately never discards an unrecognized value, see canonicalCity's own
// comment). Re-checking through the STRICT lookup (lookupDestination, which
// returns null instead of trusting unknown text) and falling through to the
// next-most-recent booking means a messy top row never becomes a broken
// section heading — it just quietly loses to an older, clean one.
const RECENT_BOOKINGS_TO_SCAN = 5;

async function resolveFromBooking(userId: string): Promise<string | null> {
  const bookings = await TravelBooking.find({
    userId,
    isDemo: { $ne: true },
    isActive: { $ne: false },
    status: { $ne: "CANCELLED" },
    destinationCity: { $ne: null },
  })
    .sort({ bookedAt: -1 })
    .limit(RECENT_BOOKINGS_TO_SCAN)
    .select("destinationCity")
    .lean();

  for (const b of bookings) {
    const hit = lookupDestination((b as any).destinationCity);
    if (hit?.city) return hit.city;
  }
  return null;
}

export async function resolvePanelCity(userId: string): Promise<PanelCityResult> {
  const bookingCity = await resolveFromBooking(userId);
  if (bookingCity) return { city: bookingCity, source: "booking" };

  const user = await User.findById(userId).select("address workspaceId").lean();
  const userCity = (user as any)?.address?.city?.trim();
  if (userCity) return { city: userCity, source: "user" };

  const workspaceId = (user as any)?.workspaceId;
  if (workspaceId) {
    const ws = await CustomerWorkspace.findById(workspaceId).select("address").lean();
    const wsCity = (ws as any)?.address?.city?.trim();
    if (wsCity) return { city: wsCity, source: "workspace" };
  }

  return { city: null, source: null };
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
