// THE D2C MID'S OWN WEBHOOK ENDPOINT — POST /api/webhooks/razorpay-d2c.
//
// ══════════════════════════════════════════════════════════════════════
// WHAT THIS FILE PROVES THAT razorpay.webhook.d2c.test.ts DOES NOT.
// ══════════════════════════════════════════════════════════════════════
// That file tests the D2C branch of the SHARED endpoint, verified with the
// B2B secret. It stays exactly as it is: after the MID split it is the
// proof that the drain path still works — every D2C order minted before
// the cutover lives on the old account and its webhook still arrives at
// the old URL.
//
// This file tests the NEW endpoint, and the three things that are true of
// it and of nothing else:
//
//   1. It verifies against RAZORPAY_D2C_WEBHOOK_SECRET. A signature made
//      with the B2B secret — a perfectly valid signature, from a real
//      Razorpay account — is REJECTED here. That rejection IS the split.
//
//   2. It resolves through VisaApplication and nothing else. A B2B order
//      id finds no application, so it becomes an orphan and the SBT
//      booking is not touched. No SBT lookup happens because none can:
//      the D2C MID cannot mint a B2B order id.
//
//   3. It fails closed on its OWN secret, independently of the B2B one.
//
// Every signature below is a real HMAC-SHA256 over the exact bytes sent,
// through the real express.raw() mount. Nothing is stubbed.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import crypto from "crypto";
import express from "express";
import request from "supertest";

import d2cRouter from "./razorpay.webhook.d2c.js";
import b2bRouter from "./razorpay.webhook.js";
import VisaApplication from "../models/VisaApplication.js";
import VisaD2CLead from "../models/VisaD2CLead.js";
import VisaActivityLog from "../models/VisaActivityLog.js";
import SBTBooking from "../models/SBTBooking.js";
import PaymentOrphan from "../models/PaymentOrphan.js";

/** The D2C MID's webhook secret. */
const D2C_SECRET = "d2c_webhook_secret_helloviza_mid";
/** The B2B MID's — a REAL secret, for a REAL account, that must not work here. */
const B2B_SECRET = "b2b_webhook_secret_plumtrips_mid";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await VisaApplication.syncIndexes();
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  process.env.RAZORPAY_D2C_WEBHOOK_SECRET = D2C_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = B2B_SECRET;
  await Promise.all([
    VisaApplication.deleteMany({}),
    VisaD2CLead.deleteMany({}),
    VisaActivityLog.deleteMany({}),
    SBTBooking.deleteMany({}),
    PaymentOrphan.deleteMany({}),
  ]);
});

/* The REAL mount, exactly as server.ts wires it:
 * app.use("/api/webhooks", express.raw(...), razorpayWebhookD2cRouter).
 * No express.json() anywhere — the handler must receive a Buffer, because
 * the HMAC covers the bytes on the wire and a re-serialised object is not
 * those bytes. */
function makeApp() {
  const app = express();
  app.use("/", express.raw({ type: "application/json" }), d2cRouter);
  return app;
}

function sign(rawBody: string, secret = D2C_SECRET): string {
  return crypto.createHmac("sha256", secret).update(Buffer.from(rawBody)).digest("hex");
}

async function postWebhook(payload: unknown, opts: { signature?: string; secret?: string } = {}) {
  const raw = JSON.stringify(payload);
  const req = request(makeApp())
    .post("/razorpay-d2c")
    .set("Content-Type", "application/json");
  const signature = opts.signature ?? sign(raw, opts.secret ?? D2C_SECRET);
  if (signature !== "") req.set("x-razorpay-signature", signature);
  // The STRING, not a Buffer: superagent re-serialises a Buffer body and
  // the bytes on the wire would stop matching the bytes we signed.
  return req.send(raw);
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
async function seedD2CCase(opts: { orderId: string; totalInr?: number }) {
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
    referenceNumber: "HV-TEST-D2C-EP",
    submittedAt: new Date(),
  });

  return { application, lead, consumerId, requestId };
}

/** A B2B flight booking awaiting capture — the thing this endpoint must never touch. */
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

describe("D2C endpoint — a genuine D2C payment", () => {
  it("a payment signed with the D2C secret resolves the application and marks it Visa Fees Paid", async () => {
    const { application, lead } = await seedD2CCase({ orderId: "order_d2c_ep_001" });

    const res = await postWebhook(
      capturedEvent({ orderId: "order_d2c_ep_001", paymentId: "pay_d2c_ep_001", amountPaise: 177000 }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).toBe("PAID");
    expect(after.d2cStage).toBe("PAYMENT_DONE");
    expect(after.d2cStatus).toBe("VISA_FEES_PAID");
    expect(after.razorpayPaymentId).toBe("pay_d2c_ep_001");

    // The imported handler is the SAME one the shared endpoint calls, so
    // the mirror and the activity log come along with it rather than being
    // reimplemented here.
    const leadAfter: any = await VisaD2CLead.findById(lead._id).lean();
    expect(leadAfter.paymentStatus).toBe("PAID");
    expect(leadAfter.stage).toBe("PAYMENT_DONE");

    const logs = await VisaActivityLog.find({ applicationId: application._id, eventType: "PAYMENT_DONE" });
    expect(logs).toHaveLength(1);
  });

  it("a redelivery of the same payment is a clean no-op — idempotency travels with the handler", async () => {
    const { application } = await seedD2CCase({ orderId: "order_d2c_ep_002" });
    const event = capturedEvent({
      orderId: "order_d2c_ep_002",
      paymentId: "pay_d2c_ep_002",
      amountPaise: 177000,
    });

    expect((await postWebhook(event)).status).toBe(200);
    expect((await postWebhook(event)).status).toBe(200);

    const logs = await VisaActivityLog.find({ applicationId: application._id, eventType: "PAYMENT_DONE" });
    expect(logs).toHaveLength(1);
  });

  it("payment.failed marks the case PAYMENT_FAILED and mirrors it", async () => {
    const { application, lead } = await seedD2CCase({ orderId: "order_d2c_ep_003" });

    const res = await postWebhook(
      failedEvent({ orderId: "order_d2c_ep_003", paymentId: "pay_d2c_ep_003", amountPaise: 177000 }),
    );

    expect(res.status).toBe(200);
    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).toBe("FAILED");
    expect(after.d2cStage).toBe("PAYMENT_FAILED");

    const leadAfter: any = await VisaD2CLead.findById(lead._id).lean();
    expect(leadAfter.paymentStatus).toBe("FAILED");
  });

  it("an amount mismatch still stops — the cross-check is in the handler, not the endpoint", async () => {
    const { application } = await seedD2CCase({ orderId: "order_d2c_ep_004", totalInr: 1770 });

    // ₹1,750 captured against a ₹1,770 case.
    const res = await postWebhook(
      capturedEvent({ orderId: "order_d2c_ep_004", paymentId: "pay_d2c_ep_004", amountPaise: 175000 }),
    );

    expect(res.status).toBe(200);
    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).not.toBe("PAID");
    expect(after.razorpayPaymentId).toBeFalsy();
  });
});

describe("D2C endpoint — the secret is the boundary between the two MIDs", () => {
  it("a signature made with the B2B secret is REJECTED — this rejection IS the split", async () => {
    const { application } = await seedD2CCase({ orderId: "order_d2c_ep_010" });

    // A genuine, well-formed HMAC. It is simply not this account's.
    const res = await postWebhook(
      capturedEvent({ orderId: "order_d2c_ep_010", paymentId: "pay_d2c_ep_010", amountPaise: 177000 }),
      { secret: B2B_SECRET },
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid signature" });

    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).not.toBe("PAID");
    expect(await VisaActivityLog.countDocuments({ applicationId: application._id })).toBe(0);
  });

  it("a forged signature is rejected and nothing moves", async () => {
    const { application } = await seedD2CCase({ orderId: "order_d2c_ep_011" });

    const res = await postWebhook(
      capturedEvent({ orderId: "order_d2c_ep_011", paymentId: "pay_d2c_ep_011", amountPaise: 177000 }),
      { signature: "f".repeat(64) },
    );

    expect(res.status).toBe(400);
    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).not.toBe("PAID");
  });

  it("a signature of the WRONG LENGTH is a plain 400, not a 500 — timingSafeEqual would throw", async () => {
    const res = await postWebhook(
      capturedEvent({ orderId: "order_d2c_ep_012", paymentId: "pay_d2c_ep_012", amountPaise: 177000 }),
      { signature: "abc" },
    );
    expect(res.status).toBe(400);
  });

  it("a TAMPERED body is rejected — the signature covers the payload", async () => {
    const { application } = await seedD2CCase({ orderId: "order_d2c_ep_013" });

    const honest = JSON.stringify(
      capturedEvent({ orderId: "order_d2c_ep_013", paymentId: "pay_d2c_ep_013", amountPaise: 177000 }),
    );
    const tampered = honest.replace("177000", "100");

    const res = await request(makeApp())
      .post("/razorpay-d2c")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", sign(honest))
      .send(tampered);

    expect(res.status).toBe(400);
    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).not.toBe("PAID");
  });

  it("no signature header at all is a 400", async () => {
    const res = await postWebhook(
      capturedEvent({ orderId: "order_d2c_ep_014", paymentId: "pay_d2c_ep_014", amountPaise: 177000 }),
      { signature: "" },
    );
    expect(res.status).toBe(400);
  });
});

describe("D2C endpoint — fail closed on its OWN secret", () => {
  const realNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = realNodeEnv;
    process.env.RAZORPAY_D2C_WEBHOOK_SECRET = D2C_SECRET;
  });

  it("refuses to process anything when RAZORPAY_D2C_WEBHOOK_SECRET is unset outside local dev", async () => {
    delete process.env.RAZORPAY_D2C_WEBHOOK_SECRET;
    process.env.NODE_ENV = "production";

    const { application } = await seedD2CCase({ orderId: "order_d2c_ep_020" });
    const res = await postWebhook(
      capturedEvent({ orderId: "order_d2c_ep_020", paymentId: "pay_d2c_ep_020", amountPaise: 177000 }),
    );

    expect(res.status).toBe(500);
    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).not.toBe("PAID");
  });

  it("does NOT fall back to the B2B secret when its own is unset", async () => {
    // The B2B secret is still set in the environment throughout. If this
    // endpoint ever consulted it, the request below would be accepted and
    // the case would be marked paid — which would be the split undone.
    delete process.env.RAZORPAY_D2C_WEBHOOK_SECRET;
    process.env.NODE_ENV = "production";

    const { application } = await seedD2CCase({ orderId: "order_d2c_ep_021" });
    const res = await postWebhook(
      capturedEvent({ orderId: "order_d2c_ep_021", paymentId: "pay_d2c_ep_021", amountPaise: 177000 }),
      { secret: B2B_SECRET },
    );

    expect(res.status).toBe(500);
    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).not.toBe("PAID");
  });
});

describe("D2C endpoint — it does not know what an SBT booking is", () => {
  it("a B2B order id resolves to nothing here and the SBT booking is left untouched", async () => {
    const booking = await seedB2BFlight("order_b2b_ep_030");

    const res = await postWebhook(
      capturedEvent({ orderId: "order_b2b_ep_030", paymentId: "pay_b2b_ep_030", amountPaise: 2150000 }),
    );

    // Acknowledged (never make Razorpay retry), but nothing was resolved.
    expect(res.status).toBe(200);

    const after: any = await SBTBooking.findById(booking._id).lean();
    expect(after.status).toBe("PENDING");
    expect(after.paymentCapturedAt).toBeFalsy();
    expect(after.webhookProcessed).toBeFalsy();

    // It lands in the orphan net instead — the correct answer for a payment
    // on the D2C MID that matches no D2C application.
    const orphan: any = await PaymentOrphan.findOne({ razorpayPaymentId: "pay_b2b_ep_030" }).lean();
    expect(orphan).toBeTruthy();
    expect(orphan.razorpayOrderId).toBe("order_b2b_ep_030");
  });

  it("a D2C application is found even when an SBT booking holds the same order id", async () => {
    // Cannot happen across two MIDs — which is the point. If it somehow
    // did, this endpoint answers with the D2C application, because the SBT
    // collections are not in its resolution path at all. The shared
    // endpoint answers the opposite way for the same input (SBT first), and
    // that asymmetry is intentional and is why they are two endpoints.
    const orderId = "order_collision_ep_031";
    const booking = await seedB2BFlight(orderId);
    const { application } = await seedD2CCase({ orderId });

    const res = await postWebhook(
      capturedEvent({ orderId, paymentId: "pay_collision_ep_031", amountPaise: 177000 }),
    );

    expect(res.status).toBe(200);
    const app: any = await VisaApplication.findById(application._id).lean();
    expect(app.d2cPaymentStatus).toBe("PAID");

    const sbt: any = await SBTBooking.findById(booking._id).lean();
    expect(sbt.status).toBe("PENDING");
  });

  it("an unmatched order becomes a PaymentOrphan, exactly as on the shared endpoint", async () => {
    const res = await postWebhook(
      capturedEvent({ orderId: "order_nobody_ep_032", paymentId: "pay_nobody_ep_032", amountPaise: 500000 }),
    );

    expect(res.status).toBe(200);
    const orphan: any = await PaymentOrphan.findOne({ razorpayPaymentId: "pay_nobody_ep_032" }).lean();
    expect(orphan).toBeTruthy();
    expect(orphan.amount).toBe(500000);
  });

  it("a D2C refund is refused loudly rather than half-written onto the application", async () => {
    const { application } = await seedD2CCase({ orderId: "order_d2c_ep_033" });
    const raw = JSON.stringify({
      event: "refund.processed",
      payload: { refund: { entity: { id: "rfnd_ep_033", order_id: "order_d2c_ep_033", amount: 177000 } } },
    });

    const res = await request(makeApp())
      .post("/razorpay-d2c")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", sign(raw))
      .send(raw);

    expect(res.status).toBe(200);
    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.refundId).toBeUndefined();
    expect(after.refundStatus).toBeUndefined();
  });

  it("an unrecognised event is acknowledged, never retried into a storm", async () => {
    const raw = JSON.stringify({ event: "payment.authorized", payload: {} });
    const res = await request(makeApp())
      .post("/razorpay-d2c")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", sign(raw))
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * BOTH ENDPOINTS, MOUNTED THE WAY server.ts MOUNTS THEM.
 *
 * The two routers share the /api/webhooks prefix and each gets its own
 * express.raw(). That is the shape in production, and it has one property
 * worth proving rather than assuming: the SECOND express.raw() must not
 * disturb a body the first one already read. body-parser marks a parsed
 * request and skips re-reading it, so the buffer survives — but "so I am
 * told" is not the standard for the bytes an HMAC is computed over, and a
 * regression here would show up only as Razorpay reporting failed
 * deliveries.
 *
 * The other half is routing: each URL must reach its own verifier, and a
 * valid signature from the wrong account must be rejected at whichever
 * endpoint it arrives.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("both webhooks mounted together, as server.ts wires them", () => {
  function makeServerShapedApp() {
    const app = express();
    // Verbatim shape of server.ts: same prefix, one raw() per router,
    // B2B first — and, as there, no express.json() anywhere near them.
    app.use("/api/webhooks", express.raw({ type: "application/json" }), b2bRouter);
    app.use("/api/webhooks", express.raw({ type: "application/json" }), d2cRouter);
    return app;
  }

  it("routes /razorpay-d2c to the D2C verifier — the second raw() leaves the body intact", async () => {
    const { application } = await seedD2CCase({ orderId: "order_mount_040" });
    const raw = JSON.stringify(
      capturedEvent({ orderId: "order_mount_040", paymentId: "pay_mount_040", amountPaise: 177000 }),
    );

    const res = await request(makeServerShapedApp())
      .post("/api/webhooks/razorpay-d2c")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", sign(raw, D2C_SECRET))
      .send(raw);

    expect(res.status).toBe(200);
    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).toBe("PAID");
  });

  it("routes /razorpay to the B2B verifier, unchanged — an SBT booking still confirms", async () => {
    const booking = await seedB2BFlight("order_mount_041");
    const raw = JSON.stringify(
      capturedEvent({ orderId: "order_mount_041", paymentId: "pay_mount_041", amountPaise: 2150000 }),
    );

    const res = await request(makeServerShapedApp())
      .post("/api/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", sign(raw, B2B_SECRET))
      .send(raw);

    expect(res.status).toBe(200);
    const after: any = await SBTBooking.findById(booking._id).lean();
    expect(after.status).toBe("CONFIRMED");
  });

  it("each endpoint rejects the OTHER account's signature — in both directions", async () => {
    const { application } = await seedD2CCase({ orderId: "order_mount_042" });
    const raw = JSON.stringify(
      capturedEvent({ orderId: "order_mount_042", paymentId: "pay_mount_042", amountPaise: 177000 }),
    );

    // B2B secret at the D2C endpoint.
    const wrongAtD2C = await request(makeServerShapedApp())
      .post("/api/webhooks/razorpay-d2c")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", sign(raw, B2B_SECRET))
      .send(raw);
    expect(wrongAtD2C.status).toBe(400);

    // D2C secret at the B2B endpoint.
    const wrongAtB2B = await request(makeServerShapedApp())
      .post("/api/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", sign(raw, D2C_SECRET))
      .send(raw);
    expect(wrongAtB2B.status).toBe(400);

    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).not.toBe("PAID");
  });

  it("the OLD endpoint still resolves a D2C order — the drain path for pre-cutover orders", async () => {
    /* Every D2C order minted before the MID cutover lives on the old
     * account and its webhook arrives HERE, signed with the B2B secret.
     * routes/razorpay.webhook.ts keeps its VisaApplication lookup for
     * exactly this window. Removing it before those orders are drained
     * would strand real consumer payments in the orphan table. */
    const { application } = await seedD2CCase({ orderId: "order_precutover_043" });
    const raw = JSON.stringify(
      capturedEvent({ orderId: "order_precutover_043", paymentId: "pay_precutover_043", amountPaise: 177000 }),
    );

    const res = await request(makeServerShapedApp())
      .post("/api/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", sign(raw, B2B_SECRET))
      .send(raw);

    expect(res.status).toBe(200);
    const after: any = await VisaApplication.findById(application._id).lean();
    expect(after.d2cPaymentStatus).toBe("PAID");
  });
});
