// B6 — /api/my-approvals approver filter, against a real Mongo.
//   - approver A never sees approver B's items;
//   - a non-approver gets isApprover:false and nothing;
//   - another workspace's items never appear;
//   - items the caller raised are dropped;
//   - travel requests / proposals list what the live inboxes list (shared
//     services/approvalInbox.service.ts) — incl. a Workspace Leader, checked
//     against the REAL GET /api/approvals/requests/inbox route below;
//   - proposals: "is it mine?" is decided BEFORE the 200 cap (not limit-then-filter);
//   - disabled sources are "off" and not queried;
//   - inline Approve is offered only for expense claims, advances, visa;
//   - a SUPERADMIN with no workspace in the JWT is bound to their HOME
//     workspace by resolveSelfWorkspace (never an unscoped read).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

const { default: User } = await import("../models/User.js");
const { default: Employee } = await import("../models/Employee.js");
const { default: LeaveRequest } = await import("../models/LeaveRequest.js");
const { default: Attendance } = await import("../models/Attendance.js");
const { default: ApprovalRequest } = await import("../models/ApprovalRequest.js");
const { default: Proposal } = await import("../models/Proposal.js");
const { default: SBTRequest } = await import("../models/SBTRequest.js");
const { default: Report } = await import("../models/Report.js");
const { default: ExpenseAdvance } = await import("../models/ExpenseAdvance.js");
const { default: VisaRequest } = await import("../models/VisaRequest.js");
const { default: Expense } = await import("../models/Expense.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { collectMyApprovals } = await import("./myApprovals.service.js");

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const id = () => new mongoose.Types.ObjectId();
const WS = id();
const OTHER_WS = id();
const A = id(); // approver A (manager of R)
const B = id(); // approver B
const R = id(); // requester (A's direct report)
const N = id(); // non-approver
const ALL_ON = {
  leave: true, attendanceOd: true, travelRequest: true, proposal: true,
  sbtRequest: true, expenseClaim: true, advance: true, visa: true,
} as const;

/** collectMyApprovals as the route calls it: with the caller's request. */
async function collectFor(u: mongoose.Types.ObjectId, enabled: Record<string, boolean> = ALL_ON) {
  const doc: any = await User.findById(u).lean();
  return collectMyApprovals({
    req: { user: { sub: String(u), email: doc?.email, roles: doc?.roles || [] }, workspaceObjectId: WS },
    userId: String(u),
    workspaceObjectId: WS,
    enabled: { ...(enabled as any) },
  });
}

async function seed() {
  await mongoose.connection.db!.dropDatabase();
  await User.collection.insertMany([
    { _id: A, workspaceId: WS, email: "a@x.test", name: "Approver A", roles: ["MANAGER"] },
    { _id: B, workspaceId: WS, email: "b@x.test", name: "Approver B", roles: ["MANAGER"] },
    { _id: R, workspaceId: WS, email: "r@x.test", name: "Req Person", designation: "Analyst", roles: ["EMPLOYEE"] },
    { _id: N, workspaceId: WS, email: "n@x.test", name: "No Approver", roles: ["EMPLOYEE"] },
  ] as any);
  const empA = id();
  await Employee.collection.insertMany([
    { _id: empA, workspaceId: WS, ownerId: A, name: "A" },
    { _id: id(), workspaceId: WS, ownerId: R, managerId: empA, name: "R" },
  ] as any);
  await LeaveRequest.collection.insertMany([
    { workspaceId: WS, userId: R, type: "CL", from: new Date("2026-11-20"), to: new Date("2026-11-21"), status: "PENDING", createdAt: new Date("2026-11-01") },
    { workspaceId: OTHER_WS, userId: R, type: "SL", from: new Date("2026-11-20"), to: new Date("2026-11-20"), status: "PENDING", createdAt: new Date("2026-11-01") },
  ] as any);
  await Attendance.collection.insertOne({
    workspaceId: WS, userId: R, date: "2026-11-05",
    odRequests: [{ _id: id(), status: "PENDING", from: "09:00", to: "18:00", requestedAt: new Date("2026-11-06") }],
  } as any);
  const ar = id();
  await ApprovalRequest.collection.insertMany([
    { _id: ar, workspaceId: WS, status: "pending", stage: "REQUEST_RAISED", managerEmail: "A@x.test", frontlinerId: String(R), frontlinerName: "Req Person", ticketId: "T1", bookingAmount: 9999, createdAt: new Date("2026-11-02") },
    { workspaceId: WS, status: "pending", stage: "REQUEST_RAISED", managerEmail: "b@x.test", meta: { ccLeaders: ["a@x.test"] }, frontlinerId: String(R), createdAt: new Date("2026-11-02") },
  ] as any);
  // 250 SUBMITTED proposals that are NOT A's, all newer than A's one — a
  // limit(200)-before-filter would never reach A's proposal.
  const otherAr = id();
  await ApprovalRequest.collection.insertOne({ _id: otherAr, workspaceId: WS, status: "approved", managerEmail: "b@x.test", frontlinerId: String(R) } as any);
  const noise = Array.from({ length: 250 }, (_, i) => ({
    workspaceId: WS, requestId: otherAr, status: "SUBMITTED", totalAmount: 1, currency: "INR",
    approvals: { l2: { decision: "PENDING" } }, updatedAt: new Date(Date.UTC(2026, 10, 7, 0, i)),
  }));
  await Proposal.collection.insertMany([
    { workspaceId: WS, requestId: ar, status: "SUBMITTED", title: "Option 1", totalAmount: 42000, currency: "INR", approvals: { l2: { decision: "PENDING" } }, updatedAt: new Date("2026-11-03") },
    ...noise,
  ] as any);
  await SBTRequest.collection.insertMany([
    { workspaceId: WS, requesterId: R, assignedBookerId: A, type: "flight", status: "PENDING", searchParams: { origin: "DEL", destination: "BOM" }, selectedOption: { Fare: { TotalFare: 5400, Currency: "INR" } }, requestedAt: new Date("2026-11-04") },
    { workspaceId: WS, requesterId: R, assignedBookerId: A, type: "hotel", status: "PENDING", searchParams: { cityName: "Pune" }, selectedOption: { TotalFare: 3000 }, requestedAt: new Date("2026-11-04") },
  ] as any);
  const rep = id();
  await Report.collection.insertMany([
    { _id: rep, workspaceId: WS, employeeId: R, name: "Client visit", ref: "CLM-1", status: "submitted", approverId: A, submittedAt: new Date("2026-11-05") },
    { workspaceId: WS, employeeId: R, name: "B's claim", ref: "CLM-2", status: "submitted", approverId: B, submittedAt: new Date("2026-11-05") },
    { workspaceId: OTHER_WS, employeeId: R, name: "Other ws", ref: "CLM-3", status: "submitted", approverId: A, submittedAt: new Date("2026-11-05") },
    { workspaceId: WS, employeeId: A, name: "Own claim", ref: "CLM-4", status: "submitted", approverId: A, submittedAt: new Date("2026-11-05") },
  ] as any);
  await Expense.collection.insertMany([
    { workspaceId: WS, reportId: rep, amount: 1000, currency: "INR" },
    { workspaceId: WS, reportId: rep, amount: 250.5, currency: "INR" },
  ] as any);
  await ExpenseAdvance.collection.insertOne({ workspaceId: WS, requesterId: R, ref: "ADV-1", purpose: "Conference", amount: 5000, currency: "INR", status: "awaiting_approval", approverId: A, submittedAt: new Date("2026-11-06") } as any);
  await VisaRequest.collection.insertOne({ workspaceId: WS, raisedByUserId: R, referenceNumber: "HV26-000001", destinationIso2: "AE", purpose: "business", approvalStatus: "pending_approval", approverId: A, submittedAt: new Date("2026-11-07") } as any);
}

beforeEach(seed);

describe("collectMyApprovals", () => {
  it("approver A sees exactly A's items, one per source", async () => {
    const r = await collectFor(A);
    const bySource = (s: string) => r.items.filter((i) => i.source === s);
    expect(r.isApprover).toBe(true);
    expect(bySource("leave")).toHaveLength(1); // OTHER_WS leave excluded
    expect(bySource("attendanceOd")).toHaveLength(1);
    // The live inbox lists managerEmail OR meta.ccLeaders → A sees both pending requests.
    expect(bySource("travelRequest")).toHaveLength(2);
    expect(bySource("expenseClaim")).toHaveLength(1); // B's, other-ws and own claim excluded
    expect(bySource("advance")).toHaveLength(1);
    expect(bySource("visa")).toHaveLength(1);
    expect(r.total).toBe(10); // leave, OD, 2 travel, proposal, 2 SBT, claim, advance, visa
    expect(Object.values(r.sources).every((s) => s === "ok")).toBe(true);
  });

  it("finds A's proposal behind 250 newer non-A proposals (filter before the 200 cap)", async () => {
    const r = await collectFor(A);
    const p = r.items.find((i) => i.source === "proposal");
    expect(p).toBeTruthy();
    expect(p).toMatchObject({ amount: 42000, currency: "INR", reviewHref: "/customer/approvals/proposals" });
    expect(p!.inline).toBeUndefined();
  });

  it("approver B never sees A's items", async () => {
    const r = await collectFor(B);
    // B: 1 travel request (managerEmail b) + 1 claim + B's proposals, which the
    // shared inbox caps at 200 (of 250) — the same list the proposals inbox shows.
    expect(r.total).toBe(202);
    expect(r.items).toHaveLength(10); // capped; total stays true
    // oldest first: travel (2 Nov), claim (5 Nov), then proposals (7 Nov)
    expect(r.items[0].source).toBe("travelRequest");
    expect(r.items[1]).toMatchObject({ source: "expenseClaim", summary: expect.stringContaining("B's claim") });
    expect(r.items.some((i) => ["leave", "attendanceOd", "advance", "visa", "sbtRequest"].includes(i.source))).toBe(false);
  });

  it("a non-approver gets isApprover:false and nothing", async () => {
    const r = await collectFor(N);
    expect(r).toMatchObject({ isApprover: false, total: 0, items: [] });
  });

  it("disabled sources are 'off' and contribute nothing", async () => {
    const r = await collectFor(A, { ...ALL_ON, expenseClaim: false, advance: false, visa: false });
    expect(r.sources).toMatchObject({ expenseClaim: "off", advance: "off", visa: "off" });
    expect(r.items.some((i) => ["expenseClaim", "advance", "visa"].includes(i.source))).toBe(false);
  });

  it("inline Approve only for expense claims, advances and visa; amounts/currency per Q12", async () => {
    const r = await collectFor(A);
    for (const it of r.items) {
      if (["expenseClaim", "advance", "visa"].includes(it.source)) expect(it.inline?.method).toBe("POST");
      else expect(it.inline).toBeUndefined();
    }
    expect(r.items.find((i) => i.source === "expenseClaim")).toMatchObject({ amount: 1250.5, currency: "INR", inline: { path: expect.stringMatching(/^\/reports\/.+\/approve$/) } });
    const travel = r.items.find((i) => i.source === "travelRequest")!;
    expect(travel.amount).toBeUndefined(); // no currency on ApprovalRequest → hidden
    const sbt = r.items.filter((i) => i.source === "sbtRequest");
    expect(sbt.find((i) => i.summary.startsWith("Flight"))).toMatchObject({ amount: 5400, currency: "INR" });
    expect(sbt.find((i) => i.summary.startsWith("Hotel"))!.amount).toBeUndefined(); // no Fare.Currency
  });

  it("requester names come from User; designation when set", async () => {
    const r = await collectFor(A);
    expect(r.items.find((i) => i.source === "leave")!.requester).toMatchObject({ name: "Req Person", designation: "Analyst" });
  });
});

describe("GET /api/my-approvals — SUPERADMIN without JWT workspace", () => {
  it("is bound to the caller's home workspace, not every tenant", async () => {
    await CustomerWorkspace.collection.insertOne({ _id: WS, status: "ACTIVE", config: { features: {} } } as any);
    const SA = id();
    await User.collection.insertOne({ _id: SA, workspaceId: WS, email: "sa@x.test", roles: ["SUPERADMIN"] } as any);
    await Report.collection.insertOne({ workspaceId: OTHER_WS, employeeId: R, name: "Other tenant", ref: "CLM-9", status: "submitted", approverId: SA, submittedAt: new Date() } as any);
    await Report.collection.insertOne({ workspaceId: WS, employeeId: R, name: "Home tenant", ref: "CLM-8", status: "submitted", approverId: SA, submittedAt: new Date() } as any);

    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const { default: router } = await import("../routes/myApprovals.js");
    const app = express();
    app.use((req: any, _res, next) => {
      req.user = { sub: String(SA), roles: ["SUPERADMIN"] };
      next();
    });
    app.use("/api/my-approvals", router);
    const res = await request(app).get("/api/my-approvals");
    expect(res.status).toBe(200);
    const claims = res.body.items.filter((i: any) => i.source === "expenseClaim");
    expect(claims.map((c: any) => c.summary)).toEqual([expect.stringContaining("Home tenant")]);
  });
});

describe("Workspace Leader — /api/my-approvals travel requests equal the live inbox", () => {
  it("lists exactly the ids GET /api/approvals/requests/inbox returns", async () => {
    // Workspace configured for the approval flow; W is its Workspace Leader.
    await CustomerWorkspace.collection.insertOne({
      _id: WS, customerId: "CUST-WL", status: "ACTIVE",
      config: { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } },
    } as any);
    const W = id();
    await User.collection.insertOne({
      _id: W, workspaceId: WS, customerId: "CUST-WL", email: "w@x.test", name: "Leader W", roles: ["WORKSPACE_LEADER"],
    } as any);
    // Extra rows the inbox must NOT list for W: W's own request, another
    // tenant's, and one already decided.
    await ApprovalRequest.collection.insertMany([
      { workspaceId: WS, status: "pending", stage: "REQUEST_RAISED", managerEmail: "a@x.test", frontlinerEmail: "w@x.test", frontlinerId: String(W), createdAt: new Date("2026-11-03") },
      { workspaceId: OTHER_WS, status: "pending", stage: "REQUEST_RAISED", managerEmail: "w@x.test", frontlinerId: String(R), createdAt: new Date("2026-11-03") },
      { workspaceId: WS, status: "approved", stage: "REQUEST_APPROVED", managerEmail: "w@x.test", frontlinerId: String(R), createdAt: new Date("2026-11-03") },
    ] as any);

    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const { default: approvalsRouter } = await import("../routes/approvals.js");
    const { default: myApprovalsRouter } = await import("../routes/myApprovals.js");
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = { sub: String(W), email: "w@x.test", roles: ["WORKSPACE_LEADER"], customerId: "CUST-WL" };
      next();
    });
    app.use("/api/approvals", approvalsRouter);
    app.use("/api/my-approvals", myApprovalsRouter);

    const inbox = await request(app).get("/api/approvals/requests/inbox");
    expect(inbox.status).toBe(200);
    const inboxIds = (inbox.body.rows || []).map((r: any) => String(r._id)).sort();
    // A leader sees the workspace's pending requests (seed: 2) minus their own.
    expect(inboxIds).toHaveLength(2);

    const mine = await request(app).get("/api/my-approvals");
    expect(mine.status).toBe(200);
    expect(mine.body.sources.travelRequest).toBe("ok");
    const myIds = mine.body.items.filter((i: any) => i.source === "travelRequest").map((i: any) => i.id).sort();
    expect(myIds).toEqual(inboxIds);
    expect(mine.body.items.filter((i: any) => i.source === "travelRequest").every((i: any) => !i.inline)).toBe(true);
  }, 30_000); // loads the full approvals router; 5s default is too tight under the full suite
});
