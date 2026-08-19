// AMOUNT INTEGRITY — the property this whole endpoint exists to hold.
//
// ══════════════════════════════════════════════════════════════════════
// THE CHARGE MUST COME FROM THE DATABASE, NOT FROM THE CALLER.
// ══════════════════════════════════════════════════════════════════════
// A payment endpoint that trusts a client-supplied amount lets any
// authenticated user name their own price. The three existing SBT order
// endpoints do exactly that (`const { amount } = req.body`), which is
// precisely why this one is tested the other way round: the request body
// carries a BOGUS amount and the assertion is that the order sent to
// Razorpay is still priced from `indicativeCostSnapshot.totalInr`.
//
// ── WHY fetch IS STUBBED RATHER THAN HITTING RAZORPAY ────────────────
// Two reasons, and the second is the important one:
//   1. no test keys, no network, no real money;
//   2. stubbing is STRICTLY STRONGER evidence. A live call would only
//      show that *an* order came back. The stub captures the exact JSON
//      body we sent, so the amount, the currency and the `notes` block
//      that Stage 2's webhook branch depends on can each be asserted
//      directly. The thing under test is what we ASK for.
//
// Real models on mongodb-memory-server — the own-scope query is a real
// three-clause Mongoose find, and an in-memory stub would not prove it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

/* requireConsumer is the wall, not the subject. It is replaced with an
 * injector so each test can act as a chosen consumer — the OWN-SCOPE
 * assertions below then exercise the route's own query, which is where
 * the isolation actually lives. */
let actingConsumerId: string;
vi.mock("../middleware/requireConsumer.js", () => ({
  requireConsumer: (req: any, _res: any, next: any) => {
    req.consumer = { id: actingConsumerId, email: "test@helloviza.dev", name: "Test" };
    req.consumerWorkspaceId = "d2c00000000000000000d2c1";
    next();
  },
}));

import router from "./consumer.applications.js";
import VisaApplication from "../models/VisaApplication.js";
import { d2cWorkspaceObjectId } from "../services/consumerWorkspace.js";

let mongod: MongoMemoryServer;

/** Every outgoing Razorpay request, captured for assertion. */
let sentRequests: Array<{ url: string; body: any; headers: any }> = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await VisaApplication.deleteMany({});
  sentRequests = [];
  process.env.RAZORPAY_KEY_ID = "rzp_test_FAKEKEYID";
  process.env.RAZORPAY_KEY_SECRET = "fake_test_secret";

  globalThis.fetch = (async (url: any, init: any) => {
    sentRequests.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: init?.headers ?? {},
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "order_TESTFAKE123", amount: 0, currency: "INR" }),
    };
  }) as any;
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/", router);
  return app;
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

/** A submitted, unpaid D2C application priced at ₹1,770. */
async function seedD2CApplication(opts: { consumerId: mongoose.Types.ObjectId; totalInr?: number; status?: string }) {
  return VisaApplication.create({
    workspaceId: d2cWorkspaceObjectId(),
    source: "D2C",
    consumerId: opts.consumerId,
    requestId: new mongoose.Types.ObjectId(),
    travellerProfileId: null,
    destinationIso2: "TH",
    ruleSnapshot: RULE_SNAPSHOT,
    indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: opts.totalInr ?? 1770 },
    status: opts.status ?? "submitted",
  });
}

describe("POST /:id/payment/order — amount integrity", () => {
  it("prices from the STORED total and ignores a bogus client amount", async () => {
    const consumerId = new mongoose.Types.ObjectId();
    actingConsumerId = String(consumerId);
    const app = await seedD2CApplication({ consumerId });

    const res = await request(makeApp())
      .post(`/${app._id}/payment/order`)
      // Everything a hostile client might try. All of it must be ignored.
      .send({ amount: 1, amountInr: 1, totalInr: 1, currency: "USD", price: 1, discount: 99 });

    expect(res.status).toBe(200);

    // THE ASSERTION. ₹1,770 -> 177000 paise, from the database.
    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0].url).toBe("https://api.razorpay.com/v1/orders");
    expect(sentRequests[0].body.amount).toBe(177000);
    expect(sentRequests[0].body.amount).not.toBe(100); // not the bogus ₹1
    expect(sentRequests[0].body.currency).toBe("INR"); // not the bogus USD

    // And the response echoes our figure, not the caller's.
    expect(res.body.amount).toBe(177000);
    expect(res.body.currency).toBe("INR");
  });

  it("sends notes.channel D2C + applicationId — what Stage 2's webhook branches on", async () => {
    const consumerId = new mongoose.Types.ObjectId();
    actingConsumerId = String(consumerId);
    const app = await seedD2CApplication({ consumerId });

    await request(makeApp()).post(`/${app._id}/payment/order`).send({});

    expect(sentRequests[0].body.notes).toEqual({
      channel: "D2C",
      applicationId: String(app._id),
    });
    expect(String(sentRequests[0].body.receipt)).toContain(`hvd2c_${app._id}`);
  });

  it("prices a DIFFERENT application from ITS OWN stored total", async () => {
    // Guards against a constant sneaking in: the figure must track the row.
    const consumerId = new mongoose.Types.ObjectId();
    actingConsumerId = String(consumerId);
    const app = await seedD2CApplication({ consumerId, totalInr: 4250 });

    await request(makeApp()).post(`/${app._id}/payment/order`).send({ amount: 177000 });

    expect(sentRequests[0].body.amount).toBe(425000);
  });

  it("persists the order id on the application and never leaks the secret", async () => {
    const consumerId = new mongoose.Types.ObjectId();
    actingConsumerId = String(consumerId);
    const app = await seedD2CApplication({ consumerId });

    const res = await request(makeApp()).post(`/${app._id}/payment/order`).send({});

    const fresh: any = await VisaApplication.findById(app._id).lean();
    expect(fresh.razorpayOrderId).toBe("order_TESTFAKE123");
    expect(fresh.razorpayPaymentId ?? null).toBeNull(); // Stage 2 writes this

    expect(res.body.keyId).toBe("rzp_test_FAKEKEYID"); // publishable — fine
    expect(JSON.stringify(res.body)).not.toContain("fake_test_secret");
  });
});

describe("POST /:id/payment/order — own-scope", () => {
  it("404s on ANOTHER consumer's application", async () => {
    const owner = new mongoose.Types.ObjectId();
    const attacker = new mongoose.Types.ObjectId();
    const app = await seedD2CApplication({ consumerId: owner });

    actingConsumerId = String(attacker);
    const res = await request(makeApp()).post(`/${app._id}/payment/order`).send({});

    // 404, not 403 — the refusal must not confirm the id exists.
    expect(res.status).toBe(404);
    // And nothing was sent to the gateway on someone else's behalf.
    expect(sentRequests).toHaveLength(0);
  });

  it("404s on an unknown / malformed id without touching the gateway", async () => {
    actingConsumerId = String(new mongoose.Types.ObjectId());

    expect((await request(makeApp()).post(`/${new mongoose.Types.ObjectId()}/payment/order`).send({})).status).toBe(404);
    expect((await request(makeApp()).post(`/not-an-objectid/payment/order`).send({})).status).toBe(404);
    expect(sentRequests).toHaveLength(0);
  });
});

describe("POST /:id/payment/order — state guards", () => {
  it("409s when already PAID, and mints nothing", async () => {
    const consumerId = new mongoose.Types.ObjectId();
    actingConsumerId = String(consumerId);
    const app = await seedD2CApplication({ consumerId });
    await VisaApplication.updateOne({ _id: app._id }, { $set: { d2cPaymentStatus: "PAID" } });

    const res = await request(makeApp()).post(`/${app._id}/payment/order`).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_PAID");
    expect(sentRequests).toHaveLength(0);
  });

  it("409s on a non-payable status (draft)", async () => {
    const consumerId = new mongoose.Types.ObjectId();
    actingConsumerId = String(consumerId);
    const app = await seedD2CApplication({ consumerId, status: "draft" });

    const res = await request(makeApp()).post(`/${app._id}/payment/order`).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_PAYABLE");
    expect(sentRequests).toHaveLength(0);
  });

  it("reuses an existing unpaid order instead of minting a second", async () => {
    const consumerId = new mongoose.Types.ObjectId();
    actingConsumerId = String(consumerId);
    const app = await seedD2CApplication({ consumerId });

    const first = await request(makeApp()).post(`/${app._id}/payment/order`).send({});
    const second = await request(makeApp()).post(`/${app._id}/payment/order`).send({});

    expect(first.body.reused).toBe(false);
    expect(second.body.reused).toBe(true);
    expect(second.body.orderId).toBe(first.body.orderId);
    expect(second.body.amount).toBe(177000);
    // One case, one live order — the gateway was called exactly once.
    expect(sentRequests).toHaveLength(1);
  });
});

describe("POST /:id/payment/order — gateway not configured", () => {
  it("503s cleanly when the keys are absent, and mints nothing", async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;

    const consumerId = new mongoose.Types.ObjectId();
    actingConsumerId = String(consumerId);
    const app = await seedD2CApplication({ consumerId });

    const res = await request(makeApp()).post(`/${app._id}/payment/order`).send({});

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("GATEWAY_NOT_CONFIGURED");
    expect(sentRequests).toHaveLength(0);

    const fresh: any = await VisaApplication.findById(app._id).lean();
    expect(fresh.razorpayOrderId ?? null).toBeNull();
  });
});
