// apps/backend/src/routes/manualBookings.paymentLinks.test.ts
//
// A booking moving to CANCELLED cancels its open payment links and reports the
// paid ones — by edit (PUT /:id) and by the cancel action (POST /:id/cancel).
// A Razorpay failure never undoes or blocks the cancellation, and a booking
// with no payment request makes no Razorpay call at all.
//
// Real: manual-bookings router, services/paymentRequests.ts, models, in-memory
// Mongo. Stubbed: the caller, requirePermission, mail, S3, and the Razorpay
// Payment Links client (no network).
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
process.env.RAZORPAY_KEY_ID = "rzp_test_paylinks";
process.env.RAZORPAY_KEY_SECRET = "test_secret";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (_req: any, _res: any, next: any) => next();
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: async () => ({ messageId: "test" }) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: async (o: any) => ({ bucket: "test-bucket", key: `${o.keyPrefix}/${o.originalName}`, url: "" }),
  getObjectBuffer: async (key: string) => Buffer.from(`BYTES:${key}`),
}));
vi.mock("../services/documentExtraction.service.js", async (orig) => ({ ...(await orig<any>()), enqueueExtraction: async () => undefined }));
vi.mock("../services/location.service.js", async (orig) => ({ ...(await orig<any>()), resolveActorFromRequest: async () => null }));

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

const { default: manualBookingsRouter } = await import("./manualBookings.js");
const { default: PaymentRequest } = await import("../models/PaymentRequest.js");

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const oid = () => new mongoose.Types.ObjectId();
const OPS = { sub: String(oid()), email: "rita@plumtrips.com", name: "Rita Menon", roles: ["SUPERADMIN"] };

const app = express();
app.use(express.json());
app.use("/api/admin/manual-bookings", (req: any, _res, next) => {
  req.user = { ...OPS, _id: OPS.sub };
  req.workspace = { customerId: "PLUMTRIPS-HOUSE" };
  req.workspaceObjectId = HOUSE;
  req.permissionScope = "ALL";
  next();
}, manualBookingsRouter);

let mongod: MongoMemoryServer;
const CLIENT = oid();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-bookings-payment-links-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await PaymentRequest.syncIndexes();
  rz.cancelled = [];
  rz.failCancel = false;
});

/** A booking through the real create route: an NC lead needs only the basics. */
async function makeBooking(): Promise<string> {
  const res = await request(app).post("/api/admin/manual-bookings").send({
    workspaceId: String(CLIENT),
    type: "FLIGHT",
    bookingDate: "2026-10-26",
    travelDate: "2027-01-18",
    status: "PENDING",
    subStatus: "Lead Not Contactable",
    passengers: [{ name: "Riya Sen", type: "ADULT" }],
  });
  expect(res.status).toBeLessThan(300);
  return String(res.body.booking?._id ?? res.body._id);
}

/** A request on the booking: link 1 PAID, link 2 open on Razorpay, link 3 never created. */
async function seedLinks(bookingId: string) {
  const _id = oid();
  const link = (seq: number, status: string, extra: any = {}) => ({
    _id: oid(), seq, basePaise: 10000, pgChargePaise: 0, totalPaise: 10000,
    referenceId: `PBX-${_id}-${seq}`, expireBy: new Date(Date.now() + 86400000), status, createAttempts: 1, emailOutboxIds: [], ...extra,
  });
  await PaymentRequest.create({
    _id, subject: "BOOKING", subjectId: bookingId, bookingIds: [bookingId], customerId: CLIENT, subjectRef: "MB-1",
    targetBasePaise: 30000, targetSource: { kind: "BOOKING_GRAND_TOTAL", valueAtCreation: 300 }, splitPattern: "EQUAL:3",
    pgChargePct: 0, recipient: { email: "pax@client.com" }, status: "PARTLY_PAID", isOpen: true, createdBy: "rm",
    links: [
      link(1, "PAID", { razorpayLinkId: `plink_paid_${_id}`, razorpayPaymentId: `pay_${_id}`, paidAt: new Date() }),
      link(2, "CREATED", { razorpayLinkId: `plink_open_${_id}`, shortUrl: "https://rzp.io/i/x" }),
      link(3, "FAILED_CREATE", { createError: "timeout" }),
    ],
  });
  return { requestId: String(_id), openRazorpayId: `plink_open_${_id}` };
}

const linkStatuses = async (requestId: string) => ((await PaymentRequest.findById(requestId).lean()) as any).links.map((l: any) => l.status);
const bookingStatus = async (id: string) => ((await mongoose.connection.db!.collection("manualbookings").findOne({ _id: new mongoose.Types.ObjectId(id) })) as any).status;

describe("booking cancelled → its open payment links are cancelled", () => {
  it("cancel by edit (PUT /:id): open links cancelled on Razorpay and here, the paid one reported", async () => {
    const id = await makeBooking();
    const { requestId, openRazorpayId } = await seedLinks(id);
    const res = await request(app).put(`/api/admin/manual-bookings/${id}`).send({ status: "CANCELLED", subStatus: "Lead Not Contactable" });
    expect(res.status).toBe(200);
    expect(await bookingStatus(id)).toBe("CANCELLED");
    expect(rz.cancelled).toEqual([openRazorpayId]);
    expect(await linkStatuses(requestId)).toEqual(["PAID", "CANCELLED", "CANCELLED"]);
    expect(res.body.paymentLinks.paid).toHaveLength(1);
    expect(res.body.paymentLinks.paid[0].basePaise).toBe(10000);
    expect(res.body.paymentLinks.cancelled).toHaveLength(2);
  });

  it("the cancel action (POST /:id/cancel) does the same", async () => {
    const id = await makeBooking();
    const { requestId } = await seedLinks(id);
    const res = await request(app).post(`/api/admin/manual-bookings/${id}/cancel`).send({ reason: "CUSTOMER_CANCELLED" });
    expect(res.status).toBe(200);
    expect(await linkStatuses(requestId)).toEqual(["PAID", "CANCELLED", "CANCELLED"]);
    expect(res.body.paymentLinks.paid).toHaveLength(1);
  });

  it("an edit that does not move to CANCELLED leaves the links alone", async () => {
    const id = await makeBooking();
    const { requestId } = await seedLinks(id);
    const res = await request(app).put(`/api/admin/manual-bookings/${id}`).send({ notes: "called again" });
    expect(res.status).toBe(200);
    expect(res.body.paymentLinks).toBeNull();
    expect(rz.cancelled).toEqual([]);
    expect(await linkStatuses(requestId)).toEqual(["PAID", "CREATED", "FAILED_CREATE"]);
  });

  it("a booking with no payment request makes no Razorpay call", async () => {
    const id = await makeBooking();
    const res = await request(app).post(`/api/admin/manual-bookings/${id}/cancel`).send({ reason: "DUPLICATE_ENTRY" });
    expect(res.status).toBe(200);
    expect(res.body.paymentLinks).toBeNull();
    expect(rz.cancelled).toEqual([]);
  });

  it("Razorpay failing never blocks or undoes the cancellation", async () => {
    const id = await makeBooking();
    const { requestId } = await seedLinks(id);
    rz.failCancel = true;
    const res = await request(app).post(`/api/admin/manual-bookings/${id}/cancel`).send({ reason: "CUSTOMER_CANCELLED" });
    expect(res.status).toBe(200);
    expect(await bookingStatus(id)).toBe("CANCELLED");
    expect(res.body.paymentLinks.failed.map((f: any) => f.error).join(" ")).toMatch(/Razorpay/);
    // The never-created link is written off locally; the Razorpay one stays open for a retry from the panel.
    expect(await linkStatuses(requestId)).toEqual(["PAID", "CREATED", "CANCELLED"]);
  });
});
