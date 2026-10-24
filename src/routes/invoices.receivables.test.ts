// apps/backend/src/routes/invoices.receivables.test.ts
//
// Invoice list card "Total Receivables" never sums a CANCELLED invoice —
// with no status filter, and even when the list is filtered to CANCELLED.
// The other cards are unchanged.
//
// Real: invoices router, Invoice model, in-memory Mongo, raw-insert fixtures.
// Stubbed: auth (x-test-user), workspace resolver, PDF / S3 / automations.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../utils/invoicePdf.js", () => ({
  generateInvoicePdf: vi.fn(async () => Buffer.from("%PDF")),
  prefetchInvoiceAssets: vi.fn(async () => ({})),
}));
vi.mock("../utils/s3Upload.js", () => ({ uploadAndPresign: vi.fn(async (k: string) => `https://s3.test/${k}`) }));
vi.mock("../services/taskAutomation.js", () => ({ triggerTaskAutomation: vi.fn(async () => undefined) }));

const { default: invoicesRouter } = await import("./invoices.js");

const oid = () => new mongoose.Types.ObjectId();
const HOUSE = "69679a7628330a58d29f2254";
const SA_ID = oid();
const SA_USER = { _id: String(SA_ID), id: String(SA_ID), sub: String(SA_ID), roles: ["SUPERADMIN"], workspaceId: HOUSE };

const app = express();
app.use(express.json());
app.use(
  "/api/admin/invoices",
  (req: any, _res: any, next: any) => {
    req.workspaceObjectId = new mongoose.Types.ObjectId(HOUSE);
    next();
  },
  invoicesRouter,
);
const list = (q = "") =>
  request(app).get(`/api/admin/invoices${q}`).set("x-test-user", JSON.stringify(SA_USER));

let mongod: MongoMemoryServer;
const WS = oid();
let n = 0;
function inv(status: string, grandTotal: number) {
  n += 1;
  return {
    _id: oid(),
    invoiceNo: `INV-RCV-${n}`,
    workspaceId: WS,
    status,
    grandTotal,
    invoiceDate: new Date("2026-10-10"),
    generatedAt: new Date("2026-10-10"),
    lineItems: [],
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("invoices-receivables-test"));
  await mongoose.connection.db!.collection("invoices").insertMany([
    inv("DRAFT", 300),
    inv("SENT", 1000),
    inv("PAID", 2000),
    inv("CANCELLED", 5000),
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("invoice list — Total Receivables", () => {
  it("excludes CANCELLED invoices; the other cards are unchanged", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4); // the list still shows the cancelled one
    expect(res.body.stats.totalReceivables).toBe(3300);
    expect(res.body.stats.outstanding).toBe(1300);
    expect(res.body.stats.pendingCount).toBe(2);
  });

  it("is 0 even when the list is filtered to CANCELLED", async () => {
    const res = await list("?status=CANCELLED");
    expect(res.body.total).toBe(1);
    expect(res.body.stats.totalReceivables).toBe(0);
  });
});
