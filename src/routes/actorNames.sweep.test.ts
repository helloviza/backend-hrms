// apps/backend/src/routes/actorNames.sweep.test.ts
//
// Names, never ids, outside approvals (Part B sweep):
//   - the shared helpers: userNames (one lookup), nameOrUnknown,
//     idsToNamesInText (older notes that stored an id)
//   - Voucher Ops list: createdByName + customerName, not ids
//   - Manual Bookings list: createdByName (the email stays only as a hover)
//   - none of these responses shows a 24-hex id as a displayed value
//
// Real: vouchers + manualBookings routers, User / VoucherExtraction /
// ManualBooking models, in-memory Mongo. Stubbed: auth, workspace and
// permission guards (identity from a header), S3, extraction, automations.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: (req: any, _res: any, next: any) => {
    const id = String(req.headers["x-test-ws"] || "");
    req.workspaceId = id;
    req.workspaceObjectId = new mongoose.Types.ObjectId(id);
    req.workspace = { _id: req.workspaceObjectId, customerId: null };
    next();
  },
  requireResolvedWorkspace: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireFeature.js", () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
  requireAnyFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.permissionScope = "ALL";
    next();
  },
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/s3Upload.js", () => ({ uploadBufferToS3: async () => ({ bucket: "b", key: "k", url: "u" }), deleteObject: async () => {} }));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: async () => "signed://x" }));
vi.mock("../config/aws.js", () => ({ s3: { send: async () => ({}) } }));
vi.mock("../services/location.service.js", () => ({
  resolveActorFromRequest: async () => ({ location: { city: null, rawCity: null, source: "private-ip", confidence: 0, reason: "test" } }),
}));
vi.mock("../services/documentExtraction.service.js", () => ({ enqueueExtraction: async () => null }));
vi.mock("../services/taskAutomation.js", () => ({ triggerTaskAutomation: async () => null }));

const { userNames, nameOrUnknown, idsToNamesInText, UNKNOWN_USER } = await import("../services/actorNames.js");
const { default: vouchersRouter } = await import("./vouchers.js");
const { default: manualBookingsRouter } = await import("./manualBookings.js");
const { HOUSE_WORKSPACE_ID } = await import("../utils/bookingAccess.js");

const app = express();
app.use(express.json());
app.use("/api/vouchers", vouchersRouter);
app.use("/api/manual-bookings", manualBookingsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const HEX = /\b[a-f0-9]{24}\b/i;

const NEEL = { _id: oid(), firstName: "Neel", lastName: "Bhatia", name: "neel", email: "neel@plumtrips.com" };
const GONE_ID = oid(); // a user who no longer exists
const WS = oid();
const CUSTOMER = oid(); // ManualBooking.workspaceId is a Customer._id

const staff = { _id: String(NEEL._id), sub: String(NEEL._id), email: NEEL.email, roles: ["SUPERADMIN"] };
const as = (r: request.Test, ws: any = WS) => r.set("x-test-user", JSON.stringify(staff)).set("x-test-ws", String(ws));

/** THE shared check: no displayed value is a raw 24-hex id. */
function expectNoRawIds(label: string, values: any[]) {
  for (const v of values) expect(String(v ?? ""), `${label}: a raw id is displayed`).not.toMatch(HEX);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("actor-names-sweep-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await col("users").insertOne({ ...NEEL, workspaceId: new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID), roles: ["ADMIN"], status: "ACTIVE", passwordHash: "x" } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: "ACME", name: "acme-ws", companyName: "Acme Corp", status: "ACTIVE" } as any);
});

describe("shared helpers (services/actorNames.ts)", () => {
  it("userNames: ids and emails to profile names in one lookup; unknown keys absent", async () => {
    const names = await userNames([String(NEEL._id), "NEEL@plumtrips.com", String(GONE_ID), "", null]);
    expect(names.get(String(NEEL._id))).toBe("Neel Bhatia");
    expect(names.get("neel@plumtrips.com")).toBe("Neel Bhatia");
    expect(names.has(String(GONE_ID))).toBe(false);
  });

  it("nameOrUnknown never returns an id", () => {
    expect(nameOrUnknown("", String(GONE_ID), null)).toBe(UNKNOWN_USER);
    expect(nameOrUnknown(String(GONE_ID), "Riya Shah")).toBe("Riya Shah");
  });

  it("idsToNamesInText: stored ids in old notes become names; unknown assignees become Unknown user", async () => {
    const notes = [`Assigned to ${NEEL._id}`, `L1 → ${GONE_ID} (manager)`, `[Assigned to ${GONE_ID}]`, "Assigned to Riya Shah"];
    const named = await idsToNamesInText(notes);
    expect(notes.map(named)).toEqual(["Assigned to Neel Bhatia", "L1 → Unknown user (manager)", "[Assigned to Unknown user]", "Assigned to Riya Shah"]);
    expectNoRawIds("notes", notes.map(named));
  });
});

describe("Voucher Ops list (item 1)", () => {
  it("shows the uploader's and the company's names, not ids", async () => {
    await col("voucherextractions").insertMany([
      { workspaceId: WS, customerId: "ACME", createdBy: NEEL._id, docType: "flight", status: "SUCCESS", file: { originalName: "a.pdf" }, createdAt: new Date() },
      { workspaceId: WS, customerId: "ACME", createdBy: GONE_ID, docType: "hotel", status: "SUCCESS", file: { originalName: "b.pdf" }, createdAt: new Date() },
    ] as any[]);
    const r = await as(request(app).get("/api/vouchers"));
    expect(r.status).toBe(200);
    expect(r.body.map((v: any) => [v.createdByName, v.customerName]).sort()).toEqual([
      ["Neel Bhatia", "Acme Corp"],
      ["Unknown user", "Acme Corp"],
    ]);
    expectNoRawIds("voucher list", r.body.flatMap((v: any) => [v.createdByName, v.customerName]));
  });
});

describe("Manual Bookings list (item 2)", () => {
  it('"Created by" is the profile name (email kept only as the hover)', async () => {
    const base = { workspaceId: CUSTOMER, type: "FLIGHT", status: "CONFIRMED", isDemo: false, pricing: { actualPrice: 1, quotedPrice: 2, currency: "INR" }, passengers: [], createdAt: new Date() };
    await col("manualbookings").insertMany([
      { ...base, bookingRef: "MB-1", createdBy: String(NEEL._id), createdByEmail: NEEL.email },
      { ...base, bookingRef: "MB-2", createdBy: String(GONE_ID), createdByEmail: "" },
    ] as any[]);
    const r = await as(request(app).get("/api/manual-bookings"), HOUSE_WORKSPACE_ID);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    const byRef = Object.fromEntries(r.body.docs.map((d: any) => [d.bookingRef, d.createdByName]));
    expect(byRef).toEqual({ "MB-1": "Neel Bhatia", "MB-2": "Unknown user" });
    expectNoRawIds("manual bookings list", Object.values(byRef));
  });
});
