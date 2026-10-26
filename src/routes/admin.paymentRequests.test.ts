// /api/admin/payment-requests — gates, the one-open-request rule, partial
// creation + retry by reference, cancel / replace rules, tenant scoping, and
// that no booking or invoice status is ever changed.
//
// Real: the router, requirePermission (UserPermission rows), requireBillingStaff,
// canAccessBooking, invoiceInCallerScope, every model, in-memory Mongo.
// Stubbed: requireAuth (caller from a header), the Razorpay Payment Links
// client (an in-memory fake — no network), and the email outbox.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.RAZORPAY_KEY_ID = "rzp_test_paylinks";
process.env.RAZORPAY_KEY_SECRET = "test_secret";

// The router's limiters are express-rate-limit instances; they would trip
// across this file's ~50 calls from one test IP. Pass-through here.
vi.mock("express-rate-limit", () => ({
  default: () => (_req: any, _res: any, next: any) => next(),
  ipKeyGenerator: (ip: string) => ip,
}));

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    const u = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    req.user = u.user;
    if (u.workspaceObjectId) req.workspaceObjectId = u.workspaceObjectId;
    if (u.customerId) req.workspace = { customerId: u.customerId };
    next();
  };
  return { requireAuth, default: requireAuth };
});

/* ── Fake Razorpay ───────────────────────────────────────────────────── */
type FakeLink = { id: string; reference_id: string; amount: number; status: string; short_url: string; order_id?: string; payments?: any[]; notes?: any };
const rz = {
  links: new Map<string, FakeLink>(), // by id
  failCreates: 0, // next N creates throw before creating
  failAtCall: 0, // the Nth create call (1-based) throws before creating
  createCount: 0,
  timeoutCreates: 0, // next N creates create, then throw (a timeout that succeeded)
  calls: [] as Array<{ fn: string; arg: any }>,
  seq: 0,
};
const byRef = (ref: string) => [...rz.links.values()].find((l) => l.reference_id === ref) ?? null;

vi.mock("../services/razorpayPaymentLinks.js", async () => {
  const actual: any = await vi.importActual("../services/razorpayPaymentLinks.js");
  return {
    ...actual,
    createPaymentLink: vi.fn(async (input: any) => {
      rz.calls.push({ fn: "create", arg: input });
      rz.createCount++;
      if (rz.failAtCall === rz.createCount) throw new actual.RazorpayLinkError("Gateway timeout", 504, {});
      if (rz.failCreates > 0) {
        rz.failCreates--;
        throw new actual.RazorpayLinkError("Gateway timeout", 504, {});
      }
      if (byRef(input.referenceId)) throw new actual.RazorpayLinkError("reference_id already exists", 400, {});
      const link: FakeLink = {
        id: `plink_${++rz.seq}`,
        reference_id: input.referenceId,
        amount: input.amountPaise,
        status: "created",
        short_url: `https://rzp.io/i/fake${rz.seq}`,
        notes: input.notes,
      };
      rz.links.set(link.id, link);
      if (rz.timeoutCreates > 0) {
        rz.timeoutCreates--;
        throw new actual.RazorpayLinkError("socket hang up", 502, {});
      }
      return { ...link };
    }),
    fetchPaymentLink: vi.fn(async (id: string) => {
      rz.calls.push({ fn: "fetch", arg: id });
      const l = rz.links.get(id);
      if (!l) throw new actual.RazorpayLinkError("not found", 404, {});
      return { ...l };
    }),
    fetchPaymentLinkByReference: vi.fn(async (ref: string) => {
      rz.calls.push({ fn: "fetchByReference", arg: ref });
      const l = byRef(ref);
      return l ? { ...l } : null;
    }),
    fetchPaymentLinkByPaymentId: vi.fn(async () => null),
    cancelPaymentLink: vi.fn(async (id: string) => {
      rz.calls.push({ fn: "cancel", arg: id });
      const l = rz.links.get(id)!;
      if (l.status !== "created") throw new actual.RazorpayLinkError("cannot cancel or expire an already paid/partially paid link", 400, {});
      l.status = "cancelled";
      return { ...l };
    }),
  };
});

const sentEmails: any[] = [];
vi.mock("../services/emailOutbox.js", () => ({
  enqueueEmail: vi.fn(async (msg: any) => {
    sentEmails.push(msg);
    return { ok: true, id: String(new mongoose.Types.ObjectId()), status: "SENT" };
  }),
}));

const { default: router } = await import("./admin.paymentRequests.js");
const { default: PaymentRequest } = await import("../models/PaymentRequest.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { default: Invoice } = await import("../models/Invoice.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ApprovalRequest } = await import("../models/ApprovalRequest.js");
const { UserPermission } = await import("../models/UserPermission.js");

const app = express();
app.use(express.json());
app.use("/api/admin/payment-requests", router);

/* ── Fixtures ────────────────────────────────────────────────────────── */
const HOUSE_WS = "69679a7628330a58d29f2254";
const HOUSE_CUST = String(new mongoose.Types.ObjectId());
const CUST_A = new mongoose.Types.ObjectId();
const CWS_A = new mongoose.Types.ObjectId();
const CUST_B = new mongoose.Types.ObjectId();
const CWS_B = new mongoose.Types.ObjectId();

const STAFF = String(new mongoose.Types.ObjectId());
const STAFF_OWN = String(new mongoose.Types.ObjectId());
const STAFF_NOPERM = String(new mongoose.Types.ObjectId());
const TENANT_ADMIN = String(new mongoose.Types.ObjectId());
const SUPER = String(new mongoose.Types.ObjectId());

const staff = (id = STAFF) => JSON.stringify({ user: { _id: id, roles: ["EMPLOYEE"], email: "rm@plumtrips.com" }, workspaceObjectId: HOUSE_WS, customerId: HOUSE_CUST });
const superAdmin = JSON.stringify({ user: { _id: SUPER, roles: ["SUPERADMIN"] } });
const tenantAdmin = JSON.stringify({ user: { _id: TENANT_ADMIN, roles: ["ADMIN"] }, workspaceObjectId: String(CWS_A), customerId: String(CUST_A) });

let mongod: MongoMemoryServer;
let BOOKING: mongoose.Types.ObjectId;
let BOOKING_STUDENT: mongoose.Types.ObjectId;
let INVOICE: mongoose.Types.ObjectId;
const REQ = new mongoose.Types.ObjectId();

const perm = (userId: string, access: string, scope: string) => ({
  userId,
  modules: { manualBookings: { access, scope }, invoices: { access, scope } },
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("payment-requests-test"));
  await PaymentRequest.syncIndexes();
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  rz.links.clear();
  rz.failCreates = 0;
  rz.timeoutCreates = 0;
  rz.failAtCall = 0;
  rz.createCount = 0;
  rz.seq = 0;
  rz.calls = [];
  sentEmails.length = 0;
  await Promise.all([
    PaymentRequest.deleteMany({}),
    ManualBooking.collection.deleteMany({}),
    Invoice.collection.deleteMany({}),
    CustomerWorkspace.collection.deleteMany({}),
    ApprovalRequest.collection.deleteMany({}),
    UserPermission.collection.deleteMany({}),
  ]);
  await UserPermission.collection.insertMany([
    perm(STAFF, "WRITE", "ALL"),
    perm(STAFF_OWN, "WRITE", "OWN"),
    perm(TENANT_ADMIN, "FULL", "ALL"),
  ] as any);
  await CustomerWorkspace.collection.insertMany([
    { _id: CWS_A, customerId: String(CUST_A), status: "ACTIVE" },
    { _id: CWS_B, customerId: String(CUST_B), status: "ACTIVE" },
  ] as any);
  // Raw inserts: fixtures exactly as stored, no pricing hook.
  BOOKING = new mongoose.Types.ObjectId();
  BOOKING_STUDENT = new mongoose.Types.ObjectId();
  INVOICE = new mongoose.Types.ObjectId();
  await ManualBooking.collection.insertMany([
    {
      _id: BOOKING, workspaceId: CUST_A, bookingRef: "MB-1001", status: "PENDING", type: "FLIGHT", travelDate: new Date(),
      pricing: { grandTotal: 1000.01 }, passengers: [{ name: "Lead Pax", email: "pax@client.com", phone: "9876543210" }], createdBy: "someone-else",
    },
    {
      _id: BOOKING_STUDENT, workspaceId: CUST_B, bookingRef: "MB-2002", status: "WIP", type: "FLIGHT", travelDate: new Date(),
      source: "ADMIN_QUEUE", sourceBookingId: REQ, pricing: { grandTotal: 50000 }, passengers: [{ name: "Student Pax" }], createdBy: "someone-else",
    },
  ] as any);
  await ApprovalRequest.collection.insertOne({
    _id: REQ, workspaceId: CWS_B, frontlinerEmail: "partner@agency.com", frontlinerName: "Partner Desk",
    meta: { partnerLead: { caseNumber: "S-1", contact: { name: "Asha Student", email: "asha@student.edu", phone: "+919811112222" } } },
  } as any);
  await Invoice.collection.insertOne({
    _id: INVOICE, workspaceId: CWS_A, invoiceNo: "INV-2026FY0041", status: "SENT", grandTotal: 1000.01,
    bookingIds: [BOOKING], clientDetails: { contactPerson: "Accounts", email: "ap@client.com" },
  } as any);
});

const create = (body: any, who = staff()) => request(app).post("/api/admin/payment-requests").set("x-test-user", who).send(body);
const bookingBody = (extra: any = {}) => ({
  subject: "BOOKING", subjectId: String(BOOKING), split: { mode: "EQUAL", parts: 2 }, pgChargePct: 2,
  recipient: { name: "Lead Pax", email: "pax@client.com" }, ...extra,
});

async function subjectStatuses() {
  const b: any = await ManualBooking.collection.findOne({ _id: BOOKING });
  const i: any = await Invoice.collection.findOne({ _id: INVOICE });
  return { booking: b.status, invoice: i.status, bookingKeys: Object.keys(b).sort().join(","), invoiceKeys: Object.keys(i).sort().join(",") };
}

describe("create — booking", () => {
  it("splits the grand total, adds the PG charge per link, creates every link on Razorpay", async () => {
    const before = await subjectStatuses();
    const res = await create(bookingBody());
    expect(res.status).toBe(201);
    const r = res.body.request;
    expect(r.targetBasePaise).toBe(100001);
    expect(r.links.map((l: any) => l.basePaise)).toEqual([50000, 50001]);
    expect(r.links.map((l: any) => l.pgChargePaise)).toEqual([1000, 1000]);
    expect(r.links.map((l: any) => l.totalPaise)).toEqual([51000, 51001]);
    expect(r.links.every((l: any) => l.status === "CREATED" && l.shortUrl)).toBe(true);
    expect(r.status).toBe("OPEN");
    expect(r.customerId).toBe(String(CUST_A));
    expect(r.invoiceWorkspaceId).toBe(String(CWS_A));
    const creates = rz.calls.filter((c) => c.fn === "create").map((c) => c.arg);
    expect(creates).toHaveLength(2);
    expect(creates[0].referenceId).toMatch(/^PBX-[a-f0-9]{24}-1$/);
    expect(creates[0].referenceId.length).toBeLessThanOrEqual(40);
    expect(creates[0].notes.source).toBe("plumbox_payment_request");
    // Status only: the booking and invoice are byte-for-byte untouched.
    expect(await subjectStatuses()).toEqual(before);
  });

  it("refuses an INVOICED / CANCELLED booking and one without a grand total", async () => {
    for (const status of ["INVOICED", "CANCELLED"]) {
      await ManualBooking.collection.updateOne({ _id: BOOKING }, { $set: { status } });
      const res = await create(bookingBody());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("SUBJECT_NOT_ELIGIBLE");
    }
    await ManualBooking.collection.updateOne({ _id: BOOKING }, { $set: { status: "CONFIRMED", "pricing.grandTotal": 0 } });
    expect((await create(bookingBody())).body.code).toBe("SUBJECT_NOT_ELIGIBLE");
    expect(rz.calls).toHaveLength(0);
  });

  it("validates split, PG % and recipient", async () => {
    expect((await create(bookingBody({ split: { mode: "EQUAL", parts: 4 } }))).body.code).toBe("BAD_SPLIT");
    expect((await create(bookingBody({ split: { mode: "AMOUNTS", amountsPaise: [50000, 50000] } }))).body.code).toBe("SUM_MISMATCH");
    expect((await create(bookingBody({ pgChargePct: 10.5 }))).body.code).toBe("BAD_PG_PCT");
    expect((await create(bookingBody({ recipient: { name: "x" } }))).body.code).toBe("BAD_RECIPIENT");
    expect(await PaymentRequest.countDocuments()).toBe(0);
  });

  it("only one open request per subject", async () => {
    expect((await create(bookingBody())).status).toBe(201);
    const second = await create(bookingBody());
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("OPEN_REQUEST_EXISTS");
  });

  it("the database index enforces it too (a race past the check)", async () => {
    const first = await create(bookingBody());
    const doc: any = await PaymentRequest.findById(first.body.request.id).lean();
    const clone = { ...doc, _id: new mongoose.Types.ObjectId(), links: [] };
    await expect(PaymentRequest.collection.insertOne(clone)).rejects.toMatchObject({ code: 11000 });
  });

  it("a fully cancelled request frees the subject for a new one", async () => {
    const r = (await create(bookingBody({ split: { mode: "EQUAL", parts: 1 } }))).body.request;
    await request(app).post(`/api/admin/payment-requests/${r.id}/links/${r.links[0].id}/cancel`).set("x-test-user", staff());
    expect((await PaymentRequest.findById(r.id).lean())!.status).toBe("CANCELLED");
    expect((await create(bookingBody())).status).toBe(201);
  });

  it("defaults the recipient to the student on a partner case", async () => {
    const res = await request(app)
      .get(`/api/admin/payment-requests/preview?subject=BOOKING&id=${BOOKING_STUDENT}`)
      .set("x-test-user", staff());
    expect(res.status).toBe(200);
    expect(res.body.defaultRecipient).toEqual({ name: "Asha Student", email: "asha@student.edu", phone: "+919811112222" });
    const lead = await request(app).get(`/api/admin/payment-requests/preview?subject=BOOKING&id=${BOOKING}`).set("x-test-user", staff());
    expect(lead.body.defaultRecipient.email).toBe("pax@client.com");
  });
});

describe("partial creation failure and retry", () => {
  it("keeps the links that were created and marks the failed one FAILED_CREATE", async () => {
    rz.failAtCall = 2; // first create OK, second throws without creating
    const res = await create(bookingBody());
    expect(res.status).toBe(201);
    expect(res.body.request.links.map((l: any) => l.status)).toEqual(["CREATED", "FAILED_CREATE"]);
    expect(res.body.request.links[1].createError).toMatch(/timeout/i);

    const retry = await request(app).post(`/api/admin/payment-requests/${res.body.request.id}/retry`).set("x-test-user", staff());
    expect(retry.status).toBe(200);
    expect(retry.body.request.links.map((l: any) => l.status)).toEqual(["CREATED", "CREATED"]);
    // Same reference on the retry.
    const refs = rz.calls.filter((c) => c.fn === "create").map((c) => c.arg.referenceId);
    expect(refs[1]).toBe(refs[2]);
  });

  it("a create that timed out but succeeded is adopted by reference — no duplicate", async () => {
    rz.timeoutCreates = 1;
    const res = await create(bookingBody({ split: { mode: "EQUAL", parts: 1 } }));
    expect(res.status).toBe(201);
    const link = res.body.request.links[0];
    expect(link.status).toBe("CREATED");
    expect(link.razorpayLinkId).toBe("plink_1");
    expect(rz.links.size).toBe(1);
  });

  it("a retry whose reference already exists on Razorpay adopts it", async () => {
    rz.failCreates = 1;
    const res = await create(bookingBody({ split: { mode: "EQUAL", parts: 1 } }));
    const id = res.body.request.id;
    const ref = rz.calls.find((c) => c.fn === "create")!.arg.referenceId;
    // Someone (or a lost response) created it meanwhile.
    rz.links.set("plink_manual", { id: "plink_manual", reference_id: ref, amount: 102001, status: "created", short_url: "https://rzp.io/i/m" });
    const retry = await request(app).post(`/api/admin/payment-requests/${id}/retry`).set("x-test-user", staff());
    expect(retry.body.request.links[0]).toMatchObject({ status: "CREATED", razorpayLinkId: "plink_manual" });
    expect(rz.links.size).toBe(1);
  });

  it("does not adopt a same-reference link with a different amount", async () => {
    rz.failCreates = 1;
    const res = await create(bookingBody({ split: { mode: "EQUAL", parts: 1 } }));
    const ref = rz.calls.find((c) => c.fn === "create")!.arg.referenceId;
    rz.links.set("plink_bad", { id: "plink_bad", reference_id: ref, amount: 1, status: "created", short_url: "x" });
    const retry = await request(app).post(`/api/admin/payment-requests/${res.body.request.id}/retry`).set("x-test-user", staff());
    expect(retry.body.request.links[0].status).toBe("FAILED_CREATE");
    expect(retry.body.request.links[0].razorpayLinkId).toBeNull();
  });
});

describe("cancel and replace", () => {
  async function twoLinks() {
    return (await create(bookingBody())).body.request;
  }

  it("cancels a CREATED link on Razorpay; a PAID link can't be cancelled", async () => {
    const r = await twoLinks();
    const c = await request(app).post(`/api/admin/payment-requests/${r.id}/links/${r.links[0].id}/cancel`).set("x-test-user", staff());
    expect(c.status).toBe(200);
    expect(c.body.request.links[0].status).toBe("CANCELLED");
    expect(c.body.request.status).toBe("OPEN");

    await PaymentRequest.updateOne({ _id: r.id }, { $set: { "links.1.status": "PAID" } });
    const p = await request(app).post(`/api/admin/payment-requests/${r.id}/links/${r.links[1].id}/cancel`).set("x-test-user", staff());
    expect(p.status).toBe(409);
    expect(p.body.code).toBe("NOT_CANCELLABLE");
  });

  it("Razorpay 400 on cancel (paid meanwhile) refreshes the link instead", async () => {
    const r = await twoLinks();
    const fake = rz.links.get(r.links[0].razorpayLinkId)!;
    fake.status = "paid";
    fake.payments = [{ payment_id: "pay_meanwhile", amount: fake.amount, method: "upi" }];
    const c = await request(app).post(`/api/admin/payment-requests/${r.id}/links/${r.links[0].id}/cancel`).set("x-test-user", staff());
    expect(c.status).toBe(200);
    expect(c.body.outcome).toBe("REFRESHED");
    expect(c.body.request.links[0].status).toBe("PAID");
    expect(c.body.request.status).toBe("PARTLY_PAID");
  });

  it("replacement carries exactly the replaced base, a new reference, and replacesLinkId", async () => {
    const r = await twoLinks();
    await PaymentRequest.updateOne({ _id: r.id }, { $set: { "links.1.status": "EXPIRED" } });
    const rep = await request(app).post(`/api/admin/payment-requests/${r.id}/links/${r.links[1].id}/replace`).set("x-test-user", staff()).send({});
    expect(rep.status).toBe(200);
    const links = rep.body.request.links;
    expect(links).toHaveLength(3);
    expect(links[2]).toMatchObject({ seq: 3, basePaise: 50001, pgChargePaise: 1000, totalPaise: 51001, status: "CREATED", replacesLinkId: r.links[1].id });
    expect(links[2].referenceId).not.toBe(r.links[1].referenceId);
    // Sum rule: live links still cover the target.
    const live = links.filter((l: any) => !["CANCELLED", "EXPIRED"].includes(l.status));
    expect(live.reduce((s: number, l: any) => s + l.basePaise, 0)).toBe(100001);

    const again = await request(app).post(`/api/admin/payment-requests/${r.id}/links/${r.links[1].id}/replace`).set("x-test-user", staff()).send({});
    expect(again.body.code).toBe("ALREADY_REPLACED");
  });

  it("replacing a CREATED link cancels it first", async () => {
    const r = await twoLinks();
    const rep = await request(app).post(`/api/admin/payment-requests/${r.id}/links/${r.links[0].id}/replace`).set("x-test-user", staff()).send({});
    expect(rep.status).toBe(200);
    expect(rep.body.request.links[0].status).toBe("CANCELLED");
    expect(rz.links.get(r.links[0].razorpayLinkId)!.status).toBe("cancelled");
    expect(rep.body.request.links[2].basePaise).toBe(r.links[0].basePaise);
  });

  it("a PAID link can't be replaced", async () => {
    const r = await twoLinks();
    await PaymentRequest.updateOne({ _id: r.id }, { $set: { "links.0.status": "PAID" } });
    const rep = await request(app).post(`/api/admin/payment-requests/${r.id}/links/${r.links[0].id}/replace`).set("x-test-user", staff()).send({});
    expect(rep.body.code).toBe("LINK_PAID");
  });
});

describe("invoice subject", () => {
  const invBody = (extra: any = {}) => ({
    subject: "INVOICE", subjectId: String(INVOICE), split: { mode: "PERCENT", percents: [60, 40] }, recipient: { email: "ap@client.com" }, ...extra,
  });

  it("only a SENT invoice", async () => {
    for (const status of ["DRAFT", "PAID", "PAYMENT_DECLARED", "CANCELLED"]) {
      await Invoice.collection.updateOne({ _id: INVOICE }, { $set: { status } });
      expect((await create(invBody())).body.code).toBe("SUBJECT_NOT_ELIGIBLE");
    }
    await Invoice.collection.updateOne({ _id: INVOICE }, { $set: { status: "SENT" } });
    const ok = await create(invBody());
    expect(ok.status).toBe(201);
    expect(ok.body.request.links.map((l: any) => l.basePaise)).toEqual([60000, 40001]);
    expect(ok.body.request.customerId).toBe(String(CUST_A));
    expect(ok.body.request.invoiceWorkspaceId).toBe(String(CWS_A));
    expect((await subjectStatuses()).invoice).toBe("SENT");
  });

  it("warns when the invoice's bookings already have paid links, and proceeds on confirm", async () => {
    const b = (await create(bookingBody({ split: { mode: "EQUAL", parts: 1 } }))).body.request;
    await PaymentRequest.updateOne({ _id: b.id }, { $set: { "links.0.status": "PAID", status: "PAID", isOpen: false } });
    const warn = await create(invBody());
    expect(warn.status).toBe(409);
    expect(warn.body).toMatchObject({ code: "BOOKINGS_ALREADY_PAID_BY_LINK", needsConfirm: true });
    expect(warn.body.summary.paidBasePaise).toBe(100001);
    expect(await PaymentRequest.countDocuments({ subject: "INVOICE" })).toBe(0);
    const ok = await create(invBody({ confirm: true }));
    expect(ok.status).toBe(201);
  });

  it("lists an invoice's requests with its bookings' link summary", async () => {
    await create(bookingBody({ split: { mode: "EQUAL", parts: 1 } }));
    const res = await request(app).get(`/api/admin/payment-requests?invoiceId=${INVOICE}`).set("x-test-user", staff());
    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual([]);
    expect(res.body.bookingLinks.openLinks).toHaveLength(1);
  });
});

describe("access and tenant scoping", () => {
  it("a tenant admin with full grants is refused (Plumtrips money, Plumtrips staff)", async () => {
    const res = await create(bookingBody(), tenantAdmin);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("STAFF_ONLY");
    const inv = await create({ subject: "INVOICE", subjectId: String(INVOICE), split: { mode: "EQUAL", parts: 1 }, recipient: { email: "a@b.co" } }, tenantAdmin);
    expect(inv.status).toBe(403);
  });

  it("a request outside the caller's tenant answers 404, not 403", async () => {
    const r = (await create(bookingBody())).body.request; // tenant A
    const tenantB = JSON.stringify({ user: { _id: TENANT_ADMIN, roles: ["ADMIN"] }, workspaceObjectId: String(CWS_B), customerId: String(CUST_B) });
    expect((await request(app).get(`/api/admin/payment-requests/${r.id}`).set("x-test-user", tenantB)).status).toBe(404);
    expect((await request(app).post(`/api/admin/payment-requests/${r.id}/links/${r.links[0].id}/cancel`).set("x-test-user", tenantB)).status).toBe(404);
    // Own tenant: found, then refused as not staff.
    expect((await request(app).get(`/api/admin/payment-requests/${r.id}`).set("x-test-user", tenantAdmin)).status).toBe(403);
  });

  it("staff with OWN scope can't reach someone else's booking (404)", async () => {
    const res = await create(bookingBody(), staff(STAFF_OWN));
    expect(res.status).toBe(404);
  });

  it("staff without the grant are refused", async () => {
    expect((await create(bookingBody(), staff(STAFF_NOPERM))).status).toBe(403);
  });

  it("Super Admin may", async () => {
    expect((await create(bookingBody(), superAdmin)).status).toBe(201);
  });

  it("an unknown id answers 404", async () => {
    expect((await request(app).get(`/api/admin/payment-requests/${new mongoose.Types.ObjectId()}`).set("x-test-user", staff())).status).toBe(404);
    expect((await create({ ...bookingBody(), subjectId: String(new mongoose.Types.ObjectId()) })).status).toBe(404);
  });
});

describe("email", () => {
  it("one email listing each link with base and PG charge separately, via the outbox", async () => {
    const res = await create(bookingBody({ sendEmail: true }));
    expect(res.status).toBe(201);
    expect(res.body.email).toEqual({ status: "SENT", to: "pax@client.com" });
    expect(sentEmails).toHaveLength(1);
    const m = sentEmails[0];
    expect(m.event).toBe("payment_link_sent");
    expect(m.replyTo).toBe("ops@plumtrips.com");
    expect(m.to).toEqual(["pax@client.com"]);
    expect(m.html).toContain("https://rzp.io/i/fake1");
    expect(m.html).toContain("https://rzp.io/i/fake2");
    expect(m.html).toContain("Payment gateway charge");
    expect(m.text).toContain("Amount: ₹500.00");
    expect(m.text).toContain("Payment gateway charge: ₹10.00");
    expect(m.text).toContain("Total to pay: ₹510.01");
    const doc: any = await PaymentRequest.findById(res.body.request.id).lean();
    expect(doc.links.every((l: any) => l.emailOutboxIds.length === 1)).toBe(true);
  });

  it("resend can correct the recipient", async () => {
    const r = (await create(bookingBody())).body.request;
    const res = await request(app)
      .post(`/api/admin/payment-requests/${r.id}/send-email`)
      .set("x-test-user", staff())
      .send({ recipient: { name: "Accounts", email: "AP@Client.com" } });
    expect(res.status).toBe(200);
    expect(sentEmails[0].to).toEqual(["ap@client.com"]);
  });
});

describe("cancelOpenLinksForSubject (exported for Steps 2/3)", () => {
  it("cancels every CREATED / FAILED_CREATE link, reports the PAID ones, changes no booking", async () => {
    const { cancelOpenLinksForSubject } = await import("../services/paymentRequests.js");
    rz.failAtCall = 3; // third link never reaches Razorpay
    const r = (await create(bookingBody({ split: { mode: "EQUAL", parts: 3 } }))).body.request;
    expect(r.links.map((l: any) => l.status)).toEqual(["CREATED", "CREATED", "FAILED_CREATE"]);
    await PaymentRequest.updateOne({ _id: r.id }, { $set: { "links.0.status": "PAID" } });

    const report = await cancelOpenLinksForSubject("BOOKING", BOOKING, { id: STAFF });
    expect(report.paid.map((p) => p.linkId)).toEqual([r.links[0].id]);
    expect(report.cancelled.map((c) => c.linkId).sort()).toEqual([r.links[1].id, r.links[2].id].sort());
    expect(report.failed).toEqual([]);
    expect(rz.links.get(r.links[1].razorpayLinkId)!.status).toBe("cancelled");
    const doc: any = await PaymentRequest.findById(r.id).lean();
    expect(doc.links.map((l: any) => l.status)).toEqual(["PAID", "CANCELLED", "CANCELLED"]);
    expect(doc.status).toBe("PARTLY_PAID");
    expect((await subjectStatuses()).booking).toBe("PENDING");
  });
});

describe("dry run (the confirm screen's figures)", () => {
  it("returns the server's plan, saves nothing and never calls Razorpay", async () => {
    const res = await create(bookingBody({ dryRun: true, split: { mode: "PERCENT", percents: [40, 40, 20] } }));
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.plan.links).toEqual([
      { seq: 1, basePaise: 40000, pgChargePaise: 800, totalPaise: 40800 },
      { seq: 2, basePaise: 40000, pgChargePaise: 800, totalPaise: 40800 },
      { seq: 3, basePaise: 20001, pgChargePaise: 400, totalPaise: 20401 },
    ]);
    expect(res.body.plan.customerTotalPaise).toBe(102001);
    expect(res.body.plan.targetBasePaise).toBe(100001);
    expect(await PaymentRequest.countDocuments()).toBe(0);
    expect(rz.calls).toHaveLength(0);
  });

  it("refuses exactly what creation refuses", async () => {
    expect((await create(bookingBody({ dryRun: true, split: { mode: "AMOUNTS", amountsPaise: [1, 100000] } }))).body.code).toBe("LINK_TOO_SMALL");
    await create(bookingBody());
    expect((await create(bookingBody({ dryRun: true }))).body.code).toBe("OPEN_REQUEST_EXISTS");
  });
});

describe("GET /summary (list chips, one query)", () => {
  it("summarises a page of bookings; bookings without a request are absent", async () => {
    const r = (await create(bookingBody())).body.request;
    await PaymentRequest.updateOne({ _id: r.id }, { $set: { "links.0.status": "PAID", status: "PARTLY_PAID" } });
    const res = await request(app)
      .get(`/api/admin/payment-requests/summary?bookingIds=${BOOKING},${BOOKING_STUDENT},not-an-id`)
      .set("x-test-user", staff());
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.summaries)).toEqual([String(BOOKING)]);
    expect(res.body.summaries[String(BOOKING)]).toMatchObject({
      requestId: r.id, status: "PARTLY_PAID", linkCount: 2, paidLinkCount: 1, paidBasePaise: 50000, openLinkCount: 1,
    });
  });

  it("an open request describes the booking even when a newer cancelled one exists, and paid money adds up across requests", async () => {
    const r = (await create(bookingBody({ split: { mode: "EQUAL", parts: 1 } }))).body.request;
    await PaymentRequest.updateOne({ _id: r.id }, { $set: { "links.0.status": "PAID", status: "PAID", isOpen: false } });
    const second = (await create(bookingBody())).body.request;
    const res = await request(app).get(`/api/admin/payment-requests/summary?bookingIds=${BOOKING}`).set("x-test-user", staff());
    expect(res.body.summaries[String(BOOKING)]).toMatchObject({ requestId: second.id, status: "OPEN", paidBasePaise: 100001, openLinkCount: 2 });
  });

  it("is staff-only and capped at 100 ids", async () => {
    expect((await request(app).get(`/api/admin/payment-requests/summary?bookingIds=${BOOKING}`).set("x-test-user", tenantAdmin)).status).toBe(403);
    const many = Array.from({ length: 101 }, () => String(new mongoose.Types.ObjectId())).join(",");
    expect((await request(app).get(`/api/admin/payment-requests/summary?bookingIds=${many}`).set("x-test-user", staff())).body.code).toBe("TOO_MANY");
  });

  it("leaves out bookings the caller can't reach (OWN scope)", async () => {
    await create(bookingBody());
    const res = await request(app).get(`/api/admin/payment-requests/summary?bookingIds=${BOOKING}`).set("x-test-user", staff(STAFF_OWN));
    expect(res.body.summaries).toEqual({});
  });
});

describe("invoice links (Step 3)", () => {
  const invBody = (extra: any = {}) => ({ subject: "INVOICE", subjectId: String(INVOICE), split: { mode: "EQUAL", parts: 1 }, recipient: { email: "ap@client.com" }, ...extra });

  it("the invoice target is Invoice.grandTotal and the default recipient its bill-to contact", async () => {
    const res = await request(app).get(`/api/admin/payment-requests/preview?subject=INVOICE&id=${INVOICE}`).set("x-test-user", staff());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subjectRef: "INV-2026FY0041", targetBasePaise: 100001, blockedReason: null });
    expect(res.body.defaultRecipient).toEqual({ name: "Accounts", email: "ap@client.com" });
  });

  it("already collected by booking link: the preview names the booking ref, and creation needs confirm", async () => {
    const b = (await create(bookingBody({ split: { mode: "EQUAL", parts: 1 } }))).body.request;
    await PaymentRequest.updateOne({ _id: b.id }, { $set: { "links.0.status": "PAID", status: "PAID", isOpen: false } });
    const prev = await request(app).get(`/api/admin/payment-requests/preview?subject=INVOICE&id=${INVOICE}`).set("x-test-user", staff());
    expect(prev.body.bookingLinks.paidBasePaise).toBe(100001);
    expect(prev.body.bookingLinks.paidLinks[0].bookingRefs).toEqual(["MB-1001"]);
    // The dry run (the confirm screen) is refused the same way until confirm: true.
    expect((await create(invBody({ dryRun: true }))).body.code).toBe("BOOKINGS_ALREADY_PAID_BY_LINK");
    expect((await create(invBody({ dryRun: true, confirm: true }))).body.dryRun).toBe(true);
    expect((await create(invBody({ confirm: true }))).status).toBe(201);
    expect((await subjectStatuses()).invoice).toBe("SENT");
  });

  it("a non-SENT invoice keeps its request readable", async () => {
    const r = (await create(invBody())).body.request;
    await Invoice.collection.updateOne({ _id: INVOICE }, { $set: { status: "PAID" } });
    const list = await request(app).get(`/api/admin/payment-requests?invoiceId=${INVOICE}`).set("x-test-user", staff());
    expect(list.status).toBe(200);
    expect(list.body.requests.map((x: any) => x.id)).toEqual([r.id]);
    // ...but no new links on a non-SENT invoice.
    expect((await create(invBody())).body.code).toBe("SUBJECT_NOT_ELIGIBLE");
  });

  it("GET /summary?invoiceIds= — the invoice's own request plus what its bookings collected", async () => {
    const b = (await create(bookingBody({ split: { mode: "EQUAL", parts: 1 } }))).body.request;
    await PaymentRequest.updateOne({ _id: b.id }, { $set: { "links.0.status": "PAID", status: "PAID", isOpen: false } });
    const i = (await create(invBody({ confirm: true, split: { mode: "EQUAL", parts: 2 } }))).body.request;
    await PaymentRequest.updateOne({ _id: i.id }, { $set: { "links.0.status": "PAID", status: "PARTLY_PAID" } });
    const other = new mongoose.Types.ObjectId();
    const res = await request(app).get(`/api/admin/payment-requests/summary?invoiceIds=${INVOICE},${other}`).set("x-test-user", staff());
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.summaries)).toEqual([String(INVOICE)]);
    expect(res.body.summaries[String(INVOICE)]).toMatchObject({ requestId: i.id, status: "PARTLY_PAID", paidLinkCount: 1, linkCount: 2, bookingPaidBasePaise: 100001 });
  });

  it("an invoice with only booking-link money still gets a summary", async () => {
    const b = (await create(bookingBody({ split: { mode: "EQUAL", parts: 1 } }))).body.request;
    await PaymentRequest.updateOne({ _id: b.id }, { $set: { "links.0.status": "PAID", status: "PAID", isOpen: false } });
    const res = await request(app).get(`/api/admin/payment-requests/summary?invoiceIds=${INVOICE}`).set("x-test-user", staff());
    expect(res.body.summaries[String(INVOICE)]).toEqual({ bookingPaidBasePaise: 100001 });
  });

  it("invoice summary is staff-only and tenant-scoped", async () => {
    expect((await request(app).get(`/api/admin/payment-requests/summary?invoiceIds=${INVOICE}`).set("x-test-user", tenantAdmin)).status).toBe(403);
  });
});

describe("refresh", () => {
  it("pulls a paid state from Razorpay through the guards; a second refresh changes nothing", async () => {
    const r = (await create(bookingBody())).body.request;
    const fake = rz.links.get(r.links[0].razorpayLinkId)!;
    fake.status = "paid";
    fake.payments = [{ payment_id: "pay_1", amount: fake.amount, method: "card" }];
    const one = await request(app).post(`/api/admin/payment-requests/${r.id}/refresh`).set("x-test-user", staff());
    expect(one.body.changes).toEqual([{ linkId: r.links[0].id, outcome: "PAID" }]);
    expect(one.body.request.links[0]).toMatchObject({ status: "PAID", method: "card", paidAmountPaise: fake.amount });
    const two = await request(app).post(`/api/admin/payment-requests/${r.id}/refresh`).set("x-test-user", staff());
    expect(two.body.changes).toEqual([]);
    expect((await subjectStatuses()).booking).toBe("PENDING");
  });
});
