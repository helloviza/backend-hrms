// Route-level coverage for the Phase 2a read-only visa API (GET
// /destinations, GET /rules, GET /content/:iso2). No DB — VisaRule and
// VisaDestinationContent are mocked with plain in-memory fixtures, same
// approach as myBookings.manual.test.ts. requireAuth/requireWorkspace are
// NOT part of this router (mounted by server.ts) so they're not exercised
// here; requireFeature("visaEnabled") IS wired into the test app below
// (mirroring the real server.ts mount chain) so the visaEnabled=false
// rejection can be tested end-to-end.
import { describe, it, expect, vi, beforeEach } from "vitest";

function findChain(result: any[]) {
  const chain: any = {
    select: () => chain,
    sort: () => chain,
    lean: () => Promise.resolve(result),
  };
  return chain;
}

// The mocked module isn't only consumed by routes/visa.ts's own import —
// routes/visa.ts now also imports VisaApplication.js/VisaRequest.js (Phase
// 3a write path, real/unmocked here since this file never exercises those
// routes), and VisaApplication.ts's own schema imports several more named
// exports from VisaRule.js at module-load time. All of them must be present
// on this mock or importing the router at all throws, not just the routes
// this file actually tests.
const visaRuleFindMock = vi.fn();
const visaRuleFindOneMock = vi.fn();
vi.mock("../models/VisaRule.js", () => ({
  default: {
    find: (...args: any[]) => visaRuleFindMock(...args),
    findOne: (...args: any[]) => visaRuleFindOneMock(...args),
  },
  VISA_PURPOSES: ["TOURIST", "BUSINESS", "TOURIST_OR_BUSINESS", "TRANSIT"],
  VISA_ENTRY_TYPES: ["SINGLE", "DOUBLE", "MULTIPLE", "UNSPECIFIED"],
  VISA_SERVICE_TIERS: ["STANDARD", "EXPRESS", "SUPERFAST", "PRIORITY", "SUPER_PRIORITY"],
  VISA_PRODUCT_CLASSES: ["VISA", "ARRIVAL_CARD", "FORM_SERVICE", "APPOINTMENT_SERVICE"],
  VISA_CATEGORIES: ["STICKER", "STAMP", "E_VISA", "VOA", "VISA_FREE"],
  VISA_ETA_BASES: ["BUSINESS", "CALENDAR"],
  VISA_RULE_DISPLAY_MODES: ["ITEMISED", "INDICATIVE"],
  // Phase 10b — VisaApplication.ts's schema now also imports this (the
  // documentGroups[].requirement enum), at the same module-load time.
  VISA_DOC_REQUIREMENT_LEVELS: ["REQUIRED", "CONDITIONAL"],
}));

const visaContentFindOneMock = vi.fn();
vi.mock("../models/VisaDestinationContent.js", () => ({
  default: { findOne: (...args: any[]) => ({ lean: () => visaContentFindOneMock(...args) }) },
}));

import express from "express";
import request from "supertest";
import router from "./visa.js";
import { requireFeature } from "../middleware/requireFeature.js";

const STAFF_USER = { id: "u1", roles: ["EMPLOYEE"], email: "agent@plumtrips.com" };

function makeApp(opts: { visaEnabled?: boolean; workspaceId?: string } = {}) {
  const { visaEnabled = true, workspaceId = "wwwwwwwwwwwwwwwwwwwwwwww" } = opts;
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = STAFF_USER;
    req.workspaceId = workspaceId;
    req.workspace = {
      _id: workspaceId,
      status: "ACTIVE",
      config: { features: { visaEnabled } },
    };
    next();
  });
  app.use(requireFeature("visaEnabled"));
  app.use("/", router);
  return app;
}

function ruleDoc(overrides: any = {}) {
  return {
    nationality: "IN",
    destinationIso2: "DE",
    destinationName: "Germany",
    purpose: "TOURIST",
    entryType: "SINGLE",
    serviceTier: "STANDARD",
    status: "PUBLISHED",
    isSchengen: true,
    productClass: "VISA",
    visaCategory: "STICKER",
    validityDays: 90,
    maxStayDays: 30,
    isExtension: false,
    etaMinDays: 5,
    etaMaxDays: 10,
    etaBasis: "BUSINESS",
    appointmentRequired: true,
    biometricsRequired: true,
    documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }],
    embassyFeeInr: 5000,
    vfsFeeInr: 1500,
    plumtripsServiceFeeInr: 2000,
    ...overrides,
  };
}

beforeEach(() => {
  visaRuleFindMock.mockReset();
  visaRuleFindOneMock.mockReset();
  visaContentFindOneMock.mockReset();
});

describe("GET /destinations", () => {
  it("queries status:PUBLISHED only, so a DRAFT-only destination is never returned", async () => {
    visaRuleFindMock.mockReturnValue(findChain([]));
    const res = await request(makeApp()).get("/destinations");
    expect(res.status).toBe(200);
    expect(res.body.destinations).toEqual([]);
    const [filter] = visaRuleFindMock.mock.calls[0];
    expect(filter).toEqual({ status: "PUBLISHED" });
  });

  it("returns a single `category` when a destination has exactly one visaCategory", async () => {
    visaRuleFindMock.mockReturnValue(
      findChain([
        ruleDoc({ destinationIso2: "AE", destinationName: "United Arab Emirates", visaCategory: "E_VISA" }),
      ]),
    );
    const res = await request(makeApp()).get("/destinations");
    expect(res.status).toBe(200);
    expect(res.body.destinations).toHaveLength(1);
    const dest = res.body.destinations[0];
    expect(dest.iso2).toBe("AE");
    expect(dest.region).toBe("GULF");
    expect(dest.category).toBe("E_VISA");
    expect(dest.categories).toEqual(["E_VISA"]);
  });

  it("returns all categories (and no single `category`) when a destination has more than one", async () => {
    visaRuleFindMock.mockReturnValue(
      findChain([
        ruleDoc({ destinationIso2: "TH", destinationName: "Thailand", visaCategory: "VOA" }),
        ruleDoc({ destinationIso2: "TH", destinationName: "Thailand", visaCategory: "E_VISA", purpose: "BUSINESS" }),
      ]),
    );
    const res = await request(makeApp()).get("/destinations");
    expect(res.status).toBe(200);
    const dest = res.body.destinations.find((d: any) => d.iso2 === "TH");
    expect(dest.category).toBeUndefined();
    expect(dest.categories.sort()).toEqual(["E_VISA", "VOA"]);
  });

  describe("purposes (2026-08-03 — derived from real rules, not hardcoded)", () => {
    it("reports only the one purpose a single-purpose destination actually has", async () => {
      visaRuleFindMock.mockReturnValue(
        findChain([ruleDoc({ destinationIso2: "AE", destinationName: "United Arab Emirates", purpose: "TOURIST" })]),
      );
      const res = await request(makeApp()).get("/destinations");
      const dest = res.body.destinations.find((d: any) => d.iso2 === "AE");
      expect(dest.purposes).toEqual(["TOURIST"]);
    });

    it("surfaces a TOURIST_OR_BUSINESS rule as BOTH Tourist and Business, never as its own option", async () => {
      visaRuleFindMock.mockReturnValue(
        findChain([ruleDoc({ destinationIso2: "CA", destinationName: "Canada", purpose: "TOURIST_OR_BUSINESS" })]),
      );
      const res = await request(makeApp()).get("/destinations");
      const dest = res.body.destinations.find((d: any) => d.iso2 === "CA");
      expect(dest.purposes).toEqual(["TOURIST", "BUSINESS"]);
    });

    it("unions purposes across multiple rules for the same destination, in canonical order", async () => {
      visaRuleFindMock.mockReturnValue(
        findChain([
          ruleDoc({ destinationIso2: "ZA", destinationName: "South Africa", purpose: "TRANSIT" }),
          ruleDoc({ destinationIso2: "ZA", destinationName: "South Africa", purpose: "TOURIST" }),
          ruleDoc({ destinationIso2: "ZA", destinationName: "South Africa", purpose: "BUSINESS" }),
        ]),
      );
      const res = await request(makeApp()).get("/destinations");
      const dest = res.body.destinations.find((d: any) => d.iso2 === "ZA");
      expect(dest.purposes).toEqual(["TOURIST", "BUSINESS", "TRANSIT"]);
    });

    it("does not duplicate a purpose already covered by another rule on the same destination", async () => {
      visaRuleFindMock.mockReturnValue(
        findChain([
          ruleDoc({ destinationIso2: "CA", destinationName: "Canada", purpose: "TOURIST_OR_BUSINESS" }),
          ruleDoc({ destinationIso2: "CA", destinationName: "Canada", purpose: "TOURIST", entryType: "MULTIPLE" }),
        ]),
      );
      const res = await request(makeApp()).get("/destinations");
      const dest = res.body.destinations.find((d: any) => d.iso2 === "CA");
      expect(dest.purposes).toEqual(["TOURIST", "BUSINESS"]);
    });
  });
});

describe("GET /rules", () => {
  it("returns all variants for a destination with multiple entryType/serviceTier combinations", async () => {
    visaRuleFindMock.mockReturnValue(
      findChain([
        ruleDoc({ entryType: "SINGLE", serviceTier: "STANDARD" }),
        ruleDoc({ entryType: "MULTIPLE", serviceTier: "EXPRESS" }),
      ]),
    );
    const res = await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST");
    expect(res.status).toBe(200);
    expect(res.body.variants).toHaveLength(2);
    expect(res.body.variants.map((v: any) => v.serviceTier).sort()).toEqual(["EXPRESS", "STANDARD"]);
  });

  it("orders variants by the defined serviceTier sequence, not alphabetically — STANDARD first even when inserted last", async () => {
    // Alphabetical order would be EXPRESS, STANDARD, SUPERFAST — the exact
    // UAE bug (defaulted to Express, over-quoting the customer). Fixtures
    // are deliberately inserted out of both orders to prove this isn't
    // riding on insertion order either.
    visaRuleFindMock.mockReturnValue(
      findChain([
        ruleDoc({ serviceTier: "SUPERFAST" }),
        ruleDoc({ serviceTier: "EXPRESS" }),
        ruleDoc({ serviceTier: "STANDARD" }),
      ]),
    );
    const res = await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST");
    expect(res.status).toBe(200);
    expect(res.body.variants.map((v: any) => v.serviceTier)).toEqual(["STANDARD", "EXPRESS", "SUPERFAST"]);
  });

  it("queries status:PUBLISHED, nationality:IN, destination and purpose — so a DRAFT rule is never returned", async () => {
    visaRuleFindMock.mockReturnValue(findChain([ruleDoc({ status: "PUBLISHED" })]));
    const res = await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST");
    expect(res.status).toBe(200);
    expect(res.body.variants).toHaveLength(1);
    const [{ nationality, destinationIso2, purpose, status }] = visaRuleFindMock.mock.calls[0];
    expect(status).toBe("PUBLISHED");
    expect(nationality).toBe("IN");
    expect(destinationIso2).toBe("DE");
    expect(purpose).toEqual({ $in: ["TOURIST", "TOURIST_OR_BUSINESS"] });
  });

  describe("purpose widening — TOURIST_OR_BUSINESS covers two purposes, not a third", () => {
    it("purpose=TOURIST queries for TOURIST and TOURIST_OR_BUSINESS", async () => {
      visaRuleFindMock.mockReturnValue(findChain([ruleDoc({ purpose: "TOURIST" })]));
      await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST");
      const [{ purpose }] = visaRuleFindMock.mock.calls[0];
      expect(purpose).toEqual({ $in: ["TOURIST", "TOURIST_OR_BUSINESS"] });
    });

    it("purpose=BUSINESS queries for BUSINESS and TOURIST_OR_BUSINESS", async () => {
      visaRuleFindMock.mockReturnValue(findChain([ruleDoc({ purpose: "BUSINESS" })]));
      await request(makeApp()).get("/rules?destination=DE&purpose=BUSINESS");
      const [{ purpose }] = visaRuleFindMock.mock.calls[0];
      expect(purpose).toEqual({ $in: ["BUSINESS", "TOURIST_OR_BUSINESS"] });
    });

    it("purpose=TRANSIT queries for TRANSIT only — never TOURIST_OR_BUSINESS", async () => {
      visaRuleFindMock.mockReturnValue(findChain([ruleDoc({ purpose: "TRANSIT" })]));
      await request(makeApp()).get("/rules?destination=DE&purpose=TRANSIT");
      const [{ purpose }] = visaRuleFindMock.mock.calls[0];
      expect(purpose).toEqual({ $in: ["TRANSIT"] });
      expect(purpose.$in).not.toContain("TOURIST_OR_BUSINESS");
    });

    it("a TOURIST_OR_BUSINESS rule is returned for a TOURIST query end-to-end", async () => {
      visaRuleFindMock.mockReturnValue(findChain([ruleDoc({ purpose: "TOURIST_OR_BUSINESS" })]));
      const res = await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST");
      expect(res.status).toBe(200);
      expect(res.body.variants).toHaveLength(1);
    });

    it("a TOURIST_OR_BUSINESS rule is returned for a BUSINESS query end-to-end", async () => {
      visaRuleFindMock.mockReturnValue(findChain([ruleDoc({ purpose: "TOURIST_OR_BUSINESS" })]));
      const res = await request(makeApp()).get("/rules?destination=DE&purpose=BUSINESS");
      expect(res.status).toBe(200);
      expect(res.body.variants).toHaveLength(1);
    });
  });

  it("hydrates the document checklist from VISA_DOCUMENT_CODES", async () => {
    visaRuleFindMock.mockReturnValue(
      findChain([
        ruleDoc({
          documentRequirements: [
            { docCode: "DOC-01", requirement: "REQUIRED" },
            { docCode: "DOC-03", requirement: "CONDITIONAL", condition: "If self-employed" },
          ],
        }),
      ]),
    );
    const res = await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST");
    const docs = res.body.variants[0].documents;
    expect(docs).toEqual([
      { docCode: "DOC-01", name: "Passport", category: "IDENTITY", notes: expect.any(String), requirement: "REQUIRED", condition: undefined, satisfiedByBooking: false, conciergeArrangeable: false },
      { docCode: "DOC-03", name: "Bank Statement", category: "FINANCIAL", notes: expect.any(String), requirement: "CONDITIONAL", condition: "If self-employed", satisfiedByBooking: false, conciergeArrangeable: false },
    ]);
  });

  it("marks DOC-07/DOC-08/DOC-09 conciergeArrangeable, and nothing else — DOC-09 gets no fake booking lookup", async () => {
    visaRuleFindMock.mockReturnValue(
      findChain([
        ruleDoc({
          documentRequirements: [
            { docCode: "DOC-01", requirement: "REQUIRED" },
            { docCode: "DOC-07", requirement: "REQUIRED" },
            { docCode: "DOC-08", requirement: "REQUIRED" },
            { docCode: "DOC-09", requirement: "REQUIRED" },
          ],
        }),
      ]),
    );
    const res = await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST");
    const docs = res.body.variants[0].documents;
    const byCode = Object.fromEntries(docs.map((d: any) => [d.docCode, d]));

    expect(byCode["DOC-01"].conciergeArrangeable).toBe(false);
    expect(byCode["DOC-07"].conciergeArrangeable).toBe(true);
    expect(byCode["DOC-08"].conciergeArrangeable).toBe(true);
    expect(byCode["DOC-09"].conciergeArrangeable).toBe(true);

    // DOC-09 has no booking register to check — satisfiedByBooking is
    // always false for it, never derived from a lookup that doesn't exist.
    expect(byCode["DOC-09"].satisfiedByBooking).toBe(false);
  });

  it("hydrates gracefully (no throw) for a docCode not yet defined in VISA_DOCUMENT_CODES", async () => {
    visaRuleFindMock.mockReturnValue(
      findChain([ruleDoc({ documentRequirements: [{ docCode: "DOC-19", requirement: "REQUIRED" }] })]),
    );
    const res = await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST");
    expect(res.status).toBe(200);
    expect(res.body.variants[0].documents[0]).toMatchObject({ docCode: "DOC-19", name: null });
  });

  it("computes an ITEMISED fee block with GST on the service fee only", async () => {
    visaRuleFindMock.mockReturnValue(
      findChain([ruleDoc({ embassyFeeInr: 5000, vfsFeeInr: 1500, plumtripsServiceFeeInr: 2000 })]),
    );
    const res = await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST");
    const fee = res.body.variants[0].fee;
    expect(fee.displayMode).toBe("ITEMISED");
    const gst = fee.lineItems.find((l: any) => l.code === "GST");
    expect(gst.amountInr).toBe(360); // 18% of 2000
    expect(fee.disclaimer).toEqual(expect.stringContaining("recovered at actual"));
  });

  it("computes an INDICATIVE fee block when no itemised component is populated", async () => {
    visaRuleFindMock.mockReturnValue(
      findChain([
        ruleDoc({ embassyFeeInr: undefined, vfsFeeInr: undefined, plumtripsServiceFeeInr: undefined, indicativeVisaCostInr: 8000 }),
      ]),
    );
    const res = await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST");
    const fee = res.body.variants[0].fee;
    expect(fee.displayMode).toBe("INDICATIVE");
    expect(fee.totalInr).toBe(8000);
    expect(fee.disclaimer).toEqual(expect.stringContaining("recovered at actual"));
  });

  it("400s on a missing/invalid purpose rather than querying the DB", async () => {
    const res = await request(makeApp()).get("/rules?destination=DE");
    expect(res.status).toBe(400);
    expect(visaRuleFindMock).not.toHaveBeenCalled();
  });

  it("defaults nationality to IN when the query param is absent", async () => {
    visaRuleFindMock.mockReturnValue(findChain([ruleDoc()]));
    const res = await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST");
    expect(res.status).toBe(200);
    expect(res.body.nationality.iso2).toBe("IN");
    const [{ nationality }] = visaRuleFindMock.mock.calls[0];
    expect(nationality).toBe("IN");
  });

  it("honours an explicit nationality query param", async () => {
    visaRuleFindMock.mockReturnValue(findChain([ruleDoc({ nationality: "PK" })]));
    const res = await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST&nationality=PK");
    expect(res.status).toBe(200);
    expect(res.body.nationality.iso2).toBe("PK");
    const [{ nationality }] = visaRuleFindMock.mock.calls[0];
    expect(nationality).toBe("PK");
  });

  it("resolves an explicit nationality through normaliseToIso2 (demonym/alias forms too)", async () => {
    visaRuleFindMock.mockReturnValue(findChain([ruleDoc({ nationality: "US" })]));
    const res = await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST&nationality=American");
    expect(res.status).toBe(200);
    expect(res.body.nationality.iso2).toBe("US");
  });

  it("400s on an unrecognised nationality rather than querying the DB", async () => {
    const res = await request(makeApp()).get("/rules?destination=DE&purpose=TOURIST&nationality=Narnia");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nationality/i);
    expect(visaRuleFindMock).not.toHaveBeenCalled();
  });
});

// A well-formed 24-hex-char ObjectId string — the mock doesn't do real
// query filtering, so this is just a stand-in id, never actually matched
// against anything.
const VALID_RULE_ID = "507f1f77bcf86cd799439011";

function leanChain(value: any) {
  return { lean: () => Promise.resolve(value) };
}

describe("GET /rules/:id", () => {
  it("404s when the query's own status:PUBLISHED filter excludes a DRAFT rule (findOne legitimately returns null)", async () => {
    visaRuleFindOneMock.mockReturnValue(leanChain(null));
    const res = await request(makeApp()).get(`/rules/${VALID_RULE_ID}`);
    expect(res.status).toBe(404);
    const [filter] = visaRuleFindOneMock.mock.calls[0];
    expect(filter).toEqual({ _id: VALID_RULE_ID, status: "PUBLISHED" });
  });

  it("404s (not 500s) for an unknown id", async () => {
    visaRuleFindOneMock.mockReturnValue(leanChain(null));
    const res = await request(makeApp()).get(`/rules/${VALID_RULE_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });

  it("404s (not 500s) on a malformed id — never even reaches the DB", async () => {
    const res = await request(makeApp()).get("/rules/not-a-valid-object-id");
    expect(res.status).toBe(404);
    expect(visaRuleFindOneMock).not.toHaveBeenCalled();
  });

  it("returns the fee block, shaped like one GET /rules variant entry plus destination/purpose", async () => {
    visaRuleFindOneMock.mockReturnValue(
      leanChain(
        ruleDoc({
          _id: VALID_RULE_ID,
          embassyFeeInr: 5000,
          vfsFeeInr: 1500,
          plumtripsServiceFeeInr: 2000,
        }),
      ),
    );
    const res = await request(makeApp()).get(`/rules/${VALID_RULE_ID}`);
    expect(res.status).toBe(200);

    const { rule } = res.body;
    expect(rule.ruleId).toBe(VALID_RULE_ID);
    expect(rule.destination).toBe("DE");
    expect(rule.destinationName).toBe("Germany");
    expect(rule.purpose).toBe("TOURIST");
    expect(rule.category).toBe("STICKER");
    expect(rule.eta).toEqual({ minDays: 5, maxDays: 10, basis: "BUSINESS" });
    expect(rule.fee).toBeDefined();
    expect(rule.fee.displayMode).toBe("ITEMISED");
    expect(rule.fee.totalInr).toBeGreaterThan(0);
    expect(rule.documents).toEqual([
      expect.objectContaining({ docCode: "DOC-01", requirement: "REQUIRED" }),
    ]);
  });
});

describe("GET /content/:iso2", () => {
  it("returns PUBLISHED content", async () => {
    visaContentFindOneMock.mockResolvedValue({
      destinationIso2: "DE",
      status: "PUBLISHED",
      businessBlock: { highlights: ["a"] },
      tourismBlock: { highlights: ["b"] },
      entrySnapshot: { visaRequired: true, headline: "h", summary: "s" },
    });
    const res = await request(makeApp()).get("/content/DE");
    expect(res.status).toBe(200);
    expect(res.body.content.destinationIso2).toBe("DE");
  });

  it("404s (not 500s) for a destination whose only content is DRAFT", async () => {
    // status:"PUBLISHED" is part of the query itself, so a DRAFT-only
    // destination resolves the same as "no document found".
    visaContentFindOneMock.mockResolvedValue(null);
    const res = await request(makeApp()).get("/content/DE");
    expect(res.status).toBe(404);
  });

  it("404s (not 500s) for a completely unknown iso2", async () => {
    visaContentFindOneMock.mockResolvedValue(null);
    const res = await request(makeApp()).get("/content/ZZ");
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });
});

describe("visaEnabled feature gate", () => {
  it("rejects with the workspace-feature-not-enabled error when visaEnabled=false", async () => {
    const res = await request(makeApp({ visaEnabled: false })).get("/destinations");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/visaEnabled/);
    expect(visaRuleFindMock).not.toHaveBeenCalled();
  });
});
