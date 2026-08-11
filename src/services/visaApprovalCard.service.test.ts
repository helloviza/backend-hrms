// Unit coverage for the approvals-card evidence block — the rules an
// approver's decision now rests on. Pure functions, no database, no route:
// every signal here is a derivation over documents that were already loaded,
// which is exactly why it lives in a service and not inline in routes/visa.ts.
//
// The route-level half (the payload actually shipping masked, the full number
// being absent from the wire) is asserted in routes/visa.approval.test.ts
// against the in-memory collection harness — a masking rule proved only in a
// unit test is a masking rule nobody has watched cross the wire.
import { describe, it, expect } from "vitest";
import {
  buildVisaApprovalCard,
  parseVisaDateOnly,
  resolveFiledFor,
  resolvePassportValidity,
  resolveRosterStatus,
  summariseConsent,
  summariseDocuments,
  type VisaApprovalCardContext,
} from "./visaApprovalCard.service.js";
import { VISA_CONSENT_CLAUSE_IDS } from "../config/visaConsent.js";

const NOW = new Date("2026-08-11T00:00:00.000Z");

/* ═══════════════════════════════════════════════════════════════════════
 * Dates — the substrate every other signal sits on.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("parseVisaDateOnly", () => {
  it("reads the 'YYYY-MM-DD' strings TravellerProfile actually stores", () => {
    expect(parseVisaDateOnly("2031-06-30")?.toISOString()).toBe("2031-06-30T00:00:00.000Z");
  });

  it("reads the real Dates VisaRequest.travelDateTo stores, flattening the time", () => {
    expect(parseVisaDateOnly(new Date("2026-09-25T18:42:11.000Z"))?.toISOString()).toBe(
      "2026-09-25T00:00:00.000Z",
    );
  });

  it("returns null for junk rather than an Invalid Date", () => {
    // The point: an unparseable stored value must degrade to UNKNOWN (an
    // honest gap), never compare as NaN and silently report VALID.
    expect(parseVisaDateOnly("not-a-date")).toBeNull();
    expect(parseVisaDateOnly("")).toBeNull();
    expect(parseVisaDateOnly(null)).toBeNull();
    expect(parseVisaDateOnly(undefined)).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Passport validity.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("resolvePassportValidity", () => {
  const travel = { travelDateFrom: new Date("2026-09-15"), travelDateTo: new Date("2026-09-25") };

  it("VALID when the passport outlasts the trip", () => {
    expect(resolvePassportValidity({ passportExpiry: "2031-06-30", ...travel, now: NOW })).toBe("VALID");
  });

  it("VALID when it expires exactly ON the last day — valid THROUGH the expiry date", () => {
    expect(resolvePassportValidity({ passportExpiry: "2026-09-25", ...travel, now: NOW })).toBe("VALID");
  });

  it("EXPIRES_BEFORE_TRAVEL when it lapses mid-trip", () => {
    expect(resolvePassportValidity({ passportExpiry: "2026-09-20", ...travel, now: NOW })).toBe(
      "EXPIRES_BEFORE_TRAVEL",
    );
  });

  it("EXPIRED beats EXPIRES_BEFORE_TRAVEL — already lapsed is the stronger fact", () => {
    expect(resolvePassportValidity({ passportExpiry: "2026-01-01", ...travel, now: NOW })).toBe("EXPIRED");
  });

  it("falls back to travelDateFrom when the request has no end date", () => {
    expect(
      resolvePassportValidity({
        passportExpiry: "2026-09-10",
        travelDateFrom: new Date("2026-09-15"),
        now: NOW,
      }),
    ).toBe("EXPIRES_BEFORE_TRAVEL");
  });

  it("with no travel dates at all, only 'has it already expired' is answerable", () => {
    expect(resolvePassportValidity({ passportExpiry: "2026-09-10", now: NOW })).toBe("VALID");
    expect(resolvePassportValidity({ passportExpiry: "2020-09-10", now: NOW })).toBe("EXPIRED");
  });

  it("UNKNOWN — not VALID — when no expiry is on file", () => {
    expect(resolvePassportValidity({ passportExpiry: null, ...travel, now: NOW })).toBe("UNKNOWN");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Roster status — the infosec signal.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("resolveRosterStatus", () => {
  const USER = "64b000000000000000000001";
  const known = new Set([USER]);

  it("MEMBER via a claim that still resolves to a live account", () => {
    expect(resolveRosterStatus({ claimedBy: USER }, known)).toEqual({
      rosterStatus: "MEMBER",
      rosterBasis: "CLAIMED_LOGIN",
    });
  });

  it("MEMBER via an admin-written roster link, with no claim at all", () => {
    expect(resolveRosterStatus({ linkedMemberId: "m1" }, known)).toEqual({
      rosterStatus: "MEMBER",
      rosterBasis: "ROSTER_LINK",
    });
  });

  it("OFF_ROSTER when the profile exists and carries NEITHER link", () => {
    expect(resolveRosterStatus({ firstName: "Kavya" }, known)).toEqual({
      rosterStatus: "OFF_ROSTER",
      rosterBasis: "NO_LINK",
    });
  });

  it("UNKNOWN — never MEMBER — for a claim pointing at a deleted account", () => {
    // A non-null pointer is not a resolved link. Reporting MEMBER here would
    // be exactly the fabricated 'verified' state this module refuses.
    expect(resolveRosterStatus({ claimedBy: "64b0000000000000000000ff" }, known)).toEqual({
      rosterStatus: "UNKNOWN",
      rosterBasis: "CLAIM_UNRESOLVED",
    });
  });

  it("a dangling claim still reports MEMBER when a roster link backs it up", () => {
    expect(
      resolveRosterStatus({ claimedBy: "64b0000000000000000000ff", linkedMemberId: "m1" }, known),
    ).toEqual({ rosterStatus: "MEMBER", rosterBasis: "ROSTER_LINK" });
  });

  it("UNKNOWN when there is no traveller record to look at", () => {
    expect(resolveRosterStatus(null, known)).toEqual({
      rosterStatus: "UNKNOWN",
      rosterBasis: "NO_PROFILE",
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Requestor vs traveller.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("resolveFiledFor", () => {
  it("SELF when every traveller is the requestor", () => {
    expect(resolveFiledFor([{ isRequestor: true, hasResolvedClaim: true }])).toBe("SELF");
  });

  it("SELF_AND_OTHERS when the requestor travels alongside colleagues", () => {
    expect(
      resolveFiledFor([
        { isRequestor: true, hasResolvedClaim: true },
        { isRequestor: false, hasResolvedClaim: false },
      ]),
    ).toBe("SELF_AND_OTHERS");
  });

  it("ON_BEHALF only with positive proof — a traveller claimed by somebody else", () => {
    expect(resolveFiledFor([{ isRequestor: false, hasResolvedClaim: true }])).toBe("ON_BEHALF");
  });

  it("UNKNOWN, not ON_BEHALF, when no traveller resolves to any login", () => {
    // An unclaimed traveller may BE the requestor under a profile they never
    // claimed. Nothing here can tell, so nothing here claims to.
    expect(resolveFiledFor([{ isRequestor: false, hasResolvedClaim: false }])).toBe("UNKNOWN");
  });

  it("UNKNOWN for a request with no travellers", () => {
    expect(resolveFiledFor([])).toBe("UNKNOWN");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Documents + consent.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("summariseDocuments", () => {
  it("counts every upload but reports DISTINCT codes, catalogue-named", () => {
    const summary = summariseDocuments([
      { docCode: "DOC-01" },
      { docCode: "DOC-01" }, // a re-upload — a second file, the same requirement
      { docCode: "DOC-02" },
    ]);
    expect(summary.count).toBe(3);
    expect(summary.docCodes).toEqual(["DOC-01", "DOC-02"]);
    expect(summary.docNames).toHaveLength(2);
    expect(summary.docNames[0]).toBeTruthy();
  });

  it("names an unrecognised code as itself rather than dropping it", () => {
    expect(summariseDocuments([{ docCode: "NOT-A-REAL-CODE" }]).docNames).toEqual(["NOT-A-REAL-CODE"]);
  });

  it("empty is empty — never a placeholder", () => {
    expect(summariseDocuments([])).toEqual({ count: 0, docCodes: [], docNames: [] });
  });
});

describe("summariseConsent", () => {
  it("accepted only when EVERY clause is recorded", () => {
    const consents = VISA_CONSENT_CLAUSE_IDS.map((clauseId) => ({
      clauseId,
      version: "v1",
      acceptedAt: new Date("2026-08-01"),
    }));
    const summary = summariseConsent(consents);
    expect(summary.accepted).toBe(true);
    expect(summary.missingClauseIds).toEqual([]);
    expect(summary.version).toBe("v1");
  });

  it("names the missing clauses instead of a bare false", () => {
    const summary = summariseConsent([
      { clauseId: VISA_CONSENT_CLAUSE_IDS[0], version: "v1", acceptedAt: new Date() },
    ]);
    expect(summary.accepted).toBe(false);
    expect(summary.missingClauseIds).toEqual([...VISA_CONSENT_CLAUSE_IDS].slice(1));
  });

  it("an empty consents array is not accepted", () => {
    expect(summariseConsent([]).accepted).toBe(false);
    expect(summariseConsent(null).accepted).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The whole card.
 * ═══════════════════════════════════════════════════════════════════════ */
const REQUESTOR = "64b000000000000000000001";
const COLLEAGUE = "64b000000000000000000002";

const FULL_CONSENTS = VISA_CONSENT_CLAUSE_IDS.map((clauseId) => ({
  clauseId,
  version: "v1",
  acceptedAt: new Date("2026-08-01"),
  acceptedByUserId: REQUESTOR,
}));

function ctx(overrides: Partial<VisaApprovalCardContext> = {}): VisaApprovalCardContext {
  return {
    profilesById: new Map(),
    documentsByApplicationId: new Map(),
    knownUserIds: new Set([REQUESTOR, COLLEAGUE]),
    now: NOW,
    ...overrides,
  };
}

/** A complete traveller: passport, expiry beyond the trip, DOB, claimed. */
function goodProfile(overrides: Record<string, any> = {}) {
  return {
    _id: "p1",
    firstName: "Arjun",
    lastName: "Nair",
    dob: "1991-04-17",
    nationality: "IN",
    passportNo: "M8841203",
    passportExpiry: "2031-06-30",
    claimedBy: REQUESTOR,
    ...overrides,
  };
}

function requestDoc(overrides: Record<string, any> = {}) {
  return {
    _id: "r1",
    raisedByUserId: REQUESTOR,
    destinationIso2: "DE",
    purpose: "TOURIST",
    travelDateFrom: new Date("2026-09-15"),
    travelDateTo: new Date("2026-09-25"),
    consents: FULL_CONSENTS,
    ...overrides,
  };
}

function applicationDoc(overrides: Record<string, any> = {}) {
  return {
    _id: "a1",
    travellerProfileId: "p1",
    nationality: "IN",
    nationalityUnresolved: false,
    ruleSnapshot: { documentRequirements: [] },
    applicantProfile: {},
    linkedBookings: [],
    ...overrides,
  };
}

describe("buildVisaApprovalCard — the complete, self-filed request", () => {
  const card = buildVisaApprovalCard({
    request: requestDoc(),
    applications: [applicationDoc()],
    ctx: ctx({ profilesById: new Map([["p1", goodProfile()]]) }),
  });

  it("reads as a self-application", () => {
    expect(card.filedFor).toBe("SELF");
    expect(card.travellers[0].isRequestor).toBe(true);
  });

  it("reads as an on-roster traveller", () => {
    expect(card.travellers[0].rosterStatus).toBe("MEMBER");
    expect(card.offRosterCount).toBe(0);
  });

  it("is ready to file, with no gaps at all", () => {
    expect(card.completeness.ready).toBe(true);
    expect(card.completeness.gaps).toEqual([]);
  });

  it("NEVER carries the passport number — only the tail and a validity verdict", () => {
    const t = card.travellers[0];
    expect(t.passportOnFile).toBe(true);
    expect(t.passportValidity).toBe("VALID");
    expect(t.passportMasked).toBe("****1203");
    expect(t.passportMasked).not.toContain("M884");
    expect(JSON.stringify(card)).not.toContain("M8841203");
    expect(t).not.toHaveProperty("passportNo");
  });

  it("carries the decision subset and NOT the rest of the traveller record", () => {
    const t = card.travellers[0];
    expect(t.name).toBe("Arjun Nair");
    expect(t.dob).toBe("1991-04-17");
    expect(t.nationality).toBe("IN");
    // Contact details are not decision-relevant and are not on this payload.
    expect(t).not.toHaveProperty("email");
    expect(t).not.toHaveProperty("mobile");
    expect(t).not.toHaveProperty("claimedBy");
  });
});

describe("buildVisaApprovalCard — filed on behalf of a colleague", () => {
  const card = buildVisaApprovalCard({
    request: requestDoc(),
    applications: [applicationDoc({ _id: "a2", travellerProfileId: "p2" })],
    ctx: ctx({
      profilesById: new Map([
        [
          "p2",
          // Claimed by somebody else, so "not the requestor" is PROVEN.
          goodProfile({ _id: "p2", firstName: "Kavya", lastName: "Menon", claimedBy: COLLEAGUE }),
        ],
      ]),
    }),
  });

  it("labels the filing relationship as on-behalf", () => {
    expect(card.filedFor).toBe("ON_BEHALF");
    expect(card.travellers[0].isRequestor).toBe(false);
  });

  it("a colleague with a live login is still on the roster", () => {
    expect(card.travellers[0].rosterStatus).toBe("MEMBER");
    expect(card.offRosterCount).toBe(0);
  });
});

describe("buildVisaApprovalCard — an outsider on the company's account", () => {
  const card = buildVisaApprovalCard({
    request: requestDoc(),
    applications: [applicationDoc({ _id: "a3", travellerProfileId: "p3" })],
    ctx: ctx({
      // No claim, no roster link — nothing ties this person to the workspace.
      profilesById: new Map([
        ["p3", goodProfile({ _id: "p3", firstName: "Priya", lastName: "Sharma", claimedBy: undefined })],
      ]),
    }),
  });

  it("flags the traveller as off-roster and counts them", () => {
    expect(card.travellers[0].rosterStatus).toBe("OFF_ROSTER");
    expect(card.travellers[0].rosterBasis).toBe("NO_LINK");
    expect(card.offRosterCount).toBe(1);
  });

  it("cannot claim this was filed on behalf — an unclaimed profile proves nothing", () => {
    // THE INTERACTION WORTH PINNING: off-roster and on-behalf are separate
    // questions. A traveller with no login link is not evidence that the
    // requestor isn't the traveller, so filedFor says UNKNOWN rather than
    // borrowing the off-roster finding as an answer to a different question.
    expect(card.filedFor).toBe("UNKNOWN");
    expect(card.travellers[0].isRequestor).toBe(false);
  });
});

describe("buildVisaApprovalCard — completeness gaps", () => {
  it("names a missing passport expiry as a BLOCKING gap against that traveller", () => {
    const card = buildVisaApprovalCard({
      request: requestDoc(),
      applications: [applicationDoc()],
      ctx: ctx({ profilesById: new Map([["p1", goodProfile({ passportExpiry: null })]]) }),
    });

    expect(card.completeness.ready).toBe(false);
    const gap = card.completeness.gaps.find((g) => g.code === "PASSPORT_EXPIRY_MISSING");
    expect(gap).toBeTruthy();
    expect(gap!.severity).toBe("BLOCKING");
    expect(gap!.travellerName).toBe("Arjun Nair");
    expect(card.travellers[0].passportValidity).toBe("UNKNOWN");
  });

  it("flags a passport that lapses before the trip", () => {
    const card = buildVisaApprovalCard({
      request: requestDoc(),
      applications: [applicationDoc()],
      ctx: ctx({ profilesById: new Map([["p1", goodProfile({ passportExpiry: "2026-09-20" })]]) }),
    });
    expect(card.completeness.ready).toBe(false);
    expect(card.completeness.gaps.map((g) => g.code)).toContain("PASSPORT_EXPIRES_BEFORE_TRAVEL");
  });

  it("reports a missing traveller record as one gap, not five derived ones", () => {
    const card = buildVisaApprovalCard({
      request: requestDoc(),
      applications: [applicationDoc({ travellerProfileId: null })],
      ctx: ctx(),
    });
    expect(card.completeness.gaps.map((g) => g.code)).toEqual(["TRAVELLER_PROFILE_MISSING"]);
    expect(card.travellers[0].rosterStatus).toBe("UNKNOWN");
    expect(card.travellers[0].rosterBasis).toBe("NO_PROFILE");
  });

  it("reports an unresolved nationality honestly instead of defaulting one", () => {
    const card = buildVisaApprovalCard({
      request: requestDoc(),
      applications: [
        applicationDoc({ nationality: null, nationalityUnresolved: true }),
      ],
      ctx: ctx({ profilesById: new Map([["p1", goodProfile({ nationality: "Indiann" })]]) }),
    });
    expect(card.travellers[0].nationalityUnresolved).toBe(true);
    // Falls back to the profile's raw text so the approver sees what was
    // typed, alongside the flag saying it didn't resolve.
    expect(card.travellers[0].nationality).toBe("Indiann");
    expect(card.completeness.gaps.map((g) => g.code)).toContain("NATIONALITY_UNRESOLVED");
  });

  it("missing consent is a request-level gap with no traveller attached", () => {
    const card = buildVisaApprovalCard({
      request: requestDoc({ consents: [] }),
      applications: [applicationDoc()],
      ctx: ctx({ profilesById: new Map([["p1", goodProfile()]]) }),
    });
    const gap = card.completeness.gaps.find((g) => g.code === "CONSENT_MISSING");
    expect(gap!.travellerName).toBeNull();
    expect(card.consent.accepted).toBe(false);
  });

  it("outstanding checklist documents are ADVISORY — submit does not block on them", () => {
    // The severity split is not cosmetic: POST /requests/:id/submit
    // deliberately never checks the checklist, so a card claiming this blocks
    // would be asserting a rule the product does not enforce.
    const card = buildVisaApprovalCard({
      request: requestDoc(),
      applications: [
        applicationDoc({
          ruleSnapshot: { documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }] },
        }),
      ],
      ctx: ctx({ profilesById: new Map([["p1", goodProfile()]]) }),
    });

    const gap = card.completeness.gaps.find((g) => g.code === "DOCUMENTS_OUTSTANDING");
    expect(gap!.severity).toBe("ADVISORY");
    expect(gap!.label).toBe("1 required document not uploaded yet");
    // Still "ready": nothing BLOCKING is outstanding.
    expect(card.completeness.ready).toBe(true);
  });

  it("an uploaded document clears the outstanding requirement and is counted", () => {
    const card = buildVisaApprovalCard({
      request: requestDoc(),
      applications: [
        applicationDoc({
          ruleSnapshot: { documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }] },
        }),
      ],
      ctx: ctx({
        profilesById: new Map([["p1", goodProfile()]]),
        documentsByApplicationId: new Map([["a1", [{ docCode: "DOC-01" }]]]),
      }),
    });

    expect(card.completeness.gaps).toEqual([]);
    expect(card.documents.count).toBe(1);
    expect(card.travellers[0].documents.docCodes).toEqual(["DOC-01"]);
  });
});

describe("buildVisaApprovalCard — multi-traveller", () => {
  const card = buildVisaApprovalCard({
    request: requestDoc(),
    applications: [
      applicationDoc({ _id: "a1", travellerProfileId: "p1" }),
      applicationDoc({ _id: "a2", travellerProfileId: "p2" }),
      applicationDoc({ _id: "a3", travellerProfileId: "p3" }),
    ],
    ctx: ctx({
      profilesById: new Map<string, any>([
        ["p1", goodProfile()], // the requestor
        ["p2", goodProfile({ _id: "p2", firstName: "Sneha", claimedBy: COLLEAGUE })],
        // No claim, no roster link — a genuine outsider on the company's account.
        ["p3", goodProfile({ _id: "p3", firstName: "Priya", claimedBy: undefined })],
      ]),
    }),
  });

  it("counts the travellers and the off-roster ones separately", () => {
    expect(card.travellerCount).toBe(3);
    expect(card.offRosterCount).toBe(1);
  });

  it("is SELF_AND_OTHERS — the requestor is on the trip, and so are others", () => {
    expect(card.filedFor).toBe("SELF_AND_OTHERS");
  });

  it("keeps every traveller addressable by their own application id", () => {
    expect(card.travellers.map((t) => t.applicationId)).toEqual(["a1", "a2", "a3"]);
  });
});
