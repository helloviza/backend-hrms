// apps/backend/src/routes/myBookings.carbon.cancelled.test.ts
//
// Flight Emissions card, reporting rule v2 (CARBON_REPORTING_RULE_VERSION):
// records whose ManualBooking is CANCELLED or soft-deleted are left out of the
// total; records on a live booking, or on no booking at all, still count.
//
// Real: myBookings router, CarbonRecord / ManualBooking / ExtractedDocument
// models, in-memory Mongo, raw-insert fixtures. req.user / req.workspace are
// injected, as in myBookings.carbon.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const { default: router } = await import("./myBookings.js");
const { CARBON_CALCULATION_VERSION, CARBON_REPORTING_RULE_VERSION } = await import("../services/carbonEngine.service.js");

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const CUSTOMER = oid();
const leader = { _id: String(oid()), email: "lead@acme.test", roles: ["WORKSPACE_LEADER"] };

const app = express();
app.use((req: any, _res, next) => {
  req.user = leader;
  req.workspace = { customerId: String(CUSTOMER) };
  next();
});
app.use("/", router);

const B = { confirmed: oid(), invoiced: oid(), cancelled: oid(), deleted: oid(), noFlags: oid() };
let seg = 0;
function record(bookingId: mongoose.Types.ObjectId | null, co2eKg: number, extra: Record<string, any> = {}) {
  seg += 1;
  return {
    workspaceId: CUSTOMER,
    extractedDocumentId: oid(),
    bookingId,
    passengerIndex: 0,
    segmentIndex: seg,
    calculationVersion: CARBON_CALCULATION_VERSION,
    status: "calculated",
    confidence: "high",
    travelMonth: "2026-10",
    co2eKg,
    ...extra,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("carbon-cancelled-test"));
  const db = mongoose.connection.db!;
  await db.collection("manualbookings").insertMany([
    { _id: B.confirmed, bookingRef: "MB-C1", workspaceId: CUSTOMER, status: "CONFIRMED", isActive: true },
    { _id: B.invoiced, bookingRef: "MB-C2", workspaceId: CUSTOMER, status: "INVOICED" },
    { _id: B.cancelled, bookingRef: "MB-C3", workspaceId: CUSTOMER, status: "CANCELLED" },
    { _id: B.deleted, bookingRef: "MB-C4", workspaceId: CUSTOMER, status: "CONFIRMED", isActive: false },
    { _id: B.noFlags, bookingRef: "MB-C5", workspaceId: CUSTOMER, status: "PENDING" }, // pending still flies
  ]);
  await db.collection("carbonrecords").insertMany([
    record(B.confirmed, 100),
    record(B.invoiced, 200),
    record(B.cancelled, 400),
    record(B.deleted, 800),
    record(B.noFlags, 16),
    record(null, 32), // no booking link at all
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("GET /my-bookings/carbon — cancelled and deleted bookings", () => {
  it("leaves out records of cancelled / deleted bookings; keeps live and unlinked ones", async () => {
    const res = await request(app).get("/carbon");
    expect(res.status).toBe(200);
    expect(res.body.reportingRuleVersion).toBe(CARBON_REPORTING_RULE_VERSION);
    expect(res.body.totalCo2eKg).toBe(100 + 200 + 16 + 32);
    expect(res.body.records).toBe(4);
    expect(res.body.priced).toBe(4);
    expect(res.body.documents).toBe(4);
  });
});
