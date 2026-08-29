// The two erasure SURFACES, over real HTTP against real collections —
// routes/consumer.erasure.ts (D4, the request) and
// routes/admin.consumerErasure.ts (D7/D8, review and execute).
//
// Both routers in ONE file, deliberately: the only interesting assertions
// are about the HANDOFF between them — a consumer raises, an agent reviews,
// a Super Admin executes, and at no point may a step be skipped or a
// non-Super-Admin reach the destructive one. Split across two files, the
// gate tests would each have to fake the other half's state.
//
// Never imports server.ts (that would boot the app and dial the real
// cluster); a minimal express app mounts the real routers at their real
// prefixes, the convention admin.consumers.test.ts sets.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

const B2B_SECRET = "b2b-jwt-secret-for-erasure-tests";
process.env.JWT_SECRET = B2B_SECRET;
process.env.CONSUMER_JWT_SECRET = "consumer-jwt-secret-for-erasure-tests";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-erasure-routes-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.AWS_REGION ||= "ap-south-1";
process.env.PII_MASTER_KEY ||= crypto.randomBytes(32).toString("base64");
delete process.env.ERASURE_REDACT_INVOICE_NAME;

vi.mock("../utils/s3Upload.js", () => ({
  deleteObject: vi.fn(async () => undefined),
  uploadBufferToS3: vi.fn(),
  getObjectBuffer: vi.fn(),
  uploadAndPresign: vi.fn(),
  uploadLogoToS3: vi.fn(),
  uploadExpenseReceiptToS3: vi.fn(),
}));

const { default: Consumer } = await import("../models/Consumer.js");
const { default: ConsumerProfile } = await import("../models/ConsumerProfile.js");
const { default: SavedCountry } = await import("../models/SavedCountry.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { default: Invoice } = await import("../models/Invoice.js");
const { default: ConsumerErasureRequest } = await import("../models/ConsumerErasureRequest.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { signConsumerAccessToken } = await import("../utils/consumerJwt.js");
const { default: consumerErasureRouter } = await import("./consumer.erasure.js");
const { default: adminConsumerErasureRouter } = await import("./admin.consumerErasure.js");

let mongod: MongoMemoryServer;

const SUPER_ID = new mongoose.Types.ObjectId();
const STAFF_ID = new mongoose.Types.ObjectId();
const WORKSPACE_ID = new mongoose.Types.ObjectId("d2c00000000000000000d2c1");
const HOUSE_CUSTOMER_ID = new mongoose.Types.ObjectId();

function b2bToken(id: mongoose.Types.ObjectId, roles: string[], email: string) {
  return jwt.sign({ sub: String(id), id: String(id), _id: String(id), email, roles }, B2B_SECRET, {
    expiresIn: "1h",
  });
}

const SUPER_AUTH = `Bearer ${b2bToken(SUPER_ID, ["SUPERADMIN"], "boss@plumtrips.com")}`;
const STAFF_AUTH = `Bearer ${b2bToken(STAFF_ID, ["OPS"], "agent@plumtrips.com")}`;

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use("/api/consumer/erasure", consumerErasureRouter);
  a.use("/api/admin/consumer-erasure", adminConsumerErasureRouter);
  return a;
}

async function makeConsumer(email = "person@example.com", name = "Rahul Sharma") {
  const consumer: any = await Consumer.create({ email, name, passwordHash: "x" });
  const token = signConsumerAccessToken({
    consumerId: String(consumer._id),
    tokenVersion: consumer.tokenVersion,
  });
  return { consumer, auth: `Bearer ${token}` };
}

/** A paid case, so the retention preview has something to show a reviewer. */
async function makePaidCase(consumer: any) {
  const booking: any = await ManualBooking.create({
    type: "VISA",
    workspaceId: HOUSE_CUSTOMER_ID,
    bookedBy: SUPER_ID,
    status: "CONFIRMED",
    source: "MANUAL",
    travelDate: new Date("2026-10-01"),
    passengers: [{ name: consumer.name, email: consumer.email, type: "ADULT" }],
    pricing: { actualPrice: 2500, quotedPrice: 4270, gstMode: "ON_MARKUP", gstPercent: 18 },
    notes: `Helloviza D2C visa — ${consumer.name}`,
    metadata: { channel: "D2C", consumerId: String(consumer._id) },
  });
  const invoice: any = await Invoice.create({
    workspaceId: HOUSE_CUSTOMER_ID,
    bookingIds: [booking._id],
    lineItems: [],
    subtotal: 4000,
    totalGST: 270,
    grandTotal: 4270,
    supplyType: "IGST",
    igstAmount: 270,
    clientDetails: { companyName: consumer.name, email: consumer.email },
    status: "PAID",
    invoiceDate: new Date(),
  });
  return { booking, invoice };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await ConsumerErasureRequest.syncIndexes();
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all(
    [Consumer, ConsumerProfile, SavedCountry, ManualBooking, Invoice, ConsumerErasureRequest, UserPermission].map(
      (m: any) => m.deleteMany({}),
    ),
  );
  // A non-Super-Admin who genuinely holds visaApplication:READ — the only
  // interesting kind, since a caller refused at the gate proves nothing
  // about what the SUPERADMIN-only gate adds on top of it.
  await UserPermission.create({
    userId: String(STAFF_ID),
    email: "agent@plumtrips.com",
    workspaceId: "house",
    universe: "STAFF",
    level: { code: "L4", name: "Ops" },
    modules: { visaApplication: { access: "READ", scope: "ALL" } },
    grantedBy: String(SUPER_ID),
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * D4 — THE CONSUMER'S REQUEST
 * ═════════════════════════════════════════════════════════════════════ */

describe("POST /api/consumer/erasure — the request entry point", () => {
  it("records the request and DELETES NOTHING", async () => {
    const { consumer, auth } = await makeConsumer();
    await SavedCountry.create({ consumerId: consumer._id, workspaceId: WORKSPACE_ID, iso2: "TH", source: "manual" });
    await makePaidCase(consumer);

    const res = await request(app())
      .post("/api/consumer/erasure")
      .set("Authorization", auth)
      .send({ reason: "I no longer use this service" });

    expect(res.status).toBe(201);
    expect(res.body.request.state).toBe("requested");

    // THE POINT OF THE WHOLE TWO-STEP DESIGN.
    expect(await Consumer.findById(consumer._id).lean()).not.toBeNull();
    expect(await SavedCountry.countDocuments({ consumerId: consumer._id })).toBe(1);
    expect(await Invoice.countDocuments({})).toBe(1);

    const row: any = await ConsumerErasureRequest.findOne({ consumerId: consumer._id }).lean();
    expect(row.state).toBe("requested");
    expect(row.origin).toBe("consumer_account");
    expect(row.subjectEmail).toBe("person@example.com");
  });

  it("refuses without a consumer session", async () => {
    const res = await request(app()).post("/api/consumer/erasure").send({});
    expect(res.status).toBe(401);
  });

  it("cannot be raised for anyone else — the body's consumerId is ignored", async () => {
    const mine = await makeConsumer("mine@example.com", "Mine");
    const theirs = await makeConsumer("theirs@example.com", "Theirs");

    await request(app())
      .post("/api/consumer/erasure")
      .set("Authorization", mine.auth)
      .send({ consumerId: String(theirs.consumer._id) })
      .expect(201);

    expect(await ConsumerErasureRequest.countDocuments({ consumerId: theirs.consumer._id })).toBe(0);
    expect(await ConsumerErasureRequest.countDocuments({ consumerId: mine.consumer._id })).toBe(1);
  });

  it("409s on a second request while one is open, and reports the state", async () => {
    const { auth } = await makeConsumer();
    await request(app()).post("/api/consumer/erasure").set("Authorization", auth).expect(201);
    const res = await request(app()).post("/api/consumer/erasure").set("Authorization", auth);
    expect(res.status).toBe(409);
    expect(res.body.state).toBe("requested");
  });

  it("GET reports the open request back to the consumer", async () => {
    const { auth } = await makeConsumer();
    expect((await request(app()).get("/api/consumer/erasure").set("Authorization", auth)).body.request).toBeNull();

    await request(app()).post("/api/consumer/erasure").set("Authorization", auth).expect(201);
    const res = await request(app()).get("/api/consumer/erasure").set("Authorization", auth);
    expect(res.body.request.state).toBe("requested");
    expect(res.body.request.stateLabel).toContain("awaiting review");
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * D7 — THE GATE
 * ═════════════════════════════════════════════════════════════════════ */

describe("the admin surface — who may do what", () => {
  async function openRequest() {
    const { consumer, auth } = await makeConsumer();
    await makePaidCase(consumer);
    await request(app()).post("/api/consumer/erasure").set("Authorization", auth).expect(201);
    const row: any = await ConsumerErasureRequest.findOne({ consumerId: consumer._id }).lean();
    return { consumer, requestId: String(row._id) };
  }

  it("a visaApplication:READ holder can see the queue and review", async () => {
    const { requestId } = await openRequest();

    const queue = await request(app()).get("/api/admin/consumer-erasure").set("Authorization", STAFF_AUTH);
    expect(queue.status).toBe(200);
    expect(queue.body.rows).toHaveLength(1);
    expect(queue.body.summary.requested).toBe(1);
    // The gate is stated on the response, not inferred by the client.
    expect(queue.body.viewer.canExecute).toBe(false);
    expect(queue.body.policy.redactInvoiceName).toBe(false);

    const review = await request(app())
      .post(`/api/admin/consumer-erasure/${requestId}/review`)
      .set("Authorization", STAFF_AUTH)
      .send({ note: "looks genuine" });
    expect(review.status).toBe(200);
    expect(review.body.request.state).toBe("under_review");
  });

  it("...but CANNOT approve, reject or execute", async () => {
    const { requestId } = await openRequest();
    await request(app())
      .post(`/api/admin/consumer-erasure/${requestId}/review`)
      .set("Authorization", STAFF_AUTH)
      .expect(200);

    for (const path of ["approve", "reject", "execute"]) {
      const res = await request(app())
        .post(`/api/admin/consumer-erasure/${requestId}/${path}`)
        .set("Authorization", STAFF_AUTH)
        .send({ note: "x", confirm: true });
      expect(res.status).toBe(403);
    }
    // Nothing moved, and nothing was erased.
    const row: any = await ConsumerErasureRequest.findById(requestId).lean();
    expect(row.state).toBe("under_review");
    expect(await Consumer.countDocuments({})).toBe(1);
  });

  it("the reviewer is SHOWN what will be kept before approving", async () => {
    const { requestId } = await openRequest();

    const detail = await request(app())
      .get(`/api/admin/consumer-erasure/${requestId}`)
      .set("Authorization", STAFF_AUTH);

    expect(detail.status).toBe(200);
    expect(detail.body.plan.dryRun).toBe(true);
    // THE RETENTION PREVIEW — an invoice, listed as retained, with its
    // number and amount, and the D1 flag's effect spelled out.
    expect(detail.body.plan.retained.invoices).toHaveLength(1);
    expect(detail.body.plan.retained.invoices[0].grandTotal).toBe(4270);
    expect(detail.body.plan.retained.invoices[0].nameKept).toBe(true);
    // ...and the invoice appears under REDACT, never under DELETE.
    const redact = detail.body.plan.motions.redact.find((e: any) => e.collection === "Invoice");
    expect(redact.count).toBe(1);
    expect(detail.body.plan.motions.delete.find((e: any) => e.collection === "Invoice")).toBeUndefined();
  });
});

/* ═════════════════════════════════════════════════════════════════════
 * D8 — THE FULL CONSOLE FLOW
 * ═════════════════════════════════════════════════════════════════════ */

describe("review -> approve -> execute", () => {
  async function openRequest() {
    const { consumer, auth } = await makeConsumer();
    const fixture = await makePaidCase(consumer);
    await request(app()).post("/api/consumer/erasure").set("Authorization", auth).expect(201);
    const row: any = await ConsumerErasureRequest.findOne({ consumerId: consumer._id }).lean();
    return { consumer, fixture, requestId: String(row._id) };
  }

  it("refuses to execute a request that was never approved", async () => {
    const { requestId } = await openRequest();
    const res = await request(app())
      .post(`/api/admin/consumer-erasure/${requestId}/execute`)
      .set("Authorization", SUPER_AUTH)
      .send({ confirm: true });
    expect(res.status).toBe(409);
    expect(await Consumer.countDocuments({})).toBe(1);
  });

  it("refuses to execute without confirm: true", async () => {
    const { requestId } = await openRequest();
    await request(app()).post(`/api/admin/consumer-erasure/${requestId}/review`).set("Authorization", SUPER_AUTH);
    await request(app()).post(`/api/admin/consumer-erasure/${requestId}/approve`).set("Authorization", SUPER_AUTH);

    const res = await request(app())
      .post(`/api/admin/consumer-erasure/${requestId}/execute`)
      .set("Authorization", SUPER_AUTH)
      .send({});
    expect(res.status).toBe(400);
    expect(await Consumer.countDocuments({})).toBe(1);
  });

  it("executes: the account goes, the invoice stays, the record is pseudonymised", async () => {
    const { consumer, fixture, requestId } = await openRequest();

    await request(app())
      .post(`/api/admin/consumer-erasure/${requestId}/review`)
      .set("Authorization", SUPER_AUTH)
      .expect(200);
    await request(app())
      .post(`/api/admin/consumer-erasure/${requestId}/approve`)
      .set("Authorization", SUPER_AUTH)
      .expect(200);

    const res = await request(app())
      .post(`/api/admin/consumer-erasure/${requestId}/execute`)
      .set("Authorization", SUPER_AUTH)
      .send({ confirm: true, reason: "DPDP erasure request" });

    expect(res.status).toBe(200);
    expect(res.body.request.state).toBe("executed");
    expect(res.body.manifest.dryRun).toBe(false);

    expect(await Consumer.findById(consumer._id).lean()).toBeNull();

    const inv: any = await Invoice.findById(fixture.invoice._id).lean();
    expect(inv).not.toBeNull();
    expect(inv.grandTotal).toBe(4270);
    expect(inv.clientDetails.email ?? null).toBeNull();

    // D6, on the wire and in the database.
    expect(res.body.request.subjectEmail).toBeNull();
    expect(res.body.request.subjectPseudonym).toMatch(/^hv:/);
    const stored: any = await ConsumerErasureRequest.findById(requestId).lean();
    expect(JSON.stringify(stored)).not.toContain("person@example.com");
    expect(JSON.stringify(stored)).not.toContain("Rahul Sharma");
  });

  it("an executed request serves its stored manifest instead of a stale plan", async () => {
    const { requestId } = await openRequest();
    await request(app()).post(`/api/admin/consumer-erasure/${requestId}/review`).set("Authorization", SUPER_AUTH);
    await request(app()).post(`/api/admin/consumer-erasure/${requestId}/approve`).set("Authorization", SUPER_AUTH);
    await request(app())
      .post(`/api/admin/consumer-erasure/${requestId}/execute`)
      .set("Authorization", SUPER_AUTH)
      .send({ confirm: true })
      .expect(200);

    const detail = await request(app())
      .get(`/api/admin/consumer-erasure/${requestId}`)
      .set("Authorization", STAFF_AUTH);
    expect(detail.body.plan).toBeNull();
    expect(detail.body.manifest.dryRun).toBe(false);
    expect(detail.body.manifest.retained.invoices).toHaveLength(1);
  });

  it("rejecting requires a reason and leaves everything intact", async () => {
    const { consumer, requestId } = await openRequest();

    const bad = await request(app())
      .post(`/api/admin/consumer-erasure/${requestId}/reject`)
      .set("Authorization", SUPER_AUTH)
      .send({});
    expect(bad.status).toBe(400);

    const ok = await request(app())
      .post(`/api/admin/consumer-erasure/${requestId}/reject`)
      .set("Authorization", SUPER_AUTH)
      .send({ note: "Could not verify the account holder" });
    expect(ok.status).toBe(200);
    expect(ok.body.request.state).toBe("rejected");

    expect(await Consumer.findById(consumer._id).lean()).not.toBeNull();
    expect(await Invoice.countDocuments({})).toBe(1);
  });

  it("an ops agent can log a request that arrived by another channel", async () => {
    const { consumer } = await makeConsumer("phoned@example.com", "Phoned In");

    const res = await request(app())
      .post("/api/admin/consumer-erasure")
      .set("Authorization", STAFF_AUTH)
      .send({ consumerId: String(consumer._id), reason: "Phoned the helpdesk" });

    expect(res.status).toBe(201);
    expect(res.body.request.origin).toBe("ops_logged");
    expect(await Consumer.findById(consumer._id).lean()).not.toBeNull();
  });
});
