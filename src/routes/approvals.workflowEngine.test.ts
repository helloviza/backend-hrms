// apps/backend/src/routes/approvals.workflowEngine.test.ts
//
// S2: the approval-workflow step engine, end to end through the real routes,
// with a THREE-approver chain (department head → reporting manager → default
// approver), although StatusNeo uses one:
//   - submit writes the snapshot; the first step's assignee is the approver
//     and the only one emailed a decision link (D3);
//   - a later step's assignee can't act early; deciding a step moves the
//     request on (pending, REQUEST_RAISED) and emails the next step;
//   - stale step links are refused (step decided, round changed, no claim);
//   - first decision wins per step; a decline at any step ends the request;
//   - resubmit restarts the same chain (D5), round 2;
//   - leadersMayDecide ALLOW / DENY / OVERRIDE_WITH_REASON (reason required,
//     in-app only, recorded, shown in emails);
//   - the last approval lands exactly where today's does (Flow 3
//     REQUEST_APPROVED + ops queue; Flow 2 PROPOSAL_PENDING).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  JWT_SECRET: "jwt-secret-for-tests",
  JWT_REFRESH_SECRET: "refresh-secret-for-tests",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
})) process.env[k] ||= v;

const { mails } = vi.hoisted(() => ({ mails: [] as any[] }));

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
    mails.push(m);
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

const { default: approvalsRouter } = await import("./approvals.js");
const { default: approvalLinksRouter } = await import("./approvalLinks.js");
const { saveWorkflowDraft, publishWorkflowDraft } = await import("../services/approvalWorkflow/store.js");
const { signApprovalLink } = await import("../utils/approvalLinkToken.js");
const { DESK_EMAIL } = await import("../services/actorNames.js");

const app = express();
app.use(express.json());
app.use("/api/public/approval-links", approvalLinksRouter);
app.use("/api/approvals", approvalsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const WS = oid(); // Flow 3
const WS2 = oid(); // Flow 2
const DEPT = oid();
const DEPT2 = oid();

type Who = { sub: string; email: string; name: string; roles: string[]; ws: any };
const who = (email: string, name: string, ws: any, roles = ["EMPLOYEE"]): Who => ({ sub: String(oid()), email, name, roles, ws });
const EMP = who("emp@sn.test", "Esha Employee", WS);
const HEAD = who("head@sn.test", "Hari Head", WS);
const RM = who("rm@sn.test", "Mira Manager", WS);
const DEF = who("def@sn.test", "Dev Default", WS);
const WL = who("wl@sn.test", "Lata Leader", WS, ["WORKSPACE_LEADER"]);
const EMP2 = who("emp@f2.test", "Ravi Two", WS2);
const HEAD2 = who("head@f2.test", "Hema Head", WS2);
const PEOPLE = [EMP, HEAD, RM, DEF, WL, EMP2, HEAD2];

const as = (r: request.Test, w: Who) =>
  r
    .set("x-test-user", JSON.stringify({ sub: w.sub, _id: w.sub, email: w.email, name: w.name, roles: w.roles, workspaceId: String(w.ws) }))
    .set("x-test-ws", String(w.ws));

const flight = {
  type: "flight", title: "BLR → BOM", qty: 1, price: 0,
  meta: { origin: "BLR", destination: "BOM", tripType: "oneway", departDate: "2027-03-12", travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }] },
};
const submit = (w: Who = EMP) => as(request(app).post("/api/approvals/requests"), w).send({ cartItems: [flight], comments: "Client visit" });
const act = (id: any, w: Who, action: string, comment?: string) =>
  as(request(app).put(`/api/approvals/requests/${String(id)}/action`), w).send({ action, comment });
const getReq = async (id: any) => (await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(id)) })) as any;

const chain = (leadersMayDecide: string) => ({
  enabled: true,
  leadersMayDecide,
  steps: [
    { key: "head", label: "Department head approval", type: "DEPARTMENT_HEAD", role: "APPROVER", fallback: "DEFAULT_APPROVER" },
    { key: "rm", label: "Reporting manager approval", type: "REPORTING_MANAGER", role: "APPROVER", fallback: "SKIP" },
    { key: "def", label: "Travel approver", type: "DEFAULT_APPROVER", role: "APPROVER", fallback: "REFUSE_SUBMIT" },
  ],
});
const actor = { id: "", name: "test", email: "", kind: "SCRIPT" as const, roles: [] };
async function publish(ws: any, cfg: any) {
  await saveWorkflowDraft({ workspaceId: ws, config: cfg, actor });
  await publishWorkflowDraft({ workspaceId: ws, actor, changeSummary: "test" });
}

/** The decision links in the latest mail to `email`: { approve, decline, clarify } tokens. */
function linksFor(email: string) {
  const m = [...mails].reverse().find((x) => [x.to].flat().map(String).includes(email));
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const [, tok, intent] of String(m.html).matchAll(/token=([^&"]+)&(?:amp;)?intent=(\w+)/g)) out[intent] = decodeURIComponent(tok);
  return out;
}
const mailsTo = (email: string) => mails.filter((x) => [x.to].flat().map(String).includes(email));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-workflow-engine-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  mails.length = 0;
  const flow3 = { travelFlow: "APPROVAL_DIRECT", features: { approvalDirectEnabled: true } };
  const flow2 = { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } };
  await col("customerworkspaces").insertMany([
    { _id: WS, customerId: "SN", name: "StatusNeo", companyName: "StatusNeo", status: "ACTIVE", defaultApproverEmails: [DEF.email], config: flow3 },
    { _id: WS2, customerId: "F2", name: "Flow Two", companyName: "Flow Two", status: "ACTIVE", defaultApproverEmails: [], config: flow2 },
  ] as any[]);
  await col("users").insertMany(
    PEOPLE.map((p) => ({ _id: new mongoose.Types.ObjectId(p.sub), workspaceId: p.ws, email: p.email, firstName: p.name.split(" ")[0], lastName: p.name.split(" ")[1], roles: p.roles, status: "ACTIVE" })) as any[],
  );
  await col("customermembers").insertMany([
    { customerId: "SN", workspaceId: WS, email: WL.email, role: "WORKSPACE_LEADER", isActive: true },
    { customerId: "F2", workspaceId: WS2, email: "wl@f2.test", role: "WORKSPACE_LEADER", isActive: true },
  ] as any[]);
  await col("departments").insertMany([
    { _id: DEPT, workspaceId: WS, name: "Engineering", isActive: true, managerId: new mongoose.Types.ObjectId(HEAD.sub) },
    { _id: DEPT2, workspaceId: WS2, name: "Sales", isActive: true, managerId: new mongoose.Types.ObjectId(HEAD2.sub) },
  ] as any[]);
  await col("travellerprofiles").insertMany([
    { workspaceId: WS, firstName: "Esha", lastName: "Employee", email: EMP.email, isActive: true, claimedBy: new mongoose.Types.ObjectId(EMP.sub), departmentId: DEPT, reportingManagerId: new mongoose.Types.ObjectId(RM.sub) },
    { workspaceId: WS2, firstName: "Ravi", lastName: "Two", email: EMP2.email, isActive: true, claimedBy: new mongoose.Types.ObjectId(EMP2.sub), departmentId: DEPT2 },
  ] as any[]);
});

describe("a three-approver chain", () => {
  it("submit snapshots the chain; only the first step's assignee gets a decision link", async () => {
    await publish(WS, chain("DENY"));
    const r = await submit();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const doc = await getReq(r.body.request._id);
    expect(doc).toMatchObject({ status: "pending", stage: "REQUEST_RAISED", managerEmail: HEAD.email, managerName: "Hari Head" });
    expect(doc.workflow).toMatchObject({ round: 1, currentStep: 0, pendingEmails: [HEAD.email], leadersMayDecide: "DENY", versionNumber: 1 });
    expect(doc.workflow.steps.map((s: any) => [s.key, s.status, s.assignees.map((a: any) => a.email), s.resolvedVia])).toEqual([
      ["head", "PENDING", [HEAD.email], "DEPARTMENT_HEAD"],
      ["rm", "WAITING", [RM.email], "REPORTING_MANAGER"],
      ["def", "WAITING", [DEF.email], "DEFAULT_APPROVER"],
    ]);
    expect(linksFor(HEAD.email)).toHaveProperty("approve");
    // The Workspace Leader and later steps get no decision link.
    expect(mailsTo(WL.email)).toHaveLength(0);
    expect(mailsTo(RM.email)).toHaveLength(0);
    expect(mailsTo(DEF.email)).toHaveLength(0);
    expect(mailsTo(EMP.email)).toHaveLength(1); // the confirmation
  });

  it("walks head (email link) → manager (app) → default approver (app) to REQUEST_APPROVED and the ops queue", async () => {
    await publish(WS, chain("DENY"));
    const id = (await submit()).body.request._id;

    // A later step's assignee cannot act early.
    expect((await act(id, RM, "approved")).body.code).toBe("NOT_AN_APPROVER");

    const headLinks = linksFor(HEAD.email)!;
    const view = await request(app).get(`/api/public/approval-links/${headLinks.approve}`);
    expect(view.body.link).toMatchObject({ state: "OPEN", step: "Department head approval", actions: ["approve", "decline", "clarify"] });
    mails.length = 0;
    const r1 = await request(app).post(`/api/public/approval-links/${headLinks.approve}`).send({ action: "approve" });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    let doc = await getReq(id);
    expect(doc).toMatchObject({ status: "pending", stage: "REQUEST_RAISED", managerEmail: RM.email });
    expect(doc.workflow).toMatchObject({ currentStep: 1, pendingEmails: [RM.email] });
    expect(doc.workflow.steps[0]).toMatchObject({ status: "APPROVED", decidedBy: { email: HEAD.email, via: "email", override: false } });
    expect(doc.history.at(-1)).toMatchObject({ action: "email_step_approved", userEmail: HEAD.email });
    // The next step is told, with its own links; the requester hears nothing yet.
    expect(mails.map((m) => String(m.to))).toEqual([RM.email]);
    expect(linksFor(RM.email)).toHaveProperty("approve");

    // The head's other links (decline, clarify) are for a step already decided.
    const stale = await request(app).post(`/api/public/approval-links/${headLinks.decline}`).send({ action: "decline", reason: "x" });
    expect([stale.status, stale.body.code]).toEqual([409, "STEP_ALREADY_DECIDED"]);
    const staleView = await request(app).get(`/api/public/approval-links/${headLinks.decline}`);
    expect(staleView.body.link).toMatchObject({ state: "DECIDED", stale: true, actions: [] });
    // The head can no longer act in-app either.
    expect((await act(id, HEAD, "approved")).body.code).toBe("NOT_AN_APPROVER");

    // The step-2 approver sees it in their inbox, decidable.
    const inbox = await as(request(app).get("/api/approvals/requests/inbox?view=all"), RM);
    const row = inbox.body.rows.find((x: any) => String(x._id) === String(id));
    expect(row).toMatchObject({ _bucket: "pending", _workflow: { role: "APPROVER", canDecide: true, canOverride: false } });

    expect((await act(id, RM, "approved", "fine")).status).toBe(200);
    doc = await getReq(id);
    expect(doc.workflow).toMatchObject({ currentStep: 2, pendingEmails: [DEF.email] });
    mails.length = 0;
    expect((await act(id, DEF, "approved")).status).toBe(200);
    doc = await getReq(id);
    expect(doc).toMatchObject({ status: "approved", stage: "REQUEST_APPROVED", adminState: "pending", approvedByEmail: DEF.email });
    expect(doc.workflow.currentStep).toBe(-1);
    expect(doc.workflow.steps.map((s: any) => s.status)).toEqual(["APPROVED", "APPROVED", "APPROVED"]);
    expect(doc.history.at(-1)).toMatchObject({ action: "approved", userEmail: DEF.email });
    // Same emails as today's approval: requester, FYI to the other approvers, the ops desk.
    const to = mails.map((m) => [m.to].flat().map(String).join(","));
    expect(to).toContain(EMP.email);
    expect(to).toContain(DESK_EMAIL);
    expect(mails.some((m) => String(m.to).includes(HEAD.email) && /approved/i.test(String(m.subject)))).toBe(true);
  });

  it("first decision wins on a step", async () => {
    await publish(WS, chain("DENY"));
    const id = (await submit()).body.request._id;
    // Two links to the head for the same step (e.g. the original and a resend).
    const doc = await getReq(id);
    const claim = `1.0.head`;
    expect(doc.workflow.round).toBe(1);
    const a = signApprovalLink({ kind: "request", id: String(id), email: HEAD.email, step: claim }, 72)!;
    const b = signApprovalLink({ kind: "request", id: String(id), email: HEAD.email, step: claim }, 72)!;
    const [ra, rb] = await Promise.all([
      request(app).post(`/api/public/approval-links/${a}`).send({ action: "approve" }),
      request(app).post(`/api/public/approval-links/${b}`).send({ action: "approve" }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect((await getReq(id)).workflow.currentStep).toBe(1);
  });

  it("a link with no step claim, or for another round, is refused", async () => {
    await publish(WS, chain("DENY"));
    const id = (await submit()).body.request._id;
    const bare = signApprovalLink({ kind: "request", id: String(id), email: HEAD.email }, 72)!;
    const r = await request(app).post(`/api/public/approval-links/${bare}`).send({ action: "approve" });
    expect([r.status, r.body.code]).toEqual([409, "STEP_ALREADY_DECIDED"]);
    const wrongRound = signApprovalLink({ kind: "request", id: String(id), email: HEAD.email, step: "2.0.head" }, 72)!;
    expect((await request(app).post(`/api/public/approval-links/${wrongRound}`).send({ action: "approve" })).body.code).toBe("STEP_ALREADY_DECIDED");
    expect((await getReq(id)).workflow.currentStep).toBe(0);
  });

  it("a decline at step 2 ends the request; resubmit restarts the same chain in round 2", async () => {
    await publish(WS, chain("DENY"));
    const id = (await submit()).body.request._id;
    const round1HeadLinks = linksFor(HEAD.email)!;
    await act(id, HEAD, "approved");
    expect((await act(id, RM, "declined")).body.code).toBe("REASON_REQUIRED");
    expect((await act(id, RM, "declined", "Not now")).status).toBe(200);
    let doc = await getReq(id);
    expect(doc).toMatchObject({ status: "declined", stage: "REQUEST_DECLINED", adminState: "cancelled" });
    expect(doc.workflow.steps.map((s: any) => s.status)).toEqual(["APPROVED", "DECLINED", "WAITING"]);

    // Snapshot (D5): even if the department head changes now, round 2 keeps the old chain.
    await col("departments").updateOne({ _id: DEPT }, { $set: { managerId: new mongoose.Types.ObjectId(WL.sub) } });
    mails.length = 0;
    expect((await as(request(app).put(`/api/approvals/requests/${id}/resubmit`), EMP).send({ comment: "Again" })).status).toBe(200);
    doc = await getReq(id);
    expect(doc).toMatchObject({ status: "pending", stage: "REQUEST_RAISED", managerEmail: HEAD.email });
    expect(doc.workflow).toMatchObject({ round: 2, currentStep: 0, pendingEmails: [HEAD.email] });
    expect(doc.workflow.steps.map((s: any) => s.status)).toEqual(["PENDING", "WAITING", "WAITING"]);
    expect(mails.map((m) => String(m.to))).toEqual([HEAD.email]);
    // A round-1 link for the same step is stale.
    expect((await request(app).post(`/api/public/approval-links/${round1HeadLinks.clarify}`).send({ action: "clarify", reason: "?" })).body.code).toBe("STEP_ALREADY_DECIDED");
    const fresh = linksFor(HEAD.email)!;
    expect((await request(app).post(`/api/public/approval-links/${fresh.approve}`).send({ action: "approve" })).status).toBe(200);
    expect((await getReq(id)).workflow.currentStep).toBe(1);
  });

  it("a question at step 1 goes back to that step after the reply", async () => {
    await publish(WS, chain("DENY"));
    const id = (await submit()).body.request._id;
    expect((await act(id, HEAD, "clarify", "Which client?")).status).toBe(200);
    expect((await getReq(id)).stage).toBe("REQUEST_NEEDS_CLARIFICATION");
    mails.length = 0;
    expect((await as(request(app).post(`/api/approvals/requests/${id}/clarification`), EMP).send({ reply: "Acme" })).status).toBe(200);
    expect(mails.map((m) => String(m.to))).toEqual([HEAD.email]);
    expect(linksFor(HEAD.email)).toHaveProperty("approve");
    const doc = await getReq(id);
    expect(doc.workflow).toMatchObject({ currentStep: 0, round: 1 });
  });

  it("the requester never decides, and a step whose person is missing is skipped", async () => {
    await publish(WS, chain("DENY"));
    await col("travellerprofiles").updateOne({ claimedBy: new mongoose.Types.ObjectId(EMP.sub) }, { $unset: { reportingManagerId: "" } });
    const id = (await submit()).body.request._id;
    const doc = await getReq(id);
    expect(doc.workflow.steps[1]).toMatchObject({ status: "SKIPPED", fallbackReason: "NO_REPORTING_MANAGER", routingNote: "Skipped: no reporting manager set" });
    expect((await act(id, EMP, "approved")).body.code).toBe("SELF_APPROVAL_NOT_ALLOWED");
    await act(id, HEAD, "approved");
    expect((await getReq(id)).workflow).toMatchObject({ currentStep: 2, pendingEmails: [DEF.email] });
  });
});

describe("leadersMayDecide", () => {
  it("DENY: a Workspace Leader cannot decide, but can view", async () => {
    await publish(WS, chain("DENY"));
    const id = (await submit()).body.request._id;
    expect((await act(id, WL, "approved", "go")).body.code).toBe("NOT_AN_APPROVER");
    const inbox = await as(request(app).get("/api/approvals/requests/inbox?view=all"), WL);
    const row = inbox.body.rows.find((x: any) => String(x._id) === String(id));
    expect(row._workflow).toMatchObject({ role: "LEADER", canDecide: false, canOverride: false });
  });

  it("ALLOW: a Workspace Leader decides the current step like its approver (in-app only)", async () => {
    await publish(WS, chain("ALLOW"));
    const id = (await submit()).body.request._id;
    expect((await act(id, WL, "approved")).status).toBe(200);
    expect((await getReq(id)).workflow).toMatchObject({ currentStep: 1 });
    // Never by link, even with a correctly bound one.
    const forged = signApprovalLink({ kind: "request", id: String(id), email: WL.email, step: "1.1.rm" }, 72)!;
    expect((await request(app).post(`/api/public/approval-links/${forged}`).send({ action: "approve" })).body.code).toBe("NOT_AN_APPROVER");
  });

  it("OVERRIDE_WITH_REASON: a reason is required; the override decides the CURRENT step only, is recorded and is in the emails", async () => {
    await publish(WS, chain("OVERRIDE_WITH_REASON"));
    const id = (await submit()).body.request._id;
    const inbox = await as(request(app).get("/api/approvals/requests/inbox?view=all"), WL);
    expect(inbox.body.rows.find((x: any) => String(x._id) === String(id))._workflow).toMatchObject({ canDecide: false, canOverride: true });

    expect((await act(id, WL, "approved")).body.code).toBe("OVERRIDE_REASON_REQUIRED");
    expect((await act(id, WL, "clarify", "why?")).body.code).toBe("OVERRIDE_CLARIFY_NOT_ALLOWED");
    const forged = signApprovalLink({ kind: "request", id: String(id), email: WL.email, step: "1.0.head" }, 72)!;
    expect((await request(app).post(`/api/public/approval-links/${forged}`).send({ action: "approve", reason: "x" })).body.code).toBe("NOT_AN_APPROVER");

    mails.length = 0;
    const r = await act(id, WL, "approved", "Head on leave, client trip is urgent");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Step 1 is overridden; step 2 (the reporting manager) is now pending — the chain continues.
    let doc = await getReq(id);
    expect(doc).toMatchObject({ status: "pending", stage: "REQUEST_RAISED", managerEmail: RM.email });
    expect(doc.workflow).toMatchObject({ currentStep: 1, pendingEmails: [RM.email] });
    expect(doc.workflow.steps.map((s: any) => s.status)).toEqual(["OVERRIDDEN", "PENDING", "WAITING"]);
    expect(doc.workflow.steps[0].decidedBy).toMatchObject({ email: WL.email, override: true });
    expect(doc.workflow.overrides).toEqual([
      expect.objectContaining({ stepKey: "head", action: "approved", byEmail: WL.email, reason: "Head on leave, client trip is urgent" }),
    ]);
    expect(doc.history.at(-1)).toMatchObject({ action: "step_approved", comment: expect.stringContaining("Workspace Leader override of department head approval") });
    // The next step's approver is asked, told it was an override and why; the requester hears nothing yet.
    expect(mails.map((m) => String(m.to))).toEqual([RM.email]);
    expect(String(mails[0].html)).toContain("Workspace Leader override");
    expect(String(mails[0].html)).toContain("Head on leave, client trip is urgent");
    // The request detail shows it.
    const detail = await as(request(app).get(`/api/approvals/requests/${id}`), EMP);
    expect(detail.body.request._workflow.overrides[0]).toMatchObject({ action: "approved", reason: "Head on leave, client trip is urgent" });

    // The manager decides step 2 themselves; at step 3 the leader overrides again, which approves the request.
    expect((await act(id, RM, "approved")).status).toBe(200);
    mails.length = 0;
    expect((await act(id, WL, "approved", "Travel desk confirmed budget")).status).toBe(200);
    doc = await getReq(id);
    expect(doc).toMatchObject({ status: "approved", stage: "REQUEST_APPROVED", approvedByEmail: WL.email });
    expect(doc.workflow.steps.map((s: any) => s.status)).toEqual(["OVERRIDDEN", "APPROVED", "OVERRIDDEN"]);
    expect(doc.workflow.overrides.map((o: any) => o.stepKey)).toEqual(["head", "def"]);
    const toEmp = mails.find((m) => String(m.to) === EMP.email)!;
    expect(String(toEmp.html)).toContain("Workspace Leader override");
    expect(String(toEmp.html)).toContain("Travel desk confirmed budget");
  });

  it("OVERRIDE_WITH_REASON: a one-step chain (StatusNeo) — the override approves the request", async () => {
    await publish(WS, { ...chain("OVERRIDE_WITH_REASON"), steps: [chain("x").steps[0]] });
    const id = (await submit()).body.request._id;
    expect((await act(id, WL, "approved", "Head on leave")).status).toBe(200);
    const doc = await getReq(id);
    expect(doc).toMatchObject({ status: "approved", stage: "REQUEST_APPROVED" });
    expect(doc.workflow.steps.map((s: any) => s.status)).toEqual(["OVERRIDDEN"]);
  });

  it("OVERRIDE_WITH_REASON: an override decline ends the request with the reason", async () => {
    await publish(WS, chain("OVERRIDE_WITH_REASON"));
    const id = (await submit()).body.request._id;
    await act(id, HEAD, "approved");
    expect((await act(id, WL, "declined", "Budget frozen")).status).toBe(200);
    const doc = await getReq(id);
    expect(doc).toMatchObject({ status: "declined", stage: "REQUEST_DECLINED" });
    expect(doc.workflow.steps.map((s: any) => s.status)).toEqual(["APPROVED", "DECLINED", "WAITING"]);
    expect(doc.workflow.steps[1].decidedBy).toMatchObject({ email: WL.email, override: true });
    expect(doc.workflow.overrides[0]).toMatchObject({ stepKey: "rm", action: "declined", reason: "Budget frozen" });
  });
});

describe("Flow 2 under a workflow", () => {
  it("the last approval lands on PROPOSAL_PENDING, as today", async () => {
    await publish(WS2, {
      enabled: true,
      leadersMayDecide: "DENY",
      steps: [{ key: "head", label: "Department head approval", type: "DEPARTMENT_HEAD", role: "APPROVER", fallback: "REFUSE_SUBMIT" }],
    });
    const r = await submit(EMP2);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await act(r.body.request._id, HEAD2, "approved")).status).toBe(200);
    expect(await getReq(r.body.request._id)).toMatchObject({ status: "approved", stage: "PROPOSAL_PENDING" });
  });

  it("REFUSE_SUBMIT: no head → the submit is refused with a clear message", async () => {
    await publish(WS2, {
      enabled: true,
      steps: [{ key: "head", label: "Department head approval", type: "DEPARTMENT_HEAD", role: "APPROVER", fallback: "REFUSE_SUBMIT" }],
    });
    await col("departments").updateOne({ _id: DEPT2 }, { $unset: { managerId: "" } });
    const r = await submit(EMP2);
    expect([r.status, r.body.code]).toEqual([400, "WORKFLOW_NO_APPROVER"]);
    expect(r.body.error).toContain("no department head set");
    expect(await col("approvalrequests").countDocuments()).toBe(0);
  });
});
