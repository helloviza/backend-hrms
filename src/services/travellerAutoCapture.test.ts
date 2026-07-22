// Auto-capture is only as trustworthy as its "did anything actually
// change" decision — these tests exercise the real applyTravellerFields
// dirty-tracking path (not mocked) against a fake Mongoose-like document,
// and mock only findMatchingTraveller (already covered by
// travellerMatch.test.ts) and the TravellerProfile/travelerId minting
// side effects.
import { describe, it, expect, vi, beforeEach } from "vitest";

const findMatchingTravellerMock = vi.fn();
vi.mock("../utils/travellerMatch.js", async () => {
  const actual = await vi.importActual<typeof import("../utils/travellerMatch.js")>("../utils/travellerMatch.js");
  return { ...actual, findMatchingTraveller: (...args: any[]) => findMatchingTravellerMock(...args) };
});

const tpCreateMock = vi.fn();
vi.mock("../models/TravellerProfile.js", () => ({
  default: { create: (...args: any[]) => tpCreateMock(...args) },
}));

const mintMock = vi.fn();
vi.mock("../utils/travelerId.js", () => ({
  mintTravellerProfileId: (...args: any[]) => mintMock(...args),
}));

import { autoCaptureTravellersFromBooking, type BookingPassengerForCapture } from "./travellerAutoCapture.js";

const WS = "workspace0000000000000001";
const CUSTOMER = "customer0000000000000001";
const UID = "user0000000000000000001";

// Minimal fake Mongoose document — mirrors real dirty-tracking: a setter
// only marks a path modified if the assigned value actually differs.
function fakeDoc(initial: Record<string, any>) {
  const modified = new Set<string>();
  const values: Record<string, any> = { ...initial };
  const doc: any = {
    save: vi.fn().mockResolvedValue(undefined),
    isModified: () => modified.size > 0,
  };
  for (const key of Object.keys(initial)) {
    Object.defineProperty(doc, key, {
      get: () => values[key],
      set: (v: any) => { if (v !== values[key]) { modified.add(key); values[key] = v; } },
      enumerable: true,
    });
  }
  // Fields not present on `initial` still need get/set (e.g. a brand-new
  // optional field being populated for the first time).
  for (const key of ["title", "firstName", "middleName", "lastName", "gender", "dob", "nationality", "passportNo", "passportExpiry", "passportIssueCountry", "passportIssueDate", "mobile", "email"]) {
    if (key in initial) continue;
    Object.defineProperty(doc, key, {
      get: () => values[key],
      set: (v: any) => { if (v !== values[key]) { modified.add(key); values[key] = v; } },
      enumerable: true,
    });
  }
  return doc;
}

function passenger(over: Partial<BookingPassengerForCapture> = {}): BookingPassengerForCapture {
  return {
    Title: "Mr", FirstName: "Priya", LastName: "Sharma",
    DateOfBirth: "1990-01-01T00:00:00", Gender: 2, Nationality: "IN",
    PassportNo: "M1234567", PassportExpiry: "2030-01-01T00:00:00",
    PassportIssueCountryCode: "IN", PassportIssueDate: "2020-01-01T00:00:00",
    ContactNo: "9999999999", Email: "priya@acme.com",
    ...over,
  };
}

beforeEach(() => {
  findMatchingTravellerMock.mockReset().mockResolvedValue(null);
  tpCreateMock.mockReset().mockImplementation((doc: any) => Promise.resolve({ _id: "new-id", travelerId: "ACME-001", ...doc }));
  mintMock.mockReset().mockResolvedValue("ACME-001");
});

describe("autoCaptureTravellersFromBooking", () => {
  it("no-ops on an empty/missing passenger list", async () => {
    await autoCaptureTravellersFromBooking({ workspaceId: WS, customerId: CUSTOMER, createdBy: UID, passengers: [] });
    await autoCaptureTravellersFromBooking({ workspaceId: WS, customerId: CUSTOMER, createdBy: UID, passengers: null });
    expect(findMatchingTravellerMock).not.toHaveBeenCalled();
    expect(tpCreateMock).not.toHaveBeenCalled();
  });

  it("creates a new profile with source BOOKING_AUTOCAPTURE when nothing matches", async () => {
    await autoCaptureTravellersFromBooking({
      workspaceId: WS, customerId: CUSTOMER, createdBy: UID, passengers: [passenger()],
    });

    expect(tpCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS, source: "BOOKING_AUTOCAPTURE", createdBy: UID,
      firstName: "Priya", lastName: "Sharma", dob: "1990-01-01", // TBO ISO stripped to date-only
      passportExpiry: "2030-01-01", passportIssueDate: "2020-01-01",
    }));
  });

  it("converts TBO's numeric Gender (1/2) into Male/Female for storage", async () => {
    await autoCaptureTravellersFromBooking({
      workspaceId: WS, customerId: CUSTOMER, createdBy: UID,
      passengers: [passenger({ Gender: 1 }), passenger({ Gender: 2, Email: "other@acme.com" })],
    });

    expect(tpCreateMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ gender: "Male" }));
    expect(tpCreateMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ gender: "Female" }));
  });

  it("links to a matched profile and updates it when a field actually changed", async () => {
    const doc = fakeDoc({ firstName: "Priya", lastName: "Sharma", passportExpiry: "2025-01-01" }); // stale expiry
    findMatchingTravellerMock.mockResolvedValue({ profile: doc, tier: 1 });

    await autoCaptureTravellersFromBooking({
      workspaceId: WS, customerId: CUSTOMER, createdBy: UID, passengers: [passenger()], // fresh expiry 2030-01-01
    });

    expect(doc.save).toHaveBeenCalled();
    expect(doc.passportExpiry).toBe("2030-01-01");
    expect(tpCreateMock).not.toHaveBeenCalled();
  });

  it("does NOT write when the matched profile's data is identical to the booking passenger (selected, unmodified)", async () => {
    const doc = fakeDoc({
      title: "Mr", firstName: "Priya", lastName: "Sharma", gender: "Female", dob: "1990-01-01", nationality: "IN",
      passportNo: "M1234567", passportExpiry: "2030-01-01", passportIssueCountry: "IN", passportIssueDate: "2020-01-01",
      mobile: "9999999999", email: "priya@acme.com",
    });
    findMatchingTravellerMock.mockResolvedValue({ profile: doc, tier: 1 });

    await autoCaptureTravellersFromBooking({
      workspaceId: WS, customerId: CUSTOMER, createdBy: UID, passengers: [passenger()],
    });

    expect(doc.save).not.toHaveBeenCalled();
  });

  it("stray whitespace alone does not trigger a write", async () => {
    const doc = fakeDoc({ firstName: "Priya", lastName: "Sharma" });
    findMatchingTravellerMock.mockResolvedValue({ profile: doc, tier: 1 });

    await autoCaptureTravellersFromBooking({
      workspaceId: WS, customerId: CUSTOMER, createdBy: UID,
      passengers: [passenger({ FirstName: "  Priya  ", LastName: " Sharma", Email: undefined, PassportNo: undefined, PassportExpiry: undefined, PassportIssueDate: undefined, Nationality: undefined, PassportIssueCountryCode: undefined, ContactNo: undefined, DateOfBirth: undefined, Gender: undefined, Title: undefined })],
    });

    expect(doc.save).not.toHaveBeenCalled();
  });

  it("one passenger's failure does not stop capture for the rest of the booking", async () => {
    findMatchingTravellerMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(null);

    await autoCaptureTravellersFromBooking({
      workspaceId: WS, customerId: CUSTOMER, createdBy: UID,
      passengers: [passenger({ Email: "a@acme.com" }), passenger({ FirstName: "Amit", LastName: "Verma", Email: "b@acme.com" })],
    });

    expect(tpCreateMock).toHaveBeenCalledTimes(1); // second passenger still captured
    expect(tpCreateMock).toHaveBeenCalledWith(expect.objectContaining({ firstName: "Amit" }));
  });

  it("skips a malformed passenger with no first/last name rather than throwing", async () => {
    await autoCaptureTravellersFromBooking({
      workspaceId: WS, customerId: CUSTOMER, createdBy: UID,
      passengers: [passenger({ FirstName: "", LastName: "" })],
    });
    expect(findMatchingTravellerMock).not.toHaveBeenCalled();
    expect(tpCreateMock).not.toHaveBeenCalled();
  });
});
