// The cutover migration that clears stranded D2C order ids.
//
// Real documents on mongodb-memory-server, not literals: the thing under
// test is a SELECTOR, and a selector can only be proved against a real
// collection with real schema defaults in it. The interesting rows are the
// ones that must NOT match — a paid case, a B2B case, an application that
// never had an order — and a hand-built fixture object would let the
// selector "pass" against a shape the schema never produces.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { clearD2CRazorpayOrderIds, assertLocalDatabase } from "./2026-09-10-clear-d2c-razorpay-order-ids.js";
import VisaApplication from "../models/VisaApplication.js";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await VisaApplication.deleteMany({});
});

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

async function seedApplication(opts: {
  source?: string;
  orderId?: string | null;
  paymentStatus?: string | null;
}) {
  const doc: any = await VisaApplication.create({
    workspaceId: D2C_WORKSPACE_ID,
    requestId: new mongoose.Types.ObjectId(),
    consumerId: new mongoose.Types.ObjectId(),
    source: opts.source ?? "D2C",
    travellerProfileId: null,
    destinationIso2: "TH",
    ruleSnapshot: RULE_SNAPSHOT,
    indicativeCostSnapshot: { displayMode: "ITEMISED", totalInr: 1770 },
    status: "submitted",
    razorpayOrderId: opts.orderId ?? null,
  });

  // Set after create so the schema's source-dependent default for
  // d2cPaymentStatus runs first and is then deliberately overridden.
  if (opts.paymentStatus !== undefined) {
    await VisaApplication.updateOne({ _id: doc._id }, { $set: { d2cPaymentStatus: opts.paymentStatus } });
  }
  return doc;
}

describe("clearD2CRazorpayOrderIds — the dry run reports without writing", () => {
  it("counts the stranded rows and changes nothing", async () => {
    const stranded = await seedApplication({ orderId: "order_old_mid_1", paymentStatus: "PENDING" });
    await seedApplication({ orderId: "order_old_mid_2", paymentStatus: "PAID" });

    const summary = await clearD2CRazorpayOrderIds(true);

    expect(summary.d2cWithOrderId).toBe(2);
    expect(summary.strandedUnpaid).toBe(1);
    expect(summary.paidLeftIntact).toBe(1);
    expect(summary.cleared).toBe(0);

    const after: any = await VisaApplication.findById(stranded._id).lean();
    expect(after.razorpayOrderId).toBe("order_old_mid_1");
  });
});

describe("clearD2CRazorpayOrderIds — what --apply clears, and what it refuses to", () => {
  it("clears an unpaid D2C application's old-MID order id", async () => {
    const stranded = await seedApplication({ orderId: "order_old_mid_3", paymentStatus: "PENDING" });

    const summary = await clearD2CRazorpayOrderIds(false);
    expect(summary.cleared).toBe(1);

    const after: any = await VisaApplication.findById(stranded._id).lean();
    // null, not absent — the state a never-ordered application is already
    // in, and what the reuse branch in consumer.applications.ts reads as
    // "no order yet, mint one".
    expect(after.razorpayOrderId).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(after, "razorpayOrderId")).toBe(true);
  });

  it("leaves a PAID application's order id alone — it is settlement evidence", async () => {
    const paid = await seedApplication({ orderId: "order_old_mid_4", paymentStatus: "PAID" });

    const summary = await clearD2CRazorpayOrderIds(false);
    expect(summary.cleared).toBe(0);
    expect(summary.paidLeftIntact).toBe(1);

    const after: any = await VisaApplication.findById(paid._id).lean();
    expect(after.razorpayOrderId).toBe("order_old_mid_4");
  });

  it("does not touch a B2B case in the same collection, whatever it is holding", async () => {
    // source is a two-value enum (models/visaCaseSource.ts): B2B | D2C. A
    // B2B visa case lives in this same collection and its MID is unchanged,
    // so an order id on one is not stranded and must not be cleared.
    const b2b = await seedApplication({
      source: "B2B",
      orderId: "order_b2b_5",
      paymentStatus: null,
    });

    const summary = await clearD2CRazorpayOrderIds(false);
    expect(summary.d2cWithOrderId).toBe(0);
    expect(summary.cleared).toBe(0);

    const after: any = await VisaApplication.findById(b2b._id).lean();
    expect(after.razorpayOrderId).toBe("order_b2b_5");
  });

  it("ignores applications that never had an order — null and empty string alike", async () => {
    await seedApplication({ orderId: null, paymentStatus: "PENDING" });
    await seedApplication({ orderId: "", paymentStatus: "PENDING" });

    const summary = await clearD2CRazorpayOrderIds(false);
    expect(summary.d2cWithOrderId).toBe(0);
    expect(summary.strandedUnpaid).toBe(0);
    expect(summary.cleared).toBe(0);
  });

  it("is idempotent — a second run finds nothing left to do", async () => {
    await seedApplication({ orderId: "order_old_mid_6", paymentStatus: "PENDING" });

    expect((await clearD2CRazorpayOrderIds(false)).cleared).toBe(1);

    const second = await clearD2CRazorpayOrderIds(false);
    expect(second.strandedUnpaid).toBe(0);
    expect(second.cleared).toBe(0);
  });

  it("clears a FAILED case too — a failed attempt still holds a dead old-MID order", async () => {
    const failed = await seedApplication({ orderId: "order_old_mid_7", paymentStatus: "FAILED" });

    expect((await clearD2CRazorpayOrderIds(false)).cleared).toBe(1);

    const after: any = await VisaApplication.findById(failed._id).lean();
    expect(after.razorpayOrderId).toBeNull();
  });
});

describe("assertLocalDatabase — the guard that keeps this off production", () => {
  it("refuses an Atlas connection string", () => {
    expect(() => assertLocalDatabase("mongodb+srv://user:pw@main-prod-cluster.mongodb.net/plumbox")).toThrow(
      /REFUSING TO RUN/,
    );
  });

  it("refuses a non-local host", () => {
    expect(() => assertLocalDatabase("mongodb://10.0.0.5:27017/plumbox_dev")).toThrow(/non-local host/);
  });

  it("refuses a local host holding the wrong database name", () => {
    expect(() => assertLocalDatabase("mongodb://127.0.0.1:27017/plumbox")).toThrow(/expected 'plumbox_dev'/);
  });

  it("refuses an empty URI", () => {
    expect(() => assertLocalDatabase("")).toThrow(/MONGO_URI is empty/);
  });

  it("accepts the local dev database", () => {
    expect(() => assertLocalDatabase("mongodb://127.0.0.1:27017/plumbox_dev")).not.toThrow();
  });
});
