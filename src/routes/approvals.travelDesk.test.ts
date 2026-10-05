// apps/backend/src/routes/approvals.travelDesk.test.ts
//
// Travel Desk case assignment:
//   - the Assign picker lists only team agents; only ops staff can join
//   - non-staff cannot assign, unassign or change settings
//   - auto-allocation on approval: round robin (rotates, skips Away), least
//     busy (fewest open; ties rotate), customer's Account Manager first when
//     eligible (fallback otherwise), nobody available → unassigned + flagged
//   - the assignee is emailed; every change is recorded in the activity with
//     a staff-only note that customers never receive
//
// Real: approvals router + Travel Desk router/service, decision service,
// models, in-memory Mongo. Stubbed: requireAuth (user from a header),
// requireWorkspace (workspace from a header), mail (recorded), email-action
// tokens, TBO.
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
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
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
const { default: customersRouter } = await import("./customers.js");
const { autoAllocate } = await import("../services/travelDesk.js");

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);
app.use("/api/customers", customersRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const WS = oid();
const CUSTOMER_ID = oid();
const APPROVER = "approver@cust.test";

type Who = { sub: string; email: string; name: string; roles: string[] };
const staffUser = (name: string, roles = ["OPS"]): Who => ({ sub: String(oid()), email: `${name.toLowerCase()}@plumtrips.test`, name, roles });
const ASHA = staffUser("Asha");
const BEN = staffUser("Ben", ["ADMIN"]);
const CHIT = staffUser("Chit");
const RAVI = staffUser("Ravi"); // the customer's Account Manager
const HOUSE_EMPLOYEE: Who = { sub: String(oid()), email: "clerk@plumtrips.test", name: "Clerk", roles: ["EMPLOYEE"] };
const REQUESTER: Who = { sub: String(oid()), email: "requestor@cust.test", name: "Req", roles: ["EMPLOYEE"] };
const APPROVER_USER: Who = { sub: String(oid()), email: APPROVER, name: "Appr", roles: ["EMPLOYEE"] };
const LEADER: Who = { sub: String(oid()), email: "leader@cust.test", name: "Lead", roles: ["WORKSPACE_LEADER"] };

const as = (r: request.Test, who: Who, wsId: any) =>
  r.set("x-test-user", JSON.stringify({ sub: who.sub, email: who.email, name: who.name, roles: who.roles })).set("x-test-ws", String(wsId));
const asStaff = (r: request.Test, who: Who = BEN) => as(r, who, HOUSE);

async function setDesk(body: any) {
  const r = await asStaff(request(app).put("/api/approvals/travel-desk/settings")).send(body);
  expect(r.status).toBe(200);
  return r.body;
}

/** A request raised and approved through the real routes (the approve fires auto-allocation). */
async function approvedRequest() {
  const created = await as(request(app).post("/api/approvals/requests"), REQUESTER, WS).send({
    customerId: String(CUSTOMER_ID),
    comments: "Client visit",
    cartItems: [{
      type: "flight", title: "BLR → DEL", qty: 1, price: 0,
      meta: { origin: "BLR", destination: "DEL", tripType: "oneway", departDate: "2027-04-02", travelScope: "domestic",
        travellers: [{ kind: "manual", firstName: "Asha", lastName: "Guest" }] },
    }],
  });
  expect(created.status).toBe(200);
  const id = created.body.request._id;
  const ok = await as(request(app).put(`/api/approvals/requests/${id}/action`), APPROVER_USER, WS).send({ action: "approved" });
  expect(ok.status).toBe(200);
  return id as string;
}
const stored = async (id: any) => (await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(id)) })) as any;
const assignee = async (id: any) => (await stored(id))?.meta?.adminAssigned?.userId || null;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-travel-desk-test"));
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    { _id: HOUSE, customerId: "HOUSE", name: "Plumtrips", status: "ACTIVE", config: { features: {} } },
    {
      _id: WS, customerId: String(CUSTOMER_ID), name: "Acme", companyName: "Acme", status: "ACTIVE", tenantType: "CORPORATE",
      defaultApproverEmails: [APPROVER],
      config: { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } },
    },
  ] as any[]);
  await col("customermembers").insertOne({ customerId: String(CUSTOMER_ID), email: LEADER.email, role: "WORKSPACE_LEADER", isActive: true } as any);
  await col("users").insertMany(
    [ASHA, BEN, CHIT, RAVI, HOUSE_EMPLOYEE].map((u) => ({
      _id: new mongoose.Types.ObjectId(u.sub), workspaceId: HOUSE, email: u.email, name: u.name, roles: u.roles, status: "ACTIVE",
    })) as any[],
  );
  // The booking team = Access Console "Admin Queue" grant (WRITE). The plain
  // HOUSE employee has none.
  await col("userpermissions").insertMany(
    [ASHA, BEN, CHIT, RAVI].map((u) => ({
      userId: u.sub, email: u.email, workspaceId: String(HOUSE), universe: "STAFF", status: "active", source: "manual",
      level: { code: "L1", name: "Employee", designation: "" }, modules: { adminQueue: { access: "WRITE", scope: "ALL" } },
    })) as any[],
  );
  await col("customers").insertOne({
    _id: CUSTOMER_ID, name: "Acme", workspaceId: WS,
    accountTeam: { accountManager: { userId: new mongoose.Types.ObjectId(RAVI.sub), name: "Ravi", email: RAVI.email } },
  } as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  sent.length = 0;
  await col("approvalrequests").deleteMany({});
  await col("traveldesksettings").deleteMany({});
  await col("customers").updateOne(
    { _id: CUSTOMER_ID },
    { $set: { accountTeam: { accountManager: { userId: new mongoose.Types.ObjectId(RAVI.sub), name: "Ravi", email: RAVI.email } } } },
  );
});

describe("team and picker", () => {
  it("the Assign picker lists only team agents; only Plumtrips ops staff can join the team", async () => {
    const s = await setDesk({ mode: "off", agents: [{ userId: ASHA.sub }, { userId: BEN.sub, available: false }] });
    expect(s.candidates.map((c: any) => c.email)).toEqual(expect.arrayContaining([ASHA.email, BEN.email, CHIT.email, RAVI.email]));
    expect(s.candidates.map((c: any) => c.email)).not.toContain(HOUSE_EMPLOYEE.email);

    const picker = await asStaff(request(app).get("/api/approvals/travel-desk/agents"));
    expect(picker.status).toBe(200);
    expect(picker.body.agents.map((a: any) => [a.email, a.available])).toEqual([[ASHA.email, true], [BEN.email, false]]);

    const bad = await asStaff(request(app).put("/api/approvals/travel-desk/settings")).send({ agents: [{ userId: HOUSE_EMPLOYEE.sub }] });
    expect([bad.status, bad.body.code]).toEqual([400, "NOT_ELIGIBLE"]);
  });

  it("non-staff cannot read or change settings, toggle availability, assign or unassign", async () => {
    await setDesk({ mode: "off", agents: [{ userId: ASHA.sub }] });
    const id = await approvedRequest();
    for (const [who, ws] of [[REQUESTER, WS], [APPROVER_USER, WS], [LEADER, WS], [HOUSE_EMPLOYEE, HOUSE]] as const) {
      expect((await as(request(app).get("/api/approvals/travel-desk/settings"), who, ws)).status).toBe(403);
      expect((await as(request(app).put("/api/approvals/travel-desk/settings"), who, ws).send({ mode: "round_robin" })).status).toBe(403);
      expect((await as(request(app).patch(`/api/approvals/travel-desk/agents/${ASHA.sub}`), who, ws).send({ available: false })).status).toBe(403);
      expect((await as(request(app).get("/api/approvals/travel-desk/agents"), who, ws)).status).toBe(403);
      expect((await as(request(app).put(`/api/approvals/admin/${id}/assign`), who, ws).send({ agentUserId: ASHA.sub })).status).toBe(403);
      expect((await as(request(app).put(`/api/approvals/admin/${id}/unassign`), who, ws).send({})).status).toBe(403);
    }
    expect(await assignee(id)).toBeNull();
    expect((await col("traveldesksettings").findOne({}))!.mode).toBe("off");
  });
});

describe("manual assign / reassign / unassign", () => {
  it("assigns a team agent (Away allowed by hand), refuses anyone else, reassigns, unassigns — all in the activity", async () => {
    await setDesk({ mode: "off", agents: [{ userId: ASHA.sub }, { userId: BEN.sub, available: false }] });
    const id = await approvedRequest();

    const outsider = await asStaff(request(app).put(`/api/approvals/admin/${id}/assign`)).send({ agentUserId: CHIT.sub });
    expect([outsider.status, outsider.body.code]).toEqual([400, "NOT_TEAM_AGENT"]);

    const a = await asStaff(request(app).put(`/api/approvals/admin/${id}/assign`)).send({ agentUserId: ASHA.sub, comment: "Corporate fare" });
    expect(a.status).toBe(200);
    let doc = await stored(id);
    expect([doc.adminState, doc.meta.adminAssigned.userId, doc.meta.adminAssigned.via]).toEqual(["assigned", ASHA.sub, "manual"]);

    const away = await asStaff(request(app).put(`/api/approvals/admin/${id}/assign`)).send({ agentUserId: BEN.sub });
    expect(away.status).toBe(200);
    expect(await assignee(id)).toBe(BEN.sub);

    const un = await asStaff(request(app).put(`/api/approvals/admin/${id}/unassign`)).send({ comment: "back to pool" });
    expect(un.status).toBe(200);
    doc = await stored(id);
    expect([doc.adminState, doc.meta.adminAssigned]).toEqual(["pending", undefined]);

    const acts = doc.history.map((h: any) => [h.action, h.staffNote || ""]);
    expect(acts).toEqual(expect.arrayContaining([
      ["admin_assigned", expect.stringContaining(`Assigned to Asha <${ASHA.email}>`)],
      ["admin_reassigned", expect.stringContaining("(was Asha)")],
      ["admin_unassigned", "Unassigned from Ben — Note: back to pool"],
    ]));
    // The note is staff-only: in staffNote, never in the comment customers can read.
    const assignedRow = doc.history.find((h: any) => h.action === "admin_assigned");
    expect(assignedRow.comment).toBeUndefined();
    expect(assignedRow.staffNote).toContain("Note: Corporate fare");
  });

  it("customers see only a bare \"Assigned\" row — no agent, no assigner, no note (old rows too)", async () => {
    await setDesk({ mode: "off", agents: [{ userId: ASHA.sub }] });
    const id = await approvedRequest();
    await asStaff(request(app).put(`/api/approvals/admin/${id}/assign`)).send({ agentUserId: ASHA.sub, comment: "VIP — call before booking" });
    // An older row written before this change: note in the comment, staff name/email on it.
    await col("approvalrequests").updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $push: { history: { action: "admin_assigned", at: new Date(), by: BEN.sub, comment: "Legacy note", userName: "Ben", userEmail: BEN.email } } } as any,
    );
    for (const who of [REQUESTER, APPROVER_USER, LEADER]) {
      const got = await as(request(app).get(`/api/approvals/requests/${id}`), who, WS);
      const rows = got.body.request.history.filter((h: any) => h.action === "admin_assigned");
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(Object.keys(r).sort()).toEqual(["action", "at"]);
      const body = JSON.stringify(got.body);
      // (The traveller is "Asha Guest", so the agent is checked by email and id.)
      for (const leak of ["VIP", "Legacy note", "\"Ben\"", BEN.email, ASHA.email, ASHA.sub, BEN.sub]) expect(body, leak).not.toContain(leak);
    }
    const staff = await asStaff(request(app).get(`/api/approvals/admin/requests/${id}`));
    expect(JSON.stringify(staff.body)).toContain("Note: VIP — call before booking");
  });

  it("emails the assignee: request no, customer, route/dates and a link to the ops queue item", async () => {
    await setDesk({ mode: "off", agents: [{ userId: ASHA.sub }] });
    const id = await approvedRequest();
    sent.length = 0;
    await asStaff(request(app).put(`/api/approvals/admin/${id}/assign`)).send({ agentUserId: ASHA.sub });
    const mail = sent.find((m) => m.to === ASHA.email)!;
    expect(mail).toBeTruthy();
    const doc = await stored(id);
    // Same code the ops queue shows (ticketId, else REQ- + last 6 of the id).
    expect(mail.subject).toContain(doc.ticketId || `REQ-${String(id).slice(-6).toUpperCase()}`);
    expect(mail.subject).toContain("Acme");
    expect(mail.html).toContain("Flight · BLR → DEL");
    expect(mail.html).toContain("2 Apr 2027");
    expect(mail.html).toContain(`/admin/approvals?request=${id}`);
    expect(mail.html).not.toMatch(/₹|INR/);
  });

  it("customers never receive the assignee, the staff notes or the Travel Desk-only rows", async () => {
    await setDesk({ mode: "round_robin", agents: [{ userId: ASHA.sub }, { userId: BEN.sub }] });
    const id = await approvedRequest(); // auto-assigned
    await asStaff(request(app).put(`/api/approvals/admin/${id}/assign`)).send({ agentUserId: BEN.sub }); // reassigned
    for (const who of [REQUESTER, APPROVER_USER, LEADER]) {
      const got = await as(request(app).get(`/api/approvals/requests/${id}`), who, WS);
      expect(got.status).toBe(200);
      const body = JSON.stringify(got.body);
      for (const leak of ["adminAssigned", "staffNote", "admin_auto_assigned", "admin_reassigned", ASHA.email, BEN.email]) {
        expect(body, `${who.email}: ${leak}`).not.toContain(leak);
      }
    }
    const staff = await asStaff(request(app).get(`/api/approvals/admin/requests/${id}`));
    expect(JSON.stringify(staff.body)).toContain("admin_auto_assigned");
  });
});

describe("auto-allocation when a request enters the ops queue", () => {
  it("mode Off: nothing is assigned", async () => {
    await setDesk({ mode: "off", agents: [{ userId: ASHA.sub }] });
    const id = await approvedRequest();
    expect(await assignee(id)).toBeNull();
    expect((await stored(id)).meta.assignmentFlag).toBeUndefined();
  });

  it("round robin rotates in team order and skips Away agents (persisted pointer)", async () => {
    await setDesk({ mode: "round_robin", rmFirst: false, agents: [{ userId: ASHA.sub }, { userId: BEN.sub }, { userId: CHIT.sub, available: false }] });
    const got = [];
    for (let i = 0; i < 4; i++) got.push(await assignee(await approvedRequest()));
    expect(got).toEqual([ASHA.sub, BEN.sub, ASHA.sub, BEN.sub]);

    const doc = await stored((await col("approvalrequests").find().sort({ createdAt: 1 }).toArray())[0]._id);
    expect(doc.history.find((h: any) => h.action === "admin_auto_assigned").staffNote).toContain("auto: Round robin");
    expect((await col("traveldesksettings").findOne({}))!.rrLastUserId.toString()).toBe(BEN.sub);
  });

  it("least busy picks the agent with the fewest open cases; ties rotate", async () => {
    await setDesk({ mode: "least_busy", rmFirst: false, agents: [{ userId: ASHA.sub }, { userId: BEN.sub }] });
    // Asha already holds two open cases.
    await col("approvalrequests").insertMany([1, 2].map(() => ({
      workspaceId: WS, customerId: String(CUSTOMER_ID), status: "approved", adminState: "in_progress",
      meta: { adminAssigned: { userId: ASHA.sub } }, cartItems: [], history: [],
    })) as any[]);
    expect(await assignee(await approvedRequest())).toBe(BEN.sub); // 0 vs 2
    expect(await assignee(await approvedRequest())).toBe(BEN.sub); // 1 vs 2
    const third = await approvedRequest(); // 2 vs 2 → tie → rotate past Ben
    expect(await assignee(third)).toBe(ASHA.sub);
    expect((await stored(third)).meta.adminAssigned.reason).toBe("least_busy");
  });

  it("the customer's Account Manager first when on the team and Available; otherwise the mode's pick", async () => {
    await setDesk({ mode: "round_robin", rmFirst: true, agents: [{ userId: ASHA.sub }, { userId: RAVI.sub }] });
    const rmCase = await approvedRequest();
    expect(await assignee(rmCase)).toBe(RAVI.sub);
    expect((await stored(rmCase)).meta.adminAssigned.reason).toBe("rm");

    // RM Away → falls back to round robin (the RM pick did not move the pointer, so Asha is next).
    const toggle = await asStaff(request(app).patch(`/api/approvals/travel-desk/agents/${RAVI.sub}`)).send({ available: false });
    expect(toggle.status).toBe(200);
    const fallback = await approvedRequest();
    expect([await assignee(fallback), (await stored(fallback)).meta.adminAssigned.reason]).toEqual([ASHA.sub, "round_robin"]);

    // RM not on the team → fallback; RM-first off → straight to the mode.
    await setDesk({ agents: [{ userId: ASHA.sub }, { userId: BEN.sub }] });
    expect((await stored(await approvedRequest())).meta.adminAssigned.reason).toBe("round_robin");
    await setDesk({ rmFirst: false, agents: [{ userId: ASHA.sub }, { userId: RAVI.sub }] });
    expect((await stored(await approvedRequest())).meta.adminAssigned.reason).toBe("round_robin");
  });

  it("an Account Manager set by staff in the Account Team editor is picked first (customer stored on its own workspace)", async () => {
    // Staff (HOUSE ADMIN) change Acme's Account Manager to Chit through the real editor.
    const set = await asStaff(request(app).patch(`/api/customers/${CUSTOMER_ID}/account-team`)).send({ accountManager: { userId: CHIT.sub } });
    expect(set.status).toBe(200);
    await setDesk({ mode: "round_robin", rmFirst: true, agents: [{ userId: ASHA.sub }, { userId: CHIT.sub }] });
    const id = await approvedRequest();
    expect([await assignee(id), (await stored(id)).meta.adminAssigned.reason]).toEqual([CHIT.sub, "rm"]);
  });

  it("no available agent: left unassigned and flagged for the queue; the flag clears when someone takes it", async () => {
    await setDesk({ mode: "round_robin", agents: [{ userId: ASHA.sub, available: false }] });
    const id = await approvedRequest();
    let doc = await stored(id);
    expect([doc.adminState, doc.meta.adminAssigned, doc.meta.assignmentFlag?.code]).toEqual(["pending", undefined, "NO_AGENT_AVAILABLE"]);
    expect(sent.some((m) => m.to === ASHA.email)).toBe(false);

    await asStaff(request(app).put(`/api/approvals/admin/${id}/assign`)).send({ agentUserId: ASHA.sub });
    doc = await stored(id);
    expect([doc.meta.adminAssigned.userId, doc.meta.assignmentFlag]).toEqual([ASHA.sub, undefined]);
  });

  it("auto-assignment emails the assignee and never re-allocates a held case", async () => {
    await setDesk({ mode: "round_robin", rmFirst: false, agents: [{ userId: ASHA.sub }, { userId: BEN.sub }] });
    const id = await approvedRequest();
    const mail = sent.find((m) => m.to === ASHA.email);
    expect(mail?.html).toContain("Auto-assigned (Round robin)");
    expect(await autoAllocate(id)).toEqual({ skipped: "already_assigned" });
    expect(await assignee(id)).toBe(ASHA.sub);
  });
});
