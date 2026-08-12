// THE REPORTS WORKSPACE PICKER (2026-08-12).
//
// /admin/visa-reports shipped its workspace filter as a free-text box
// captioned "Paste a workspace ID". Ops has company names, not ObjectIds, so
// the filter was unusable and the reports were in practice
// all-workspaces-only. The fix is a picker on the frontend — and the claim
// this file exists to check is that the picker is WIRING, not a new contract:
//
//   · the list it renders comes from an endpoint gated exactly as the reports
//     are, so it grants nobody a workspace name they could not already read;
//   · the id it hands back drives the SAME ?workspaceId filter, to the same
//     rows, as a hand-pasted id always did.
//
// Both routers are mounted on one app precisely because that is the pair
// under test: two files that must agree about one id. Testing them apart
// would prove each half and miss the join.
//
// Real database (mongodb-memory-server), not the in-memory fakes
// admin.visa.reports.test.ts uses: the question here is whether a real
// workspaceId from one query matches a real workspaceId in another, which a
// fake collection cannot answer honestly.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

// requirePermission is deliberately NOT mocked — "gated the same as the
// reports surface" is the assertion, so the gate has to be the real one.
import reportsRouter from "./admin.visa.reports.js";
import rosterRouter from "./admin.visa.roster.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import TravellerProfile from "../models/TravellerProfile.js";
import VisaRequest from "../models/VisaRequest.js";
import VisaApplication from "../models/VisaApplication.js";
import User from "../models/User.js";
import { UserPermission } from "../models/UserPermission.js";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

let actor: { _id: mongoose.Types.ObjectId };

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(actor._id), sub: String(actor._id), roles: ["ADMIN"], email: "ops@plumtrips.com" };
    next();
  });
  // Reports first: its /reports/* routes match before the roster router's
  // router-level middleware can see them, so each half is exercised through
  // its own gate rather than through the other's.
  app.use("/", reportsRouter);
  app.use("/", rosterRouter);
  return app;
}

async function makeOpsUser(visaApplication: string) {
  const u = await User.create({
    name: "Ops Agent",
    email: `ops-${new mongoose.Types.ObjectId()}@plumtrips.com`,
    passwordHash: "x",
    workspaceId: new mongoose.Types.ObjectId(),
    roles: ["ADMIN"],
  });
  await UserPermission.create({
    userId: String(u._id),
    email: u.email,
    workspaceId: "ws",
    universe: "STAFF",
    source: "manual",
    status: "active",
    grantedBy: new mongoose.Types.ObjectId(),
    level: { code: "L6", name: "Admin", designation: "Admin" },
    modules: { visaApplication: { access: visaApplication, scope: "ALL" } },
  } as any);
  return u;
}

async function seedWorkspace(companyName: string, over: any = {}) {
  return CustomerWorkspace.create({
    companyName,
    customerId: `CUST-${new mongoose.Types.ObjectId()}`,
    ...over,
  } as any);
}

/** One workspace's worth of report data — a request, a traveller, one case. */
async function seedCase(workspaceId: any, over: any = {}) {
  const traveller = await TravellerProfile.create({
    workspaceId,
    travelerId: `T-${new mongoose.Types.ObjectId()}`,
    firstName: "Priya",
    lastName: "Sharma",
    createdBy: new mongoose.Types.ObjectId(),
    source: "MANUAL",
  });
  const req = await VisaRequest.create({
    workspaceId,
    raisedByUserId: new mongoose.Types.ObjectId(),
    destinationIso2: "FR",
    purpose: "BUSINESS",
    applicationIds: [],
  });
  return VisaApplication.create({
    workspaceId,
    requestId: req._id,
    travellerProfileId: traveller._id,
    ruleSnapshot: {
      ruleId: new mongoose.Types.ObjectId(),
      capturedAt: new Date(),
      destinationName: "France",
      isSchengen: true,
      productClass: "VISA",
      visaCategory: "STICKER",
      purpose: "BUSINESS",
      entryType: "SINGLE",
      serviceTier: "STANDARD",
      appointmentRequired: false,
      biometricsRequired: false,
      documentRequirements: [],
    },
    indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 1000 },
    status: "lodged",
    submittedAt: new Date(),
    ...over,
  });
}

/** Column 1 of the case-log CSV is "Workspace" — the company names exported. */
function workspaceColumn(csv: string): string[] {
  return csv
    .trim()
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((line) => line.split(",")[1]);
}

beforeEach(async () => {
  await Promise.all([
    CustomerWorkspace.deleteMany({}),
    TravellerProfile.deleteMany({}),
    VisaRequest.deleteMany({}),
    VisaApplication.deleteMany({}),
    User.deleteMany({}),
    UserPermission.deleteMany({}),
  ]);
  const u = await makeOpsUser("READ");
  actor = { _id: u._id as mongoose.Types.ObjectId };
});

describe("workspace picker — the list, and its gate", () => {
  it("returns id and companyName for each workspace, which is all the picker needs", async () => {
    const acme = await seedWorkspace("Acme Travel");
    await seedWorkspace("Beta Industries");

    const res = await request(makeApp()).get("/workspaces");

    expect(res.status).toBe(200);
    const names = res.body.workspaces.map((w: any) => w.companyName).sort();
    expect(names).toEqual(["Acme Travel", "Beta Industries"]);
    const row = res.body.workspaces.find((w: any) => w.companyName === "Acme Travel");
    expect(row.workspaceId).toBe(String(acme._id));
  });

  it("is GATED by visaApplication — the same permission each report endpoint applies", async () => {
    await seedWorkspace("Acme Travel");
    const u = await makeOpsUser("NONE");
    actor = { _id: u._id as mongoose.Types.ObjectId };

    // The point of the pairing: whoever is refused the list is refused the
    // report too, so the picker cannot become a way to enumerate tenant names
    // that the reports themselves would not have disclosed.
    const list = await request(makeApp()).get("/workspaces");
    const report = await request(makeApp()).get("/reports/case-log").query({ format: "csv" });

    expect(list.status).toBe(403);
    expect(report.status).toBe(403);
  });

  it("OPENS for READ on both, so a reader of the reports is a reader of the list", async () => {
    await seedWorkspace("Acme Travel");

    const list = await request(makeApp()).get("/workspaces");
    const report = await request(makeApp()).get("/reports/case-log").query({ format: "csv" });

    expect(list.status).toBe(200);
    expect(report.status).toBe(200);
  });

  it("omits SAAS_HRMS tenants — they have no visa module, so never a row in any of these reports", async () => {
    await seedWorkspace("Acme Travel");
    await seedWorkspace("HRMS Only Ltd", { tenantType: "SAAS_HRMS" });

    const res = await request(makeApp()).get("/workspaces");
    const names = res.body.workspaces.map((w: any) => w.companyName);
    expect(names).toContain("Acme Travel");
    expect(names).not.toContain("HRMS Only Ltd");
  });

  it("lists the house Plumtrips workspace, which is where production visa cases actually sit", async () => {
    await seedWorkspace("Plumtrips");
    const res = await request(makeApp()).get("/workspaces");
    // A picker that hid it would offer no way to filter to the one workspace
    // holding every real case.
    expect(res.body.workspaces.map((w: any) => w.companyName)).toContain("Plumtrips");
  });
});

describe("workspace picker — the id it produces drives the EXISTING filter", () => {
  it("narrows the case log to exactly that workspace, end to end", async () => {
    const acme = await seedWorkspace("Acme Travel");
    const beta = await seedWorkspace("Beta Industries");
    await seedCase(acme._id);
    await seedCase(beta._id);

    // Exactly what the picker does: find the row by the name a human read,
    // then hand its id to the filter that already existed.
    const list = await request(makeApp()).get("/workspaces");
    const chosen = list.body.workspaces.find((w: any) => w.companyName === "Acme Travel");

    const res = await request(makeApp())
      .get("/reports/case-log")
      .query({ format: "csv", workspaceId: chosen.workspaceId });

    expect(res.status).toBe(200);
    expect(workspaceColumn(res.text)).toEqual(["Acme Travel"]);
  });

  it("produces the same rows a hand-pasted ObjectId always did — the contract is unchanged", async () => {
    const acme = await seedWorkspace("Acme Travel");
    const beta = await seedWorkspace("Beta Industries");
    await seedCase(acme._id);
    await seedCase(beta._id);

    const list = await request(makeApp()).get("/workspaces");
    const fromPicker = list.body.workspaces.find((w: any) => w.companyName === "Acme Travel").workspaceId;

    const pasted = await request(makeApp())
      .get("/reports/case-log")
      .query({ format: "csv", workspaceId: String(acme._id) });
    const picked = await request(makeApp())
      .get("/reports/case-log")
      .query({ format: "csv", workspaceId: fromPicker });

    expect(fromPicker).toBe(String(acme._id));
    expect(picked.text).toBe(pasted.text);
  });

  it("leaving the picker on 'All workspaces' still exports every workspace, as before", async () => {
    const acme = await seedWorkspace("Acme Travel");
    const beta = await seedWorkspace("Beta Industries");
    await seedCase(acme._id);
    await seedCase(beta._id);

    // The picker's cleared state sends no workspaceId at all — not an empty
    // string, which would have to be parsed away server-side.
    const res = await request(makeApp()).get("/reports/case-log").query({ format: "csv" });
    expect(workspaceColumn(res.text).sort()).toEqual(["Acme Travel", "Beta Industries"]);
  });

  it("still rejects a workspaceId that is not an ObjectId — validation untouched", async () => {
    const res = await request(makeApp())
      .get("/reports/case-log")
      .query({ format: "csv", workspaceId: "Acme Travel" });

    // Nothing about the picker relaxes this: the parameter is still an id, and
    // a company name pasted into it is still an error rather than a silent
    // all-workspaces export.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });
});
