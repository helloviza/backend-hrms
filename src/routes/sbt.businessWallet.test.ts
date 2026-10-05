// apps/backend/src/routes/sbt.businessWallet.test.ts
//
// The SBT Business Wallet as a CREDIT LINE: available = creditLimit − used.
// Wallet bookings raise `used` (refused above available, also under
// concurrency); cancellation refunds come only from the ledger; Super Admin
// records payments, adjustments (reason required) and limit changes — nobody
// else; every move is a ledger entry; customers get a statement scoped to the
// company (Workspace Leader) or to their own bookings, with selling amounts
// only; downloads carry only that company's rows; the 80% email goes once; the
// migration derives limit and used from the old model and the ledger.
//
// Real: sbt.wallet + admin.businessWallets routers, services (sbtWallet,
//   sbtPaymentGate), models, in-memory Mongo.
// Stubbed: requireAuth / requireWorkspace (headers), the email outbox, the
//   Workspace Leader lookup, TBO agency balance.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: (req: any, _res: any, next: any) => {
    const id = String(req.headers["x-test-ws"] || "");
    req.workspaceId = id;
    req.workspaceObjectId = new mongoose.Types.ObjectId(id);
    next();
  },
}));
const mail = vi.hoisted(() => ({ enqueueEmail: vi.fn(async () => ({ ok: true, id: "m", status: "SENT" })) }));
vi.mock("../services/emailOutbox.js", async (orig) => ({ ...(await orig<any>()), ...mail }));
vi.mock("../services/approvalDeciders.js", async (orig) => ({
  ...(await orig<any>()),
  activeLeaderEmails: async () => ["leader@acme.test"],
  inactiveEmails: async () => new Set<string>(),
}));
vi.mock("../services/tbo.auth.service.js", async (orig) => ({ ...(await orig<any>()), getAgencyBalance: async () => ({ CashBalance: 1e9 }) }));

const { default: walletRouter } = await import("./sbt.wallet.js");
const { default: adminRouter } = await import("./admin.businessWallets.js");
const { default: settingsRouter } = await import("./workspace.settings.js");
const { reserveOfficial, creditOfficial, creditCancelledBooking } = await import("../services/sbtPaymentGate.js");
const { checkUsageAlert, ledgerUsed, creditLineFromLegacy, walletStateOf } = await import("../services/sbtWallet.js");

const app = express();
app.use(express.json());
app.use("/api/sbt/wallet", walletRouter);
app.use("/api/admin/business-wallets", adminRouter);
app.use("/api/workspace/settings", (req: any, _res, next) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceId = String(req.headers["x-test-ws"] || "");
  req.workspaceObjectId = new mongoose.Types.ObjectId(req.workspaceId);
  next();
}, settingsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const ACME = oid();
const BETA = oid();
const LEADER = oid();
const ASHA = oid(); // employee, books her own trips
const RAVI = oid(); // another employee
const SA = oid();
const L = 100000; // ₹1 lakh

const userHdr = (id: mongoose.Types.ObjectId, roles: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ _id: String(id), id: String(id), sub: String(id), email: `${id}@t`, roles, ...extra });
const asLeader = (r: request.Test, ws = ACME) => r.set("x-test-user", userHdr(LEADER, ["CUSTOMER"], { customerMemberRole: "WORKSPACE_LEADER" })).set("x-test-ws", String(ws));
const asAsha = (r: request.Test) => r.set("x-test-user", userHdr(ASHA, ["CUSTOMER"])).set("x-test-ws", String(ACME));
const asSA = (r: request.Test) => r.set("x-test-user", userHdr(SA, ["SUPERADMIN"])).set("x-test-ws", String(ACME));
const reqFor = (userId: mongoose.Types.ObjectId, ws = ACME, roles = ["CUSTOMER"]) =>
  ({ user: { _id: String(userId), sub: String(userId), roles }, workspaceObjectId: ws });

async function setWallet(ws: mongoose.Types.ObjectId, creditLimit: number, used: number, extra: Record<string, unknown> = {}) {
  await col("customerworkspaces").updateOne({ _id: ws }, { $set: { sbtOfficialBooking: { enabled: true, creditLimit, used, ...extra } } });
}
const used = async (ws = ACME) => ((await col("customerworkspaces").findOne({ _id: ws })) as any).sbtOfficialBooking.used;

/** A paid wallet booking: SBTPayment row + flight booking + ledger DEBIT through the real reserve. */
async function walletBooking(owner: mongoose.Types.ObjectId, amount: number, pnr: string, extra: { netAmount?: number } = {}) {
  const payId = oid();
  const bookingId = oid();
  const r = await reserveOfficial(reqFor(owner) as any, amount, { key: `debit:${payId}`, reason: "BOOKING", paymentId: String(payId), product: "FLIGHT" });
  if (!(r as any).ok) return r;
  await col("sbtpayments").insertOne({
    _id: payId, product: "FLIGHT", mode: "OFFICIAL", status: "TICKETED", userId: String(owner), workspaceId: String(ACME),
    amount, amountPaise: amount * 100, bookingDocIds: [String(bookingId)], refunds: [], refundedPaise: 0, isTest: false,
    fulfilment: { kind: "FLIGHT_LCC", save: {} },
  } as any);
  await col("sbtbookings").insertOne({
    _id: bookingId, userId: owner, workspaceId: ACME, pnr, bookingId: "7001", status: "CONFIRMED", totalFare: amount,
    netAmount: extra.netAmount ?? amount * 0.9, marginAmount: amount * 0.1, commissionEarned: 250,
    origin: { code: "DEL", city: "Delhi" }, destination: { code: "BOM", city: "Mumbai" }, departureTime: "2026-11-01T06:00:00",
    passengers: [{ firstName: owner.equals(ASHA) ? "Asha" : "Ravi", lastName: owner.equals(ASHA) ? "Rao" : "Kumar" }],
  } as any);
  return { ok: true, payId, bookingId };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-business-wallet-test"));
  await mongoose.model("SBTWalletLedger").syncIndexes();
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  for (const c of ["customerworkspaces", "users", "sbtwalletledgers", "sbtpayments", "sbtbookings", "sbthotelbookings"]) await col(c).deleteMany({});
  mail.enqueueEmail.mockClear();
  await col("customerworkspaces").insertMany([
    { _id: ACME, customerId: "C-ACME", companyName: "Acme Corp", status: "ACTIVE", sbtOfficialBooking: { enabled: true, creditLimit: 10 * L, used: 0 } },
    { _id: BETA, customerId: "C-BETA", companyName: "Beta Ltd", status: "ACTIVE", sbtOfficialBooking: { enabled: true, creditLimit: 5 * L, used: 0 } },
  ] as any[]);
  await col("users").insertMany([
    { _id: SA, email: "sa@plumtrips.com", name: "Imran Ali", roles: ["SUPERADMIN"] },
    { _id: ASHA, email: "asha@acme.test", firstName: "Asha", lastName: "Rao", sbtEnabled: true },
    { _id: RAVI, email: "ravi@acme.test", firstName: "Ravi", lastName: "Kumar", sbtEnabled: true },
    { _id: LEADER, email: "leader@acme.test", firstName: "Lata", lastName: "Leader", sbtEnabled: true },
  ] as any[]);
});

describe("the credit line", () => {
  it("Imran's example: limit 10L, used 8L, payment 5L → available 7L", async () => {
    await setWallet(ACME, 10 * L, 8 * L);
    const r = await asSA(request(app).post(`/api/admin/business-wallets/${ACME}/payments`))
      .send({ amount: 5 * L, paymentDate: "2026-10-01", mode: "NEFT", reference: "UTR123", note: "Sept invoice" });
    expect(r.status).toBe(200);
    expect(r.body.wallet).toMatchObject({ creditLimit: 10 * L, used: 3 * L, available: 7 * L });
    const s = await asLeader(request(app).get("/api/sbt/wallet/summary"));
    expect(s.body).toMatchObject({ creditLimit: 10 * L, used: 3 * L, available: 7 * L });
    const e: any = await col("sbtwalletledgers").findOne({ entryType: "PAYMENT_RECEIVED" });
    expect(e).toMatchObject({ type: "CREDIT", amount: 5 * L, usedAfter: 3 * L, actorUserId: String(SA), payment: { mode: "NEFT", reference: "UTR123" }, remark: "Sept invoice" });
  });

  it("a booking above available is refused, and nothing moves", async () => {
    await setWallet(ACME, 10 * L, 9.5 * L);
    const r: any = await reserveOfficial(reqFor(ASHA) as any, 60000, { key: "debit:x", reason: "BOOKING" });
    expect(r).toMatchObject({ ok: false, status: 402, code: "LIMIT_EXCEEDED" });
    expect(r.error).toMatch(/available travel credit/);
    expect(await used()).toBe(9.5 * L);
    expect(await col("sbtwalletledgers").countDocuments()).toBe(0);
    // Exactly the available amount is fine.
    expect(await reserveOfficial(reqFor(ASHA) as any, 50000, { key: "debit:y", reason: "BOOKING" })).toMatchObject({ ok: true });
    expect(await used()).toBe(10 * L);
  });

  it("no limit set → nothing available (the old '0 = unlimited' is gone)", async () => {
    await setWallet(ACME, 0, 0);
    expect(await reserveOfficial(reqFor(ASHA) as any, 1, { key: "debit:z", reason: "BOOKING" })).toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
  });

  it("concurrent wallet bookings can't overspend", async () => {
    await setWallet(ACME, 10000, 0);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      reserveOfficial(reqFor(ASHA) as any, 3000, { key: `debit:c${i}`, reason: "BOOKING" })));
    expect(results.filter((r: any) => r.ok).length).toBe(3);
    expect(await used()).toBe(9000);
    expect(await col("sbtwalletledgers").countDocuments({ entryType: "BOOKING" })).toBe(3);
  });

  it("cancellation refunds come only from the ledger, once", async () => {
    const b: any = await walletBooking(ASHA, 12000, "PNRA");
    expect(await used()).toBe(12000);
    const booking = await col("sbtbookings").findOne({ _id: b.bookingId });
    const first = await creditCancelledBooking("FLIGHT", { ...booking, totalFare: 999999 } as any);
    expect(first.credited).toBe(12000); // the ledger's 12000, not the booking's tampered total
    expect((await creditCancelledBooking("FLIGHT", booking as any)).credited).toBe(0); // nothing left
    expect(await used()).toBe(0);
    // A booking with no wallet ledger gives nothing back.
    expect((await creditCancelledBooking("FLIGHT", { _id: oid(), workspaceId: ACME, bookingId: "9" })).credited).toBe(0);
    const c: any = await col("sbtwalletledgers").findOne({ type: "CREDIT" });
    expect(c).toMatchObject({ entryType: "CANCELLATION_REFUND", amount: 12000, usedAfter: 0 });
    // The refund names its booking once (the entry and its payment row both point at it).
    const st = await asLeader(request(app).get("/api/sbt/wallet/statement?types=CANCELLATION_REFUND"));
    expect(st.body.rows).toHaveLength(1);
    expect(st.body.rows[0]).toMatchObject({ bookingRef: "PNRA", travellers: "Asha Rao", trip: "DEL → BOM · 1 Nov 2026" });
  });

  it("a failed checkout's release gives the reservation back exactly once", async () => {
    await reserveOfficial(reqFor(ASHA) as any, 5000, { key: "debit:p1", reason: "BOOKING", paymentId: "p1" });
    expect(await creditOfficial(ACME, 5000, undefined, { key: "credit:p1", reason: "RELEASE_SUPPLIER_FAILED", paymentId: "p1" })).toBe(true);
    expect(await creditOfficial(ACME, 5000, undefined, { key: "credit:p1", reason: "RELEASE_SUPPLIER_FAILED", paymentId: "p1" })).toBe(false);
    expect(await used()).toBe(0);
  });
});

describe("Super Admin actions", () => {
  const actions = (ws = ACME) => [
    ["payment", "post", `/api/admin/business-wallets/${ws}/payments`, { amount: 1000, paymentDate: "2026-10-01", mode: "UPI" }],
    ["adjustment", "post", `/api/admin/business-wallets/${ws}/adjustments`, { direction: "CREDIT", amount: 1000, reason: "Goodwill" }],
    ["limit", "put", `/api/admin/business-wallets/${ws}/limit`, { creditLimit: 2 * L, reason: "Renewal" }],
  ] as const;

  it("only a SUPERADMIN can record payments, adjust or change the limit — or read the House pages", async () => {
    for (const roles of [["ADMIN"], ["HR"], ["OPS"], ["CUSTOMER"], ["WORKSPACE_LEADER"], ["SUPERADMIN"]]) {
      const extra = roles[0] === "SUPERADMIN" ? { _demoImpersonation: true } : { customerMemberRole: "WORKSPACE_LEADER" };
      const hdr = userHdr(LEADER, roles, extra);
      for (const [, method, path, body] of actions()) {
        const r = await (request(app) as any)[method](path).set("x-test-user", hdr).send(body);
        expect(r.status, `${roles} ${path}`).toBe(403);
      }
      expect((await request(app).get("/api/admin/business-wallets").set("x-test-user", hdr)).status).toBe(403);
    }
    expect(await col("sbtwalletledgers").countDocuments()).toBe(0);
    expect(await used()).toBe(0);
  });

  it("an adjustment needs a reason; with one it moves `used` and is logged with who and why", async () => {
    await setWallet(ACME, 10 * L, 50000);
    const none = await asSA(request(app).post(`/api/admin/business-wallets/${ACME}/adjustments`)).send({ direction: "CREDIT", amount: 2000, reason: "  " });
    expect(none.status).toBe(400);
    expect(await col("sbtwalletledgers").countDocuments()).toBe(0);
    const ok = await asSA(request(app).post(`/api/admin/business-wallets/${ACME}/adjustments`))
      .send({ direction: "DEBIT", amount: 2000, reason: "Airline no-show fee", internalNote: "per email 4 Oct" });
    expect(ok.status).toBe(200);
    expect(await used()).toBe(52000);
    expect(await col("sbtwalletledgers").findOne({ entryType: "ADJUSTMENT" })).toMatchObject({
      type: "DEBIT", amount: 2000, remark: "Airline no-show fee", internalNote: "per email 4 Oct", actorUserId: String(SA), usedAfter: 52000,
    });
  });

  it("a limit change needs a reason and is a ledger entry (before → after)", async () => {
    expect((await asSA(request(app).put(`/api/admin/business-wallets/${ACME}/limit`)).send({ creditLimit: 12 * L })).status).toBe(400);
    const r = await asSA(request(app).put(`/api/admin/business-wallets/${ACME}/limit`)).send({ creditLimit: 12 * L, reason: "Annual review" });
    expect(r.body.wallet).toMatchObject({ creditLimit: 12 * L, available: 12 * L });
    expect(await col("sbtwalletledgers").findOne({ entryType: "LIMIT_CHANGE" })).toMatchObject({
      type: "NONE", limitBefore: 10 * L, limitAfter: 12 * L, remark: "Annual review", actorUserId: String(SA),
    });
  });

  it("a double-submitted payment is recorded once", async () => {
    const body = { amount: 1000, paymentDate: "2026-10-01", mode: "CHEQUE", reference: "000123", clientKey: "form-1" };
    expect((await asSA(request(app).post(`/api/admin/business-wallets/${ACME}/payments`)).send(body)).status).toBe(200);
    expect((await asSA(request(app).post(`/api/admin/business-wallets/${ACME}/payments`)).send(body)).status).toBe(409);
    expect(await used()).toBe(-1000);
  });

  it("payments are validated: amount, mode, a date not in the future", async () => {
    for (const bad of [
      { amount: 0, paymentDate: "2026-10-01", mode: "NEFT" },
      { amount: 100, paymentDate: "2026-10-01", mode: "CASH" },
      { amount: 100, paymentDate: "2099-01-01", mode: "NEFT" },
      { amount: 100, mode: "NEFT" },
    ]) {
      expect((await asSA(request(app).post(`/api/admin/business-wallets/${ACME}/payments`)).send(bad)).status).toBe(400);
    }
  });

  it("customers can no longer change their own limit; the monthly reset is retired", async () => {
    const r = await asLeader(request(app).put("/api/workspace/settings/official-booking"))
      .set("x-test-user", userHdr(LEADER, ["WORKSPACE_LEADER"])).send({ enabled: true, monthlyLimit: 99 * L, creditLimit: 99 * L });
    expect(r.status).toBe(200);
    expect((await walletStateOf(ACME)).creditLimit).toBe(10 * L);
  });
});

describe("statements", () => {
  async function scenario() {
    await walletBooking(ASHA, 12000, "PNRASHA", { netAmount: 10500 });
    await walletBooking(RAVI, 8000, "PNRRAVI");
    await asSA(request(app).post(`/api/admin/business-wallets/${ACME}/payments`)).send({ amount: 5000, paymentDate: "2026-10-02", mode: "NEFT", reference: "UTR9" });
    // Another company's activity must never show.
    await reserveOfficial(reqFor(ASHA, BETA) as any, 777, { key: "debit:beta", reason: "BOOKING" });
  }

  it("a Workspace Leader sees the whole company: bookings with travellers, trip and booked-by, and payments", async () => {
    await scenario();
    const r = await asLeader(request(app).get("/api/sbt/wallet/statement"));
    expect(r.status).toBe(200);
    expect(r.body.wholeCompany).toBe(true);
    expect(r.body.rows.map((x: any) => x.type).sort()).toEqual(["BOOKING", "BOOKING", "PAYMENT_RECEIVED"]);
    const asha = r.body.rows.find((x: any) => x.bookingRef === "PNRASHA");
    expect(asha).toMatchObject({ amount: 12000, usedAfter: 12000, travellers: "Asha Rao", trip: expect.stringContaining("DEL → BOM"), bookedBy: "Asha Rao", product: "FLIGHT" });
    expect(r.body.rows.find((x: any) => x.type === "PAYMENT_RECEIVED")).toMatchObject({ amount: 5000, payment: { mode: "NEFT", reference: "UTR9" } });
  });

  it("an employee sees only their own bookings' entries — no other bookings, payments or adjustments", async () => {
    await scenario();
    const r = await asAsha(request(app).get("/api/sbt/wallet/statement"));
    expect(r.body.wholeCompany).toBe(false);
    expect(r.body.rows.map((x: any) => x.bookingRef)).toEqual(["PNRASHA"]);
  });

  it("no net, margin, commission or staff-only field in the customer statement or downloads", async () => {
    await scenario();
    const r = await asLeader(request(app).get("/api/sbt/wallet/statement"));
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/netAmount|marginAmount|commission|internalNote|enteredBy|10500/i);
    const csv = await asLeader(request(app).get("/api/sbt/wallet/statement?format=csv"));
    expect(csv.text).not.toMatch(/10500|Internal note|Entered by/);
  });

  it("downloads carry only that company's rows (customer and House)", async () => {
    await scenario();
    const csv = await asLeader(request(app).get("/api/sbt/wallet/statement?format=csv"));
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    const lines = csv.text.trim().split(/\r\n/);
    expect(lines.length).toBe(1 + 3);
    expect(csv.text).toContain("PNRASHA");
    expect(csv.text).not.toContain("777");
    const xlsx = await asLeader(request(app).get("/api/sbt/wallet/statement?format=xlsx")).buffer(true);
    expect(xlsx.headers["content-type"]).toMatch(/spreadsheetml/);
    const house = await asSA(request(app).get(`/api/admin/business-wallets/${ACME}?format=csv`));
    expect(house.text).toContain("Entered by");
    expect(house.text.trim().split(/\r\n/).length).toBe(1 + 3);
    expect(house.text).not.toContain("777");
    const beta = await asSA(request(app).get(`/api/admin/business-wallets/${BETA}?format=csv`));
    expect(beta.text.trim().split(/\r\n/).length).toBe(1 + 1);
  });

  it("filters: type, search and date range", async () => {
    await scenario();
    const t = await asLeader(request(app).get("/api/sbt/wallet/statement?types=PAYMENT_RECEIVED"));
    expect(t.body.rows).toHaveLength(1);
    const q = await asLeader(request(app).get("/api/sbt/wallet/statement?q=ravi"));
    expect(q.body.rows.map((x: any) => x.bookingRef)).toEqual(["PNRRAVI"]);
    const d = await asLeader(request(app).get("/api/sbt/wallet/statement?from=2020-01-01&to=2020-01-31"));
    expect(d.body.rows).toHaveLength(0);
  });

  it("the House list shows limit, used, available, % used and flags ≥80%", async () => {
    await setWallet(BETA, 5 * L, 4.2 * L);
    const r = await asSA(request(app).get("/api/admin/business-wallets"));
    const beta = r.body.companies.find((c: any) => c.companyName === "Beta Ltd");
    expect(beta).toMatchObject({ creditLimit: 5 * L, used: 4.2 * L, available: 0.8 * L, usagePct: 84, nearLimit: true });
    const sum = await asSA(request(app).get("/api/admin/business-wallets?format=csv"));
    expect(sum.text).toContain("Beta Ltd");
  });
});

describe("the 80% email", () => {
  it("fires once when usage crosses 80%, and again only after it dropped below", async () => {
    await setWallet(ACME, 10000, 7000);
    await reserveOfficial(reqFor(ASHA) as any, 1500, { key: "debit:a", reason: "BOOKING" }); // 85%
    await checkUsageAlert(ACME);
    await reserveOfficial(reqFor(ASHA) as any, 500, { key: "debit:b", reason: "BOOKING" }); // 90%
    await checkUsageAlert(ACME);
    const alerts = () => mail.enqueueEmail.mock.calls.filter((c: any) => c[0].event === "wallet_usage_80");
    expect(alerts()).toHaveLength(1);
    expect((alerts()[0] as any[])[0]).toMatchObject({ to: ["leader@acme.test"], replyTo: "ops@plumtrips.com" });
    // A payment brings it under 80% → flag cleared, a payment email goes out.
    await asSA(request(app).post(`/api/admin/business-wallets/${ACME}/payments`)).send({ amount: 5000, paymentDate: "2026-10-01", mode: "UPI" });
    expect(mail.enqueueEmail.mock.calls.filter((c: any) => c[0].event === "wallet_payment_received")).toHaveLength(1);
    expect(((await col("customerworkspaces").findOne({ _id: ACME })) as any).sbtOfficialBooking.usageAlertSent).toBe(false);
    await reserveOfficial(reqFor(ASHA) as any, 4000, { key: "debit:c", reason: "BOOKING" }); // 9000 → 90%
    await checkUsageAlert(ACME);
    expect(alerts()).toHaveLength(2);
  });
});

describe("migration", () => {
  it("creditLimit = old monthly limit; used = non-test ledger debits − credits", async () => {
    await col("sbtwalletledgers").insertMany([
      { workspaceId: String(ACME), type: "DEBIT", amount: 30000, monthKey: "2026-09", reason: "BOOKING", idempotencyKey: "m1", isTest: false },
      { workspaceId: String(ACME), type: "DEBIT", amount: 20000, monthKey: "2026-10", reason: "BOOKING", idempotencyKey: "m2", isTest: false },
      { workspaceId: String(ACME), type: "CREDIT", amount: 5000, monthKey: "2026-10", reason: "CANCELLATION", idempotencyKey: "m3", isTest: false },
      { workspaceId: String(ACME), type: "DEBIT", amount: 99999, monthKey: "2026-10", reason: "BOOKING", idempotencyKey: "m4", isTest: true },
      { workspaceId: String(BETA), type: "DEBIT", amount: 1234, monthKey: "2026-10", reason: "BOOKING", idempotencyKey: "m5", isTest: false },
    ] as any[]);
    expect(await ledgerUsed(ACME)).toEqual({ used: 45000, debits: 50000, credits: 5000, testRows: 1 });
    expect(creditLineFromLegacy({ enabled: true, monthlyLimit: 50000 }, 45000)).toEqual({ creditLimit: 50000, used: 45000, usageAlertSent: true, wasUnlimited: false });
    expect(creditLineFromLegacy({ enabled: true, monthlyLimit: 0 }, 1000)).toEqual({ creditLimit: 0, used: 1000, usageAlertSent: false, wasUnlimited: true });
    expect(creditLineFromLegacy({ enabled: false, monthlyLimit: 100000 }, 0)).toMatchObject({ creditLimit: 100000, usageAlertSent: false, wasUnlimited: false });
  });
});
