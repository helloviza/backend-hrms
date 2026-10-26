// POST /api/webhooks/razorpay-links, and the R1 orphan recogniser on the B2B
// endpoint (POST /api/webhooks/razorpay).
//
// Real: both routers through the real express.raw() mount, real HMAC over the
// exact bytes sent, every model, in-memory Mongo. Stubbed: the Razorpay
// Payment Links client's payment_id lookup (no network).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import crypto from "crypto";
import express from "express";
import request from "supertest";

process.env.NODE_ENV = "test";

const lookup = { byPaymentId: new Map<string, any>(), calls: 0, throws: false };
vi.mock("../services/razorpayPaymentLinks.js", async () => {
  const actual: any = await vi.importActual("../services/razorpayPaymentLinks.js");
  return {
    ...actual,
    fetchPaymentLinkByPaymentId: vi.fn(async (pid: string) => {
      lookup.calls++;
      if (lookup.throws) throw new Error("Razorpay down");
      return lookup.byPaymentId.get(pid) ?? null;
    }),
  };
});

const { default: linksRouter } = await import("./razorpay.webhook.links.js");
const { default: b2bRouter } = await import("./razorpay.webhook.js");
const { default: PaymentRequest } = await import("../models/PaymentRequest.js");
const { default: PaymentOrphan } = await import("../models/PaymentOrphan.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");

const LINKS_SECRET = "links_webhook_secret_test";
const B2B_SECRET = "b2b_webhook_secret_test";

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("payment-links-webhook-test"));
  await PaymentRequest.syncIndexes();
}, 180_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const BOOKING = new mongoose.Types.ObjectId();
beforeEach(async () => {
  process.env.RAZORPAY_LINKS_WEBHOOK_SECRET = LINKS_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = B2B_SECRET;
  process.env.RAZORPAY_KEY_ID = "rzp_test_paylinks";
  process.env.RAZORPAY_KEY_SECRET = "test_secret";
  process.env.NODE_ENV = "test";
  lookup.byPaymentId.clear();
  lookup.calls = 0;
  lookup.throws = false;
  await Promise.all([PaymentRequest.deleteMany({}), PaymentOrphan.deleteMany({}), ManualBooking.collection.deleteMany({})]);
  await ManualBooking.collection.insertOne({ _id: BOOKING, workspaceId: new mongoose.Types.ObjectId(), bookingRef: "MB-1", status: "PENDING", pricing: { grandTotal: 1000 } } as any);
});

function app(router: any) {
  const a = express();
  a.use("/", express.raw({ type: "application/json" }), router);
  return a;
}
const sign = (raw: string, secret: string) => crypto.createHmac("sha256", secret).update(Buffer.from(raw)).digest("hex");

async function postLinks(payload: unknown, opts: { secret?: string; signature?: string | null } = {}) {
  const raw = JSON.stringify(payload);
  const r = request(app(linksRouter)).post("/razorpay-links").set("Content-Type", "application/json");
  if (opts.signature !== null) r.set("x-razorpay-signature", opts.signature ?? sign(raw, opts.secret ?? LINKS_SECRET));
  return r.send(raw);
}
async function postB2B(payload: unknown) {
  const raw = JSON.stringify(payload);
  return request(app(b2bRouter)).post("/razorpay").set("Content-Type", "application/json").set("x-razorpay-signature", sign(raw, B2B_SECRET)).send(raw);
}

/** A stored request with two CREATED links (₹500 + ₹500, 2% PG → 51000 each). */
async function seedRequest() {
  const _id = new mongoose.Types.ObjectId();
  const mk = (seq: number) => ({
    _id: new mongoose.Types.ObjectId(),
    seq,
    basePaise: 50000,
    pgChargePaise: 1000,
    totalPaise: 51000,
    referenceId: `PBX-${_id}-${seq}`,
    razorpayLinkId: `plink_${seq}_${_id}`,
    shortUrl: `https://rzp.io/i/${seq}`,
    expireBy: new Date(Date.now() + 86400000),
    status: "CREATED",
    createAttempts: 1,
    emailOutboxIds: [],
  });
  const doc = await PaymentRequest.create({
    _id,
    subject: "BOOKING",
    subjectId: BOOKING,
    bookingIds: [BOOKING],
    customerId: new mongoose.Types.ObjectId(),
    subjectRef: "MB-1",
    targetBasePaise: 100000,
    targetSource: { kind: "BOOKING_GRAND_TOTAL", valueAtCreation: 1000 },
    splitPattern: "EQUAL:2",
    pgChargePct: 2,
    recipient: { email: "pax@client.com" },
    status: "OPEN",
    isOpen: true,
    links: [mk(1), mk(2)],
    createdBy: "rm",
  });
  return doc.toObject() as any;
}

const paidEvent = (link: any, over: { amount?: number; ref?: string; payAmount?: number; payId?: string } = {}) => ({
  event: "payment_link.paid",
  payload: {
    payment_link: { entity: { id: link.razorpayLinkId, amount: over.amount ?? link.totalPaise, amount_paid: link.totalPaise, reference_id: over.ref ?? link.referenceId, status: "paid", notes: { paymentRequestId: "forged" } } },
    payment: { entity: { id: over.payId ?? `pay_${link.seq}`, amount: over.payAmount ?? link.totalPaise, method: "upi", order_id: `order_${link.seq}`, status: "captured" } },
    order: { entity: { id: `order_${link.seq}`, status: "paid" } },
  },
});
const stateEvent = (event: string, link: any) => ({
  event,
  payload: { payment_link: { entity: { id: link.razorpayLinkId, amount: link.totalPaise, reference_id: link.referenceId, status: event.split(".")[1] } } },
});

const linkOf = async (id: any, seq: number) => ((await PaymentRequest.findById(id).lean()) as any).links.find((l: any) => l.seq === seq);

describe("signature", () => {
  it("accepts a valid signature over the raw bytes", async () => {
    const r = await seedRequest();
    expect((await postLinks(paidEvent(r.links[0]))).status).toBe(200);
  });
  it("rejects a missing signature, a wrong secret (incl. the B2B one) and a wrong-length forgery", async () => {
    const r = await seedRequest();
    expect((await postLinks(paidEvent(r.links[0]), { signature: null })).status).toBe(400);
    expect((await postLinks(paidEvent(r.links[0]), { secret: B2B_SECRET })).status).toBe(400);
    expect((await postLinks(paidEvent(r.links[0]), { signature: "abc" })).status).toBe(400);
    expect((await linkOf(r._id, 1)).status).toBe("CREATED");
  });
  it("fails closed without its secret outside development / test", async () => {
    delete process.env.RAZORPAY_LINKS_WEBHOOK_SECRET;
    process.env.NODE_ENV = "production";
    const r = await seedRequest();
    const res = await postLinks(paidEvent(r.links[0]), { signature: null });
    expect(res.status).toBe(500);
    expect((await linkOf(r._id, 1)).status).toBe("CREATED");
  });
});

describe("payment_link.paid", () => {
  it("marks the link PAID, request PARTLY_PAID then PAID; the booking is untouched", async () => {
    const r = await seedRequest();
    await postLinks(paidEvent(r.links[0]));
    const l1 = await linkOf(r._id, 1);
    expect(l1).toMatchObject({ status: "PAID", razorpayPaymentId: "pay_1", paidAmountPaise: 51000, method: "upi", razorpayOrderId: "order_1" });
    expect(((await PaymentRequest.findById(r._id).lean()) as any).status).toBe("PARTLY_PAID");
    await postLinks(paidEvent(r.links[1]));
    const doc: any = await PaymentRequest.findById(r._id).lean();
    expect(doc.status).toBe("PAID");
    expect(doc.isOpen).toBe(false);
    expect(((await ManualBooking.collection.findOne({ _id: BOOKING })) as any).status).toBe("PENDING");
  });

  it("a replay is a no-op", async () => {
    const r = await seedRequest();
    await postLinks(paidEvent(r.links[0]));
    const before: any = await PaymentRequest.findById(r._id).lean();
    const res = await postLinks(paidEvent(r.links[0]));
    expect(res.status).toBe(200);
    const after: any = await PaymentRequest.findById(r._id).lean();
    expect(after.history.length).toBe(before.history.length);
    expect(after.links[0].paidAt).toEqual(before.links[0].paidAt);
  });

  it("an amount or reference mismatch is NOT applied, and is recorded", async () => {
    const r = await seedRequest();
    await postLinks(paidEvent(r.links[0], { amount: 1 }));
    await postLinks(paidEvent(r.links[0], { payAmount: 50000 }));
    await postLinks(paidEvent(r.links[0], { ref: "PBX-someone-else-1" }));
    const doc: any = await PaymentRequest.findById(r._id).lean();
    expect(doc.links[0].status).toBe("CREATED");
    expect(doc.history.filter((h: any) => h.action === "RAZORPAY_MISMATCH").length).toBe(3);
  });

  it("finds the link by its Razorpay id, never by notes", async () => {
    const r = await seedRequest();
    const ev: any = paidEvent(r.links[0]);
    ev.payload.payment_link.entity.id = "plink_unknown";
    ev.payload.payment_link.entity.notes = { paymentRequestId: String(r._id), linkId: String(r.links[0]._id) };
    await postLinks(ev);
    expect((await linkOf(r._id, 1)).status).toBe("CREATED");
  });

  it("resolves a PaymentOrphan with the same payment id", async () => {
    const r = await seedRequest();
    await PaymentOrphan.create({ razorpayPaymentId: "pay_1", razorpayOrderId: "order_1", amount: 51000, webhookPayload: {} });
    await postLinks(paidEvent(r.links[0]));
    const o: any = await PaymentOrphan.findOne({ razorpayPaymentId: "pay_1" }).lean();
    expect(o.resolvedAt).toBeTruthy();
    expect(o.notes).toMatch(/payment link/);
  });

  it("partially_paid is logged and never applied", async () => {
    const r = await seedRequest();
    const ev: any = paidEvent(r.links[0]);
    ev.event = "payment_link.partially_paid";
    expect((await postLinks(ev)).status).toBe(200);
    expect((await linkOf(r._id, 1)).status).toBe("CREATED");
  });
});

describe("expired / cancelled — guarded moves", () => {
  it("CREATED → EXPIRED and CREATED → CANCELLED", async () => {
    const r = await seedRequest();
    await postLinks(stateEvent("payment_link.expired", r.links[0]));
    await postLinks(stateEvent("payment_link.cancelled", r.links[1]));
    expect((await linkOf(r._id, 1)).status).toBe("EXPIRED");
    expect((await linkOf(r._id, 2)).status).toBe("CANCELLED");
    expect(((await PaymentRequest.findById(r._id).lean()) as any).status).toBe("CANCELLED");
  });

  it("never demotes PAID, never revives a dead link", async () => {
    const r = await seedRequest();
    await postLinks(paidEvent(r.links[0]));
    await postLinks(stateEvent("payment_link.expired", r.links[0]));
    await postLinks(stateEvent("payment_link.cancelled", r.links[0]));
    expect((await linkOf(r._id, 1)).status).toBe("PAID");

    await postLinks(stateEvent("payment_link.expired", r.links[1]));
    await postLinks(paidEvent(r.links[1]));
    expect((await linkOf(r._id, 2)).status).toBe("EXPIRED");
    const doc: any = await PaymentRequest.findById(r._id).lean();
    expect(doc.history.some((h: any) => h.action === "RAZORPAY_STATE_IGNORED")).toBe(true);
  });
});

describe("R1 — the B2B endpoint does not orphan Plumbox payment links", () => {
  const captured = (id: string, orderId: string, amount = 51000) => ({
    event: "payment.captured",
    payload: { payment: { entity: { id, order_id: orderId, amount, currency: "INR", status: "captured" } } },
  });

  it("a payment on our link (order id already stored) → no orphan, no Razorpay lookup", async () => {
    const r = await seedRequest();
    await postLinks(paidEvent(r.links[0])); // stores order_1
    const res = await postB2B(captured("pay_1", "order_1"));
    expect(res.status).toBe(200);
    expect(await PaymentOrphan.countDocuments()).toBe(0);
    expect(lookup.calls).toBe(0);
  });

  it("captured before payment_link.paid: one payment_id lookup recognises our link → no orphan", async () => {
    const r = await seedRequest();
    lookup.byPaymentId.set("pay_early", { id: r.links[0].razorpayLinkId, reference_id: r.links[0].referenceId, notes: {} });
    await postB2B(captured("pay_early", "order_early"));
    expect(await PaymentOrphan.countDocuments()).toBe(0);
    expect(lookup.calls).toBe(1);
    expect((await linkOf(r._id, 1)).razorpayOrderId).toBe("order_early");
  });

  it("a link made by hand on the Razorpay dashboard still orphans exactly as before", async () => {
    lookup.byPaymentId.set("pay_manual", { id: "plink_dash", reference_id: "INV-123", notes: { anything: "x" } });
    await postB2B(captured("pay_manual", "order_manual", 99900));
    const o: any = await PaymentOrphan.findOne({ razorpayPaymentId: "pay_manual" }).lean();
    expect(o).toMatchObject({ razorpayOrderId: "order_manual", amount: 99900 });
  });

  it("a plain unmatched payment still orphans; a lookup error falls back to orphaning", async () => {
    await postB2B(captured("pay_plain", "order_plain"));
    lookup.throws = true;
    await postB2B(captured("pay_err", "order_err"));
    expect(await PaymentOrphan.countDocuments({ razorpayPaymentId: { $in: ["pay_plain", "pay_err"] } })).toBe(2);
  });
});
