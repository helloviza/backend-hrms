// Create/update hardening for /api/admin/manual-bookings, end to end through
// supertest against REAL collections (MongoMemoryServer) and the REAL
// router + model. Only the edges that would need AWS / geo / a worker are
// faked: S3 put/presign/delete, the IP-geo resolver, the extraction queue
// and the task-automation hook.
//
// Three things are pinned here, each a finding from the 2026-09-20 audit:
//   B. attachments[] / s3Key can never enter through a create or update
//      body — the only writer of an s3Key is POST /:id/attachments, and the
//      presign route can therefore only ever sign a key the server wrote.
//   C. POST / gates the client-supplied workspaceId with canAccessBooking
//      (same tenant rule as every read/update); PUT /:id whitelists its
//      body, so workspaceId / bookedBy / createdBy / bookingRef / source /
//      invoiceId / isDemo are unreachable from a client.
//   D. A flight/hotel booking may not ENTER Done (CONFIRMED) without an
//      attachment on record — on create (nothing can be attached yet), on
//      update, and from the delete side (last file on a Done booking).
//      Legacy rows already in that state, and SBT-sourced rows, are exempt.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/manual-bookings-hardening-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

// Identity is injected per request through a header so one app can play
// every caller — requireAuth / requirePermission themselves are pass-through.
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

const { s3Log } = vi.hoisted(() => ({ s3Log: { puts: [] as any[], presigns: [] as any[], deletes: [] as string[] } }));

vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: async (opts: any) => {
    const key = `${opts.keyPrefix}/${Date.now()}-server-${s3Log.puts.length + 1}.pdf`;
    s3Log.puts.push({ ...opts, buffer: undefined, key });
    return { bucket: "test-bucket", key, url: `https://test-bucket/${key}` };
  },
}));
vi.mock("../utils/s3Presign.js", () => ({
  presignGetObject: async (opts: any) => {
    s3Log.presigns.push(opts.key);
    return `signed://${opts.key}`;
  },
}));
vi.mock("../config/aws.js", () => ({
  s3: { send: async (cmd: any) => { s3Log.deletes.push(cmd?.input?.Key); return {}; } },
}));
vi.mock("../services/location.service.js", () => ({
  resolveActorFromRequest: async () => ({
    location: { city: null, rawCity: null, source: "private-ip", confidence: 0, reason: "test" },
  }),
}));
vi.mock("../services/documentExtraction.service.js", () => ({
  enqueueExtraction: async () => null,
}));
vi.mock("../services/taskAutomation.js", () => ({
  triggerTaskAutomation: async () => null,
}));

const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { HOUSE_WORKSPACE_ID } = await import("../utils/bookingAccess.js");
const { default: router } = await import("./manualBookings.js");

const TENANT_A_CUSTOMER_ID = "aaaaaaaaaaaaaaaaaaaaaaaa"; // Customer._id space
const TENANT_A_WORKSPACE_ID = "bbbbbbbbbbbbbbbbbbbbbbbb"; // CustomerWorkspace._id space
const TENANT_B_CUSTOMER_ID = "cccccccccccccccccccccccc";
const STAFF_A_ID = "507f1f77bcf86cd799439011";
const HOUSE_STAFF_ID = "507f1f77bcf86cd799439022";

type Caller = { userId: string; customerId?: string | null; workspaceObjectId?: string; scope?: string; roles?: string[] };
const TENANT_A: Caller = { userId: STAFF_A_ID, customerId: TENANT_A_CUSTOMER_ID, workspaceObjectId: TENANT_A_WORKSPACE_ID, scope: "ALL" };
const HOUSE: Caller = { userId: HOUSE_STAFF_ID, customerId: null, workspaceObjectId: HOUSE_WORKSPACE_ID, scope: "ALL" };

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  const c: Caller = JSON.parse(String(req.headers["x-caller"] || "{}"));
  req.user = { _id: c.userId, sub: c.userId, email: "ops@test.local", roles: c.roles ?? ["ADMIN"] };
  req.workspace = { customerId: c.customerId ?? null };
  req.workspaceObjectId = c.workspaceObjectId;
  req.permissionScope = c.scope ?? "ALL";
  next();
});
app.use("/", router);

const as = (c: Caller) => ({ "x-caller": JSON.stringify(c) });

// Minimum that clears validateBookingRequired() for a FLIGHT.
const flight = (over: Record<string, any> = {}) => ({
  workspaceId: TENANT_A_CUSTOMER_ID,
  type: "FLIGHT",
  supplierName: "Test Supplier",
  givenBy: "Ops Desk",
  travelDate: "2026-10-01",
  passengers: [{ name: "Priya", type: "ADULT" }],
  pricing: { actualPrice: 1000, quotedPrice: 1200, gstMode: "ON_MARKUP", gstPercent: 18, currency: "INR" },
  ...over,
});

async function create(body: any, caller: Caller = TENANT_A) {
  return request(app).post("/").set(as(caller)).send(body);
}
async function upload(id: string, caller: Caller = TENANT_A) {
  return request(app)
    .post(`/${id}/attachments`)
    .set(as(caller))
    .field("type", "ticket")
    .attach("file", Buffer.from("%PDF-1.4 test"), { filename: "ticket.pdf", contentType: "application/pdf" });
}

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await ManualBooking.deleteMany({});
  s3Log.puts.length = 0;
  s3Log.presigns.length = 0;
  s3Log.deletes.length = 0;
});

/* ── B. attachments / s3Key never come from a body ─────────────────── */
describe("B — client-supplied attachments[] / s3Key are refused", () => {
  it("POST / with attachments[] → 400, nothing written", async () => {
    const r = await create(flight({ attachments: [{ type: "ticket", originalFilename: "x.pdf", s3Key: "hrms/invoices/other-tenant/secret.pdf", size: 1, mimeType: "application/pdf", uploadedBy: STAFF_A_ID }] }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/attachments are managed via POST/);
    expect(await ManualBooking.countDocuments({})).toBe(0);
  });

  it("POST / with an s3Key smuggled anywhere in the body → 400", async () => {
    const r = await create(flight({ itinerary: { origin: "DEL", s3Key: "hrms/anything.pdf" } }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/s3Key cannot be supplied/);
    expect(await ManualBooking.countDocuments({})).toBe(0);
  });

  it("PUT /:id with attachments[] → 400, the row's attachments are untouched", async () => {
    const created = (await create(flight())).body.booking;
    const r = await request(app).put(`/${created._id}`).set(as(TENANT_A))
      .send({ notes: "x", attachments: [{ type: "other", originalFilename: "y.pdf", s3Key: "hrms/policies/hr.pdf", size: 1, mimeType: "application/pdf", uploadedBy: STAFF_A_ID }] });
    expect(r.status).toBe(400);
    const row: any = await ManualBooking.findById(created._id).lean();
    expect(row.attachments).toEqual([]);
    expect(row.notes).toBeUndefined();
  });

  it("presign can only ever sign a key the upload route wrote", async () => {
    const created = (await create(flight())).body.booking;
    const up = await upload(created._id);
    expect(up.status).toBe(201);
    const key = up.body.attachment.s3Key;
    expect(key).toMatch(new RegExp(`^bookings/attachments/${created._id}/`));
    expect(s3Log.puts[0].customerId).toBe(TENANT_A_CUSTOMER_ID); // tenant carried in S3 object metadata

    // Attempt to swap the stored key for a foreign one through PUT → refused.
    const swap = await request(app).put(`/${created._id}`).set(as(TENANT_A))
      .send({ attachments: [{ ...up.body.attachment, s3Key: "hrms/invoices/other-tenant/secret.pdf" }] });
    expect(swap.status).toBe(400);

    const url = await request(app).get(`/${created._id}/attachments/${up.body.attachment._id}/url`).set(as(TENANT_A));
    expect(url.status).toBe(200);
    expect(url.body.url).toBe(`signed://${key}`);
    expect(s3Log.presigns).toEqual([key]);
  });
});

/* ── C. whitelisted bodies + tenant gate on create ─────────────────── */
describe("C — tenant gate on create, server-owned fields unreachable", () => {
  it("non-HOUSE caller creating for ANOTHER tenant → 403 (same rule as reads)", async () => {
    const r = await create(flight({ workspaceId: TENANT_B_CUSTOMER_ID }), TENANT_A);
    expect(r.status).toBe(403);
    expect(await ManualBooking.countDocuments({})).toBe(0);
  });

  it("non-HOUSE caller creating for its OWN tenant → 201 (either id-space)", async () => {
    expect((await create(flight({ workspaceId: TENANT_A_CUSTOMER_ID }), TENANT_A)).status).toBe(201);
    // The ~26 prod rows written in CustomerWorkspace._id space still resolve.
    expect((await create(flight({ workspaceId: TENANT_A_WORKSPACE_ID }), TENANT_A)).status).toBe(201);
  });

  it("HOUSE caller may create for any tenant; SUPERADMIN too", async () => {
    expect((await create(flight({ workspaceId: TENANT_B_CUSTOMER_ID }), HOUSE)).status).toBe(201);
    expect((await create(flight({ workspaceId: TENANT_B_CUSTOMER_ID }), { userId: STAFF_A_ID, roles: ["SUPERADMIN"] })).status).toBe(201);
  });

  it("workspaceId missing / malformed → 400, not a 500 from Mongoose", async () => {
    expect((await create(flight({ workspaceId: undefined }))).status).toBe(400);
    expect((await create(flight({ workspaceId: "not-an-id" }))).status).toBe(400);
  });

  it("POST / ignores server-owned fields in the body", async () => {
    const r = await create(flight({
      bookedBy: HOUSE_STAFF_ID, createdBy: "attacker", createdByEmail: "a@b.c", bookingRef: "MB-9999-0001",
      isDemo: true, createdByDemoUser: true, invoiceId: new mongoose.Types.ObjectId().toHexString(),
      deletedAt: new Date().toISOString(), piiRedactedAt: new Date().toISOString(), metadata: { intakeRef: "x" },
      bookedFromCity: { city: "Nowhere", source: "ip", confidence: 1, reason: "spoof" },
      invoiceRaisedDate: new Date().toISOString(), sourceBookingRef: "SBT-1",
    }));
    expect(r.status).toBe(201);
    const row: any = await ManualBooking.findById(r.body.booking._id).lean();
    expect(String(row.bookedBy)).toBe(STAFF_A_ID);
    expect(row.createdBy).toBe(STAFF_A_ID);
    expect(row.bookingRef).toMatch(/^MB-\d{4}-\d{4}$/);
    expect(row.isDemo).toBe(false);
    expect(row.invoiceId).toBeUndefined();
    expect(row.deletedAt).toBeUndefined();
    expect(row.piiRedactedAt).toBeUndefined();
    expect(row.metadata).toBeUndefined();
    expect(row.invoiceRaisedDate).toBeUndefined();
    expect(row.sourceBookingRef).toBeUndefined();
    expect(row.bookedFromCity.reason).toBe("test"); // resolver's, never the body's
  });

  it("POST / refuses a client-claimed SBT source or INVOICED status", async () => {
    expect((await create(flight({ source: "SBT" }))).status).toBe(400);
    expect((await create(flight({ source: "SBT_AUTO" }))).status).toBe(400);
    expect((await create(flight({ status: "INVOICED" }))).status).toBe(400);
    expect((await create(flight({ source: "ADMIN_QUEUE" }))).status).toBe(201); // the ?requestId= prefill path
  });

  it("PUT /:id cannot move a booking to another tenant or rewrite server-owned fields", async () => {
    const created = (await create(flight())).body.booking;
    const r = await request(app).put(`/${created._id}`).set(as(TENANT_A)).send({
      notes: "edited",
      workspaceId: TENANT_B_CUSTOMER_ID, bookedBy: HOUSE_STAFF_ID, createdBy: "attacker",
      bookingRef: "MB-0000-0000", source: "SBT", isDemo: true,
      invoiceId: new mongoose.Types.ObjectId().toHexString(), invoiceRaisedDate: new Date().toISOString(),
      deletedAt: new Date().toISOString(),
    });
    expect(r.status).toBe(200);
    const row: any = await ManualBooking.findById(created._id).lean();
    expect(row.notes).toBe("edited");
    expect(String(row.workspaceId)).toBe(TENANT_A_CUSTOMER_ID);
    expect(String(row.bookedBy)).toBe(STAFF_A_ID);
    expect(row.createdBy).toBe(STAFF_A_ID);
    expect(row.bookingRef).toBe(created.bookingRef);
    expect(row.source).toBe("MANUAL");
    expect(row.isDemo).toBe(false);
    expect(row.invoiceId).toBeUndefined();
    expect(row.invoiceRaisedDate).toBeUndefined();
    expect(row.deletedAt).toBeUndefined();
  });

  it("PUT /:id still rejects a cross-tenant caller outright (unchanged)", async () => {
    const created = (await create(flight())).body.booking;
    const r = await request(app).put(`/${created._id}`)
      .set(as({ userId: "507f1f77bcf86cd799439033", customerId: TENANT_B_CUSTOMER_ID, scope: "ALL" }))
      .send({ notes: "x" });
    expect(r.status).toBe(403);
  });

  it("pricing derived figures are recomputed, not taken from the body", async () => {
    const r = await create(flight({ pricing: { actualPrice: 1000, quotedPrice: 1200, gstMode: "ON_FULL", gstPercent: 18, currency: "INR", grandTotal: 1, profitMargin: 999, diff: 5 } }));
    expect(r.status).toBe(201);
    expect(r.body.booking.pricing.grandTotal).toBe(1416); // 1200 + 18%
    expect(r.body.booking.pricing.diff).toBe(200);
  });
});

/* ── D. mandatory attachment as a STATUS gate ──────────────────────── */
describe("D — flight/hotel may not ENTER Done without an attachment", () => {
  it("POST / a FLIGHT directly as CONFIRMED → 400 ATTACHMENT_REQUIRED; as PENDING → 201", async () => {
    const r = await create(flight({ status: "CONFIRMED" }));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("ATTACHMENT_REQUIRED");
    expect(await ManualBooking.countDocuments({})).toBe(0);
    expect((await create(flight({ status: "PENDING" }))).status).toBe(201);
    expect((await create(flight({ status: "WIP" }))).status).toBe(201);
  });

  it("HOTEL is gated the same way; a non-gated type (OTHER) can be born CONFIRMED", async () => {
    const hotel = flight({ type: "HOTEL", status: "CONFIRMED", sector: "Goa", returnDate: "2026-10-03", itinerary: { hotelName: "H" } });
    expect((await create(hotel)).body.code).toBe("ATTACHMENT_REQUIRED");
    expect((await create(flight({ type: "OTHER", status: "CONFIRMED" }))).status).toBe(201);
  });

  it("the create-then-upload-then-Done sequence the form runs works end to end", async () => {
    const created = (await create(flight({ status: "PENDING" }))).body.booking;

    // Done before any file → refused, row untouched.
    const early = await request(app).put(`/${created._id}`).set(as(TENANT_A)).send({ status: "CONFIRMED" });
    expect(early.status).toBe(400);
    expect(early.body.code).toBe("ATTACHMENT_REQUIRED");
    expect(((await ManualBooking.findById(created._id).lean()) as any).status).toBe("PENDING");

    // Manual fallback: attach from the edit screen, then mark Done.
    expect((await upload(created._id)).status).toBe(201);
    const done = await request(app).put(`/${created._id}`).set(as(TENANT_A)).send({ status: "CONFIRMED" });
    expect(done.status).toBe(200);
    expect(done.body.booking.status).toBe("CONFIRMED");
  });

  it("the last attachment on a Done flight cannot be deleted; after moving back to Pending it can", async () => {
    const created = (await create(flight())).body.booking;
    const att = (await upload(created._id)).body.attachment;
    await request(app).put(`/${created._id}`).set(as(TENANT_A)).send({ status: "CONFIRMED" });

    const del = await request(app).delete(`/${created._id}/attachments/${att._id}`).set(as(TENANT_A));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("ATTACHMENT_REQUIRED");
    expect(s3Log.deletes).toEqual([]);

    // A second file makes the first deletable even while Done.
    const att2 = (await upload(created._id)).body.attachment;
    expect((await request(app).delete(`/${created._id}/attachments/${att._id}`).set(as(TENANT_A))).status).toBe(200);
    // …but the now-last one is protected again until the booking leaves Done.
    expect((await request(app).delete(`/${created._id}/attachments/${att2._id}`).set(as(TENANT_A))).status).toBe(409);
    await request(app).put(`/${created._id}`).set(as(TENANT_A)).send({ status: "PENDING" });
    expect((await request(app).delete(`/${created._id}/attachments/${att2._id}`).set(as(TENANT_A))).status).toBe(200);
  });

  it("a legacy Done flight with no attachment stays editable — ENTERING is gated, not BEING", async () => {
    const legacy = await ManualBooking.create({
      workspaceId: TENANT_A_CUSTOMER_ID, type: "FLIGHT", status: "CONFIRMED", source: "MANUAL",
      travelDate: new Date("2026-01-01"), supplierName: "Old", givenBy: "Old", bookedBy: STAFF_A_ID, createdBy: STAFF_A_ID,
      passengers: [{ name: "Legacy" }], attachments: [],
    });
    const r = await request(app).put(`/${legacy._id}`).set(as(TENANT_A)).send({ notes: "typo fixed" });
    expect(r.status).toBe(200);
    expect(r.body.booking.status).toBe("CONFIRMED");
  });

  it("SBT-sourced rows are exempt — their document lives in the SBT system", async () => {
    const sbt = await ManualBooking.create({
      workspaceId: TENANT_A_CUSTOMER_ID, type: "FLIGHT", status: "PENDING", source: "SBT",
      sourceBookingId: new mongoose.Types.ObjectId(),
      travelDate: new Date("2026-01-01"), supplierName: "TBO", bookedBy: STAFF_A_ID, createdBy: STAFF_A_ID,
      passengers: [{ name: "Sbt" }], attachments: [],
    });
    const r = await request(app).put(`/${sbt._id}`).set(as(TENANT_A)).send({ status: "CONFIRMED" });
    expect(r.status).toBe(200);
    expect(r.body.booking.status).toBe("CONFIRMED");
  });

  it("changing TYPE into a gated one while Done is also an ENTER", async () => {
    const other = (await create(flight({ type: "OTHER", status: "CONFIRMED", itinerary: { description: "d" } }))).body.booking;
    const r = await request(app).put(`/${other._id}`).set(as(TENANT_A)).send({ type: "FLIGHT" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("ATTACHMENT_REQUIRED");
  });
});
