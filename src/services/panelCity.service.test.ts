// panelCity — person-scoped tiers only: User.address.city, then the IP city
// (plus both returned separately for the panel's "Around you" section).
// Bookings (TravelBooking.userId is the BOOKER, not the traveller) and the
// company address (HQ, not the person) are never consulted.
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  bookingFind: vi.fn(),
  workspaceFind: vi.fn(),
  user: vi.fn(),
  ip: vi.fn(),
}));

vi.mock("../models/TravelBooking.js", () => ({ default: { find: H.bookingFind } }));
vi.mock("../models/CustomerWorkspace.js", () => ({ default: { findById: H.workspaceFind } }));
vi.mock("../models/User.js", () => ({ default: { findById: () => ({ select: () => ({ lean: H.user }) }) } }));
vi.mock("./location.service.js", () => ({ resolveCityFromIpBounded: H.ip }));

import { resolvePanelCity } from "./panelCity.service.js";

const ipLoc = (over: Record<string, any>) => ({
  city: null, rawCity: null, region: null, country: null, source: "unresolved", confidence: 0, accuracyRadiusKm: null, reason: "x", ...over,
});
const IP = "203.0.113.7"; // TEST-NET-3, documentation range

beforeEach(() => {
  Object.values(H).forEach((m) => m.mockReset());
  // A staff booker's mirror row for someone else's Patna trip, and an HQ
  // address — both present, both must be ignored.
  H.bookingFind.mockImplementation(() => {
    throw new Error("TravelBooking must not be read for the panel city");
  });
  H.workspaceFind.mockImplementation(() => {
    throw new Error("CustomerWorkspace must not be read for the panel city");
  });
  H.user.mockResolvedValue({ address: {}, workspaceId: "ws1" });
  H.ip.mockResolvedValue(ipLoc({}));
});

const none = { city: null, source: null, profileCity: null, currentCity: null };
const bengaluru = () => ipLoc({ city: "Bengaluru", rawCity: "Bengaluru", source: "ip", reason: "ok" });

describe("resolvePanelCity", () => {
  it("profile city → source 'user'; the IP city is still returned separately", async () => {
    H.user.mockResolvedValue({ address: { city: "Pune" }, workspaceId: "ws1" });
    H.ip.mockResolvedValue(bengaluru());
    expect(await resolvePanelCity("u1", { ip: IP })).toEqual({
      city: "Pune", source: "user", profileCity: "Pune", currentCity: "Bengaluru",
    });
    expect(H.ip).toHaveBeenCalledWith(IP, 800);
  });

  it("no profile city → genuinely-resolved IP city, source 'ip'", async () => {
    H.ip.mockResolvedValue(bengaluru());
    expect(await resolvePanelCity("u1", { ip: IP })).toEqual({
      city: "Bengaluru", source: "ip", profileCity: null, currentCity: "Bengaluru",
    });
  });

  it("profile city, IP unresolved → currentCity null (section 1 falls back to the profile)", async () => {
    H.user.mockResolvedValue({ address: { city: "Pune" } });
    expect(await resolvePanelCity("u1", { ip: IP })).toEqual({
      city: "Pune", source: "user", profileCity: "Pune", currentCity: null,
    });
  });

  it("booker ≠ traveller: a booking the user made (for anyone) never becomes their city", async () => {
    // Staff booker with no profile city and no IP: before 2026-11-09 the most
    // recent mirror row (userId = booker) produced "For you in Patna".
    expect(await resolvePanelCity("u1")).toEqual(none);
    expect(H.bookingFind).not.toHaveBeenCalled();
  });

  it("company address is not a person-scoped source", async () => {
    expect(await resolvePanelCity("u1", { ip: IP })).toEqual(none);
    expect(H.workspaceFind).not.toHaveBeenCalled();
  });

  it("IP not genuinely resolved (no MaxMind DB / private / not in strict table) → null", async () => {
    for (const loc of [
      ipLoc({ reason: "geo_db_unavailable" }),
      ipLoc({ source: "private-ip", reason: "loopback" }),
      ipLoc({ source: "ip", rawCity: "Thane", reason: "city_not_in_lookup" }),
    ]) {
      H.ip.mockResolvedValue(loc);
      expect(await resolvePanelCity("u1", { ip: IP })).toEqual(none);
    }
  });

  it("blank / whitespace profile city falls through; no ip → no lookup", async () => {
    H.user.mockResolvedValue({ address: { city: "   " } });
    expect(await resolvePanelCity("u1")).toEqual(none);
    expect(H.ip).not.toHaveBeenCalled();
  });
});
