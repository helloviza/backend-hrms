// apps/backend/src/services/eodSnapshot.metrics.test.ts
//
// Every ManualBooking figure in the EOD WhatsApp snapshot — Today / WTD / MTD
// KPIs, the by-type breakdown, top performers, top clients and the 7-day
// trend — follows the shared rule (utils/bookingMetrics.ts): CONFIRMED +
// INVOICED only, never deleted, never demo. The dead "FAILED" alert is gone.
//
// Real: computeEodSnapshot, ManualBooking / User / Customer models, in-memory
// Mongo, raw-insert fixtures (rows missing isActive / isDemo stay missing).
// Stubbed: WhatsApp transport and the image renderer.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("./whatsappService.js", () => ({ whatsappService: {} }));
vi.mock("./eodImageRenderer.js", () => ({ renderEodImage: async () => null }));

const { computeEodSnapshot } = await import("./eodSnapshot.js");

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const STAFF = oid();
const CUSTOMER = oid();

let seq = 0;
function row(status: string, grandTotal: number, extra: Record<string, any> = {}) {
  seq += 1;
  return {
    _id: oid(),
    bookingRef: `MB-EOD-${seq}`,
    workspaceId: CUSTOMER,
    type: "FLIGHT",
    status,
    bookingDate: new Date(), // today (IST) — the snapshot's every range includes it
    bookedBy: STAFF,
    pricing: { grandTotal, gstAmount: grandTotal / 10, basePrice: grandTotal / 5 },
    ...extra,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("eod-metrics-test"));
  const db = mongoose.connection.db!;
  await db.collection("users").insertOne({ _id: STAFF, name: "Neel", firstName: "Neel", email: "neel@plumtrips.com" });
  await db.collection("customers").insertOne({ _id: CUSTOMER, name: "Acme", legalName: "Acme Pvt Ltd" });
  await db.collection("manualbookings").insertMany([
    row("CONFIRMED", 1000), // no isActive / isDemo keys
    row("INVOICED", 2000, { isActive: true, isDemo: false }),
    row("PENDING", 400),
    row("WIP", 500),
    row("CANCELLED", 800),
    row("CONFIRMED", 3000, { isActive: false }),
    row("CONFIRMED", 5000, { isDemo: true }),
    // A FAILED status never existed in the enum; even a raw row carrying it
    // must not resurrect the old alert line.
    row("FAILED", 50),
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("EOD snapshot — counted bookings", () => {
  it("Today / WTD / MTD, breakdown, performers, clients and trend count CONFIRMED + INVOICED only", async () => {
    const snap = await computeEodSnapshot({
      wtdSummary: true,
      mtdSummary: true,
      typeBreakdown: true,
      topPerformers: true,
      topClients: true,
      pipelineFollowups: false,
      alerts: { failedBookings: true, holdsExpiring: false, overdueInvoices: false },
    } as any);

    for (const k of [snap.today, snap.wtd!, snap.mtd!]) {
      expect(k.bookings).toBe(2);
      expect(k.revenue).toBe(3000);
      expect(k.gst).toBe(300);
      expect(k.netSales).toBe(2700);
      expect(k.baseProfit).toBe(600);
    }
    expect(snap.breakdown.reduce((a, r) => a + r.bookings, 0)).toBe(2);
    expect(snap.breakdown.reduce((a, r) => a + r.netSales, 0)).toBe(2700);
    expect(snap.performers).toHaveLength(1);
    expect(snap.performers[0]).toMatchObject({ bookings: 2, revenue: 3000 });
    expect(snap.clients).toHaveLength(1);
    expect(snap.clients[0]).toMatchObject({ bookings: 2, revenue: 3000 });
    const today = snap.trend7d.find((t) => t.isToday)!;
    expect(today.netSales).toBe(2700);
    // the dead FAILED alert line is gone, even with its toggle on
    expect(snap.alerts.some((a) => /FAILED/.test(a))).toBe(false);
  });
});
