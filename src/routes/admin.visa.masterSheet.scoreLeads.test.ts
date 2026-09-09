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

/* The caller's identity, swappable per test.
 *
 * It has to be STABLE within a test, unlike the throwaway id this used to
 * mint per request, because the contact-masking probe
 * (services/capabilityProbe.ts) looks the caller up in UserPermission.
 * Roles stay ["ADMIN"] and never SUPERADMIN — an L8 bypasses the probe by
 * design, so a superadmin fixture would make every masking assertion here
 * pass for the wrong reason. */
const UNGRANTED_USER = new mongoose.Types.ObjectId().toString();
const GRANTED_USER = new mongoose.Types.ObjectId().toString();
let currentUserId = UNGRANTED_USER;

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: currentUserId, roles: ["ADMIN"] };
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
const { default: VisaD2CLead } = await import("../models/VisaD2CLead.js");
const { default: Consumer } = await import("../models/Consumer.js");
const { UserPermission } = await import("../models/UserPermission.js");

const app = express();
app.use(express.json());
app.use("/api/admin/visa/master-sheet", masterSheetRouter);

const get = (qs = "") => request(app).get("/api/admin/visa/master-sheet/score-leads" + qs);
/** The apply-funnel tab — the other half of the side door. */
const getApply = (qs = "") => request(app).get("/api/admin/visa/master-sheet" + qs);

/**
 * Gives GRANTED_USER a real consumerContactPII grant and becomes them.
 *
 * A REAL UserPermission document, not a stubbed probe: the thing under
 * test is that holdsCapability's own query — status "active", the module
 * path, the access ordering — actually finds the grant, and a mocked probe
 * would assert nothing but that the route calls a function.
 */
async function becomeGrantedReader() {
  await UserPermission.create({
    userId: GRANTED_USER,
    email: "granted.reader@plumtrips.com",
    workspaceId: new mongoose.Types.ObjectId().toString(),
    universe: "STAFF",
    status: "active",
    level: { code: "L4", name: "Ops", designation: "Ops" },
    modules: { consumerContactPII: { access: "READ", scope: "ALL" } },
    grantedBy: new mongoose.Types.ObjectId().toString(),
  } as any);
  currentUserId = GRANTED_USER;
}

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
  await VisaD2CLead.deleteMany({});
  await Consumer.deleteMany({});
  await UserPermission.deleteMany({});
  // Every test starts as the reader who holds nothing — the default the
  // masking has to be correct for.
  currentUserId = UNGRANTED_USER;
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
      // MASKED, because this reader holds no consumerContactPII. It used to
      // be the full address here — see the masking describe block below.
      email: "s•••@example.com",
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

  it("searches name and destination — and treats the query as text, not a regex", async () => {
    await seed();

    expect((await get("?q=Another")).body.rows).toHaveLength(1);
    expect((await get("?q=Australia")).body.rows).toHaveLength(1);
    /* Email is NOT searchable for this reader — see the search-oracle test
     * in the masking block below for why that is the point and not a
     * regression. A granted reader still gets the email clause. */
    expect((await get("?q=anonymous@example.com")).body.rows).toHaveLength(0);

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

/* ═════════════════════════════════════════════════════════════════════
 * CONTACT MASKING — THE SIDE DOOR, CLOSED
 * ═════════════════════════════════════════════════════════════════════
 * The unified /people route shipped masking contacts behind
 * consumerContactPII. These two per-funnel routes did not, and the console
 * renders all three side by side: the same ungranted reader saw
 * "i•••@gmail.com" on one tab and the full address on the next, about the
 * same person, on the same page.
 *
 * These tests are the reason that cannot come back. They assert the
 * DEFAULT (masked) on both endpoints, the grant lifting it on both, and
 * the search oracle — the subtler half, because an endpoint that masks the
 * value it returns while still letting you SEARCH on it has not withheld
 * the value, it has only made you ask twice.
 */
describe("contact masking — both per-funnel tabs, not just the unified sheet", () => {
  /** The apply funnel's rows come from a Consumer join, so it needs one. */
  async function seedApplyRow() {
    const consumer = await Consumer.create({
      email: "applicant@example.com",
      name: "Applicant Person",
      phone: "+919876544417",
      passwordHash: "x",
      tokenVersion: 0,
      status: "ACTIVE",
    } as any);
    await VisaD2CLead.create({
      consumerId: consumer._id,
      email: "applicant@example.com",
      workspaceId: new mongoose.Types.ObjectId(),
      destinationIso2: "TH",
      destinationName: "Thailand",
      purpose: "TOURIST",
    } as any);
    return consumer;
  }

  it("MASKS the score-lead address for a reader who holds nothing", async () => {
    await seed();

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.contactsMasked).toBe(true);
    expect(res.body.rows.map((r: any) => r.email).sort()).toEqual([
      "a•••@example.com",
      "a•••@example.com",
      "s•••@example.com",
    ]);

    /* The whole-body assertion, not just the column: a masked response
     * with the real value one field away has not masked anything. */
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain("signed.up@example.com");
    expect(serialised).not.toContain("anonymous@example.com");
    expect(serialised).not.toContain("another@example.com");
  });

  it("MASKS the apply-funnel address for a reader who holds nothing", async () => {
    await seedApplyRow();

    const res = await getApply();
    expect(res.status).toBe(200);
    expect(res.body.contactsMasked).toBe(true);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].consumer.email).toBe("a•••@example.com");
    // The name is deliberately NOT masked — it is what makes the row
    // readable, and knowing a name is not a way to reach anybody.
    expect(res.body.rows[0].consumer.name).toBe("Applicant Person");
    expect(JSON.stringify(res.body)).not.toContain("applicant@example.com");
    // And no phone leaks in through the join: this view never selected one.
    expect(JSON.stringify(res.body)).not.toContain("9876544417");
  });

  it("UNMASKS both tabs for a reader who holds consumerContactPII at READ", async () => {
    await seed();
    await seedApplyRow();
    await becomeGrantedReader();

    const score = await get();
    expect(score.body.contactsMasked).toBe(false);
    expect(score.body.rows.map((r: any) => r.email).sort()).toEqual([
      "anonymous@example.com",
      "another@example.com",
      "signed.up@example.com",
    ]);

    const apply = await getApply();
    expect(apply.body.contactsMasked).toBe(false);
    expect(apply.body.rows[0].consumer.email).toBe("applicant@example.com");
  });

  it("closes the search oracle: a masked reader cannot confirm an address through ?q=", async () => {
    await seed();

    /* The exact address, typed in full. A hit would tell this reader that
     * this precise person is in the funnel — recovering the value the mask
     * withholds, one guess at a time, with no rate limit and no audit
     * trail. Name and destination still search, because both are on screen
     * unmasked and searching them reveals nothing new. */
    expect((await get("?q=anonymous@example.com")).body.rows).toHaveLength(0);
    expect((await get("?q=signed.up")).body.rows).toHaveLength(0);
    expect((await get("?q=Another Person")).body.rows).toHaveLength(1);
    expect((await get("?q=Australia")).body.rows).toHaveLength(1);
  });

  it("keeps email searchable for a granted reader — it discloses nothing they cannot already read", async () => {
    await seed();
    await becomeGrantedReader();

    expect((await get("?q=anonymous@example.com")).body.rows).toHaveLength(1);
    expect((await get("?q=Another Person")).body.rows).toHaveLength(1);
  });

  it("does not let a REVOKED grant keep unmasking (status must be active)", async () => {
    await seed();
    await becomeGrantedReader();
    await UserPermission.updateOne({ userId: GRANTED_USER }, { $set: { status: "revoked" } });

    const res = await get();
    expect(res.body.contactsMasked).toBe(true);
    expect(res.body.rows.every((r: any) => r.email.includes("•"))).toBe(true);
  });
});
