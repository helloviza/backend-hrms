// travellerIdentityPII — the unmask grant for identity-document numbers on
// the OPS / cross-tenant traveller surfaces (models/UserPermission.ts).
//
// One file, three routers, one rule — so the three cannot drift:
//   · routes/admin.travellers.ts (Client Travellers foundation)
//   · routes/admin.visa.roster.ts (visa roster dossier / vault / wallet)
//   · routes/workspace.travellers.ts (the CUSTOMER's own portal — NOT
//     governed by this grant, and this file proves it stays unmasked)
//
// Real database, real routers, real requireHouse / requirePermission driven
// by real UserPermission rows. Only requireAuth / requireWorkspace are
// replaced by a header-driven identity injector; S3 presign is stubbed.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/traveller-identity-pii-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/s3Presign.js", () => ({
  presignGetObject: async ({ key }: any) => `https://s3.test/${key}?signed=1`,
}));

const { default: TravellerProfile } = await import("../models/TravellerProfile.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: CustomerMember } = await import("../models/CustomerMember.js");
const { default: VisaHolding } = await import("../models/VisaHolding.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { LEVEL_TEMPLATES } = await import("../config/levelTemplates.js");
const { requireHouse } = await import("../middleware/requireHouse.js");
const { default: adminTravellersRouter } = await import("./admin.travellers.js");
const { default: rosterRouter } = await import("./admin.visa.roster.js");
const { default: workspaceTravellersRouter } = await import("./workspace.travellers.js");

const HOUSE_WS = "69679a7628330a58d29f2254";
const CUSTOMER_A = new mongoose.Types.ObjectId().toHexString();
const PASSPORT = "Z1234567";
const VISA_NO = "V998877665";

type Caller = { userId: string; workspaceId?: string; customerId?: string | null; workspaceObjectId?: string; roles?: string[]; email?: string };

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  const c: Caller = JSON.parse(String(req.headers["x-caller"] || "{}"));
  req.user = { _id: c.userId, sub: c.userId, email: c.email ?? `${c.userId}@test.local`, roles: c.roles ?? [] };
  req.workspaceId = c.workspaceId || undefined;
  req.workspace = { customerId: c.customerId ?? null };
  req.workspaceObjectId = c.workspaceObjectId ? new mongoose.Types.ObjectId(c.workspaceObjectId) : undefined;
  next();
});
app.use("/api/admin/customers", requireHouse, adminTravellersRouter);
app.use("/api/admin/visa", rosterRouter);
app.use("/api/workspace/travellers", workspaceTravellersRouter);
const hdr = (c: Caller) => ({ "x-caller": JSON.stringify(c) });

let mongod: MongoMemoryServer;
let wsA: mongoose.Types.ObjectId;
let traveller: any;
let holder: string, nonHolder: string, member: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

async function grant(userId: string, modules: Record<string, { access: string; scope: string }>) {
  await UserPermission.collection.insertOne({
    userId, email: `${userId}@test.local`, workspaceId: HOUSE_WS, universe: "STAFF", source: "manual", status: "active",
    level: { code: "L6", name: "Admin", designation: "Admin" }, modules,
  } as any);
}

beforeEach(async () => {
  await Promise.all([TravellerProfile.deleteMany({}), CustomerWorkspace.deleteMany({}), CustomerMember.deleteMany({}), VisaHolding.deleteMany({}), UserPermission.deleteMany({})]);
  wsA = (await CustomerWorkspace.collection.insertOne({ customerId: CUSTOMER_A, status: "ACTIVE", createdAt: new Date() } as any)).insertedId as any;
  traveller = await TravellerProfile.create({
    workspaceId: wsA, travelerId: "ACM-001", firstName: "Anita", lastName: "Rao", email: "anita@acme.test",
    gender: "F", dob: "1990-04-12", nationality: "IN", passportNo: PASSPORT, passportExpiry: "2031-01-01", passportIssueCountry: "IN",
    createdBy: new mongoose.Types.ObjectId(), source: "MANUAL", isActive: true,
  });
  await VisaHolding.create({
    workspaceId: wsA, travellerProfileId: traveller._id, countryIso2: "GB", countryName: "United Kingdom", visaType: "Standard Visitor",
    visaNumber: VISA_NO, entryType: "MULTIPLE", issueDate: "2026-01-01", expiryDate: "2028-01-01", source: "MANUAL", createdBy: new mongoose.Types.ObjectId(),
  } as any);

  holder = new mongoose.Types.ObjectId().toHexString();
  nonHolder = new mongoose.Types.ObjectId().toHexString();
  member = new mongoose.Types.ObjectId().toHexString();
  // Both ops users hold the door-opening grants; only one holds the unmask.
  await grant(nonHolder, { manualBookings: { access: "READ", scope: "ALL" }, visaApplication: { access: "READ", scope: "ALL" } });
  await grant(holder, { manualBookings: { access: "READ", scope: "ALL" }, visaApplication: { access: "READ", scope: "ALL" }, travellerIdentityPII: { access: "READ", scope: "ALL" } });
  // A customer-side member of tenant A (WORKSPACE_LEADER), with NO ops grants at all.
  await CustomerMember.collection.insertOne({ customerId: CUSTOMER_A, email: `${member}@test.local`, name: "Meera Iyer", role: "WORKSPACE_LEADER", isActive: true, travelerId: "" } as any);
});

const asNonHolder: Caller = { userId: nonHolder as any, workspaceId: HOUSE_WS, roles: ["EMPLOYEE"] };
const asHolder: Caller = { userId: holder as any, workspaceId: HOUSE_WS, roles: ["EMPLOYEE"] };
const asSuper: Caller = { userId: new mongoose.Types.ObjectId().toHexString(), workspaceId: "", roles: ["SUPERADMIN"] };
// Callers are re-minted in beforeEach; read them lazily.
const NH = () => ({ ...asNonHolder, userId: nonHolder });
const H = () => ({ ...asHolder, userId: holder });

describe("model — the key exists and no level confers it", () => {
  it("defaults to NONE and every level template carries NONE", async () => {
    const fresh = new UserPermission({ userId: "u", email: "u@x", workspaceId: "w", universe: "STAFF", source: "manual", level: { code: "L1", name: "", designation: "" } } as any);
    const m = (fresh.modules as any).travellerIdentityPII;
    expect({ access: m.access, scope: m.scope }).toEqual({ access: "NONE", scope: "NONE" });
    for (const [code, tpl] of Object.entries(LEVEL_TEMPLATES as any)) {
      expect((tpl as any).travellerIdentityPII, code).toEqual({ access: "NONE", scope: "NONE" });
    }
  });
});

describe("Client Travellers foundation (admin.travellers.ts)", () => {
  it("list is masked for everyone; detail masks WITHOUT the grant and says so", async () => {
    const list = await request(app).get(`/api/admin/customers/${CUSTOMER_A}/travellers`).set(hdr(NH()));
    expect(list.body.travellers[0].passportMasked).toBe("****4567");
    expect(list.body.travellers[0]).not.toHaveProperty("passportNo");
    const d = await request(app).get(`/api/admin/customers/${CUSTOMER_A}/travellers/${traveller._id}`).set(hdr(NH()));
    expect(d.status).toBe(200);
    expect(d.body.identityUnmasked).toBe(false);
    expect(d.body.traveller.passportNo).toBe("****4567");
    expect(JSON.stringify(d.body)).not.toContain(PASSPORT);
  });

  it("detail unmasks WITH the grant, and for SUPERADMIN without it", async () => {
    const d = await request(app).get(`/api/admin/customers/${CUSTOMER_A}/travellers/${traveller._id}`).set(hdr(H()));
    expect(d.body.identityUnmasked).toBe(true);
    expect(d.body.traveller.passportNo).toBe(PASSPORT);
    const s = await request(app).get(`/api/admin/customers/${CUSTOMER_A}/travellers/${traveller._id}`).set(hdr(asSuper));
    expect(s.body.identityUnmasked).toBe(true);
    expect(s.body.traveller.passportNo).toBe(PASSPORT);
  });
});

describe("visa roster (admin.visa.roster.ts)", () => {
  const base = () => `/api/admin/visa/workspaces/${wsA}/travellers/${traveller._id}`;

  it("WITHOUT the grant: dossier, vault (MRZ line 2 / scan / comparison) and wallet visa numbers are masked", async () => {
    const d = await request(app).get(base()).set(hdr(NH()));
    expect(d.status).toBe(200);
    expect(d.body.identityUnmasked).toBe(false);
    expect(d.body.traveller.passportNo).toBe("****4567");
    expect(JSON.stringify(d.body)).not.toContain(PASSPORT);
    // MRZ line 2 opens with the document number field; the number is gone
    // but the line keeps its shape (the last 4 of the field, then the rest).
    const line2: string | undefined = d.body.passportVault?.mrz?.line2;
    expect(line2, "MRZ must compose for this fixture so line-2 masking is exercised").toBeDefined();
    expect(line2!.startsWith("*****")).toBe(true);
    expect(line2).not.toContain(PASSPORT);
    expect(line2).toHaveLength(44);
    const w = await request(app).get(`${base()}/visa-holdings`).set(hdr(NH()));
    expect(w.body.identityUnmasked).toBe(false);
    expect(w.body.holdings[0].visaNumber).toBe("******7665");
    expect(JSON.stringify(w.body)).not.toContain(VISA_NO);
    const roster = await request(app).get(`/api/admin/visa/workspaces/${wsA}/roster`).set(hdr(NH()));
    expect(roster.body.travellers?.[0]?.passportMasked).toBe("****4567");
    expect(roster.body.travellers?.[0]).not.toHaveProperty("passportNo");
  });

  it("WITH the grant: full passport in dossier + vault, full visa numbers, full number beside the masked one on the roster", async () => {
    const d = await request(app).get(base()).set(hdr(H()));
    expect(d.body.identityUnmasked).toBe(true);
    expect(d.body.traveller.passportNo).toBe(PASSPORT);
    const line2: string | undefined = d.body.passportVault?.mrz?.line2;
    expect(line2).toBeDefined();
    expect(line2!.startsWith(PASSPORT)).toBe(true);
    const w = await request(app).get(`${base()}/visa-holdings`).set(hdr(H()));
    expect(w.body.holdings[0].visaNumber).toBe(VISA_NO);
    const roster = await request(app).get(`/api/admin/visa/workspaces/${wsA}/roster`).set(hdr(H()));
    expect(roster.body.travellers?.[0]?.passportMasked).toBe("****4567");
    expect(roster.body.travellers?.[0]?.passportNo).toBe(PASSPORT);
  });

  it("SUPERADMIN sees full without the grant", async () => {
    const d = await request(app).get(base()).set(hdr(asSuper));
    expect(d.body.traveller.passportNo).toBe(PASSPORT);
    const w = await request(app).get(`${base()}/visa-holdings`).set(hdr(asSuper));
    expect(w.body.holdings[0].visaNumber).toBe(VISA_NO);
  });
});

describe("customer portal (workspace.travellers.ts) — NOT governed by the grant", () => {
  it("an active member of the OWN workspace, holding no ops grant at all, still reads the full passport number", async () => {
    const asMember: Caller = { userId: member, email: `${member}@test.local`, customerId: CUSTOMER_A, workspaceObjectId: String(wsA), roles: ["CUSTOMER"] };
    const d = await request(app).get(`/api/workspace/travellers/${traveller._id}`).set(hdr(asMember));
    expect(d.status).toBe(200);
    expect(d.body.traveller.passportNo).toBe(PASSPORT);
    expect(await UserPermission.countDocuments({ userId: member })).toBe(0);
    // …and the customer list stays last-4, as it always was.
    const list = await request(app).get(`/api/workspace/travellers`).set(hdr(asMember));
    expect(list.body.travellers[0].passportMasked).toBe("****4567");
    expect(list.body.travellers[0]).not.toHaveProperty("passportNo");
  });
});
