// apps/backend/src/routes/manualBookings.enquirySummary.test.ts
//
// Team Summary → Enquiries tab (services/manualBookingEnquirySummary.ts) and
// ManualBooking.confirmedAt (first entry into CONFIRMED, pre-save hook):
// bucket maths, conversion formula, source filter, logged-by toggle incl. the
// website form, avg time to complete, scope ALL / TEAM / OWN, export = table,
// and every count = what the LIST returns for the same filters.
//
// Real: manual-bookings router, models, in-memory Mongo. Stubbed: the caller.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
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
const { CONVERSION_FORMULA, enquiryExportColumns } = await import("../services/manualBookingEnquirySummary.js");

const oid = () => new mongoose.Types.ObjectId();
const HOUSE_WS = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const HOUSE = new mongoose.Types.ObjectId("6a4e0d2ea90c293c9e129f48");
const CLIENT = oid();
const U = { MGR: oid(), R1: oid(), PEER: oid(), SYS: oid() };
const H = 3_600_000;

let caller = { id: U.MGR, scope: "ALL" };
const app = express();
app.use(express.json());
app.use("/api/admin/manual-bookings", (req: any, _res, next) => {
  req.user = { _id: String(caller.id), sub: String(caller.id), roles: ["EMPLOYEE"], email: "x@plumtrips.com", name: "X" };
  req.workspace = { customerId: "PLUMTRIPS-HOUSE" };
  req.workspaceObjectId = HOUSE_WS;
  req.permissionScope = caller.scope;
  next();
}, manualBookingsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-bookings-enquiry-summary-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * 86_400_000);
const IN = new Date("2026-11-10T06:00:00Z");
const OUT = new Date("2026-09-10T06:00:00Z");
const RANGE = "dateFrom=2026-11-01&dateTo=2026-11-30";
let seq = 0;
async function bk(over: Record<string, any>) {
  const createdAt = over.createdAt ?? ago(0.1);
  await col("manualbookings").insertOne({
    bookingRef: `MB-ENQ-${String(++seq).padStart(3, "0")}`,
    workspaceId: CLIENT, type: "VISA", status: "PENDING", source: "MANUAL",
    bookingDate: IN, travelDate: new Date("2027-01-18T06:00:00Z"),
    passengers: [{ name: "Guest", type: "ADULT" }], pricing: { actualPrice: 0, quotedPrice: 0 },
    isActive: true, isDemo: false, bookedBy: U.MGR, createdBy: String(U.MGR),
    assignmentStatus: over.assignPerson ? "ASSIGNED" : "PENDING_TO_ASSIGN",
    metadata: { channel: "ADMIN_ENQUIRY" },
    createdAt, updatedAt: createdAt,
    ...over,
  });
}
const web = { metadata: { channel: "TRAVEL_INTAKE_FORM" }, createdBy: String(U.SYS), workspaceId: HOUSE };

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  seq = 0;
  caller = { id: U.MGR, scope: "ALL" };
  await col("users").insertMany([
    { _id: U.MGR, name: "Meera Manager", designation: "Team Lead", email: "m@x.test", workspaceId: HOUSE_WS },
    { _id: U.R1, name: "Ravi One", email: "r@x.test", workspaceId: HOUSE_WS, managerId: U.MGR },
    { _id: U.PEER, name: "Pia Peer", email: "p@x.test", workspaceId: HOUSE_WS },
    { _id: U.SYS, name: "System Intake", email: "intake@x.test", workspaceId: HOUSE_WS },
  ]);
  // Logged by MGR, assigned to R1 (Log Enquiry):
  await bk({ assignPerson: U.R1, status: "PENDING", createdAt: ago(5) });
  await bk({ assignPerson: U.R1, status: "WIP", createdAt: ago(2) });
  await bk({ assignPerson: U.R1, status: "CONFIRMED", createdAt: ago(10), confirmedAt: new Date(ago(10).getTime() + 10 * H) });
  await bk({ assignPerson: U.R1, status: "INVOICED", createdAt: ago(9), confirmedAt: new Date(ago(9).getTime() + 30 * H) });
  await bk({ assignPerson: U.R1, status: "CONFIRMED", createdAt: ago(20) }); // completed before confirmedAt existed → not timed
  await bk({ assignPerson: U.R1, status: "CANCELLED" });
  await bk({ assignPerson: U.R1, status: "CONFIRMED", bookingDate: OUT, createdAt: ago(70), confirmedAt: ago(69) }); // out of range
  // Website form: assigned to R1 (open); unassigned completed in 2h (HOUSE intake row)
  await bk({ ...web, assignPerson: U.R1, status: "PENDING" });
  await bk({ ...web, status: "CONFIRMED", createdAt: ago(3), confirmedAt: new Date(ago(3).getTime() + 2 * H) });
  // A normal booking (not an enquiry) — never counted
  await bk({ assignPerson: U.R1, status: "PENDING", metadata: {} });
  // The peer's own enquiry
  await bk({ assignPerson: U.PEER, status: "PENDING", createdBy: String(U.PEER), bookedBy: U.PEER });
});

const base = "/api/admin/manual-bookings";
const get = async (qs = "") => {
  const r = await request(app).get(`${base}/enquiry-summary?${RANGE}&${qs}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const row = (s: any, name: string) => s.rows.find((r: any) => r.name === name);

describe("buckets, conversion, time to complete", () => {
  it("assignee rows: received / open now / ageing / completed / cancelled / conversion / avg", async () => {
    const s = await get();
    expect(s.conversionFormula).toBe(CONVERSION_FORMULA);
    expect(row(s, "Ravi One")).toMatchObject({
      received: 7, pending: 3, olderThan1d: 2, olderThan3d: 1, completed: 3, cancelled: 1,
      conversionPct: 42.9, avgCompleteMs: 20 * H, timedCompleted: 2,
    });
    expect(row(s, "Unassigned")).toMatchObject({ received: 1, completed: 1, pending: 0, conversionPct: 100, avgCompleteMs: 2 * H });
    expect(row(s, "Pia Peer")).toMatchObject({ received: 1, pending: 1, conversionPct: 0, avgCompleteMs: null });
    expect(s.cards).toEqual({ received: 9, openNow: 4, converted: 4, cancelled: 1, conversionPct: 44.4, avgCompleteMs: 14 * H, timedCompleted: 3 });
  });

  it("non-enquiry bookings and out-of-range completions are not counted", async () => {
    const s = await get();
    expect(s.rows.reduce((a: number, r: any) => a + r.received, 0)).toBe(9);
    expect(row(s, "Ravi One").completed).toBe(3);
  });

  it("source filter: Log Enquiry only / Website form only", async () => {
    const a = await get("enquirySource=admin");
    expect(row(a, "Ravi One")).toMatchObject({ received: 6, pending: 2 });
    expect(row(a, "Unassigned")).toBeUndefined();
    const w = await get("enquirySource=website");
    expect(row(w, "Ravi One")).toMatchObject({ received: 1, pending: 1, completed: 0 });
    expect(row(w, "Unassigned")).toMatchObject({ received: 1, completed: 1 });
    expect(w.cards.received).toBe(2);
  });

  it("logged-by toggle: website enquiries are 'Website form'", async () => {
    const s = await get("groupBy=logger");
    expect(s.groupBy).toBe("logger");
    expect(s.rows[0]).toMatchObject({ key: "__website", name: "Website form", received: 2, completed: 1, cancelled: 0, pending: 1, conversionPct: 50 });
    expect(row(s, "Meera Manager")).toMatchObject({ received: 6, completed: 3, cancelled: 1, pending: 2, conversionPct: 50 });
    expect(row(s, "System Intake")).toBeUndefined();
    expect(row(s, "Pia Peer")).toMatchObject({ received: 1 });
  });
});

describe("scope", () => {
  it("TEAM (manager): self + reportee + Unassigned; never the peer", async () => {
    caller = { id: U.MGR, scope: "TEAM" };
    const s = await get();
    expect(s.rows.map((r: any) => r.name).sort()).toEqual(["Meera Manager", "Ravi One", "Unassigned"]);
    expect(row(s, "Ravi One").received).toBe(7);
  });
  it("OWN (rep): only their own row", async () => {
    caller = { id: U.R1, scope: "OWN" };
    const s = await get();
    expect(s.rows.map((r: any) => r.name)).toEqual(["Ravi One"]);
    expect(s.cards.received).toBe(7);
  });
  it("OWN in logged-by mode: no Website form row", async () => {
    caller = { id: U.PEER, scope: "OWN" };
    const s = await get("groupBy=logger");
    expect(s.rows.map((r: any) => r.name)).toEqual(["Pia Peer"]);
  });
});

describe("click-through: counts = list totals for the same filters", () => {
  const list = async (qs: string) => (await request(app).get(`${base}?limit=200&${qs}`)).body.total;
  it("assignee rows (all sources)", async () => {
    const s = await get();
    const ch = "channel=ADMIN_ENQUIRY,TRAVEL_INTAKE_FORM";
    for (const r of s.rows) {
      const who = `assignPerson=${r.key ?? "none"}`;
      expect(await list(`${ch}&${who}&${RANGE}`), `${r.name} received`).toBe(r.received);
      expect(await list(`${ch}&${who}&status=PENDING,WIP`), `${r.name} pending`).toBe(r.pending);
      expect(await list(`${ch}&${who}&status=CONFIRMED,INVOICED&${RANGE}`), `${r.name} completed`).toBe(r.completed);
      expect(await list(`${ch}&${who}&status=CANCELLED&${RANGE}`), `${r.name} cancelled`).toBe(r.cancelled);
    }
  });
  it("logged-by rows: people = createdBy + Log Enquiry channel; Website form = website channel", async () => {
    const s = await get("groupBy=logger");
    for (const r of s.rows) {
      const q = r.key === "__website" ? "channel=TRAVEL_INTAKE_FORM" : `channel=ADMIN_ENQUIRY&createdBy=${r.key ?? "none"}`;
      expect(await list(`${q}&${RANGE}`), `${r.name} logged`).toBe(r.received);
      expect(await list(`${q}&status=CONFIRMED,INVOICED&${RANGE}`), `${r.name} completed`).toBe(r.completed);
    }
  });
});

describe("export = table", () => {
  for (const groupBy of ["assignee", "logger"] as const) {
    it(groupBy, async () => {
      const s = await get(`groupBy=${groupBy}`);
      const res = await request(app).get(`${base}/enquiry-summary/export?${RANGE}&groupBy=${groupBy}`).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body);
      const cols = enquiryExportColumns(groupBy);
      expect((wb.worksheets[0].getRow(5).values as any[]).slice(1)).toEqual(cols.map((c) => c.header));
      const data: any[][] = [];
      wb.worksheets[0].eachRow((r, n) => { if (n > 5) { const v = r.values as any[]; data.push(Array.from({ length: cols.length }, (_, i) => v[i + 1] ?? null)); } });
      expect(data).toEqual(s.rows.map((r: any) => cols.map((c) => c.get(r, new Date(s.generatedAt)))));
    });
  }
});

describe("confirmedAt (first entry into CONFIRMED)", () => {
  const visa = (over: any = {}) => ({
    workspaceId: String(CLIENT), type: "VISA", bookingDate: "2026-11-16", travelDate: "2027-01-18",
    passengers: [{ name: "Riya Sen", type: "ADULT" }], pricing: { actualPrice: 0, quotedPrice: 0 }, ...over,
  });
  const stored = async (id: string) => col("manualbookings").findOne({ _id: new mongoose.Types.ObjectId(id) });
  it("stamped on the first move into CONFIRMED and never moved after", async () => {
    const c = await request(app).post(base).send(visa({ status: "PENDING" }));
    const id = String(c.body.booking._id);
    expect((await stored(id) as any).confirmedAt).toBeUndefined();
    const done = await request(app).put(`${base}/${id}`).send({ status: "CONFIRMED", supplierName: "VFS", givenBy: "R" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const first = (await stored(id) as any).confirmedAt;
    expect(first).toBeInstanceOf(Date);
    await request(app).put(`${base}/${id}`).send({ status: "WIP" });
    await new Promise((r) => setTimeout(r, 20));
    await request(app).put(`${base}/${id}`).send({ status: "CONFIRMED" });
    expect((await stored(id) as any).confirmedAt.getTime()).toBe(first.getTime());
  });
  it("a booking created as CONFIRMED gets it at create; the body can't set it", async () => {
    const c = await request(app).post(base).send(visa({ status: "CONFIRMED", supplierName: "VFS", givenBy: "R", confirmedAt: "2020-01-01T00:00:00Z" }));
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const at = (await stored(String(c.body.booking._id)) as any).confirmedAt;
    expect(Math.abs(at.getTime() - Date.now())).toBeLessThan(60_000);
  });
});
