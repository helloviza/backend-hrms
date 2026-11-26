// apps/backend/src/routes/manualBookings.sbtLink.test.ts
//
// SBT → Manual Booking link, P1 routes (docs/specs/sbt-to-manual-booking-spec.md
// §3.1 / §3.3 / §3.4 / §8.2):
//   - PUT on a locked booking: a price change → 400 PRICE_LOCKED, notes → 200,
//     cancel by edit / POST /:id/cancel → 400 SBT_LINKED_CANCEL;
//   - duplicate PNR: create / PNR edit → 409 SBT_PNR_DUPLICATE with matches,
//     acknowledged → saved with duplicateAck; ±365-day window; a linked booking
//     is never its own duplicate; switch off → no guard; GET /pnr-check; bulk
//     import row skipped unless ackDuplicate = YES;
//   - the repair view lists only confirmed SBT bookings with no link, with the
//     last link error; import-from-sbt = the link service (locked, idempotent,
//     parallel-safe);
//   - Team Summary: client self-booked rows have their own row (never
//     Unassigned), and the list filters agree with it.
//
// Real: manual-bookings router, models, hooks, link service, in-memory Mongo.
// Stubbed: the caller, permissions, mailer, S3, location, extraction.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import XLSX from "xlsx";
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
vi.mock("../services/taskAutomation.js", () => ({ triggerTaskAutomation: async () => null }));

const { default: manualBookingsRouter } = await import("./manualBookings.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { default: SBTConfig } = await import("../models/SBTConfig.js");
const svc = await import("../services/sbtManualLink.js");
const { manualLinksSettled } = await import("../services/sbtManualLinkTrigger.js");
const idx = await import("../bootstrap/ensureSbtManualLinkIndexes.js");

const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const HOUSE_WS = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const STAFF = oid();
const CUSTOMER = oid();
const CWS = oid();
const CLIENT_USER = oid();

const app = express();
app.use(express.json());
app.use("/api/admin/manual-bookings", (req: any, _res, next) => {
  req.user = { _id: String(STAFF), sub: String(STAFF), roles: ["SUPERADMIN"], email: "ops@plumtrips.com", name: "Ops Desk" };
  req.workspace = { customerId: "PLUMTRIPS-HOUSE" };
  req.workspaceObjectId = HOUSE_WS;
  req.permissionScope = "ALL";
  req.permissionAccess = "FULL";
  next();
}, manualBookingsRouter);
const api = "/api/admin/manual-bookings";

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-bookings-sbt-link-test"));
}, 120_000);
afterAll(async () => {
  await manualLinksSettled();
  await mongoose.disconnect();
  await mongod?.stop();
});

async function setSwitch(enabled: boolean) {
  await SBTConfig.updateOne({ key: "global" }, { $set: { manualLinkEnabled: enabled, manualLinkEnabledAt: new Date("2026-12-01T00:00:00Z") } }, { upsert: true });
  svc.resetManualLinkSettingsCache();
}

beforeEach(async () => {
  await manualLinksSettled();
  await mongoose.connection.db!.dropDatabase();
  await idx.ensureSbtManualLinkIndexes({ log: () => {}, error: () => {} } as any);
  await col("customers").insertOne({ _id: CUSTOMER, name: "Osprey Labs", legalName: "Osprey Labs Pvt Ltd", legalNameNormalized: "osprey labs pvt ltd" });
  await col("customerworkspaces").insertOne({ _id: CWS, customerId: String(CUSTOMER), companyName: "Osprey Labs" });
  await col("users").insertMany([
    { _id: CLIENT_USER, email: "riya@osprey.test", name: "Riya Sen" },
    { _id: STAFF, email: "ops@plumtrips.com", name: "Ops Desk" },
  ]);
  await setSwitch(true);
});

function sbtFlight(over: Record<string, any> = {}) {
  return {
    _id: oid(),
    userId: CLIENT_USER,
    workspaceId: CWS,
    pnr: "QX7P2L",
    bookingId: "1882001",
    status: "CONFIRMED",
    origin: { code: "DEL", city: "Delhi" },
    destination: { code: "BOM", city: "Mumbai" },
    departureTime: "2026-12-20T06:30:00",
    arrivalTime: "2026-12-20T08:45:00",
    airlineCode: "6E",
    airlineName: "IndiGo",
    flightNumber: "6E2134",
    cabin: 2,
    passengers: [{ firstName: "Riya", lastName: "Sen", paxType: "ADULT", isLead: true, email: "riya@osprey.test" }],
    totalFare: 10790,
    marginAmount: 490,
    marginSource: "DEFAULT",
    paymentMode: "official",
    paymentStatus: "paid",
    bookedAt: new Date("2026-12-02T09:00:00Z"),
    ...over,
  };
}
async function insertFlight(over: Record<string, any> = {}) {
  const d = sbtFlight(over);
  await col("sbtbookings").insertOne(d);
  return d;
}
async function linkedBooking(over: Record<string, any> = {}) {
  const f = await insertFlight(over);
  const r: any = await svc.ensureLinkedManualBooking("SBTBooking", f, { via: "AUTO" });
  return { sbt: f, mb: r.booking };
}

const newBooking = (over: Record<string, any> = {}) => ({
  workspaceId: String(CUSTOMER),
  type: "FLIGHT",
  status: "PENDING",
  travelDate: "2026-12-20",
  sector: "Delhi-Mumbai",
  itinerary: { origin: "Delhi", destination: "Mumbai", airline: "IndiGo", flightNo: "6E2134" },
  passengers: [{ name: "Riya Sen", type: "ADULT" }],
  pricing: { actualPrice: 10000, quotedPrice: 10790, gstMode: "ON_MARKUP", gstPercent: 18, currency: "INR" },
  supplierName: "IndiGo",
  supplierPNR: "QX7P2L",
  ...over,
});

/* ── price lock + cancel (§3.3) ───────────────────────────────────── */

describe("PUT / cancel on a linked booking", () => {
  it("a price change is refused with PRICE_LOCKED; notes save; the price is unchanged", async () => {
    const { mb } = await linkedBooking();
    const bad = await request(app).put(`${api}/${mb._id}`).send({ pricing: { ...mb.pricing, quotedPrice: 9999 } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "PRICE_LOCKED", fields: ["quotedPrice"] });

    // The edit form re-sends the stored pricing untouched — that is fine.
    const ok = await request(app).put(`${api}/${mb._id}`).send({
      notes: "Window seat",
      pricing: { actualPrice: mb.pricing.actualPrice, quotedPrice: mb.pricing.quotedPrice, gstMode: "ON_MARKUP", gstPercent: 18, currency: "INR" },
      lineItems: [],
    });
    expect(ok.status).toBe(200);
    const after: any = await ManualBooking.findById(mb._id).lean();
    expect(after.notes).toBe("Window seat");
    expect(after.pricing).toMatchObject({ actualPrice: 10300, quotedPrice: 10790, grandTotal: 10790 });

    const type = await request(app).put(`${api}/${mb._id}`).send({ type: "HOTEL" });
    expect(type.status).toBe(400);
    expect(type.body.code).toBe("PRICE_LOCKED");
  });

  it("cancelling by edit or by the cancel button is refused — it is cancelled in SBT", async () => {
    const { mb } = await linkedBooking();
    const edit = await request(app).put(`${api}/${mb._id}`).send({ status: "CANCELLED" });
    expect(edit.status).toBe(400);
    expect(edit.body.code).toBe("SBT_LINKED_CANCEL");
    const cancel = await request(app).post(`${api}/${mb._id}/cancel`).send({ reason: "CUSTOMER_CANCELLED" });
    expect(cancel.status).toBe(400);
    expect(cancel.body.code).toBe("SBT_LINKED_CANCEL");
    expect((await ManualBooking.findById(mb._id).lean() as any).status).toBe("CONFIRMED");
  });
});

/* ── duplicate PNR (§3.4) ─────────────────────────────────────────── */

describe("duplicate PNR guard", () => {
  it("create with an SBT PNR → 409 with the matches; acknowledged → saved with duplicateAck", async () => {
    const { mb } = await linkedBooking();
    const res = await request(app).post(api).send(newBooking());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SBT_PNR_DUPLICATE");
    expect(res.body.error).toMatch(new RegExp(`${mb.bookingRef}, linked automatically`));
    expect(res.body.matches).toEqual([expect.objectContaining({ kind: "FLIGHT", pnr: "QX7P2L", linkedBookingRef: mb.bookingRef })]);
    expect(await ManualBooking.countDocuments({})).toBe(1);

    const ack = await request(app).post(api).send(newBooking({ acknowledgeSbtDuplicate: true }));
    expect(ack.status).toBe(201);
    const saved: any = await ManualBooking.findById(ack.body.booking._id).lean();
    expect(saved.duplicateAck).toMatchObject({ byName: "Ops Desk" });
    expect(saved.duplicateAck.matches[0]).toMatchObject({ pnr: "QX7P2L" });
  });

  it("matches a return PNR and a hotel confirmation number, case-insensitively for hotels", async () => {
    await insertFlight({ pnr: "OUT111", returnPnr: "RET222" });
    await col("sbthotelbookings").insertOne({ _id: oid(), userId: CLIENT_USER, workspaceId: CWS, confirmationNo: "cnf889911", status: "CONFIRMED", checkIn: "2026-12-20" });
    expect((await request(app).post(api).send(newBooking({ supplierPNR: "RET222" }))).status).toBe(409);
    const h = await request(app).get(`${api}/pnr-check`).query({ pnr: "CNF889911", travelDate: "2026-12-21" });
    expect(h.body.matches).toEqual([expect.objectContaining({ kind: "HOTEL", pnr: "cnf889911", linkedBookingRef: null })]);
  });

  it("outside ±365 days, a test booking, or a short token: no warning", async () => {
    await insertFlight({ pnr: "ZZ1111", departureTime: "2024-01-05T06:30:00" });
    await insertFlight({ pnr: "TT2222", isTest: true });
    expect((await request(app).post(api).send(newBooking({ supplierPNR: "ZZ1111" }))).status).toBe(201);
    expect((await request(app).post(api).send(newBooking({ supplierPNR: "TT2222" }))).status).toBe(201);
    expect((await request(app).get(`${api}/pnr-check`).query({ pnr: "AB1" })).body.matches).toEqual([]);
  });

  it("the switch off turns the guard off", async () => {
    await insertFlight();
    await setSwitch(false);
    expect((await request(app).post(api).send(newBooking())).status).toBe(201);
  });

  it("PUT: changing the PNR to an SBT one → 409; the linked booking is never its own duplicate", async () => {
    const { mb } = await linkedBooking();
    const other = await request(app).post(api).send(newBooking({ supplierPNR: "MAN999" }));
    expect(other.status).toBe(201);
    const put = await request(app).put(`${api}/${other.body.booking._id}`).send({ supplierPNR: "QX7P2L" });
    expect(put.status).toBe(409);
    expect(put.body.code).toBe("SBT_PNR_DUPLICATE");
    // The linked row re-saving its own PNR (case change) is fine.
    expect((await request(app).put(`${api}/${mb._id}`).send({ supplierPNR: "qx7p2l" })).status).toBe(200);
    expect((await request(app).get(`${api}/pnr-check`).query({ pnr: "QX7P2L", bookingId: String(mb._id) })).body.matches).toEqual([]);
  });

  it("bulk import: a matching row is skipped unless ackDuplicate = YES", async () => {
    await insertFlight();
    const sheet = (ack: string) => {
      const ws = XLSX.utils.aoa_to_sheet([
        ["type", "clientName", "travelDate", "passengerName", "actualPrice", "quotedPrice", "supplierName", "supplierPNR", "ackDuplicate"],
        ["FLIGHT", "Osprey Labs Pvt Ltd", "20-12-2026", "Riya Sen", "10000", "10790", "IndiGo", "QX7P2L", ack],
        ["FLIGHT", "Osprey Labs Pvt Ltd", "20-12-2026", "Arun Sen", "5000", "5600", "IndiGo", "FRESH9", ""],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Bookings");
      return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    };
    const dry = await request(app).post(`${api}/import?dryRun=true`).attach("file", sheet(""), "b.xlsx");
    expect(dry.status).toBe(200);
    expect(dry.body.summary).toEqual({ valid: 1, invalid: 1 });
    expect(dry.body.rows[0]).toMatchObject({ valid: false, code: "SBT_PNR_DUPLICATE" });
    expect(dry.body.rows[0].errors[0].error).toMatch(/ackDuplicate = YES/);

    const commit = await request(app).post(`${api}/import?dryRun=false`).attach("file", sheet("YES"), "b.xlsx");
    expect(commit.body.inserted).toBe(2);
    const acked: any = await ManualBooking.findOne({ supplierPNR: "QX7P2L", source: "MANUAL" }).lean();
    expect(acked.duplicateAck.matches[0]).toMatchObject({ pnr: "QX7P2L" });
  });
});

/* ── repair view + import (§3.1) ──────────────────────────────────── */

describe("SBT queue = repair view; import-from-sbt = link now", () => {
  it("lists only confirmed, unlinked SBT bookings, with the last link error", async () => {
    const open = await insertFlight({ pnr: "OPEN01", manualLinkError: "NO_CUSTOMER: …", manualLinkAttempts: 2 });
    const { sbt: linked } = await linkedBooking({ pnr: "LINK01" });
    const legacy = await insertFlight({ pnr: "LEG001" });
    await col("manualbookings").insertOne({ bookingRef: "MB-OLD-1", source: "SBT", sourceBookingId: legacy._id, workspaceId: CUSTOMER, type: "FLIGHT", status: "CONFIRMED", travelDate: new Date(), bookedBy: STAFF });
    await insertFlight({ pnr: "PEND01", status: "PENDING" });
    await insertFlight({ pnr: "TEST01", isTest: true });
    await col("sbthotelbookings").insertOne({ _id: oid(), status: "HELD", hotelName: "Held Inn", workspaceId: CWS });

    const res = await request(app).get(`${api}/sbt-queue`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.bookingRef)).toEqual(["OPEN01"]);
    expect(res.body.items[0]).toMatchObject({ _id: String(open._id), linkError: "NO_CUSTOMER: …", linkAttempts: 2, clientName: "Osprey Labs Pvt Ltd", workspaceId: String(CUSTOMER) });
    expect(String(linked._id)).not.toBe(res.body.items[0]._id);
  });

  it("import links through the service (locked, bookedBy = the client); twice → skipped; parallel → one row", async () => {
    const f = await insertFlight();
    const first = await request(app).post(`${api}/import-from-sbt`).send({ bookingIds: [String(f._id)] });
    expect(first.body).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
    const mb: any = await ManualBooking.findOne({ "sbtLink.bookingId": f._id }).lean();
    expect(mb).toMatchObject({ source: "SBT", clientSelfBooked: true, sbtLink: expect.objectContaining({ createdVia: "IMPORT" }) });
    expect(String(mb.bookedBy)).toBe(String(CLIENT_USER));
    expect(mb.pricingLocked).toBeTruthy();
    expect(mb.notes).toMatch(/linked from the SBT queue by ops@plumtrips.com/);

    const again = await request(app).post(`${api}/import-from-sbt`).send({ bookingIds: [String(f._id)] });
    expect(again.body).toMatchObject({ imported: 0, skipped: 1 });

    const g = await insertFlight({ pnr: "PAR001" });
    const both = await Promise.all([1, 2, 3].map(() => request(app).post(`${api}/import-from-sbt`).send({ bookingIds: [String(g._id)] })));
    expect(both.reduce((s, r) => s + r.body.imported, 0)).toBe(1);
    expect(await ManualBooking.countDocuments({ "sbtLink.bookingId": g._id })).toBe(1);
  });

  it("refuses test, cancelled and not-confirmed bookings (works with the switch off)", async () => {
    await setSwitch(false);
    const t = await insertFlight({ isTest: true });
    const c = await insertFlight({ status: "CANCELLED" });
    const p = await insertFlight({ status: "PENDING" });
    const res = await request(app).post(`${api}/import-from-sbt`).send({ bookingIds: [String(t._id), String(c._id), String(p._id), String(oid())] });
    expect(res.body.details.map((d: any) => d.error)).toEqual([
      "test booking — not imported",
      "cancelled booking — not imported",
      "not confirmed yet — not imported",
      "source booking not found",
    ]);
    expect(await ManualBooking.countDocuments({})).toBe(0);
  });
});

/* ── Team Summary + list filters (§3.2) ───────────────────────────── */

describe("Team Summary bucket", () => {
  it("self-booked rows have their own row in both groupings, never Unassigned; filters agree", async () => {
    await linkedBooking({ pnr: "SELF01" });
    await linkedBooking({ pnr: "SELF02" });
    // An ops enquiry with no assignee — the only real Unassigned case.
    await col("manualbookings").insertOne({
      bookingRef: "MB-UNA-1", workspaceId: CUSTOMER, type: "FLIGHT", status: "PENDING", source: "MANUAL",
      bookingDate: new Date("2026-12-02T09:00:00Z"), travelDate: new Date(), bookedBy: STAFF, createdBy: String(STAFF),
      assignmentStatus: "PENDING_TO_ASSIGN", isActive: true, pricing: { quotedPrice: 0 }, createdAt: new Date(),
    });
    const range = "dateFrom=2026-12-01&dateTo=2026-12-31";
    for (const groupBy of ["assignee", "creator"]) {
      const s = await request(app).get(`${api}/summary?${range}&groupBy=${groupBy}`);
      expect(s.status).toBe(200);
      const self = s.body.rows.find((r: any) => r.key === "sbt-self");
      expect(self).toMatchObject({ name: "Client self-booked (SBT)", completed: 2, pending: 0, gmv: 21580 });
      // The ops enquiry sits on Unassigned (by assignee) / its creator (by creator) — never the self-booked row.
      const opsRow = s.body.rows.find((r: any) => r.key === (groupBy === "assignee" ? null : String(STAFF)));
      expect(opsRow).toMatchObject({ pending: 1, completed: 0 });
      expect(s.body.rows.filter((r: any) => r.name === "Unknown user")).toEqual([]);
      expect(s.body.top5.map((t: any) => t.key)).not.toContain("sbt-self");
    }

    const list = async (q: string) => (await request(app).get(`${api}?${q}&limit=50`)).body;
    const refs = (b: any) => (b.docs ?? []).map((x: any) => x.bookingRef).sort();
    expect(refs(await list("assignPerson=sbt-self")).length).toBe(2);
    expect(refs(await list("createdBy=sbt-self")).length).toBe(2);
    expect(refs(await list("assignPerson=none"))).toEqual(["MB-UNA-1"]);
    expect(refs(await list("assignmentStatus=PENDING_TO_ASSIGN"))).toEqual(["MB-UNA-1"]);
  });
});
