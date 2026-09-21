// HOUSE-staff traveller access — the endpoint pair under
// /api/admin/customers/:customerId/travellers, end to end against REAL
// collections (MongoMemoryServer) with the REAL router, the REAL
// requireHouse + requirePermission middlewares (driven by real UserPermission
// rows) and the REAL TravellerProfile/CustomerWorkspace models. Only
// requireAuth/requireWorkspace are replaced by a header-driven identity
// injector, so one app can play every caller.
//
// What is pinned:
//   - gating: HOUSE + manualBookings:READ passes, SUPERADMIN passes, a tenant
//     user and a HOUSE user without the grant are refused outright;
//   - the Customer._id → CustomerWorkspace._id STRING hop, and that the
//     naive filter (Customer._id as workspaceId) is exactly what returns
//     nothing;
//   - isolation: customer A's list never carries customer B's traveller, the
//     detail read 404s across tenants, and a customer with no workspace gets
//     the "no directory" signal without a workspace being minted;
//   - disclosure: the list is masked (last-4 passport, no PAN/Aadhaar, no
//     write-side ids); the detail is full but still strips pan/aadhaar.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/admin-travellers-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

// Identity comes from a header; the real requireHouse reads req.workspaceId
// and the real requirePermission reads req.user + a UserPermission row.
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

const { default: TravellerProfile } = await import("../models/TravellerProfile.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { requireHouse } = await import("../middleware/requireHouse.js");
const { default: router } = await import("./admin.travellers.js");

const HOUSE_WS = "69679a7628330a58d29f2254"; // requireHouse's PLUMTRIPS_HOUSE_WORKSPACE_ID
const CUSTOMER_A = new mongoose.Types.ObjectId().toHexString();
const CUSTOMER_B = new mongoose.Types.ObjectId().toHexString();
const CUSTOMER_NO_WS = new mongoose.Types.ObjectId().toHexString();
const HOUSE_STAFF = new mongoose.Types.ObjectId().toHexString();
const HOUSE_STAFF_NO_GRANT = new mongoose.Types.ObjectId().toHexString();
const TENANT_ADMIN = new mongoose.Types.ObjectId().toHexString();
const SUPERADMIN = new mongoose.Types.ObjectId().toHexString();

type Caller = { userId: string; workspaceId: string; roles?: string[] };
const asHouse: Caller = { userId: HOUSE_STAFF, workspaceId: HOUSE_WS, roles: ["EMPLOYEE"] };
const asHouseNoGrant: Caller = { userId: HOUSE_STAFF_NO_GRANT, workspaceId: HOUSE_WS, roles: ["EMPLOYEE"] };
const asTenant: Caller = { userId: TENANT_ADMIN, workspaceId: new mongoose.Types.ObjectId().toHexString(), roles: ["TENANT_ADMIN"] };
const asSuper: Caller = { userId: SUPERADMIN, workspaceId: "", roles: ["SUPERADMIN"] };

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  const c: Caller = JSON.parse(String(req.headers["x-caller"] || "{}"));
  req.user = { _id: c.userId, sub: c.userId, email: `${c.userId}@test.local`, roles: c.roles ?? [] };
  req.workspaceId = c.workspaceId || undefined;
  next();
});
// EXACT production mount chain minus the two mocked middlewares.
app.use("/api/admin/customers", requireHouse, router);

const hdr = (c: Caller) => ({ "x-caller": JSON.stringify(c) });
const list = (customerId: string, c: Caller = asHouse, qs = "") =>
  request(app).get(`/api/admin/customers/${customerId}/travellers${qs}`).set(hdr(c));
const detail = (customerId: string, id: string, c: Caller = asHouse) =>
  request(app).get(`/api/admin/customers/${customerId}/travellers/${id}`).set(hdr(c));

let mongod: MongoMemoryServer;
let wsA: any, wsB: any;
let travA1: any, travA2: any, travB1: any, travAInactive: any;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([TravellerProfile.deleteMany({}), CustomerWorkspace.deleteMany({}), UserPermission.deleteMany({})]);

  // customerId is stored as a STRING on customerworkspaces (61/61 prod rows).
  wsA = await CustomerWorkspace.collection.insertOne({ customerId: CUSTOMER_A, status: "ACTIVE", createdAt: new Date() } as any).then((r) => r.insertedId);
  wsB = await CustomerWorkspace.collection.insertOne({ customerId: CUSTOMER_B, status: "ACTIVE", createdAt: new Date() } as any).then((r) => r.insertedId);

  const base = { createdBy: new mongoose.Types.ObjectId(HOUSE_STAFF), source: "MANUAL", isActive: true };
  travA1 = await TravellerProfile.create({ ...base, workspaceId: wsA, travelerId: "ACM-001", title: "Ms", firstName: "Anita", lastName: "Rao", email: "anita@acme.test", mobile: "9876543210", mobileCountryCode: "+91", dob: "1990-04-12", nationality: "IN", passportNo: "P1234567", passportExpiry: "2031-01-01" });
  travA2 = await TravellerProfile.create({ ...base, workspaceId: wsA, travelerId: "ACM-002", firstName: "Vikram", lastName: "Rao", email: "vikram@acme.test" });
  travAInactive = await TravellerProfile.create({ ...base, workspaceId: wsA, travelerId: "ACM-003", firstName: "Gone", lastName: "Person", isActive: false });
  travB1 = await TravellerProfile.create({ ...base, workspaceId: wsB, travelerId: "BTA-001", firstName: "Anita", lastName: "Bose", email: "anita@beta.test", passportNo: "Z9999999" });

  // Real permission rows drive the real requirePermission. userId is a STRING
  // path on UserPermission (raw inserts bypass casting — an ObjectId here would
  // never match the middleware's string lookup). status:"active" because
  // holdsCapability() — the unmask probe — only reads active rows.
  await UserPermission.collection.insertOne({ userId: HOUSE_STAFF, email: `${HOUSE_STAFF}@test.local`, status: "active", modules: { manualBookings: { access: "READ", scope: "ALL" } } } as any);
  await UserPermission.collection.insertOne({ userId: HOUSE_STAFF_NO_GRANT, email: `${HOUSE_STAFF_NO_GRANT}@test.local`, status: "active", modules: { manualBookings: { access: "NONE", scope: "NONE" } } } as any);
  await UserPermission.collection.insertOne({ userId: TENANT_ADMIN, email: `${TENANT_ADMIN}@test.local`, status: "active", modules: { manualBookings: { access: "FULL", scope: "ALL" } } } as any);
});

/* ── gating ─────────────────────────────────────────────────────────── */
describe("gating — HOUSE + manualBookings:READ, or SUPERADMIN", () => {
  it("HOUSE staffer with manualBookings:READ gets the client's travellers (masked)", async () => {
    const r = await list(CUSTOMER_A);
    expect(r.status).toBe(200);
    expect(r.body.hasDirectory).toBe(true);
    expect(r.body.workspaceId).toBe(String(wsA));
    expect(r.body.travellers.map((t: any) => t.travelerId).sort()).toEqual(["ACM-001", "ACM-002"]);
  });

  it("SUPERADMIN passes both gates without a permission row or a workspace", async () => {
    const r = await list(CUSTOMER_A, asSuper);
    expect(r.status).toBe(200);
    expect(r.body.travellers).toHaveLength(2);
  });

  it("a tenant user — even with a manualBookings:FULL grant — is refused at requireHouse (403)", async () => {
    const r = await list(CUSTOMER_A, asTenant);
    expect(r.status).toBe(403);
    expect(r.body.travellers).toBeUndefined();
    expect((await detail(CUSTOMER_A, String(travA1._id), asTenant)).status).toBe(403);
  });

  it("a HOUSE user WITHOUT the manualBookings grant is refused at requirePermission (403)", async () => {
    const r = await list(CUSTOMER_A, asHouseNoGrant);
    expect(r.status).toBe(403);
    expect(r.body.travellers).toBeUndefined();
  });
});

/* ── the ID-space hop ───────────────────────────────────────────────── */
describe("Customer._id → CustomerWorkspace._id hop (string match)", () => {
  it("the naive filter — Customer._id as workspaceId — returns nothing; the hop is what makes it work", async () => {
    const naive = await TravellerProfile.find({ workspaceId: new mongoose.Types.ObjectId(CUSTOMER_A), isActive: true }).lean();
    expect(naive).toHaveLength(0);
    // customerId is STORED as a string. Mongoose casts an ObjectId to the
    // String path so the model-level query matches either way — but anything
    // that bypasses casting (raw driver, $lookup/$expr equality, aggregation)
    // matches only the string form. Hence the route matches with String(...).
    expect(await CustomerWorkspace.collection.findOne({ customerId: new mongoose.Types.ObjectId(CUSTOMER_A) } as any)).toBeNull();
    expect(await CustomerWorkspace.collection.findOne({ customerId: String(CUSTOMER_A) })).not.toBeNull();
    expect(await CustomerWorkspace.findOne({ customerId: String(CUSTOMER_A) }).lean()).not.toBeNull();
    // …and the route resolves through exactly that string hop.
    const r = await list(CUSTOMER_A);
    expect(r.body.workspaceId).toBe(String(wsA));
    expect(r.body.travellers).toHaveLength(2);
  });

  it("a customer with NO workspace → hasDirectory:false, empty list, and NO workspace gets minted", async () => {
    const before = await CustomerWorkspace.countDocuments({});
    const r = await list(CUSTOMER_NO_WS);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, hasDirectory: false, workspaceId: null, travellers: [] });
    expect(r.body.message).toMatch(/no traveller directory/i);
    expect(await CustomerWorkspace.countDocuments({})).toBe(before);
    expect(await CustomerWorkspace.findOne({ customerId: CUSTOMER_NO_WS }).lean()).toBeNull();
    // The detail read 404s rather than resolving anything.
    expect((await detail(CUSTOMER_NO_WS, String(travA1._id))).status).toBe(404);
  });

  it("a malformed customer id is treated as 'no directory', not a 500", async () => {
    const r = await list("not-an-object-id");
    expect(r.status).toBe(200);
    expect(r.body.hasDirectory).toBe(false);
  });
});

/* ── isolation (the security tests) ─────────────────────────────────── */
describe("isolation — one customer's request never carries another's travellers", () => {
  it("customer A's list has no B rows and vice versa, even on a search term both share", async () => {
    // Both workspaces hold an "Anita".
    const a = await list(CUSTOMER_A, asHouse, "?search=anita");
    const b = await list(CUSTOMER_B, asHouse, "?search=anita");
    expect(a.body.travellers.map((t: any) => t.travelerId)).toEqual(["ACM-001"]);
    expect(b.body.travellers.map((t: any) => t.travelerId)).toEqual(["BTA-001"]);
    expect(a.body.travellers.some((t: any) => t._id === String(travB1._id))).toBe(false);
  });

  it("the workspaceId filter is genuinely applied — a bare find would have returned both tenants", async () => {
    // Proof that the plugin does NOT scope for us: a bare query is cross-tenant.
    const bare = await TravellerProfile.find({ isActive: true }).lean();
    expect(bare.map((t: any) => t.travelerId).sort()).toEqual(["ACM-001", "ACM-002", "BTA-001"]);
    // …whereas the route, with no search and a generous limit, returns only A.
    const r = await list(CUSTOMER_A, asHouse, "?limit=100");
    expect(r.body.travellers.map((t: any) => t.travelerId).sort()).toEqual(["ACM-001", "ACM-002"]);
  });

  it("detail: a traveller id from another tenant → 404 (no existence leak)", async () => {
    const cross = await detail(CUSTOMER_A, String(travB1._id));
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual({ error: "Traveller not found" });
    // Same body as a nonexistent id — indistinguishable.
    const missing = await detail(CUSTOMER_A, new mongoose.Types.ObjectId().toHexString());
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(cross.body);
    // And the SAME id is 200 under its own customer.
    expect((await detail(CUSTOMER_B, String(travB1._id))).status).toBe(200);
  });

  it("inactive travellers are excluded from both reads", async () => {
    const r = await list(CUSTOMER_A, asHouse, "?limit=100");
    expect(r.body.travellers.some((t: any) => t.travelerId === "ACM-003")).toBe(false);
    expect((await detail(CUSTOMER_A, String(travAInactive._id))).status).toBe(404);
  });

  it("a client-supplied workspaceId is ignored (body/query/header)", async () => {
    // Trying to steer the list at workspace B while naming customer A.
    const r = await request(app)
      .get(`/api/admin/customers/${CUSTOMER_A}/travellers?workspaceId=${String(wsB)}&limit=100`)
      .set({ ...hdr(asHouse), "x-workspace-id": String(wsB) });
    expect(r.body.workspaceId).toBe(String(wsA));
    expect(r.body.travellers.some((t: any) => t.travelerId === "BTA-001")).toBe(false);
  });
});

/* ── disclosure shape ───────────────────────────────────────────────── */
describe("disclosure — masked list, full-but-gated detail", () => {
  it("list rows carry the SBT typeahead shape with passportMasked only", async () => {
    const r = await list(CUSTOMER_A, asHouse, "?search=ACM-001");
    const row = r.body.travellers[0];
    expect(row).toEqual({
      _id: String(travA1._id), travelerId: "ACM-001", title: "Ms", firstName: "Anita", middleName: null, lastName: "Rao",
      email: "anita@acme.test", mobile: "9876543210", mobileCountryCode: "+91", dob: "1990-04-12", nationality: "IN",
      passportMasked: "****4567",
    });
    expect(row).not.toHaveProperty("passportNo");
    expect(row).not.toHaveProperty("pan");
    expect(row).not.toHaveProperty("createdBy");
    expect(row).not.toHaveProperty("linkedMemberId");
  });

  it("list is capped: default 8, max 100, never unbounded", async () => {
    const base = { workspaceId: wsA, createdBy: new mongoose.Types.ObjectId(HOUSE_STAFF), source: "MANUAL", isActive: true };
    await TravellerProfile.insertMany(Array.from({ length: 120 }, (_, i) => ({ ...base, travelerId: `BULK-${String(i).padStart(3, "0")}`, firstName: `Bulk${i}`, lastName: "Row" })));
    expect((await list(CUSTOMER_A)).body.travellers).toHaveLength(8);
    expect((await list(CUSTOMER_A, asHouse, "?limit=50")).body.travellers).toHaveLength(50);
    expect((await list(CUSTOMER_A, asHouse, "?limit=5000")).body.travellers).toHaveLength(100);
  });

  it("search matches name, email and travelerId (case-insensitive, regex-safe)", async () => {
    expect((await list(CUSTOMER_A, asHouse, "?search=VIKRAM")).body.travellers.map((t: any) => t.travelerId)).toEqual(["ACM-002"]);
    expect((await list(CUSTOMER_A, asHouse, "?search=acme.test&limit=100")).body.travellers).toHaveLength(2);
    expect((await list(CUSTOMER_A, asHouse, "?search=acm-00")).body.travellers).toHaveLength(2);
    expect((await list(CUSTOMER_A, asHouse, "?search=.*")).body.travellers).toHaveLength(0); // literal, not a wildcard
  });

  it("detail returns the full record minus pan/aadhaar — passport MASKED without travellerIdentityPII", async () => {
    const r = await detail(CUSTOMER_A, String(travA1._id));
    expect(r.status).toBe(200);
    expect(r.body.workspaceId).toBe(String(wsA));
    expect(r.body.identityUnmasked).toBe(false);
    expect(r.body.traveller).toMatchObject({
      travelerId: "ACM-001", firstName: "Anita", lastName: "Rao", passportNo: "****4567", passportExpiry: "2031-01-01",
      mobile: "9876543210", email: "anita@acme.test", dob: "1990-04-12",
    });
    expect(JSON.stringify(r.body)).not.toContain("P1234567");
    expect(r.body.traveller).not.toHaveProperty("pan");
    expect(r.body.traveller).not.toHaveProperty("aadhaar");
    expect(r.body.traveller).not.toHaveProperty("__v");
    // Read-only surface: none of the customer router's write affordances.
    expect(r.body).not.toHaveProperty("canManage");
    expect(r.body).not.toHaveProperty("editableFields");
  });

  it("detail UNMASKS the passport for a travellerIdentityPII holder, and for SUPERADMIN", async () => {
    await UserPermission.collection.updateOne({ userId: HOUSE_STAFF }, { $set: { "modules.travellerIdentityPII": { access: "READ", scope: "ALL" } } });
    const r = await detail(CUSTOMER_A, String(travA1._id));
    expect(r.body.identityUnmasked).toBe(true);
    expect(r.body.traveller.passportNo).toBe("P1234567");
    const s = await detail(CUSTOMER_A, String(travA1._id), asSuper);
    expect(s.body.identityUnmasked).toBe(true);
    expect(s.body.traveller.passportNo).toBe("P1234567");
    // The list never carries the full number regardless of the grant.
    const l = await list(CUSTOMER_A, asHouse, "?search=ACM-001");
    expect(l.body.travellers[0].passportMasked).toBe("****4567");
    expect(l.body.travellers[0]).not.toHaveProperty("passportNo");
  });

  it("the router exposes nothing but the two GETs (read-only by construction)", async () => {
    for (const m of ["post", "put", "patch", "delete"] as const) {
      const r = await (request(app) as any)[m](`/api/admin/customers/${CUSTOMER_A}/travellers`).set(hdr(asSuper)).send({});
      expect(r.status).toBe(404);
    }
    expect((await request(app).post(`/api/admin/customers/${CUSTOMER_A}/travellers/auto-capture`).set(hdr(asSuper)).send({})).status).toBe(404);
  });
});
