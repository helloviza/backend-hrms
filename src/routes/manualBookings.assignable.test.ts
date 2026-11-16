// apps/backend/src/routes/manualBookings.assignable.test.ts
//
// Assign Person = Manual Bookings staff only (2026-11-17,
// services/assignableUsers.ts):
//   - GET /assignable-users: HOUSE staff whose ACTIVE STAFF UserPermission
//     gives manualBookings access ≠ NONE, plus SUPERADMINs; active, login
//     enabled, never a customer / vendor account; sorted by name;
//   - ?include=<id> appends a current out-of-list assignee flagged noAccess;
//   - /assignees (list filter) = assignable + out-of-list holders, flagged;
//   - create / enquiry / PUT refuse a NEW or CHANGED out-of-list assignee;
//     an unchanged old value is fine.
//
// Real: manual-bookings router, models, in-memory Mongo. Stubbed: the caller.
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
vi.mock("../utils/s3Upload.js", () => ({ uploadBufferToS3: async () => ({}), getObjectBuffer: async () => Buffer.from("") }));
vi.mock("../services/documentExtraction.service.js", async (orig) => ({ ...(await orig<any>()), enqueueExtraction: async () => undefined }));
vi.mock("../services/location.service.js", async (orig) => ({ ...(await orig<any>()), resolveActorFromRequest: async () => null }));

const { default: manualBookingsRouter } = await import("./manualBookings.js");
const { ASSIGNEE_NOT_ALLOWED } = await import("../services/assignableUsers.js");

const oid = () => new mongoose.Types.ObjectId();
const HOUSE_WS = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const HOUSE = "6a4e0d2ea90c293c9e129f48";
const OTHER_WS = oid();
const CLIENT = oid();
const U = {
  amit: oid(),      // HOUSE staff, WRITE → in
  bela: oid(),      // HOUSE staff, access NONE → out
  chen: oid(),      // HOUSE staff, no permission doc → out
  dev: oid(),       // SUPERADMIN, other workspace, no permission → in
  esha: oid(),      // HOUSE staff, READ, but INACTIVE → out
  farah: oid(),     // customer user with a CUSTOMER permission (universe CUSTOMER) → out
  gopal: oid(),     // HOUSE staff, permission SUSPENDED → out
  hari: oid(),      // HOUSE staff, FULL, login disabled → out
  isha: oid(),      // partner / other-workspace staff with STAFF manualBookings → out (not HOUSE)
  aaron: oid(),     // HOUSE staff, READ → in (sorts first)
};

let callerHouse = true;
const app = express();
app.use(express.json());
app.use("/api/admin/manual-bookings", (req: any, _res, next) => {
  req.user = { _id: String(U.dev), sub: String(U.dev), roles: ["EMPLOYEE"], email: "x@plumtrips.com", name: "X" };
  if (callerHouse) { req.workspace = { customerId: "PLUMTRIPS-HOUSE" }; req.workspaceObjectId = HOUSE_WS; }
  else req.workspace = { customerId: String(CLIENT) };
  req.permissionScope = "ALL";
  next();
}, manualBookingsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-bookings-assignable-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const perm = (u: mongoose.Types.ObjectId, access: string, extra: any = {}) => ({
  userId: String(u), email: `${u}@x.test`, workspaceId: String(HOUSE_WS), universe: "STAFF", source: "manual",
  level: { code: "L2", name: "Staff", designation: "" }, status: "active", tier: 1, roleType: "EMPLOYEE",
  grantedModules: [], modules: { manualBookings: { access, scope: "OWN" } }, ...extra,
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  callerHouse = true;
  const user = (id: mongoose.Types.ObjectId, name: string, extra: any = {}) => ({ _id: id, name, email: `${name.split(" ")[0].toLowerCase()}@x.test`, workspaceId: HOUSE_WS, roles: ["EMPLOYEE"], status: "ACTIVE", ...extra });
  await col("users").insertMany([
    user(U.amit, "Amit Shah"), user(U.bela, "Bela Roy"), user(U.chen, "Chen Li"),
    user(U.dev, "Dev Super", { roles: ["SUPERADMIN"], workspaceId: OTHER_WS }),
    user(U.esha, "Esha Inactive", { status: "INACTIVE" }),
    user(U.farah, "Farah Customer", { accountType: "CUSTOMER", workspaceId: OTHER_WS }),
    user(U.gopal, "Gopal Suspended"), user(U.hari, "Hari Blocked", { loginDisabled: true }),
    user(U.isha, "Isha Partner", { workspaceId: OTHER_WS }),
    user(U.aaron, "Aaron Ahuja"),
  ]);
  await col("userpermissions").insertMany([
    perm(U.amit, "WRITE"), perm(U.bela, "NONE"), perm(U.esha, "READ"),
    perm(U.farah, "FULL", { universe: "CUSTOMER" }), perm(U.gopal, "FULL", { status: "suspended" }),
    perm(U.hari, "FULL"), perm(U.isha, "FULL", { workspaceId: String(OTHER_WS) }), perm(U.aaron, "READ"),
  ]);
  await col("customers").insertMany([{ _id: CLIENT, name: "Acme", legalName: "Acme", status: "ACTIVE" }, { _id: new mongoose.Types.ObjectId(HOUSE), name: "House", status: "ACTIVE" }]);
});

const base = "/api/admin/manual-bookings";
const visa = (over: any = {}) => ({
  workspaceId: String(CLIENT), type: "VISA", status: "PENDING", bookingDate: "2026-11-16", travelDate: "2027-01-18",
  passengers: [{ name: "Riya Sen", type: "ADULT" }], pricing: { actualPrice: 0, quotedPrice: 0 }, ...over,
});

describe("GET /assignable-users", () => {
  it("Manual Bookings staff + SUPERADMIN only, active, sorted by name", async () => {
    const r = await request(app).get(`${base}/assignable-users`);
    expect(r.status).toBe(200);
    expect(r.body.users.map((u: any) => u.name)).toEqual(["Aaron Ahuja", "Amit Shah", "Dev Super"]);
    expect(r.body.users.every((u: any) => !u.noAccess)).toBe(true);
  });

  it("?include=<current assignee> appends an out-of-list person flagged noAccess (and not twice)", async () => {
    const r = await request(app).get(`${base}/assignable-users?include=${U.bela}`);
    expect(r.body.users.map((u: any) => [u.name, !!u.noAccess])).toEqual([["Aaron Ahuja", false], ["Amit Shah", false], ["Dev Super", false], ["Bela Roy", true]]);
    const again = await request(app).get(`${base}/assignable-users?include=${U.amit}`);
    expect(again.body.users).toHaveLength(3);
  });

  it("HOUSE staff only", async () => {
    callerHouse = false;
    expect((await request(app).get(`${base}/assignable-users`)).status).toBe(403);
  });
});

describe("GET /assignees (list filter)", () => {
  it("assignable staff first, then out-of-list holders flagged noAccess", async () => {
    await col("manualbookings").insertMany([
      { bookingRef: "MB-1", workspaceId: CLIENT, type: "VISA", status: "PENDING", assignPerson: U.chen, isActive: true, isDemo: false },
      { bookingRef: "MB-2", workspaceId: CLIENT, type: "VISA", status: "PENDING", assignPerson: U.amit, isActive: true, isDemo: false },
    ]);
    const r = await request(app).get(`${base}/assignees`);
    expect(r.body.assignees.map((a: any) => [a.name, !!a.noAccess])).toEqual([["Aaron Ahuja", false], ["Amit Shah", false], ["Dev Super", false], ["Chen Li", true]]);
  });
});

describe("server refuses a new out-of-list assignee", () => {
  for (const [who, id] of [["no-access staff", "bela"], ["no permission", "chen"], ["inactive", "esha"], ["customer", "farah"], ["suspended", "gopal"], ["login disabled", "hari"], ["non-HOUSE staff", "isha"]] as const) {
    it(`create with ${who} → 400`, async () => {
      const r = await request(app).post(base).send(visa({ assignPerson: String(U[id]) }));
      expect([r.status, r.body.code, r.body.error]).toEqual([400, "ASSIGNEE_NOT_ALLOWED", ASSIGNEE_NOT_ALLOWED]);
    });
  }

  it("create / enquiry with an assignable person (incl. a SUPERADMIN) → 201", async () => {
    expect((await request(app).post(base).send(visa({ assignPerson: String(U.amit) }))).status).toBe(201);
    expect((await request(app).post(base).send(visa({ assignPerson: String(U.dev) }))).status).toBe(201);
    expect((await request(app).post(`${base}/enquiry`).send(visa({ assignPerson: String(U.aaron) }))).status).toBe(201);
  });

  it("enquiry with an out-of-list person → 400", async () => {
    const r = await request(app).post(`${base}/enquiry`).send(visa({ assignPerson: String(U.bela) }));
    expect(r.body.code).toBe("ASSIGNEE_NOT_ALLOWED");
  });

  it("PUT: unchanged old (now out-of-list) assignee is fine; a change to out-of-list refused; to in-list OK", async () => {
    const created = await request(app).post(base).send(visa({ assignPerson: String(U.amit) }));
    const id = String(created.body.booking._id);
    // Amit loses access afterwards — the booking must stay editable as is.
    await col("userpermissions").updateOne({ userId: String(U.amit) }, { $set: { "modules.manualBookings.access": "NONE" } });
    const same = await request(app).put(`${base}/${id}`).send({ assignPerson: String(U.amit), notes: "still editable" });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    const noField = await request(app).put(`${base}/${id}`).send({ notes: "no assignee field at all" });
    expect(noField.status).toBe(200);
    const bad = await request(app).put(`${base}/${id}`).send({ assignPerson: String(U.chen) });
    expect([bad.status, bad.body.code]).toEqual([400, "ASSIGNEE_NOT_ALLOWED"]);
    const ok = await request(app).put(`${base}/${id}`).send({ assignPerson: String(U.aaron) });
    expect(ok.status).toBe(200);
    const row: any = await col("manualbookings").findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(String(row.assignPerson)).toBe(String(U.aaron));
  });
});
