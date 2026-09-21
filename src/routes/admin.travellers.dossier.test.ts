// The booking-gated dossier twins under
// /api/admin/customers/:customerId/travellers/:id/{dossier,visa-holdings,
// trips,documents,documents/:documentId/url} — routes/admin.travellers.ts.
//
// Same questions the roster dossier tests ask, plus the two things that
// are different here: the tenant comes from the Customer._id STRING hop,
// and the gate is HOUSE + manualBookings:READ rather than visaApplication.
// Real database, real router, real requireHouse / requirePermission driven
// by real UserPermission rows; only the S3 presign is stubbed.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/admin-travellers-dossier-test";
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
  presignGetObject: async ({ key, view }: any) => `https://s3.test/${key}?signed=1&view=${view ? 1 : 0}`,
}));

const { default: TravellerProfile } = await import("../models/TravellerProfile.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: TravellerDocument } = await import("../models/TravellerDocument.js");
const { default: TravellerTrip } = await import("../models/TravellerTrip.js");
const { default: VisaHolding } = await import("../models/VisaHolding.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { requireHouse } = await import("../middleware/requireHouse.js");
const { default: router } = await import("./admin.travellers.js");

const HOUSE_WS = "69679a7628330a58d29f2254";
const CUSTOMER_A = new mongoose.Types.ObjectId().toHexString();
const CUSTOMER_B = new mongoose.Types.ObjectId().toHexString();
const CUSTOMER_NO_WS = new mongoose.Types.ObjectId().toHexString();

type Caller = { userId: string; workspaceId: string; roles?: string[] };
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  const c: Caller = JSON.parse(String(req.headers["x-caller"] || "{}"));
  req.user = { _id: c.userId, sub: c.userId, email: `${c.userId}@test.local`, roles: c.roles ?? [] };
  req.workspaceId = c.workspaceId || undefined;
  next();
});
app.use("/api/admin/customers", requireHouse, router);
const hdr = (c: Caller) => ({ "x-caller": JSON.stringify(c) });

let mongod: MongoMemoryServer;
let wsA: any, wsB: any, tA: any, tB: any, docA: any;
let ops: Caller, opsUnmask: Caller, tenant: Caller;
const sup: Caller = { userId: new mongoose.Types.ObjectId().toHexString(), workspaceId: "", roles: ["SUPERADMIN"] };
const base = (customerId = CUSTOMER_A, id = String(tA._id)) => `/api/admin/customers/${customerId}/travellers/${id}`;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([TravellerProfile.deleteMany({}), CustomerWorkspace.deleteMany({}), TravellerDocument.deleteMany({}), TravellerTrip.deleteMany({}), VisaHolding.deleteMany({}), UserPermission.deleteMany({})]);
  wsA = (await CustomerWorkspace.collection.insertOne({ customerId: CUSTOMER_A, status: "ACTIVE" } as any)).insertedId;
  wsB = (await CustomerWorkspace.collection.insertOne({ customerId: CUSTOMER_B, status: "ACTIVE" } as any)).insertedId;
  const base = { createdBy: new mongoose.Types.ObjectId(), source: "MANUAL", isActive: true };
  tA = await TravellerProfile.create({ ...base, workspaceId: wsA, travelerId: "ACM-001", firstName: "Anita", lastName: "Rao", gender: "F", dob: "1990-04-12", nationality: "IN", passportNo: "Z1234567", passportExpiry: "2031-01-01", passportIssueCountry: "IN" });
  tB = await TravellerProfile.create({ ...base, workspaceId: wsB, travelerId: "BTA-001", firstName: "Bimal", lastName: "Sen", passportNo: "Q7654321" });
  docA = await TravellerDocument.create({ workspaceId: wsA, travellerProfileId: tA._id, docKind: "PASSPORT_FRONT", version: 1, s3Key: `traveller-profiles/${wsA}/${tA._id}/passport.pdf`, originalFilename: "passport.pdf", mimeType: "application/pdf", sizeBytes: 100, uploadedByUserId: new mongoose.Types.ObjectId() } as any);
  await TravellerDocument.create({ workspaceId: wsA, travellerProfileId: tA._id, docKind: "PASSPORT_FRONT", version: 2, s3Key: `traveller-profiles/${wsA}/${tA._id}/passport-v2.pdf`, originalFilename: "passport-v2.pdf", mimeType: "application/pdf", sizeBytes: 120, uploadedByUserId: new mongoose.Types.ObjectId() } as any);
  await VisaHolding.create({ workspaceId: wsA, travellerProfileId: tA._id, countryIso2: "GB", countryName: "United Kingdom", visaNumber: "V998877665", entryType: "MULTIPLE", issueDate: "2026-01-01", expiryDate: "2028-01-01", source: "MANUAL", createdBy: new mongoose.Types.ObjectId() } as any);
  await TravellerTrip.create({ workspaceId: wsA, travellerProfileId: tA._id, countryIso2: "FR", countryName: "France", purpose: "BUSINESS", datePrecision: "MONTH", tripMonth: "2025-06", createdBy: new mongoose.Types.ObjectId() } as any).catch(() => null);

  const mk = async (modules: any, roles = ["EMPLOYEE"], workspaceId = HOUSE_WS): Promise<Caller> => {
    const userId = new mongoose.Types.ObjectId().toHexString();
    await UserPermission.collection.insertOne({ userId, email: `${userId}@test.local`, workspaceId, universe: "STAFF", source: "manual", status: "active", level: { code: "L4", name: "Ops", designation: "Ops" }, modules } as any);
    return { userId, workspaceId, roles };
  };
  ops = await mk({ manualBookings: { access: "READ", scope: "ALL" } });
  opsUnmask = await mk({ manualBookings: { access: "READ", scope: "ALL" }, travellerIdentityPII: { access: "READ", scope: "ALL" } });
  tenant = await mk({ manualBookings: { access: "FULL", scope: "ALL" }, visaApplication: { access: "FULL", scope: "ALL" } }, ["TENANT_ADMIN"], new mongoose.Types.ObjectId().toHexString());
});

describe("gating — HOUSE + manualBookings:READ; no visa grant needed", () => {
  it("HOUSE ops gets all four reads; SUPERADMIN too", async () => {
    for (const c of [ops, sup]) {
      for (const p of ["/dossier", "/visa-holdings", "/trips", "/documents"]) {
        const r = await request(app).get(base() + p).set(hdr(c));
        expect(r.status, `${p} for ${c.roles}`).toBe(200);
      }
    }
  });
  it("a tenant user — even with manualBookings:FULL + visaApplication:FULL — is refused at requireHouse", async () => {
    for (const p of ["/dossier", "/visa-holdings", "/trips", "/documents", `/documents/${docA._id}/url`]) {
      expect((await request(app).get(base() + p).set(hdr(tenant))).status, p).toBe(403);
    }
  });
});

describe("read-only signals — what locks the shared components", () => {
  it("dossier: editableFields [], canManage false, consent ledger withheld with a reason, dossier helpers present", async () => {
    const r = await request(app).get(base() + "/dossier").set(hdr(ops));
    expect(r.body).toMatchObject({ ok: true, canManage: false, editableFields: [], isClaimable: false });
    expect(r.body.consentLedger.available).toBe(false);
    expect(r.body.consentLedger.reason).toMatch(/consent ledger/i);
    expect(r.body.dossierHealth).toBeDefined();
    expect(r.body.header).toBeDefined();
    expect(r.body.passportVault?.mrz).toBeDefined();
    expect(r.body.traveller.travelerId).toBe("ACM-001");
  });
  it("wallet + trips declare canEdit false; documents declare uploadableKinds [] and list only the latest version per kind", async () => {
    const w = await request(app).get(base() + "/visa-holdings").set(hdr(ops));
    expect(w.body.capabilities).toEqual({ canEdit: false, canAttachStamp: false, stampReason: "Read-only from the ops console." });
    expect(w.body.holdings).toHaveLength(1);
    const t = await request(app).get(base() + "/trips").set(hdr(ops));
    expect(t.body.capabilities).toEqual({ canEdit: false });
    const d = await request(app).get(base() + "/documents").set(hdr(ops));
    expect(d.body.capabilities).toEqual({ uploadableKinds: [] });
    expect(d.body.documents).toHaveLength(1);
    expect(d.body.documents[0].version).toBe(2);
    expect(d.body.documents[0]).not.toHaveProperty("s3Key");
  });
  it("documents View presigns inline; upload / replace / delete do not exist under this prefix (404)", async () => {
    const list = await request(app).get(base() + "/documents").set(hdr(ops));
    const id = list.body.documents[0]._id;
    const u = await request(app).get(base() + `/documents/${id}/url`).set(hdr(ops));
    expect(u.status).toBe(200);
    expect(u.body.url).toMatch(/passport-v2\.pdf\?signed=1&view=1$/);
    expect((await request(app).post(base() + "/documents").set(hdr(sup)).send({})).status).toBe(404);
    expect((await request(app).delete(base() + `/documents/${id}`).set(hdr(sup))).status).toBe(404);
    expect((await request(app).put(base() + "/dossier").set(hdr(sup)).send({ firstName: "Hacked" })).status).toBe(404);
    expect((await request(app).post(base() + "/visa-holdings").set(hdr(sup)).send({})).status).toBe(404);
    expect((await request(app).post(base() + "/trips").set(hdr(sup)).send({})).status).toBe(404);
  });
});

describe("tenancy — the Customer._id hop and both-ids scoping", () => {
  it("customer B's traveller id under customer A → 404 on every read; the same id under B → 200", async () => {
    for (const p of ["/dossier", "/visa-holdings", "/trips", "/documents"]) {
      expect((await request(app).get(base(CUSTOMER_A, String(tB._id)) + p).set(hdr(ops))).status, p).toBe(404);
      expect((await request(app).get(base(CUSTOMER_B, String(tB._id)) + p).set(hdr(ops))).status, p).toBe(200);
    }
  });
  it("a customer with no workspace → 404 (nothing minted); a document id from another profile → 404", async () => {
    const before = await CustomerWorkspace.countDocuments({});
    expect((await request(app).get(base(CUSTOMER_NO_WS, String(tA._id)) + "/dossier").set(hdr(ops))).status).toBe(404);
    expect(await CustomerWorkspace.countDocuments({})).toBe(before);
    expect((await request(app).get(base(CUSTOMER_B, String(tB._id)) + `/documents/${docA._id}/url`).set(hdr(ops))).status).toBe(404);
  });
});

describe("masking — travellerIdentityPII, same rule as the foundation and the roster", () => {
  it("without the grant: passport masked in dossier + vault (MRZ line 2), visa number masked", async () => {
    const d = await request(app).get(base() + "/dossier").set(hdr(ops));
    expect(d.body.identityUnmasked).toBe(false);
    expect(d.body.traveller.passportNo).toBe("****4567");
    expect(d.body.passportVault.mrz.line2).toBeDefined();
    expect(d.body.passportVault.mrz.line2.startsWith("*****")).toBe(true);
    expect(JSON.stringify(d.body)).not.toContain("Z1234567");
    const w = await request(app).get(base() + "/visa-holdings").set(hdr(ops));
    expect(w.body.holdings[0].visaNumber).toBe("******7665");
  });
  it("with the grant, and for SUPERADMIN: full", async () => {
    for (const c of [opsUnmask, sup]) {
      const d = await request(app).get(base() + "/dossier").set(hdr(c));
      expect(d.body.identityUnmasked).toBe(true);
      expect(d.body.traveller.passportNo).toBe("Z1234567");
      expect(d.body.passportVault.mrz.line2.startsWith("Z1234567")).toBe(true);
      const w = await request(app).get(base() + "/visa-holdings").set(hdr(c));
      expect(w.body.holdings[0].visaNumber).toBe("V998877665");
    }
  });
});
