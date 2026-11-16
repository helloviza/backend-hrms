// apps/backend/src/routes/manualBookings.prospect.test.ts
//
// "Client not registered yet" (Log Enquiry follow-up, 2026-11-16):
//   - POST /enquiry with clientNotRegistered: saved under HOUSE with
//     prospectCompanyName; refused without a company name;
//   - prospectCompanyName is written by that route ONLY (not POST /, not PUT);
//   - it shows in the list (client label), list search and the export;
//   - POST /:id/move-client moves a HOUSE booking to a real client at
//     Pending / WIP, recorded in clientMoves, prospect name kept — and is
//     refused in every other case; PUT still can't change workspaceId.
//
// Real: manual-bookings router, models, in-memory Mongo. Stubbed: the caller
// (scope / access level / HOUSE or not), mail, S3.
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
// The caller's access level is honoured, so "no WRITE" is a real 403.
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: (_m: string, min: string) => (req: any, res: any, next: any) => {
    const rank: Record<string, number> = { NONE: 0, READ: 1, WRITE: 2, FULL: 3 };
    if ((rank[req.__access] ?? 3) < rank[min]) return res.status(403).json({ message: "Insufficient access level" });
    next();
  },
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: async () => ({ messageId: "test" }) }));
vi.mock("../utils/s3Upload.js", () => ({ uploadBufferToS3: async () => ({}), getObjectBuffer: async () => Buffer.from("") }));
vi.mock("../services/documentExtraction.service.js", async (orig) => ({ ...(await orig<any>()), enqueueExtraction: async () => undefined }));
vi.mock("../services/location.service.js", async (orig) => ({ ...(await orig<any>()), resolveActorFromRequest: async () => null }));

const { default: manualBookingsRouter, PROSPECT_COMPANY_REQUIRED } = await import("./manualBookings.js");

const oid = () => new mongoose.Types.ObjectId();
const HOUSE_WS = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const HOUSE = "6a4e0d2ea90c293c9e129f48";
const CLIENT = oid();
const INACTIVE = oid();
const STAFF = oid();
const OTHER = oid();

let caller: { id: mongoose.Types.ObjectId; scope: string; access: string; roles: string[]; house: boolean };
const app = express();
app.use(express.json());
app.use("/api/admin/manual-bookings", (req: any, _res, next) => {
  req.user = { _id: String(caller.id), sub: String(caller.id), roles: caller.roles, email: "rita@plumtrips.com", name: "Rita Menon" };
  if (caller.house) {
    req.workspace = { customerId: "PLUMTRIPS-HOUSE" };
    req.workspaceObjectId = HOUSE_WS;
  } else {
    req.workspace = { customerId: String(CLIENT) };
  }
  req.permissionScope = caller.scope;
  req.__access = caller.access;
  next();
}, manualBookingsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-bookings-prospect-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  caller = { id: STAFF, scope: "ALL", access: "FULL", roles: ["EMPLOYEE"], house: true };
  await col("customers").insertMany([
    { _id: new mongoose.Types.ObjectId(HOUSE), name: "Plumtrips (House)", legalName: "Plumtrips (House)", status: "ACTIVE" },
    { _id: CLIENT, name: "Acme Travel Pvt Ltd", legalName: "Acme Travel Pvt Ltd", status: "ACTIVE" },
    { _id: INACTIVE, name: "Gone Ltd", legalName: "Gone Ltd", status: "INACTIVE" },
  ]);
  await col("users").insertMany([
    { _id: STAFF, name: "Rita Menon", email: "rita@plumtrips.com", workspaceId: HOUSE_WS },
    { _id: OTHER, name: "Omar Other", email: "omar@plumtrips.com", workspaceId: HOUSE_WS },
  ]);
});

const base = "/api/admin/manual-bookings";
const enquiry = (over: any = {}) => ({
  workspaceId: HOUSE,
  type: "VISA",
  bookingDate: "2026-11-16",
  travelDate: "2027-01-18",
  passengers: [{ name: "Walk-in Guest", type: "ADULT" }], // no phone, no email
  pricing: { actualPrice: 0, quotedPrice: 0 },
  ...over,
});
const logEnquiry = (b: any) => request(app).post(`${base}/enquiry`).send(b);
const stored = async (id: string) => col("manualbookings").findOne({ _id: new mongoose.Types.ObjectId(id) });
const move = (id: string, workspaceId: any) => request(app).post(`${base}/${id}/move-client`).send({ workspaceId });
async function prospectBooking(status = "PENDING") {
  const res = await logEnquiry(enquiry({ clientNotRegistered: true, prospectCompanyName: "Zenith Exports" }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = String(res.body.booking._id);
  if (status !== "PENDING") await col("manualbookings").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { status } });
  return id;
}

describe("POST /enquiry — client not registered yet", () => {
  it("saves under HOUSE with the company name; no phone / email needed", async () => {
    const res = await logEnquiry(enquiry({ clientNotRegistered: true, prospectCompanyName: "  Zenith Exports  " }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row: any = await stored(String(res.body.booking._id));
    expect(String(row.workspaceId)).toBe(HOUSE);
    expect(row.prospectCompanyName).toBe("Zenith Exports");
    expect(row.passengers[0].phone ?? "").toBe("");
  });

  it("is refused without a company name (or with blanks)", async () => {
    for (const prospectCompanyName of [undefined, "", "   "]) {
      const res = await logEnquiry(enquiry({ clientNotRegistered: true, prospectCompanyName }));
      expect([res.status, res.body.error], String(prospectCompanyName)).toEqual([400, PROSPECT_COMPANY_REQUIRED]);
    }
    expect(await col("manualbookings").countDocuments({})).toBe(0);
  });

  it("is always HOUSE: a real client with the flag is refused", async () => {
    const res = await logEnquiry(enquiry({ workspaceId: String(CLIENT), clientNotRegistered: true, prospectCompanyName: "X" }));
    expect([res.status, res.body.code]).toEqual([400, "PROSPECT_NOT_HOUSE"]);
  });

  it("a registered-client enquiry saves without phone / email, with no prospect name", async () => {
    const res = await logEnquiry(enquiry({ workspaceId: String(CLIENT), prospectCompanyName: "ignored" }));
    expect(res.status).toBe(201);
    expect((await stored(String(res.body.booking._id)) as any).prospectCompanyName).toBeUndefined();
  });
});

describe("prospectCompanyName is server-written only", () => {
  it("POST / ignores it (even with the flag)", async () => {
    const res = await request(app).post(base).send({
      ...enquiry({ clientNotRegistered: true, prospectCompanyName: "Sneaky Co" }),
      status: "PENDING", supplierName: "", givenBy: "",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await stored(String(res.body.booking._id)) as any).prospectCompanyName).toBeUndefined();
  });

  it("PUT can't set or change it, and still can't change workspaceId", async () => {
    const id = await prospectBooking();
    const res = await request(app).put(`${base}/${id}`).send({ prospectCompanyName: "Renamed", workspaceId: String(CLIENT), notes: "edited" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row: any = await stored(id);
    expect([row.prospectCompanyName, String(row.workspaceId), row.notes]).toEqual(["Zenith Exports", HOUSE, "edited"]);
  });
});

describe("list, search and export show the prospect company", () => {
  it("list client label, search by company, prospect filter, export column", async () => {
    const id = await prospectBooking();
    await logEnquiry(enquiry({ workspaceId: String(CLIENT) })); // a normal one
    const list = await request(app).get(`${base}?limit=50`);
    const row = list.body.docs.find((d: any) => String(d._id) === id);
    expect(row.clientName).toBe("Plumtrips (House) · Zenith Exports");
    const other = list.body.docs.find((d: any) => String(d._id) !== id);
    expect(other.clientName).toBe("Acme Travel Pvt Ltd"); // the server-side name now resolves (populated id)

    const found = await request(app).get(`${base}?search=zenith`);
    expect(found.body.docs.map((d: any) => String(d._id))).toEqual([id]);
    const prospects = await request(app).get(`${base}?prospect=1`);
    expect(prospects.body.docs.map((d: any) => String(d._id))).toEqual([id]);

    const csv = await request(app).get(`${base}/export?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("Plumtrips (House) · Zenith Exports");
    expect(csv.text).toContain("Acme Travel Pvt Ltd");
  });
});

describe("POST /:id/move-client", () => {
  for (const status of ["PENDING", "WIP"]) {
    it(`moves HOUSE → client at ${status}; recorded; prospect name kept`, async () => {
      const id = await prospectBooking(status);
      const res = await move(id, String(CLIENT));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row: any = await stored(id);
      expect(String(row.workspaceId)).toBe(String(CLIENT));
      expect(row.prospectCompanyName).toBe("Zenith Exports");
      expect(row.clientMoves).toHaveLength(1);
      const m = row.clientMoves[0];
      expect([String(m.by), m.byName, String(m.from), String(m.to), m.toName, m.prospectCompanyName])
        .toEqual([String(STAFF), "Rita Menon", HOUSE, String(CLIENT), "Acme Travel Pvt Ltd", "Zenith Exports"]);
      expect(m.at).toBeInstanceOf(Date);
      // after the move the list shows the real client only
      const list = await request(app).get(`${base}?limit=50`);
      expect(list.body.docs.find((d: any) => String(d._id) === id).clientName).toBe("Acme Travel Pvt Ltd");
    });
  }

  for (const status of ["CONFIRMED", "CANCELLED", "INVOICED"]) {
    it(`refused at ${status}`, async () => {
      const id = await prospectBooking(status);
      const res = await move(id, String(CLIENT));
      expect([res.status, res.body.code]).toEqual([400, "MOVE_STATUS"]);
      expect(String((await stored(id) as any).workspaceId)).toBe(HOUSE);
    });
  }

  it("refused from a non-HOUSE client (every other client change stays blocked)", async () => {
    const res0 = await logEnquiry(enquiry({ workspaceId: String(CLIENT) }));
    const id = String(res0.body.booking._id);
    const res = await move(id, String(INACTIVE));
    expect([res.status, res.body.code]).toEqual([400, "NOT_HOUSE"]);
  });

  it("refused for a user without WRITE", async () => {
    const id = await prospectBooking();
    caller = { ...caller, access: "READ" };
    expect((await move(id, String(CLIENT))).status).toBe(403);
    expect(String((await stored(id) as any).workspaceId)).toBe(HOUSE);
  });

  it("refused for a user who can't see the booking (OWN scope, someone else's, assigned away)", async () => {
    const id = await prospectBooking();
    await col("manualbookings").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { assignPerson: OTHER, assignmentStatus: "ASSIGNED" } });
    caller = { ...caller, id: new mongoose.Types.ObjectId(), scope: "OWN" };
    expect((await move(id, String(CLIENT))).status).toBe(403);
    expect(String((await stored(id) as any).workspaceId)).toBe(HOUSE);
  });

  it("refused for a non-HOUSE caller", async () => {
    const id = await prospectBooking();
    caller = { ...caller, house: false };
    expect([(await move(id, String(CLIENT))).status, (await move(id, String(CLIENT))).body.code]).toEqual([403, "HOUSE_ONLY"]);
  });

  it("refused to a non-existent, inactive, invalid or HOUSE client", async () => {
    const id = await prospectBooking();
    expect((await move(id, String(oid()))).body.code).toBe("TARGET_NOT_FOUND");
    expect((await move(id, String(INACTIVE))).body.code).toBe("TARGET_NOT_FOUND");
    expect((await move(id, "not-an-id")).body.code).toBe("TARGET_INVALID");
    expect((await move(id, HOUSE)).body.code).toBe("TARGET_INVALID");
    expect(String((await stored(id) as any).workspaceId)).toBe(HOUSE);
  });

  it("a second move is refused (no longer HOUSE)", async () => {
    const id = await prospectBooking();
    expect((await move(id, String(CLIENT))).status).toBe(200);
    expect((await move(id, String(CLIENT))).body.code).toBe("NOT_HOUSE");
  });
});
