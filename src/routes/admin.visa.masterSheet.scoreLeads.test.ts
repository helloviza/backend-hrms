// apps/backend/src/routes/admin.visa.masterSheet.scoreLeads.test.ts
//
// GET /api/admin/visa/master-sheet/score-leads — the Visa Score Calc tab.
//
// ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────
// The apply-funnel endpoint next to it has no test, and that is a gap
// rather than a precedent worth copying. This one is new code reading a
// new collection, and the two things it has to get right are things a
// typecheck cannot see: that the SUMMARY counts the whole filtered set
// rather than the page, and that nothing sensitive can be read back
// through it.
//
// Real persistence (mongodb-memory-server), not a query emulator: the
// shaping this route does is mostly about schema defaults and casing —
// hadAccount, checkCount, the utm sub-document — and a literal fixture
// would assert the defaults I typed rather than the ones the schema
// applies.
//
// requireAuth and requirePermission ARE mocked. The guard is identical to
// the apply endpoint's — visaApplication READ, asserted here only as "the
// same middleware is applied" — and re-proving the permission system
// through a second route would be testing middleware/requirePermission.ts
// in the wrong file.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "b2b-test-secret";
process.env.CONSUMER_JWT_SECRET ||= "consumer-distinct-test-secret";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: new mongoose.Types.ObjectId().toString(), roles: ["ADMIN"] };
    next();
  },
}));

/** Records what the route asked for, so the guard can be asserted. */
const asked: Array<[string, string]> = [];
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: (resource: string, action: string) => {
    asked.push([resource, action]);
    return (_req: any, _res: any, next: any) => next();
  },
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));

const { default: masterSheetRouter } = await import("./admin.visa.masterSheet.js");
const { default: VisaScoreLead } = await import("../models/VisaScoreLead.js");

const app = express();
app.use(express.json());
app.use("/api/admin/visa/master-sheet", masterSheetRouter);

const get = (qs = "") => request(app).get("/api/admin/visa/master-sheet/score-leads" + qs);

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await VisaScoreLead.deleteMany({});
});

/** Distinct destinations, because the collection is keyed on (email, iso2). */
async function seed() {
  const consumerId = new mongoose.Types.ObjectId();
  await VisaScoreLead.create([
    {
      email: "signed.up@example.com",
      name: "Signed Up",
      consumerId,
      hadAccount: true,
      destinationIso2: "US",
      destinationName: "United States",
      score: 712,
      band: "Good",
      rangeLow: 690,
      rangeHigh: 734,
      checkCount: 3,
      lastCheckedAt: new Date("2026-09-05T10:00:00Z"),
    },
    {
      email: "anonymous@example.com",
      name: null,
      consumerId: null,
      hadAccount: false,
      destinationIso2: "AU",
      destinationName: "Australia",
      score: 640,
      band: "Fair",
      checkCount: 1,
      lastCheckedAt: new Date("2026-09-06T10:00:00Z"),
      utm: { source: "google", medium: "cpc", campaign: "visa-score", content: "", term: "" },
    },
    {
      email: "another@example.com",
      name: "Another Person",
      consumerId: null,
      hadAccount: false,
      destinationIso2: "AE",
      destinationName: "United Arab Emirates",
      score: 588,
      band: "Weak",
      checkCount: 2,
      lastCheckedAt: new Date("2026-09-07T10:00:00Z"),
    },
  ]);
  return { consumerId };
}

describe("GET /master-sheet/score-leads — the guard", () => {
  it("is behind the SAME permission as the apply funnel — visaApplication READ", () => {
    /* Recorded at module load, when the router registered its handlers.
     * Both endpoints ask for it: splitting the two would mean an ops user
     * who can see somebody's application cannot see that they measured
     * their odds first. */
    expect(asked).toContainEqual(["visaApplication", "READ"]);
    expect(
      asked.filter(([r, a]) => r === "visaApplication" && a === "READ").length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("GET /master-sheet/score-leads — the rows", () => {
  it("returns the sheet newest-checked first, with the account split named", async () => {
    await seed();

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rows).toHaveLength(3);

    // Sorted on lastCheckedAt descending — the sheet is a worklist.
    expect(res.body.rows.map((r: any) => r.destinationIso2)).toEqual(["AE", "AU", "US"]);

    /* THE NUMBER THE TAB EXISTS FOR. Two of these three people have no
     * account: that is the marketable population, and it is a computed
     * summary rather than something to count down a column. */
    expect(res.body.summary).toMatchObject({
      total: 3,
      withAccount: 1,
      withoutAccount: 2,
      repeatCheckers: 2,
    });
  });

  it("shapes a row into exactly the marketing fields — and no answers", async () => {
    const { consumerId } = await seed();

    const res = await get("?destination=us");
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);

    const row = res.body.rows[0];
    expect(row).toMatchObject({
      email: "signed.up@example.com",
      name: "Signed Up",
      consumerId: String(consumerId),
      hadAccount: true,
      destinationIso2: "US",
      destinationName: "United States",
      score: 712,
      band: "Good",
      rangeLow: 690,
      rangeHigh: 734,
      checkCount: 3,
    });

    /* DPDP, read side. The collection has no answers path, so this cannot
     * regress without a schema change — which is precisely why it is
     * asserted at the surface a human reads rather than only at the
     * writer. */
    const serialised = JSON.stringify(res.body);
    for (const key of ["compliance", "character", "answers", "responses"]) {
      expect(serialised).not.toContain(key);
    }
  });

  it("filters on hadAccount, and the summary follows the filter", async () => {
    await seed();

    const res = await get("?hadAccount=false");
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows.every((r: any) => r.hadAccount === false)).toBe(true);

    // Scoped to the filtered set, not to the collection.
    expect(res.body.summary).toMatchObject({ total: 2, withAccount: 0, withoutAccount: 2 });
  });

  it("searches name, email and destination — and treats the query as text, not a regex", async () => {
    await seed();

    expect((await get("?q=Another")).body.rows).toHaveLength(1);
    expect((await get("?q=anonymous@example.com")).body.rows).toHaveLength(1);
    expect((await get("?q=Australia")).body.rows).toHaveLength(1);

    /* A caller typing ".*" means the two characters, not "match
     * everything" — the escape in the route is what makes that true, and
     * an unescaped build of this query would return all three. */
    const wild = await get("?q=" + encodeURIComponent(".*"));
    expect(wild.status).toBe(200);
    expect(wild.body.rows).toHaveLength(0);
  });

  it("counts the WHOLE filtered set even when the page is smaller", async () => {
    await seed();

    const res = await get("?limit=1");
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.summary.total).toBe(3);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 1, total: 3, totalPages: 3 });
  });

  it("renders an empty sheet as an empty sheet, not an error", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.summary).toMatchObject({ total: 0, withAccount: 0, withoutAccount: 0 });
  });
});
