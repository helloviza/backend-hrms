// apps/backend/src/server.billingOwnScope.test.ts
//
// Scope OWN for Invoices and Credit Notes (Imran, 2026-10-07). Plumtrips ops
// staff shaped like chirag@ (roles [EMPLOYEE], HOUSE, invoices + creditnotes +
// manualBookings with scope OWN) see only invoices that carry a booking they
// created (or that they generated), credit notes on those invoices (or that
// they created), and may invoice / credit only their own bookings' lines.
// Scope ALL and Super Admin are unchanged.
//
// Through the REAL app (server.ts) with REAL login tokens, as in
// server.adminMount.test.ts. Only Mongo is in-memory; PDF render + S3 upload of
// credit notes are stubbed (no egress).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { MongoMemoryServer } from "mongodb-memory-server";

Object.assign(process.env, {
  NODE_ENV: "test",
  DEPLOYMENT_MODE: "plumbox",
  MONGO_URI: "mongodb://127.0.0.1:1/never",
  JWT_SECRET: "test-jwt-secret-billing-own",
  JWT_REFRESH_SECRET: "test-jwt-refresh-secret-billing-own",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
  OPENAI_API_KEY: "test",
  CONSUMER_JWT_SECRET: "test-consumer-jwt-secret-billing-own",
});

vi.mock("./utils/creditNotePdf.js", () => ({ generateCreditNotePdf: vi.fn(async () => Buffer.from("%PDF-test")) }));
vi.mock("./utils/s3Upload.js", () => ({ uploadAndPresign: vi.fn(async (k: string) => `https://s3.test/${k}`) }));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, init);
  throw new Error(`egress blocked in test: ${url}`);
}) as typeof fetch;

const HOUSE = "69679a7628330a58d29f2254";
const PASSWORD = "Correct-Horse-9";
const oid = () => new mongoose.Types.ObjectId();
const O = (id: string) => new mongoose.Types.ObjectId(id);

let mongod: MongoMemoryServer;
let app: any;
let UserPermission: any;
const col = (n: string) => mongoose.connection.db!.collection(n);

type Who = { id: string; email: string; token: string };
let seq = 0;

async function person(opts: {
  roles: string[];
  first: string;
  last: string;
  grants: Record<string, [string, string]>; // module → [access, scope]
}): Promise<Who> {
  const id = oid();
  const email = `u${++seq}-${id}@plumtrips.com`;
  await col("users").insertOne({
    _id: id, email, firstName: opts.first, lastName: opts.last, name: `${opts.first} ${opts.last}`,
    roles: opts.roles, passwordHash: await bcrypt.hash(PASSWORD, 4), workspaceId: O(HOUSE),
  } as any);
  const modules: any = {};
  for (const [k, [access, scope]] of Object.entries(opts.grants)) modules[k] = { access, scope };
  await UserPermission.create({
    userId: String(id), email, workspaceId: HOUSE, universe: "STAFF",
    level: { code: "L2", name: "Senior" }, modules, grantedBy: "test",
  } as any);
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return { id: String(id), email, token: res.body.accessToken };
}

const as = (w: Who, r: request.Test) => r.set("Authorization", `Bearer ${w.token}`);
const get = (w: Who, p: string) => as(w, request(app).get(p));
const post = (w: Who, p: string, body: unknown = {}) => as(w, request(app).post(p).send(body as any));
const patch = (w: Who, p: string, body: unknown = {}) => as(w, request(app).patch(p).send(body as any));

let chirag: Who, writer: Who, priya: Who, superAdmin: Who;

const CUST = oid();
const CWS = oid();
const REASON = oid();
const B = {
  mine: oid(), other: oid(), otherOnly: oid(), imported: oid(), onMyInvoice: oid(),
  writer: oid(), freeMine: oid(), freeOther: oid(), freeMine2: oid(), freeOtherForPriya: oid(),
};
const INV = { mixed: oid(), other: oid(), imported: oid(), generatedByMe: oid(), writer: oid() };
const CN = { priyaOnMixed: oid(), priyaOnOther: oid(), chiragOnOther: oid() };

function booking(_id: any, ref: string, creator: Who | null, bookedBy: Who, extra: Record<string, any> = {}) {
  return {
    _id, bookingRef: ref, workspaceId: CUST, type: "FLIGHT", source: "MANUAL", status: "INVOICED",
    bookingDate: new Date("2026-08-20"), travelDate: new Date("2026-09-20"), sector: "DEL-BOM",
    itinerary: { origin: "Delhi", destination: "Mumbai", airline: "IndiGo", flightNo: "6E 1" },
    passengers: [{ name: "Asha Rao", type: "ADULT" }],
    pricing: { actualPrice: 9000, quotedPrice: 10000, gstMode: "ON_MARKUP", gstPercent: 18, currency: "INR" },
    supplierName: "IndiGo", isActive: true, bookedBy: O(bookedBy.id),
    ...(creator ? { createdBy: creator.id, createdByEmail: creator.email } : {}),
    ...extra,
  };
}

function line(ref: string, description: string, amount: number) {
  return { bookingRef: ref, rowType: "COST", description, subDescription: "", qty: 1, rate: amount, igst: 0, amount, passengerNames: [], type: "FLIGHT" };
}

function invoice(_id: any, no: string, bookingIds: any[], lines: any[], createdBy: Who) {
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return {
    _id, invoiceNo: no, workspaceId: CWS, status: "SENT", bookingIds, lineItems: lines,
    subtotal: total, totalGST: 0, grandTotal: total, supplyType: "IGST",
    invoiceDate: new Date("2026-09-01T00:00:00.000Z"), generatedAt: new Date("2026-09-01T00:00:00.000Z"),
    issuerDetails: { companyName: "Plumtrips", gstin: "" }, clientDetails: { companyName: "Acme Pvt Ltd" },
    createdBy: O(createdBy.id), updatedAt: new Date(),
  };
}

function creditNote(_id: any, no: string, inv: any, invNo: string, lineRef: string, createdBy: Who, status = "DRAFT") {
  return {
    _id, creditNoteNo: no, status, workspaceId: CWS, originalInvoiceId: inv, originalInvoiceNo: invNo,
    originalInvoiceDate: new Date("2026-09-01T00:00:00.000Z"), originalInvoiceAmount: 15000, creditNoteDate: new Date(),
    reasonId: REASON, reasonText: "Flight cancelled", serviceCategory: "FLIGHT", gstReasonCode: "01", gstReasonText: "Sales Return",
    isFullCredit: false, lineItems: [{ ...line(lineRef, "Seeded line", 500), originalAmount: 5000, creditedAmount: 500 }],
    subtotal: 500, totalGST: 0, grandTotal: 500, supplyType: "IGST",
    clientDetails: { companyName: "Acme Pvt Ltd" }, issuerDetails: { companyName: "Plumtrips" },
    createdBy: O(createdBy.id), generatedAt: new Date(), updatedAt: new Date(),
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  ({ default: app } = await import("./server.js"));
  ({ UserPermission } = await import("./models/UserPermission.js"));
  await mongoose.connect(mongod.getUri());

  await col("customerworkspaces").insertMany([
    { _id: O(HOUSE), customerId: "6a4e0d2ea90c293c9e129f48", companyName: "Plumtrips", status: "ACTIVE", config: { features: {} } },
    { _id: CWS, customerId: String(CUST), companyName: "Acme", status: "ACTIVE", config: { features: { invoicesEnabled: true } } },
  ] as any);
  await col("customers").insertOne({
    _id: CUST, name: "Acme", legalName: "Acme Pvt Ltd", gstRegisteredState: "Maharashtra",
    address: { street: "1 Main Rd", city: "Mumbai", state: "Maharashtra", country: "India", pincode: "400001" },
  } as any);
  await col("creditnotereasons").insertOne({
    _id: REASON, category: "FLIGHT", reason: "Flight cancelled", code: "FLT_CANCEL",
    gstReasonCode: "01", gstReasonText: "Sales Return", isActive: true, displayOrder: 1,
  } as any);

  const OWN_FULL: [string, string] = ["FULL", "OWN"];
  chirag = await person({ roles: ["EMPLOYEE"], first: "Chirag", last: "Mehta",
    grants: { invoices: OWN_FULL, creditnotes: OWN_FULL, manualBookings: OWN_FULL } });
  writer = await person({ roles: ["EMPLOYEE"], first: "Wasim", last: "Khan",
    grants: { invoices: ["WRITE", "OWN"], creditnotes: ["WRITE", "OWN"] } });
  priya = await person({ roles: ["EMPLOYEE"], first: "Priya", last: "Sharma",
    grants: { invoices: ["FULL", "ALL"], creditnotes: ["FULL", "ALL"], manualBookings: ["FULL", "ALL"] } });
  superAdmin = await person({ roles: ["SUPERADMIN"], first: "Imran", last: "Ali", grants: {} });

  await col("manualbookings").insertMany([
    booking(B.mine, "MB-MINE", chirag, chirag),
    booking(B.other, "MB-OTHER", priya, priya),
    booking(B.otherOnly, "MB-OTHER2", priya, priya),
    booking(B.imported, "MB-IMP", null, chirag), // import-from-SBT shape: bookedBy only
    booking(B.onMyInvoice, "MB-OTHER3", priya, priya),
    booking(B.writer, "MB-W", writer, writer),
    booking(B.freeMine, "MB-FREE1", chirag, chirag, { status: "CONFIRMED" }),
    booking(B.freeMine2, "MB-FREE3", chirag, chirag, { status: "CONFIRMED" }),
    booking(B.freeOther, "MB-FREE2", priya, priya, { status: "CONFIRMED" }),
    booking(B.freeOtherForPriya, "MB-FREE4", priya, priya, { status: "CONFIRMED" }),
  ] as any);
  await col("invoices").insertMany([
    invoice(INV.mixed, "INV-TEST-MIXED", [B.mine, B.other], [line("MB-MINE", "Flight mine", 10000), line("MB-OTHER", "Flight other", 5000)], priya),
    invoice(INV.other, "INV-TEST-OTHER", [B.otherOnly], [line("MB-OTHER2", "Flight other only", 5000)], priya),
    invoice(INV.imported, "INV-TEST-IMPORTED", [B.imported], [line("MB-IMP", "Flight imported", 4000)], priya),
    invoice(INV.generatedByMe, "INV-TEST-GENBYME", [B.onMyInvoice], [line("MB-OTHER3", "Flight on my invoice", 3000)], chirag),
    invoice(INV.writer, "INV-TEST-WRITER", [B.writer], [line("MB-W", "Flight writer", 2000)], priya),
  ] as any);
  await col("creditnotes").insertMany([
    creditNote(CN.priyaOnMixed, "CN-TEST-P-MIXED", INV.mixed, "INV-TEST-MIXED", "MB-OTHER", priya),
    creditNote(CN.priyaOnOther, "CN-TEST-P-OTHER", INV.other, "INV-TEST-OTHER", "MB-OTHER2", priya),
    creditNote(CN.chiragOnOther, "CN-TEST-C-OTHER", INV.other, "INV-TEST-OTHER", "MB-OTHER2", chirag),
  ] as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const invNos = (docs: any[]) => docs.map((d) => d.invoiceNo).sort();
const MINE_INVOICES = ["INV-TEST-GENBYME", "INV-TEST-IMPORTED", "INV-TEST-MIXED"];
const ALL_INVOICES = ["INV-TEST-GENBYME", "INV-TEST-IMPORTED", "INV-TEST-MIXED", "INV-TEST-OTHER", "INV-TEST-WRITER"];

describe("Invoices — scope OWN sees only invoices with a booking they created, or that they generated", () => {
  it("list", async () => {
    const res = await get(chirag, "/api/admin/invoices?limit=50");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(invNos(res.body.docs)).toEqual(MINE_INVOICES);
    expect(res.body.total).toBe(3);
  });
  it("export", async () => {
    const res = await get(chirag, "/api/admin/invoices/export?format=csv");
    expect(res.status).toBe(200);
    for (const no of MINE_INVOICES) expect(res.text).toContain(no);
    expect(res.text).not.toContain("INV-TEST-OTHER");
    expect(res.text).not.toContain("INV-TEST-WRITER");
  });
  it("activity", async () => {
    const res = await get(chirag, "/api/admin/invoices/activity");
    expect(res.status).toBe(200);
    expect(invNos(res.body)).toEqual(MINE_INVOICES);
  });
  it("detail: own → 200; others' → 404 (detail, PDF, credit-note panel)", async () => {
    expect((await get(chirag, `/api/admin/invoices/${INV.mixed}`)).status).toBe(200);
    expect((await get(chirag, `/api/admin/invoices/${INV.generatedByMe}`)).status).toBe(200);
    expect((await get(chirag, `/api/admin/invoices/${INV.other}`)).status).toBe(404);
    expect((await post(chirag, `/api/admin/invoices/${INV.other}/pdf`)).status).toBe(404);
    expect((await get(chirag, `/api/admin/invoices/${INV.other}/credit-notes`)).status).toBe(404);
  });
  it("bulk mark leaves others' invoices untouched as 'not found'", async () => {
    const res = await post(chirag, "/api/admin/invoices/bulk-mark-paid", { ids: [String(INV.other)], paidAt: "2026-10-01" });
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
    expect(res.body.blocked).toEqual([{ id: String(INV.other), reason: "not found" }]);
    expect((await col("invoices").findOne({ _id: INV.other }))!.status).toBe("SENT");
  });
});

describe("Invoices — generating from others' bookings is refused", () => {
  it("eligible bookings offers only their own", async () => {
    const res = await get(chirag, `/api/admin/invoices/${INV.mixed}/eligible-bookings`);
    expect(res.status).toBe(200);
    const refs = res.body.eligible.map((b: any) => b.bookingRef);
    expect(refs).toContain("MB-FREE1");
    expect(refs).not.toContain("MB-FREE2");
  });
  it("generate / bulk-generate with someone else's booking → 403 naming it", async () => {
    for (const p of ["/api/admin/invoices/generate", "/api/admin/invoices/bulk-generate"]) {
      const res = await post(chirag, p, { bookingIds: [String(B.freeMine), String(B.freeOther)] });
      expect(res.status, `${p}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.code).toBe("NOT_YOUR_BOOKINGS");
      expect(res.body.error).toContain("MB-FREE2");
    }
    expect((await col("manualbookings").findOne({ _id: B.freeMine }))!.status).toBe("CONFIRMED");
  });
  it("adding someone else's booking to an invoice → 403", async () => {
    const res = await post(chirag, `/api/admin/invoices/${INV.mixed}/add-bookings`, { bookingIds: [String(B.freeOther)] });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe("NOT_YOUR_BOOKINGS");
  });
  it("generate from their own booking goes through", async () => {
    const res = await post(chirag, "/api/admin/invoices/generate", { bookingIds: [String(B.freeMine2)], invoiceDate: "2026-10-01" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await col("manualbookings").findOne({ _id: B.freeMine2 }))!.status).toBe("INVOICED");
  });
});

describe("Credit notes — scope OWN", () => {
  it("list shows notes on their invoices plus notes they created", async () => {
    const res = await get(chirag, "/api/admin/credit-notes?pageSize=100");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const nos = res.body.items.map((c: any) => c.creditNoteNo);
    expect(nos).toContain("CN-TEST-P-MIXED");
    expect(nos).toContain("CN-TEST-C-OTHER");
    expect(nos).not.toContain("CN-TEST-P-OTHER");
  });
  it("export and by-id reads hide the rest (404)", async () => {
    const exp = await get(chirag, "/api/admin/credit-notes/export?format=csv");
    expect(exp.status).toBe(200);
    expect(exp.text).not.toContain("CN-TEST-P-OTHER");
    expect((await get(chirag, `/api/admin/credit-notes/${CN.priyaOnOther}`)).status).toBe(404);
    expect((await get(chirag, `/api/admin/credit-notes/${CN.priyaOnOther}/pdf`)).status).toBe(404);
    expect((await get(chirag, `/api/admin/credit-notes/${CN.priyaOnMixed}`)).status).toBe(200);
  });
  it("line ownership for the credit-note modal names who booked each line", async () => {
    const res = await get(chirag, `/api/admin/credit-notes/invoice/${INV.mixed}/lines`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.restricted).toBe(true);
    expect(res.body.lines).toEqual([
      { mine: true, bookedBy: "" },
      { mine: false, bookedBy: "Priya Sharma" },
    ]);
    const all = await get(priya, `/api/admin/credit-notes/invoice/${INV.mixed}/lines`);
    expect(all.body.restricted).toBe(false);
  });
  it("credit on their own line → created; on someone else's line or full credit → 403 'Booked by … — ask finance'", async () => {
    const base = { originalInvoiceId: String(INV.mixed), reasonId: String(REASON), isFullCredit: false };
    const ownLine = { bookingRef: "MB-MINE", rowType: "COST", description: "Flight mine", creditedAmount: 1000 };
    const otherLine = { bookingRef: "MB-OTHER", rowType: "COST", description: "Flight other", creditedAmount: 1000 };

    const bad = await post(chirag, "/api/admin/credit-notes", { ...base, lineItems: [otherLine] });
    expect(bad.status, JSON.stringify(bad.body)).toBe(403);
    expect(bad.body.error).toContain("Booked by Priya Sharma — ask finance");

    const mixedLines = await post(chirag, "/api/admin/credit-notes/preview", { ...base, lineItems: [ownLine, otherLine] });
    expect(mixedLines.status).toBe(403);

    const full = await post(chirag, "/api/admin/credit-notes", { ...base, isFullCredit: true });
    expect(full.status, JSON.stringify(full.body)).toBe(403);

    const ok = await post(chirag, "/api/admin/credit-notes", { ...base, lineItems: [ownLine] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);

    // OWN + FULL issues on the spot.
    const issued = await post(chirag, `/api/admin/credit-notes/${ok.body.creditNote._id}/issue`);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.creditNote.status).toBe("ISSUED");
  });
  it("credit on an invoice that is not theirs → 404", async () => {
    const res = await post(chirag, "/api/admin/credit-notes", {
      originalInvoiceId: String(INV.other), reasonId: String(REASON), isFullCredit: false,
      lineItems: [{ bookingRef: "MB-OTHER2", rowType: "COST", description: "Flight other only", creditedAmount: 100 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });
  it("a visible draft covering someone else's lines cannot be issued or edited by them", async () => {
    const iss = await post(chirag, `/api/admin/credit-notes/${CN.priyaOnMixed}/issue`);
    expect(iss.status, JSON.stringify(iss.body)).toBe(403);
    const ed = await patch(chirag, `/api/admin/credit-notes/${CN.priyaOnMixed}`, { notes: "x" });
    expect(ed.status, JSON.stringify(ed.body)).toBe(403);
  });
  it("OWN + WRITE drafts on their own line but cannot issue", async () => {
    const res = await post(writer, "/api/admin/credit-notes", {
      originalInvoiceId: String(INV.writer), reasonId: String(REASON), isFullCredit: false,
      lineItems: [{ bookingRef: "MB-W", rowType: "COST", description: "Flight writer", creditedAmount: 200 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const iss = await post(writer, `/api/admin/credit-notes/${res.body.creditNote._id}/issue`);
    expect(iss.status).toBe(403);
    expect(iss.body.message).toBe("Insufficient access level");
  });
});

describe("Scope ALL and Super Admin unchanged", () => {
  it("ALL sees every invoice and credit note", async () => {
    const res = await get(priya, "/api/admin/invoices?limit=50");
    expect(res.status).toBe(200);
    for (const no of ALL_INVOICES) expect(invNos(res.body.docs)).toContain(no);
    const cn = await get(priya, "/api/admin/credit-notes?pageSize=100");
    expect(cn.body.items.map((c: any) => c.creditNoteNo)).toContain("CN-TEST-P-OTHER");
    expect((await get(priya, `/api/admin/invoices/${INV.other}`)).status).toBe(200);
  });
  it("ALL may credit any line and generate from anyone's booking", async () => {
    const cn = await post(priya, "/api/admin/credit-notes/preview", {
      originalInvoiceId: String(INV.mixed), reasonId: String(REASON), isFullCredit: false,
      lineItems: [{ bookingRef: "MB-MINE", rowType: "COST", description: "Flight mine", creditedAmount: 100 }],
    });
    expect(cn.status, JSON.stringify(cn.body)).toBe(200);
    const gen = await post(priya, "/api/admin/invoices/generate", { bookingIds: [String(B.freeOtherForPriya)], invoiceDate: "2026-10-01" });
    expect(gen.status, JSON.stringify(gen.body)).toBe(201);
  });
  it("Super Admin sees everything and keeps the override", async () => {
    const res = await get(superAdmin, "/api/admin/invoices?limit=50");
    for (const no of ALL_INVOICES) expect(invNos(res.body.docs)).toContain(no);
    expect((await get(superAdmin, `/api/admin/credit-notes/${CN.priyaOnOther}`)).status).toBe(200);
    const ov = await post(superAdmin, `/api/admin/credit-notes/${CN.priyaOnOther}/override`, { reason: "test", changes: { notes: "override ok" } });
    expect(ov.status, JSON.stringify(ov.body)).toBe(200);
  });
});

describe("Manual Bookings already honours OWN (createdBy)", () => {
  it("chirag's list shows his bookings, not Priya's", async () => {
    const res = await get(chirag, "/api/admin/manual-bookings?limit=100");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body.docs ?? res.body.bookings ?? res.body.items ?? [];
    const refs = rows.map((b: any) => b.bookingRef);
    expect(refs).toContain("MB-MINE");
    expect(refs).not.toContain("MB-OTHER");
  });
});
