// apps/backend/src/routes/approvals.actorNames.test.ts
//
// Activity rows name PEOPLE (services/actorNames.ts):
//   - assign / unassign / hold / book show the staff member's profile name
//     (first + last), with the assignee, on staff screens
//   - auto-assign and auto-approve are "System"
//   - older rows that carry only a user id (or an email) resolve to profile
//     names in ONE batched lookup per response
//   - no 24-hex id appears as a name in any approvals / proposals / booking
//     history response
//   - customer-side responses and emails never carry a staff name or email:
//     staff read "Plumtrips Travel Desk"; customers keep their own names
//
// Real: approvals, proposals and bookingHistory routers, Travel Desk, the
// actor resolver, in-memory Mongo. Stubbed: requireAuth (user from a header),
// requireWorkspace (workspace from a header), mail (captured), email tokens, TBO.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

const mails: Array<{ to: string; subject: string; html: string }> = [];

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
    mails.push({ to: String(m?.to || ""), subject: String(m?.subject || ""), html: String(m?.html || "") });
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
vi.mock("../utils/emailActionToken.js", () => ({ signEmailActionToken: () => "tok", verifyEmailActionToken: () => null, hashToken: () => "hash" }));

const { default: approvalsRouter } = await import("./approvals.js");
const { default: proposalsRouter } = await import("./proposals.js");
const { default: bookingHistoryRouter } = await import("./bookingHistory.js");
const { default: UserModel } = await import("../models/User.js");

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);
app.use("/api/proposals", proposalsRouter);
app.use("/api/booking-history", bookingHistoryRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const WS = oid();
const CUSTOMER_ID = oid();
const HEX = /\b[a-f0-9]{24}\b/i;

type Who = { sub: string; email: string; first: string; last: string; roles: string[]; ws: any };
const person = (first: string, last: string, email: string, roles: string[], ws: any = HOUSE): Who => ({ sub: String(oid()), email, first, last, roles, ws });
// The token's `name` is deliberately NOT the profile name: the profile must win.
const NEEL = person("Neel", "Bhatia", "neel@plumtrips.com", ["ADMIN"]); // HOUSE ADMIN, does the clicking
const CHIRAG = person("Chirag", "Kapoor", "chirag@plumtrips.com", ["EMPLOYEE"]); // agent
const ASHA = person("Asha", "Rao", "asha@acme.test", ["EMPLOYEE"], WS); // requester
const MEERA = person("Meera", "Iyer", "approver@acme.test", ["EMPLOYEE"], WS); // approver
const LEADER = person("Lata", "Menon", "leader@acme.test", ["WORKSPACE_LEADER"], WS);
const STAFF_STRINGS = ["Neel", "Bhatia", "neel@plumtrips.com", "Chirag", "Kapoor", "chirag@plumtrips.com"];

const as = (r: request.Test, who: Who) =>
  r
    .set("x-test-user", JSON.stringify({ sub: who.sub, email: who.email, name: who.email.split("@")[0], roles: who.roles, workspaceId: String(who.ws), customerId: String(who.ws) }))
    .set("x-test-ws", String(who.ws));

async function submitAndApprove(by: Who = ASHA) {
  const created = await as(request(app).post("/api/approvals/requests"), by).send({
    customerId: String(CUSTOMER_ID),
    cartItems: [{ type: "flight", title: "BLR → DEL", qty: 1, price: 0, meta: { origin: "BLR", destination: "DEL", tripType: "oneway", departDate: "2026-11-02", travelScope: "domestic", travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }] } }],
    comments: "For Client Visit",
  });
  expect(created.status).toBe(200);
  const id = String(created.body.request._id);
  if (by !== LEADER) expect((await as(request(app).put(`/api/approvals/requests/${id}/action`), MEERA).send({ action: "approved" })).status).toBe(200);
  return id;
}
const staffHistory = async (id: string) => (await as(request(app).get(`/api/approvals/admin/requests/${id}`), NEEL)).body.history as any[];
const row = (hist: any[], action: string) => hist.filter((h) => h.action === action).pop();

/** Every name-ish field in every activity-like object of a body. */
function namesIn(body: any): string[] {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    for (const k of ["actorName", "userName", "byName", "doneByName", "assigneeName"]) if (typeof n[k] === "string") out.push(n[k]);
    Object.values(n).forEach(walk);
  };
  walk(body);
  return out;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-actor-names-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  mails.length = 0;
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    { _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE", config: { features: {} } },
    { _id: WS, customerId: String(CUSTOMER_ID), name: "Acme", companyName: "Acme", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [MEERA.email], config: { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } } },
  ] as any[]);
  await col("customermembers").insertOne({ customerId: String(CUSTOMER_ID), email: LEADER.email, role: "WORKSPACE_LEADER", isActive: true } as any);
  await col("users").insertMany(
    [NEEL, CHIRAG, ASHA, MEERA, LEADER].map((u) => ({
      _id: new mongoose.Types.ObjectId(u.sub), workspaceId: u.ws, email: u.email, firstName: u.first, lastName: u.last, name: u.email,
      roles: u.roles, status: "ACTIVE", passwordHash: "x",
    })) as any[],
  );
  await col("userpermissions").insertOne({
    userId: CHIRAG.sub, email: CHIRAG.email, workspaceId: String(HOUSE), universe: "STAFF", status: "active", source: "manual",
    level: { code: "L1", name: "Employee", designation: "" }, modules: { adminQueue: { access: "FULL", scope: "ALL" } },
  } as any);
  await as(request(app).put("/api/approvals/travel-desk/settings"), NEEL).send({ mode: "off", agents: [{ userId: CHIRAG.sub }] });
});

describe("staff screens name the person who acted", () => {
  it("assign and unassign show the staff member's profile name and the assignee; submit shows the requester", async () => {
    const id = await submitAndApprove();
    expect((await as(request(app).put(`/api/approvals/admin/${id}/assign`), NEEL).send({ agentUserId: CHIRAG.sub })).status).toBe(200);
    expect((await as(request(app).put(`/api/approvals/admin/${id}/unassign`), NEEL).send({})).status).toBe(200);

    const hist = await staffHistory(id);
    expect(row(hist, "admin_assigned")).toMatchObject({ actorName: "Neel Bhatia", actorKind: "staff", assigneeName: "Chirag Kapoor" });
    expect(row(hist, "admin_unassigned")).toMatchObject({ actorName: "Neel Bhatia", actorKind: "staff", assigneeName: "Chirag Kapoor" });
    expect(row(hist, "submitted")).toMatchObject({ actorName: "Asha Rao", actorKind: "customer" });
    expect(row(hist, "approved")).toMatchObject({ actorName: "Meera Iyer", actorKind: "customer" });
    for (const n of namesIn(hist)) expect(n, "a raw id shown as a name").not.toMatch(HEX);
  });

  it("auto events are System: auto-assign and auto-approve", async () => {
    await as(request(app).put("/api/approvals/travel-desk/settings"), NEEL).send({ mode: "round_robin", rmFirst: false, agents: [{ userId: CHIRAG.sub }] });
    const id = await submitAndApprove(LEADER); // a Workspace Leader's request is auto-approved, then auto-assigned
    const hist = await staffHistory(id);
    expect(row(hist, "approved")).toMatchObject({ actorName: "System", actorKind: "system" });
    expect(row(hist, "admin_auto_assigned")).toMatchObject({ actorName: "System", actorKind: "system", assigneeName: "Chirag Kapoor" });
  });

  it("older rows with only a user id or an email resolve to profile names, in one batched lookup", async () => {
    const id = await submitAndApprove();
    // Rows as production wrote them before this change: no actorName / actorKind.
    await col("approvalrequests").updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      {
        $set: {
          history: [
            { action: "submitted", at: new Date(), by: ASHA.sub, userEmail: "", userName: "" },
            { action: "admin_assigned", at: new Date(), by: NEEL.sub, userEmail: NEEL.email, userName: "", staffNote: "Assigned to Chirag Kapoor <chirag@plumtrips.com>" },
            { action: "admin_unassigned", at: new Date(), by: NEEL.sub, staffNote: "Unassigned from Chirag Kapoor" },
            { action: "booking_started", at: new Date(), by: NEEL.email },
          ],
        },
      },
    );
    const spy = vi.spyOn(UserModel, "find");
    const hist = await staffHistory(id);
    const lookups = spy.mock.calls.filter((c: any[]) => Array.isArray(c[0]?.$or));
    spy.mockRestore();
    expect(lookups).toHaveLength(1);
    expect(hist.map((h) => [h.action, h.actorName, h.actorKind])).toEqual([
      ["submitted", "Asha Rao", "customer"],
      ["admin_assigned", "Neel Bhatia", "staff"],
      ["admin_unassigned", "Neel Bhatia", "staff"],
      ["booking_started", "Neel Bhatia", "staff"],
    ]);
  });
});

describe("customer-side responses and emails never name staff", () => {
  it("request detail, my requests and booking history: staff read 'Plumtrips Travel Desk'; customers keep their names; no ids as names", async () => {
    const id = await submitAndApprove();
    expect((await as(request(app).put(`/api/approvals/admin/${id}/assign`), NEEL).send({ agentUserId: CHIRAG.sub })).status).toBe(200);
    expect((await as(request(app).put(`/api/approvals/admin/${id}/on-hold`), NEEL).send({ comment: "Waiting for fares" })).status).toBe(200);
    expect((await as(request(app).put(`/api/approvals/admin/${id}/start-booking`), NEEL).send({})).status).toBe(200);
    expect((await as(request(app).put(`/api/approvals/admin/${id}/done`), NEEL).send({ comment: "Ticketed" })).status).toBe(200);

    for (const [path, who] of [
      [`/api/approvals/requests/${id}`, ASHA],
      ["/api/approvals/requests/mine", ASHA],
      ["/api/booking-history/history", ASHA],
      ["/api/booking-history/history", LEADER],
    ] as const) {
      const res = await as(request(app).get(path), who);
      expect(res.status, path).toBe(200);
      const text = JSON.stringify(res.body);
      for (const s of STAFF_STRINGS) expect(text, `${path} (${who.first}) leaks "${s}"`).not.toContain(s);
      expect(text, path).toContain("Plumtrips Travel Desk");
      expect(text, path).toContain("Asha Rao");
      for (const n of namesIn(res.body)) expect(n, `${path}: a raw id shown as a name`).not.toMatch(HEX);
    }

    // The "booking processed" email to the requester names the travel desk only.
    const processed = mails.find((m) => /Processed/i.test(m.subject));
    expect(processed).toBeTruthy();
    for (const s of STAFF_STRINGS) expect(processed!.html, `email leaks "${s}"`).not.toContain(s);
    expect(processed!.html).toContain("Plumtrips Travel Desk");
  });

  it("a proposal decision recorded by staff on the customer's behalf reads 'Plumtrips Travel Desk' for the customer", async () => {
    const id = await submitAndApprove();
    const draft = await as(request(app).post(`/api/proposals/by-request/${id}/draft`), NEEL).send({});
    const pid = String(draft.body.proposal._id);
    const option = { optionNo: 1, title: "6E-201", currency: "INR", totalAmount: 0, attachments: [], lineItems: [{ itemIndex: 1, category: "flight", title: "6E-201", qty: 1, unitPrice: 5000, totalPrice: 5000, currency: "INR" }] };
    expect((await as(request(app).put(`/api/proposals/${pid}`), NEEL).send({ options: [option] })).status).toBe(200);
    expect((await as(request(app).post(`/api/proposals/${pid}/submit`), NEEL).send({})).status).toBe(200);
    mails.length = 0;
    expect((await as(request(app).post(`/api/proposals/${pid}/record-decision`), NEEL).send({ decision: "APPROVED", note: "Meera approved on the phone" })).status).toBe(200);

    // Customer view (the approver): no staff name or email anywhere.
    const customer = await as(request(app).get(`/api/proposals/${pid}`), MEERA);
    expect(customer.status).toBe(200);
    const text = JSON.stringify(customer.body);
    for (const s of STAFF_STRINGS) expect(text, `proposal leaks "${s}"`).not.toContain(s);
    expect(customer.body.proposal.approvals.l2.byName).toBe("Plumtrips Travel Desk");
    expect(String(customer.body.proposal.approvals.l2.comment || "")).toContain("Recorded by Plumtrips Travel Desk");

    // The decision email to the approver and leaders.
    const decided = mails.find((m) => /Proposal approved/i.test(m.subject));
    expect(decided).toBeTruthy();
    for (const s of STAFF_STRINGS) expect(decided!.html, `email leaks "${s}"`).not.toContain(s);

    // Staff still see who recorded it.
    const staff = await as(request(app).get(`/api/proposals/${pid}`), NEEL);
    const rec = (staff.body.proposal.history as any[]).find((h) => h.action === "RECORDED_APPROVED");
    expect(rec).toMatchObject({ actorName: "Neel Bhatia", actorKind: "staff" });
  });
});
