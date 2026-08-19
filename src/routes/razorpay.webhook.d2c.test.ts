// THE D2C PAYMENT WEBHOOK — signature, resolution, idempotency, and the
// B2B path it must not disturb.
//
// ══════════════════════════════════════════════════════════════════════
// EVERY SIGNATURE IN THIS FILE IS A REAL HMAC-SHA256.
// ══════════════════════════════════════════════════════════════════════
// Nothing here stubs verification, and nothing "trusts" a header. Each
// request body is signed with node's own crypto using the same algorithm
// Razorpay signs with, and posted through the REAL express.raw() mount —
// so the bytes the handler hashes are the bytes that went over the wire.
// That matters more than it looks: signature verification over a raw body
// is exactly the thing a JSON-parsing test harness silently breaks, by
// re-serialising the object and hashing a string the sender never sent.
// The forged-signature test below is what proves the check is live rather
// than decorative.
//
// Real models on mongodb-memory-server, because two of the properties
// under test are DATABASE properties and an in-memory stub cannot show
// either one: the unique partial index on razorpayPaymentId (idempotency
// layer 2), and the fact that a B2B order id still resolves through two
// real collection lookups before the D2C one is ever reached.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import crypto from "crypto";
import express from "express";
import request from "supertest";

import router from "./razorpay.webhook.js";
import VisaApplication from "../models/VisaApplication.js";
import VisaD2CLead from "../models/VisaD2CLead.js";
import VisaActivityLog from "../models/VisaActivityLog.js";
import SBTBooking from "../models/SBTBooking.js";
import PaymentOrphan from "../models/PaymentOrphan.js";

const WEBHOOK_SECRET = "test_webhook_secret_for_signing";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  /* Build indexes explicitly. Mongoose's autoIndex is fire-and-forget, so
   * without this the unique-index test would race the index that makes it
   * meaningful — and would pass for the wrong reason if the index lost. */
  await VisaApplication.syncIndexes();
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  await Promise.all([
    VisaApplication.deleteMany({}),
    VisaD2CLead.deleteMany({}),
    VisaActivityLog.deleteMany({}),
    SBTBooking.deleteMany({}),
    PaymentOrphan.deleteMany({}),
  ]);
});

/* The REAL mount: express.raw() before the router, exactly as server.ts
 * wires it (`app.use("/api/webhooks", express.raw(...), razorpayWebhookRouter)`).
 * No express.json() anywhere — the handler must receive a Buffer. */
function makeApp() {
  const app = express();
  app.use("/", express.raw({ type: "application/json" }), router);
  return app;
}

/** A genuine Razorpay-format signature over the exact bytes being sent. */
function sign(rawBody: string, secret = WEBHOOK_SECRET): string {
  return crypto.createHmac("sha256", secret).update(Buffer.from(rawBody)).digest("hex");
}

/** POST a payload, signing the serialised bytes and sending THOSE bytes. */
async function postWebhook(payload: unknown, opts: { signature?: string } = {}) {
  const raw = JSON.stringify(payload);
  return request(makeApp())
    .post("/razorpay")
    .set("Content-Type", "application/json")
    // The STRING, not a Buffer: superagent re-serialises a Buffer body and
    // the bytes on the wire would stop matching the bytes we signed.
    .set("x-razorpay-signature", opts.signature ?? sign(raw))
    .send(raw);
}

function capturedEvent(opts: { orderId: string; paymentId: string; amountPaise: number }) {
  return {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: opts.paymentId,
          order_id: opts.orderId,
          amount: opts.amountPaise,
          currency: "INR",
          status: "captured",
        },
      },
    },
  };
}

function failedEvent(opts: { orderId: string; paymentId: string; amountPaise: number }) {
  return {
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: opts.paymentId,
          order_id: opts.orderId,
          amount: opts.amountPaise,
          currency: "INR",
          status: "failed",
          error_description: "Your card was declined by the issuing bank.",
        },
      },
    },
  };
}

const RULE_SNAPSHOT = {
  ruleId: new mongoose.Types.ObjectId(),
  capturedAt: new Date(),
  destinationName: "Thailand",
  isSchengen: false,
  productClass: "VISA",
  visaCategory: "E_VISA",
  purpose: "TOURIST",
  entryType: "SINGLE",
  serviceTier: "STANDARD",
  appointmentRequired: false,
  biometricsRequired: false,
  documentRequirements: [],
};

const D2C_WORKSPACE_ID = new mongoose.Types.ObjectId("d2c00000000000000000d2c1");

/** A submitted, unpaid D2C application priced at ₹1,770, with its order minted. */
async function seedD2CCase(opts: { orderId: string; totalInr?: number } ) {
  const consumerId = new mongoose.Types.ObjectId();
  const requestId = new mongoose.Types.ObjectId();
  const application = await VisaApplication.create({
    workspaceId: D2C_WORKSPACE_ID,
    requestId,
    consumerId,
    source: "D2C",
    travellerProfileId: null,
    destinationIso2: "TH",
    ruleSnapshot: RULE_SNAPSHOT,
    indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: opts.totalInr ?? 1770 },
    status: "submitted",
    razorpayOrderId: opts.orderId,
  });

  const lead = await VisaD2CLead.create({
    consumerId,
    workspaceId: D2C_WORKSPACE_ID,
    destinationIso2: "TH",
    destinationName: "Thailand",
    purpose: "TOURIST",
    applicationId: application._id,
    referenceNumber: "HV-TEST-001",
    submittedAt: new Date(),
  });

  return { application, lead, consumerId, requestId };
}

/** A B2B flight booking awaiting capture — the path that must not change. */
async function seedB2BFlight(orderId: string) {
  return SBTBooking.create({
    userId: new mongoose.Types.ObjectId(),
    workspaceId: new mongoose.Types.ObjectId(),
    status: "PENDING",
    razorpayOrderId: orderId,
    origin: { code: "BOM", city: "Mumbai" },
    destination: { code: "DXB", city: "Dubai" },
    departureTime: "2026-09-01T04:30:00",
    arrivalTime: "2026-09-01T06:10:00",
    airlineCode: "EK",
    airlineName: "Emirates",
    flightNumber: "501",
    baseFare: 18000,
    totalFare: 21500,
  });
}

describe("razorpay webhook — D2C branch", () => {
  it("(a) a genuinely signed payment.captured moves the ticket to Visa Fees Paid, mirrors the lead, logs once", async () => {
    const { application, lead } = await seedD2CCase({ orderId: "order_D2C_AAA" });

    const res = await postWebhook(
      capturedEvent({ orderId: "order_D2C_AAA", paymentId: "pay_D2C_AAA", amountPaise: 177000 }),
    );
    expect(res.status).toBe(200);

    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).toBe("PAID");
    expect(after.d2cStage).toBe("PAYMENT_DONE");
    expect(after.d2cStatus).toBe("VISA_FEES_PAID");
    expect(after.razorpayPaymentId).toBe("pay_D2C_AAA");

    // The ops pipeline status is NOT rewritten by a payment.
    expect(after.status).toBe("submitted");

    const leadAfter: any = await VisaD2CLead.findById(lead._id).lean();
    expect(leadAfter.paymentStatus).toBe("PAID");
    expect(leadAfter.stage).toBe("PAYMENT_DONE");
    expect(leadAfter.status).toBe("VISA_FEES_PAID");

    const rows = await VisaActivityLog.find({ applicationId: application._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("PAYMENT_DONE");
    expect(rows[0].actorType).toBe("SYSTEM");
    expect(rows[0].source).toBe("D2C");
    expect(rows[0].detail).toMatchObject({
      channel: "D2C",
      razorpayPaymentId: "pay_D2C_AAA",
      amountInr: 1770,
    });
  });

  it("(b) the SAME signed webhook fired twice is a clean no-op — one move, one log row", async () => {
    const { application } = await seedD2CCase({ orderId: "order_D2C_BBB" });
    const event = capturedEvent({
      orderId: "order_D2C_BBB",
      paymentId: "pay_D2C_BBB",
      amountPaise: 177000,
    });

    const first = await postWebhook(event);
    const firstDoc: any = await VisaApplication.findById(application._id).lean();

    // Byte-for-byte the same delivery, signature and all.
    const second = await postWebhook(event);
    const secondDoc: any = await VisaApplication.findById(application._id).lean();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // The replay changed NOTHING — not even the updatedAt stamp, which is
    // what a second save() would have moved.
    expect(secondDoc.d2cPaymentStatus).toBe("PAID");
    expect(String(secondDoc.updatedAt)).toBe(String(firstDoc.updatedAt));

    const rows = await VisaActivityLog.find({ applicationId: application._id }).lean();
    expect(rows).toHaveLength(1);
  });

  it("(b2) idempotency layer 2 — the unique index refuses a second application claiming the same payment id", async () => {
    // The in-process guard cannot see across documents; this is what stops
    // one captured payment being applied to two cases at once.
    const { application } = await seedD2CCase({ orderId: "order_D2C_CCC" });
    await postWebhook(
      capturedEvent({ orderId: "order_D2C_CCC", paymentId: "pay_SHARED", amountPaise: 177000 }),
    );
    expect((await VisaApplication.findById(application._id).lean())!.razorpayPaymentId).toBe("pay_SHARED");

    const other = await seedD2CCase({ orderId: "order_D2C_DDD" });
    other.application.razorpayPaymentId = "pay_SHARED";

    await expect(other.application.save()).rejects.toMatchObject({ code: 11000 });
  });

  it("(b3) the partial filter lets many unpaid applications coexist — null is not a unique value here", async () => {
    // The trap the partial index exists to avoid: under a plain `sparse`
    // unique index, `default: null` means every row carries the key and the
    // SECOND application ever created would collide.
    await seedD2CCase({ orderId: "order_D2C_E1" });
    await seedD2CCase({ orderId: "order_D2C_E2" });
    await seedD2CCase({ orderId: "order_D2C_E3" });

    expect(await VisaApplication.countDocuments({ razorpayPaymentId: null })).toBe(3);
  });

  it("(c) a FORGED signature is rejected and nothing moves", async () => {
    const { application } = await seedD2CCase({ orderId: "order_D2C_FFF" });

    const res = await postWebhook(
      capturedEvent({ orderId: "order_D2C_FFF", paymentId: "pay_FORGED", amountPaise: 177000 }),
      { signature: "f".repeat(64) },
    );

    expect(res.status).toBe(400);
    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).toBe("PENDING");
    expect(after.razorpayPaymentId).toBeNull();
    expect(await VisaActivityLog.countDocuments({})).toBe(0);
  });

  it("(c2) a signature made with the WRONG secret is rejected — the secret is what's checked, not the shape", async () => {
    const { application } = await seedD2CCase({ orderId: "order_D2C_GGG" });
    const event = capturedEvent({ orderId: "order_D2C_GGG", paymentId: "pay_WRONGSECRET", amountPaise: 177000 });
    const raw = JSON.stringify(event);

    const res = await postWebhook(event, { signature: sign(raw, "not_the_real_secret") });

    expect(res.status).toBe(400);
    expect((await VisaApplication.findById(application._id).lean())!.d2cPaymentStatus).toBe("PENDING");
  });

  it("(c3) a TAMPERED body is rejected — the signature covers the payload, not just the headers", async () => {
    // Sign one amount, send another. This is the attack the raw-body hash
    // exists to stop, and it only fails if the bytes are really hashed.
    const honest = capturedEvent({ orderId: "order_D2C_HHH", paymentId: "pay_TAMPER", amountPaise: 177000 });
    const { application } = await seedD2CCase({ orderId: "order_D2C_HHH" });
    const tampered = capturedEvent({ orderId: "order_D2C_HHH", paymentId: "pay_TAMPER", amountPaise: 100 });

    const res = await postWebhook(tampered, { signature: sign(JSON.stringify(honest)) });

    expect(res.status).toBe(400);
    expect((await VisaApplication.findById(application._id).lean())!.d2cPaymentStatus).toBe("PENDING");
  });

  it("(d) payment.failed marks PAYMENT_FAILED and mirrors — a chase-able lead, never DROPPED", async () => {
    const { application, lead } = await seedD2CCase({ orderId: "order_D2C_III" });

    const res = await postWebhook(
      failedEvent({ orderId: "order_D2C_III", paymentId: "pay_FAILED", amountPaise: 177000 }),
    );
    expect(res.status).toBe(200);

    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cStage).toBe("PAYMENT_FAILED");
    expect(after.d2cPaymentStatus).toBe("FAILED");
    // Still in progress — the point of recording a failure rather than a drop.
    expect(after.d2cStatus).toBe("IN_PROGRESS");
    // A failed attempt took no money and must not consume the payment id slot.
    expect(after.razorpayPaymentId).toBeNull();

    const leadAfter: any = await VisaD2CLead.findById(lead._id).lean();
    expect(leadAfter.stage).toBe("PAYMENT_FAILED");
    expect(leadAfter.paymentStatus).toBe("FAILED");

    const rows = await VisaActivityLog.find({ applicationId: application._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("PAYMENT_FAILED");
    expect(rows[0].detail).toMatchObject({ reason: "Your card was declined by the issuing bank." });
  });

  it("(d2) a late payment.failed cannot un-pay a captured case", async () => {
    const { application } = await seedD2CCase({ orderId: "order_D2C_JJJ" });
    await postWebhook(capturedEvent({ orderId: "order_D2C_JJJ", paymentId: "pay_OK", amountPaise: 177000 }));

    const res = await postWebhook(
      failedEvent({ orderId: "order_D2C_JJJ", paymentId: "pay_LATE_FAIL", amountPaise: 177000 }),
    );

    expect(res.status).toBe(200);
    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).toBe("PAID");
    expect(after.d2cStage).toBe("PAYMENT_DONE");
  });

  it("an amount mismatch does NOT mark the case paid — it flags it for ops", async () => {
    const { application, lead } = await seedD2CCase({ orderId: "order_D2C_KKK", totalInr: 1770 });

    // ₹1 captured against a ₹1,770 case.
    const res = await postWebhook(
      capturedEvent({ orderId: "order_D2C_KKK", paymentId: "pay_SHORT", amountPaise: 100 }),
    );
    expect(res.status).toBe(200);

    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).toBe("PENDING");
    expect(after.d2cStatus).not.toBe("VISA_FEES_PAID");
    expect(after.razorpayPaymentId).toBeNull();

    // Flagged where a concierge will actually see it.
    expect(after.status).toBe("discrepancy_flagged");
    expect(after.discrepancyReason).toContain("100");
    expect(after.discrepancyReason).toContain("177000");
    // The displaced status is captured so the flag can be cleared cleanly.
    expect(after.statusBeforeActionRequired).toBe("submitted");

    // The Master Sheet must not claim money we did not reconcile.
    const leadAfter: any = await VisaD2CLead.findById(lead._id).lean();
    expect(leadAfter.paymentStatus).toBe("PENDING");

    const rows = await VisaActivityLog.find({ applicationId: application._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("PAYMENT_AMOUNT_MISMATCH");
    expect(rows[0].detail).toMatchObject({ capturedAmountInr: 1, expectedAmountInr: 1770 });
  });

  it("an overpayment is treated exactly like a shortfall — any mismatch stops", async () => {
    const { application } = await seedD2CCase({ orderId: "order_D2C_LLL", totalInr: 1770 });

    await postWebhook(capturedEvent({ orderId: "order_D2C_LLL", paymentId: "pay_OVER", amountPaise: 500000 }));

    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).toBe("PENDING");
    expect(after.status).toBe("discrepancy_flagged");
  });
});

describe("razorpay webhook — the B2B path is unchanged", () => {
  it("(e) a B2B order id still resolves to its SBT booking and confirms it", async () => {
    const booking = await seedB2BFlight("order_B2B_FLIGHT_1");

    const res = await postWebhook(
      capturedEvent({ orderId: "order_B2B_FLIGHT_1", paymentId: "pay_B2B_1", amountPaise: 2150000 }),
    );

    expect(res.status).toBe(200);
    const after: any = await SBTBooking.findById(booking._id).lean();
    expect(after.status).toBe("CONFIRMED");
    expect(after.webhookProcessed).toBe(true);
    expect(after.paymentCapturedAt).toBeTruthy();

    // The B2B path writes no visa state and no activity rows.
    expect(await VisaActivityLog.countDocuments({})).toBe(0);
    expect(await PaymentOrphan.countDocuments({})).toBe(0);
  });

  it("a B2B payment.failed still marks the SBT booking FAILED", async () => {
    const booking = await seedB2BFlight("order_B2B_FLIGHT_2");

    await postWebhook(failedEvent({ orderId: "order_B2B_FLIGHT_2", paymentId: "pay_B2B_2", amountPaise: 2150000 }));

    const after: any = await SBTBooking.findById(booking._id).lean();
    expect(after.status).toBe("FAILED");
    expect(after.failureReason).toBe("Your card was declined by the issuing bank.");
  });

  it("an SBT booking is matched even when a visa application exists — SBT is still looked up FIRST", async () => {
    // Same order id on both collections: physically impossible in
    // production, and constructed here precisely to pin the resolution
    // ORDER, which is the whole B2B-safety argument.
    const booking = await seedB2BFlight("order_COLLIDE");
    const { application } = await seedD2CCase({ orderId: "order_COLLIDE" });

    await postWebhook(capturedEvent({ orderId: "order_COLLIDE", paymentId: "pay_COLLIDE", amountPaise: 177000 }));

    expect((await SBTBooking.findById(booking._id).lean())!.status).toBe("CONFIRMED");
    // The visa application was never reached.
    expect((await VisaApplication.findById(application._id).lean())!.d2cPaymentStatus).toBe("PENDING");
  });

  it("(f) the orphan net was NOT narrowed — an order matching neither still becomes a PaymentOrphan", async () => {
    const res = await postWebhook(
      capturedEvent({ orderId: "order_NOBODY_KNOWS", paymentId: "pay_ORPHAN", amountPaise: 999900 }),
    );

    expect(res.status).toBe(200);
    const orphan: any = await PaymentOrphan.findOne({ razorpayPaymentId: "pay_ORPHAN" }).lean();
    expect(orphan).toBeTruthy();
    expect(orphan.razorpayOrderId).toBe("order_NOBODY_KNOWS");
    expect(orphan.amount).toBe(999900);
  });

  it("a D2C refund is refused loudly rather than half-written onto the application", async () => {
    const { application } = await seedD2CCase({ orderId: "order_D2C_REFUND" });
    await postWebhook(capturedEvent({ orderId: "order_D2C_REFUND", paymentId: "pay_REF", amountPaise: 177000 }));

    const res = await postWebhook({
      event: "refund.processed",
      payload: { refund: { entity: { id: "rfnd_1", order_id: "order_D2C_REFUND" } } },
    });

    expect(res.status).toBe(200);
    const after: any = await VisaApplication.findById(application._id).lean();
    // Still paid, and carrying no invented refund state.
    expect(after.d2cPaymentStatus).toBe("PAID");
    expect(after.refundId).toBeUndefined();
    expect(after.refundStatus).toBeUndefined();
  });
});
