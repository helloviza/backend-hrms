// /profile/me Phase 1 — GET /api/my-space/admin-overview (computeAdminOverview).
// Real Mongo (mongodb-memory-server). The gates are the decision functions
// extracted from the real middleware of the endpoints each block mirrors —
// nothing here is mocked, so these tests prove which callers get which
// blocks, that one block's failure is contained, and that the call writes
// nothing to the database.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import jwt from "jsonwebtoken";

const SECRET = "admin-overview-test-secret";
process.env.JWT_SECRET = SECRET;
process.env.JWT_REFRESH_SECRET ||= "admin-overview-test-refresh";
process.env.DEPLOYMENT_MODE = "plumbox";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
delete process.env.DISABLE_AUTH;

const { default: User } = await import("../models/User.js");
const { default: Employee } = await import("../models/Employee.js");
const { default: Attendance } = await import("../models/Attendance.js");
const { default: LeaveRequest } = await import("../models/LeaveRequest.js");
const { default: Department } = await import("../models/Department.js");
const { default: Onboarding } = await import("../models/Onboarding.js");
const { default: Report } = await import("../models/Report.js");
const { default: TravelBooking } = await import("../models/TravelBooking.js");
const { default: Invoice } = await import("../models/Invoice.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ApprovalRequest } = await import("../models/ApprovalRequest.js");
const { default: LeaveBalance } = await import("../models/LeaveBalance.js");
const { default: Task } = await import("../models/Task.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { computeAdminOverview, __blocks } = await import("./mySpaceAdminOverview.service.js");
const { PLUMTRIPS_HOUSE_WORKSPACE_ID } = await import("./mySpaceFeatures.js");

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  // monitorCommands: the zero-writes test below records every command the driver sends.
  await mongoose.connect(mongod.getUri(), { monitorCommands: true });
  // Build every model's indexes ONCE, up front. Tests must never drop the
  // database while these builds are in flight (that raced: "Index build
  // failed … caused by dropDatabase command"), so beforeEach empties the
  // collections instead.
  // allSettled: a pre-existing index-name clash on an unrelated model (bookingRef_1)
  // must not fail this file; the point is only that every build has finished.
  await Promise.allSettled(mongoose.modelNames().map((n) => mongoose.model(n).init()));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const HOUSE = new mongoose.Types.ObjectId(PLUMTRIPS_HOUSE_WORKSPACE_ID);
const TENANT = new mongoose.Types.ObjectId();
const SAAS = new mongoose.Types.ObjectId();
const oid = () => new mongoose.Types.ObjectId();

// Fri 2026-11-27 14:30 IST.
const NOW = Date.parse("2026-11-27T09:00:00Z");
const CFG = { shiftStart: "09:30", shiftEnd: "18:30", graceMinutes: 15, halfDayHours: 4.5, minHoursForPresent: 2, workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"] };

const WS_DOCS: Record<string, any> = {};

async function seedWorkspaces() {
  const docs = [
    { _id: HOUSE, customerId: oid(), status: "ACTIVE", companyName: "Plumtrips", attendanceConfig: CFG, config: { features: {} } },
    { _id: TENANT, customerId: oid(), status: "ACTIVE", companyName: "Tenant Co", attendanceConfig: CFG, config: { features: { expensesEnabled: true, invoicesEnabled: true, approvalFlowEnabled: true } } },
    { _id: SAAS, customerId: oid(), status: "ACTIVE", companyName: "SaaS Co", tenantType: "SAAS_HRMS", attendanceConfig: CFG, config: { features: {} } },
  ];
  await CustomerWorkspace.collection.insertMany(docs as any);
  for (const d of docs) WS_DOCS[String(d._id)] = d;
}

/** A request as it reaches the handler: requireAuth + requireWorkspace + resolveSelfWorkspace done. */
function reqFor(user: { _id: mongoose.Types.ObjectId; email: string; roles: string[]; [k: string]: any }, ws: mongoose.Types.ObjectId): any {
  const payload = { sub: String(user._id), email: user.email, roles: user.roles };
  const token = jwt.sign(payload, SECRET, { expiresIn: "1h" });
  return {
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
    query: {},
    user: { ...payload, _id: String(user._id), id: String(user._id), workspaceId: String(ws), ...user, _idRaw: undefined },
    workspaceObjectId: ws,
    workspaceId: String(ws),
    workspace: WS_DOCS[String(ws)],
    get(name: string) {
      return (this.headers as any)[name.toLowerCase()];
    },
  };
}

const person = async (ws: mongoose.Types.ObjectId, roles: string[], extra: any = {}) => {
  const _id = oid();
  const email = `${roles[0].toLowerCase()}-${String(_id).slice(-6)}@x.test`;
  await User.collection.insertOne({ _id, workspaceId: ws, email, roles, firstName: roles[0], lastName: String(_id).slice(-4), ...extra } as any);
  return { _id, email, roles };
};

const punch = (userId: any, ws: any, date: string, ins: [string, "IN" | "OUT"][]) =>
  Attendance.collection.insertOne({ workspaceId: ws, userId, date, punches: ins.map(([iso, type]) => ({ ts: new Date(iso), type })) } as any);

beforeEach(async () => {
  const cols = await mongoose.connection.db!.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
  await seedWorkspaces();
});

const at = (iso: string) => new Date(iso);

describe("admin-overview — who gets which block", () => {
  it("an EMPLOYEE gets {} — every block omitted (tenant and HOUSE)", async () => {
    const t = await person(TENANT, ["EMPLOYEE"]);
    expect((await computeAdminOverview(reqFor(t, TENANT), { now: NOW })).blocks).toEqual({});
    const h = await person(HOUSE, ["EMPLOYEE"]);
    expect((await computeAdminOverview(reqFor(h, HOUSE), { now: NOW })).blocks).toEqual({});
  });

  it("HR gets the HR blocks but not invoicesMonth until granted invoices READ", async () => {
    const hr = await person(HOUSE, ["HR"]);
    const before = await computeAdminOverview(reqFor(hr, HOUSE), { now: NOW });
    expect(Object.keys(before.blocks).sort()).toEqual(
      ["attendanceToday", "clockInToday", "departments", "employeeStatus", "headcount", "onboarding", "pendingExpenses", "pendingLeave", "recentJoiners"].sort(),
    );
    expect(before.blocks.invoicesMonth).toBeUndefined();
    expect(before.blocks.pendingTravel).toBeUndefined(); // no Admin Queue grant
    expect(before.blocks.bookingsMonth).toBeUndefined(); // HR's unified scope is OWN

    await UserPermission.collection.insertOne({ userId: String(hr._id), email: hr.email, workspaceId: HOUSE, status: "active", tier: 2, modules: { invoices: { access: "READ", scope: "ALL" } } } as any);
    const after = await computeAdminOverview(reqFor(hr, HOUSE), { now: NOW });
    expect(after.blocks.invoicesMonth).toEqual({ raisedThisMonth: 0, paidThisMonth: 0, outstandingAllOpen: 0, scope: "platform" });
    expect(after.blocks.todo).toBeUndefined(); // no tasks READ
    expect(after.blocks.topBooker).toBeUndefined(); // no manualBookings READ
  });

  it("a SaaS tenant admin never gets HOUSE-only or travel blocks", async () => {
    const ta = await person(SAAS, ["TENANT_ADMIN", "WORKSPACE_LEADER"]);
    const o = await computeAdminOverview(reqFor(ta, SAAS), { now: NOW });
    expect(o.blocks.headcount).toBeDefined();
    expect(o.blocks.attendanceToday).toBeDefined();
    expect(o.blocks.pendingTravel).toBeUndefined();
    expect(o.blocks.bookingsMonth).toBeUndefined();
    expect(o.blocks.invoicesMonth).toBeUndefined();
    expect(o.blocks.pendingExpenses).toBeUndefined(); // expensesEnabled is off for this tenant
  });

  it("a non-HOUSE ADMIN never gets pendingTravel even with the approvals feature on", async () => {
    const a = await person(TENANT, ["ADMIN"]);
    await ApprovalRequest.collection.insertOne({ workspaceId: TENANT, status: "approved", adminState: "pending" } as any);
    const o = await computeAdminOverview(reqFor(a, TENANT), { now: NOW });
    expect(o.blocks.pendingTravel).toBeUndefined();
    // expense.access isAdmin deliberately ignores the bare ADMIN token (ADMIN_ROLES), so /api/reports
    // would not show this caller the whole workspace either → omitted, not 0.
    expect(o.blocks.pendingExpenses).toBeUndefined();
  });

  it("one failing block returns {error:true}; the rest still return", async () => {
    const hr = await person(HOUSE, ["HR"]);
    const b = __blocks.find((x) => x.key === "headcount")!;
    const orig = b.run;
    b.run = async () => {
      throw new Error("boom");
    };
    try {
      const o = await computeAdminOverview(reqFor(hr, HOUSE), { now: NOW });
      expect(o.blocks.headcount).toEqual({ error: true });
      expect(o.blocks.pendingLeave).toEqual({ count: 0 });
      expect(o.blocks.departments).toEqual([]);
    } finally {
      b.run = orig;
    }
  });
});

describe("admin-overview — values and tenant isolation", () => {
  it("HR blocks count only the caller's workspace (cross-tenant fixture must not leak)", async () => {
    const hr = await person(TENANT, ["HR"]);
    await Employee.collection.insertMany([
      { workspaceId: TENANT, fullName: "T One", status: "ACTIVE", isActive: true, department: "Ops", designation: "Exec", joiningDate: at("2026-11-20T00:00:00Z") },
      { workspaceId: TENANT, fullName: "T Two", status: "EXITED", isActive: false, joiningDate: at("2026-11-21T00:00:00Z") },
      { workspaceId: TENANT, fullName: "T Future", status: "ACTIVE", isActive: true, joiningDate: at("2026-12-15T00:00:00Z") },
      { workspaceId: SAAS, fullName: "Other", status: "ACTIVE", isActive: true, joiningDate: at("2026-11-26T00:00:00Z") },
    ] as any);
    await LeaveRequest.collection.insertMany([
      { workspaceId: TENANT, userId: oid(), type: "CL", from: at("2026-12-01"), to: at("2026-12-01"), status: "PENDING" },
      { workspaceId: SAAS, userId: oid(), type: "CL", from: at("2026-12-01"), to: at("2026-12-01"), status: "PENDING" },
    ] as any);
    await Department.collection.insertMany([
      { workspaceId: TENANT, name: "Ops", isActive: true },
      { workspaceId: SAAS, name: "Sales", isActive: true },
    ] as any);
    await User.collection.updateOne({ _id: hr._id }, { $set: { department: "Ops" } });
    await User.collection.insertOne({ _id: oid(), workspaceId: SAAS, email: "s@x.test", department: "Ops", roles: ["EMPLOYEE"] } as any);
    await Onboarding.collection.insertMany([
      { workspaceId: TENANT, type: "employee", email: "a@x", token: "t1", status: "sent", expiresAt: at("2026-12-30") },
      { workspaceId: TENANT, type: "employee", email: "b@x", token: "t2", status: "sent", expiresAt: at("2026-11-01") }, // expired, not written
      { workspaceId: TENANT, type: "employee", email: "c@x", token: "t3", status: "started", expiresAt: at("2026-12-30") },
      { workspaceId: TENANT, type: "employee", email: "d@x", token: "t4", status: "verified", expiresAt: at("2026-11-01") },
      { workspaceId: TENANT, type: "employee", email: "e@x", token: "t5", status: "approved", expiresAt: at("2026-11-01") },
      { workspaceId: TENANT, type: "vendor", email: "f@x", token: "t6", status: "sent", expiresAt: at("2026-12-30") },
      { workspaceId: SAAS, type: "employee", email: "g@x", token: "t7", status: "sent", expiresAt: at("2026-12-30") },
    ] as any);

    const o = await computeAdminOverview(reqFor(hr, TENANT), { now: NOW });
    expect(o.blocks.headcount).toEqual({ total: 3, active: 2 });
    expect(o.blocks.pendingLeave).toEqual({ count: 1 });
    expect(o.blocks.departments).toEqual([{ name: "Ops", headcount: 1 }]);
    expect(o.blocks.onboarding).toEqual({
      invited: 1, inProgress: 1, submitted: 1, approved: 1,
      items: {
        invited: [{ name: "a", email: "a@x", status: "invited" }],
        inProgress: [{ name: "c", email: "c@x", status: "inProgress" }],
        submitted: [{ name: "d", email: "d@x", status: "submitted" }],
        approved: [{ name: "e", email: "e@x", status: "approved" }],
      },
    });
    expect(o.blocks.recentJoiners).toEqual([{ name: "T One", avatarUrl: null, department: "Ops", designation: "Exec", dateOfJoining: "2026-11-20" }]);
    expect(o.blocks.employeeStatus).toEqual({ total: 3, active: 2, onProbation: 0, onLeaveToday: 0, inactive: 1 });
    // read-only: the expired invite was NOT rewritten
    expect((await Onboarding.collection.findOne({ token: "t2" }))!.status).toBe("sent");
  });

  it("attendanceToday + clockInToday: IST, late vs shift+grace, leave, staff only, own workspace", async () => {
    const hr = await person(TENANT, ["HR"]);
    const onTime = await person(TENANT, ["EMPLOYEE"]);
    const late = await person(TENANT, ["EMPLOYEE"]);
    const leave = await person(TENANT, ["EMPLOYEE"]);
    await person(TENANT, ["EMPLOYEE"], { status: "INACTIVE" }); // not on the roll
    await person(TENANT, ["CUSTOMER"]); // external account, not staff
    const other = await person(SAAS, ["EMPLOYEE"]);
    await punch(onTime._id, TENANT, "2026-11-27", [["2026-11-27T03:55:00Z", "IN"], ["2026-11-27T08:00:00Z", "OUT"]]); // 09:25 IST
    await punch(late._id, TENANT, "2026-11-27", [["2026-11-27T04:20:00Z", "IN"]]); // 09:50 IST > 09:45
    await punch(other._id, SAAS, "2026-11-27", [["2026-11-27T03:00:00Z", "IN"]]);
    // a 23:50 IST punch yesterday is not "today"
    await punch(hr._id, TENANT, "2026-11-26", [["2026-11-26T18:20:00Z", "IN"]]);
    await LeaveRequest.collection.insertOne({ workspaceId: TENANT, userId: leave._id, type: "CL", from: at("2026-11-27T00:00:00Z"), to: at("2026-11-27T00:00:00Z"), status: "APPROVED" } as any);

    const o = await computeAdminOverview(reqFor(hr, TENANT), { now: NOW });
    expect(o.blocks.attendanceToday).toEqual({
      date: "2026-11-27", isWorkingDay: true, headcount: 4, present: 2, late: 1, onLeave: 1, absent: 1,
      absentees: [{ name: expect.stringMatching(/^HR /), avatarUrl: null }], // the HR user: no IN today
    });
    // late first; lateMinutes = after 09:30 + 15 min grace; worked = paired, open IN counted to now (14:30 IST)
    expect(o.blocks.clockInToday).toEqual({
      totalPunchedIn: 2,
      items: [
        { name: expect.stringMatching(/^EMPLOYEE /), avatarUrl: null, designation: "", firstIn: "2026-11-27T04:20:00.000Z", lastOut: null, isLate: true, lateMinutes: 5, workedMinutes: 280 },
        { name: expect.stringMatching(/^EMPLOYEE /), avatarUrl: null, designation: "", firstIn: "2026-11-27T03:55:00.000Z", lastOut: "2026-11-27T08:00:00.000Z", isLate: false, lateMinutes: null, workedMinutes: 245 },
      ],
    });
    expect(o.blocks.employeeStatus).toMatchObject({ onLeaveToday: 1 });
  });

  it("attendanceToday without attendanceConfig: late/isLate are null, not 0/false", async () => {
    await CustomerWorkspace.collection.updateOne({ _id: TENANT }, { $unset: { attendanceConfig: "" } });
    const hr = await person(TENANT, ["HR"]);
    await punch(hr._id, TENANT, "2026-11-27", [["2026-11-27T05:00:00Z", "IN"]]);
    const o: any = await computeAdminOverview(reqFor(hr, TENANT), { now: NOW });
    expect(o.blocks.attendanceToday.late).toBeNull();
    expect(o.blocks.clockInToday.items[0].isLate).toBeNull();
    expect(o.blocks.clockInToday.items[0].lateMinutes).toBeNull();
  });

  it("bookingsMonth (HOUSE ADMIN): CONFIRMED this IST month only; cancelled / last month / test never count", async () => {
    const admin = await person(HOUSE, ["ADMIN"]);
    const base = { service: "FLIGHT", source: "SBT", sourceType: "SBTBooking", sourceId: oid(), userId: oid(), workspaceId: TENANT };
    await TravelBooking.collection.insertMany([
      { ...base, status: "CONFIRMED", amount: 1000, bookedAt: at("2026-11-02T10:00:00Z") },
      { ...base, status: "CONFIRMED", amount: 500, bookedAt: at("2026-10-31T19:00:00Z") }, // 01 Nov 00:30 IST — this month
      { ...base, status: "CONFIRMED", amount: 9, bookedAt: at("2026-10-31T18:00:00Z") }, // 31 Oct 23:30 IST — last month
      { ...base, status: "CANCELLED", amount: 700, bookedAt: at("2026-11-05T10:00:00Z") },
      { ...base, status: "CONFIRMED", amount: 300, bookedAt: at("2026-11-06T10:00:00Z"), isTest: true },
    ] as any);
    const o = await computeAdminOverview(reqFor(admin, HOUSE), { now: NOW });
    expect(o.blocks.bookingsMonth).toEqual({ count: 2, spend: 1500, scope: "platform" });
  });

  it("pendingTravel (HOUSE ADMIN): the Travel Desk pending queue count", async () => {
    const admin = await person(HOUSE, ["ADMIN"]);
    await ApprovalRequest.collection.insertMany([
      { workspaceId: TENANT, status: "approved", adminState: "pending" },
      { workspaceId: TENANT, status: "approved", adminState: null },
      { workspaceId: TENANT, status: "approved", adminState: "assigned" },
      { workspaceId: TENANT, status: "pending" },
    ] as any);
    const o = await computeAdminOverview(reqFor(admin, HOUSE), { now: NOW });
    expect(o.blocks.pendingTravel).toEqual({ count: 2, scope: "platform" });
  });

  it("invoicesMonth (tenant ADMIN with grant): own workspace only, IST month", async () => {
    const admin = await person(TENANT, ["ADMIN"]);
    await UserPermission.collection.insertOne({ userId: String(admin._id), email: admin.email, workspaceId: TENANT, status: "active", tier: 2, modules: { invoices: { access: "READ", scope: "WORKSPACE" } } } as any);
    await Invoice.collection.insertMany([
      { invoiceNo: "INV-T-1", workspaceId: TENANT, status: "SENT", grandTotal: 100, generatedAt: at("2026-11-10T00:00:00Z") },
      { invoiceNo: "INV-T-2", workspaceId: TENANT, status: "PAID", grandTotal: 50, generatedAt: at("2026-11-11T00:00:00Z") },
      { invoiceNo: "INV-T-3", workspaceId: TENANT, status: "CANCELLED", grandTotal: 999, generatedAt: at("2026-11-12T00:00:00Z") },
      { invoiceNo: "INV-T-4", workspaceId: TENANT, status: "DRAFT", grandTotal: 25, generatedAt: at("2026-10-01T00:00:00Z") },
      { invoiceNo: "INV-T-5", workspaceId: SAAS, status: "SENT", grandTotal: 7000, generatedAt: at("2026-11-10T00:00:00Z") },
    ] as any);
    const o = await computeAdminOverview(reqFor(admin, TENANT), { now: NOW });
    // outstanding is every open invoice, any month (INV-T-4 is October): 100 + 25
    expect(o.blocks.invoicesMonth).toEqual({ raisedThisMonth: 2, paidThisMonth: 1, outstandingAllOpen: 125, scope: "workspace" });
  });

  it("pendingExpenses (tenant HR = expense admin): own workspace submitted reports; no advances key when advances are off", async () => {
    const admin = await person(TENANT, ["HR"]);
    await Report.collection.insertMany([
      { workspaceId: TENANT, status: "submitted" },
      { workspaceId: TENANT, status: "draft" },
      { workspaceId: SAAS, status: "submitted" },
    ] as any);
    const o = await computeAdminOverview(reqFor(admin, TENANT), { now: NOW });
    expect(o.blocks.pendingExpenses).toEqual({ reports: 1 });
  });
});

describe("admin-overview — Phase 2b blocks", () => {
  it("employeeStatus: probation from this year's LeaveBalance (unconfirmed or end date ahead), own workspace", async () => {
    const hr = await person(TENANT, ["HR"]);
    const a = await person(TENANT, ["EMPLOYEE"]);
    const b = await person(TENANT, ["EMPLOYEE"]);
    const c = await person(TENANT, ["EMPLOYEE"]);
    const x = await person(SAAS, ["EMPLOYEE"]);
    await LeaveBalance.collection.insertMany([
      { workspaceId: TENANT, userId: a._id, year: 2026, isConfirmed: false },
      { workspaceId: TENANT, userId: b._id, year: 2026, isConfirmed: true, probationEndDate: at("2027-01-31") },
      { workspaceId: TENANT, userId: c._id, year: 2026, isConfirmed: true, probationEndDate: at("2026-06-30") },
      { workspaceId: TENANT, userId: c._id, year: 2025, isConfirmed: false },
      { workspaceId: SAAS, userId: x._id, year: 2026, isConfirmed: false },
    ] as any);
    const o: any = await computeAdminOverview(reqFor(hr, TENANT), { now: NOW });
    expect(o.blocks.employeeStatus.onProbation).toBe(2);
  });

  it("todo: HOUSE + tasks READ only; the caller's own OPEN/IN_PROGRESS tasks, due first", async () => {
    const admin = await person(HOUSE, ["ADMIN"]);
    const other = await person(HOUSE, ["ADMIN"]);
    expect((await computeAdminOverview(reqFor(admin, HOUSE), { now: NOW })).blocks.todo).toBeUndefined();
    await UserPermission.collection.insertOne({ userId: String(admin._id), email: admin.email, workspaceId: HOUSE, status: "active", tier: 2, modules: { tasks: { access: "READ", scope: "OWN" } } } as any);
    await Task.collection.insertMany([
      { title: "Later", assignedTo: admin._id, createdBy: admin._id, status: "OPEN", priority: "LOW", dueDate: at("2026-12-10T06:00:00Z"), isActive: true },
      { title: "Sooner", assignedTo: admin._id, createdBy: admin._id, status: "IN_PROGRESS", priority: "HIGH", dueDate: at("2026-11-28T06:00:00Z"), isActive: true },
      { title: "Done", assignedTo: admin._id, createdBy: admin._id, status: "DONE", priority: "LOW", isActive: true },
      { title: "Archived", assignedTo: admin._id, createdBy: admin._id, status: "OPEN", priority: "LOW", isActive: false },
      { title: "Not mine", assignedTo: other._id, createdBy: admin._id, status: "OPEN", priority: "LOW", isActive: true },
    ] as any);
    const o: any = await computeAdminOverview(reqFor(admin, HOUSE), { now: NOW });
    expect(o.blocks.todo.map((t: any) => t.title)).toEqual(["Sooner", "Later"]);
    expect(o.blocks.todo[0]).toMatchObject({ status: "IN_PROGRESS", priority: "HIGH", dueDate: "2026-11-28" });
    // a tenant admin with the same grant: HOUSE-only → omitted
    const t = await person(TENANT, ["ADMIN"]);
    await UserPermission.collection.insertOne({ userId: String(t._id), email: t.email, workspaceId: TENANT, status: "active", tier: 2, modules: { tasks: { access: "READ", scope: "OWN" } } } as any);
    expect((await computeAdminOverview(reqFor(t, TENANT), { now: NOW })).blocks.todo).toBeUndefined();
  });

  it("topBooker: HOUSE + manualBookings READ; first top-5 row with a completed booking this month, else null", async () => {
    const admin = await person(HOUSE, ["ADMIN"]);
    await UserPermission.collection.insertOne({ userId: String(admin._id), email: admin.email, workspaceId: HOUSE, status: "active", tier: 2, modules: { manualBookings: { access: "READ", scope: "ALL" } } } as any);
    expect((await computeAdminOverview(reqFor(admin, HOUSE), { now: NOW })).blocks.topBooker).toBeNull();
    const agent = await person(HOUSE, ["OPS"], { name: "Omar Shaikh", designation: "Travel Ops Executive" });
    const mb = (status: string, bookingDate: string) => ({ bookingRef: `MB-T-${bookingDate}`, workspaceId: TENANT, assignPerson: agent._id, status, bookingDate: at(bookingDate), createdAt: at(bookingDate), type: "FLIGHT" });
    await ManualBooking.collection.insertMany([
      mb("CONFIRMED", "2026-11-10T06:00:00Z"),
      mb("INVOICED", "2026-11-12T06:00:00Z"),
      mb("CONFIRMED", "2026-10-12T06:00:00Z"), // last month
    ] as any);
    const o: any = await computeAdminOverview(reqFor(admin, HOUSE), { now: NOW });
    expect(o.blocks.topBooker).toEqual({ name: expect.any(String), avatarUrl: null, role: "Travel Ops Executive", bookings: 2 });
    const noGrant = await person(HOUSE, ["ADMIN"]);
    expect((await computeAdminOverview(reqFor(noGrant, HOUSE), { now: NOW })).blocks.topBooker).toBeUndefined();
  });
});

describe("admin-overview — performs zero database writes", () => {
  const WRITE_COMMANDS = new Set([
    "insert", "update", "delete", "findAndModify", "bulkWrite",
    "createIndexes", "dropIndexes", "drop", "dropDatabase", "create", "renameCollection",
  ]);

  it("no write command reaches MongoDB and no model write method is called, for every persona", async () => {
    const hr = await person(HOUSE, ["HR"]);
    const admin = await person(HOUSE, ["ADMIN"]);
    const tadmin = await person(TENANT, ["ADMIN"]);
    const saas = await person(SAAS, ["TENANT_ADMIN", "WORKSPACE_LEADER"]);
    const emp = await person(HOUSE, ["EMPLOYEE"]);
    await UserPermission.collection.insertOne({ userId: String(hr._id), email: hr.email, workspaceId: HOUSE, status: "active", tier: 2, modules: { invoices: { access: "READ", scope: "OWN" } } } as any);
    // Data every block can read — including an onboarding invite that is past
    // its expiry, which GET /api/onboarding/pipeline would rewrite to "expired".
    await Onboarding.collection.insertOne({ workspaceId: HOUSE, type: "employee", email: "z@x", token: "tz", status: "sent", expiresAt: at("2026-11-01") } as any);
    await punch(emp._id, HOUSE, "2026-11-27", [["2026-11-27T04:20:00Z", "IN"]]);
    await ApprovalRequest.collection.insertOne({ workspaceId: TENANT, status: "approved", adminState: "pending" } as any);
    // the Phase 2b blocks: employeeStatus, todo, topBooker
    await UserPermission.collection.insertOne({ userId: String(admin._id), email: admin.email, workspaceId: HOUSE, status: "active", tier: 2, modules: { tasks: { access: "READ", scope: "OWN" }, manualBookings: { access: "READ", scope: "ALL" } } } as any);
    await LeaveBalance.collection.insertOne({ workspaceId: HOUSE, userId: emp._id, year: 2026, isConfirmed: false } as any);
    await Task.collection.insertOne({ title: "T", assignedTo: admin._id, createdBy: admin._id, status: "OPEN", priority: "LOW", isActive: true } as any);
    await ManualBooking.collection.insertOne({ bookingRef: "MB-ZW-1", workspaceId: TENANT, assignPerson: emp._id, status: "CONFIRMED", bookingDate: at("2026-11-10T06:00:00Z"), createdAt: at("2026-11-10T06:00:00Z"), type: "FLIGHT" } as any);

    const writes: string[] = [];
    const client = mongoose.connection.getClient();
    const onCommand = (ev: any) => {
      if (WRITE_COMMANDS.has(ev.commandName)) writes.push(`${ev.commandName} ${ev.command?.[ev.commandName] ?? ""}`);
    };
    client.on("commandStarted", onCommand);
    const M: any = mongoose.Model;
    const spies = [
      vi.spyOn(M.prototype, "save"),
      ...["create", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany",
          "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "findByIdAndUpdate", "findByIdAndDelete", "bulkWrite"]
        .map((m) => vi.spyOn(M, m)),
    ];
    try {
      for (const [u, ws] of [[hr, HOUSE], [admin, HOUSE], [tadmin, TENANT], [saas, SAAS], [emp, HOUSE]] as const) {
        const o = await computeAdminOverview(reqFor(u as any, ws), { now: NOW });
        expect(o.asOf).toBe("2026-11-27");
        if (u === admin) expect(Object.keys(o.blocks)).toEqual(expect.arrayContaining(["employeeStatus", "todo", "topBooker"]));
      }
    } finally {
      client.off("commandStarted", onCommand);
    }
    for (const sp of spies) expect(sp, sp.getMockName()).not.toHaveBeenCalled();
    spies.forEach((sp) => sp.mockRestore());
    expect(writes).toEqual([]);
    // and the expired invite is still as it was
    expect((await Onboarding.collection.findOne({ token: "tz" }))!.status).toBe("sent");
  });
});
