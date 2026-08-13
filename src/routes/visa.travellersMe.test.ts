// Route-level coverage for the self-service identity READS (2026-08-10):
//   GET /api/visa/travellers/me
//   GET /api/visa/travellers/me/candidates
//
// Same in-memory-collection approach as visa.submit.test.ts. The guard in
// services/travellerIdentity.service.ts is NOT mocked — it reads through the
// same faked TravellerProfile collection, so the tier decision under test here
// is the real one, and it is the same code path POST /self-confirm executes.
//
// THE RULE these tests exist to pin: identity is `claimedBy` (a User id), never
// `linkedMemberId`. A profile linked only by linkedMemberId must NOT resolve —
// see the "ignores" test below, which is the one that would fail if anyone
// broadened the resolver later.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { travellers, members, resetStores } = vi.hoisted(() => {
  type Doc = Record<string, any>;

  function matchValue(val: any, cond: any): boolean {
    if (cond && typeof cond === "object" && !(cond instanceof Date) && cond.constructor?.name !== "ObjectId") {
      if ("$ne" in cond) return String(val) !== String(cond.$ne);
      if ("$in" in cond) return (cond.$in as any[]).map(String).includes(String(val));
    }
    if (cond === null) return val === null || val === undefined;
    if (cond === undefined) return true;
    return String(val) === String(cond);
  }

  function matches(rec: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([k, cond]) => matchValue(rec[k], cond));
  }

  function makeCollection() {
    const store = new Map<string, Doc>();
    return {
      store,
      insert(doc: Doc): Doc {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const rec = { ...doc, _id: id };
        store.set(String(id), rec);
        return rec;
      },
      query(filter: Doc = {}): Doc[] {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      clear() {
        store.clear();
      },
    };
  }

  const travellers = makeCollection();
  const members = makeCollection();
  return {
    travellers,
    members,
    resetStores() {
      travellers.clear();
      members.clear();
    },
  };
});

function chainable(getResult: () => any) {
  const obj: any = {
    select: () => obj,
    sort: () => obj,
    limit: () => obj,
    distinct: () => Promise.resolve(getResult()),
    lean: () => Promise.resolve(getResult()),
  };
  return obj;
}

vi.mock("../models/TravellerProfile.js", () => ({
  default: { find: (filter: any) => chainable(() => travellers.query(filter)) },
}));

vi.mock("../models/CustomerMember.js", () => ({
  default: { findOne: (filter: any) => chainable(() => members.query(filter)[0] ?? null) },
}));

import express from "express";
import request from "supertest";
import router from "./visa.js";

const WORKSPACE = new mongoose.Types.ObjectId();
const OTHER_WORKSPACE = new mongoose.Types.ObjectId();
const CUSTOMER_ID = "customer-1";
const ME = new mongoose.Types.ObjectId();
const SOMEONE_ELSE = new mongoose.Types.ObjectId();

function makeApp(opts: { userId?: any; email?: string; withWorkspace?: boolean } = {}) {
  const { userId = ME, email = "priya@acme.com", withWorkspace = true } = opts;
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(userId), email, roles: ["REQUESTER"] };
    if (withWorkspace) {
      req.workspaceId = String(WORKSPACE);
      req.workspaceObjectId = WORKSPACE;
      req.workspace = { _id: WORKSPACE, customerId: CUSTOMER_ID, status: "ACTIVE" };
    } else {
      req.workspace = { customerId: CUSTOMER_ID };
    }
    next();
  });
  app.use("/", router);
  return app;
}

function travellerDoc(overrides: Record<string, any> = {}) {
  return travellers.insert({
    workspaceId: WORKSPACE,
    isActive: true,
    travelerId: "ACM-001",
    firstName: "Priya",
    lastName: "Sharma",
    dob: "1990-04-02",
    email: "",
    nationality: "IN",
    passportNo: "P1234567",
    passportExpiry: "2031-01-01",
    ...overrides,
  });
}

function memberDoc(overrides: Record<string, any> = {}) {
  return members.insert({
    customerId: CUSTOMER_ID,
    email: "priya@acme.com",
    name: "Priya Sharma",
    role: "REQUESTER",
    isActive: true,
    ...overrides,
  });
}

beforeEach(() => resetStores());

/* ═══════════════════════════════════════════════════════════════════════
 * GET /travellers/me — strict resolve on claimedBy.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("GET /travellers/me", () => {
  it("resolves the single profile claimed by the caller, passport UNMASKED (own data)", async () => {
    const mine = travellerDoc({ claimedBy: ME });

    const res = await request(makeApp()).get("/travellers/me");

    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(true);
    expect(res.body.traveller.id).toBe(String(mine._id));
    expect(res.body.traveller.name).toBe("Priya Sharma");
    // The caller's OWN document — full number, not maskTailId's last-4.
    expect(res.body.traveller.passportNo).toBe("P1234567");
  });

  it("IGNORES a profile linked only by linkedMemberId — identity is claimedBy, never linkedMemberId", async () => {
    travellerDoc({ linkedMemberId: new mongoose.Types.ObjectId(), claimedBy: undefined });

    const res = await request(makeApp()).get("/travellers/me");

    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(false);
    expect(res.body.reason).toBe("none");
    expect(res.body.travellers).toEqual([]);
  });

  it("returns resolved:false / none when the caller has claimed nothing", async () => {
    travellerDoc({ claimedBy: SOMEONE_ELSE });

    const res = await request(makeApp()).get("/travellers/me");

    expect(res.body).toMatchObject({ resolved: false, reason: "none", travellers: [] });
  });

  it("NEVER guesses on duplicate claims — returns both for disambiguation", async () => {
    const a = travellerDoc({ claimedBy: ME, travelerId: "ACM-001" });
    const b = travellerDoc({ claimedBy: ME, travelerId: "ACM-002", passportNo: "Z9988776" });

    const res = await request(makeApp()).get("/travellers/me");

    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(false);
    expect(res.body.reason).toBe("duplicate_claims");
    expect(res.body.travellers).toHaveLength(2);
    const ids = res.body.travellers.map((t: any) => t.id);
    expect(ids).toContain(String(a._id));
    expect(ids).toContain(String(b._id));
    expect(res.body.traveller).toBeUndefined();
  });

  it("does not resolve a profile the caller claimed in a DIFFERENT workspace", async () => {
    travellerDoc({ claimedBy: ME, workspaceId: OTHER_WORKSPACE });

    const res = await request(makeApp()).get("/travellers/me");

    expect(res.body.resolved).toBe(false);
    expect(res.body.reason).toBe("none");
  });

  it("ignores a deactivated profile", async () => {
    travellerDoc({ claimedBy: ME, isActive: false });

    const res = await request(makeApp()).get("/travellers/me");
    expect(res.body.resolved).toBe(false);
  });

  it("400s without workspace context rather than reading across tenants", async () => {
    travellerDoc({ claimedBy: ME });

    const res = await request(makeApp({ withWorkspace: false })).get("/travellers/me");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No workspace context");
  });

  it("the projection is an allowlist — no claimedBy / linkedMemberId / createdBy leaks", async () => {
    travellerDoc({
      claimedBy: ME,
      linkedMemberId: new mongoose.Types.ObjectId(),
      createdBy: "someone",
    });

    const res = await request(makeApp()).get("/travellers/me");

    const t = res.body.traveller;
    expect(t.claimedBy).toBeUndefined();
    expect(t.linkedMemberId).toBeUndefined();
    expect(t.createdBy).toBeUndefined();
    // Membership survives only as the derived boolean.
    expect(t.isWorkspaceMember).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * GET /travellers/me/candidates — the tiered offer.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("GET /travellers/me/candidates", () => {
  it("EXACT_EMAIL for an unclaimed profile carrying the caller's email, passport MASKED", async () => {
    memberDoc();
    const t = travellerDoc({ email: "Priya@ACME.com" }); // case-insensitive

    const res = await request(makeApp()).get("/travellers/me/candidates");

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("EXACT_EMAIL");
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0].id).toBe(String(t._id));
    // NOT the caller's own record yet — masked until they prove it's theirs.
    expect(res.body.candidates[0].passportMasked).not.toBe("P1234567");
    expect(res.body.candidates[0].passportNo).toBeUndefined();
  });

  it("does not offer EXACT_EMAIL for a profile already claimed by someone else", async () => {
    memberDoc();
    travellerDoc({ email: "priya@acme.com", claimedBy: SOMEONE_ELSE });

    const res = await request(makeApp()).get("/travellers/me/candidates");

    expect(res.body.tier).toBe("NONE");
    expect(res.body.candidates).toEqual([]);
  });

  it("NAME_UNIQUE for a BLANK-email profile whose name uniquely matches the member", async () => {
    memberDoc({ name: "Priya Sharma" });
    const t = travellerDoc({ email: "" });

    const res = await request(makeApp()).get("/travellers/me/candidates");

    expect(res.body.tier).toBe("NAME_UNIQUE");
    expect(res.body.candidates[0].id).toBe(String(t._id));
  });

  it("matches the member name against the full name too (middle name on one side only)", async () => {
    memberDoc({ name: "Priya Sharma" });
    travellerDoc({ email: "", firstName: "Priya", middleName: "Anne", lastName: "Sharma" });

    const res = await request(makeApp()).get("/travellers/me/candidates");
    expect(res.body.tier).toBe("NAME_UNIQUE");
  });

  it("NONE when the name is ambiguous — two profiles share it", async () => {
    memberDoc({ name: "Priya Sharma" });
    travellerDoc({ email: "" });
    travellerDoc({ email: "", travelerId: "ACM-002" });

    const res = await request(makeApp()).get("/travellers/me/candidates");

    expect(res.body.tier).toBe("NONE");
    expect(res.body.candidates).toEqual([]);
  });

  it("ambiguity counts CLAIMED profiles too — a taken namesake still makes the name ambiguous", async () => {
    memberDoc({ name: "Priya Sharma" });
    travellerDoc({ email: "" }); // the unclaimed one
    travellerDoc({ email: "", travelerId: "ACM-002", claimedBy: SOMEONE_ELSE });

    const res = await request(makeApp()).get("/travellers/me/candidates");

    expect(res.body.tier).toBe("NONE");
  });

  it("EXACT_EMAIL wins over NAME_UNIQUE when both could apply", async () => {
    memberDoc({ name: "Priya Sharma" });
    const emailMatch = travellerDoc({ email: "priya@acme.com", firstName: "P", lastName: "S" });
    travellerDoc({ email: "", travelerId: "ACM-002" }); // name-unique candidate

    const res = await request(makeApp()).get("/travellers/me/candidates");

    expect(res.body.tier).toBe("EXACT_EMAIL");
    expect(res.body.candidates[0].id).toBe(String(emailMatch._id));
  });

  it("NONE when the member row has a blank name and no email match", async () => {
    memberDoc({ name: "" });
    travellerDoc({ email: "" });

    const res = await request(makeApp()).get("/travellers/me/candidates");
    expect(res.body.tier).toBe("NONE");
  });

  it("NONE for a non-member (staff / HOUSE account) rather than an error", async () => {
    travellerDoc({ email: "priya@acme.com" }); // no CustomerMember row seeded

    const res = await request(makeApp()).get("/travellers/me/candidates");

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe("NONE");
  });

  it("NONE for an inactive member", async () => {
    memberDoc({ isActive: false });
    travellerDoc({ email: "priya@acme.com" });

    const res = await request(makeApp()).get("/travellers/me/candidates");
    expect(res.body.tier).toBe("NONE");
  });

  it("400s without workspace context", async () => {
    const res = await request(makeApp({ withWorkspace: false })).get("/travellers/me/candidates");
    expect(res.status).toBe(400);
  });

  it("'me' is not captured as a traveller id by any other route", async () => {
    // Route-order regression guard: both /travellers/me and
    // /travellers/me/candidates must resolve to their own handlers.
    const res = await request(makeApp()).get("/travellers/me");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("resolved");
  });
});
