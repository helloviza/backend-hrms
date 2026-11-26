// apps/backend/src/routes/approvals.workflowRequestOnly.test.ts
//
// S4: requestOnlyMode and the trip's purpose (D8), with StatusNeo's config:
//   - /approvals/search/* answers 403 REQUEST_ONLY_MODE (and a workspace
//     without the mode still reaches the search);
//   - a submit needs a purpose from the fixed list ("Other" needs text), and a
//     request-only submit cannot carry a picked fare;
//   - the purpose is stored on the snapshot, editable while the request is
//     editable, kept on resubmit, and shown in the approver, confirmation,
//     watcher and ops emails, the inbox, My Requests and the request detail;
//   - request-context tells the form both settings.
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
const submit = (w: Who = EMP, purpose: any = { code: "Client meeting" }, extra: any = {}) =>
  as(request(app).post("/api/approvals/requests"), w).send({ cartItems: [flight], ...(purpose === null ? {} : { purpose }), ...extra });
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
  requestOnlyMode: true,
  purpose: { required: true, options: ["Client meeting", "Project-delivery", "Training", "Internal meeting", "Conference-event", "Other"] },
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

describe("request-only mode", () => {
  it("search answers 403 REQUEST_ONLY_MODE; with the mode off it reaches the search", async () => {
    for (const p of ["/flights", "/hotels"]) {
      const r = await as(request(app).post(`/api/approvals/search${p}`).send({}), EMP);
      expect([r.status, r.body.code], p).toEqual([403, "REQUEST_ONLY_MODE"]);
    }
    await publish({ ...STATUSNEO, requestOnlyMode: false });
    const r = await as(request(app).post("/api/approvals/search/flights").send({}), EMP);
    expect(r.body.code).not.toBe("REQUEST_ONLY_MODE");
  });

  it("request-context gives the form the mode, the purpose list and the watchers", async () => {
    const r = await as(request(app).get("/api/approvals/request-context"), EMP);
    expect(r.body.workflow).toEqual({
      requestOnlyMode: true,
      purpose: { required: true, options: STATUSNEO.purpose.options },
      watchers: [{ label: "Reporting manager (FYI)", names: ["Mira Manager"] }],
    });
    expect(r.body.approver).toMatchObject({ status: "ok", name: "Hari Head", step: "Department head approval" });
  });

  it("a request-only submit cannot carry a picked fare", async () => {
    const picked = { ...flight, meta: { ...flight.meta, optionRef: "opt-1" } };
    const r = await as(request(app).post("/api/approvals/requests"), EMP).send({ cartItems: [picked], purpose: { code: "Training" } });
    expect(r.status).toBe(400);
    expect(await col("approvalrequests").countDocuments()).toBe(0);
  });
});

describe("purpose of travel (D8)", () => {
  it("is required, must be from the list, and Other needs text", async () => {
    for (const [p, msg] of [
      [null, "Choose the purpose of travel."],
      [{ code: "Holiday" }, "Choose a purpose from the list"],
      [{ code: "Other" }, "Say what the purpose of travel is."],
      [{ code: "Other", text: "   " }, "Say what the purpose of travel is."],
    ] as const) {
      const r = await submit(EMP, p as any);
      expect([r.status, r.body.code, r.body.field], JSON.stringify(p)).toEqual([400, "PURPOSE_REQUIRED", "purpose"]);
      expect(r.body.error).toContain(msg);
    }
    expect(await col("approvalrequests").countDocuments()).toBe(0);
    const ok = await submit(EMP, { code: "other", text: "Visa interview" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await getReq(ok.body.request._id)).workflow.purpose).toEqual({ code: "Other", text: "Visa interview" });
  });

  it("is shown in the approver, confirmation, watcher and ops emails", async () => {
    const id = (await submit(EMP, { code: "Project-delivery" })).body.request._id;
    for (const to of [HEAD.email, EMP.email, RM.email]) {
      const m = mailsTo(to)[0];
      expect(String(m.html), to).toContain("Purpose of travel");
      expect(String(m.html), to).toContain("Project-delivery");
    }
    mails.length = 0;
    await act(id, HEAD, "approved");
    const desk = mails.find((m) => /New case/.test(String(m.subject)))!;
    expect(String(desk.html)).toContain("Project-delivery");
  });

  it("is on the inbox row, My Requests and the request detail", async () => {
    const id = (await submit(EMP, { code: "Training" })).body.request._id;
    const inbox = await as(request(app).get("/api/approvals/requests/inbox?view=all"), HEAD);
    expect(inbox.body.rows[0]._workflow.purpose).toEqual({ code: "Training", text: "" });
    const mine = await as(request(app).get("/api/approvals/requests/mine"), EMP);
    expect(mine.body.rows[0].workflow.purpose).toEqual({ code: "Training", text: "" });
    const detail = await as(request(app).get(`/api/approvals/requests/${id}`), RM);
    expect(detail.body.request._workflow.purpose.code).toBe("Training");
  });

  it("can be changed while editable and on resubmit", async () => {
    const id = (await submit(EMP, { code: "Training" })).body.request._id;
    const bad = await as(request(app).put(`/api/approvals/requests/${id}`), EMP).send({ cartItems: [flight], purpose: { code: "Nope" } });
    expect([bad.status, bad.body.code]).toEqual([400, "PURPOSE_REQUIRED"]);
    const ok = await as(request(app).put(`/api/approvals/requests/${id}`), EMP).send({ cartItems: [flight], purpose: { code: "Internal meeting" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await getReq(id)).workflow.purpose.code).toBe("Internal meeting");
    await act(id, HEAD, "declined", "Wrong dates");
    const re = await as(request(app).put(`/api/approvals/requests/${id}/resubmit`), EMP).send({ purpose: { code: "Conference-event" } });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    const doc = await getReq(id);
    expect(doc.workflow).toMatchObject({ round: 2, purpose: { code: "Conference-event" } });
  });

  it("not required → a submit without one is fine", async () => {
    await publish({ ...STATUSNEO, requestOnlyMode: false, purpose: { required: false, options: [] } });
    const r = await submit(EMP, null);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await getReq(r.body.request._id)).workflow.purpose).toBeNull();
  });
});
