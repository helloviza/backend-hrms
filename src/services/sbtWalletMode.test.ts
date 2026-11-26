// apps/backend/src/services/sbtWalletMode.test.ts
//
// SBT wallet billing mode (docs/specs/sbt-to-manual-booking-spec.md §3.6, P4;
// D-6, D-7, D-10):
//   • Postpaid → Prepaid holds the limit at 0 and saves it; Prepaid → Postpaid
//     restores it; reason required; same mode refused; a concurrent second
//     switch loses;
//   • Postpaid → Prepaid while money is owed: 409 BALANCE_OWED unless forced;
//   • every switch = one MODE_CHANGE ledger row (moves nothing), on both
//     statements (the reason on the staff one only), "" amount in downloads;
//   • Prepaid: a wallet booking passes only against an advance, with a
//     Prepaid-specific refusal; a limit change is refused while Prepaid;
//   • who: SuperAdmin; HOUSE staff with walletBillingMode FULL; NOT WRITE,
//     not a tenant admin holding the key, not staff without it — and the
//     SuperAdmin-only wallet routes stay SuperAdmin-only;
//   • /sbt/wallet/summary carries the staff block only for grant holders.
//
// Real: services, the two business-wallet routers, sbt.wallet router, models,
// in-memory Mongo. Stubbed: auth / workspace from headers, mail.
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
vi.mock("../services/emailOutbox.js", async (orig) => ({ ...(await orig<any>()), enqueueEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../services/approvalDeciders.js", async (orig) => ({
  ...(await orig<any>()),
  activeLeaderEmails: async () => [],
  inactiveEmails: async () => new Set<string>(),
}));

const { default: walletBillingRouter } = await import("../routes/admin.walletBilling.js");
const { default: businessWalletsRouter } = await import("../routes/admin.businessWallets.js");
const { default: sbtWalletRouter } = await import("../routes/sbt.wallet.js");
const mode = await import("./sbtWalletMode.js");
const wallet = await import("./sbtWallet.js");
const { reserveOfficial } = await import("./sbtPaymentGate.js");
const { UserPermission } = await import("../models/UserPermission.js");

const app = express();
app.use(express.json());
app.use("/api/admin/business-wallets", walletBillingRouter);
app.use("/api/admin/business-wallets", businessWalletsRouter);
app.use("/api/sbt/wallet", sbtWalletRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const HOUSE = "69679a7628330a58d29f2254";
const ACME = oid();
const SA = oid();
const BILLING_STAFF = oid();
const WRITE_STAFF = oid();
const PLAIN_STAFF = oid();
const TENANT_ADMIN = oid();
const L = 100000;

const hdr = (id: mongoose.Types.ObjectId, roles: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ _id: String(id), id: String(id), sub: String(id), email: `${id}@plumtrips.com`, roles, workspaceId: HOUSE, ...extra });
const as = (r: request.Test, user: string, ws = String(ACME)) => r.set("x-test-user", user).set("x-test-ws", ws);
const U = {
  sa: hdr(SA, ["SUPERADMIN"]),
  billing: hdr(BILLING_STAFF, ["ADMIN"]),
  write: hdr(WRITE_STAFF, ["ADMIN"]),
  plain: hdr(PLAIN_STAFF, ["ADMIN"]),
  tenant: hdr(TENANT_ADMIN, ["CUSTOMER", "WORKSPACE_LEADER"], { workspaceId: String(ACME), customerId: "C-ACME", customerMemberRole: "WORKSPACE_LEADER", email: "lead@acme.test" }),
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-wallet-mode-test"));
  await mongoose.model("SBTWalletLedger").syncIndexes();
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  for (const c of ["customerworkspaces", "sbtwalletledgers", "userpermissions", "users"]) await col(c).deleteMany({});
  await col("customerworkspaces").insertOne({ _id: ACME, customerId: "C-ACME", companyName: "Acme Corp", status: "ACTIVE", sbtOfficialBooking: { enabled: true, creditLimit: 5 * L, used: 0 } } as any);
  await col("users").insertMany([
    { _id: SA, email: "sa@plumtrips.com", roles: ["SUPERADMIN"] },
    { _id: TENANT_ADMIN, email: "lead@acme.test", sbtEnabled: true, customerId: "C-ACME" },
  ] as any[]);
  const grant = (userId: mongoose.Types.ObjectId, access: string, workspaceId = HOUSE) =>
    UserPermission.create({ userId: String(userId), email: `${userId}@x`, workspaceId, universe: "STAFF", level: { code: "L6", name: "Admin" }, modules: { walletBillingMode: { access, scope: "ALL" } }, grantedBy: String(SA), status: "active", tier: 3, roleType: "EMPLOYEE" } as any);
  await grant(BILLING_STAFF, "FULL");
  await grant(WRITE_STAFF, "WRITE");
  await grant(TENANT_ADMIN, "FULL", String(ACME));
});

const ws = async () => ((await col("customerworkspaces").findOne({ _id: ACME })) as any).sbtOfficialBooking;
const switchTo = (user: string, body: Record<string, unknown>) => as(request(app).put(`/api/admin/business-wallets/${ACME}/billing-mode`), user).send(body);
const reqFor = (roles = ["CUSTOMER"]) => ({ user: { _id: String(TENANT_ADMIN), sub: String(TENANT_ADMIN), roles }, workspaceObjectId: ACME });

describe("switch rules (D-6)", () => {
  it("Postpaid → Prepaid holds the limit at 0 and saves it; back to Postpaid restores it", async () => {
    const r = await switchTo(U.sa, { mode: "PREPAID", reason: "Advance agreed" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, billingMode: "PREPAID", wallet: { creditLimit: 0, billingMode: "PREPAID" } });
    expect(await ws()).toMatchObject({ billingMode: "PREPAID", creditLimit: 0, prepaidSavedLimit: 5 * L });

    const back = await switchTo(U.sa, { mode: "POSTPAID", reason: "Credit approved" });
    expect(back.status).toBe(200);
    const after = await ws();
    expect(after).toMatchObject({ billingMode: "POSTPAID", creditLimit: 5 * L });
    expect(after.prepaidSavedLimit).toBeUndefined();
  });

  it("reason required; unknown or same mode refused", async () => {
    expect((await switchTo(U.sa, { mode: "PREPAID" })).body.code).toBe("REASON_REQUIRED");
    expect((await switchTo(U.sa, { mode: "WEEKLY", reason: "x" })).body.code).toBe("BAD_MODE");
    expect((await switchTo(U.sa, { mode: "POSTPAID", reason: "x" })).body.code).toBe("SAME_MODE");
    expect(await col("sbtwalletledgers").countDocuments({})).toBe(0);
  });

  it("owes money → 409 BALANCE_OWED; forced with a reason → switched and flagged", async () => {
    await col("customerworkspaces").updateOne({ _id: ACME }, { $set: { "sbtOfficialBooking.used": 12000 } });
    const r = await switchTo(U.sa, { mode: "PREPAID", reason: "Moving to advance" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "BALANCE_OWED", owed: 12000 });
    expect((await ws()).billingMode).toBeUndefined();

    const forced = await switchTo(U.sa, { mode: "PREPAID", reason: "Moving to advance", force: true });
    expect(forced.status).toBe(200);
    const row: any = await col("sbtwalletledgers").findOne({ entryType: "MODE_CHANGE" });
    expect(row).toMatchObject({ type: "NONE", amount: 0, modeBefore: "POSTPAID", modeAfter: "PREPAID", limitBefore: 5 * L, limitAfter: 0, forced: true, remark: "Moving to advance", actorUserId: String(SA) });
  });

  it("two switches at once: one wins, the other is told the mode changed", async () => {
    const [a, b] = await Promise.all([
      mode.changeBillingMode(ACME, { mode: "PREPAID", reason: "a" }, String(SA)),
      mode.changeBillingMode(ACME, { mode: "PREPAID", reason: "b" }, String(SA)),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect(await col("sbtwalletledgers").countDocuments({ entryType: "MODE_CHANGE" })).toBe(1);
  });

  it("a limit change is refused while Prepaid", async () => {
    await switchTo(U.sa, { mode: "PREPAID", reason: "Advance" });
    const r = await wallet.changeLimit(ACME, { creditLimit: 9 * L, reason: "more" }, String(SA));
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/Prepaid/);
    expect((await ws()).creditLimit).toBe(0);
  });
});

describe("statements", () => {
  it("one Billing line on both statements; the reason only on the staff one; no amount in downloads", async () => {
    await switchTo(U.sa, { mode: "PREPAID", reason: "Advance agreed with Finance" });
    const staffRows = await wallet.statement(ACME, { staff: true });
    const custRows = await wallet.statement(ACME, { staff: false });
    expect(staffRows[0]).toMatchObject({ type: "MODE_CHANGE", modeBefore: "POSTPAID", modeAfter: "PREPAID", limitBefore: 5 * L, limitAfter: 0 });
    expect(staffRows[0].description).toMatch(/^Billing changed to Prepaid \(credit limit ₹5,00,000 → ₹0\) — Advance agreed with Finance$/);
    expect(custRows[0].description).toBe("Billing changed to Prepaid");
    const csv = wallet.statementCsv(custRows);
    expect(csv).toMatch(/Billing mode change,Billing changed to Prepaid,/);
    // A non-leader's own statement never shows it (bookings only).
    expect(await wallet.statement(ACME, { ownerUserId: String(TENANT_ADMIN) })).toHaveLength(0);
  });
});

describe("Prepaid bookings spend only the advance", () => {
  it("refused with a Prepaid message without an advance; passes within it; refused above it", async () => {
    await switchTo(U.sa, { mode: "PREPAID", reason: "Advance" });
    const none: any = await reserveOfficial(reqFor() as any, 8000);
    expect(none).toMatchObject({ ok: false, status: 402, code: "LIMIT_EXCEEDED" });
    expect(none.error).toMatch(/Prepaid.*advance paid in \(₹0\)/);

    await wallet.recordPayment(ACME, { amount: 20000, paymentDate: "2026-11-20", mode: "NEFT", reference: "UTR1" }, String(SA));
    expect(await reserveOfficial(reqFor() as any, 15000)).toMatchObject({ ok: true });
    const over: any = await reserveOfficial(reqFor() as any, 8000);
    expect(over.error).toMatch(/advance paid in \(₹5,000\)/);
    expect((await ws()).used).toBe(-5000);
  });
});

describe("who may change it (D-7, D-10)", () => {
  it("SuperAdmin and HOUSE staff with the grant at FULL", async () => {
    expect((await switchTo(U.billing, { mode: "PREPAID", reason: "x" })).status).toBe(200);
    expect((await switchTo(U.sa, { mode: "POSTPAID", reason: "y" })).status).toBe(200);
  });

  it("WRITE, no grant, and a tenant admin holding the key → 403; nothing changes", async () => {
    for (const u of [U.write, U.plain, U.tenant]) {
      const r = await switchTo(u, { mode: "PREPAID", reason: "x" });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("WALLET_BILLING_ACCESS_REQUIRED");
      const s = await as(request(app).put(`/api/admin/business-wallets/${ACME}/sbt-billing`), u).send({ allowPersonalInvoiceToCompany: true });
      expect(s.status).toBe(403);
    }
    expect((await ws()).billingMode).toBeUndefined();
  });

  it("a holder READS the wallets (list, company, statement, download) but never writes money", async () => {
    const list = await as(request(app).get("/api/admin/business-wallets"), U.billing);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ canManageMoney: false });
    expect(list.body.companies.map((c: any) => c.workspaceId)).toContain(String(ACME));
    const one = await as(request(app).get(`/api/admin/business-wallets/${ACME}`), U.billing);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ canManageMoney: false, company: { workspaceId: String(ACME) } });
    expect((await as(request(app).get(`/api/admin/business-wallets/${ACME}?format=csv`), U.billing)).status).toBe(200);

    const before = await ws();
    const pay = await as(request(app).post(`/api/admin/business-wallets/${ACME}/payments`), U.billing).send({ amount: 1000, paymentDate: "2026-11-20", mode: "NEFT" });
    const adj = await as(request(app).post(`/api/admin/business-wallets/${ACME}/adjustments`), U.billing).send({ direction: "CREDIT", amount: 1000, reason: "x" });
    const lim = await as(request(app).put(`/api/admin/business-wallets/${ACME}/limit`), U.billing).send({ creditLimit: 9 * L, reason: "x" });
    expect([pay.status, adj.status, lim.status]).toEqual([403, 403, 403]);
    expect(await ws()).toEqual(before);
    expect(await col("sbtwalletledgers").countDocuments({})).toBe(0);
  });

  it("non-holders (WRITE, no grant, a tenant admin with the key) can't even read the wallets", async () => {
    for (const u of [U.write, U.plain, U.tenant]) {
      expect((await as(request(app).get("/api/admin/business-wallets"), u)).status).toBe(403);
      expect((await as(request(app).get(`/api/admin/business-wallets/${ACME}`), u)).status).toBe(403);
      expect((await as(request(app).get(`/api/admin/business-wallets/${ACME}/billing`), u)).status).toBe(403);
    }
  });

  it("SuperAdmin keeps everything, and is told it may manage money", async () => {
    expect((await as(request(app).get(`/api/admin/business-wallets/${ACME}`), U.sa)).body.canManageMoney).toBe(true);
    const lim = await as(request(app).put(`/api/admin/business-wallets/${ACME}/limit`), U.sa).send({ creditLimit: 6 * L, reason: "more" });
    expect(lim.status).toBe(200);
    expect((await ws()).creditLimit).toBe(6 * L);
  });

  it("the invoicing setting: grant holders set it; default OFF", async () => {
    const get0 = await as(request(app).get(`/api/admin/business-wallets/${ACME}/billing`), U.billing);
    expect(get0.body).toMatchObject({ billingMode: "POSTPAID", sbtBilling: { allowPersonalInvoiceToCompany: false }, canManage: true });
    const put = await as(request(app).put(`/api/admin/business-wallets/${ACME}/sbt-billing`), U.billing).send({ allowPersonalInvoiceToCompany: true });
    expect(put.body).toMatchObject({ ok: true, sbtBilling: { allowPersonalInvoiceToCompany: true } });
    expect(((await col("customerworkspaces").findOne({ _id: ACME })) as any).sbtBilling).toMatchObject({ allowPersonalInvoiceToCompany: true, updatedBy: String(BILLING_STAFF) });
    expect((await as(request(app).put(`/api/admin/business-wallets/${ACME}/sbt-billing`), U.billing).send({ allowPersonalInvoiceToCompany: "yes" })).status).toBe(400);
  });

  it("/sbt/wallet/summary: mode for everyone, the staff block only for grant holders", async () => {
    await switchTo(U.sa, { mode: "PREPAID", reason: "x" });
    const t = await as(request(app).get("/api/sbt/wallet/summary"), U.tenant);
    expect(t.body).toMatchObject({ billingMode: "PREPAID", advance: 0 });
    expect(t.body.staff).toBeUndefined();
    const s = await as(request(app).get("/api/sbt/wallet/summary"), U.billing);
    expect(s.body.staff).toMatchObject({ workspaceId: String(ACME), canManageBilling: true, prepaidSavedLimit: 5 * L });
  });
});
