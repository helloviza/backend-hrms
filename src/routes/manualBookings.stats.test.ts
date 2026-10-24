// apps/backend/src/routes/manualBookings.stats.test.ts
//
// /admin/manual-bookings stat strip (Gross Sales, Net Sales, GST Payable, Net
// Profit, Booking Count, Avg Margin, Pending invoices) and the export TOTALS
// row follow the shared rule (utils/bookingMetrics.ts): CONFIRMED + INVOICED
// unless the status filter is set, never a deleted row — even with Show
// Deleted on — and demo session-aware. The list itself is unchanged: it still
// returns every row the filter matches.
//
// Real: manualBookings router, ManualBooking model, in-memory Mongo. Raw-insert
// fixtures, so rows without isActive / isDemo stay that way. Stubbed: auth
// (x-test-user), workspace + permission guards, S3, location, automations.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: (req: any, _res: any, next: any) => {
    req.workspaceObjectId = new mongoose.Types.ObjectId();
    req.workspace = { _id: req.workspaceObjectId, customerId: null };
    next();
  },
  requireResolvedWorkspace: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireFeature.js", () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
  requireAnyFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.permissionScope = "ALL";
    req.permissionAccess = "FULL";
    next();
  },
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/s3Upload.js", () => ({ uploadBufferToS3: async () => ({ bucket: "b", key: "k", url: "u" }), deleteObject: async () => {} }));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: async () => "signed://x" }));
vi.mock("../config/aws.js", () => ({ s3: { send: async () => ({}) } }));
vi.mock("../services/location.service.js", () => ({
  resolveActorFromRequest: async () => ({ location: { city: null, rawCity: null, source: "private-ip", confidence: 0, reason: "test" } }),
}));
vi.mock("../services/documentExtraction.service.js", () => ({ enqueueExtraction: async () => null }));
vi.mock("../services/taskAutomation.js", () => ({ triggerTaskAutomation: async () => null }));

const { default: manualBookingsRouter } = await import("./manualBookings.js");

const app = express();
app.use(express.json());
app.use("/api/admin/manual-bookings", manualBookingsRouter);

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const CUSTOMER = oid();
const STAFF = oid();
const superAdmin = { _id: String(STAFF), sub: String(STAFF), email: "sa@plumtrips.com", roles: ["SUPERADMIN"] };
const demoUser = { ...superAdmin, isDemoUser: true };
const as = (r: request.Test, u: any = superAdmin) => r.set("x-test-user", JSON.stringify(u));

const DAY = new Date("2026-10-10T06:00:00Z");
let seq = 0;
function row(status: string, grandTotal: number, extra: Record<string, any> = {}) {
  seq += 1;
  return {
    _id: oid(),
    bookingRef: `MB-TEST-${seq}`,
    workspaceId: CUSTOMER,
    type: "FLIGHT",
    status,
    bookingDate: DAY,
    createdAt: new Date(DAY.getTime() + seq * 1000),
    createdBy: String(STAFF),
    createdByEmail: superAdmin.email,
    bookedBy: STAFF,
    passengers: [{ name: `Pax ${seq}` }],
    pricing: { grandTotal, gstAmount: grandTotal / 10, basePrice: grandTotal / 5, quotedPrice: grandTotal, actualPrice: grandTotal / 2 },
    ...extra,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-bookings-stats-test"));
  await mongoose.connection.db!.collection("manualbookings").insertMany([
    row("CONFIRMED", 1000),                          // no isActive / isDemo keys at all
    row("INVOICED", 2000, { isActive: true, isDemo: false }),
    row("PENDING", 400),
    row("WIP", 500),
    row("CANCELLED", 800),
    row("CONFIRMED", 3000, { isActive: false }),    // soft-deleted
    row("CANCELLED", 7000, { isActive: false }),    // soft-deleted + cancelled
    row("CONFIRMED", 5000, { isDemo: true }),       // demo
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const list = (q = "", u: any = superAdmin) => as(request(app).get(`/api/admin/manual-bookings${q}`), u);

describe("manual-bookings stat strip", () => {
  it("default: CONFIRMED + INVOICED only; the list still shows every live row", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5); // list unchanged: all live, non-demo rows
    expect(res.body.stats).toEqual({
      grossSales: 3000,
      netSales: 2700,
      gstPayable: 300,
      netProfit: 600,
      bookingCount: 2,
      avgMargin: 22.22,
      pendingInvoices: 1, // the CONFIRMED one, not yet invoiced
    });
  });

  it("an explicit status filter counts exactly that status", async () => {
    const res = await list("?status=CANCELLED");
    expect(res.body.total).toBe(1);
    expect(res.body.stats).toMatchObject({ grossSales: 800, gstPayable: 80, bookingCount: 1, pendingInvoices: 0 });
    const pending = await list("?status=PENDING");
    expect(pending.body.stats).toMatchObject({ grossSales: 400, bookingCount: 1 });
  });

  it("Show Deleted lists deleted rows but never totals them (stats ignore the toggle)", async () => {
    const res = await list("?showDeleted=true");
    expect(res.body.total).toBe(2);
    expect(res.body.docs).toHaveLength(2);
    // Same figures as with the toggle off: the 3000 / 7000 deleted rows never appear.
    expect(res.body.stats).toMatchObject({ grossSales: 3000, gstPayable: 300, netProfit: 600, bookingCount: 2, pendingInvoices: 1 });
    const cancelled = await list("?showDeleted=true&status=CANCELLED");
    expect(cancelled.body.total).toBe(1); // the deleted cancelled row, listed
    expect(cancelled.body.stats).toMatchObject({ grossSales: 800, bookingCount: 1 }); // the live one, totalled
  });

  it("demo session counts only demo rows", async () => {
    const res = await list("", demoUser);
    expect(res.body.total).toBe(1);
    expect(res.body.stats).toMatchObject({ grossSales: 5000, bookingCount: 1 });
  });
});

describe("manual-bookings export TOTALS row", () => {
  async function exportRows(q: string) {
    const res = await as(request(app).get(`/api/admin/manual-bookings/export?format=xlsx${q}`))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const out: any[][] = [];
    wb.worksheets[0].eachRow((r) => out.push((r.values as any[]).slice(1)));
    return out;
  }
  const GST = 19, GRAND = 21; // 0-based: columns 20 (GST) and 22 (Grand Total)

  it("lists every row but totals only the counted ones", async () => {
    const rows = await exportRows("");
    const data = rows.filter((r) => typeof r[0] === "number");
    const totals = rows.find((r) => r[0] === "TOTALS")!;
    expect(data).toHaveLength(5);
    expect(totals[GRAND]).toBe(3000);
    expect(totals[GST]).toBe(300);
  });

  it("with a status filter, totals that status", async () => {
    const totals = (await exportRows("&status=CANCELLED")).find((r) => r[0] === "TOTALS")!;
    expect(totals[GRAND]).toBe(800);
  });

  it("Show Deleted never totals deleted rows", async () => {
    const rows = await exportRows("&showDeleted=true");
    expect(rows.filter((r) => typeof r[0] === "number")).toHaveLength(2);
    expect(rows.find((r) => r[0] === "TOTALS")![GRAND]).toBe(0);
  });
});

describe("markup analysis", () => {
  it("samples CONFIRMED + INVOICED rows only — never a deleted (or demo) one", async () => {
    const res = await as(request(app).post("/api/admin/manual-bookings/markup-analysis"))
      .send({ workspaceId: String(CUSTOMER), type: "FLIGHT", actualPrice: 100, quotedPrice: 120 });
    expect(res.status).toBe(200);
    // live CONFIRMED + live INVOICED; the deleted CONFIRMED and the demo row are out
    expect(res.body.sampleSize).toBe(2);
  });
});
