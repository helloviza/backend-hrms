// apps/backend/src/routes/manualBookings.visibility.test.ts
//
// THE shared Manual Bookings visibility rule (utils/bookingAccess.ts,
// decision 2026-11-16), exercised through the real routes:
//   list GET /, GET /export, GET /:id, PUT /:id — one rule for all four.
//
//   ALL, or WORKSPACE for HOUSE staff → every booking
//   TEAM → created by OR assigned to the caller, their reportees, and the
//          reportees' reportees (User.managerId; cycle guard, depth 5)
//   OWN  → created by OR assigned to the caller (now on ANY row, not only
//          HOUSE rows), plus the unassigned HOUSE intake triage rows
//   SUPERADMIN → everything; the ADMIN role gets no automatic widening.
//
// Real: manual-bookings router, models, in-memory Mongo. Stubbed: the caller
// (requirePermission passes and the test sets permissionScope), mail, S3.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  JWT_SECRET: "jwt-secret-for-tests",
  JWT_REFRESH_SECRET: "refresh-secret-for-tests",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
})) process.env[k] ||= v;

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (_req: any, _res: any, next: any) => next();
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: async () => ({ messageId: "test" }) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: async (o: any) => ({ bucket: "test-bucket", key: `${o.keyPrefix}/${o.originalName}`, url: "" }),
  getObjectBuffer: async (key: string) => Buffer.from(`BYTES:${key}`),
}));
vi.mock("../services/documentExtraction.service.js", async (orig) => ({ ...(await orig<any>()), enqueueExtraction: async () => undefined }));
vi.mock("../services/location.service.js", async (orig) => ({ ...(await orig<any>()), resolveActorFromRequest: async () => null }));

const { default: manualBookingsRouter } = await import("./manualBookings.js");
const { reportingTreeUserIds } = await import("../utils/reportingTree.js");

const oid = () => new mongoose.Types.ObjectId();
const HOUSE_WS = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const HOUSE_CUSTOMER = new mongoose.Types.ObjectId("6a4e0d2ea90c293c9e129f48");
const CLIENT = oid(); // a non-HOUSE client — bookings live on the client's Customer._id

// People: MGR ← R1 ← R1A (reportee's reportee), MGR ← R2; PEER and PEER_R
// (PEER's reportee) are outside MGR's tree. C1 ↔ C2 is a managerId cycle.
const U = {
  MGR: oid(), R1: oid(), R1A: oid(), R2: oid(), PEER: oid(), PEER_R: oid(), C1: oid(), C2: oid(), ADMIN: oid(),
};

let caller: { id: mongoose.Types.ObjectId; scope: string; roles: string[]; house?: boolean } = {
  id: U.MGR, scope: "TEAM", roles: ["EMPLOYEE"], house: true,
};
const app = express();
app.use(express.json());
app.use("/api/admin/manual-bookings", (req: any, _res, next) => {
  req.user = { _id: String(caller.id), sub: String(caller.id), roles: caller.roles, email: "x@plumtrips.com", name: "X" };
  if (caller.house !== false) {
    req.workspace = { customerId: "PLUMTRIPS-HOUSE" };
    req.workspaceObjectId = HOUSE_WS;
  } else {
    req.workspace = { customerId: String(CLIENT) }; // a client tenant
  }
  req.permissionScope = caller.scope;
  next();
}, manualBookingsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-bookings-visibility-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

let seq = 0;
const ref = () => `MB-VIS-${String(++seq).padStart(3, "0")}`;
async function booking(over: Record<string, any>) {
  const doc = {
    bookingRef: ref(),
    workspaceId: CLIENT,
    type: "VISA",
    status: "PENDING",
    source: "MANUAL",
    bookingDate: new Date("2026-11-10T06:00:00Z"),
    travelDate: new Date("2027-01-18T06:00:00Z"),
    passengers: [{ name: "Riya Sen", type: "ADULT" }],
    pricing: { actualPrice: 100, quotedPrice: 120 },
    isActive: true,
    bookedBy: U.ADMIN,
    isDemo: false,
    assignmentStatus: over.assignPerson ? "ASSIGNED" : "PENDING_TO_ASSIGN",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  await col("manualbookings").insertOne(doc);
  return doc;
}

let B: Record<string, any> = {};
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  seq = 0;
  const user = (id: mongoose.Types.ObjectId, managerId?: mongoose.Types.ObjectId) => ({
    _id: id, email: `${id}@plumtrips.com`, name: `U${String(id).slice(-4)}`, workspaceId: HOUSE_WS, ...(managerId ? { managerId } : {}),
  });
  await col("users").insertMany([
    user(U.MGR), user(U.R1, U.MGR), user(U.R1A, U.R1), user(U.R2, U.MGR),
    user(U.PEER), user(U.PEER_R, U.PEER), user(U.C1, U.C2), user(U.C2, U.C1), user(U.ADMIN),
  ]);
  B = {
    mgrOwn: await booking({ createdBy: String(U.MGR) }),
    r1Created: await booking({ createdBy: String(U.R1) }),
    r1aAssigned: await booking({ createdBy: String(U.PEER), assignPerson: U.R1A }), // reportee's reportee, assigned
    r2Assigned: await booking({ createdBy: String(U.ADMIN), assignPerson: U.R2 }),
    peerOwn: await booking({ createdBy: String(U.PEER) }),
    peerReportee: await booking({ createdBy: String(U.PEER_R) }),
    // OWN user R2: a NON-HOUSE booking assigned to them, created by someone else
    r2NonHouse: await booking({ createdBy: String(U.PEER), assignPerson: U.R2, workspaceId: CLIENT }),
    // HOUSE intake triage row (unassigned) — kept for TEAM and OWN
    intake: await booking({ createdBy: String(oid()), workspaceId: HOUSE_CUSTOMER, assignmentStatus: "PENDING_TO_ASSIGN" }),
    // HOUSE row assigned to the PEER — not intake any more, not ours
    houseAssignedPeer: await booking({ createdBy: String(oid()), workspaceId: HOUSE_CUSTOMER, assignPerson: U.PEER }),
  };
});

const as = (c: Partial<typeof caller> & { id: mongoose.Types.ObjectId }) => {
  caller = { scope: "OWN", roles: ["EMPLOYEE"], house: true, ...c };
};
const base = "/api/admin/manual-bookings";
async function listRefs(): Promise<string[]> {
  const r = await request(app).get(`${base}?limit=200`);
  expect(r.status).toBe(200);
  return r.body.docs.map((d: any) => d.bookingRef).sort();
}
async function exportRefs(): Promise<string[]> {
  const r = await request(app).get(`${base}/export?format=csv`);
  expect(r.status).toBe(200);
  return (String(r.text).match(/MB-VIS-\d{3}/g) || []).filter((v, i, a) => a.indexOf(v) === i).sort();
}
const refsOf = (...keys: string[]) => keys.map((k) => B[k].bookingRef).sort();
const ALL_KEYS = () => Object.keys(B);

describe("reportingTreeUserIds", () => {
  it("walks reportees and reportees' reportees, not peers", async () => {
    const ids = await reportingTreeUserIds(String(U.MGR));
    expect(ids.sort()).toEqual([U.MGR, U.R1, U.R1A, U.R2].map(String).sort());
  });
  it("a managerId cycle terminates (cycle guard)", async () => {
    const ids = await reportingTreeUserIds(String(U.C1));
    expect(ids.sort()).toEqual([U.C1, U.C2].map(String).sort());
  });
  it("depth limit caps the walk", async () => {
    expect((await reportingTreeUserIds(String(U.MGR), 1)).sort()).toEqual([U.MGR, U.R1, U.R2].map(String).sort());
  });
});

describe("scope ALL / WORKSPACE (HOUSE) / SUPERADMIN → every booking", () => {
  for (const c of [
    { label: "ALL", scope: "ALL", roles: ["EMPLOYEE"] },
    { label: "WORKSPACE (HOUSE staff)", scope: "WORKSPACE", roles: ["EMPLOYEE"] },
    { label: "SUPERADMIN", scope: "OWN", roles: ["SUPERADMIN"] },
  ]) {
    it(`${c.label}: list and export show everything`, async () => {
      as({ id: U.R1, scope: c.scope, roles: c.roles });
      expect(await listRefs()).toEqual(refsOf(...ALL_KEYS()));
      expect(await exportRefs()).toEqual(refsOf(...ALL_KEYS()));
    });
  }

  it("the ADMIN role is NOT widened: ADMIN with scope OWN sees only their own", async () => {
    as({ id: U.ADMIN, scope: "OWN", roles: ["ADMIN"] });
    expect(await listRefs()).toEqual(refsOf("r2Assigned", "intake"));
  });
});

describe("scope TEAM", () => {
  const TEAM_VIEW = ["mgrOwn", "r1Created", "r1aAssigned", "r2Assigned", "r2NonHouse", "intake"];

  it("manager sees own + reportee + reportee's reportee + intake; list = export", async () => {
    as({ id: U.MGR, scope: "TEAM" });
    expect(await listRefs()).toEqual(refsOf(...TEAM_VIEW));
    expect(await exportRefs()).toEqual(refsOf(...TEAM_VIEW));
  });

  it("manager does NOT see a peer's cases (nor the peer's reportee's)", async () => {
    as({ id: U.MGR, scope: "TEAM" });
    const refs = await listRefs();
    for (const k of ["peerOwn", "peerReportee", "houseAssignedPeer"]) expect(refs).not.toContain(B[k].bookingRef);
  });

  it("GET /:id and PUT /:id follow the same rule", async () => {
    as({ id: U.MGR, scope: "TEAM" });
    const seen = await col("manualbookings").findOne({ bookingRef: B.r1aAssigned.bookingRef });
    const hidden = await col("manualbookings").findOne({ bookingRef: B.peerOwn.bookingRef });
    expect((await request(app).get(`${base}/${seen!._id}`)).status).toBe(200);
    expect((await request(app).get(`${base}/${hidden!._id}`)).status).toBe(403);
    expect((await request(app).put(`${base}/${hidden!._id}`).send({ notes: "x" })).status).toBe(403);
    expect((await request(app).put(`${base}/${seen!._id}`).send({ notes: "team edit" })).status).toBe(200);
  });

  it("a TEAM caller inside a managerId cycle gets an answer (no hang)", async () => {
    as({ id: U.C1, scope: "TEAM" });
    expect(await listRefs()).toEqual(refsOf("intake"));
  });
});

describe("scope OWN", () => {
  it("OWN user now sees a NON-HOUSE booking assigned to them (created by someone else)", async () => {
    as({ id: U.R2, scope: "OWN" });
    expect(await listRefs()).toEqual(refsOf("r2Assigned", "r2NonHouse", "intake"));
    expect(await exportRefs()).toEqual(refsOf("r2Assigned", "r2NonHouse", "intake"));
    const doc = await col("manualbookings").findOne({ bookingRef: B.r2NonHouse.bookingRef });
    expect((await request(app).get(`${base}/${doc!._id}`)).status).toBe(200);
  });

  it("OWN never sees a teammate's or a manager's row, even when they're the manager", async () => {
    as({ id: U.MGR, scope: "OWN" });
    expect(await listRefs()).toEqual(refsOf("mgrOwn", "intake"));
    const doc = await col("manualbookings").findOne({ bookingRef: B.r1Created.bookingRef });
    expect((await request(app).get(`${base}/${doc!._id}`)).status).toBe(403);
  });

  it("WORKSPACE for a non-HOUSE caller stays on the OWN rule (tenant-gated too)", async () => {
    as({ id: U.R2, scope: "WORKSPACE", house: false });
    // Inside the CLIENT tenant: only R2's own rows, not every CLIENT booking,
    // and never the HOUSE intake row (another tenant).
    expect(await listRefs()).toEqual(refsOf("r2Assigned", "r2NonHouse"));
  });
});
