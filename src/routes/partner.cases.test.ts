// apps/backend/src/routes/partner.cases.test.ts
//
// The partner case tracker (/api/partner/cases):
//   - scope: the session workspace's PARTNER_LINK cases only (CW._id AND its
//     customerId); another partner's case, a non-partner case in the same
//     workspace, and a booking of another customer pointing at our case never
//     show; a case out of scope is the same 404 as a missing one;
//   - allowlist: a deep key scan of list and detail finds no contact, cost,
//     margin, price, notes, supplier, id or staff email — with fixtures that
//     carry every one of those (raw inserts, so absent and present fields are
//     both exercised);
//   - steps from the case history, current step from the live bookings, and
//     counts that sum to Registered;
//   - gate: 403 while partnerCasesEnabled is off, and for a member who is
//     neither a Workspace Leader nor holds canViewBilling.
//
// Real: the router, requireInvoiceAccess, tracker + rollup services, models,
// in-memory Mongo. Stubbed: the caller and the workspace it resolved to.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { default: partnerCasesRouter } = await import("./partner.cases.js");
const { isPriceKey } = await import("./approvals.security.js");

const oid = () => new mongoose.Types.ObjectId();
const AMBER = oid();
const AMBER_CUSTOMER = oid();
const UNI = oid(); // another partner
const UNI_CUSTOMER = oid();

const app = express();
app.use(express.json());
app.use(
  "/api/partner/cases",
  async (req: any, res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    const ws = await mongoose.connection.db!.collection("customerworkspaces").findOne({ _id: new mongoose.Types.ObjectId(String(req.headers["x-test-ws"])) });
    if (!ws) return res.status(403).json({ error: "no workspace" });
    req.workspace = ws;
    req.workspaceObjectId = ws._id;
    next();
  },
  partnerCasesRouter,
);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const LEAD = { sub: String(oid()), email: "lead@amber.test", roles: ["WORKSPACE_LEADER"] };
const MEMBER = { sub: String(oid()), email: "member@amber.test", roles: ["CUSTOMER"] };
const BILLING = { sub: String(oid()), email: "billing@amber.test", roles: ["CUSTOMER"] };
const STAFF = { sub: String(oid()), email: "neel@plumtrips.com", roles: ["SUPERADMIN"] };
const get = (path: string, who: any = LEAD, ws: any = AMBER) =>
  request(app).get(`/api/partner/cases${path}`).set("x-test-user", JSON.stringify(who)).set("x-test-ws", String(ws));

const t = (min: number) => new Date(Date.UTC(2026, 9, 20, 9, min));
const sys = { by: "system:partner-intake", actorKind: "system", actorName: "System", userEmail: "system-partner-intake@plumtrips.com" };
const staffRow = { by: "staff1", actorKind: "staff", actorName: "Rita Menon", userEmail: "rita@plumtrips.com" };
const traveller = { kind: "manual", firstName: "Riya", lastName: "Sen", phone: "9876543210", email: "riya@student.test", dob: "2004-05-06", passportNumber: "Z1234567", passportExpiry: "2032-01-01" };

let n = 0;
function partnerCase(ws: any, customer: any, extraHistory: any[] = [], over: any = {}) {
  n += 1;
  const caseNumber = `PL-AAAAA${"BCDEFGHJKMN"[n]}`;
  return {
    _id: oid(),
    workspaceId: ws,
    customerId: String(customer),
    ticketId: caseNumber,
    customerName: "Amber Student",
    frontlinerId: "intake", frontlinerEmail: "system-partner-intake@plumtrips.com", managerEmail: "system-partner-intake@plumtrips.com",
    status: "approved", adminState: "pending", stage: "REQUEST_APPROVED",
    bookingAmount: 5600, actualBookingPrice: 4800,
    cartItems: [{ type: "flight", price: 5600, meta: { origin: "BLR", destination: "DEL", tripType: "oneway", departDate: "2027-04-02", travelScope: "domestic", travellers: [traveller], notes: "window seat please" } }],
    meta: {
      source: "PARTNER_LINK", travelFlow: "APPROVAL_DIRECT",
      adminAssigned: { userId: "u1", agentName: "Rita Menon", agentEmail: "rita@plumtrips.com" },
      closedReason: "Student unreachable after 5 calls, mobile 9876543210",
      partnerLead: {
        caseNumber, intakeRef: `partner:${n}`, code: "AmbR2026", placement: "homepage-banner",
        contact: { name: "Riya Sen", phone: "9876543210", email: "riya@student.test" },
        ipHash: "f".repeat(64), referrer: "https://amberstudent.com/page", consent: { version: "2026-10" },
      },
    },
    history: [
      { action: "submitted", at: t(0), comment: "Case created — partner lead from Amber Student · homepage-banner", ...sys },
      { action: "approved", at: t(0), comment: "In Admin Queue — partner lead", ...sys },
      ...extraHistory,
    ],
    createdAt: t(0),
    ...over,
  };
}
const assigned = { action: "admin_auto_assigned", at: t(1), assigneeName: "Rita Menon", assigneeEmail: "rita@plumtrips.com", staffNote: "Assigned to Rita Menon <rita@plumtrips.com> — auto: RM", ...sys };
const started = { action: "booking_started", at: t(2), ...staffRow };
const bstatus = (status: string, sub = "", min = 3) => ({ action: "booking_status", at: t(min), bookingStatus: status, bookingSubStatus: sub, comment: `Booking MB-1: ${status}`, staffNote: "spoke to her mum", ...staffRow });

function booking(customer: any, caseId: any, status: string, over: any = {}) {
  return {
    workspaceId: customer, source: "ADMIN_QUEUE", sourceBookingId: caseId, bookingRef: `MB-${Math.random().toString(36).slice(2, 8)}`,
    type: "FLIGHT", status, subStatus: "", isActive: true, updatedAt: t(10),
    supplierName: "IndiGo", supplierPNR: "PNR123", givenBy: "Rita", notes: "net fare via agent", metadata: { channel: "x" },
    pricing: { actualPrice: 4800, quotedPrice: 5600, supplierCost: 4800, markupAmount: 800, profitMargin: 14.3, grandTotal: 5600 },
    partnerShare: { share: 200, bakedIn: 400 },
    passengers: [{ name: "Riya Sen", passportNo: "Z1234567", panNo: "ABCDE1234F" }],
    attachments: [{ type: "ticket", originalFilename: "ticket.pdf", s3Key: "bookings/attachments/x/ticket.pdf" }, { type: "other", originalFilename: "supplier-invoice.pdf", s3Key: "k" }],
    ...over,
  };
}

let C: Record<string, any> = {};
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("partner-cases-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  n = 0;
  await col("customerworkspaces").insertMany([
    { _id: AMBER, customerId: String(AMBER_CUSTOMER), companyName: "Amber Student", status: "ACTIVE", config: { features: { partnerCasesEnabled: true } } },
    { _id: UNI, customerId: String(UNI_CUSTOMER), companyName: "University Living", status: "ACTIVE", config: { features: { partnerCasesEnabled: true } } },
  ] as any[]);
  await col("users").insertMany([
    { _id: new mongoose.Types.ObjectId(MEMBER.sub), email: MEMBER.email, customerId: String(AMBER_CUSTOMER), canViewBilling: false },
    { _id: new mongoose.Types.ObjectId(BILLING.sub), email: BILLING.email, customerId: String(AMBER_CUSTOMER), canViewBilling: true },
  ] as any[]);
  C = {
    queued: partnerCase(AMBER, AMBER_CUSTOMER),
    assigned: partnerCase(AMBER, AMBER_CUSTOMER, [assigned], { adminState: "assigned" }),
    started: partnerCase(AMBER, AMBER_CUSTOMER, [assigned, started], { adminState: "in_progress", stage: "BOOKING_IN_PROGRESS" }),
    pending: partnerCase(AMBER, AMBER_CUSTOMER, [assigned, started, bstatus("PENDING"), bstatus("PENDING", "Lead Not Contactable", 4)], { adminState: "in_progress", stage: "BOOKING_IN_PROGRESS" }),
    done: partnerCase(AMBER, AMBER_CUSTOMER, [assigned, started, bstatus("PENDING"), bstatus("CONFIRMED", "", 5), { action: "admin_done", at: t(5), comment: "Ticket issued and shared", ...staffRow }], { adminState: "done", stage: "COMPLETED" }),
    closed: partnerCase(AMBER, AMBER_CUSTOMER, [assigned, { action: "admin_closed", at: t(6), comment: "Not reachable — mobile 9876543210", staffNote: "x", ...staffRow }], { adminState: "cancelled" }),
    allCancelled: partnerCase(AMBER, AMBER_CUSTOMER, [assigned, started, bstatus("CANCELLED", "Lead Not Contactable", 7)], { adminState: "in_progress", stage: "BOOKING_IN_PROGRESS" }),
    // never visible to Amber:
    uni: partnerCase(UNI, UNI_CUSTOMER),
    notPartner: { ...partnerCase(AMBER, AMBER_CUSTOMER), meta: { travelFlow: "APPROVAL_DIRECT" }, ticketId: "REQ-ORDNRY" },
    wrongCustomer: partnerCase(AMBER, oid()),
  };
  await col("approvalrequests").insertMany(Object.values(C));
  await col("manualbookings").insertMany([
    booking(AMBER_CUSTOMER, C.pending._id, "PENDING", { subStatus: "Lead Not Contactable" }),
    booking(AMBER_CUSTOMER, C.done._id, "CONFIRMED"),
    booking(AMBER_CUSTOMER, C.done._id, "CANCELLED", { subStatus: "Plan changed", type: "HOTEL", attachments: [] }),
    booking(AMBER_CUSTOMER, C.done._id, "PENDING", { isActive: false }), // deleted: ignored
    booking(AMBER_CUSTOMER, C.allCancelled._id, "CANCELLED", { subStatus: "Lead Not Contactable", attachments: [] }),
    // Another customer's booking pointing at Amber's case, and Amber's booking pointing at Uni's case.
    booking(UNI_CUSTOMER, C.started._id, "CONFIRMED"),
    booking(AMBER_CUSTOMER, C.uni._id, "CONFIRMED"),
  ] as any[]);
});

const FORBIDDEN_KEYS = [
  "contact", "phone", "mobile", "email", "dob", "passportNumber", "passportNo", "panNo", "travellers", "passengers",
  "notes", "note", "staffNote", "comment", "supplierName", "supplierPNR", "supplier", "partnerShare", "metadata",
  "ipHash", "referrer", "consent", "intakeRef", "agentEmail", "assigneeEmail", "userEmail", "adminAssigned",
  "closedReason", "_id", "workspaceId", "customerId", "s3Key", "originalFilename", "attachments", "pricing",
];
function keysDeep(v: any, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), keysDeep(x, out));
  return out;
}
function expectPartnerSafe(body: any) {
  const keys = keysDeep(body);
  expect(keys.filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
  expect(keys.filter(isPriceKey)).toEqual([]);
  const text = JSON.stringify(body);
  for (const bad of ["@", "9876543210", "Z1234567", "ABCDE1234F", "4800", "5600", "IndiGo", "PNR123", "spoke to her mum", "window seat", "supplier-invoice", "bookings/attachments", "net fare", "unreachable after", "AmbR2026"]) {
    expect(text, `carries "${bad}"`).not.toContain(bad);
  }
  expect(text).not.toMatch(/[0-9a-f]{24}/);
}

describe("scope and allowlist", () => {
  it("lists this workspace's partner cases only, with nothing internal at any depth", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    const numbers = res.body.cases.map((c: any) => c.caseNumber).sort();
    const mine = ["queued", "assigned", "started", "pending", "done", "closed", "allCancelled"].map((k) => C[k].meta.partnerLead.caseNumber).sort();
    expect(numbers).toEqual(mine);
    expectPartnerSafe(res.body);
  });

  it("detail: same row; another partner's case, a non-partner case, an unknown number → 404", async () => {
    const one = await get(`/${C.done.meta.partnerLead.caseNumber.toLowerCase()}`);
    expect(one.status).toBe(200);
    const listed = (await get("")).body.cases.find((c: any) => c.caseNumber === C.done.meta.partnerLead.caseNumber);
    expect(one.body.case).toEqual(listed);
    expectPartnerSafe(one.body);
    for (const num of [C.uni.meta.partnerLead.caseNumber, C.wrongCustomer.meta.partnerLead.caseNumber, "REQ-ORDNRY", "PL-ZZZZZZ", "not-a-case"]) {
      const r = await get(`/${num}`);
      expect([r.status, r.body]).toEqual([404, { error: "Case not found" }]);
    }
  });

  it("a staff admin calling it gets the same allowlisted shape", async () => {
    const lead = await get("", LEAD);
    const staff = await get("", STAFF);
    expect(staff.status).toBe(200);
    expect(staff.body).toEqual(lead.body);
  });

  it("the other partner sees only its own", async () => {
    const res = await get("", LEAD, UNI);
    expect(res.body.cases.map((c: any) => c.caseNumber)).toEqual([C.uni.meta.partnerLead.caseNumber]);
    // Amber's booking pointing at Uni's case is not Uni's document.
    expect(res.body.cases[0].documents).toEqual([]);
    expect(res.body.cases[0].currentStep.label).toBe("In Admin Queue");
  });
});

describe("steps, current step and counts", () => {
  const byNumber = async () => new Map((await get("")).body.cases.map((c: any) => [c.caseNumber, c]));
  const of = (m: Map<any, any>, k: string) => m.get(C[k].meta.partnerLead.caseNumber);

  it("current step per case, from the bookings when there are any", async () => {
    const m = await byNumber();
    const cur = (k: string) => [of(m, k).currentStep.label, of(m, k).currentStep.subStatus, of(m, k).bucket];
    expect(cur("queued")).toEqual(["In Admin Queue", "", "pendingAction"]);
    expect(cur("assigned")).toEqual(["Assigned to RM", "", "pendingAction"]);
    expect(cur("started")).toEqual(["Work started", "", "inProgress"]); // the foreign booking doesn't count
    expect(cur("pending")).toEqual(["In progress", "Lead Not Contactable", "inProgress"]);
    expect(cur("done")).toEqual(["Booking processed", "", "actioned"]);
    // Closed by ops: a free-text closedReason is never shown (only a known reason's label is).
    expect(cur("closed")).toEqual(["Request closed", "", "actioned"]);
    expect(cur("allCancelled")).toEqual(["Request cancelled", "Lead Not Contactable", "actioned"]);
    // Each case carries its outcome: done / dropped once actioned, else null.
    const outcome = (k: string) => of(m, k).outcome;
    expect(["queued", "assigned", "started", "pending"].map(outcome)).toEqual([null, null, null, null]);
    expect(["done", "closed", "allCancelled"].map(outcome)).toEqual(["bookingDone", "bookingDropped", "bookingDropped"]);
    expect(of(m, "assigned").rmName).toBe("Rita Menon");
    expect(of(m, "queued").rmName).toBe("");
  });

  it("step history: case steps, then each booking Status / Sub Status", async () => {
    const m = await byNumber();
    expect(of(m, "pending").steps.map((s: any) => [s.label, s.subStatus])).toEqual([
      ["Case created", ""], ["In Admin Queue", ""], ["Assigned to RM", ""], ["Work started", ""], ["In progress", ""], ["In progress", "Lead Not Contactable"],
    ]);
    expect(of(m, "done").steps.map((s: any) => s.label)).toEqual(["Case created", "In Admin Queue", "Assigned to RM", "Work started", "In progress", "Booking processed"]);
    expect(of(m, "closed").steps.map((s: any) => s.label)).toEqual(["Case created", "In Admin Queue", "Assigned to RM", "Request closed"]);
    for (const s of of(m, "pending").steps) expect(typeof s.at).toBe("string");
  });

  it("documents: status only, per live booking", async () => {
    const m = await byNumber();
    expect(of(m, "done").documents).toEqual([
      { service: "Flight", ticketIssued: true, voucherIssued: false, documentIssued: false },
      { service: "Hotel", ticketIssued: false, voucherIssued: false, documentIssued: false },
    ]);
  });

  it("the counts are server-side and sum to Registered", async () => {
    const { counts } = (await get("")).body;
    expect(counts).toEqual({ registered: 7, pendingAction: 2, inProgress: 2, actioned: 3, bookingDone: 1, bookingDropped: 2 });
    expect(counts.pendingAction + counts.inProgress + counts.actioned).toBe(counts.registered);
    expect(counts.pendingAction + counts.inProgress + counts.bookingDone + counts.bookingDropped).toBe(counts.registered);
  });
});

describe("gate", () => {
  it("403 while partnerCasesEnabled is off (the default)", async () => {
    await col("customerworkspaces").updateOne({ _id: AMBER }, { $unset: { "config.features.partnerCasesEnabled": 1 } });
    expect((await get("")).status).toBe(403);
    await col("customerworkspaces").updateOne({ _id: AMBER }, { $set: { "config.features.partnerCasesEnabled": false } });
    expect((await get("")).status).toBe(403);
    expect((await get(`/${C.done.meta.partnerLead.caseNumber}`)).status).toBe(403);
  });

  it("Workspace Leaders and canViewBilling members only", async () => {
    expect((await get("", LEAD)).status).toBe(200);
    expect((await get("", BILLING)).status).toBe(200);
    const member = await get("", MEMBER);
    expect([member.status, member.body.code]).toEqual([403, "BILLING_ACCESS_DENIED"]);
  });
});
