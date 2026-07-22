import { describe, it, expect, vi, beforeEach } from "vitest";

const findOneMock = vi.fn();
const findMock = vi.fn();
vi.mock("../models/TravellerProfile.js", () => ({
  default: {
    findOne: (...args: any[]) => ({ exec: () => findOneMock(...args) }),
    find: (...args: any[]) => ({ exec: () => findMock(...args) }),
  },
}));

import { findMatchingTraveller, normalizeName, normalizeEmail, applyTravellerFields } from "./travellerMatch.js";

const WS = "workspace0000000000000001";

beforeEach(() => {
  findOneMock.mockReset().mockResolvedValue(null);
  findMock.mockReset().mockResolvedValue([]);
});

describe("normalizeName / normalizeEmail", () => {
  it("lowercases, trims, and collapses internal whitespace", () => {
    expect(normalizeName("  Priya   Sharma ")).toBe("priya sharma");
    expect(normalizeName("PRIYA")).toBe("priya");
  });

  it("normalizeEmail lowercases and trims only", () => {
    expect(normalizeEmail("  Priya@ACME.com ")).toBe("priya@acme.com");
  });
});

describe("findMatchingTraveller — Tier 1 (email)", () => {
  it("matches on exact normalized email, case/whitespace-insensitive", async () => {
    const existing = { _id: "p1", firstName: "Priya", lastName: "Sharma", email: "priya@acme.com" };
    findOneMock.mockResolvedValueOnce(existing);

    const result = await findMatchingTraveller(WS, { email: "  Priya@ACME.com " });

    expect(result).toEqual({ profile: existing, tier: 1 });
    expect(findOneMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, email: "priya@acme.com", isActive: true }),
    );
    // Tier 1 short-circuits — never falls through to the name+DOB query.
    expect(findMock).not.toHaveBeenCalled();
  });

  it("no email on candidate — skips Tier 1 entirely", async () => {
    await findMatchingTraveller(WS, { firstName: "Priya", lastName: "Sharma" }); // no dob either -> null
    expect(findOneMock).not.toHaveBeenCalled();
  });
});

describe("findMatchingTraveller — Tier 2 (name + DOB)", () => {
  it("matches on exact normalized name tuple + exact DOB when email doesn't match", async () => {
    const existing = { _id: "p2", firstName: "Priya", lastName: "Sharma", dob: "1990-01-01", nationality: "Indian" };
    findMock.mockResolvedValueOnce([existing]);

    const result = await findMatchingTraveller(WS, {
      firstName: "  PRIYA ", lastName: "Sharma", dob: "1990-01-01", nationality: "Indian",
    });

    expect(result).toEqual({ profile: existing, tier: 2 });
    expect(findMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, dob: "1990-01-01", isActive: true }),
    );
  });

  it("does NOT match when DOB is missing on the candidate — refuses to guess on name alone", async () => {
    const result = await findMatchingTraveller(WS, { firstName: "Priya", lastName: "Sharma" });
    expect(result).toBeNull();
    expect(findMock).not.toHaveBeenCalled();
  });

  it("two different people, same name, no DOB on either side — never merges, always null", async () => {
    // No DOB supplied at all — Tier 2 requires firstName+lastName+dob, so this
    // never even queries; every such booking would create a new profile.
    const result = await findMatchingTraveller(WS, { firstName: "John", lastName: "Smith" });
    expect(result).toBeNull();
  });

  it("same DOB but different name — no match", async () => {
    findMock.mockResolvedValueOnce([{ _id: "p3", firstName: "Amit", lastName: "Verma", dob: "1990-01-01" }]);
    const result = await findMatchingTraveller(WS, { firstName: "Priya", lastName: "Sharma", dob: "1990-01-01" });
    expect(result).toBeNull();
  });
});

describe("findMatchingTraveller — Tier 2 conflict guard", () => {
  it("refuses to link when nationality conflicts, even with identical name+DOB", async () => {
    const existing = { _id: "p4", firstName: "Priya", lastName: "Sharma", dob: "1990-01-01", nationality: "Indian" };
    findMock.mockResolvedValueOnce([existing]);

    const result = await findMatchingTraveller(WS, {
      firstName: "Priya", lastName: "Sharma", dob: "1990-01-01", nationality: "British",
    });

    expect(result).toBeNull();
  });

  it("refuses to link when passport issue country conflicts", async () => {
    const existing = {
      _id: "p5", firstName: "Priya", lastName: "Sharma", dob: "1990-01-01",
      passportIssueCountry: "India",
    };
    findMock.mockResolvedValueOnce([existing]);

    const result = await findMatchingTraveller(WS, {
      firstName: "Priya", lastName: "Sharma", dob: "1990-01-01", passportIssueCountry: "United Kingdom",
    });

    expect(result).toBeNull();
  });

  it("links when the only populated field agrees (no conflict signal on the other)", async () => {
    const existing = { _id: "p6", firstName: "Priya", lastName: "Sharma", dob: "1990-01-01", nationality: "Indian" };
    findMock.mockResolvedValueOnce([existing]);

    // Candidate has no nationality/passportIssueCountry at all — nothing to conflict with.
    const result = await findMatchingTraveller(WS, { firstName: "Priya", lastName: "Sharma", dob: "1990-01-01" });

    expect(result).toEqual({ profile: existing, tier: 2 });
  });
});

describe("applyTravellerFields", () => {
  it("overwrites a field the candidate provides", () => {
    const doc: any = { mobile: "9999999999" };
    applyTravellerFields(doc, { mobile: "8888888888" });
    expect(doc.mobile).toBe("8888888888");
  });

  it("never clears an existing field when the candidate's value is blank/absent", () => {
    const doc: any = { nationality: "Indian", passportNo: "M1234567" };
    applyTravellerFields(doc, { nationality: "", passportNo: undefined });
    expect(doc.nationality).toBe("Indian");
    expect(doc.passportNo).toBe("M1234567");
  });

  it("trims whitespace before assigning", () => {
    const doc: any = {};
    applyTravellerFields(doc, { firstName: "  Priya  " });
    expect(doc.firstName).toBe("Priya");
  });

  it("reassigning the same value (mirroring a Mongoose doc) leaves it unmodified — proves the isModified() pattern works", () => {
    // Simulates Mongoose's own setter behavior: only mark a path dirty if the
    // new value actually differs after any schema-level transform.
    const modified = new Set<string>();
    const doc: any = {
      _values: { firstName: "Priya", mobile: "9999999999" },
      get firstName() { return this._values.firstName; },
      set firstName(v) { if (v !== this._values.firstName) { modified.add("firstName"); this._values.firstName = v; } },
      get mobile() { return this._values.mobile; },
      set mobile(v) { if (v !== this._values.mobile) { modified.add("mobile"); this._values.mobile = v; } },
      isModified: () => modified.size > 0,
    };

    applyTravellerFields(doc, { firstName: " Priya ", mobile: "9999999999" }); // same after trim
    expect(doc.isModified()).toBe(false);

    applyTravellerFields(doc, { mobile: "8888888888" }); // genuinely different
    expect(doc.isModified()).toBe(true);
  });
});
