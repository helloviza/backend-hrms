// apps/backend/src/routes/reports.metrics.test.ts
//
// /admin/reports money and volume figures follow the shared rule
// (utils/bookingMetrics.ts): CONFIRMED + INVOICED by default, exactly the
// filtered status when ?status= is passed, never deleted, demo session-aware.
// The separate cancelledCount (and the other status buckets) still read every
// live status. Covers overview, breakdowns, CSV + XLSX export, send-now and
// the scheduler path (getReportData with no user).
//
// Real: reports router, ManualBooking model, in-memory Mongo. Fixtures are raw
// inserts, so the rows missing isActive / isDemo stay missing, as on prod.
// Stubbed: auth (x-test-user), workspace + SaaS guards, permissions, mailer.
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
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/blockTravelForSaas.js", () => ({
  blockTravelForSaas: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));
const mailed: any[] = [];
vi.mock("../utils/reportMailer.js", () => ({
  sendReportEmail: async (_s: any, data: any) => { mailed.push(data); },
}));

const { default: reportsRouter, getReportData } = await import("./reports.js");

const app = express();
app.use(express.json());
app.use("/api/admin/reports", reportsRouter);

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const CUSTOMER = oid();
const STAFF = oid();
const staff = { _id: String(STAFF), sub: String(STAFF), email: "ops@plumtrips.com", roles: ["ADMIN"] };
const demoUser = { ...staff, isDemoUser: true };
const as = (r: request.Test, u: any = staff) => r.set("x-test-user", JSON.stringify(u));

const DAY = new Date("2026-10-10T06:00:00Z");
function row(status: string, grandTotal: number, extra: Record<string, any> = {}) {
  return {
    _id: oid(),
    workspaceId: CUSTOMER,
    type: "FLIGHT",
    status,
    bookingDate: DAY,
    createdAt: DAY,
    bookingMonth: DAY.toLocaleString("en-IN", { month: "long", year: "numeric" }),
    createdBy: String(STAFF),
    createdByEmail: staff.email,
    bookedBy: STAFF,
    supplierName: "Air Co",
    pricing: { grandTotal, gstAmount: grandTotal / 10, basePrice: grandTotal / 5, quotedPrice: grandTotal, actualPrice: grandTotal / 2 },
    ...extra,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("reports-metrics-test"));
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

describe("/admin/reports — counted bookings", () => {
  it("default: only CONFIRMED + INVOICED, never deleted or demo (missing keys = live)", async () => {
    const res = await as(request(app).get("/api/admin/reports/summary"));
    expect(res.status).toBe(200);
    const ov = res.body.overview;
    expect(ov.bookingCount).toBe(2);
    expect(ov.totalBookings).toBe(2);
    expect(ov.grossSales).toBe(3000);
    expect(ov.gstPayable).toBe(300);
    expect(ov.netSales).toBe(2700);
    expect(ov.netProfit).toBe(600);
    expect(ov.avgMargin).toBe(22.22);
    // status buckets read every live status — the cancelled count keeps working
    expect(ov).toMatchObject({ pendingCount: 1, wipCount: 1, confirmedCount: 1, invoicedCount: 1, cancelledCount: 1 });
  });

  it("breakdowns use the same rows", async () => {
    const { body } = await as(request(app).get("/api/admin/reports/summary"));
    const sum = (rows: any[], k: string) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    expect(sum(body.byClient, "bookings")).toBe(2);
    expect(sum(body.byClient, "pendingAmount")).toBe(1000); // CONFIRMED, not yet invoiced
    expect(sum(body.byType, "count")).toBe(2);
    expect(sum(body.byStaff, "bookings")).toBe(2);
    expect(sum(body.byWeek, "bookings")).toBe(2);
    expect(sum(body.byMonth, "bookings")).toBe(2);
    expect(sum(body.byPartner, "bookings")).toBe(2);
    expect(sum(body.byEmployee, "bookings")).toBe(2);
  });

  it("an explicit status filter counts exactly that status (still never deleted)", async () => {
    const res = await as(request(app).get("/api/admin/reports/summary?status=CANCELLED"));
    expect(res.body.overview.bookingCount).toBe(1);
    expect(res.body.overview.grossSales).toBe(800);
    expect(res.body.overview.cancelledCount).toBe(1);
    const pending = await as(request(app).get("/api/admin/reports/summary?status=PENDING"));
    expect(pending.body.overview.bookingCount).toBe(1);
    expect(pending.body.overview.grossSales).toBe(400);
  });

  it("validates the status param against the enum", async () => {
    const res = await as(request(app).get("/api/admin/reports/summary?status=FAILED"));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_STATUS");
    const exp = await as(request(app).get("/api/admin/reports/export?status=DONE&format=csv"));
    expect(exp.status).toBe(400);
  });

  it("demo session sees only demo rows", async () => {
    const res = await as(request(app).get("/api/admin/reports/summary"), demoUser);
    expect(res.body.overview.bookingCount).toBe(1);
    expect(res.body.overview.grossSales).toBe(5000);
  });

  it("CSV export carries the counted totals and the separate cancelled count", async () => {
    const res = await as(request(app).get("/api/admin/reports/export?format=csv"));
    expect(res.status).toBe(200);
    expect(res.text).toContain("Total Bookings,2");
    expect(res.text).toContain("Total GST,300");
    expect(res.text).toContain("Cancelled,1");
  });

  it("XLSX export carries the counted totals", async () => {
    const res = await as(request(app).get("/api/admin/reports/export?format=xlsx"))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const values = wb.worksheets.flatMap((ws) => {
      const out: any[] = [];
      ws.eachRow((r) => out.push(r.values));
      return out;
    });
    const flat = JSON.stringify(values);
    expect(flat).not.toContain("7000");
    expect(flat).not.toContain("5000");
    expect(flat).toContain("3000");
  });

  it("send-now and the scheduler (no user) use the default rule", async () => {
    mailed.length = 0;
    const res = await as(request(app).post("/api/admin/reports/send-now").send({ recipients: ["a@b.c"] }));
    expect(res.status).toBe(200);
    expect(mailed[0].overview.bookingCount).toBe(2);
    expect(mailed[0].overview.cancelledCount).toBe(1);

    const scheduled = await getReportData({ dateFrom: "2026-10-01", dateTo: "2026-10-31" });
    expect(scheduled.overview.bookingCount).toBe(2);
    expect(scheduled.overview.grossSales).toBe(3000);
  });
});
