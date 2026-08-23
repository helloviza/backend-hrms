// Access coverage for the cross-tenant extracted-documents master surface.
//
// This is the ONE surface designed to read across workspaces, so the thing
// under test is not "does it return rows" but "whose rows, and by what
// mechanism". Specifically it proves the F-01 distinction
// (docs/audits/vouchers-extract-render-audit.md §7): the SuperAdmin's
// cross-tenant read must be an EXPLICIT `{}` scope, never an absent or
// undefined workspaceId that Mongoose silently strips into a bare find({}).
//
// The Mongo layer is a spy over ExtractedDocument.find/countDocuments, so the
// assertions are on the FILTER THAT WOULD BE SENT TO MONGO — the only place
// the difference between "deliberately unscoped" and "accidentally unscoped"
// is observable. A test that only asserted on returned rows would pass
// identically for both, which is exactly how F-01 survived review the first
// time.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

const WS_A = "aaaaaaaaaaaaaaaaaaaaaaaa"; // tenant A
const WS_B = "bbbbbbbbbbbbbbbbbbbbbbbb"; // tenant B
const BOOKING_A = "cccccccccccccccccccccccc";
const BOOKING_B = "dddddddddddddddddddddddd";

const docA = {
  _id: "1111aaaa1111aaaa1111aaaa",
  workspaceId: WS_A, bookingId: BOOKING_A,
  originalFilename: "tenantA-eticket.pdf", status: "extracted", docType: "flight",
  attempts: 1, modelUsed: "gemini-2.5-flash", validationErrorCount: 0, verified: false,
  createdAt: new Date("2026-08-18T10:00:00Z"), updatedAt: new Date("2026-08-18T10:00:35Z"),
  flightRows: [
    { passengerIndex: 0, segmentIndex: 0,
      passengerName: "Mr A One", passengerType: "Adult", airline: "Air India", flightNo: "AI-865",
      cabinClass: "Economy", depAirport: "DEL", depCity: "Delhi", depDate: "14 JUN, 2026",
      depTime: "08:35", arrAirport: "BOM", arrCity: "Mumbai", arrDate: "14 JUN, 2026",
      arrTime: "10:50", pnr: "AAA111", ticketNo: "098-1111111111" },
    { passengerIndex: 1, segmentIndex: 0,
      passengerName: "Mrs A Two", passengerType: "Adult", airline: "Air India", flightNo: "AI-865",
      cabinClass: "Economy", depAirport: "DEL", depCity: "Delhi", depDate: "14 JUN, 2026",
      depTime: "08:35", arrAirport: "BOM", arrCity: "Mumbai", arrDate: "14 JUN, 2026",
      arrTime: "10:50", pnr: "AAA111", ticketNo: "098-2222222222" },
  ],
};

/** A hotel document: a supported extraction, but a mode the factor library has no entry for. */
const docHotel = {
  _id: "3333cccc3333cccc3333cccc",
  workspaceId: WS_A, bookingId: BOOKING_A,
  originalFilename: "tenantA-hotel-voucher.pdf", status: "extracted", docType: "hotel",
  attempts: 1, modelUsed: "gemini-2.5-flash", validationErrorCount: 0, verified: false,
  createdAt: new Date("2026-08-18T09:00:00Z"), updatedAt: new Date("2026-08-18T09:00:20Z"),
  flightRows: [],
};

const docB = {
  _id: "2222bbbb2222bbbb2222bbbb",
  workspaceId: WS_B, bookingId: BOOKING_B,
  originalFilename: "tenantB-eticket.pdf", status: "failed", docType: "flight",
  attempts: 3, validationErrorCount: 0, verified: false, error: "The document has no pages.",
  createdAt: new Date("2026-08-18T11:00:00Z"), updatedAt: new Date("2026-08-18T11:02:00Z"),
  flightRows: [],
};

/** Captures every filter handed to the model, which is what we assert on. */
const findFilters: any[] = [];
const countFilters: any[] = [];
let store: any[] = [];

function applyFilter(filter: any) {
  // Minimal, faithful-enough matcher: only equality on workspaceId/status,
  // which is all these tests exercise. An ABSENT workspaceId key matches
  // everything — deliberately reproducing the Mongoose behaviour F-01 is about.
  return store.filter((d) => {
    if ("workspaceId" in filter && String(filter.workspaceId) !== String(d.workspaceId)) return false;
    if ("status" in filter && filter.status !== d.status) return false;
    return true;
  });
}

function chain(rows: any[]) {
  const c: any = {
    select: () => c, sort: () => c, skip: () => c, limit: () => c,
    lean: async () => rows, then: (r: any) => Promise.resolve(rows).then(r),
  };
  return c;
}

vi.mock("../models/ExtractedDocument.js", () => ({
  default: {
    find: (filter: any) => { findFilters.push(filter); return chain(applyFilter(filter)); },
    countDocuments: async (filter: any) => { countFilters.push(filter); return applyFilter(filter).length; },
    distinct: async () => [],
  },
}));

vi.mock("../models/ManualBooking.js", () => ({
  default: {
    find: () => ({
      select: () => ({ lean: async () => [
        { _id: BOOKING_A, bookingRef: "MB-A-0001" },
        { _id: BOOKING_B, bookingRef: "MB-B-0001" },
      ] }),
    }),
  },
}));

// The workspace label resolves through CUSTOMER, not CustomerWorkspace —
// ExtractedDocument.workspaceId is copied from ManualBooking.workspaceId, which
// is ref:"Customer". An earlier version of this file mocked CustomerWorkspace
// with these ids, which made the label appear to resolve while the real query
// (against `customers`) matched nothing in prod. Mocking the right collection
// is the point of this fixture, not an incidental detail.
//
// The name fields deliberately exercise the precedence Customer.ts's own
// pre-save hook uses: legalName, then companyName, then name.
const customerFindArgs: any[] = [];
vi.mock("../models/Customer.js", () => ({
  default: {
    find: (filter: any) => { customerFindArgs.push(filter); return ({
      select: () => ({ lean: async () => [
        // legalName wins over the other two
        { _id: WS_A, legalName: "Tenant A Pvt Ltd", companyName: "A Co", name: "A" },
        // no legalName → companyName wins
        { _id: WS_B, companyName: "Tenant B Pvt Ltd", name: "B" },
      ] }),
    }); },
  },
}));

// Carbon results for the master join. Passenger 0 of the tenant-A document is a
// clean High row; passenger 1 is deliberately an Insufficient Data row, so the
// tests can prove a refusal to price travels through the join intact — nulls,
// not zeros — rather than being flattened into a blank that reads like a
// missing value.
const carbonFindFilters: any[] = [];
const carbonRecords = [
  {
    extractedDocumentId: "1111aaaa1111aaaa1111aaaa", passengerIndex: 0, segmentIndex: 0,
    distanceKm: 1148.2, factorValue: 0.10916, factorUnit: "kg CO2e/passenger.km",
    factorVersion: "DEFRA-2026-v1", factorSource: "DEFRA/DESNZ GHG Conversion Factors 2026",
    rfVariant: "With RF", haulBand: "International, to/from non-UK",
    resolvedCabin: "Economy class", cabinResolution: "stated", pax: 1, co2eKg: 125.34,
    methodology: "CO2e = 1148.2 km x 0.10916 kg CO2e/passenger.km x 1 passenger = 125.34 kg CO2e.",
    status: "calculated", confidence: "high", notes: null,
  },
  {
    extractedDocumentId: "1111aaaa1111aaaa1111aaaa", passengerIndex: 1, segmentIndex: 0,
    distanceKm: null, factorValue: null, factorUnit: null, factorVersion: null,
    factorSource: null, rfVariant: null, haulBand: null, resolvedCabin: null,
    cabinResolution: null, pax: 1, co2eKg: null,
    methodology: 'No CO2e calculated: origin "ZZZ" could not be resolved to an airport in the Airport Master.',
    status: "insufficient_data", confidence: "insufficient", notes: "Unresolved airport code.",
  },
];

vi.mock("../models/CarbonRecord.js", () => ({
  default: {
    find: (filter: any) => {
      carbonFindFilters.push(filter);
      return { select: () => ({ lean: async () => carbonRecords }) };
    },
  },
}));

// Present only to prove it is NOT consulted for the workspace label.
const workspaceFindSpy = vi.fn();
vi.mock("../models/CustomerWorkspace.js", () => ({
  default: {
    find: (...a: any[]) => { workspaceFindSpy(...a); return ({ select: () => ({ lean: async () => [] }) }); },
  },
}));

import express from "express";
import request from "supertest";
import router, { extractedDocScope, buildFilter } from "./admin.extractedDocuments.js";
import { CARBON_CALCULATION_VERSION } from "../services/carbonEngine.service.js";

/** Builds an app whose caller identity is whatever the test wants. */
function appAs(user: any, workspaceObjectId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    req.workspaceObjectId = workspaceObjectId;
    next();
  });
  app.use("/api/admin/extracted-documents", router);
  return app;
}

const SUPERADMIN = { _id: "super000000000000000001", roles: ["SUPERADMIN"] };
const TENANT_ADMIN = { _id: "tenant00000000000000001", roles: ["TENANT_ADMIN"] };

beforeEach(() => {
  findFilters.length = 0;
  countFilters.length = 0;
  carbonFindFilters.length = 0;
  store = [docA, docB];
});

describe("GET /api/admin/extracted-documents — access", () => {
  it("a real SuperAdmin sees rows across BOTH workspaces", async () => {
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");
    expect(res.status).toBe(200);

    const workspaces = [...new Set(res.body.rows.map((r: any) => r.workspaceId))];
    expect(workspaces).toContain(WS_A);
    expect(workspaces).toContain(WS_B);
    expect(res.body.total).toBe(2);
  });

  it("the SuperAdmin's cross-tenant read is an EXPLICIT {} scope, not an absent filter", async () => {
    await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");
    // The whole of F-01: `workspaceId` must be genuinely ABSENT by decision,
    // never present-but-undefined (which Mongoose strips, producing the same
    // query by accident). Assert the key is absent AND that no undefined value
    // was smuggled in under it.
    const filter = findFilters[0];
    expect(Object.prototype.hasOwnProperty.call(filter, "workspaceId")).toBe(false);
    expect(filter.workspaceId).toBeUndefined();
  });

  it("a non-SuperAdmin is refused outright (403)", async () => {
    const res = await request(appAs(TENANT_ADMIN, WS_A)).get("/api/admin/extracted-documents");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/SuperAdmin/i);
    // Nothing was even queried.
    expect(findFilters).toHaveLength(0);
  });

  it("SuperAdmin narrowing to one workspace returns only that tenant", async () => {
    const res = await request(appAs(SUPERADMIN)).get(
      `/api/admin/extracted-documents?workspaceId=${WS_A}`,
    );
    expect(res.status).toBe(200);
    const workspaces = [...new Set(res.body.rows.map((r: any) => r.workspaceId))];
    expect(workspaces).toEqual([WS_A]);
    // Tenant B's row must be ABSENT, not merely unshown.
    expect(JSON.stringify(res.body.rows)).not.toContain("tenantB-eticket.pdf");
    expect(JSON.stringify(res.body.rows)).not.toContain(WS_B);
  });
});

// Layer 2, tested directly against the scope/filter functions rather than
// through the route. Going through the route would only ever re-observe the
// 403 from layer 1, which proves nothing about what the query would have been
// — so these call the exported functions with a synthetic req instead.
describe("scope layering — layer 2 holds independently of the route guard", () => {
  it("a non-SuperAdmin's scope is their own workspace, never {}", () => {
    const scope = extractedDocScope({ user: TENANT_ADMIN, workspaceObjectId: WS_A });
    expect(scope).toEqual({ workspaceId: WS_A });
  });

  it("a real SuperAdmin's scope is an explicit, empty object", () => {
    const scope = extractedDocScope({ user: SUPERADMIN, workspaceObjectId: undefined });
    expect(scope).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(scope, "workspaceId")).toBe(false);
  });

  it("tenantScope THROWS for a non-SuperAdmin with no workspace, rather than widening", () => {
    // The F-01 failure mode is returning undefined here and letting Mongoose
    // strip the key. It must throw instead.
    expect(() => extractedDocScope({ user: TENANT_ADMIN, workspaceObjectId: undefined }))
      .toThrowError(/workspace context missing/i);
  });

  it("a caller-supplied workspaceId cannot widen a tenant caller's own scope", () => {
    // Tenant A asks for tenant B's data. The tenancy clause is applied last,
    // so the final filter must still pin A.
    const filter = buildFilter({
      user: TENANT_ADMIN,
      workspaceObjectId: WS_A,
      query: { workspaceId: WS_B },
    });
    expect(String(filter.workspaceId)).toBe(WS_A);
    expect(String(filter.workspaceId)).not.toBe(WS_B);
  });

  it("a SuperAdmin's narrowing survives the same ordering", () => {
    const filter = buildFilter({
      user: SUPERADMIN,
      workspaceObjectId: undefined,
      query: { workspaceId: WS_B },
    });
    expect(String(filter.workspaceId)).toBe(WS_B);
  });
});

describe("export", () => {
  it("CSV export contains exactly the list's rows, and no more", async () => {
    const list = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");
    const csv = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents/export?format=csv");

    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);

    const dataLines = csv.text.trim().split("\n").slice(1); // drop header
    expect(dataLines).toHaveLength(list.body.rows.length);

    // Every passenger on the multi-pax tenant-A document is present, and each
    // carries its own ticket number.
    expect(csv.text).toContain("Mr A One");
    expect(csv.text).toContain("Mrs A Two");
    expect(csv.text).toContain("098-1111111111");
    expect(csv.text).toContain("098-2222222222");
  });

  it("export is refused for a non-SuperAdmin and leaks nothing", async () => {
    const res = await request(appAs(TENANT_ADMIN, WS_A)).get(
      "/api/admin/extracted-documents/export?format=csv",
    );
    expect(res.status).toBe(403);
    expect(res.text).not.toContain("tenantA-eticket.pdf");
    expect(res.text).not.toContain("tenantB-eticket.pdf");
  });

  it("export honours the same filters as the list", async () => {
    const res = await request(appAs(SUPERADMIN)).get(
      "/api/admin/extracted-documents/export?format=csv&status=failed",
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("tenantB-eticket.pdf"); // the failed one
    expect(res.text).not.toContain("tenantA-eticket.pdf"); // extracted, filtered out
  });
});

describe("flattening", () => {
  it("emits one row per passenger, and still emits a row for a document with no flightRows", async () => {
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");
    const rows = res.body.rows;

    // docA has 2 passengers, docB has none but must not vanish.
    expect(rows).toHaveLength(3);
    const failedRow = rows.find((r: any) => r.status === "failed");
    expect(failedRow).toBeTruthy();
    expect(failedRow.passengerName).toBe("");
    expect(failedRow.originalFilename).toBe("tenantB-eticket.pdf");
  });

  it("resolves workspace name and booking ref as labels for ids already on the row", async () => {
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");
    const a = res.body.rows.find((r: any) => r.workspaceId === WS_A);
    expect(a.workspace).toBe("Tenant A Pvt Ltd");
    expect(a.bookingRef).toBe("MB-A-0001");
    // Never a raw id — the symptom this fix exists to remove.
    expect(a.workspace).not.toMatch(/^[a-f0-9]{24}$/);
  });

  it("resolves the workspace label out of CUSTOMER-space, not CustomerWorkspace", async () => {
    customerFindArgs.length = 0;
    workspaceFindSpy.mockClear();
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");

    // The lookup went to `customers`, keyed on the ids actually stored.
    expect(customerFindArgs).toHaveLength(1);
    expect(customerFindArgs[0]._id.$in.map(String).sort()).toEqual([WS_A, WS_B].sort());
    // And CustomerWorkspace was not consulted for the label at all.
    expect(workspaceFindSpy).not.toHaveBeenCalled();

    const labels = [...new Set(res.body.rows.map((r: any) => r.workspace))].sort();
    expect(labels).toEqual(["Tenant A Pvt Ltd", "Tenant B Pvt Ltd"]);
  });

  it("uses Customer's own name precedence: legalName, then companyName, then name", async () => {
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");
    // WS_A has all three set — legalName must win.
    expect(res.body.rows.find((r: any) => r.workspaceId === WS_A).workspace).toBe("Tenant A Pvt Ltd");
    // WS_B has no legalName — companyName must win over name.
    expect(res.body.rows.find((r: any) => r.workspaceId === WS_B).workspace).toBe("Tenant B Pvt Ltd");
  });

  it("does not ship extractedJson to the client", async () => {
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");
    expect(JSON.stringify(res.body)).not.toContain("extractedJson");
  });
});

// Carbon Engine Phase 1 — the join from CarbonRecord onto the flattened rows.
//
// The thing worth testing is not that a number appears, but that a REFUSAL to
// produce one survives the join: an Insufficient Data row must arrive at the
// client (and at Excel) as an absent value, never as a zero that a SUM would
// silently swallow.
describe("carbon columns", () => {
  it("joins each carbon result onto its own passenger and segment", async () => {
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");

    const p0 = res.body.rows.find((r: any) => r.passengerName === "Mr A One");
    expect(p0.carbonStatus).toBe("calculated");
    expect(p0.carbonConfidence).toBe("high");
    expect(p0.distanceKm).toBe(1148.2);
    expect(p0.emissionFactor).toBe(0.10916);
    expect(p0.factorVersion).toBe("DEFRA-2026-v1");
    expect(p0.co2eKg).toBe(125.34);
    expect(p0.methodology).toContain("CO2e =");

    // The second passenger gets ITS OWN record, not the first one's.
    const p1 = res.body.rows.find((r: any) => r.passengerName === "Mrs A Two");
    expect(p1.carbonStatus).toBe("insufficient_data");
    expect(p1.co2eKg).toBeNull();
  });

  it("an Insufficient Data row carries nulls, never zeros", async () => {
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");
    const p1 = res.body.rows.find((r: any) => r.passengerName === "Mrs A Two");

    expect(p1.co2eKg).toBeNull();
    expect(p1.distanceKm).toBeNull();
    expect(p1.emissionFactor).toBeNull();
    expect(p1.co2eKg).not.toBe(0);
    expect(p1.distanceKm).not.toBe(0);
    // ...and it says why, rather than leaving the reader to guess.
    expect(p1.methodology).toContain("could not be resolved");
  });

  it("a flight row with no carbon record yet reads as not_calculated, not as zero", async () => {
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");
    // docB is a flight document with no flightRows and so no carbon record.
    const failed = res.body.rows.find((r: any) => r.originalFilename === "tenantB-eticket.pdf");
    expect(failed.carbonStatus).toBe("not_calculated");
    expect(failed.co2eKg).toBeNull();
  });

  it("a non-flight document reads as mode_not_supported, and says so in words", async () => {
    store = [docHotel];
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");
    const hotel = res.body.rows[0];

    expect(hotel.carbonStatus).toBe("mode_not_supported");
    expect(hotel.co2eKg).toBeNull();
    expect(hotel.methodology).toMatch(/not yet supported/i);
  });

  it("aircraft type is present but empty — the extractor has no such field to report", async () => {
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");
    for (const row of res.body.rows) {
      expect(row).toHaveProperty("aircraftType");
      expect(row.aircraftType).toBe("");
    }
  });

  it("the carbon read is pinned to one calculation version and carries the same scope clause", async () => {
    await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");
    const filter = carbonFindFilters[0];

    // Pinned, so seeding a newer engine version cannot silently restate history.
    expect(filter.calculationVersion).toBe(CARBON_CALCULATION_VERSION);
    // Same F-01 posture as every other query in this file: for a SuperAdmin the
    // workspace key is genuinely ABSENT by decision, never present-but-undefined.
    expect(Object.prototype.hasOwnProperty.call(filter, "workspaceId")).toBe(false);
    expect(filter.workspaceId).toBeUndefined();
    // And it can only ever ask about documents the scoped list already returned.
    expect(filter.extractedDocumentId.$in.map(String)).toEqual([docA._id, docB._id]);
  });

  it("the export carries the carbon columns, with blanks where no number exists", async () => {
    const csv = await request(appAs(SUPERADMIN)).get(
      "/api/admin/extracted-documents/export?format=csv",
    );
    const [header, ...lines] = csv.text.trim().split("\n");

    for (const col of ["Distance (km)", "Aircraft Type", "Emission Factor", "Factor Version",
                       "CO2e (kg)", "Carbon Confidence", "Carbon Status", "Calculation Methodology"]) {
      expect(header).toContain(col);
    }

    const priced = lines.find((l) => l.includes("Mr A One"))!;
    expect(priced).toContain("1148.2");
    expect(priced).toContain("0.10916");
    expect(priced).toContain("125.34");
    expect(priced).toContain("high");

    // The refused row must reach the spreadsheet as empty cells — a "0" here
    // would be indistinguishable from a real measurement once summed. The six
    // value columns (distance, aircraft, factor, version, CO2e) run empty right
    // up to the confidence column.
    const refused = lines.find((l) => l.includes("Mrs A Two"))!;
    expect(refused).toContain(",,,,,,insufficient,insufficient_data,");
    expect(refused).not.toContain(",0,,");
    expect(refused).not.toContain(",0.0,");
  });

  it("every row exposes the grain the carbon record is keyed on", async () => {
    const res = await request(appAs(SUPERADMIN)).get("/api/admin/extracted-documents");
    const p1 = res.body.rows.find((r: any) => r.passengerName === "Mrs A Two");
    expect(p1.passengerIndex).toBe(1);
    expect(p1.segmentIndex).toBe(0);
  });
});
