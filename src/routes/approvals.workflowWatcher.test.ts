// apps/backend/src/routes/approvals.workflowWatcher.test.ts
//
// S3: StatusNeo's chain — DEPARTMENT_HEAD approver (fallback, self rule) and
// REPORTING_MANAGER watcher — through the real routes:
//   - the watcher can VIEW (detail, inbox FYI tab — even with SBT on) and is
//     emailed for submitted / approved / declined / booking done (D9), never
//     with a decision link;
//   - the watcher can NEVER decide: in-app (approve, decline, clarify — also
//     when they are a Workspace Leader) or by email link (even a correctly
//     bound one);
//   - D1 travel admins get "approved" and are copied on "booking done";
//   - D2 no head → the default approver, with "Routed to fallback: no
//     department head set" on the request and in the form's preview;
//   - D4 the head raises a request → their reporting manager approves;
//   - one person is never both approver and watcher.
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
const { markRequestDone } = await import("../services/approvalProgress.js");
const { default: ApprovalRequest } = await import("../models/ApprovalRequest.js");

const app = express();
app.use(express.json());
app.use("/api/public/approval-links", approvalLinksRouter);
app.use("/api/approvals", approvalsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const WS = oid();
const DEPT = oid();

type Who = { sub: string; email: string; name: string; roles: string[] };
const who = (email: string, name: string, roles = ["EMPLOYEE"]): Who => ({ sub: String(oid()), email, name, roles });
const EMP = who("emp@sn.test", "Esha Employee");
const HEAD = who("head@sn.test", "Hari Head");
const HEADS_RM = who("vp@sn.test", "Vera Vp");
const RM = who("rm@sn.test", "Mira Manager");
const DEF = who("def@sn.test", "Dev Default");
const WL = who("wl@sn.test", "Lata Leader", ["WORKSPACE_LEADER"]);
const TRAVEL = "travel@sn.test";
const PEOPLE = [EMP, HEAD, HEADS_RM, RM, DEF, WL];

const as = (r: request.Test, w: Who) =>
  r
    .set("x-test-user", JSON.stringify({ sub: w.sub, _id: w.sub, email: w.email, name: w.name, roles: w.roles, workspaceId: String(WS) }))
    .set("x-test-ws", String(WS));
const flight = {
  type: "flight", title: "BLR → BOM", qty: 1, price: 0,
  meta: { origin: "BLR", destination: "BOM", tripType: "oneway", departDate: "2027-03-12", travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }] },
};
const submit = (w: Who = EMP) => as(request(app).post("/api/approvals/requests"), w).send({ cartItems: [flight] });
const act = (id: any, w: Who, action: string, comment?: string) =>
  as(request(app).put(`/api/approvals/requests/${String(id)}/action`), w).send({ action, comment });
const getReq = async (id: any) => (await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(id)) })) as any;
const mailsTo = (email: string) => mails.filter((m) => [m.to, m.cc].flat().filter(Boolean).map(String).some((x) => x.split(",").includes(email)));
const hasLinks = (m: any) => /approval\/email\?token=/.test(String(m.html));
const oidOf = (w: Who) => new mongoose.Types.ObjectId(w.sub);

const STATUSNEO = {
  enabled: true,
  template: "DEPT_HEAD_WATCHER",
  leadersMayDecide: "OVERRIDE_WITH_REASON",
  completion: "ALL_SERVICES_BOOKED",
  steps: [
    { key: "head", label: "Department head approval", type: "DEPARTMENT_HEAD", role: "APPROVER", fallback: "DEFAULT_APPROVER", selfRule: "NEXT_IN_LINE" },
    { key: "rm", label: "Reporting manager (FYI)", type: "REPORTING_MANAGER", role: "WATCHER", fallback: "SKIP", watcherEvents: ["submitted", "approved", "declined", "booking_done"] },
  ],
  email: { travelAdminEmails: [TRAVEL] },
};
const actor = { id: "", name: "test", email: "", kind: "SCRIPT" as const, roles: [] };
async function publish(cfg: any = STATUSNEO) {
  await saveWorkflowDraft({ workspaceId: WS, config: cfg, actor });
  await publishWorkflowDraft({ workspaceId: WS, actor, changeSummary: "test" });
}
const profile = (w: Who, over: any = {}) => ({
  workspaceId: WS, firstName: w.name.split(" ")[0], lastName: w.name.split(" ")[1], email: w.email, isActive: true,
  claimedBy: oidOf(w), departmentId: DEPT, ...over,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-workflow-watcher-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  mails.length = 0;
  await col("customerworkspaces").insertOne({
    _id: WS, customerId: "SN", name: "StatusNeo", companyName: "StatusNeo", status: "ACTIVE", defaultApproverEmails: [DEF.email],
    config: { travelFlow: "APPROVAL_DIRECT", features: { approvalDirectEnabled: true } },
  } as any);
  await col("users").insertMany(
    PEOPLE.map((p) => ({ _id: oidOf(p), workspaceId: WS, email: p.email, firstName: p.name.split(" ")[0], lastName: p.name.split(" ")[1], roles: p.roles, status: "ACTIVE" })) as any[],
  );
  await col("customermembers").insertOne({ customerId: "SN", workspaceId: WS, email: WL.email, role: "WORKSPACE_LEADER", isActive: true } as any);
  await col("departments").insertOne({ _id: DEPT, workspaceId: WS, name: "Engineering", isActive: true, managerId: oidOf(HEAD) } as any);
  await col("travellerprofiles").insertMany([
    profile(EMP, { reportingManagerId: oidOf(RM) }),
    profile(HEAD, { reportingManagerId: oidOf(HEADS_RM) }),
  ] as any[]);
  await publish();
});

describe("the reporting manager watches", () => {
  it("is snapshotted as a watcher and emailed on submit — no decision links", async () => {
    const r = await submit();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const doc = await getReq(r.body.request._id);
    expect(doc.workflow).toMatchObject({ watcherEmails: [RM.email], pendingEmails: [HEAD.email], travelAdminEmails: [TRAVEL] });
    expect(doc.workflow.steps[1]).toMatchObject({ key: "rm", role: "WATCHER", status: "WATCHING", assignees: [{ email: RM.email, name: "Mira Manager" }] });
    const rmMails = mailsTo(RM.email);
    expect(rmMails).toHaveLength(1);
    expect(rmMails[0].subject).toMatch(/^FYI: Esha Employee's travel request was submitted/);
    expect(hasLinks(rmMails[0])).toBe(false);
    expect(String(rmMails[0].html)).toContain("you cannot approve or decline it");
    expect(String(rmMails[0].html)).toContain("copied as Esha Employee's reporting manager, for information only");
    expect(hasLinks(mailsTo(HEAD.email)[0])).toBe(true);
    expect(mailsTo(TRAVEL)).toHaveLength(0); // travel admins hear at approval, not submit
    expect(mailsTo(WL.email)).toHaveLength(0); // no decision link for leaders (D3)
  });

  it("can view the request and finds it in the FYI tab — also with SBT switched on", async () => {
    const id = (await submit()).body.request._id;
    const detail = await as(request(app).get(`/api/approvals/requests/${id}`), RM);
    expect(detail.status).toBe(200);
    expect(detail.body.request._workflow).toMatchObject({ role: "WATCHER", canDecide: false, canOverride: false, currentStep: { label: "Department head approval", names: ["Hari Head"] } });

    let inbox = await as(request(app).get("/api/approvals/requests/inbox?view=all"), RM);
    expect(inbox.status).toBe(200);
    expect(inbox.body.rows.map((x: any) => [String(x._id), x._bucket])).toEqual([[String(id), "fyi"]]);

    await col("users").updateOne({ _id: oidOf(RM) }, { $set: { sbtEnabled: true } });
    inbox = await as(request(app).get("/api/approvals/requests/inbox?view=all"), RM);
    expect(inbox.status).toBe(200);
    expect(inbox.body.rows.map((x: any) => x._bucket)).toEqual(["fyi"]);
    // Nothing to decide for an SBT user otherwise: the plain inbox still refuses.
    expect((await as(request(app).get("/api/approvals/requests/inbox"), RM)).status).toBe(403);
  });

  it("can never decide in-app — approve, decline or ask — even as a Workspace Leader", async () => {
    const id = (await submit()).body.request._id;
    for (const [action, comment] of [["approved", undefined], ["declined", "no"], ["clarify", "why?"]]) {
      const r = await act(id, RM, action as string, comment as any);
      expect([r.status, r.body.code], action as string).toEqual([403, "WATCHER_CANNOT_DECIDE"]);
    }
    await col("customermembers").insertOne({ customerId: "SN", workspaceId: WS, email: RM.email, role: "WORKSPACE_LEADER", isActive: true } as any);
    const r = await act(id, RM, "approved", "I am a leader too");
    expect([r.status, r.body.code]).toEqual([403, "WATCHER_CANNOT_DECIDE"]);
    expect(await getReq(id)).toMatchObject({ status: "pending", stage: "REQUEST_RAISED" });
  });

  it("can never decide by email link, even one bound to the current step", async () => {
    const id = (await submit()).body.request._id;
    const tok = signApprovalLink({ kind: "request", id: String(id), email: RM.email, step: "1.0.head" }, 72)!;
    const view = await request(app).get(`/api/public/approval-links/${tok}`);
    expect(view.body.link).toMatchObject({ state: "NOT_ALLOWED", actions: [] });
    const r = await request(app).post(`/api/public/approval-links/${tok}`).send({ action: "approve" });
    expect([r.status, r.body.code]).toEqual([403, "WATCHER_CANNOT_DECIDE"]);
    expect((await getReq(id)).status).toBe("pending");
  });

  it("hears approved, declined and booking done; travel admins get approved and booking done (D1)", async () => {
    const a = (await submit()).body.request._id;
    mails.length = 0;
    expect((await act(a, HEAD, "approved")).status).toBe(200);
    expect(mailsTo(RM.email).map((m) => m.subject)).toEqual([expect.stringMatching(/^FYI: .* was approved/)]);
    expect(mailsTo(TRAVEL).map((m) => m.subject)).toEqual([expect.stringMatching(/^Approved — Esha Employee's travel request/)]);
    expect(mailsTo(TRAVEL).some(hasLinks)).toBe(false);

    mails.length = 0;
    const doc: any = await ApprovalRequest.findById(a).exec();
    await markRequestDone({ doc, admin: { email: "ops@plumtrips.test", name: "Ops" }, comment: "Booked" });
    expect(mailsTo(RM.email).map((m) => m.subject)).toEqual([expect.stringMatching(/^FYI: .* is booked/)]);
    const done = mails.find((m) => /Processed/.test(String(m.subject)))!;
    expect([done.cc].flat().join(",")).toContain(TRAVEL);

    const b = (await submit()).body.request._id;
    mails.length = 0;
    await act(b, HEAD, "declined", "Not this month");
    const rm = mailsTo(RM.email);
    expect(rm.map((m) => m.subject)).toEqual([expect.stringMatching(/^FYI: .* was declined/)]);
    expect(String(rm[0].html)).toContain("Not this month");
    expect(mailsTo(TRAVEL)).toHaveLength(0);
  });

  it("gets only the events the step lists", async () => {
    await publish({ ...STATUSNEO, steps: [STATUSNEO.steps[0], { ...STATUSNEO.steps[1], watcherEvents: ["approved"] }] });
    const id = (await submit()).body.request._id;
    expect(mailsTo(RM.email)).toHaveLength(0);
    await act(id, HEAD, "approved");
    expect(mailsTo(RM.email)).toHaveLength(1);
  });
});

describe("department head routing", () => {
  it("D2: no head → the default approver, and the request says why", async () => {
    await col("departments").updateOne({ _id: DEPT }, { $unset: { managerId: "" } });
    const ctx = await as(request(app).get("/api/approvals/request-context"), EMP);
    expect(ctx.body.approver).toMatchObject({ status: "ok", name: "Dev Default", step: "Department head approval", note: "Routed to fallback: no department head set" });
    expect(ctx.body.workflow.watchers).toEqual([{ label: "Reporting manager (FYI)", names: ["Mira Manager"] }]);

    const id = (await submit()).body.request._id;
    const doc = await getReq(id);
    expect(doc).toMatchObject({ managerEmail: DEF.email });
    expect(doc.workflow.steps[0]).toMatchObject({
      assignees: [{ email: DEF.email }], resolvedVia: "FALLBACK_DEFAULT_APPROVER", fallbackReason: "NO_DEPARTMENT_HEAD",
      routingNote: "Routed to fallback: no department head set",
    });
    const detail = await as(request(app).get(`/api/approvals/requests/${id}`), EMP);
    expect(detail.body.request._workflow.steps[0].routingNote).toBe("Routed to fallback: no department head set");
    expect((await act(id, DEF, "approved")).status).toBe(200);
  });

  it("D2: no traveller profile linked → fallback, with the reason", async () => {
    await col("travellerprofiles").deleteMany({ claimedBy: oidOf(EMP) });
    const doc = await getReq((await submit()).body.request._id);
    expect(doc.workflow.steps[0]).toMatchObject({ fallbackReason: "NO_TRAVELLER_PROFILE", assignees: [{ email: DEF.email }] });
    expect(doc.workflow.steps[1].status).toBe("SKIPPED"); // no profile → no reporting manager either
  });

  it("D2: an inactive head → fallback", async () => {
    await col("users").updateOne({ _id: oidOf(HEAD) }, { $set: { status: "INACTIVE" } });
    const doc = await getReq((await submit()).body.request._id);
    expect(doc.workflow.steps[0]).toMatchObject({ fallbackReason: "DEPARTMENT_HEAD_INACTIVE", resolvedVia: "FALLBACK_DEFAULT_APPROVER" });
  });

  it("D4: the head raises a request → their reporting manager approves", async () => {
    const r = await submit(HEAD);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const doc = await getReq(r.body.request._id);
    expect(doc).toMatchObject({ managerEmail: HEADS_RM.email });
    expect(doc.workflow.steps[0]).toMatchObject({
      assignees: [{ email: HEADS_RM.email }], resolvedVia: "REPORTING_MANAGER_REQUESTER_IS_HEAD", fallbackReason: "REQUESTER_IS_DEPARTMENT_HEAD",
    });
    // Their reporting manager approves, so is not also a watcher.
    expect(doc.workflow.steps[1]).toMatchObject({ status: "SKIPPED" });
    expect(doc.workflow.watcherEmails).toEqual([]);
    expect((await act(r.body.request._id, HEADS_RM, "approved")).status).toBe(200);
  });

  it("D4: the head has no reporting manager → the fallback", async () => {
    await col("travellerprofiles").updateOne({ claimedBy: oidOf(HEAD) }, { $unset: { reportingManagerId: "" } });
    const doc = await getReq((await submit(HEAD)).body.request._id);
    expect(doc.workflow.steps[0]).toMatchObject({ assignees: [{ email: DEF.email }], resolvedVia: "FALLBACK_DEFAULT_APPROVER", fallbackReason: "REQUESTER_IS_DEPARTMENT_HEAD" });
  });

  it("the head is also the reporting manager → approver only, never a watcher", async () => {
    await col("travellerprofiles").updateOne({ claimedBy: oidOf(EMP) }, { $set: { reportingManagerId: oidOf(HEAD) } });
    const doc = await getReq((await submit()).body.request._id);
    expect(doc.workflow.steps.map((s: any) => s.status)).toEqual(["PENDING", "SKIPPED"]);
    expect(doc.workflow.watcherEmails).toEqual([]);
    expect(mailsTo(HEAD.email)).toHaveLength(1);
    expect(hasLinks(mailsTo(HEAD.email)[0])).toBe(true);
  });
});
