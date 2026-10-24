// apps/backend/src/routes/myBookings.stats.metrics.test.ts
//
// Customer Overview / Bookings cards (GET /api/my-bookings/stats): Total
// Trips, Total Spend and the by-service split count CONFIRMED + INVOICED
// bookings only — never PENDING / WIP / CANCELLED, never deleted, and demo
// session-aware (utils/bookingMetrics.ts).
//
// Real: myBookings router, ManualBooking model, in-memory Mongo, raw-insert
// fixtures (rows missing isActive / isDemo stay missing). Auth and the
// workspace resolver are not part of this router; the test injects req.user
// and req.workspace, as myBookings.stats.test.ts does.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const { default: router } = await import("./myBookings.js");

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const CUSTOMER = oid();
const leader = { _id: String(oid()), email: "lead@acme.test", roles: ["WORKSPACE_LEADER"] };
const demoLeader = { ...leader, isDemoUser: true };

function makeApp(user: any) {
  const app = express();
  app.use((req: any, _res, next) => {
    req.user = user;
    req.workspace = { customerId: String(CUSTOMER) };
    next();
  });
  app.use("/", router);
  return app;
}

const DAY = new Date("2026-10-10T06:00:00Z");
let seq = 0;
function row(status: string, grandTotal: number, extra: Record<string, any> = {}) {
  seq += 1;
  return {
    _id: oid(),
    bookingRef: `MB-CUST-${seq}`,
    workspaceId: CUSTOMER,
    type: "FLIGHT",
    status,
    bookingDate: DAY,
    passengers: [{ name: `Pax ${seq}`, email: `pax${seq}@acme.test` }],
    pricing: { grandTotal },
    ...extra,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("my-bookings-stats-metrics-test"));
  await mongoose.connection.db!.collection("manualbookings").insertMany([
    row("CONFIRMED", 1000), // no isActive / isDemo keys
    row("INVOICED", 2000, { isActive: true, isDemo: false }),
    row("PENDING", 400),
    row("WIP", 500),
    row("CANCELLED", 800),
    row("CONFIRMED", 3000, { isActive: false }),
    row("CONFIRMED", 5000, { isDemo: true }),
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const Q = "/stats?from=2026-10-01&to=2026-10-31";

describe("GET /my-bookings/stats — counted bookings", () => {
  it("Total Trips / Spend count CONFIRMED + INVOICED only", async () => {
    const res = await request(makeApp(leader)).get(Q);
    expect(res.status).toBe(200);
    const p = res.body.primary;
    expect(p.totalTrips).toBe(2);
    expect(p.totalSpend).toBe(3000);
    expect(p.flightCount).toBe(2);
    expect(p.travellerCount).toBe(2);
  });

  it("a demo session counts only demo rows", async () => {
    const p = (await request(makeApp(demoLeader)).get(Q)).body.primary;
    expect(p.totalTrips).toBe(1);
    expect(p.totalSpend).toBe(5000);
  });
});
