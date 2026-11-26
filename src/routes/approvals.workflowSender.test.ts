// apps/backend/src/routes/approvals.workflowSender.test.ts
//
// S6 — email level A and per-event on/off, for a workflow request:
//   - customer emails go out from OUR address with the workspace's display
//     name, and its reply-to; staff (ops desk) emails are unchanged;
//   - the sender is read at SEND time: a retry uses the setting in force then;
//   - a request with no workflow keeps today's From / Reply-To;
//   - a switched-off FYI event is not sent; decision-link events can't be
//     switched off (the config is refused).
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
const { failNext } = vi.hoisted(() => ({ failNext: { n: 0, to: "" } }));
vi.mock("../utils/mailer.js", async (orig) => ({
  ...(await orig<any>()),
  sendMail: async (m: any) => {
    if (failNext.n > 0 && [m.to].flat().map(String).includes(failNext.to)) {
      failNext.n--;
      return { ok: false, error: "SMTP down (test)" };
    }
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
const { processOutbox } = await import("../services/emailOutbox.js");
const { sanitizeWorkflowConfig } = await import("../services/approvalWorkflow/config.js");
const { mailFromAddress } = await import("../utils/mailer.js");

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

const SENDER = { level: "A", displayName: "StatusNeo Travel via Plumtrips", replyTo: "travel@statusneo.test" };
const withSender = (over: any = {}) => ({ ...STATUSNEO, email: { ...STATUSNEO.email, sender: SENDER, ...over } });
const mailTo = (email: string) => mails.find((m) => [m.to].flat().map(String).includes(email));

describe("email level A", () => {
  it("customer emails: the workspace's name on our address, and its reply-to; the ops desk email is unchanged", async () => {
    await publish(withSender());
    const id = (await submit()).body.request._id;
    for (const who of [HEAD.email, EMP.email, RM.email]) {
      const m = mailTo(who)!;
      expect(m.from, who).toMatch(/^"StatusNeo Travel via Plumtrips" <[^>]+@[^>]+>$/);
      expect(m.replyTo, who).toBe("travel@statusneo.test");
    }
    expect(mailTo(HEAD.email)!.from).toBe(`"StatusNeo Travel via Plumtrips" <${mailFromAddress("REQUESTS")}>`);
    mails.length = 0;
    await act(id, HEAD, "approved");
    const desk = mails.find((m) => /New case/.test(String(m.subject)))!;
    expect(desk.from || "").not.toContain("StatusNeo Travel");
  });

  it("is read at send time: a retry uses the sender in force then", async () => {
    await publish(withSender());
    Object.assign(failNext, { n: 1, to: HEAD.email }); // the head's approval email fails its first try
    await submit();
    expect(mailTo(HEAD.email)).toBeUndefined();
    await publish(withSender({ sender: { ...SENDER, displayName: "StatusNeo Travel Desk" } }));
    await processOutbox(new Date(Date.now() + 3 * 60_000));
    expect(mailTo(HEAD.email)!.from).toMatch(/^"StatusNeo Travel Desk" </);
  });

  it("a request with no workflow keeps today's From / Reply-To", async () => {
    await publish({ ...withSender(), enabled: false });
    await submit();
    const m = mailTo(EMP.email)!;
    expect(m.from || "").not.toContain("StatusNeo Travel");
    expect(m.replyTo || "").not.toBe("travel@statusneo.test");
  });
});

describe("per-event on/off", () => {
  it("a switched-off FYI event is not sent; the others are", async () => {
    await publish(withSender({ events: { request_watcher_fyi: { enabled: false } } }));
    await submit();
    expect(mailTo(RM.email)).toBeUndefined();
    expect(mailTo(HEAD.email)).toBeDefined();
    expect(mailTo(EMP.email)).toBeDefined();
  });

  it("decision-link and staff events cannot be switched off; unknown events are refused", () => {
    expect(() => sanitizeWorkflowConfig(withSender({ events: { request_submitted_approver: { enabled: false } } }))).toThrow(/decision link and cannot be switched off/);
    expect(() => sanitizeWorkflowConfig(withSender({ events: { ops_new_case: { enabled: false } } }))).toThrow(/staff emails cannot be switched off/);
    expect(() => sanitizeWorkflowConfig(withSender({ events: { not_an_event: { enabled: false } } }))).toThrow(/not an approval email event/);
    expect(sanitizeWorkflowConfig(withSender({ events: { booking_done: { enabled: true } } })).email.events).toEqual({ booking_done: { enabled: true } });
  });
});
