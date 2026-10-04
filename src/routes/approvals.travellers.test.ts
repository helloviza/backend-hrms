// apps/backend/src/routes/approvals.travellers.test.ts
//
// Travellers on an approval request (Flow 2 and Flow 3):
//   - "self" is always the request owner's own profile (the TravellerProfile
//     they claimed — My Profile); whatever the client sends for it is ignored
//   - anyone raising a request (requester, approver, Workspace Leader) can add
//     manual travellers; those live on the request only and are never written
//     to travellers, members, users or anywhere else
//   - a request with no traveller is refused
//   - an incomplete own profile blocks submit while self is included
//   - passport numbers: last 4 for customer-side viewers and in emails, full
//     for Plumtrips staff; a customer's masked round-trip on edit keeps the
//     real number
//
// Real: approvals router, travel-mode/feature guards, models, in-memory Mongo.
// Stubbed: requireAuth (user from a header), requireWorkspace (workspace from
// a header), mail (recorded), email-action tokens, TBO.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

const sent: Array<{ to: string; subject: string; html: string }> = [];

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: async (req: any, res: any, next: any) => {
    const { default: mg } = await import("mongoose");
    const id = String(req.headers["x-test-ws"] || "");
    const ws = await mg.connection.db!.collection("customerworkspaces").findOne({ _id: new mg.Types.ObjectId(id) });
    if (!ws) return res.status(403).json({ error: "no workspace" });
    req.workspace = ws;
    req.workspaceObjectId = ws._id;
    req.workspaceId = String(ws._id);
    next();
  },
}));
vi.mock("../utils/mailer.js", () => ({
  sendMail: async (m: any) => {
    sent.push({ to: String(m.to), subject: String(m.subject), html: String(m.html || "") });
    return { messageId: "test" };
  },
}));
vi.mock("../services/tbo.flight.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchFlights: v.fn() };
});
vi.mock("../services/tbo.hotel.search.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchHotels: v.fn() };
});
vi.mock("../utils/emailActionToken.js", () => ({
  signEmailActionToken: () => "tok",
  verifyEmailActionToken: () => null,
  hashToken: () => "hash",
}));

const { default: approvalsRouter } = await import("./approvals.js");

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

// Plumtrips staff sign in to HOUSE (prod shape). STAFF is a HOUSE ADMIN —
// queue access for oversight, no Admin Queue grant needed.
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const WS_DIRECT = oid(); // Flow 3
const WS_FLOW = oid(); // Flow 2
const APPROVER = "approver@cust.test";
const LEADER = "leader@cust.test";

type Who = { sub: string; email: string; roles?: string[] };
const REQUESTER: Who = { sub: String(oid()), email: "requestor@cust.test" };
const APPROVER_USER: Who = { sub: String(oid()), email: APPROVER };
const LEADER_USER: Who = { sub: String(oid()), email: LEADER, roles: ["WORKSPACE_LEADER"] };
const STAFF: Who = { sub: String(oid()), email: "ops@plumtrips.test", roles: ["ADMIN"] };

const as = (r: request.Test, who: Who, wsId: any) =>
  r
    .set("x-test-user", JSON.stringify({ sub: who.sub, email: who.email, name: who.email.split("@")[0], roles: who.roles || ["EMPLOYEE"] }))
    .set("x-test-ws", String(wsId));

const PROFILE_PASSPORT = "Z9876543";
const MANUAL_PASSPORT = "K1234567";

const ws = (_id: any, customerId: string, travelFlow: string) => ({
  _id, customerId, name: `WS ${customerId}`, status: "ACTIVE", tenantType: "CORPORATE",
  defaultApproverEmails: [APPROVER],
  config: {
    travelFlow,
    features: { approvalFlowEnabled: travelFlow === "APPROVAL_FLOW", approvalDirectEnabled: travelFlow === "APPROVAL_DIRECT" },
  },
});

function profileFor(who: Who, wsId: any, extra: Record<string, any> = {}) {
  return {
    workspaceId: wsId,
    travelerId: `T-${who.sub.slice(-6)}`,
    claimedBy: new mongoose.Types.ObjectId(who.sub),
    firstName: "Riya",
    lastName: "Profile",
    dob: "1990-04-02",
    gender: "Female",
    nationality: "Indian",
    passportNo: PROFILE_PASSPORT,
    passportExpiry: "2031-01-01",
    email: who.email,
    mobile: "9800000000",
    isActive: true,
    source: "MANUAL",
    createdBy: new mongoose.Types.ObjectId(who.sub),
    ...extra,
  };
}

const manual = (extra: Record<string, any> = {}) => ({
  kind: "manual", firstName: "Asha", lastName: "Guest", dob: "1988-01-01", gender: "Female",
  nationality: "Indian", passportNumber: MANUAL_PASSPORT, passportExpiry: "2030-05-05", ...extra,
});

const item = (travellers: any[], travelScope = "international") => ({
  type: "flight", title: "BLR → DXB", qty: 1, price: 0,
  meta: { origin: "BLR", destination: "DXB", departDate: "2027-03-12", travelScope, travellers },
});

const submit = (who: Who, travellers: any[], opts: { wsId?: any; scope?: string } = {}) =>
  as(request(app).post("/api/approvals/requests"), who, opts.wsId || WS_DIRECT)
    .send({ customerId: (opts.wsId || WS_DIRECT) === WS_FLOW ? "F1" : "D1", cartItems: [item(travellers, opts.scope)] });

const stored = async (id: any) => {
  const doc: any = await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
  return doc.cartItems[0].meta.travellers as any[];
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-travellers-test"));
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    ws(WS_DIRECT, "D1", "APPROVAL_DIRECT"),
    ws(WS_FLOW, "F1", "APPROVAL_FLOW"),
    { _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE", config: { features: {} } },
  ] as any[]);
  await col("customermembers").insertMany([
    { customerId: "D1", email: LEADER, role: "WORKSPACE_LEADER", isActive: true },
    { customerId: "F1", email: LEADER, role: "WORKSPACE_LEADER", isActive: true },
  ] as any[]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  sent.length = 0;
  await col("approvalrequests").deleteMany({});
  await col("travellerprofiles").deleteMany({});
  await col("travellerprofiles").insertOne(profileFor(REQUESTER, WS_DIRECT) as any);
});

describe("self traveller comes from the owner's own profile", () => {
  it("ignores every client-sent self value and stores the profile", async () => {
    const r = await submit(REQUESTER, [
      { kind: "self", firstName: "Forged", lastName: "Name", dob: "2001-01-01", passportNumber: "FAKE0001", nationality: "Martian" },
    ]);
    expect(r.status).toBe(200);
    const [self] = await stored(r.body.request._id);
    expect(self).toMatchObject({
      kind: "self", firstName: "Riya", lastName: "Profile", dob: "1990-04-02",
      nationality: "Indian", passportNumber: PROFILE_PASSPORT, passportExpiry: "2031-01-01",
    });
    expect(JSON.stringify(await stored(r.body.request._id))).not.toMatch(/Forged|FAKE0001|Martian/);
  });

  it("re-reads the profile on edit, also when the client edits the self card", async () => {
    const r = await submit(REQUESTER, [{ kind: "self" }]);
    await col("travellerprofiles").updateOne({ claimedBy: new mongoose.Types.ObjectId(REQUESTER.sub) }, { $set: { lastName: "Updated" } });
    const put = await as(request(app).put(`/api/approvals/requests/${r.body.request._id}`), REQUESTER, WS_DIRECT)
      .send({ cartItems: [item([{ kind: "self", lastName: "Client" }])] });
    expect(put.status).toBe(200);
    const [self] = await stored(r.body.request._id);
    expect(self.lastName).toBe("Updated");
  });

  it("GET /self-traveller returns the caller's profile with the passport masked", async () => {
    const r = await as(request(app).get("/api/approvals/self-traveller"), REQUESTER, WS_DIRECT);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    expect(r.body.traveller.firstName).toBe("Riya");
    expect(r.body.traveller.passportNumber).toBe("****6543");
    expect(r.body.missing).toEqual([]);
    expect(r.body.missingInternational).toEqual([]);
  });
});

describe("incomplete own profile blocks submit while self is included", () => {
  it("no claimed profile → SELF_PROFILE_INCOMPLETE", async () => {
    await col("travellerprofiles").deleteMany({});
    const r = await submit(REQUESTER, [{ kind: "self" }], { scope: "domestic" });
    expect([r.status, r.body.code]).toEqual([400, "SELF_PROFILE_INCOMPLETE"]);
  });

  it("missing date of birth blocks even a domestic trip", async () => {
    await col("travellerprofiles").updateOne({}, { $unset: { dob: "" } });
    const r = await submit(REQUESTER, [{ kind: "self" }], { scope: "domestic" });
    expect([r.status, r.body.code]).toEqual([400, "SELF_PROFILE_INCOMPLETE"]);
    expect(r.body.missing).toEqual(["dob"]);
  });

  it("missing passport blocks international, not domestic", async () => {
    await col("travellerprofiles").updateOne({}, { $unset: { passportNo: "", passportExpiry: "" } });
    const intl = await submit(REQUESTER, [{ kind: "self" }]);
    expect([intl.status, intl.body.code]).toEqual([400, "SELF_PROFILE_INCOMPLETE"]);
    expect(intl.body.missing).toEqual(["passportNumber", "passportExpiry"]);
    const dom = await submit(REQUESTER, [{ kind: "self" }], { scope: "domestic" });
    expect(dom.status).toBe(200);
  });

  it("an incomplete profile does not block when self is left out", async () => {
    await col("travellerprofiles").deleteMany({});
    const r = await submit(REQUESTER, [manual()]);
    expect(r.status).toBe(200);
  });
});

describe("at least one traveller", () => {
  it("refuses a request with no traveller", async () => {
    const r = await submit(REQUESTER, []);
    expect([r.status, r.body.code]).toEqual([400, "NO_TRAVELLERS"]);
    expect(await col("approvalrequests").countDocuments()).toBe(0);
  });
});

describe("manual travellers — any role, on this request only", () => {
  it.each([
    ["requester", REQUESTER, WS_DIRECT],
    ["approver", APPROVER_USER, WS_FLOW],
    ["Workspace Leader", LEADER_USER, WS_FLOW],
  ])("%s can add manual travellers", async (_label, who, wsId) => {
    const r = await submit(who as Who, [manual(), manual({ firstName: "Vikram", passportNumber: "P7654321" })], { wsId });
    expect(r.status).toBe(200);
    const trs = await stored(r.body.request._id);
    expect(trs.map((t) => [t.kind, t.firstName, t.passportNumber])).toEqual([
      ["manual", "Asha", MANUAL_PASSPORT],
      ["manual", "Vikram", "P7654321"],
    ]);
    expect(trs.every((t) => /^m-[a-f0-9]{16}$/.test(t.travellerId))).toBe(true);
  });

  it("are never written to travellers, members, users or any other collection", async () => {
    const counts = async () => {
      const out: Record<string, number> = {};
      for (const c of await mongoose.connection.db!.listCollections().toArray()) {
        if (c.name !== "approvalrequests") out[c.name] = await col(c.name).countDocuments();
      }
      return out;
    };
    const before = await counts();
    const r = await submit(REQUESTER, [{ kind: "self" }, manual({ email: "asha@guest.test", phone: "9811111111" })]);
    expect(r.status).toBe(200);
    expect(await counts()).toEqual(before);
    for (const c of Object.keys(before)) {
      expect(await col(c).countDocuments({ $or: [{ firstName: "Asha" }, { email: "asha@guest.test" }, { passportNo: MANUAL_PASSPORT }] })).toBe(0);
    }
  });

  it("international manual travellers need passport number, expiry and nationality", async () => {
    const r = await submit(REQUESTER, [manual({ passportNumber: "", nationality: "" })]);
    expect([r.status, r.body.code]).toEqual([400, "TRAVELLER_INCOMPLETE"]);
    expect(r.body.missing).toEqual(["passportNumber", "nationality"]);
    const dom = await submit(REQUESTER, [{ kind: "manual", firstName: "Asha", lastName: "Guest" }], { scope: "domestic" });
    expect(dom.status).toBe(200);
  });
});

describe("staff work every tenant's requests from the ops queue", () => {
  // STAFF's token workspace (HOUSE) is not the request's workspace
  // (WS_DIRECT). Ops actions must still find the request.
  it("staff from another workspace can open, assign and reveal; a Workspace Leader from another workspace cannot", async () => {
    const r = await submit(REQUESTER, [manual()]);
    const id = r.body.request._id;
    await col("approvalrequests").updateOne({ _id: new mongoose.Types.ObjectId(String(id)) }, { $set: { status: "approved", adminState: "pending" } });

    expect((await as(request(app).get(`/api/approvals/admin/requests/${id}`), STAFF, HOUSE)).status).toBe(200);
    expect((await as(request(app).get(`/api/approvals/requests/${id}`), STAFF, HOUSE)).status).toBe(200);
    expect((await as(request(app).get(`/api/approvals/admin/requests/${id}/selection-snapshot`), STAFF, HOUSE)).status).toBe(200);
    // Found (a 404 would mean the lookup failed); refused only because the user is not on the Travel Desk.
    const assign = await as(request(app).put(`/api/approvals/admin/${id}/assign`), STAFF, HOUSE).send({ agentUserId: String(oid()) });
    expect([assign.status, assign.body.code]).toEqual([400, "NOT_TEAM_AGENT"]);
    const reveal = await as(request(app).post(`/api/approvals/admin/requests/${id}/passport-reveal`), STAFF, HOUSE)
      .send({ itemIndex: 0, travellerIndex: 0 });
    expect([reveal.status, reveal.body.passportNumber]).toEqual([200, MANUAL_PASSPORT]);
    const hold = await as(request(app).put(`/api/approvals/admin/${id}/on-hold`), STAFF, HOUSE).send({ comment: "waiting" });
    expect(hold.status).toBe(200);

    // Non-staff stay inside their own workspace.
    expect((await as(request(app).get(`/api/approvals/admin/requests/${id}`), LEADER_USER, WS_FLOW)).status).toBe(404);
    expect((await as(request(app).get(`/api/approvals/requests/${id}`), APPROVER_USER, WS_FLOW)).status).toBe(404);
  });
});

describe("passport masking", () => {
  it("customer-side viewers and staff payloads get last 4 (staff read the full number only through the audited reveal)", async () => {
    const r = await submit(REQUESTER, [{ kind: "self" }, manual()]);
    const id = r.body.request._id;
    expect(r.body.request.cartItems[0].meta.travellers.map((t: any) => t.passportNumber)).toEqual(["****6543", "****4567"]);

    for (const who of [REQUESTER, APPROVER_USER, LEADER_USER]) {
      const got = await as(request(app).get(`/api/approvals/requests/${id}`), who, WS_DIRECT);
      expect(got.status).toBe(200);
      const body = JSON.stringify(got.body);
      expect(body).not.toContain(PROFILE_PASSPORT);
      expect(body).not.toContain(MANUAL_PASSPORT);
    }
    const mine = await as(request(app).get("/api/approvals/requests/mine"), REQUESTER, WS_DIRECT);
    expect(JSON.stringify(mine.body)).not.toContain(MANUAL_PASSPORT);

    const staff = await as(request(app).get(`/api/approvals/requests/${id}`), STAFF, HOUSE);
    expect(staff.body.request.cartItems[0].meta.travellers.map((t: any) => t.passportNumber)).toEqual(["****6543", "****4567"]);
    const staffQueue = await as(request(app).get("/api/approvals/admin/pending"), STAFF, HOUSE);
    expect(staffQueue.status).toBe(200);
    expect(JSON.stringify(staffQueue.body)).not.toMatch(new RegExp(`${PROFILE_PASSPORT}|${MANUAL_PASSPORT}`));
  });

  it("emails never carry a passport number", async () => {
    await submit(REQUESTER, [{ kind: "self" }, manual()]);
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) {
      expect(m.html).not.toContain(PROFILE_PASSPORT);
      expect(m.html).not.toContain(MANUAL_PASSPORT);
      expect(m.html).not.toContain("4567");
    }
    expect(sent.some((m) => m.html.includes("Asha Guest"))).toBe(true);
  });

  it("a customer's edit round-trip keeps the real passport behind the mask", async () => {
    const r = await submit(REQUESTER, [{ kind: "self" }, manual()]);
    const id = r.body.request._id;
    const got = await as(request(app).get(`/api/approvals/requests/${id}`), REQUESTER, WS_DIRECT);
    const put = await as(request(app).put(`/api/approvals/requests/${id}`), REQUESTER, WS_DIRECT)
      .send({ cartItems: got.body.request.cartItems, comments: "edited" });
    expect(put.status).toBe(200);
    const trs = await stored(id);
    expect(trs.map((t) => t.passportNumber)).toEqual([PROFILE_PASSPORT, MANUAL_PASSPORT]);
  });

  it("customers (requester, approver, Workspace Leader) cannot call the reveal endpoints; nothing is recorded", async () => {
    const r = await submit(REQUESTER, [{ kind: "self" }, manual()]);
    const id = r.body.request._id;
    for (const who of [REQUESTER, APPROVER_USER, LEADER_USER]) {
      const reveal = await as(request(app).post(`/api/approvals/admin/requests/${id}/passport-reveal`), who, WS_DIRECT)
        .send({ itemIndex: 0, travellerIndex: 1 });
      expect(reveal.status).toBe(403);
      expect(JSON.stringify(reveal.body)).not.toContain(MANUAL_PASSPORT);
      const audit = await as(request(app).get(`/api/approvals/admin/requests/${id}/passport-reveals`), who, WS_DIRECT);
      expect(audit.status).toBe(403);
    }
    const raw: any = await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
    expect(raw.passportReveals).toBeUndefined();
  });

  it("staff reveal returns the full number and records who, which request, which traveller, when", async () => {
    const r = await submit(REQUESTER, [{ kind: "self" }, manual()]);
    const id = r.body.request._id;
    const before: any = await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(id)) });

    const reveal = await as(request(app).post(`/api/approvals/admin/requests/${id}/passport-reveal`), STAFF, HOUSE)
      .send({ itemIndex: 0, travellerIndex: 1 });
    expect(reveal.status).toBe(200);
    expect(reveal.body.passportNumber).toBe(MANUAL_PASSPORT);
    expect(reveal.headers["cache-control"]).toMatch(/no-store/);

    const raw: any = await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
    expect(raw.passportReveals).toHaveLength(1);
    expect(raw.passportReveals[0]).toMatchObject({
      byUserId: STAFF.sub, byEmail: STAFF.email, itemIndex: 0, travellerIndex: 1, travellerName: "Asha Guest",
    });
    expect(raw.passportReveals[0].at).toBeInstanceOf(Date);
    // Not in history (customers read it; booking history parses its latest entry) and no "Last update" bump.
    expect(raw.history.map((h: any) => h.action)).not.toContain("passport_revealed");
    expect(raw.history).toHaveLength(before.history.length);
    expect(raw.updatedAt.getTime()).toBe(before.updatedAt.getTime());

    const audit = await as(request(app).get(`/api/approvals/admin/requests/${id}/passport-reveals`), STAFF, HOUSE);
    expect(audit.status).toBe(200);
    expect(audit.body.reveals).toHaveLength(1);
    expect(audit.body.reveals[0]).toMatchObject({ byEmail: STAFF.email, travellerName: "Asha Guest" });

    // Customers never see the audit, nor the number, after a reveal.
    for (const who of [REQUESTER, APPROVER_USER, LEADER_USER]) {
      const got = await as(request(app).get(`/api/approvals/requests/${id}`), who, WS_DIRECT);
      const body = JSON.stringify(got.body);
      expect(body).not.toContain(MANUAL_PASSPORT);
      expect(body).not.toContain("passportReveals");
    }
    const leaderQueue = await as(request(app).get("/api/approvals/admin/pending"), LEADER_USER, WS_DIRECT);
    expect(JSON.stringify(leaderQueue.body)).not.toMatch(new RegExp(`${MANUAL_PASSPORT}|passportReveals`));
  });

  it("reveal refuses a traveller with no passport and a bad index, recording nothing", async () => {
    const r = await submit(REQUESTER, [{ kind: "manual", firstName: "No", lastName: "Passport" }], { scope: "domestic" });
    const id = r.body.request._id;
    const none = await as(request(app).post(`/api/approvals/admin/requests/${id}/passport-reveal`), STAFF, HOUSE)
      .send({ itemIndex: 0, travellerIndex: 0 });
    expect(none.status).toBe(404);
    const bad = await as(request(app).post(`/api/approvals/admin/requests/${id}/passport-reveal`), STAFF, HOUSE)
      .send({ itemIndex: "x", travellerIndex: 0 });
    expect(bad.status).toBe(400);
    const raw: any = await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
    expect(raw.passportReveals).toBeUndefined();
  });

  it("a masked passport that matches nothing stored must be re-entered", async () => {
    const r = await submit(REQUESTER, [manual({ passportNumber: "****4567" })]);
    expect([r.status, r.body.code]).toEqual([400, "PASSPORT_REENTER"]);
  });
});
