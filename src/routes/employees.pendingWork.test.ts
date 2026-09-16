// Pre-deactivation guard + Employment Status coupling (2026-09-16).
//
// Real Mongo, real routers. Proves:
//   • GET /employees/:id/pending-work returns the open items per bucket and
//     excludes resolved ones; the standing section returns counts + names;
//     an unresolved User↔Employee join returns a FLAG, never a silent 0;
//     cross-tenant → 404; a no-work user gets an empty result.
//   • A terminal employmentStatus saved through PUT /employees/:id flips
//     User.status → INACTIVE via setUserActiveStatus (audit row, snapshot),
//     value-based: it fires on an unrelated-field save too. A non-terminal
//     save never reactivates.
//   • POST /employees with a terminal status → 400.
//   • Deactivation is advisory: PATCH proceeds with pending work open and
//     records the snapshot + acknowledgment on the audit row.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/employee-pending-work-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const WS = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const OTHER_WS = new mongoose.Types.ObjectId("66c0000000000000000000ff");

const ids = vi.hoisted(() => ({
  admin: "66c000000000000000000001",
  ravi: "66c000000000000000000002", // the person being deactivated — has everything
  noWork: "66c000000000000000000003", // clean user, has an Employee row
  noEmployee: "66c000000000000000000004", // no Employee row → unresolved join
  report1: "66c000000000000000000005", // Ravi's direct report
  report2: "66c000000000000000000006", // Ravi's direct report
  peer: "66c000000000000000000007",
  otherAdmin: "66c000000000000000000008",
  resigned: "66c000000000000000000009", // already carries "Resigned", still ACTIVE
}));
const caller = vi.hoisted(() => ({ current: "admin" as "admin" | "otherAdmin" }));

vi.mock("../middleware/auth.js", () => {
  const inject = (req: any, _res: any, next: any) => {
    req.user =
      caller.current === "admin"
        ? { id: ids.admin, _id: ids.admin, sub: ids.admin, roles: ["ADMIN"], email: "ops@plumtrips.com" }
        : { id: ids.otherAdmin, _id: ids.otherAdmin, sub: ids.otherAdmin, roles: ["ADMIN"], email: "admin@other.test" };
    next();
  };
  return { requireAuth: inject, default: inject };
});
vi.mock("../middleware/requireWorkspace.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    requireWorkspace: (req: any, _res: any, next: any) => {
      req.workspaceObjectId = caller.current === "otherAdmin"
        ? new mongoose.Types.ObjectId("66c0000000000000000000ff")
        : new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
      next();
    },
  };
});

const { default: User } = await import("../models/User.js");
const { default: Employee } = await import("../models/Employee.js");
const { default: UserStatusAudit } = await import("../models/UserStatusAudit.js");
const { default: Task } = await import("../models/Task.js");
const { default: Ticket } = await import("../models/Ticket.js");
const { default: Report } = await import("../models/Report.js");
const { default: ExpenseAdvance } = await import("../models/ExpenseAdvance.js");
const { default: SBTRequest } = await import("../models/SBTRequest.js");
const { default: ApprovalRequest } = await import("../models/ApprovalRequest.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { default: VisaApplication } = await import("../models/VisaApplication.js");
const { default: LeaveRequest } = await import("../models/LeaveRequest.js");
const { default: Attendance } = await import("../models/Attendance.js");
const { default: Lead } = await import("../models/Lead.js");
const { default: Opportunity } = await import("../models/Opportunity.js");
const { default: ReimbursementClaim } = await import("../models/ReimbursementClaim.js");
const { default: EmployeeDeclaration } = await import("../models/EmployeeDeclaration.js");
const { default: ManualDateChangeRequest } = await import("../models/ManualDateChangeRequest.js");
const { default: Department } = await import("../models/Department.js");
const { default: CRMCompany } = await import("../models/CRMCompany.js");
const { default: CRMContact } = await import("../models/CRMContact.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: TravellerProfile } = await import("../models/TravellerProfile.js");
const { default: Pipeline } = await import("../models/Pipeline.js");
const { default: employeesRouter } = await import("./employees.js");
const { collectPendingWork } = await import("../services/pendingWork.service.js");

let mongod: MongoMemoryServer;
const oid = (s: string) => new mongoose.Types.ObjectId(s);
const emp = { ravi: new mongoose.Types.ObjectId(), noWork: new mongoose.Types.ObjectId(), report1: new mongoose.Types.ObjectId(), report2: new mongoose.Types.ObjectId(), resigned: new mongoose.Types.ObjectId() };

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/employees", employeesRouter);
  return a;
}
const pendingWork = (id: any) => request(app()).get(`/api/employees/${id}/pending-work`);
const byKey = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.key, r]));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const RAVI = oid(ids.ravi);

  await User.collection.insertMany([
    { _id: oid(ids.admin), name: "Ops Admin", email: "ops@plumtrips.com", roles: ["ADMIN"], workspaceId: WS, passwordHash: "x", status: "ACTIVE" },
    { _id: RAVI, name: "Ravi Menon", email: "ravi@plumtrips.com", roles: ["MANAGER"], workspaceId: WS, passwordHash: "x", status: "ACTIVE", employmentStatus: "Active" },
    { _id: oid(ids.noWork), name: "Neha Clean", email: "neha@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: WS, passwordHash: "x", status: "ACTIVE" },
    { _id: oid(ids.noEmployee), name: "Orphan User", email: "orphan@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: WS, passwordHash: "x", status: "ACTIVE" },
    // Reports-to Ravi in User-space (managerId) AND Employee-space below.
    { _id: oid(ids.report1), name: "Asha Report", email: "asha@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: WS, passwordHash: "x", status: "ACTIVE", managerId: RAVI },
    { _id: oid(ids.report2), name: "Bilal Report", email: "bilal@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: WS, passwordHash: "x", status: "ACTIVE", managerL2Id: RAVI, sbtAssignedBookerId: RAVI },
    { _id: oid(ids.peer), name: "Peer Person", email: "peer@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: WS, passwordHash: "x", status: "ACTIVE" },
    { _id: oid(ids.otherAdmin), name: "Other Admin", email: "admin@other.test", roles: ["ADMIN"], workspaceId: OTHER_WS, passwordHash: "x", status: "ACTIVE" },
    { _id: oid(ids.resigned), name: "Gone Already", email: "gone@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: WS, passwordHash: "x", status: "ACTIVE", employmentStatus: "Resigned", jobLocation: "Pune" },
  ] as any[]);
  await Employee.collection.insertMany([
    { _id: emp.ravi, fullName: "Ravi Menon", email: "ravi@plumtrips.com", ownerId: RAVI, workspaceId: WS, status: "ACTIVE", isActive: true },
    { _id: emp.noWork, fullName: "Neha Clean", email: "neha@plumtrips.com", ownerId: oid(ids.noWork), workspaceId: WS, status: "ACTIVE", isActive: true },
    { _id: emp.report1, fullName: "Asha Report", email: "asha@plumtrips.com", ownerId: oid(ids.report1), workspaceId: WS, status: "ACTIVE", isActive: true, managerId: emp.ravi },
    { _id: emp.report2, fullName: "Bilal Report", email: "bilal@plumtrips.com", ownerId: oid(ids.report2), workspaceId: WS, status: "ACTIVE", isActive: true, managerId: emp.ravi },
    { _id: emp.resigned, fullName: "Gone Already", email: "gone@plumtrips.com", ownerId: oid(ids.resigned), workspaceId: WS, status: "ACTIVE", isActive: true },
  ] as any[]);

  const now = new Date();
  // ── BUCKET 1 fixtures: one open + one resolved per source ──
  await Task.collection.insertMany([
    { title: "Chase Acme PO", assignedTo: RAVI, createdBy: RAVI, status: "OPEN", isActive: true, workspaceId: String(WS) },
    { title: "Done task", assignedTo: RAVI, createdBy: RAVI, status: "DONE", isActive: true, workspaceId: String(WS) },
    { title: "Soft-deleted task", assignedTo: RAVI, createdBy: RAVI, status: "OPEN", isActive: false, workspaceId: String(WS) },
  ] as any[]);
  await Ticket.collection.insertMany([
    { ticketRef: "TK-1001", subject: "Refund not received", assignedTo: RAVI, status: "WAITING_CLIENT", priority: "NORMAL" },
    { ticketRef: "TK-1000", subject: "Closed one", assignedTo: RAVI, status: "CLOSED", priority: "NORMAL" },
  ] as any[]);
  await Report.collection.insertMany([
    { workspaceId: WS, employeeId: oid(ids.peer), name: "Mumbai trip", ref: "EXP-001", status: "submitted", approverId: RAVI },
    { workspaceId: WS, employeeId: oid(ids.peer), name: "Old trip", ref: "EXP-000", status: "approved", approverId: RAVI },
    { workspaceId: WS, employeeId: RAVI, name: "Ravi's own claim", ref: "EXP-002", status: "clarification_required", approverId: oid(ids.admin) },
  ] as any[]);
  await ExpenseAdvance.collection.insertMany([
    { workspaceId: WS, requesterId: oid(ids.peer), ref: "ADV-1", purpose: "Delhi", amount: 5000, status: "awaiting_approval", approverId: RAVI },
    { workspaceId: WS, requesterId: oid(ids.peer), ref: "ADV-0", purpose: "Old", amount: 100, status: "settled", approverId: RAVI },
    { workspaceId: WS, requesterId: RAVI, ref: "ADV-2", purpose: "Ravi own", amount: 900, status: "disbursed", approverId: oid(ids.admin) },
  ] as any[]);
  await SBTRequest.collection.insertMany([
    { workspaceId: WS, requesterId: oid(ids.peer), assignedBookerId: RAVI, type: "flight", status: "PENDING", searchParams: {}, selectedOption: {}, passengerDetails: [{ firstName: "P", lastName: "Q", gender: "Male" }] },
    { workspaceId: WS, requesterId: oid(ids.peer), assignedBookerId: RAVI, type: "flight", status: "BOOKED", searchParams: {}, selectedOption: {} },
    { workspaceId: WS, requesterId: RAVI, assignedBookerId: oid(ids.admin), type: "hotel", status: "PENDING", searchParams: {}, selectedOption: {} },
  ] as any[]);
  // Travel approvals: the LIVE model (routes/approvals.ts). People are STRING
  // user ids + email; managerId is absent when the approver email did not
  // resolve to a user at create time (the inbox matches managerEmail).
  // On-hold is written as status "pending" + stage REQUEST_ON_HOLD.
  await ApprovalRequest.collection.insertMany([
    // Ravi is the approver, by id — awaiting his decision
    { workspaceId: WS, ticketId: "T-100", customerName: "Acme", frontlinerId: String(ids.peer), frontlinerEmail: "peer@plumtrips.com", managerId: String(RAVI), managerEmail: "ravi@plumtrips.com", status: "pending", stage: "REQUEST_RAISED" },
    // Ravi is the approver by EMAIL only (no managerId) and it is on hold — still his
    { workspaceId: WS, ticketId: "T-102", frontlinerId: String(ids.peer), frontlinerEmail: "peer@plumtrips.com", managerEmail: "Ravi@Plumtrips.com", status: "pending", stage: "REQUEST_ON_HOLD", adminState: "on_hold" },
    // Already decided — excluded
    { workspaceId: WS, ticketId: "T-099", frontlinerId: String(ids.peer), frontlinerEmail: "peer@plumtrips.com", managerId: String(RAVI), managerEmail: "ravi@plumtrips.com", status: "approved", stage: "PROPOSAL_PENDING", adminState: "pending" },
    { workspaceId: WS, ticketId: "T-098", frontlinerId: String(ids.peer), frontlinerEmail: "peer@plumtrips.com", managerId: String(RAVI), managerEmail: "ravi@plumtrips.com", status: "declined", stage: "REQUEST_DECLINED", adminState: "cancelled" },
    // Raised in ANOTHER customer workspace with Ravi as approver — COUNTED:
    // ApprovalRequest.workspaceId is the tenant the request was raised in
    // (prod: HOUSE approvers on customer-workspace requests), not the
    // approver's home workspace, so the source is not workspace-scoped.
    { workspaceId: OTHER_WS, ticketId: "T-OTHER", frontlinerId: String(ids.peer), frontlinerEmail: "peer@other.test", managerId: String(RAVI), managerEmail: "ravi@plumtrips.com", status: "pending", stage: "REQUEST_RAISED" },
    // Same workspace, a DIFFERENT approver (id and email) — never Ravi's
    { workspaceId: WS, ticketId: "T-NOT-RAVI", frontlinerId: String(ids.peer), frontlinerEmail: "peer@plumtrips.com", managerId: String(ids.admin), managerEmail: "ops@plumtrips.com", status: "pending", stage: "REQUEST_RAISED" },
    // Ravi RAISED this one, awaiting the admin — owned, still open
    { workspaceId: WS, ticketId: "T-101", frontlinerId: String(RAVI), frontlinerEmail: "ravi@plumtrips.com", managerId: String(ids.admin), managerEmail: "ops@plumtrips.com", status: "pending", stage: "REQUEST_RAISED" },
    // Ravi raised it, but frontlinerId is a STALE id (the User doc it named
    // was replaced in the duplicate-user cleanup) — attributed by email, the
    // live Inteletek shape (4 of prod's 6 pending rows, 2026-09-16). Counted.
    { workspaceId: WS, ticketId: "T-STALE", frontlinerId: new mongoose.Types.ObjectId().toHexString(), frontlinerEmail: "ravi@plumtrips.com", managerId: String(ids.admin), managerEmail: "ops@plumtrips.com", status: "pending", stage: "REQUEST_RAISED" },
    // Ravi raised, already approved — excluded from "owned"
    { workspaceId: WS, ticketId: "T-097", frontlinerId: String(RAVI), frontlinerEmail: "ravi@plumtrips.com", managerId: String(ids.admin), managerEmail: "ops@plumtrips.com", status: "approved", stage: "BOOKING_DONE", adminState: "done" },
  ] as any[]);
  await ManualBooking.collection.insertMany([
    { workspaceId: WS, bookingRef: "MB-1", travellerName: "X", status: "WIP", isActive: true, assignPerson: RAVI, assignmentStatus: "ASSIGNED" },
    { workspaceId: WS, bookingRef: "MB-0", travellerName: "Y", status: "INVOICED", isActive: true, assignPerson: RAVI, assignmentStatus: "ASSIGNED" },
  ] as any[]);
  await VisaApplication.collection.insertMany([
    { workspaceId: WS, destinationName: "Türkiye", status: "docs_under_review", assignedConciergeUserId: RAVI },
    { workspaceId: WS, destinationName: "Japan", status: "closed", assignedConciergeUserId: RAVI },
    { workspaceId: WS, destinationName: "France", status: "draft", assignedScreeningOfficerId: RAVI },
  ] as any[]);
  await LeaveRequest.collection.insertMany([
    { workspaceId: WS, userId: oid(ids.report1), type: "CASUAL", from: now, to: now, status: "PENDING" },
    { workspaceId: WS, userId: oid(ids.report2), type: "SICK", from: now, to: now, status: "APPROVED" },
    { workspaceId: WS, userId: RAVI, type: "EARNED", from: now, to: now, status: "PENDING" },
  ] as any[]);
  await Attendance.collection.insertMany([
    { workspaceId: WS, userId: oid(ids.report2), date: "2026-09-10", odRequests: [{ reason: "client visit", status: "PENDING", requestedAt: now }] },
    { workspaceId: WS, userId: oid(ids.report1), date: "2026-09-11", odRequests: [{ reason: "done", status: "APPROVED", requestedAt: now }] },
  ] as any[]);
  // ── BUCKET 2 fixtures ──
  await Lead.collection.insertMany([
    { leadCode: "L-1", contactName: "A", contactPhone: "1", companyName: "Acme", stage: "negotiation", assignedTo: RAVI, createdAt: now },
    { leadCode: "L-2", contactName: "B", contactPhone: "2", companyName: "Won Co", stage: "won", assignedTo: RAVI, createdAt: now },
  ] as any[]);
  await Opportunity.collection.insertMany([
    { name: "Acme corporate", pipeline: "corporate", stage: "proposal", service: "flights", ownerUserId: RAVI, createdBy: RAVI },
    { name: "Lost deal", pipeline: "corporate", stage: "closed_lost", service: "flights", ownerUserId: RAVI, createdBy: RAVI, closedAt: now },
  ] as any[]);
  await ReimbursementClaim.collection.insertMany([
    { workspaceId: WS, userId: RAVI, month: "2026-08", status: "SUBMITTED" },
    { workspaceId: WS, userId: RAVI, month: "2026-07", status: "PAID" },
  ] as any[]);
  await EmployeeDeclaration.collection.insertMany([
    { workspaceId: WS, userId: RAVI, financialYear: "2026-27", declarationStatus: "SUBMITTED", proofStatus: "NOT_STARTED" },
    { workspaceId: WS, userId: RAVI, financialYear: "2025-26", declarationStatus: "FROZEN", proofStatus: "VERIFIED" },
  ] as any[]);
  await ManualDateChangeRequest.collection.insertMany([
    { workspaceId: WS, userId: RAVI, hotelName: "Taj", requestedNewCheckIn: "2026-10-01", requestedNewCheckOut: "2026-10-03", status: "IN_DISCUSSION" },
    { workspaceId: WS, userId: RAVI, hotelName: "Oberoi", requestedNewCheckIn: "2026-10-01", requestedNewCheckOut: "2026-10-03", status: "RESOLVED" },
  ] as any[]);
  // ── STANDING fixtures ──
  await Department.collection.insertMany([
    { workspaceId: WS, name: "Operations", managerId: RAVI, isActive: true },
    { workspaceId: WS, name: "Old Dept", managerId: RAVI, isActive: false },
  ] as any[]);
  await CRMCompany.collection.insertOne({ name: "Acme Ltd", accountManagerId: RAVI } as any);
  await CRMContact.collection.insertMany([
    { firstName: "Cara", lastName: "Contact", assignedTo: RAVI, status: "active" },
    { firstName: "Gone", lastName: "Contact", assignedTo: RAVI, status: "inactive" },
  ] as any[]);
  await CustomerWorkspace.collection.insertOne({ customerId: "cust-1", companyName: "Client One", accountManagerId: RAVI, status: "ACTIVE" } as any);
  await TravellerProfile.collection.insertOne({ workspaceId: OTHER_WS, name: "Traveller T", tourApproverId: RAVI, isActive: true } as any);
  await Pipeline.collection.insertOne({ name: "Corporate", ownerId: RAVI } as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe("GET /employees/:id/pending-work", () => {
  it("returns the open items per bucket and excludes resolved ones", async () => {
    caller.current = "admin";
    const res = await pendingWork(emp.ravi);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(ids.ravi);
    expect(res.body.employeeId).toBe(String(emp.ravi));
    expect(res.body.flags).toEqual([]);

    const b1 = byKey(res.body.awaitingAction);
    expect(b1.tasks.count).toBe(1);
    expect(b1.tasks.items[0].title).toBe("Chase Acme PO");
    expect(b1.tickets.count).toBe(1);
    expect(b1.tickets.items[0].href).toMatch(/^\/admin\/tickets\//);
    expect(b1.expenseClaimsToApprove.count).toBe(1);
    expect(b1.expenseClaimsToApprove.items[0].title).toBe("EXP-001 · Mumbai trip");
    expect(b1.advancesToApprove.count).toBe(1);
    expect(b1.sbtRequestsToBook.count).toBe(1);
    expect(b1.sbtRequestsToBook.items[0].title).toBe("flight request · P Q");
    // ApprovalRequest (live model): by managerId (T-100), by managerEmail only
    // on hold (T-102), raised in another workspace (T-OTHER); approved /
    // declined / different-approver rows excluded.
    expect(b1.travelApprovalsToDecide.count).toBe(3);
    expect(b1.travelApprovalsToDecide.items.map((i: any) => i.title).sort()).toEqual(["Ticket T-100 · Acme", "Ticket T-102", "Ticket T-OTHER"]);
    expect(b1.travelApprovalsToDecide.items.find((i: any) => i.title === "Ticket T-102").status).toBe("on hold");
    expect(b1.travelApprovalsToDecide.hrefAll).toBe("/admin/approvals");
    expect(b1.manualBookingsAssigned.count).toBe(1);
    expect(b1.visaApplicationsAssigned.count).toBe(1); // closed + draft excluded
    expect(b1.leaveApprovalsOfReports.count).toBe(1); // report1 PENDING; report2 APPROVED excluded
    expect(b1.odApprovalsOfReports.count).toBe(1);
    expect(res.body.totals.awaitingAction).toBe(12);

    const b2 = byKey(res.body.owned);
    expect(b2.leads.count).toBe(1);
    expect(b2.leads.items[0].title).toBe("L-1 · Acme");
    expect(b2.leads.items[0].href).toMatch(/^\/crm\/leads\/[0-9a-f]{24}$/); // CRM routes live under /crm
    expect(b2.opportunities.count).toBe(1);
    // CRM v2 flags are unset in this suite → the opportunity board does not
    // exist (router folds it into /crm/leads; /api/opportunities 404s), so the
    // source carries no link and says where to act.
    expect(b2.opportunities.hrefAll).toBeNull();
    expect(b2.opportunities.items[0].href).toBeNull();
    expect(b2.opportunities.note).toMatch(/CRM v2/);
    expect(b2.ownLeaveRequests.count).toBe(1);
    expect(b2.ownExpenseClaims.count).toBe(1);
    expect(b2.ownAdvances.count).toBe(1);
    expect(b2.ownReimbursementClaims.count).toBe(1);
    expect(b2.ownSbtRequests.count).toBe(1);
    // T-101 (by id) + T-STALE (stale frontlinerId, matched by email); T-097 approved excluded
    expect(b2.ownTravelApprovals.count).toBe(2);
    expect(b2.ownTravelApprovals.items.map((i: any) => i.title).sort()).toEqual(["Ticket T-101", "Ticket T-STALE"]);
    expect(b2.ownDeclarations.count).toBe(1);
    expect(b2.ownDateChangeRequests.count).toBe(1);
    expect(res.body.totals.owned).toBe(11);

    // Every emitted link must be a route an ADMIN can load (router.tsx);
    // sources with no admin-reachable page carry no link and say why.
    const ADMIN_ROUTES = [
      "/admin/tasks", "/admin/tickets", "/expenses/approvals", "/expenses/advances/queues", "/admin/approvals",
      "/admin/manual-bookings", "/admin/visa-applications", "/leaves/team", "/attendance/regularize",
      "/crm/leads", "/crm/opportunities", "/payroll/reimbursements", "/payroll/declarations/manage", "/admin/sbt/date-change-requests",
    ];
    const DETAIL = /^\/(admin\/tickets|expenses\/claims|expenses\/advances|admin\/manual-bookings|admin\/visa-applications|crm\/leads|crm\/opportunities)\/[0-9a-f]{24}(\/edit)?$/;
    for (const src of [...res.body.awaitingAction, ...res.body.owned]) {
      if (src.hrefAll === null) {
        expect(src.note).toMatch(/no admin page/i);
        for (const it of src.items) expect(it.href).toBeNull();
        continue;
      }
      expect(ADMIN_ROUTES).toContain(src.hrefAll);
      for (const it of src.items) expect(it.href === src.hrefAll || DETAIL.test(it.href)).toBe(true);
    }
    expect([...res.body.awaitingAction, ...res.body.owned].filter((s: any) => s.hrefAll === null).map((s: any) => s.key))
      .toEqual(["sbtRequestsToBook", "opportunities", "ownSbtRequests"]);
  });

  it("links opportunities to /crm/opportunities only when a CRM v2 flag is on", async () => {
    caller.current = "admin";
    process.env.CRM_V2_OPPORTUNITY = "true";
    try {
      const res = await pendingWork(emp.ravi);
      const opp = byKey(res.body.owned).opportunities;
      expect(opp.hrefAll).toBe("/crm/opportunities");
      expect(opp.items[0].href).toMatch(/^\/crm\/opportunities\/[0-9a-f]{24}$/);
      expect(opp.note).toBeUndefined();
    } finally {
      delete process.env.CRM_V2_OPPORTUNITY;
    }
  });

  it("standing section returns counts + names, deduplicating reports across User- and Employee-space", async () => {
    caller.current = "admin";
    const res = await pendingWork(emp.ravi);
    const st = byKey(res.body.standing);
    // Asha: User.managerId + Employee.managerId; Bilal: User.managerL2Id + Employee.managerId → 2 people, once each.
    expect(st.reportsTo.count).toBe(2);
    expect(st.reportsTo.names).toEqual(["Asha Report", "Bilal Report"]);
    expect(st.departmentManager).toMatchObject({ count: 1, names: ["Operations"] });
    expect(st.crmAccountManager).toMatchObject({ count: 1, names: ["Acme Ltd"] });
    expect(st.crmContacts).toMatchObject({ count: 1, names: ["Cara Contact"] });
    expect(st.workspaceRoles).toMatchObject({ count: 1, names: ["Client One"] });
    expect(st.travellerApprover).toMatchObject({ count: 1, names: ["Traveller T"] });
    expect(st.sbtBookerFor).toMatchObject({ count: 1, names: ["Bilal Report"] });
    expect(st.pipelinesOwned).toMatchObject({ count: 1, names: ["Corporate"] });
    expect(res.body.totals.standing).toBe(9);
  });

  it("a user with nothing open gets an empty result — zeros, no flags, no standing roles", async () => {
    caller.current = "admin";
    const res = await pendingWork(emp.noWork);
    expect(res.status).toBe(200);
    expect(res.body.flags).toEqual([]);
    expect(res.body.totals).toEqual({ awaitingAction: 0, owned: 0, standing: 0 });
    for (const s of [...res.body.awaitingAction, ...res.body.owned]) {
      expect(s.count).toBe(0);
      expect(s.items).toEqual([]);
      expect(s.unresolved).toBeUndefined();
    }
  });

  it("an unresolved User↔Employee join returns a flag and null counts — never a silent 0", async () => {
    caller.current = "admin";
    const res = await pendingWork(ids.noEmployee); // User id; no Employee row
    expect(res.status).toBe(200);
    expect(res.body.flags.length).toBe(1);
    expect(res.body.flags[0]).toMatch(/could not be resolved.*verify manually/i);
    const b1 = byKey(res.body.awaitingAction);
    expect(b1.leaveApprovalsOfReports).toMatchObject({ count: null, unresolved: true });
    expect(b1.odApprovalsOfReports).toMatchObject({ count: null, unresolved: true });
    expect(byKey(res.body.standing).reportsTo).toMatchObject({ count: null, unresolved: true });
    // sources that do not depend on the join still resolve normally
    expect(b1.tasks.count).toBe(0);
  });

  it("refuses cross-tenant with 404", async () => {
    caller.current = "otherAdmin";
    const res = await pendingWork(emp.ravi);
    expect(res.status).toBe(404);
  });
});

describe("Employment Status coupling", () => {
  it("POST /employees with a terminal Employment Status is refused (400)", async () => {
    caller.current = "admin";
    const res = await request(app()).post("/api/employees").send({
      officialEmail: "new.person@plumtrips.com", firstName: "New", lastName: "Person", employmentStatus: "Terminated",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TERMINAL_EMPLOYMENT_STATUS_ON_CREATE");
    expect(await User.countDocuments({ email: "new.person@plumtrips.com" })).toBe(0);
  });

  it("value-based: an UNRELATED-field save on a user already marked Resigned deactivates them via the helper", async () => {
    caller.current = "admin";
    // The form PUTs its whole row back; only jobLocation changed.
    const res = await request(app()).put(`/api/employees/${emp.resigned}`).send({
      email: "gone@plumtrips.com", officialEmail: "gone@plumtrips.com", name: "Gone Already",
      employmentStatus: "Resigned", jobLocation: "Mumbai", acknowledgedPendingWork: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("INACTIVE");
    expect(res.body.jobLocation).toBe("Mumbai");

    const u: any = await User.findById(ids.resigned).lean();
    expect(u.status).toBe("INACTIVE");
    expect(u.employmentStatus).toBe("Resigned");
    const e: any = await Employee.findById(emp.resigned).lean();
    expect(e.status).toBe("INACTIVE");
    expect(e.isActive).toBe(false);

    const audit: any = await UserStatusAudit.findOne({ userId: oid(ids.resigned) }).lean();
    expect(audit).toMatchObject({
      fromStatus: "ACTIVE", toStatus: "INACTIVE", trigger: "employment_status", employmentStatus: "Resigned",
      actorEmail: "ops@plumtrips.com", acknowledgedPendingWork: true,
    });
    expect(audit.pendingWorkSnapshot.totals).toEqual({ awaitingAction: 0, owned: 0, standing: 0 });
  });

  it("a non-terminal save on an INACTIVE user does not reactivate (explicit Reactivate only)", async () => {
    caller.current = "admin";
    const res = await request(app()).put(`/api/employees/${emp.resigned}`).send({
      email: "gone@plumtrips.com", officialEmail: "gone@plumtrips.com", name: "Gone Already", employmentStatus: "Active",
    });
    expect(res.status).toBe(200);
    const u: any = await User.findById(ids.resigned).lean();
    expect(u.status).toBe("INACTIVE");
    expect(u.employmentStatus).toBe("Active");
    expect(await UserStatusAudit.countDocuments({ userId: oid(ids.resigned) })).toBe(1); // no second row
  });

  it("saving Terminated on an active employee with pending work still deactivates (advisory) and snapshots the counts", async () => {
    caller.current = "admin";
    const res = await request(app()).put(`/api/employees/${emp.ravi}`).send({
      email: "ravi@plumtrips.com", officialEmail: "ravi@plumtrips.com", name: "Ravi Menon",
      employmentStatus: "terminated ", acknowledgedPendingWork: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("INACTIVE");
    expect((await User.findById(ids.ravi).lean() as any).status).toBe("INACTIVE");

    const audit: any = await UserStatusAudit.findOne({ userId: oid(ids.ravi) }).lean();
    expect(audit.trigger).toBe("employment_status");
    expect(audit.employmentStatus).toBe("terminated");
    expect(audit.pendingWorkSnapshot.totals).toEqual({ awaitingAction: 12, owned: 11, standing: 9 });
    expect(audit.pendingWorkSnapshot.awaitingAction.tasks).toBe(1);
    expect(audit.pendingWorkSnapshot.standing.reportsTo).toBe(2);
  });
});

describe("explicit deactivation is advisory on pending work", () => {
  it("PATCH INACTIVE proceeds with items open, returns the totals and records snapshot + acknowledgment", async () => {
    caller.current = "admin";
    // Give Asha (a direct report, clean) one open task so the guard has content.
    await Task.collection.insertOne({ title: "Asha open", assignedTo: oid(ids.report1), createdBy: oid(ids.report1), status: "IN_PROGRESS", isActive: true, workspaceId: String(WS) } as any);

    const res = await request(app()).patch(`/api/employees/${emp.report1}/status`).send({ status: "INACTIVE", acknowledgedPendingWork: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: "INACTIVE", changed: true });
    expect(res.body.pendingWorkTotals.awaitingAction).toBe(1);

    const audit: any = await UserStatusAudit.findOne({ userId: oid(ids.report1) }).lean();
    expect(audit).toMatchObject({ trigger: "explicit", acknowledgedPendingWork: true, actorEmail: "ops@plumtrips.com" });
    expect(audit.pendingWorkSnapshot.awaitingAction.tasks).toBe(1);

    // Reactivation writes its own row, with no snapshot.
    const back = await request(app()).patch(`/api/employees/${emp.report1}/status`).send({ status: "ACTIVE" });
    expect(back.status).toBe(200);
    const rows = await UserStatusAudit.find({ userId: oid(ids.report1) }).sort({ createdAt: 1 }).lean();
    expect(rows.map((r: any) => r.toStatus)).toEqual(["INACTIVE", "ACTIVE"]);
    expect((rows[1] as any).pendingWorkSnapshot).toBeUndefined();
  });

  it("collectPendingWork is read-only — running it changes nothing", async () => {
    const before = await Promise.all([Task.countDocuments({}), LeaveRequest.countDocuments({}), User.countDocuments({ status: "INACTIVE" })]);
    await collectPendingWork({ userId: ids.ravi, workspaceId: WS });
    const after = await Promise.all([Task.countDocuments({}), LeaveRequest.countDocuments({}), User.countDocuments({ status: "INACTIVE" })]);
    expect(after).toEqual(before);
  });
});
