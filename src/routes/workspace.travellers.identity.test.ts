// Route-level coverage for the self-service identity WRITES (2026-08-10):
//   POST  /api/workspace/travellers/:id/self-confirm   (the 9-condition guard)
//   PATCH /api/workspace/travellers/:id/link-member    (the admin link)
//
// A SEPARATE file from workspace.travellers.test.ts on purpose: these routes
// need User / UserPermission / logger mocks that file has never had, and
// bolting them onto its shared beforeEach would change the setup underneath 55
// existing tests that have nothing to do with identity.
//
// services/travellerIdentity.service.ts is NOT mocked — the guard runs for real
// against the faked TravellerProfile collection, which is the whole point:
// these tests exercise the nine conditions themselves, not a stub of them.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));

const { travellers, members, users, permissions, resetStores } = vi.hoisted(() => {
  type Doc = Record<string, any>;
  let seq = 0;

  function matchValue(val: any, cond: any): boolean {
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
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
        seq += 1;
        // Real 24-hex ObjectId-shaped ids: PATCH /link-member validates
        // memberId with mongoose.isValidObjectId, so "id-1" would be
        // rejected as malformed before any of the logic under test ran.
        // Minted here rather than via mongoose because vi.hoisted runs
        // before this file's imports.
        const id = doc._id ?? `${seq.toString(16).padStart(24, "a")}`;
        // save() writes back into the store, so a route's mutation is
        // observable to the test exactly as a real save would be.
        const rec: Doc = { ...doc, _id: id };
        rec.save = async () => {
          store.set(String(id), rec);
          return rec;
        };
        rec.toObject = () => {
          const { save, toObject, ...plain } = rec;
          return plain;
        };
        store.set(String(id), rec);
        return rec;
      },
      get(id: any): Doc | null {
        return store.get(String(id)) ?? null;
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
  const users = makeCollection();
  const permissions = makeCollection();
  return {
    travellers,
    members,
    users,
    permissions,
    resetStores() {
      travellers.clear();
      members.clear();
      users.clear();
      permissions.clear();
    },
  };
});

/**
 * Supports BOTH shapes these routes use on the same model:
 *   findOne(...).select(...).lean()  -> a plain record (existence checks)
 *   await findOne(...)               -> the saveable doc
 */
// Every chaining method returns the SAME object, and the object is itself
// thenable — so `.lean()`, `.lean().exec()`, `.select(...).lean()` and a bare
// `await find(...)` all work. Mongoose's own Query behaves this way (lean()
// returns a Query, not a Promise); a lean() that returned a raw Promise breaks
// getActorMember's `.lean().exec()`.
function findOneish(getResult: () => any) {
  const obj: any = {
    select: () => obj,
    sort: () => obj,
    limit: () => obj,
    lean: () => obj,
    exec: () => Promise.resolve(getResult()),
    then: (resolve: any, reject: any) => Promise.resolve(getResult()).then(resolve, reject),
    catch: (reject: any) => Promise.resolve(getResult()).catch(reject),
  };
  return obj;
}

const chainable = findOneish;

vi.mock("../models/TravellerProfile.js", () => ({
  default: {
    find: (filter: any) => chainable(() => travellers.query(filter)),
    findOne: (filter: any) => findOneish(() => travellers.query(filter)[0] ?? null),
    create: async (doc: any) => travellers.insert(doc),
  },
  MEAL_PREFERENCE_CODES: [],
}));

vi.mock("../models/CustomerMember.js", () => ({
  default: { findOne: (filter: any) => findOneish(() => members.query(filter)[0] ?? null) },
}));

vi.mock("../models/User.js", () => ({
  default: { findOne: (filter: any) => findOneish(() => users.query(filter)[0] ?? null) },
}));

vi.mock("../models/UserPermission.js", () => ({
  UserPermission: { findOne: (filter: any) => findOneish(() => permissions.query(filter)[0] ?? null) },
  // The REAL comparator — the ops gate's decision is under test, not stubbed.
  hasAccess: (actual: string, required: string) => {
    const order = ["NONE", "READ", "WRITE", "FULL"];
    return order.indexOf(actual) >= order.indexOf(required);
  },
}));

vi.mock("../models/CustomerWorkspace.js", () => ({
  default: { findById: () => ({ select: () => ({ lean: async () => ({}) }) }) },
}));

vi.mock("../models/Customer.js", () => ({
  default: { findById: () => ({ select: () => ({ lean: async () => ({ legalName: "Acme" }) }) }) },
}));

vi.mock("../services/travellerAutoCapture.js", () => ({
  autoCaptureTravellersFromBooking: vi.fn(),
}));

const logLines: any[] = [];
vi.mock("../utils/logger.js", () => {
  const child = () => ({
    info: (msg: any, meta: any) => logLines.push({ msg, ...meta }),
    warn: () => {},
    error: () => {},
    debug: () => {},
  });
  return { default: { child, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } };
});

import express from "express";
import request from "supertest";
import travellerRouter from "./workspace.travellers.js";

const WORKSPACE_ID = "workspace0000000000000001";
const OTHER_WORKSPACE = "workspace0000000000000002";
const CUSTOMER_ID = "customer-1";
const OTHER_CUSTOMER = "customer-2";
const ME_USER = "user-me";

function makeApp(user: any, opts: { withWorkspace?: boolean } = {}) {
  const { withWorkspace = true } = opts;
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    req.workspace = { customerId: CUSTOMER_ID };
    if (withWorkspace) req.workspaceObjectId = WORKSPACE_ID;
    next();
  });
  app.use("/", travellerRouter);
  return app;
}

/** A plain REQUESTER member session (the self-confirm actor). */
function requesterApp(email = "priya@acme.com") {
  return makeApp({ _id: ME_USER, email, roles: ["REQUESTER"] });
}

function travellerDoc(overrides: Record<string, any> = {}) {
  return travellers.insert({
    workspaceId: WORKSPACE_ID,
    isActive: true,
    firstName: "Priya",
    lastName: "Sharma",
    email: "",
    claimedBy: undefined,
    linkedMemberId: undefined,
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

beforeEach(() => {
  resetStores();
  logLines.length = 0;
});

/* ═══════════════════════════════════════════════════════════════════════
 * POST /:id/self-confirm — every one of the nine conditions.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("POST /:id/self-confirm — the 9-condition guard", () => {
  it("1. refuses SUPERADMIN — this is a member self-service action", async () => {
    memberDoc();
    const t = travellerDoc();

    const app = makeApp({ _id: "root", email: "root@plumtrips.com", roles: ["SUPERADMIN"] });
    const res = await request(app).post(`/${t._id}/self-confirm`).send({ confirm: true });

    expect(res.status).toBe(400);
    expect(travellers.get(t._id).claimedBy).toBeUndefined();
  });

  it("9. refuses without an explicit { confirm: true }", async () => {
    memberDoc();
    const t = travellerDoc();

    const res = await request(requesterApp()).post(`/${t._id}/self-confirm`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("confirm");
    expect(travellers.get(t._id).claimedBy).toBeUndefined();
  });

  it("2. refuses a non-member", async () => {
    const t = travellerDoc(); // no CustomerMember row seeded

    const res = await request(requesterApp()).post(`/${t._id}/self-confirm`).send({ confirm: true });

    expect(res.status).toBe(403);
    expect(travellers.get(t._id).claimedBy).toBeUndefined();
  });

  it("2. refuses an INACTIVE member", async () => {
    memberDoc({ isActive: false });
    const t = travellerDoc();

    const res = await request(requesterApp()).post(`/${t._id}/self-confirm`).send({ confirm: true });
    expect(res.status).toBe(403);
  });

  it("3. 400s with no workspace context rather than reading across tenants", async () => {
    memberDoc();
    const t = travellerDoc();

    const app = makeApp({ _id: ME_USER, email: "priya@acme.com" }, { withWorkspace: false });
    const res = await request(app).post(`/${t._id}/self-confirm`).send({ confirm: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No workspace context");
  });

  it("3. 404s a traveller in a DIFFERENT workspace (session-scoped, never id alone)", async () => {
    memberDoc();
    const t = travellerDoc({ workspaceId: OTHER_WORKSPACE });

    const res = await request(requesterApp()).post(`/${t._id}/self-confirm`).send({ confirm: true });

    expect(res.status).toBe(404);
    expect(travellers.get(t._id).claimedBy).toBeUndefined();
  });

  it("4. 409s when the traveller is already claimed (claimedBy set)", async () => {
    memberDoc();
    const t = travellerDoc({ claimedBy: "someone-else" });

    const res = await request(requesterApp()).post(`/${t._id}/self-confirm`).send({ confirm: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_claimed");
    expect(travellers.get(t._id).claimedBy).toBe("someone-else");
  });

  it("4. 409s when already linked on the OTHER key (linkedMemberId set) — both keys must be free", async () => {
    memberDoc();
    const t = travellerDoc({ linkedMemberId: "another-member" });

    const res = await request(requesterApp()).post(`/${t._id}/self-confirm`).send({ confirm: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_claimed");
  });

  it("5. 403s on a CONTRADICTING email — a name match never overrides an email that exists", async () => {
    memberDoc();
    const t = travellerDoc({ email: "someoneelse@acme.com" });

    const res = await request(requesterApp()).post(`/${t._id}/self-confirm`).send({ confirm: true });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("email_mismatch");
    expect(travellers.get(t._id).claimedBy).toBeUndefined();
  });

  it("6. 404s when the member row has no name to match on", async () => {
    memberDoc({ name: "   " });
    const t = travellerDoc();

    const res = await request(requesterApp()).post(`/${t._id}/self-confirm`).send({ confirm: true });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("no_match");
  });

  it("7. 409s on an AMBIGUOUS name — two profiles share it", async () => {
    memberDoc();
    const t = travellerDoc();
    travellerDoc();

    const res = await request(requesterApp()).post(`/${t._id}/self-confirm`).send({ confirm: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ambiguous_name");
    expect(res.body.error).toContain("workspace leader");
    expect(travellers.get(t._id).claimedBy).toBeUndefined();
  });

  it("7. ambiguity counts CLAIMED profiles too — a taken namesake still blocks", async () => {
    memberDoc();
    const t = travellerDoc();
    travellerDoc({ claimedBy: "someone-else" }); // same name, already taken

    const res = await request(requesterApp()).post(`/${t._id}/self-confirm`).send({ confirm: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ambiguous_name");
  });

  it("8. ANTI-ENUMERATION: a probed id that isn't the re-derived match 404s", async () => {
    memberDoc({ name: "Priya Sharma" });
    travellerDoc(); // the real match for this member
    const other = travellerDoc({ firstName: "Rahul", lastName: "Verma" });

    const res = await request(requesterApp())
      .post(`/${other._id}/self-confirm`)
      .send({ confirm: true });

    // Indistinguishable from "no match at all" — the id reveals nothing.
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("no_match");
    expect(travellers.get(other._id).claimedBy).toBeUndefined();
  });

  it("404s when nothing carries the member's name", async () => {
    memberDoc({ name: "Nobody Here" });
    const t = travellerDoc();

    const res = await request(requesterApp()).post(`/${t._id}/self-confirm`).send({ confirm: true });
    expect(res.status).toBe(404);
  });

  it("ALL NINE HOLD -> links, writing claimedBy (identity) + claimedAt + linkedMemberId", async () => {
    const m = memberDoc();
    const t = travellerDoc();

    const res = await request(requesterApp()).post(`/${t._id}/self-confirm`).send({ confirm: true });

    expect(res.status).toBe(200);
    const saved = travellers.get(t._id);
    expect(String(saved.claimedBy)).toBe(ME_USER); // the identity key
    expect(saved.claimedAt).toBeInstanceOf(Date);
    expect(String(saved.linkedMemberId)).toBe(String(m._id)); // write-access key
  });

  it("emits a structured audit line on success (a log line, not a collection)", async () => {
    memberDoc();
    const t = travellerDoc();

    await request(requesterApp()).post(`/${t._id}/self-confirm`).send({ confirm: true });

    const line = logLines.find((l) => l.msg === "visa.identity.self_confirm.linked");
    expect(line).toBeTruthy();
    expect(line.actorUserId).toBe(ME_USER);
    expect(line.travellerId).toBe(String(t._id));
    expect(line.tier).toBe("NAME_UNIQUE");
    expect(line.action).toBe("self_confirm");
  });

  it("emits an audit line on refusal too, carrying the code", async () => {
    memberDoc();
    const t = travellerDoc({ email: "someoneelse@acme.com" });

    await request(requesterApp()).post(`/${t._id}/self-confirm`).send({ confirm: true });

    const line = logLines.find((l) => l.msg === "visa.identity.self_confirm.refused");
    expect(line?.code).toBe("email_mismatch");
    expect(line?.outcome).toBe("refused");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * PATCH /:id/link-member — the admin link.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("PATCH /:id/link-member", () => {
  function leaderApp() {
    return makeApp({ _id: "leader-user", email: "lead@acme.com", roles: ["WORKSPACE_LEADER"] });
  }

  function seedTargetMember(overrides: Record<string, any> = {}) {
    const target = members.insert({
      customerId: CUSTOMER_ID,
      email: "anita@acme.com",
      name: "Anita Desai",
      role: "REQUESTER",
      isActive: true,
      ...overrides,
    });
    return target;
  }

  it("a WORKSPACE_LEADER can link a traveller to a member", async () => {
    memberDoc({ email: "lead@acme.com", name: "Lead", role: "WORKSPACE_LEADER" });
    const target = seedTargetMember();
    const targetUser = users.insert({ email: "anita@acme.com" });
    const t = travellerDoc();

    const res = await request(leaderApp())
      .patch(`/${t._id}/link-member`)
      .send({ memberId: target._id });

    expect(res.status).toBe(200);
    const saved = travellers.get(t._id);
    expect(String(saved.claimedBy)).toBe(String(targetUser._id));
    expect(String(saved.linkedMemberId)).toBe(String(target._id));
    expect(saved.claimedAt).toBeInstanceOf(Date);
  });

  it("visa OPS (visaApplication WRITE grant) can link without being a leader", async () => {
    memberDoc({ email: "ops@plumtrips.com", name: "Ops", role: "REQUESTER" });
    permissions.insert({
      userId: "ops-user",
      status: "active",
      modules: { visaApplication: { access: "WRITE" } },
    });
    const target = seedTargetMember();
    users.insert({ email: "anita@acme.com" });
    const t = travellerDoc();

    const app = makeApp({ _id: "ops-user", email: "ops@plumtrips.com", roles: ["REQUESTER"] });
    const res = await request(app).patch(`/${t._id}/link-member`).send({ memberId: target._id });

    expect(res.status).toBe(200);
  });

  it("a plain REQUESTER with no grant is refused 403", async () => {
    memberDoc();
    permissions.insert({
      userId: ME_USER,
      status: "active",
      modules: { visaApplication: { access: "READ" } }, // READ is not enough
    });
    const target = seedTargetMember();
    users.insert({ email: "anita@acme.com" });
    const t = travellerDoc();

    const res = await request(requesterApp())
      .patch(`/${t._id}/link-member`)
      .send({ memberId: target._id });

    expect(res.status).toBe(403);
    expect(travellers.get(t._id).claimedBy).toBeUndefined();
  });

  it("CROSS-TENANT: refuses a member belonging to a different customer", async () => {
    memberDoc({ email: "lead@acme.com", role: "WORKSPACE_LEADER" });
    const foreign = seedTargetMember({ customerId: OTHER_CUSTOMER });
    users.insert({ email: "anita@acme.com" });
    const t = travellerDoc();

    const res = await request(leaderApp())
      .patch(`/${t._id}/link-member`)
      .send({ memberId: foreign._id });

    expect(res.status).toBe(404);
    expect(travellers.get(t._id).claimedBy).toBeUndefined();
  });

  it("refuses an inactive member", async () => {
    memberDoc({ email: "lead@acme.com", role: "WORKSPACE_LEADER" });
    const target = seedTargetMember({ isActive: false });
    users.insert({ email: "anita@acme.com" });
    const t = travellerDoc();

    const res = await request(leaderApp())
      .patch(`/${t._id}/link-member`)
      .send({ memberId: target._id });

    expect(res.status).toBe(404);
  });

  it("404s a traveller from another workspace", async () => {
    memberDoc({ email: "lead@acme.com", role: "WORKSPACE_LEADER" });
    const target = seedTargetMember();
    users.insert({ email: "anita@acme.com" });
    const t = travellerDoc({ workspaceId: OTHER_WORKSPACE });

    const res = await request(leaderApp())
      .patch(`/${t._id}/link-member`)
      .send({ memberId: target._id });

    expect(res.status).toBe(404);
  });

  it("NO-LOGIN member is REFUSED, never auto-provisioned", async () => {
    memberDoc({ email: "lead@acme.com", role: "WORKSPACE_LEADER" });
    const target = seedTargetMember(); // deliberately NO User row
    const t = travellerDoc();

    const res = await request(leaderApp())
      .patch(`/${t._id}/link-member`)
      .send({ memberId: target._id });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("member_has_no_login");
    expect(res.body.error).toContain("invite");
    // Nothing written, and no account conjured into existence.
    expect(travellers.get(t._id).claimedBy).toBeUndefined();
    expect(users.query({ email: "anita@acme.com" })).toHaveLength(0);
  });

  it("409s when the traveller is already claimed by someone else", async () => {
    memberDoc({ email: "lead@acme.com", role: "WORKSPACE_LEADER" });
    const target = seedTargetMember();
    users.insert({ email: "anita@acme.com" });
    const t = travellerDoc({ claimedBy: "a-different-user" });

    const res = await request(leaderApp())
      .patch(`/${t._id}/link-member`)
      .send({ memberId: target._id });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_linked");
    expect(String(travellers.get(t._id).claimedBy)).toBe("a-different-user");
  });

  it("reassign:true is the ONLY way to move an existing link", async () => {
    memberDoc({ email: "lead@acme.com", role: "WORKSPACE_LEADER" });
    const target = seedTargetMember();
    const targetUser = users.insert({ email: "anita@acme.com" });
    const t = travellerDoc({ claimedBy: "a-different-user" });

    const res = await request(leaderApp())
      .patch(`/${t._id}/link-member`)
      .send({ memberId: target._id, reassign: true });

    expect(res.status).toBe(200);
    expect(String(travellers.get(t._id).claimedBy)).toBe(String(targetUser._id));

    const line = logLines.find((l) => l.msg === "visa.identity.link_member.linked");
    expect(line.reassigned).toBe(true);
    expect(line.previousClaimedBy).toBe("a-different-user");
  });

  it("re-linking to the SAME person is not a reassign and needs no flag", async () => {
    memberDoc({ email: "lead@acme.com", role: "WORKSPACE_LEADER" });
    const target = seedTargetMember();
    const targetUser = users.insert({ email: "anita@acme.com" });
    const t = travellerDoc({ claimedBy: undefined, linkedMemberId: target._id });

    const res = await request(leaderApp())
      .patch(`/${t._id}/link-member`)
      .send({ memberId: target._id });

    expect(res.status).toBe(200);
    expect(String(travellers.get(t._id).claimedBy)).toBe(String(targetUser._id));
  });

  it("400s without a memberId", async () => {
    memberDoc({ email: "lead@acme.com", role: "WORKSPACE_LEADER" });
    const t = travellerDoc();

    const res = await request(leaderApp()).patch(`/${t._id}/link-member`).send({});
    expect(res.status).toBe(400);
  });

  it("emits a structured audit line naming which half of the gate authorised it", async () => {
    memberDoc({ email: "lead@acme.com", role: "WORKSPACE_LEADER" });
    const target = seedTargetMember();
    users.insert({ email: "anita@acme.com" });
    const t = travellerDoc();

    await request(leaderApp()).patch(`/${t._id}/link-member`).send({ memberId: target._id });

    const line = logLines.find((l) => l.msg === "visa.identity.link_member.linked");
    expect(line.via).toBe("workspace_leader");
    expect(line.travellerId).toBe(String(t._id));
    expect(line.targetMemberId).toBe(String(target._id));
    expect(line.action).toBe("link_member");
  });
});
