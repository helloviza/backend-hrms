// Phase 1 coverage for workspace.travellers.ts: the RBAC decision matrix
// (ensureTravellerWriteAccess, tested directly — pure function) plus
// route-level checks for the things a unit test can't cover: ownership
// bound in the Mongo filter itself (never trusted from the URL param),
// the list/search response never leaking a raw passportNo, and soft
// delete never hard-deleting. requireAuth/requireWorkspace are mocked as
// passthroughs — the harness injects req.user/req.workspace/
// req.workspaceObjectId directly, same approach as
// invoices.workspaceAccess.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));

const tpFindMock = vi.fn();
const tpFindOneMock = vi.fn();
const tpCreateMock = vi.fn();

function chainable(value: any) {
  const obj: any = {
    select: () => obj,
    sort: () => obj,
    limit: () => obj,
    lean: () => Promise.resolve(value),
    exec: () => Promise.resolve(value),
    then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject),
  };
  return obj;
}

function findOneResult(value: any) {
  const obj: any = {
    // .select() joined the chain on 2026-08-11 — the self-only create gate
    // (ensureRequesterMayCreateSelf) reads findOne(...).select("_id").lean().
    // Returns `obj` so any order of select/lean/exec resolves, matching what
    // a real Mongoose Query does.
    select: () => obj,
    lean: () => Promise.resolve(value),
    exec: () => Promise.resolve(value),
    then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject),
    catch: (reject: any) => Promise.resolve(value).catch(reject),
  };
  return obj;
}

vi.mock("../models/TravellerProfile.js", () => ({
  default: {
    find: (...args: any[]) => chainable(tpFindMock(...args)),
    findOne: (...args: any[]) => findOneResult(tpFindOneMock(...args)),
    create: (...args: any[]) => tpCreateMock(...args),
  },
  MEAL_PREFERENCE_CODES: [
    "VGML", "VJML", "AVML", "HNML", "MOML", "GFML", "KSML",
    "DBML", "CHML", "BLML", "RVML", "LSML", "LFML", "NLML", "SFML", "FPML", "LCML",
  ],
  // Slice 1 vocabularies — mirrored from the model so the route's
  // allowlisting is exercised against the same values production uses.
  LOYALTY_PROGRAMME_TYPES: ["HOTEL", "CAR", "RAIL", "OTHER"],
  SEAT_PREFERENCES: ["WINDOW", "AISLE", "MIDDLE", "NO_PREFERENCE"],
  HOTEL_PREFERENCES: [
    "NON_SMOKING", "HIGH_FLOOR", "LOW_FLOOR", "KING_BED", "TWIN_BEDS",
    "QUIET_ROOM", "AWAY_FROM_LIFT", "ACCESSIBLE_ROOM", "EARLY_CHECK_IN", "LATE_CHECK_OUT",
  ],
}));

// Designation joined the router in slice 1 (dossier Tab 1). Mocked like the
// other models so resolveDesignationId's tenant check can be exercised
// without a database.
const desigFindOneMock = vi.fn();
vi.mock("../models/Designation.js", () => ({
  default: {
    findOne: (...args: any[]) => findOneResult(desigFindOneMock(...args)),
    find: (...args: any[]) => chainable([]),
    create: vi.fn(),
    updateOne: vi.fn(),
  },
}));

const cmFindOneMock = vi.fn();

function leanish(value: any) {
  return {
    exec: () => Promise.resolve(value),
    then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject),
  };
}

vi.mock("../models/CustomerMember.js", () => ({
  default: {
    findOne: (...args: any[]) => {
      const value = cmFindOneMock(...args);
      return {
        lean: () => leanish(value),
        select: () => ({ lean: () => leanish(value) }),
      };
    },
  },
}));

const cwFindByIdMock = vi.fn();
vi.mock("../models/CustomerWorkspace.js", () => ({
  default: {
    findById: (...args: any[]) => ({ select: () => ({ lean: () => Promise.resolve(cwFindByIdMock(...args)) }) }),
  },
}));

const custFindByIdMock = vi.fn();
vi.mock("../models/Customer.js", () => ({
  default: {
    findById: (...args: any[]) => ({ select: () => ({ lean: () => Promise.resolve(custFindByIdMock(...args)) }) }),
  },
}));

const autoCaptureMock = vi.fn();
vi.mock("../services/travellerAutoCapture.js", () => ({
  autoCaptureTravellersFromBooking: (...args: any[]) => autoCaptureMock(...args),
}));

import express from "express";
import request from "supertest";
import travellerRouter, { ensureTravellerWriteAccess } from "./workspace.travellers.js";

const WORKSPACE_ID = "workspace0000000000000001";
const CUSTOMER_ID = "customer0000000000000001";

function makeApp(user: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    req.workspace = { customerId: CUSTOMER_ID };
    req.workspaceObjectId = WORKSPACE_ID;
    next();
  });
  app.use("/", travellerRouter);
  return app;
}

beforeEach(() => {
  tpFindMock.mockReset().mockReturnValue([]);
  tpFindOneMock.mockReset().mockReturnValue(null);
  // .save() joined the default on 2026-08-11. This stands in for a Mongoose
  // DOCUMENT, which always has one — POST / already re-saved after
  // login-provisioning, and now also after auto-claiming a REQUESTER's own
  // record, so a bare object here was only working by never reaching either
  // branch. A test that wants to assert on the save passes its own doc.
  tpCreateMock
    .mockReset()
    .mockImplementation((doc: any) =>
      Promise.resolve({ _id: "new-id", ...doc, save: vi.fn().mockResolvedValue(undefined) }),
    );
  cmFindOneMock.mockReset().mockReturnValue(null);
  cwFindByIdMock.mockReset().mockReturnValue({});
  custFindByIdMock.mockReset().mockReturnValue({ legalName: "Acme Pvt Ltd" });
  autoCaptureMock.mockReset().mockResolvedValue(undefined);
  desigFindOneMock.mockReset().mockReturnValue(null);
});

/* ── ensureTravellerWriteAccess — the RBAC matrix, tested directly ───── */

describe("ensureTravellerWriteAccess", () => {
  it("SUPERADMIN (member=null) bypasses everything", () => {
    expect(ensureTravellerWriteAccess("u1", null, true, null, "edit").ok).toBe(true);
  });

  it("create is allowed for any active member regardless of role", () => {
    for (const role of ["WORKSPACE_LEADER", "APPROVER", "REQUESTER"]) {
      expect(ensureTravellerWriteAccess("u1", { role }, true, null, "create").ok).toBe(true);
    }
  });

  it("edit/delete on a nonexistent traveller is 404 regardless of role", () => {
    expect(ensureTravellerWriteAccess("u1", { role: "WORKSPACE_LEADER" }, true, null, "edit"))
      .toEqual({ ok: false, status: 404, error: "Traveller not found" });
  });

  it("WORKSPACE_LEADER can edit/delete any traveller", () => {
    const traveller = { createdBy: "someone-else" };
    expect(ensureTravellerWriteAccess("u1", { role: "WORKSPACE_LEADER" }, true, traveller, "edit").ok).toBe(true);
    expect(ensureTravellerWriteAccess("u1", { role: "WORKSPACE_LEADER" }, true, traveller, "delete").ok).toBe(true);
  });

  it("APPROVER can edit when canApproverManageTravellers=true (default)", () => {
    expect(ensureTravellerWriteAccess("u1", { role: "APPROVER" }, true, { createdBy: "someone-else" }, "edit").ok).toBe(true);
  });

  it("APPROVER is blocked when canApproverManageTravellers=false", () => {
    const result = ensureTravellerWriteAccess("u1", { role: "APPROVER" }, false, { createdBy: "someone-else" }, "edit");
    expect(result.ok).toBe(false);
  });

  it("REQUESTER can edit their own (createdBy) record", () => {
    expect(ensureTravellerWriteAccess("u1", { _id: "m1", role: "REQUESTER" }, true, { createdBy: "u1" }, "edit").ok).toBe(true);
  });

  it("REQUESTER can edit a record they're the linked subject of", () => {
    const traveller = { createdBy: "leader-id", linkedMemberId: "m1" };
    expect(ensureTravellerWriteAccess("u1", { _id: "m1", role: "REQUESTER" }, true, traveller, "edit").ok).toBe(true);
  });

  it("REQUESTER cannot edit someone else's record they're not linked to", () => {
    const traveller = { createdBy: "leader-id", linkedMemberId: "someone-else-member" };
    const result = ensureTravellerWriteAccess("u1", { _id: "m1", role: "REQUESTER" }, true, traveller, "edit");
    expect(result.ok).toBe(false);
  });

  // 2026-08-11. claimedBy is the key resolveMyTravellerProfiles resolves on,
  // so it is the key the self-profile surface is bound to — but the row gate
  // only knew createdBy and linkedMemberId. POST / sets claimedBy and NOT
  // linkedMemberId whenever an admin adds a colleague WITH an email, which
  // is the common path: those profiles resolved as "yours" on My Profile and
  // then refused every edit, including the person's own mobile number.
  it("REQUESTER can edit a record they have CLAIMED, even when an admin created it", () => {
    const traveller = { createdBy: "leader-id", linkedMemberId: null, claimedBy: "u1" };
    expect(ensureTravellerWriteAccess("u1", { _id: "m1", role: "REQUESTER" }, true, traveller, "edit").ok).toBe(true);
  });

  it("…but somebody else's claim grants nothing", () => {
    const traveller = { createdBy: "leader-id", linkedMemberId: null, claimedBy: "another-user" };
    expect(ensureTravellerWriteAccess("u1", { _id: "m1", role: "REQUESTER" }, true, traveller, "edit").ok).toBe(false);
  });

  it("missing/unrecognized role is denied", () => {
    expect(ensureTravellerWriteAccess("u1", { role: "" }, true, { createdBy: "u1" }, "edit"))
      .toEqual({ ok: false, status: 403, error: "Not a member of this workspace" });
  });

  it("bulk: WORKSPACE_LEADER always allowed", () => {
    expect(ensureTravellerWriteAccess("u1", { role: "WORKSPACE_LEADER" }, true, null, "bulk").ok).toBe(true);
    expect(ensureTravellerWriteAccess("u1", { role: "WORKSPACE_LEADER" }, false, null, "bulk").ok).toBe(true);
  });

  it("bulk: APPROVER gated by the workspace flag", () => {
    expect(ensureTravellerWriteAccess("u1", { role: "APPROVER" }, true, null, "bulk").ok).toBe(true);
    expect(ensureTravellerWriteAccess("u1", { role: "APPROVER" }, false, null, "bulk").ok).toBe(false);
  });

  it("bulk: REQUESTER is always denied, even though single-add is allowed for them", () => {
    expect(ensureTravellerWriteAccess("u1", { role: "REQUESTER" }, true, null, "bulk").ok).toBe(false);
    expect(ensureTravellerWriteAccess("u1", { role: "REQUESTER" }, true, null, "create").ok).toBe(true);
  });
});

/* ── GET / — list/search ──────────────────────────────────────────────── */

describe("GET / — list/search", () => {
  it("returns passportMasked, never raw passportNo", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    tpFindMock.mockReturnValue([
      { _id: "t1", travelerId: "ACME-001", firstName: "Priya", lastName: "Sharma", email: "priya@acme.com", passportNo: "M1234567" },
    ]);

    const app = makeApp({ sub: "u1", email: "requester@acme.com", roles: ["CUSTOMER"] });
    const res = await request(app).get("/");

    expect(res.status).toBe(200);
    expect(res.body.travellers[0].passportMasked).toBe("****4567");
    expect(res.body.travellers[0]).not.toHaveProperty("passportNo");
  });

  it("403s when the caller isn't an active workspace member", async () => {
    cmFindOneMock.mockReturnValue(null);
    const app = makeApp({ sub: "u1", email: "stranger@acme.com", roles: ["CUSTOMER"] });
    const res = await request(app).get("/");
    expect(res.status).toBe(403);
  });

  it("SUPERADMIN bypasses the membership check entirely", async () => {
    tpFindMock.mockReturnValue([]);
    const app = makeApp({ sub: "admin1", email: "admin@plumtrips.com", roles: ["SUPERADMIN"] });
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(cmFindOneMock).not.toHaveBeenCalled();
  });

  it("REQUESTER gets canManage=true on their own row, false on a colleague's, and can still see the colleague (read-vs-write split)", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    tpFindMock.mockReturnValue([
      { _id: "t1", firstName: "Priya", lastName: "Sharma", email: "priya@acme.com", createdBy: "u1" },
      { _id: "t2", firstName: "Amit", lastName: "Verma", email: "amit@acme.com", createdBy: "someone-else" },
    ]);

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).get("/");

    expect(res.status).toBe(200);
    expect(res.body.travellers).toHaveLength(2);
    expect(res.body.travellers[0].canManage).toBe(true);
    expect(res.body.travellers[1].canManage).toBe(false);
    expect(res.body.capabilities.canCreate).toBe(true);
    expect(res.body.capabilities.canBulkImport).toBe(false); // REQUESTER: create yes, bulk no
  });

  it("WORKSPACE_LEADER gets canBulkImport=true", async () => {
    cmFindOneMock.mockReturnValue({ _id: "leader1", role: "WORKSPACE_LEADER", isActive: true });
    tpFindMock.mockReturnValue([]);
    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app).get("/");
    expect(res.body.capabilities.canBulkImport).toBe(true);
  });

  it("isClaimable is true only for an unlinked profile whose email matches the caller's own", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    tpFindMock.mockReturnValue([
      { _id: "t1", firstName: "Priya", lastName: "Sharma", email: "requester@acme.com", createdBy: "leader-id", linkedMemberId: null },
      { _id: "t2", firstName: "Amit", lastName: "Verma", email: "amit@acme.com", createdBy: "leader-id", linkedMemberId: null },
      { _id: "t3", firstName: "Rahul", lastName: "Gupta", email: "requester@acme.com", createdBy: "leader-id", linkedMemberId: "someone-else-member" },
    ]);

    const app = makeApp({ sub: "u1", email: "Requester@ACME.com" });
    const res = await request(app).get("/");

    expect(res.body.travellers[0].isClaimable).toBe(true); // email matches, unlinked
    expect(res.body.travellers[1].isClaimable).toBe(false); // email doesn't match
    expect(res.body.travellers[2].isClaimable).toBe(false); // email matches but already linked to someone else
  });
});

/* ── GET /:id — ownership bound in the query filter itself ───────────── */

describe("GET /:id", () => {
  it("scopes the findOne filter by workspaceId — ownership never trusted from the URL alone", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    tpFindOneMock.mockReturnValue({ _id: "t1", firstName: "Priya", lastName: "Sharma" });

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).get("/t1");

    expect(res.status).toBe(200);
    expect(tpFindOneMock).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "t1", workspaceId: WORKSPACE_ID }),
    );
  });

  it("404s on a cross-tenant id guess — not found in THIS workspace's filter", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    tpFindOneMock.mockReturnValue(null);

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).get("/someone-elses-id");
    expect(res.status).toBe(404);
  });

  it("includes canManage and isClaimable, and never masks the detail read (feeds the edit form)", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    tpFindOneMock.mockReturnValue({
      _id: "t1", firstName: "Priya", lastName: "Sharma", passportNo: "M1234567",
      email: "requester@acme.com", createdBy: "someone-else", linkedMemberId: null,
    });

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).get("/t1");

    expect(res.status).toBe(200);
    expect(res.body.traveller.passportNo).toBe("M1234567"); // unmasked
    expect(res.body.canManage).toBe(false); // not owner, not linked, plain REQUESTER
    expect(res.body.isClaimable).toBe(true); // email matches, unlinked
  });
});

/* ── POST / — create ───────────────────────────────────────────────────── */

describe("POST / — create", () => {
  it("requires firstName and lastName", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).post("/").send({ firstName: "Priya" });
    expect(res.status).toBe(400);
  });

  it("REQUESTER can create; createdBy is set from the actor, not the body", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).post("/").send({ firstName: "Amit", lastName: "Verma", createdBy: "spoofed" });

    expect(res.status).toBe(201);
    expect(tpCreateMock).toHaveBeenCalledWith(expect.objectContaining({ createdBy: "u1", source: "MANUAL" }));
  });

  it("REQUESTER cannot link a new profile to a DIFFERENT member", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).post("/").send({ firstName: "Amit", lastName: "Verma", linkedMemberId: "member999" });
    expect(res.status).toBe(403);
    expect(tpCreateMock).not.toHaveBeenCalled();
  });

  it("REQUESTER CAN self-link (linkedMemberId === their own member id)", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true, travelerId: "" });
    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).post("/").send({ firstName: "Amit", lastName: "Verma", linkedMemberId: "member1" });

    expect(res.status).toBe(201);
    expect(tpCreateMock).toHaveBeenCalledWith(expect.objectContaining({ linkedMemberId: "member1" }));
  });

  it("WORKSPACE_LEADER can link a new profile to a different member", async () => {
    cmFindOneMock.mockReturnValue({ _id: "leader1", role: "WORKSPACE_LEADER", isActive: true, travelerId: "ACME-005" });
    const app = makeApp({ sub: "leader-uid", email: "leader@acme.com" });
    const res = await request(app).post("/").send({ firstName: "Amit", lastName: "Verma", linkedMemberId: "member999" });

    expect(res.status).toBe(201);
    expect(tpCreateMock).toHaveBeenCalledWith(expect.objectContaining({ linkedMemberId: "member999" }));
  });

  /* ── ACT-FOR CONTROL 2 (2026-08-11) — self-only create ───────────────
   * `action: "create"` used to return ok unconditionally for any active
   * member, so a plain employee could mint profiles for arbitrary other
   * people. A REQUESTER now gets exactly one profile — their own — and it
   * is auto-claimed to them, which is also what closes the audit §5 gap
   * that left a self-added profile with no claimedBy and My Profile blank.
   * Design doc §3. */

  it("REQUESTER's own create is AUTO-CLAIMED — the fix for the blank My Profile", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    tpFindOneMock.mockReturnValue(null); // no existing claimed profile
    const created: any = { _id: "t9", firstName: "Amit", lastName: "Verma", save: vi.fn().mockResolvedValue(undefined) };
    tpCreateMock.mockResolvedValue(created);

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).post("/").send({ firstName: "Amit", lastName: "Verma" });

    expect(res.status).toBe(201);
    // No email involved and no invite fired — the whole point of claiming
    // directly rather than routing through ensureCstepTravellerLogin.
    expect(created.claimedBy).toBe("u1");
    expect(created.claimedAt).toBeInstanceOf(Date);
    expect(created.linkedMemberId).toBe("member1");
    expect(created.save).toHaveBeenCalled();
  });

  it("REQUESTER who already holds a claimed profile gets a 409, not a second row", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    tpFindOneMock.mockReturnValue({ _id: "existing" });

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).post("/").send({ firstName: "Someone", lastName: "Else" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already have a traveller profile/i);
    // Refused BEFORE the travelerId mint, so a rejected create consumes no
    // counter.
    expect(tpCreateMock).not.toHaveBeenCalled();
  });

  it("REQUESTER cannot set the org-only fields at create either", async () => {
    // Otherwise "set it while creating" would be the obvious way around the
    // edit matrix.
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    tpFindOneMock.mockReturnValue(null);

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).post("/").send({ firstName: "Amit", lastName: "Verma", employeeId: "E-1" });

    expect(res.status).toBe(403);
    expect(res.body.fields).toEqual(["employeeId"]);
    expect(tpCreateMock).not.toHaveBeenCalled();
  });

  it("a WORKSPACE_LEADER is not limited to one profile", async () => {
    cmFindOneMock.mockReturnValue({ _id: "leader1", role: "WORKSPACE_LEADER", isActive: true, travelerId: "ACME-005" });
    tpFindOneMock.mockReturnValue({ _id: "existing" }); // would 409 a REQUESTER

    const app = makeApp({ sub: "leader-uid", email: "leader@acme.com" });
    const res = await request(app).post("/").send({ firstName: "Amit", lastName: "Verma" });

    expect(res.status).toBe(201);
  });
});

/* ── PUT /:id — edit RBAC ──────────────────────────────────────────────── */

describe("PUT /:id", () => {
  // FIELD-LEVEL GATING (2026-08-11) split this in two. The ROW gate is
  // unchanged — a REQUESTER still reaches their own record — but the FIELD
  // gate now decides which keys they may set, and `firstName` is not one of
  // them: a legal name is an assertion the ORG makes, not one an employee
  // restates about themselves. This test used to prove a REQUESTER could
  // rename themselves; that is exactly the behaviour this pass removes.
  // See infra/design/universal-traveller-profile-2026-08-11.md §2.
  it("REQUESTER can edit the fields they own on their own (createdBy) record", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const doc: any = { _id: "t1", createdBy: "u1", mobile: "9000000000", save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).put("/t1").send({ mobile: "9111111111", gender: "Female" });

    expect(res.status).toBe(200);
    expect(doc.mobile).toBe("9111111111");
    expect(doc.gender).toBe("Female");
    expect(doc.updatedBy).toBe("u1"); // "last edited by" is written on every save
    expect(doc.save).toHaveBeenCalled();
  });

  it("REQUESTER CANNOT rename themselves — 403 naming the field, and nothing is saved", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const doc: any = { _id: "t1", createdBy: "u1", firstName: "Old", save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).put("/t1").send({ firstName: "New", mobile: "9111111111" });

    expect(res.status).toBe(403);
    expect(res.body.fields).toEqual(["firstName"]);
    // ALL-OR-NOTHING. The allowed field in the same payload must not land
    // either — a partial save would show the user a rejection while quietly
    // applying half of what they typed.
    expect(doc.firstName).toBe("Old");
    expect(doc.mobile).toBeUndefined();
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("WORKSPACE_LEADER CAN rename, and can set the org-only fields", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "WORKSPACE_LEADER", isActive: true });
    const doc: any = { _id: "t1", createdBy: "someone-else", firstName: "Old", save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app).put("/t1").send({ firstName: "New", employeeId: "E-42" });

    expect(res.status).toBe(200);
    expect(doc.firstName).toBe("New");
    expect(doc.employeeId).toBe("E-42");
  });

  it("email is IGNORED on edit for everyone, including a WORKSPACE_LEADER", async () => {
    // Not 403'd — the "full" preset renders the field read-only and still
    // sends it, and rejecting an unchanged value would block saving the rest
    // of the form. It simply never reaches the document: writing it would
    // provision a login and fire a live invite as a side effect of an edit.
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "WORKSPACE_LEADER", isActive: true });
    const doc: any = { _id: "t1", email: "old@acme.com", save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app).put("/t1").send({ email: "new@acme.com", mobile: "9111111111" });

    expect(res.status).toBe(200);
    expect(doc.email).toBe("old@acme.com"); // untouched
    expect(doc.mobile).toBe("9111111111"); // the rest of the form still saves
  });

  /* ── SLICE 1 — dossier Tabs 1 and 4 (2026-08-11) ──────────────────── */

  it("EMPLOYEE can edit their own preferences, loyalty, personal email and emergency contacts", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const doc: any = { _id: "t1", claimedBy: "u1", save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).put("/t1").send({
      seatPreference: "window",
      homeAirport: "blr",
      mealPreference: "VJML",
      hotelPreferences: ["NON_SMOKING", "HIGH_FLOOR"],
      loyaltyProgrammes: [{ programmeType: "hotel", programmeName: "Marriott Bonvoy", membershipNumber: "MB-1", tier: "Gold" }],
      personalEmail: "Arjun.Personal@Gmail.com",
      taxResidency: "IN",
      emergencyContacts: [{ name: "Priya Nair", relationship: "Spouse", phone: "9990001111" }],
    });

    expect(res.status).toBe(200);
    // Case-normalised where the schema says so.
    expect(doc.seatPreference).toBe("WINDOW");
    expect(doc.homeAirport).toBe("BLR");
    expect(doc.mealPreference).toBe("VJML");
    expect(doc.hotelPreferences).toEqual(["NON_SMOKING", "HIGH_FLOOR"]);
    expect(doc.loyaltyProgrammes[0]).toMatchObject({ programmeType: "HOTEL", membershipNumber: "MB-1", tier: "Gold" });
    expect(doc.personalEmail).toBe("arjun.personal@gmail.com");
    expect(doc.emergencyContacts[0]).toMatchObject({ name: "Priya Nair", relationship: "Spouse" });
  });

  it("EMPLOYEE cannot set the new ORG fields — designation, cost centre, work location", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const doc: any = { _id: "t1", claimedBy: "u1", save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).put("/t1").send({
      designationId: "6a0000000000000000000009",
      costCenterId: "CC-1",
      workLocation: "Bengaluru",
      seatPreference: "AISLE", // allowed, but must NOT land either
    });

    expect(res.status).toBe(403);
    expect(res.body.fields.sort()).toEqual(["costCenterId", "designationId", "workLocation"]);
    expect(doc.seatPreference).toBeUndefined();
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("WORKSPACE_LEADER can set the org fields, and a designation is tenant-checked", async () => {
    cmFindOneMock.mockReturnValue({ _id: "leader1", role: "WORKSPACE_LEADER", isActive: true });
    const doc: any = { _id: "t1", save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);
    desigFindOneMock.mockReturnValue({ _id: "6a0000000000000000000009" });

    const app = makeApp({ sub: "leader-uid", email: "leader@acme.com" });
    const res = await request(app).put("/t1").send({
      designationId: "6a0000000000000000000009",
      costCenterId: "CC-4412",
      workLocation: "Bengaluru — HQ",
    });

    expect(res.status).toBe(200);
    expect(doc.costCenterId).toBe("CC-4412");
    expect(doc.workLocation).toBe("Bengaluru — HQ");
    // Resolved through a filter carrying BOTH the id and the workspace.
    expect(desigFindOneMock).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "6a0000000000000000000009", workspaceId: expect.anything() }),
    );
  });

  it("rejects a designation that does not belong to this workspace", async () => {
    cmFindOneMock.mockReturnValue({ _id: "leader1", role: "WORKSPACE_LEADER", isActive: true });
    const doc: any = { _id: "t1", save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);
    desigFindOneMock.mockReturnValue(null); // another tenant's row

    const app = makeApp({ sub: "leader-uid", email: "leader@acme.com" });
    const res = await request(app).put("/t1").send({ designationId: "6a0000000000000000000009" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not belong to this workspace/i);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("drops blank and unrecognised values from the structured fields", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const doc: any = { _id: "t1", claimedBy: "u1", save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).put("/t1").send({
      seatPreference: "TELEPORT",                       // not in the vocabulary
      hotelPreferences: ["NON_SMOKING", "HELIPAD", "NON_SMOKING"], // unknown + duplicate
      emergencyContacts: [
        { name: "Priya Nair", phone: "999" },
        { name: "", relationship: "", phone: "" },      // wholly blank
      ],
      loyaltyProgrammes: [
        { programmeType: "SUBMARINE", programmeName: "Hertz", membershipNumber: "H-9" },
        { programmeName: "", membershipNumber: "" },    // identifies nothing
      ],
    });

    expect(res.status).toBe(200);
    expect(doc.seatPreference).toBeUndefined();
    expect(doc.hotelPreferences).toEqual(["NON_SMOKING"]);
    expect(doc.emergencyContacts).toHaveLength(1);
    // An unknown programmeType drops to undefined but KEEPS the row — the
    // membership number is what the user cares about.
    expect(doc.loyaltyProgrammes).toHaveLength(1);
    expect(doc.loyaltyProgrammes[0].programmeType).toBeUndefined();
    expect(doc.loyaltyProgrammes[0].programmeName).toBe("Hertz");
  });

  /* ── WORK EMAIL IS NOT A SECOND LOGIN WRITE-PATH ──────────────────── */

  it("personalEmail never touches `email`, so it cannot reach the login path", async () => {
    // The login provisioning in POST / is guarded on `traveller.email`.
    // personalEmail is a different key that no code path copies into it, so
    // writing it can never upsert a member, provision a User or fire an
    // invite. This asserts the separation directly.
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const doc: any = {
      _id: "t1", claimedBy: "u1", email: "work@acme.com",
      save: vi.fn().mockResolvedValue(undefined),
    };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).put("/t1").send({
      personalEmail: "arjun@gmail.com",
      email: "hijack@evil.com", // ignored — the work email is read-only
    });

    expect(res.status).toBe(200);
    expect(doc.personalEmail).toBe("arjun@gmail.com");
    expect(doc.email).toBe("work@acme.com"); // untouched
  });

  it("PAN/Aadhaar are refused for EVERYONE while encryption at rest is unbuilt", async () => {
    // 422, not 403: the server understood and will not do it, and no
    // permission would change the answer. The fields exist; capture does
    // not. Design doc §4.
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "WORKSPACE_LEADER", isActive: true });
    const doc: any = { _id: "t1", save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app).put("/t1").send({ panNumber: "ABCDE1234F" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not available yet/i);
    expect(doc.pan).toBeUndefined();
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("REQUESTER cannot edit someone else's unlinked record", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const doc: any = { _id: "t1", createdBy: "someone-else", linkedMemberId: null, save: vi.fn() };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).put("/t1").send({ firstName: "New" });

    expect(res.status).toBe(403);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("REQUESTER CAN edit a record they're the linked subject of, even if someone else created it", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const doc: any = { _id: "t1", createdBy: "leader-id", linkedMemberId: "member1", save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).put("/t1").send({ mobile: "9999999999" });

    expect(res.status).toBe(200);
    expect(doc.save).toHaveBeenCalled();
  });

  it("WORKSPACE_LEADER can edit any record", async () => {
    cmFindOneMock.mockReturnValue({ _id: "leader1", role: "WORKSPACE_LEADER", isActive: true });
    const doc: any = { _id: "t1", createdBy: "someone-else", save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "leader-uid", email: "leader@acme.com" });
    const res = await request(app).put("/t1").send({ firstName: "New" });

    expect(res.status).toBe(200);
  });

  it("APPROVER is blocked when the workspace flag is explicitly off", async () => {
    cmFindOneMock.mockReturnValue({ _id: "appr1", role: "APPROVER", isActive: true });
    cwFindByIdMock.mockReturnValue({ canApproverManageTravellers: false });
    const doc: any = { _id: "t1", createdBy: "someone-else", save: vi.fn() };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "appr-uid", email: "approver@acme.com" });
    const res = await request(app).put("/t1").send({ firstName: "New" });

    expect(res.status).toBe(403);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("APPROVER is allowed by default when the flag is unset", async () => {
    cmFindOneMock.mockReturnValue({ _id: "appr1", role: "APPROVER", isActive: true });
    cwFindByIdMock.mockReturnValue({});
    const doc: any = { _id: "t1", createdBy: "someone-else", save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "appr-uid", email: "approver@acme.com" });
    const res = await request(app).put("/t1").send({ firstName: "New" });

    expect(res.status).toBe(200);
  });
});

/* ── DELETE /:id — soft delete only ────────────────────────────────────── */

describe("DELETE /:id", () => {
  it("sets isActive=false via save — never a hard delete", async () => {
    cmFindOneMock.mockReturnValue({ _id: "leader1", role: "WORKSPACE_LEADER", isActive: true });
    const doc: any = { _id: "t1", createdBy: "x", isActive: true, save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "leader-uid", email: "leader@acme.com" });
    const res = await request(app).delete("/t1");

    expect(res.status).toBe(200);
    expect(doc.isActive).toBe(false);
    expect(doc.save).toHaveBeenCalled();
  });
});

/* ── POST /:id/claim — explicit "Is this you?" self-link ──────────────── */

describe("POST /:id/claim", () => {
  it("rejects when the profile's email doesn't match the caller's account email", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const doc: any = { _id: "t1", email: "someoneelse@acme.com", linkedMemberId: null, save: vi.fn() };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "priya@acme.com" });
    const res = await request(app).post("/t1/claim");

    expect(res.status).toBe(403);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("links on exact email match (case/whitespace-insensitive), sets claimedBy/claimedAt", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const doc: any = { _id: "t1", email: "priya@acme.com", linkedMemberId: null, save: vi.fn().mockResolvedValue(undefined) };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "  Priya@ACME.com " });
    const res = await request(app).post("/t1/claim");

    expect(res.status).toBe(200);
    expect(doc.linkedMemberId).toBe("member1");
    expect(doc.claimedBy).toBe("u1");
    expect(doc.claimedAt).toBeInstanceOf(Date);
  });

  it("409s when already linked to a different member", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const doc: any = { _id: "t1", email: "priya@acme.com", linkedMemberId: "someone-else-member", save: vi.fn() };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "priya@acme.com" });
    const res = await request(app).post("/t1/claim");

    expect(res.status).toBe(409);
    expect(doc.save).not.toHaveBeenCalled();
  });
});

/* ── Bulk import — RBAC gate on template/preview/commit ────────────────── */

const HEADER_ROW = "Title,First Name,Middle Name,Last Name,Gender,Date of Birth,Nationality,Passport Number,Passport Expiry,Passport Issue Country,Passport Issue Date,Mobile,Email,Frequent Flyer Airline,Frequent Flyer Number";

function csvRow(fields: Partial<{
  title: string; firstName: string; middleName: string; lastName: string; gender: string; dob: string;
  nationality: string; passportNo: string; passportExpiry: string; passportIssueCountry: string;
  passportIssueDate: string; mobile: string; email: string; ffAirline: string; ffNumber: string;
}>): string {
  return [
    fields.title ?? "", fields.firstName ?? "", fields.middleName ?? "", fields.lastName ?? "",
    fields.gender ?? "", fields.dob ?? "", fields.nationality ?? "", fields.passportNo ?? "",
    fields.passportExpiry ?? "", fields.passportIssueCountry ?? "", fields.passportIssueDate ?? "",
    fields.mobile ?? "", fields.email ?? "", fields.ffAirline ?? "", fields.ffNumber ?? "",
  ].join(",");
}

function csvBuffer(rows: string[]): Buffer {
  return Buffer.from([HEADER_ROW, ...rows].join("\n"));
}

describe("Bulk import — RBAC gate", () => {
  it("REQUESTER is blocked from template download, preview, and commit", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    const app = makeApp({ sub: "u1", email: "requester@acme.com" });

    const tmpl = await request(app).get("/template/download");
    expect(tmpl.status).toBe(403);

    const preview = await request(app).post("/bulk/preview").attach("file", csvBuffer([csvRow({ firstName: "A", lastName: "B" })]), "t.csv");
    expect(preview.status).toBe(403);

    const commit = await request(app).post("/bulk/commit").attach("file", csvBuffer([csvRow({ firstName: "A", lastName: "B" })]), "t.csv");
    expect(commit.status).toBe(403);
  });

  it("APPROVER is blocked from bulk when the workspace flag is off", async () => {
    cmFindOneMock.mockReturnValue({ _id: "appr1", role: "APPROVER", isActive: true });
    cwFindByIdMock.mockReturnValue({ canApproverManageTravellers: false });
    const app = makeApp({ sub: "u1", email: "approver@acme.com" });

    const res = await request(app).post("/bulk/preview").attach("file", csvBuffer([csvRow({ firstName: "A", lastName: "B" })]), "t.csv");
    expect(res.status).toBe(403);
  });

  it("WORKSPACE_LEADER can reach template download", async () => {
    cmFindOneMock.mockReturnValue({ _id: "leader1", role: "WORKSPACE_LEADER", isActive: true });
    const app = makeApp({ sub: "u1", email: "leader@acme.com" });

    const res = await request(app).get("/template/download?format=csv");
    expect(res.status).toBe(200);
    expect(res.text).toContain("First Name");
    expect(res.text).toContain("Frequent Flyer Number");
  });
});

/* ── POST /bulk/preview — dry run, no writes ──────────────────────────── */

describe("POST /bulk/preview", () => {
  beforeEach(() => {
    cmFindOneMock.mockReturnValue({ _id: "leader1", role: "WORKSPACE_LEADER", isActive: true });
  });

  it("classifies a fully-new row as create — no match on empty email/dob", async () => {
    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app)
      .post("/bulk/preview")
      .attach("file", csvBuffer([csvRow({ firstName: "Amit", lastName: "Verma" })]), "t.csv");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ action: "create", firstName: "Amit", lastName: "Verma" });
    expect(tpCreateMock).not.toHaveBeenCalled(); // preview never writes
  });

  it("classifies a Tier-1 email match as update", async () => {
    tpFindOneMock.mockReturnValue({ _id: "t1", travelerId: "ACME-001", firstName: "Priya", lastName: "Sharma" });
    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app)
      .post("/bulk/preview")
      .attach("file", csvBuffer([csvRow({ firstName: "Priya", lastName: "Sharma", email: "priya@acme.com" })]), "t.csv");

    expect(res.status).toBe(200);
    expect(res.body.results[0].action).toBe("update");
    expect(res.body.results[0].reason).toMatch(/email/i);
  });

  it("classifies a Tier-2 name+DOB match (no email in the row) as update", async () => {
    tpFindMock.mockReturnValue([{ _id: "t2", travelerId: "ACME-002", firstName: "Rahul", lastName: "Gupta", dob: "1990-05-01" }]);
    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app)
      .post("/bulk/preview")
      .attach("file", csvBuffer([csvRow({ firstName: "Rahul", lastName: "Gupta", dob: "1990-05-01" })]), "t.csv");

    expect(res.status).toBe(200);
    expect(res.body.results[0].action).toBe("update");
    expect(res.body.results[0].reason).toMatch(/date of birth/i);
  });

  it("skips a row missing required First/Last Name", async () => {
    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app)
      .post("/bulk/preview")
      .attach("file", csvBuffer([csvRow({ firstName: "", lastName: "OnlyLast" })]), "t.csv");

    expect(res.body.results[0]).toMatchObject({ action: "skip", reason: expect.stringMatching(/required/i) });
  });

  it("skips a row with an invalid email", async () => {
    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app)
      .post("/bulk/preview")
      .attach("file", csvBuffer([csvRow({ firstName: "A", lastName: "B", email: "not-an-email" })]), "t.csv");

    expect(res.body.results[0]).toMatchObject({ action: "skip", reason: expect.stringMatching(/email/i) });
  });

  it("skips a row with a badly-formatted date", async () => {
    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app)
      .post("/bulk/preview")
      .attach("file", csvBuffer([csvRow({ firstName: "A", lastName: "B", dob: "01-05-1990" })]), "t.csv");

    expect(res.body.results[0]).toMatchObject({ action: "skip", reason: expect.stringMatching(/YYYY-MM-DD/) });
  });

  it("rejects a file over the row cap, naming the cap", async () => {
    const rows = Array.from({ length: 501 }, (_, i) => csvRow({ firstName: `P${i}`, lastName: "Test" }));
    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app).post("/bulk/preview").attach("file", csvBuffer(rows), "t.csv");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/501/);
    expect(res.body.error).toMatch(/500/);
  });
});

/* ── POST /bulk/commit — writes for real ───────────────────────────────── */

describe("POST /bulk/commit", () => {
  beforeEach(() => {
    cmFindOneMock.mockReturnValue({ _id: "leader1", role: "WORKSPACE_LEADER", isActive: true });
  });

  it("creates a new profile with source BULK_IMPORT and createdBy the actor", async () => {
    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app)
      .post("/bulk/commit")
      .attach("file", csvBuffer([csvRow({ firstName: "Amit", lastName: "Verma" })]), "t.csv");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, updated: 0, skipped: 0 });
    expect(tpCreateMock).toHaveBeenCalledWith(expect.objectContaining({ source: "BULK_IMPORT", createdBy: "u1", firstName: "Amit" }));
  });

  it("updates a Tier-1 matched profile, overwriting only fields the row provides", async () => {
    const doc: any = {
      _id: "t1", travelerId: "ACME-001", firstName: "Priya", lastName: "Sharma",
      nationality: "Indian", mobile: "9999999999", save: vi.fn().mockResolvedValue(undefined),
    };
    tpFindOneMock.mockReturnValue(doc);

    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app)
      .post("/bulk/commit")
      .attach(
        "file",
        csvBuffer([csvRow({ firstName: "Priya", lastName: "Sharma", email: "priya@acme.com", mobile: "8888888888" })]),
        "t.csv",
      );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0, updated: 1, skipped: 0 });
    expect(doc.mobile).toBe("8888888888"); // overwritten — row provided it
    expect(doc.nationality).toBe("Indian"); // untouched — row's cell was blank
    expect(doc.save).toHaveBeenCalled();
    expect(tpCreateMock).not.toHaveBeenCalled();
  });

  it("row cap is enforced on commit too", async () => {
    const rows = Array.from({ length: 501 }, (_, i) => csvRow({ firstName: `P${i}`, lastName: "Test" }));
    const app = makeApp({ sub: "u1", email: "leader@acme.com" });
    const res = await request(app).post("/bulk/commit").attach("file", csvBuffer(rows), "t.csv");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/500/);
  });
});

/* ── GET /export/download — masked unless SUPERADMIN ──────────────────── */

describe("GET /export/download", () => {
  it("masks passport to last-4 for a regular member", async () => {
    cmFindOneMock.mockReturnValue({ _id: "member1", role: "REQUESTER", isActive: true });
    tpFindMock.mockReturnValue([
      { travelerId: "ACME-001", firstName: "Priya", lastName: "Sharma", passportNo: "M1234567" },
    ]);

    const app = makeApp({ sub: "u1", email: "requester@acme.com" });
    const res = await request(app).get("/export/download?format=csv");

    expect(res.status).toBe(200);
    expect(res.text).toContain("****4567");
    expect(res.text).not.toContain("M1234567");
  });

  it("SUPERADMIN gets the full unmasked passport number", async () => {
    tpFindMock.mockReturnValue([
      { travelerId: "ACME-001", firstName: "Priya", lastName: "Sharma", passportNo: "M1234567" },
    ]);

    const app = makeApp({ sub: "admin1", email: "admin@plumtrips.com", roles: ["SUPERADMIN"] });
    const res = await request(app).get("/export/download?format=csv");

    expect(res.status).toBe(200);
    expect(res.text).toContain("M1234567");
  });
});

/* ── POST /auto-capture — passenger-step submit, no RBAC beyond auth ──── */

describe("POST /auto-capture", () => {
  it("any authenticated member (no manage-travellers role needed) gets 200 accepted:true", async () => {
    const app = makeApp({ sub: "u1", email: "requester@acme.com", roles: ["REQUESTER"] });
    const res = await request(app).post("/auto-capture").send({ passengers: [{ FirstName: "Amit", LastName: "Verma" }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true });
  });

  it("forwards workspaceId/customerId/createdBy/passengers from req context, not the request body", async () => {
    const app = makeApp({ sub: "u1", email: "requester@acme.com", roles: ["REQUESTER"] });
    await request(app).post("/auto-capture").send({
      passengers: [{ FirstName: "Amit", LastName: "Verma", SaveToTravellers: true }],
      workspaceId: "someone-elses-workspace", // must be ignored — ownership never trusted from the body
    });

    expect(autoCaptureMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      createdBy: "u1",
      passengers: [{ FirstName: "Amit", LastName: "Verma", SaveToTravellers: true }],
    }));
  });

  it("responds immediately without awaiting autoCaptureTravellersFromBooking (fire-and-forget)", async () => {
    let resolveCapture: () => void = () => {};
    autoCaptureMock.mockReturnValue(new Promise<void>(resolve => { resolveCapture = resolve; }));

    const app = makeApp({ sub: "u1", email: "requester@acme.com", roles: ["REQUESTER"] });
    const res = await request(app).post("/auto-capture").send({ passengers: [{ FirstName: "Amit", LastName: "Verma" }] });

    // The route already responded even though the capture promise above is
    // still unresolved — proves the request doesn't wait on it.
    expect(res.status).toBe(200);
    resolveCapture();
  });

  it("a rejected capture promise never surfaces as a 500 — response already sent", async () => {
    autoCaptureMock.mockRejectedValue(new Error("boom"));
    const app = makeApp({ sub: "u1", email: "requester@acme.com", roles: ["REQUESTER"] });
    const res = await request(app).post("/auto-capture").send({ passengers: [{ FirstName: "Amit", LastName: "Verma" }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true });
  });
});
