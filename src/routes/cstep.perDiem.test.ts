// apps/backend/src/routes/cstep.perDiem.test.ts
//
// CSTEP per-traveller per diem. A traveller carries its own ₹/day rate per
// trip type (perDiemRateDomesticInr / perDiemRateInternationalInr), and
// settlement/start seeds settlement.perDiem.rate from it — the trip type's
// own rate first, then CstepPerDiemPolicy, then 0. Per-diem days are the
// trip's inclusive day count less the declared personal days, floored at 0.
// The rates are set by a CSTEP Admin only: on the single create/edit routes
// (a change from anyone else is 403; resending the stored value is a no-op),
// and through the CSTEP bulk import (ignored, with a note, for a non-admin
// importer; blank keeps the stored rate). The CSTEP export carries both
// columns. Claims still have no per diem (409).
// Per Diem Eligible (Yes/No) on every Tour Proposal / Event Request: No seeds
// a zero per diem with no rate/day lookup; a missing flag reads as Yes.
// Personal days are subtracted on domestic tours and events too.
//
// Real: workspace.travellers + cstep routers, models, in-memory Mongo
//   REPLICA SET on a fresh database, cstep_qc_perdiem.
// Stubbed: auth/workspace middleware (x-test-user / x-test-ws headers), S3,
//   mail, the CSTEP PDF helpers.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_perdiem";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return {};
    }
  },
  PutObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async (args: any) => ({ key: `${args.keyPrefix}/qc` })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({ key: "qc-packet" })) }));

const { default: travellerRouter } = await import("./workspace.travellers.js");
const { default: cstepRouter, findDefaultPerDiemRate, computePerDiemDays, isPerDiemEligible } = await import("./cstep.js");

const DB = "cstep_qc_perdiem";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

// C = CSTEP workspace, P = CSTEP workspace with NO policy rows, N = ordinary workspace.
const WS = { C: oid(), P: oid(), N: oid() };
const CUST = { C: oid(), P: oid(), N: oid() };
const WS_CUSTOMER: Record<string, string> = {
  [String(WS.C)]: String(CUST.C),
  [String(WS.P)]: String(CUST.P),
  [String(WS.N)]: String(CUST.N),
};
const U = { leaderC: oid(), leaderN: oid() };
const PROJECT_C = oid();

const app = express();
app.use(express.json());
app.use((req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  const ws = String(req.headers["x-test-ws"] || WS.C);
  req.workspaceObjectId = new mongoose.Types.ObjectId(ws);
  req.workspaceId = ws;
  req.workspace = { _id: req.workspaceObjectId, customerId: WS_CUSTOMER[ws], status: "ACTIVE" };
  next();
});
app.use("/api/travellers", travellerRouter);
app.use("/api/cstep", cstepRouter);

const who = (id: mongoose.Types.ObjectId, ws: mongoose.Types.ObjectId, extra: any = {}) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles: ["CUSTOMER"], workspaceId: String(ws), ...extra,
});
// The same workspace leader twice: once as the JWT carries a CSTEP Admin
// (customerMemberRole), once without it — so the traveller write-RBAC is
// identical and only the CSTEP Admin gate differs.
const ACT = {
  admin: who(U.leaderC, WS.C, { customerMemberRole: "WORKSPACE_LEADER" }),
  nonAdmin: who(U.leaderC, WS.C),
  leaderN: who(U.leaderN, WS.N, { customerMemberRole: "WORKSPACE_LEADER" }),
};
const call = (method: "get" | "post" | "put" | "patch", as: any, ws: mongoose.Types.ObjectId, path: string) =>
  request(app)[method](path).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(ws));
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const csvFile = (lines: string[]) => Buffer.from(lines.join("\n") + "\n");
const bulk = (as: any, ws: mongoose.Types.ObjectId, step: "preview" | "commit", lines: string[]) =>
  call("post", as, ws, `/api/travellers/bulk/${step}`).attach("file", csvFile(lines), { filename: "t.csv", contentType: "text/csv" });
const profile = (filter: any) => col("travellerprofiles").findOne(filter) as Promise<any>;
const HDR = "Employee ID,First Name,Last Name,Email,Per Diem Domestic (₹/day),Per Diem International (₹/day)";

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri(DB);

  // Step 0 gate: a local server and an empty database, or nothing is seeded.
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  const existing = await mongoose.connection.db!.listCollections().toArray();
  if (existing.length) throw new Error(`Step 0: refusing to seed — ${DB} is not empty (${existing.length} collections)`);

  await mongoose.connection.syncIndexes();
  await col("cstepprojects").insertOne({ _id: PROJECT_C, workspaceId: WS.C, projectCode: "PRJ-QC", projectName: "QC Project", isActive: true } as any);
  await col("customerworkspaces").insertMany([
    { _id: WS.C, customerId: String(CUST.C), companyName: "QC CSTEP", status: "ACTIVE", config: { features: { cstepEnabled: true } } },
    { _id: WS.P, customerId: String(CUST.P), companyName: "QC CSTEP no policy", status: "ACTIVE", config: { features: { cstepEnabled: true } } },
    { _id: WS.N, customerId: String(CUST.N), companyName: "Northwind", status: "ACTIVE", config: { features: { cstepEnabled: false } } },
  ] as any[]);
  await col("customers").insertMany([
    { _id: CUST.C, name: "Centre Study Labs", legalName: "Centre Study Labs" },
    { _id: CUST.P, name: "Policy-less Labs", legalName: "Policy-less Labs" },
    { _id: CUST.N, name: "Northwind Traders", legalName: "Northwind Traders" },
  ] as any[]);
  await col("customermembers").insertMany([
    { customerId: String(CUST.C), email: ACT.admin.email, role: "WORKSPACE_LEADER", isActive: true, travelerId: "" },
    { customerId: String(CUST.N), email: ACT.leaderN.email, role: "WORKSPACE_LEADER", isActive: true, travelerId: "" },
  ] as any[]);
  await col("users").insertMany([
    { _id: U.leaderC, email: ACT.admin.email, roles: ["CUSTOMER"], workspaceId: WS.C, customerId: String(CUST.C) },
    { _id: U.leaderN, email: ACT.leaderN.email, roles: ["CUSTOMER"], workspaceId: WS.N, customerId: String(CUST.N) },
  ] as any[]);
  // Workspace C's policy: domestic ₹800, international (no country) ₹3000.
  await col("cstepperdiempolicies").insertMany([
    { workspaceId: WS.C, tripType: "DOMESTIC", rate: 800, currency: "INR", createdBy: U.leaderC },
    { workspaceId: WS.C, tripType: "INTERNATIONAL", rate: 3000, currency: "INR", createdBy: U.leaderC },
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

const seedTraveller = async (ws: mongoose.Types.ObjectId, travelerId: string, rates: any = {}) => {
  const _id = oid();
  await col("travellerprofiles").insertOne({
    _id, workspaceId: ws, travelerId, employeeId: travelerId, firstName: "T", lastName: travelerId,
    isActive: true, source: "MANUAL", createdBy: U.leaderC, ...rates,
  } as any);
  return _id;
};

/** A Tour Proposal already at REPORT_SUBMITTED — the state settlement/start needs. */
const seedRequest = async (travelerProfileId: mongoose.Types.ObjectId, over: any = {}) => {
  const _id = oid();
  await col("csteptravelrequests").insertOne({
    _id, workspaceId: WS.C, travelerProfileId, formType: "TOUR_PROPOSAL", status: "REPORT_SUBMITTED",
    type: "DOMESTIC", purpose: "QC trip", projectId: PROJECT_C, departureDate: "2026-11-02", returnDate: "2026-11-06",
    createdBy: U.leaderC, ...over,
  } as any);
  return _id;
};

/* ── the rate lookup + day count ─────────────────────────────────────── */

describe("findDefaultPerDiemRate — traveller first, then policy, then nothing", () => {
  const both = { perDiemRateDomesticInr: 1500, perDiemRateInternationalInr: 6000 };

  it("picks the traveller's own rate for the trip type", async () => {
    expect(await findDefaultPerDiemRate(WS.C, { type: "DOMESTIC" }, both)).toEqual({ rate: 1500, currency: "INR" });
    expect(await findDefaultPerDiemRate(WS.C, { type: "INTERNATIONAL", countries: [{ country: "France" }] }, both)).toEqual({
      rate: 6000,
      currency: "INR",
    });
  });

  it("a deliberate ₹0/day of the traveller's own is honoured, not treated as unset", async () => {
    expect(await findDefaultPerDiemRate(WS.C, { type: "DOMESTIC" }, { perDiemRateDomesticInr: 0 })).toEqual({ rate: 0, currency: "INR" });
  });

  it("falls back to the policy when the traveller has no rate for THIS trip type", async () => {
    expect(await findDefaultPerDiemRate(WS.C, { type: "DOMESTIC" }, { perDiemRateInternationalInr: 6000 })).toMatchObject({ rate: 800 });
    expect(await findDefaultPerDiemRate(WS.C, { type: "INTERNATIONAL" }, { perDiemRateDomesticInr: 1500 })).toMatchObject({ rate: 3000 });
    expect(await findDefaultPerDiemRate(WS.C, { type: "DOMESTIC" }, null)).toMatchObject({ rate: 800 });
  });

  it("returns null with no traveller rate and no policy (the caller seeds 0)", async () => {
    expect(await findDefaultPerDiemRate(WS.P, { type: "DOMESTIC" }, {})).toBeNull();
    expect(await findDefaultPerDiemRate(WS.P, { type: "INTERNATIONAL" }, undefined)).toBeNull();
  });
});

describe("computePerDiemDays — trip days less personal days, floored at 0", () => {
  const trip = { departureDate: "2026-11-02", returnDate: "2026-11-06" }; // 5 days, both ends counted

  it("keeps the both-ends count when no personal days are declared", () => {
    expect(computePerDiemDays(trip)).toBe(5);
    expect(computePerDiemDays({ departureDate: "2026-11-02", returnDate: "2026-11-02" })).toBe(1);
  });

  it("subtracts the declared count, or the listed dates when no count was typed", () => {
    expect(computePerDiemDays({ ...trip, personalDays: { count: 2 } })).toBe(3);
    expect(computePerDiemDays({ ...trip, personalDays: { dates: ["2026-11-03"] } })).toBe(4);
  });

  it("never goes below 0", () => {
    expect(computePerDiemDays({ ...trip, personalDays: { count: 9 } })).toBe(0);
  });

  it("no trip dates stays 0", () => {
    expect(computePerDiemDays({ personalDays: { count: 1 } })).toBe(0);
    expect(computePerDiemDays({})).toBe(0);
  });
});

/* ── settlement/start seeds from the traveller ──────────────────────── */

describe("settlement/start — the traveller's rate seeds settlement.perDiem", () => {
  it("domestic: traveller's own rate × (trip days − personal days) flows into buckets and totals", async () => {
    const t = await seedTraveller(WS.C, "PD-001", { perDiemRateDomesticInr: 1200, perDiemRateInternationalInr: 5000 });
    const id = await seedRequest(t, { personalDays: { count: 1, dates: ["2026-11-04"] } });
    const r = ok(await call("post", ACT.admin, WS.C, `/api/cstep/requests/${id}/settlement/start`));
    const s = r.body.settlement;
    expect(s.perDiem).toMatchObject({ computedDays: 4, days: 4, rate: 1200, currency: "INR", amountInr: 4800 });
    expect(s.buckets.perDiem).toBe(4800);
    expect(s.totalCostOfTour).toBe(4800);
    expect(s.amountClaimed).toBe(4800);
  });

  it("international: the traveller's international rate, not the domestic one", async () => {
    const t = await seedTraveller(WS.C, "PD-002", { perDiemRateDomesticInr: 1200, perDiemRateInternationalInr: 5000 });
    const id = await seedRequest(t, { type: "INTERNATIONAL", countries: [{ country: "France" }] });
    const s = ok(await call("post", ACT.admin, WS.C, `/api/cstep/requests/${id}/settlement/start`)).body.settlement;
    expect(s.perDiem).toMatchObject({ days: 5, rate: 5000, amountInr: 25000 });
  });

  it("no rate of their own: the policy rate, exactly as before", async () => {
    const t = await seedTraveller(WS.C, "PD-003");
    const id = await seedRequest(t);
    const s = ok(await call("post", ACT.admin, WS.C, `/api/cstep/requests/${id}/settlement/start`)).body.settlement;
    expect(s.perDiem).toMatchObject({ days: 5, rate: 800, amountInr: 4000 });
  });

  it("personal days beyond the trip floor at 0 days and ₹0", async () => {
    const t = await seedTraveller(WS.C, "PD-004", { perDiemRateDomesticInr: 1200 });
    const id = await seedRequest(t, { personalDays: { count: 7 } });
    const s = ok(await call("post", ACT.admin, WS.C, `/api/cstep/requests/${id}/settlement/start`)).body.settlement;
    expect(s.perDiem).toMatchObject({ computedDays: 0, days: 0, rate: 1200, amountInr: 0 });
  });

  it("the Official's rate + days override still works on top of the seeded rate", async () => {
    const t = await seedTraveller(WS.C, "PD-005", { perDiemRateDomesticInr: 1200 });
    const id = await seedRequest(t);
    ok(await call("post", ACT.admin, WS.C, `/api/cstep/requests/${id}/settlement/start`));
    const r = ok(
      await call("patch", ACT.admin, WS.C, `/api/cstep/requests/${id}/settlement/perdiem`).send({
        rate: 1000,
        overrideDays: 3,
        overrideReason: "Left early",
      }),
    );
    expect(r.body.settlement.perDiem).toMatchObject({ computedDays: 5, overrideDays: 3, days: 3, rate: 1000, amountInr: 3000 });
  });
});

/* ── Per Diem Eligible + personal days on every trip type ────────────── */

describe("isPerDiemEligible — only an explicit No turns it off", () => {
  it("missing / null / true are Yes; false (or the string) is No", () => {
    expect(isPerDiemEligible({})).toBe(true);
    expect(isPerDiemEligible({ perDiemEligible: null })).toBe(true);
    expect(isPerDiemEligible({ perDiemEligible: true })).toBe(true);
    expect(isPerDiemEligible({ perDiemEligible: false })).toBe(false);
    expect(isPerDiemEligible({ perDiemEligible: "false" })).toBe(false);
  });
});

describe("settlement/start — Per Diem Eligible", () => {
  it("No: zero per diem even with a traveller rate AND a policy rate set", async () => {
    const t = await seedTraveller(WS.C, "EL-001", { perDiemRateDomesticInr: 1200, perDiemRateInternationalInr: 5000 });
    const id = await seedRequest(t, { perDiemEligible: false, personalDays: { count: 1 } });
    const s = ok(await call("post", ACT.admin, WS.C, `/api/cstep/requests/${id}/settlement/start`)).body.settlement;
    expect(s.perDiem).toMatchObject({ days: 0, rate: 0, amountInr: 0, computedDays: 0 });
    expect(s.buckets.perDiem).toBe(0);
    expect(s.totalCostOfTour).toBe(0);
    expect(s.amountClaimed).toBe(0);
  });

  it("No on an international tour and an event: zero as well", async () => {
    const t = await seedTraveller(WS.C, "EL-002", { perDiemRateDomesticInr: 1200, perDiemRateInternationalInr: 5000 });
    const intl = await seedRequest(t, { type: "INTERNATIONAL", countries: [{ country: "France" }], perDiemEligible: false });
    const ev = await seedRequest(t, { formType: "EVENT_REQUEST", type: undefined, perDiemEligible: false });
    for (const id of [intl, ev]) {
      const s = ok(await call("post", ACT.admin, WS.C, `/api/cstep/requests/${id}/settlement/start`)).body.settlement;
      expect(s.perDiem).toMatchObject({ days: 0, rate: 0, amountInr: 0 });
    }
  });

  it("Yes (explicit) computes exactly as a request made before the flag existed", async () => {
    const t = await seedTraveller(WS.C, "EL-003", { perDiemRateDomesticInr: 1200 });
    const yes = await seedRequest(t, { perDiemEligible: true });
    const legacy = await seedRequest(t); // no perDiemEligible field at all
    for (const id of [yes, legacy]) {
      const s = ok(await call("post", ACT.admin, WS.C, `/api/cstep/requests/${id}/settlement/start`)).body.settlement;
      expect(s.perDiem).toMatchObject({ days: 5, rate: 1200, amountInr: 6000 });
    }
  });
});

describe("settlement/start — personal days on domestic tours and events", () => {
  it("domestic tour: dates-only personal days are subtracted", async () => {
    const t = await seedTraveller(WS.C, "PDD-001", { perDiemRateDomesticInr: 1000 });
    const id = await seedRequest(t, { personalDays: { dates: ["2026-11-03", "2026-11-04"] } });
    const s = ok(await call("post", ACT.admin, WS.C, `/api/cstep/requests/${id}/settlement/start`)).body.settlement;
    expect(s.perDiem).toMatchObject({ computedDays: 3, days: 3, rate: 1000, amountInr: 3000 });
  });

  it("event request: its start/end dates less personal days, at the domestic rate", async () => {
    const t = await seedTraveller(WS.C, "PDE-001", { perDiemRateDomesticInr: 1000, perDiemRateInternationalInr: 5000 });
    const id = await seedRequest(t, { formType: "EVENT_REQUEST", type: undefined, personalDays: { count: 2 } });
    const s = ok(await call("post", ACT.admin, WS.C, `/api/cstep/requests/${id}/settlement/start`)).body.settlement;
    expect(s.perDiem).toMatchObject({ computedDays: 3, days: 3, rate: 1000, amountInr: 3000 });
  });
});

describe("the request form's perDiemEligible field", () => {
  it("a DRAFT edit stores No, and Yes again", async () => {
    const t = await seedTraveller(WS.C, "FRM-001");
    const id = await seedRequest(t, { status: "DRAFT", stations: [{ from: "Bengaluru", to: "Delhi" }], modesRequested: ["AIR"] });
    const r1 = await call("patch", ACT.admin, WS.C, `/api/cstep/requests/${id}`).send({ perDiemEligible: false });
    expect(r1.status, JSON.stringify(r1.body)).toBeLessThan(300);
    expect((await col("csteptravelrequests").findOne({ _id: id }))!.perDiemEligible).toBe(false);
    ok(await call("patch", ACT.admin, WS.C, `/api/cstep/requests/${id}`).send({ perDiemEligible: true }));
    expect((await col("csteptravelrequests").findOne({ _id: id }))!.perDiemEligible).toBe(true);
  });
});

describe("claims still have no per diem", () => {
  for (const formType of ["LOCAL_TRAVEL_CLAIM", "EXPENSE_CLAIM"]) {
    it(`${formType}: the perdiem PATCH and settlement/start are 409`, async () => {
      const t = await seedTraveller(WS.C, `CL-${formType.length}`, { perDiemRateDomesticInr: 1200 });
      const id = await seedRequest(t, { formType, status: "APPROVED" });
      const patch = await call("patch", ACT.admin, WS.C, `/api/cstep/requests/${id}/settlement/perdiem`).send({ rate: 500 });
      expect(patch.status).toBe(409);
      expect(patch.body.error).toBe("A claim has no per diem");
      const start = await call("post", ACT.admin, WS.C, `/api/cstep/requests/${id}/settlement/start`);
      expect(start.status).toBe(409);
      expect(await col("cstepsettlements").countDocuments({ requestId: id })).toBe(0);
    });
  }
});

/* ── single create / edit ────────────────────────────────────────────── */

describe("traveller create/edit — per-diem rates are CSTEP-Admin-only", () => {
  let id: string;

  it("a CSTEP Admin creates a traveller with both rates (₹ and separators tolerated)", async () => {
    const r = ok(
      await call("post", ACT.admin, WS.C, "/api/travellers").send({
        firstName: "Rate", lastName: "Holder", employeeId: "RT-001",
        perDiemRateDomesticInr: "1,500", perDiemRateInternationalInr: "₹ 6000",
      }),
    );
    id = r.body.traveller._id;
    expect(await profile({ _id: new mongoose.Types.ObjectId(id) })).toMatchObject({
      perDiemRateDomesticInr: 1500,
      perDiemRateInternationalInr: 6000,
    });
  });

  it("a create without the fields leaves them unset (no default)", async () => {
    ok(await call("post", ACT.admin, WS.C, "/api/travellers").send({ firstName: "No", lastName: "Rate", employeeId: "RT-002" }));
    const doc = await profile({ travelerId: "RT-002" });
    expect(doc).not.toHaveProperty("perDiemRateDomesticInr");
    expect(doc).not.toHaveProperty("perDiemRateInternationalInr");
  });

  it("GET /:id lists the per-diem keys as editable for a CSTEP Admin only", async () => {
    const a = ok(await call("get", ACT.admin, WS.C, `/api/travellers/${id}`));
    expect(a.body.editableFields).toEqual(expect.arrayContaining(["perDiemRateDomesticInr", "perDiemRateInternationalInr"]));
    const n = ok(await call("get", ACT.nonAdmin, WS.C, `/api/travellers/${id}`));
    expect(n.body.editableFields).not.toContain("perDiemRateDomesticInr");
    expect(n.body.editableFields.length).toBeGreaterThan(0); // still a leader — everything else stays editable
  });

  it("a non-admin's CHANGE is 403 and writes nothing; resending the stored value is a no-op", async () => {
    const r = await call("put", ACT.nonAdmin, WS.C, `/api/travellers/${id}`).send({ firstName: "Renamed", perDiemRateDomesticInr: 9999 });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("Only a CSTEP Admin can set a traveller's per-diem rates");
    expect(await profile({ travelerId: "RT-001" })).toMatchObject({ firstName: "Rate", perDiemRateDomesticInr: 1500 });

    ok(await call("put", ACT.nonAdmin, WS.C, `/api/travellers/${id}`).send({ workLocation: "Pune", perDiemRateDomesticInr: "1500" }));
    expect(await profile({ travelerId: "RT-001" })).toMatchObject({ workLocation: "Pune", perDiemRateDomesticInr: 1500 });
  });

  it("a non-admin cannot set rates at create either", async () => {
    const r = await call("post", ACT.nonAdmin, WS.C, "/api/travellers").send({ firstName: "Sneak", lastName: "Y", employeeId: "RT-003", perDiemRateDomesticInr: 100 });
    expect(r.status).toBe(403);
    expect(await profile({ travelerId: "RT-003" })).toBeNull();
  });

  it("a CSTEP Admin edits one rate, and blank clears it back to the policy", async () => {
    ok(await call("put", ACT.admin, WS.C, `/api/travellers/${id}`).send({ perDiemRateInternationalInr: 7000 }));
    expect(await profile({ travelerId: "RT-001" })).toMatchObject({ perDiemRateDomesticInr: 1500, perDiemRateInternationalInr: 7000 });
    ok(await call("put", ACT.admin, WS.C, `/api/travellers/${id}`).send({ perDiemRateDomesticInr: "" }));
    const doc = await profile({ travelerId: "RT-001" });
    expect(doc.perDiemRateDomesticInr).toBeUndefined();
    expect(doc.perDiemRateInternationalInr).toBe(7000);
  });

  it("a negative or non-numeric rate is 400", async () => {
    for (const bad of [-1, "-50", "abc", "12abc"]) {
      const r = await call("put", ACT.admin, WS.C, `/api/travellers/${id}`).send({ perDiemRateInternationalInr: bad });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/^Per Diem International \(₹\/day\) must be a non-negative number of rupees per day/);
    }
    expect((await profile({ travelerId: "RT-001" })).perDiemRateInternationalInr).toBe(7000);
  });

  it("an ordinary workspace refuses a rate (400) — the fields are CSTEP's", async () => {
    const r = await call("post", ACT.leaderN, WS.N, "/api/travellers").send({ firstName: "Nw", lastName: "Z", perDiemRateDomesticInr: 100 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Per-diem rates apply only to CSTEP workspaces");
  });
});

/* ── bulk import ─────────────────────────────────────────────────────── */

describe("CSTEP bulk import — the two per-diem columns", () => {
  it("the CSTEP template ends with both columns; an ordinary workspace's does not", async () => {
    const c = ok(await call("get", ACT.admin, WS.C, "/api/travellers/template/download"));
    const header = c.text.replace(/^﻿/, "").split("\n")[0].trim().split(",");
    expect(header.slice(-2)).toEqual(["Per Diem Domestic (₹/day)", "Per Diem International (₹/day)"]);
    const n = ok(await call("get", ACT.leaderN, WS.N, "/api/travellers/template/download"));
    expect(n.text).not.toMatch(/Per Diem/);
  });

  it("preview refuses a bad value with a clear reason, before any write", async () => {
    const r = ok(
      await bulk(ACT.admin, WS.C, "preview", [
        HDR,
        "IM-001,Ira,Mehta,ira@qc.local,1200,",
        "IM-002,Bad,Neg,neg@qc.local,-5,",
        "IM-003,Bad,Text,text@qc.local,,lots",
      ]),
    );
    expect(r.body.results.map((x: any) => x.action)).toEqual(["create", "skip", "skip"]);
    expect(r.body.results[1].reason).toMatch(/^Per Diem Domestic \(₹\/day\) must be a non-negative number of rupees per day/);
    expect(r.body.results[2].reason).toMatch(/^Per Diem International \(₹\/day\) must be a non-negative number/);
    expect(await profile({ travelerId: "IM-001" })).toBeNull();
  });

  it("a CSTEP Admin's commit sets the rates on create", async () => {
    const r = ok(await bulk(ACT.admin, WS.C, "commit", [HDR, "IM-001,Ira,Mehta,ira@qc.local,1200,5500", "IM-004,Om,Das,om@qc.local,,"]));
    expect(r.body.created).toBe(2);
    expect(await profile({ travelerId: "IM-001" })).toMatchObject({ perDiemRateDomesticInr: 1200, perDiemRateInternationalInr: 5500 });
    const om = await profile({ travelerId: "IM-004" });
    expect(om.perDiemRateDomesticInr).toBeUndefined();
    expect(om.perDiemRateInternationalInr).toBeUndefined();
  });

  it("on update a blank cell keeps the stored rate; a filled one replaces it", async () => {
    const r = ok(await bulk(ACT.admin, WS.C, "commit", [HDR, "IM-001,Ira,Mehta,ira@qc.local,,6000"]));
    expect(r.body.updated).toBe(1);
    expect(await profile({ travelerId: "IM-001" })).toMatchObject({ perDiemRateDomesticInr: 1200, perDiemRateInternationalInr: 6000 });
  });

  it("a non-admin importer: the columns are ignored (with a note), the row still imports, the rates are untouched", async () => {
    const p = ok(await bulk(ACT.nonAdmin, WS.C, "preview", [HDR, "IM-001,Ira,Mehta,ira@qc.local,1,-999"]));
    expect(p.body.results[0].action).toBe("update"); // the bad value is not even read
    expect(p.body.results[0].reason).toMatch(/Per-diem columns ignored — only a CSTEP Admin can set per-diem rates\.$/);

    const c = ok(await bulk(ACT.nonAdmin, WS.C, "commit", [HDR, "IM-001,Ira,Mehta,ira@qc.local,1,2", "IM-005,New,Person,np@qc.local,1,2"]));
    expect(c.body.updated).toBe(1);
    expect(c.body.created).toBe(1);
    expect(c.body.results[1].reason).toBe("Per-diem columns ignored — only a CSTEP Admin can set per-diem rates.");
    expect(await profile({ travelerId: "IM-001" })).toMatchObject({ perDiemRateDomesticInr: 1200, perDiemRateInternationalInr: 6000 });
    const np = await profile({ travelerId: "IM-005" });
    expect(np.perDiemRateDomesticInr).toBeUndefined();
  });

  it("an ordinary workspace ignores the columns entirely", async () => {
    const r = ok(await bulk(ACT.leaderN, WS.N, "commit", ["First Name,Last Name,Email,Per Diem Domestic (₹/day)", "Nora,West,nora@qc.local,700"]));
    expect(r.body.created).toBe(1);
    expect((await profile({ firstName: "Nora" })).perDiemRateDomesticInr).toBeUndefined();
  });
});

/* ── export ──────────────────────────────────────────────────────────── */

describe("traveller export", () => {
  it("CSTEP: both per-diem columns, with the stored rates (blank when unset)", async () => {
    const r = ok(await call("get", ACT.admin, WS.C, "/api/travellers/export/download"));
    const lines = r.text.replace(/^﻿/, "").trim().split("\n").map((l) => l.trim().split(","));
    expect(lines[0].slice(-2)).toEqual(["Per Diem Domestic (₹/day)", "Per Diem International (₹/day)"]);
    const row = (empId: string) => lines.find((l) => l[0] === empId)!;
    expect(row("IM-001").slice(-2)).toEqual(["1200", "6000"]);
    expect(row("IM-004").slice(-2)).toEqual(["", ""]);
    expect(row("RT-001").slice(-2)).toEqual(["", "7000"]);
  });

  it("an ordinary workspace's export is unchanged", async () => {
    const r = ok(await call("get", ACT.leaderN, WS.N, "/api/travellers/export/download"));
    expect(r.text).not.toMatch(/Per Diem/);
    expect(r.text.replace(/^﻿/, "").split("\n")[0].trim().split(",")).toHaveLength(16);
  });
});
