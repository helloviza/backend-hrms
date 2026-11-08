// panelCity — the IP city is the LAST tier, after the three existing ones.
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  bookings: vi.fn(),
  user: vi.fn(),
  workspace: vi.fn(),
  ip: vi.fn(),
}));

const chain = (fn: any) => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: fn }) }) }) });
vi.mock("../models/TravelBooking.js", () => ({ default: { find: () => chain(H.bookings) } }));
vi.mock("../models/User.js", () => ({ default: { findById: () => ({ select: () => ({ lean: H.user }) }) } }));
vi.mock("../models/CustomerWorkspace.js", () => ({ default: { findById: () => ({ select: () => ({ lean: H.workspace }) }) } }));
vi.mock("./location.service.js", () => ({ resolveCityFromIpBounded: H.ip }));

import { resolvePanelCity } from "./panelCity.service.js";

const ipLoc = (over: Record<string, any>) => ({
  city: null, rawCity: null, region: null, country: null, source: "unresolved", confidence: 0, accuracyRadiusKm: null, reason: "x", ...over,
});

beforeEach(() => {
  Object.values(H).forEach((m) => m.mockReset());
  H.bookings.mockResolvedValue([]);
  H.user.mockResolvedValue({ address: {}, workspaceId: null });
  H.workspace.mockResolvedValue(null);
  H.ip.mockResolvedValue(ipLoc({}));
});

describe("resolvePanelCity — tier order unchanged, IP last", () => {
  it("booking destination still wins and the IP is never looked up", async () => {
    H.bookings.mockResolvedValue([{ destinationCity: "Dubai" }]);
    expect(await resolvePanelCity("u1", { ip: "49.43.246.108" })).toEqual({ city: "Dubai", source: "booking" });
    expect(H.ip).not.toHaveBeenCalled();
  });

  it("User.address.city beats the IP", async () => {
    H.user.mockResolvedValue({ address: { city: "Pune" } });
    expect(await resolvePanelCity("u1", { ip: "49.43.246.108" })).toEqual({ city: "Pune", source: "user" });
    expect(H.ip).not.toHaveBeenCalled();
  });

  it("nothing else → IP city, labelled source 'ip'", async () => {
    H.ip.mockResolvedValue(ipLoc({ city: "Bengaluru", rawCity: "Bengaluru", source: "ip", reason: "ok" }));
    expect(await resolvePanelCity("u1", { ip: "49.43.246.108" })).toEqual({ city: "Bengaluru", source: "ip" });
    expect(H.ip).toHaveBeenCalledWith("49.43.246.108", 800);
  });

  it("IP not genuinely resolved (no MaxMind DB / private / not in strict table) → null", async () => {
    for (const loc of [
      ipLoc({ reason: "geo_db_unavailable" }),
      ipLoc({ source: "private-ip", reason: "loopback" }),
      ipLoc({ source: "ip", rawCity: "Thane", reason: "city_not_in_lookup" }),
    ]) {
      H.ip.mockResolvedValue(loc);
      expect(await resolvePanelCity("u1", { ip: "1.2.3.4" })).toEqual({ city: null, source: null });
    }
  });

  it("no ip passed → behaves exactly as before", async () => {
    expect(await resolvePanelCity("u1")).toEqual({ city: null, source: null });
    expect(H.ip).not.toHaveBeenCalled();
  });
});
