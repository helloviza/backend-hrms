// apps/backend/src/routes/businessWallets.polish.test.ts
//
// Business Wallets polish:
//   • names, never ids — Customer name → workspace name → "Unnamed company · slug";
//     Plumtrips' own workspace reads "Plumtrips (House)" — in the list, the
//     statement header, the summary download, statement downloads and emails;
//   • the list shows wallet-ON companies unless asked for the switched-off ones;
//   • adjustments read "Reduce what they owe (credit)" / "Add to what they owe (debit)";
//   • the duplicate-company report groups name variants and shared GSTIN / PAN /
//     company domain, ranks the "main" record by linked data, and writes nothing.
//
// Real: admin.businessWallets + sbt.wallet routers, services (companyNames,
//   companyDuplicates, sbtWallet), models, in-memory Mongo.
// Stubbed: requireAuth / requireWorkspace (headers), the email outbox, the leader lookup.
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

const { default: adminRouter } = await import("./admin.businessWallets.js");
const { default: walletRouter } = await import("./sbt.wallet.js");
const { normaliseCompanyName, groupDuplicates, collectDuplicateReport, reportCsv } = await import("../services/companyDuplicates.js");

const app = express();
app.use(express.json());
app.use("/api/admin/business-wallets", adminRouter);
app.use("/api/sbt/wallet", walletRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = (s?: string) => new mongoose.Types.ObjectId(s);
const HEX24 = /\b[a-f0-9]{24}\b/i;
const HOUSE = oid("69679a7628330a58d29f2254");
const NAMED_BY_CUSTOMER = oid();
const NAMED_BY_WS = oid();
const SLUG_ONLY = oid();
const NOTHING = oid();
const OFF = oid();
const CUST = oid();
const SA = oid();
const sa = (r: request.Test) =>
  r.set("x-test-user", JSON.stringify({ _id: String(SA), id: String(SA), sub: String(SA), roles: ["SUPERADMIN"] })).set("x-test-ws", String(HOUSE));
const leader = (r: request.Test, ws: mongoose.Types.ObjectId) =>
  r.set("x-test-user", JSON.stringify({ _id: String(SA), sub: String(SA), roles: ["CUSTOMER"], customerMemberRole: "WORKSPACE_LEADER" })).set("x-test-ws", String(ws));

const wallet = (extra: Record<string, unknown> = {}) => ({ sbtOfficialBooking: { enabled: true, creditLimit: 100000, used: 1000, ...extra } });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("business-wallets-polish-test"));
  await mongoose.model("SBTWalletLedger").syncIndexes();
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  for (const c of ["customerworkspaces", "customers", "users", "sbtwalletledgers", "sbtpayments", "sbtbookings", "sbthotelbookings",
    "manualbookings", "invoices", "creditnotes", "approvalrequests", "sbtmarginoverrides"]) await col(c).deleteMany({});
  mail.enqueueEmail.mockClear();
  await col("customers").insertOne({ _id: CUST, name: "Rohan Mehta", legalName: "Rohan Mehta", email: "rohan@gmail.com" } as any); // an affiliate — named like any company
  await col("customerworkspaces").insertMany([
    { _id: HOUSE, customerId: String(oid()), companyName: "", status: "ACTIVE", ...wallet() },
    { _id: NAMED_BY_CUSTOMER, customerId: String(CUST), companyName: "", status: "ACTIVE", ...wallet() },
    { _id: NAMED_BY_WS, customerId: String(oid()), companyName: "Acme Corp", status: "ACTIVE", ...wallet() },
    { _id: SLUG_ONLY, customerId: String(oid()), companyName: "", slug: "zen-travels", status: "ACTIVE", ...wallet() },
    { _id: NOTHING, customerId: String(oid()), companyName: "", status: "ACTIVE", ...wallet() },
    { _id: OFF, customerId: String(oid()), companyName: "Dormant Ltd", status: "ACTIVE", ...wallet({ enabled: false, creditLimit: 50000, used: 0 }) },
  ] as any[]);
  await col("users").insertOne({ _id: SA, email: "sa@plumtrips.com", name: "Imran Ali", roles: ["SUPERADMIN"] } as any);
});

describe("names, never ids", () => {
  it("the list names every company: Customer → workspace → slug; House is 'Plumtrips (House)'", async () => {
    const r = await sa(request(app).get("/api/admin/business-wallets"));
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.companies.map((c: any) => [c.workspaceId, c.companyName]));
    expect(byId[String(HOUSE)]).toBe("Plumtrips (House)");
    expect(byId[String(NAMED_BY_CUSTOMER)]).toBe("Rohan Mehta");
    expect(byId[String(NAMED_BY_WS)]).toBe("Acme Corp");
    expect(byId[String(SLUG_ONLY)]).toBe("Unnamed company · zen-travels");
    expect(byId[String(NOTHING)]).toBe("Unnamed company");
    for (const c of r.body.companies) expect(c.companyName).not.toMatch(HEX24);
  });

  it("the statement header, the summary download and statement downloads carry names, not ids", async () => {
    const one = await sa(request(app).get(`/api/admin/business-wallets/${NAMED_BY_CUSTOMER}`));
    expect(one.body.company.companyName).toBe("Rohan Mehta");
    const sum = await sa(request(app).get("/api/admin/business-wallets?format=csv"));
    const names = sum.text.split(/\r\n/).slice(1).map((l: string) => l.split(",")[0]);
    expect(names).toContain("Plumtrips (House)");
    for (const n of names) expect(n).not.toMatch(HEX24);
    const xl = await sa(request(app).get(`/api/admin/business-wallets/${NOTHING}?format=csv`));
    expect(xl.headers["content-disposition"]).not.toMatch(HEX24);
    const cust = await leader(request(app).get("/api/sbt/wallet/summary"), NAMED_BY_CUSTOMER);
    expect(cust.body.companyName).toBe("Rohan Mehta");
  });

  it("emails name the company, never its id", async () => {
    await sa(request(app).post(`/api/admin/business-wallets/${NOTHING}/payments`)).send({ amount: 500, paymentDate: "2026-10-01", mode: "UPI" });
    await sa(request(app).post(`/api/admin/business-wallets/${NAMED_BY_CUSTOMER}/payments`)).send({ amount: 500, paymentDate: "2026-10-01", mode: "UPI" });
    expect(mail.enqueueEmail).toHaveBeenCalledTimes(2);
    for (const [m] of mail.enqueueEmail.mock.calls as any[]) {
      expect(m.customerName).not.toMatch(HEX24);
      expect(m.html).not.toMatch(HEX24);
    }
    expect((mail.enqueueEmail.mock.calls[1] as any[])[0].customerName).toBe("Rohan Mehta");
  });
});

describe("wallet-on filter", () => {
  it("shows wallet-ON companies by default; the switch adds switched-off ones", async () => {
    const def = await sa(request(app).get("/api/admin/business-wallets"));
    expect(def.body.companies.map((c: any) => c.workspaceId)).not.toContain(String(OFF));
    expect(def.body.companies.every((c: any) => c.enabled)).toBe(true);
    const all = await sa(request(app).get("/api/admin/business-wallets?walletOff=include"));
    expect(all.body.companies.map((c: any) => c.workspaceId)).toContain(String(OFF));
    const csvDef = await sa(request(app).get("/api/admin/business-wallets?format=csv"));
    expect(csvDef.text).not.toContain("Dormant Ltd");
    const csvAll = await sa(request(app).get("/api/admin/business-wallets?format=csv&walletOff=include"));
    expect(csvAll.text).toContain("Dormant Ltd");
  });
});

describe("adjustment labels", () => {
  it("the statement and downloads say which way an adjustment went", async () => {
    await sa(request(app).post(`/api/admin/business-wallets/${NAMED_BY_WS}/adjustments`)).send({ direction: "CREDIT", amount: 100, reason: "Goodwill" });
    await sa(request(app).post(`/api/admin/business-wallets/${NAMED_BY_WS}/adjustments`)).send({ direction: "DEBIT", amount: 50, reason: "No-show fee" });
    const st = await sa(request(app).get(`/api/admin/business-wallets/${NAMED_BY_WS}`));
    expect(st.body.rows.map((r: any) => r.description)).toEqual([
      "Add to what they owe (debit) — No-show fee",
      "Reduce what they owe (credit) — Goodwill",
    ]);
    const csv = await sa(request(app).get(`/api/admin/business-wallets/${NAMED_BY_WS}?format=csv`));
    const lines = csv.text.split(/\r\n/).slice(1);
    expect(lines[0]).toContain(",Add to what they owe (debit),");
    expect(lines[1]).toContain(",Reduce what they owe (credit),");
    const bad = await sa(request(app).post(`/api/admin/business-wallets/${NAMED_BY_WS}/adjustments`)).send({ direction: "UP", amount: 1, reason: "x" });
    expect(bad.body.error).toMatch(/Reduce what they owe \(credit\).*Add to what they owe \(debit\)/);

    // The company sees the same adjustments in its own words.
    const cust = await leader(request(app).get("/api/sbt/wallet/statement"), NAMED_BY_WS);
    expect(cust.body.rows.map((r: any) => r.description)).toEqual([
      "Charge — adds to what you owe — No-show fee",
      "Credit — reduces what you owe — Goodwill",
    ]);
    const custCsv = await leader(request(app).get("/api/sbt/wallet/statement?format=csv"), NAMED_BY_WS);
    const custLines = custCsv.text.split(/\r\n/).slice(1);
    expect(custLines[0]).toContain(",Charge — adds to what you owe,");
    expect(custLines[1]).toContain(",Credit — reduces what you owe,");
    expect(custCsv.text).not.toMatch(/what they owe/);
    expect(JSON.stringify(cust.body)).not.toMatch(/what they owe/);
    // Customer emails (payment / 80%) never use the staff wording.
    await sa(request(app).post(`/api/admin/business-wallets/${NAMED_BY_WS}/payments`)).send({ amount: 10, paymentDate: "2026-10-01", mode: "UPI" });
    for (const [m] of mail.enqueueEmail.mock.calls as any[]) expect(`${m.subject} ${m.html}`).not.toMatch(/what they owe/);
  });
});

describe("duplicate companies — report only", () => {
  it("normalises legal suffixes, case, punctuation and spaces", () => {
    expect(normaliseCompanyName("LLAMA LOGISOL PRIVATE LIMITED")).toBe("llama logisol");
    expect(normaliseCompanyName("Llama Logisol Pvt. Ltd.")).toBe("llama logisol");
    expect(normaliseCompanyName("  Molnlycke  Health Care India Private Limited ")).toBe("molnlycke health care india");
    expect(normaliseCompanyName("Brightline Media LLP")).toBe("brightline media");
    expect(normaliseCompanyName("A & B Travels (OPC) Pvt Ltd")).toBe("a and b travels");
    expect(normaliseCompanyName("Limited")).toBe("limited"); // a lone word is never emptied
  });

  it("groups name variants, a shared GSTIN (and the PAN inside it) and a company domain — not public mail domains", () => {
    const g = groupDuplicates([
      { key: "a", names: ["LLAMA LOGISOL PRIVATE LIMITED"], gstin: "", pan: "", emailDomain: "" },
      { key: "b", names: ["Llama Logisol Pvt Ltd"], gstin: "", pan: "", emailDomain: "" },
      { key: "c", names: ["Molnlycke Health Care India Private Limited"], gstin: "29AABCM1234F1Z5", pan: "", emailDomain: "" },
      { key: "d", names: ["MHC India"], gstin: "29AABCM1234F1Z5", pan: "", emailDomain: "" },
      { key: "e", names: ["Molnlycke HC"], gstin: "", pan: "AABCM1234F", emailDomain: "" },
      { key: "f", names: ["Zenith Pharma"], gstin: "", pan: "", emailDomain: "zenith.in" },
      { key: "g", names: ["ZP Travel Desk"], gstin: "", pan: "", emailDomain: "zenith.in" },
      { key: "h", names: ["Rohan Mehta"], gstin: "", pan: "", emailDomain: "" },
      { key: "i", names: ["Priya Nair"], gstin: "", pan: "", emailDomain: "" },
    ]);
    const sets = g.map((x) => x.keys.sort().join(",")).sort();
    expect(sets).toEqual(["a,b", "c,d,e", "f,g"]);
    const molnlycke = g.find((x) => x.keys.includes("c"))!;
    expect(molnlycke.reasons).toEqual(expect.arrayContaining(["gstin:29AABCM1234F1Z5", "pan:AABCM1234F"]));
  });

  it("the report counts linked data, suggests a main record, lists unnamed workspaces — and writes nothing", async () => {
    const A = oid(); const B = oid(); const CA = oid(); const CB = oid();
    await col("customers").insertMany([
      { _id: CA, name: "LLAMA LOGISOL PRIVATE LIMITED", gstNumber: "27AAACL1111A1Z1", createdAt: new Date("2025-01-01") },
      { _id: CB, name: "Llama Logisol Pvt Ltd", createdAt: new Date("2026-02-01") },
    ] as any[]);
    await col("customerworkspaces").insertMany([
      { _id: A, customerId: String(CA), companyName: "", status: "ACTIVE", createdAt: new Date("2025-01-01"), ...wallet() },
      { _id: B, customerId: String(CB), companyName: "", status: "ACTIVE", createdAt: new Date("2026-02-01"), sbtOfficialBooking: { enabled: false } },
    ] as any[]);
    await col("users").insertMany([{ workspaceId: A, email: "a1@llama.in" }, { workspaceId: A, email: "a2@llama.in" }, { workspaceId: B, email: "b1@llama.in" }] as any[]);
    await col("invoices").insertMany([{ workspaceId: A, invoiceNo: "INV-1" }, { workspaceId: A, invoiceNo: "INV-2" }] as any[]);
    await col("manualbookings").insertMany([{ workspaceId: CA, bookingRef: "MB-1" }, { workspaceId: CB, bookingRef: "MB-2" }] as any[]);
    await col("sbtmarginoverrides").insertOne({ workspaceId: B, reason: "x" } as any);

    const snapshot = async () => {
      const out: Record<string, unknown> = {};
      for (const c of await mongoose.connection.db!.listCollections().toArray()) {
        out[c.name] = await col(c.name).find({}).sort({ _id: 1 }).toArray();
      }
      return JSON.stringify(out);
    };
    const before = await snapshot();
    const { rows, unnamed } = await collectDuplicateReport();
    expect(await snapshot()).toBe(before); // nothing written

    const llama = rows.filter((r) => /llama/i.test(r.name));
    expect(llama).toHaveLength(2);
    const main = llama.find((r) => r.main)!;
    expect(main).toMatchObject({ workspaceId: String(A), gstin: "27AAACL1111A1Z1", pan: "AAACL1111A", walletOn: true, marginOverride: false });
    expect(main.counts).toMatchObject({ users: 2, invoices: 2, manualBookings: 1 });
    const other = llama.find((r) => !r.main)!;
    expect(other).toMatchObject({ workspaceId: String(B), walletOn: false, marginOverride: true });
    expect(other.counts.users).toBe(1);
    expect(unnamed.map((u) => u.workspaceId)).toEqual(expect.arrayContaining([String(NOTHING), String(SLUG_ONLY)]));
    expect(unnamed.map((u) => u.workspaceId)).not.toContain(String(NAMED_BY_CUSTOMER));
    const csv = reportCsv(rows);
    expect(csv).toContain("Suggested main");
    expect(csv).toContain("MAIN");
  });
});
