// OPS → TRAVELLER DOSSIER (2026-08-12) — routes/admin.visa.roster.ts.
//
// The dossier had no route from ops. These three reads add one, and the
// interesting questions are all about AUTHORISATION and TENANCY, not shape:
//
//   · does the ops permission actually open it (it does — this file's gate is
//     the same requirePermission the roster uses), and
//   · can a traveller id alone reach across into another tenant (it must not
//     — every query is scoped by workspaceId AND travellerId), and
//   · is the consent ledger still withheld (it must be — it is gated at edit
//     level inside the owning workspace and ops is further from it, not
//     closer).
//
// Real database: every assertion here is about what a scoped query matches,
// which is precisely what a fake cannot answer.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

// requirePermission is NOT mocked away — the point of this file is that the
// ops grant is what opens the dossier. It reads UserPermission for real.
import router from "./admin.visa.roster.js";
import TravellerProfile from "../models/TravellerProfile.js";
import TravellerTrip from "../models/TravellerTrip.js";
import VisaHolding from "../models/VisaHolding.js";
import User from "../models/User.js";
import { UserPermission } from "../models/UserPermission.js";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const TENANT_A = new mongoose.Types.ObjectId();
const TENANT_B = new mongoose.Types.ObjectId();

let actor: { _id: mongoose.Types.ObjectId; roles: string[] };

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(actor._id), sub: String(actor._id), roles: actor.roles, email: "ops@plumtrips.com" };
    next();
  });
  app.use("/", router);
  return app;
}

async function makeOpsUser(opts: { visaApplication?: string; roles?: string[] } = {}) {
  const u = await User.create({
    name: "Ops Agent",
    email: `ops-${new mongoose.Types.ObjectId()}@plumtrips.com`,
    passwordHash: "x",
    workspaceId: new mongoose.Types.ObjectId(),
    roles: opts.roles ?? ["ADMIN"],
  });
  await UserPermission.create({
    userId: String(u._id),
    email: u.email,
    workspaceId: "ws",
    universe: "STAFF",
    source: "manual",
    status: "active",
    grantedBy: new mongoose.Types.ObjectId(),
    level: { code: "L6", name: "Admin", designation: "Admin" },
    modules: { visaApplication: { access: opts.visaApplication ?? "NONE", scope: "ALL" } },
  } as any);
  return u;
}

async function seedTraveller(workspaceId: mongoose.Types.ObjectId, over: any = {}) {
  return TravellerProfile.create({
    workspaceId,
    travelerId: `T-${new mongoose.Types.ObjectId()}`,
    firstName: "Priya",
    lastName: "Sharma",
    passportNo: "Z1234567",
    createdBy: new mongoose.Types.ObjectId(),
    source: "MANUAL",
    ...over,
  });
}

beforeEach(async () => {
  await Promise.all([
    TravellerProfile.deleteMany({}),
    TravellerTrip.deleteMany({}),
    VisaHolding.deleteMany({}),
    User.deleteMany({}),
    UserPermission.deleteMany({}),
  ]);
  const u = await makeOpsUser({ visaApplication: "READ" });
  actor = { _id: u._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
});

describe("ops dossier — the gate", () => {
  it("OPENS for a non-SuperAdmin staff user holding visaApplication READ", async () => {
    // The whole point: ops authority here is the PERMISSION, not SuperAdmin.
    // Testing this as an L8 would prove nothing, since L8 bypasses the gate.
    const t = await seedTraveller(TENANT_A);
    const res = await request(makeApp()).get(`/workspaces/${TENANT_A}/travellers/${t._id}`);

    expect(res.status).toBe(200);
    expect(res.body.traveller.firstName).toBe("Priya");
  });

  it("REFUSES a staff user with no visaApplication grant", async () => {
    const u = await makeOpsUser({ visaApplication: "NONE" });
    actor = { _id: u._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const t = await seedTraveller(TENANT_A);

    const res = await request(makeApp()).get(`/workspaces/${TENANT_A}/travellers/${t._id}`);
    expect(res.status).toBe(403);
  });

  it("refuses the sub-resources too — the gate is router-level, not per-route", async () => {
    const u = await makeOpsUser({ visaApplication: "NONE" });
    actor = { _id: u._id as mongoose.Types.ObjectId, roles: ["ADMIN"] };
    const t = await seedTraveller(TENANT_A);

    for (const path of ["visa-holdings", "trips"]) {
      const res = await request(makeApp()).get(`/workspaces/${TENANT_A}/travellers/${t._id}/${path}`);
      expect(res.status, path).toBe(403);
    }
  });
});

describe("ops dossier — tenancy", () => {
  it("a traveller id alone cannot reach across tenants — the workspace must match", async () => {
    const theirs = await seedTraveller(TENANT_B, { firstName: "Someone", lastName: "Else" });

    // Correct id, WRONG workspace in the path. Ops is cross-tenant by design,
    // so the protection is that both ids are named and must agree — not that
    // the reader is confined to one tenant.
    const res = await request(makeApp()).get(`/workspaces/${TENANT_A}/travellers/${theirs._id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found in this workspace/i);
  });

  it("reads a traveller in ANY workspace when the pair is correct — ops is cross-tenant", async () => {
    const a = await seedTraveller(TENANT_A, { firstName: "Aye" });
    const b = await seedTraveller(TENANT_B, { firstName: "Bee" });

    const resA = await request(makeApp()).get(`/workspaces/${TENANT_A}/travellers/${a._id}`);
    const resB = await request(makeApp()).get(`/workspaces/${TENANT_B}/travellers/${b._id}`);
    expect(resA.body.traveller.firstName).toBe("Aye");
    expect(resB.body.traveller.firstName).toBe("Bee");
  });

  it("scopes the sub-resources by workspace as well, not by traveller id alone", async () => {
    const theirs = await seedTraveller(TENANT_B);
    await TravellerTrip.create({
      workspaceId: TENANT_B,
      travellerProfileId: theirs._id,
      countryIso2: "FR",
      countryName: "France",
      purpose: "BUSINESS",
      datePrecision: "MONTH",
      tripMonth: "2019-03",
      createdBy: new mongoose.Types.ObjectId(),
    } as any);

    const wrong = await request(makeApp()).get(`/workspaces/${TENANT_A}/travellers/${theirs._id}/trips`);
    expect(wrong.status).toBe(404);

    const right = await request(makeApp()).get(`/workspaces/${TENANT_B}/travellers/${theirs._id}/trips`);
    expect(right.status).toBe(200);
    expect(right.body.trips).toHaveLength(1);
  });

  it("rejects a malformed id rather than casting it into a query", async () => {
    const res = await request(makeApp()).get(`/workspaces/not-an-id/travellers/also-not-an-id`);
    expect(res.status).toBe(400);
  });
});

describe("ops dossier — read-only and masked", () => {
  it("locks every field by returning an empty editableFields allowlist", async () => {
    const t = await seedTraveller(TENANT_A);
    const res = await request(makeApp()).get(`/workspaces/${TENANT_A}/travellers/${t._id}`);

    // This is the mechanism the shared form already uses to lock fields —
    // there is no ops-only read-only mode to get wrong.
    expect(res.body.editableFields).toEqual([]);
    expect(res.body.canManage).toBe(false);
    expect(res.body.isClaimable).toBe(false);
  });

  it("MASKS the passport number, and masks it in the vault echo too", async () => {
    const t = await seedTraveller(TENANT_A, { passportNo: "Z1234567" });
    const res = await request(makeApp()).get(`/workspaces/${TENANT_A}/travellers/${t._id}`);

    // 8 characters in, last 4 kept — the shared maskTailId, same as the roster.
    expect(res.body.traveller.passportNo).toBe("****4567");
    expect(res.body.traveller.passportNo).not.toContain("Z123");
    // The vault feeds the MRZ/mismatch panel; if it echoed the raw number the
    // tab would hand back exactly what the field above hid.
    expect(res.body.passportVault?.passportNo ?? "").not.toBe("Z1234567");
  });

  it("declares both panels non-editable, so the shared panels hide their write affordances", async () => {
    const t = await seedTraveller(TENANT_A);
    const wallet = await request(makeApp()).get(`/workspaces/${TENANT_A}/travellers/${t._id}/visa-holdings`);
    const trips = await request(makeApp()).get(`/workspaces/${TENANT_A}/travellers/${t._id}/trips`);

    expect(wallet.body.capabilities.canEdit).toBe(false);
    expect(wallet.body.capabilities.canAttachStamp).toBe(false);
    expect(trips.body.capabilities.canEdit).toBe(false);
  });

  it("exposes no write verb at all on the dossier paths", async () => {
    const t = await seedTraveller(TENANT_A);
    const base = `/workspaces/${TENANT_A}/travellers/${t._id}`;
    for (const call of [
      request(makeApp()).put(base).send({ firstName: "Hacked" }),
      request(makeApp()).post(`${base}/trips`).send({ countryIso2: "FR" }),
      request(makeApp()).delete(`${base}/visa-holdings/x`),
    ]) {
      const res = await call;
      expect(res.status).toBe(404); // no such route on this router
    }
    // And the record is untouched.
    expect((await TravellerProfile.findById(t._id).lean() as any).firstName).toBe("Priya");
  });
});

describe("ops dossier — the consent ledger stays withheld", () => {
  it("ships no consents route on the ops router", async () => {
    const t = await seedTraveller(TENANT_A);
    const res = await request(makeApp()).get(`/workspaces/${TENANT_A}/travellers/${t._id}/consents`);
    expect(res.status).toBe(404);
  });

  it("says so explicitly in the payload rather than leaving the tab empty", async () => {
    // An empty ledger would read as "this person consented to nothing", which
    // is a different and false statement.
    const t = await seedTraveller(TENANT_A);
    const res = await request(makeApp()).get(`/workspaces/${TENANT_A}/travellers/${t._id}`);

    expect(res.body.consentLedger.available).toBe(false);
    expect(res.body.consentLedger.reason).toMatch(/consent ledger/i);
    expect(res.body.consentLedger).not.toHaveProperty("entries");
  });
});
