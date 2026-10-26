// apps/backend/src/routes/invoices.paymentLinks.test.ts
//
// An invoice moving to CANCELLED (POST /:id/cancel) cancels its open payment
// links and reports the paid ones. Never blocks the cancellation (a Razorpay
// failure still cancels the invoice), makes no Razorpay call when the invoice
// has no payment request, and never touches a BOOKING-subject request on the
// invoice's bookings.
//
// Real: invoices router, services/paymentRequests.ts, models, in-memory Mongo,
// raw-insert fixtures. Stubbed: auth, PDF / S3 / automations, and the Razorpay
// Payment Links client (no network).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.RAZORPAY_KEY_ID = "rzp_test_paylinks";
process.env.RAZORPAY_KEY_SECRET = "test_secret";

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

const rz = { cancelled: [] as string[], failCancel: false };
vi.mock("../services/razorpayPaymentLinks.js", async () => {
  const actual: any = await vi.importActual("../services/razorpayPaymentLinks.js");
  return {
    ...actual,
    cancelPaymentLink: vi.fn(async (id: string) => {
      if (rz.failCancel) throw new Error("Razorpay unavailable");
      rz.cancelled.push(id);
      return { id, status: "cancelled" };
    }),
    fetchPaymentLinkByReference: vi.fn(async () => null),
  };
});

const { default: invoicesRouter } = await import("./invoices.js");
const { default: PaymentRequest } = await import("../models/PaymentRequest.js");

const oid = () => new mongoose.Types.ObjectId();
const HOUSE = "69679a7628330a58d29f2254";
const SA_ID = oid();
const SA_USER = { _id: String(SA_ID), id: String(SA_ID), sub: String(SA_ID), roles: ["SUPERADMIN"], workspaceId: HOUSE };

const app = express();
app.use(express.json());
app.use("/api/admin/invoices", (req: any, _res: any, next: any) => {
  req.workspaceObjectId = new mongoose.Types.ObjectId(HOUSE);
  next();
}, invoicesRouter);
const cancel = (id: unknown) =>
  request(app).post(`/api/admin/invoices/${id}/cancel`).set("x-test-user", JSON.stringify(SA_USER)).send({ reason: "Wrong client" });

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const WS = oid();
const CUST = oid();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("invoices-payment-links-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

let INVOICE: mongoose.Types.ObjectId;
let BOOKING: mongoose.Types.ObjectId;
let n = 0;
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await PaymentRequest.syncIndexes();
  rz.cancelled = [];
  rz.failCancel = false;
  INVOICE = oid();
  BOOKING = oid();
  n += 1;
  await col("manualbookings").insertOne({ _id: BOOKING, workspaceId: CUST, bookingRef: `MB-INV-${n}`, status: "INVOICED", invoiceId: INVOICE, pricing: { grandTotal: 1000 } });
  await col("invoices").insertOne({
    _id: INVOICE, invoiceNo: `INV-PL-${n}`, workspaceId: WS, status: "SENT", grandTotal: 1000, subtotal: 1000, totalGST: 0,
    bookingIds: [BOOKING], lineItems: [], invoiceDate: new Date(), generatedAt: new Date(),
  });
});

/** A request on `subject`: link 1 PAID, link 2 open on Razorpay, link 3 never created. */
async function seed(subject: "INVOICE" | "BOOKING") {
  const _id = oid();
  const link = (seq: number, status: string, extra: any = {}) => ({
    _id: oid(), seq, basePaise: 33333, pgChargePaise: 0, totalPaise: 33333,
    referenceId: `PBX-${_id}-${seq}`, expireBy: new Date(Date.now() + 86400000), status, createAttempts: 1, emailOutboxIds: [], ...extra,
  });
  await PaymentRequest.create({
    _id, subject, subjectId: subject === "INVOICE" ? INVOICE : BOOKING, bookingIds: [BOOKING], invoiceId: subject === "INVOICE" ? INVOICE : undefined,
    customerId: CUST, invoiceWorkspaceId: WS, subjectRef: "x", targetBasePaise: 99999,
    targetSource: { kind: subject === "INVOICE" ? "INVOICE_GRAND_TOTAL" : "BOOKING_GRAND_TOTAL", valueAtCreation: 999.99 },
    splitPattern: "EQUAL:3", pgChargePct: 0, recipient: { email: "ap@client.com" }, status: "PARTLY_PAID", isOpen: true, createdBy: "rm",
    links: [
      link(1, "PAID", { razorpayLinkId: `plink_paid_${_id}`, razorpayPaymentId: `pay_${_id}`, paidAt: new Date() }),
      link(2, "CREATED", { razorpayLinkId: `plink_open_${_id}`, shortUrl: "https://rzp.io/i/x" }),
      link(3, "FAILED_CREATE", { createError: "timeout" }),
    ],
  });
  return { requestId: String(_id), openRazorpayId: `plink_open_${_id}` };
}
const linkStatuses = async (id: string) => ((await PaymentRequest.findById(id).lean()) as any).links.map((l: any) => l.status);
const invoiceStatus = async () => ((await col("invoices").findOne({ _id: INVOICE })) as any).status;

describe("invoice cancelled → its open payment links are cancelled", () => {
  it("cancels the open links on Razorpay and here, and reports the paid one", async () => {
    const { requestId, openRazorpayId } = await seed("INVOICE");
    const res = await cancel(INVOICE);
    expect(res.status).toBe(200);
    expect(await invoiceStatus()).toBe("CANCELLED");
    expect(rz.cancelled).toEqual([openRazorpayId]);
    expect(await linkStatuses(requestId)).toEqual(["PAID", "CANCELLED", "CANCELLED"]);
    expect(res.body.paymentLinks.paid).toHaveLength(1);
    expect(res.body.paymentLinks.paid[0].basePaise).toBe(33333);
    expect(res.body.paymentLinks.cancelled).toHaveLength(2);
  });

  it("an invoice with no payment request: no Razorpay call, paymentLinks null", async () => {
    const res = await cancel(INVOICE);
    expect(res.status).toBe(200);
    expect(res.body.paymentLinks).toBeNull();
    expect(rz.cancelled).toEqual([]);
  });

  it("booking-level links on the invoice's bookings are left alone", async () => {
    const { requestId } = await seed("BOOKING");
    const res = await cancel(INVOICE);
    expect(res.status).toBe(200);
    expect(res.body.paymentLinks).toBeNull();
    expect(await linkStatuses(requestId)).toEqual(["PAID", "CREATED", "FAILED_CREATE"]);
  });

  it("Razorpay failing never blocks the cancellation", async () => {
    const { requestId } = await seed("INVOICE");
    rz.failCancel = true;
    const res = await cancel(INVOICE);
    expect(res.status).toBe(200);
    expect(await invoiceStatus()).toBe("CANCELLED");
    expect(res.body.paymentLinks.failed.map((f: any) => f.error).join(" ")).toMatch(/Razorpay/);
    expect(await linkStatuses(requestId)).toEqual(["PAID", "CREATED", "CANCELLED"]);
  });

  it("a refused cancel (already PAID invoice) touches no link", async () => {
    const { requestId } = await seed("INVOICE");
    await col("invoices").updateOne({ _id: INVOICE }, { $set: { status: "PAID" } });
    const res = await cancel(INVOICE);
    expect(res.status).toBe(400);
    expect(rz.cancelled).toEqual([]);
    expect(await linkStatuses(requestId)).toEqual(["PAID", "CREATED", "FAILED_CREATE"]);
  });
});
