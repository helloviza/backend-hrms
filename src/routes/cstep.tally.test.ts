// apps/backend/src/routes/cstep.tally.test.ts
//
// CSTEP Finance "Export to Tally" — routes/cstep.tally.ts, plus the vendor
// invoice no. now captured on mark-paid (routes/cstep.ts) and the TALLY
// series (utils/cstepSequence.ts). Paid vendor lines across vendor types →
// Dr/Cr pairs sharing one voucher number, the mapped expense ledger (or the
// default for an unmapped type), amounts / narration / bill-wise fields, the
// "Upload" sheet with its 25 headers in order and real date cells, a paidAt
// range, stable voucher numbers on re-export, and Finance/Admin-only access.
//
// Real: cstep + tally routers, models, sheetImport, sequence engine,
//   in-memory Mongo REPLICA SET (voucher numbers are taken in a
//   transaction) on a fresh database, cstep_qc_tally.
// Stubbed: S3, mail, PDF helpers, auth (x-test-user) and the workspace
//   resolver (x-test-ws).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_tally";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return {};
    }
  },
  PutObjectCommand: class {
    constructor(public input: any) {}
  },
  GetObjectCommand: class {
    constructor(public input: any) {}
  },
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async (args: any) => ({ key: `${args.keyPrefix}/qc` })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({ key: "qc-packet" })) }));

const { default: cstepRouter } = await import("./cstep.js");
const { default: tallyRouter, TALLY_COLUMNS } = await import("./cstep.tally.js");

const DB = "cstep_qc_tally";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const U = { travA: oid(), travB: oid(), finA: oid(), finB: oid(), admin: oid(), plain: oid() };
const TP = { a: oid(), b: oid() };
const VT = { air: oid(), hotel: oid(), venue: oid() };
const V = { sky: oid(), lake: oid(), hall: oid() };
const R = { tour: oid(), event: oid(), tourB: oid() };
const L = { flight: oid(), hotel: oid(), hotelSept: oid(), hall: oid(), hotelB: oid() };

const fakeAuth = (req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceObjectId = new mongoose.Types.ObjectId(String(req.headers["x-test-ws"] || WS));
  next();
};
const app = express();
app.use(express.json());
app.use("/api/cstep/tally", fakeAuth, tallyRouter);
app.use("/api/cstep", fakeAuth, cstepRouter);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = { finA: who(U.finA), finB: who(U.finB), admin: who(U.admin, ["ADMIN"]), plain: who(U.plain) };
const send = (method: "get" | "put" | "patch", as: any, path: string, body?: any) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS));
  return body === undefined ? r : r.send(body);
};
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const exportSheet = (as: any, from: string, to: string) =>
  request(app)
    .get(`/api/cstep/tally/export?from=${from}&to=${to}`)
    .set("x-test-user", JSON.stringify(as))
    .set("x-test-ws", String(WS))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
async function readSheet(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0];
  const rows: any[][] = [];
  ws.eachRow((row, n) => n > 1 && rows.push(Array.from({ length: 25 }, (_, i) => row.getCell(i + 1).value ?? "")));
  return { wb, ws, rows };
}
const pay = (as: any, req: any, line: any, body: any) => send("patch", as, `/requests/${req}/arrangements/${line}/payment`, body);

const MMYY = (() => {
  const d = new Date(Date.now() + 330 * 60 * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
})();
const REF = { tour: `0001/${MMYY}`, event: `EVR0001/${MMYY}`, tourB: `0002/${MMYY}` };
const ymd = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri(DB);

  // Step 0 gate: a local server and an empty database, or nothing is seeded.
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  const existing = await mongoose.connection.db!.listCollections().toArray();
  if (existing.length) throw new Error(`Step 0: refusing to seed — ${DB} is not empty (${existing.length} collections)`);

  await mongoose.connection.syncIndexes();

  const now = new Date();
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertMany([
    { _id: TP.a, workspaceId: WS, travelerId: "E-001", firstName: "Asha", lastName: "Rao", isActive: true, claimedBy: U.travA, financeUserId: U.finA },
    { _id: TP.b, workspaceId: WS, travelerId: "E-002", firstName: "Ravi", lastName: "Kumar", isActive: true, claimedBy: U.travB, financeUserId: U.finB },
  ] as any[]);
  await col("cstepvendortypes").insertMany([
    { _id: VT.air, workspaceId: WS, name: "Airline", isActive: true },
    { _id: VT.hotel, workspaceId: WS, name: "Hotel", isActive: true },
    { _id: VT.venue, workspaceId: WS, name: "Venue", isActive: true },
  ] as any[]);
  const vendor = (_id: any, vendorCode: string, name: string, vendorTypeId: any) => ({ _id, workspaceId: WS, vendorCode, name, vendorTypeId, isActive: true, createdAt: now, updatedAt: now });
  await col("cstepvendors").insertMany([
    vendor(V.sky, "CSTEPVEN0001", "Skyline Travels", VT.air),
    vendor(V.lake, "CSTEPVEN0002", "Hotel Lakeview", VT.hotel),
    vendor(V.hall, "CSTEPVEN0003", "Lakeside Convention Hall", VT.venue),
  ] as any[]);

  const reqDoc = (_id: any, formType: string, ref: string, tp: any, project?: string) => ({
    _id, workspaceId: WS, travelerProfileId: tp, createdBy: U.travA, formType, purpose: `QC ${ref}`,
    departureDate: "2026-11-10", returnDate: "2026-11-12", status: "ARRANGED", claimReference: ref,
    ...(project ? { project } : {}), createdAt: now, updatedAt: now,
  });
  await col("csteptravelrequests").insertMany([
    reqDoc(R.tour, "TOUR_PROPOSAL", REF.tour, TP.a, "PRJ-ENERGY"),
    reqDoc(R.event, "EVENT_REQUEST", REF.event, TP.a),
    reqDoc(R.tourB, "TOUR_PROPOSAL", REF.tourB, TP.b, "PRJ-SOLAR"),
  ] as any[]);
  const vendors: any[] = await col("cstepvendors").find({}).toArray();
  const line = (_id: any, requestId: any, arrangedType: string, vendorId: any, amount: number) => {
    const v = vendors.find((x) => String(x._id) === String(vendorId));
    return {
      _id, workspaceId: WS, requestId, source: "ADDED", arrangedType, status: "ARRANGED", currency: "INR", amount,
      exchangeRate: 1, amountInr: amount, vendorId, vendorCode: v.vendorCode, vendorName: v.name, paymentStatus: "UNPAID",
      createdBy: U.admin, createdAt: now, updatedAt: now,
    };
  };
  await col("csteparrangements").insertMany([
    line(L.flight, R.tour, "FLIGHT", V.sky, 11850),
    line(L.hotel, R.tour, "HOTEL", V.lake, 9600),
    line(L.hotelSept, R.tour, "HOTEL", V.lake, 1200),
    line(L.hall, R.event, "OTHER", V.hall, 24000),
    line(L.hotelB, R.tourB, "HOTEL", V.lake, 5000),
  ] as any[]);

  // Payments through the real mark-paid route.
  ok(await pay(ACT.finA, R.tour, L.flight, { paymentStatus: "PAID", paymentRef: "UTR111", vendorInvoiceNo: " INV-AIR-9 ", paidAt: "2026-10-10" }));
  ok(await pay(ACT.finA, R.tour, L.hotel, { paymentStatus: "PAID", paymentRef: "UTR222", paidAt: "2026-10-12" }));
  ok(await pay(ACT.finA, R.tour, L.hotelSept, { paymentStatus: "PAID", paymentRef: "UTR000", paidAt: "2026-09-20" }));
  ok(await pay(ACT.finA, R.event, L.hall, { paymentStatus: "PAID", paymentRef: "UTR333", paidAt: "2026-10-14" }));
  ok(await pay(ACT.finB, R.tourB, L.hotelB, { paymentStatus: "PAID", paymentRef: "UTR444", paidAt: "2026-10-11" }));
}, 240_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("vendor invoice no. on mark-paid", () => {
  it("is stored trimmed, logged, and cleared by Mark unpaid", async () => {
    const l: any = await col("csteparrangements").findOne({ _id: L.flight });
    expect(l.vendorInvoiceNo).toBe("INV-AIR-9");
    const entry: any = await col("cstepapprovals").findOne({ entityId: R.tour, action: "VENDOR_PAYMENT", comment: /INV-AIR-9/ });
    expect(entry.comment).toContain("| Ref: UTR111 | Invoice: INV-AIR-9 | Paid on 2026-10-10");

    ok(await pay(ACT.finA, R.tour, L.flight, { paymentStatus: "UNPAID" }));
    expect(((await col("csteparrangements").findOne({ _id: L.flight })) as any).vendorInvoiceNo).toBeUndefined();
    ok(await pay(ACT.finA, R.tour, L.flight, { paymentStatus: "PAID", paymentRef: "UTR111", vendorInvoiceNo: "INV-AIR-9", paidAt: "2026-10-10" }));
  });
});

describe("Tally settings — CSTEP Admin only", () => {
  it("Finance and plain users are refused; Admin reads the defaults and the next voucher no.", async () => {
    expect((await send("get", ACT.finA, "/tally/settings")).status).toBe(403);
    expect((await send("put", ACT.finA, "/tally/settings", { companyName: "X" })).status).toBe(403);
    expect((await send("get", ACT.plain, "/tally/settings")).status).toBe(403);
    const r = ok(await send("get", ACT.admin, "/tally/settings")).body;
    expect(r.settings).toEqual({ companyName: "", voucherType: "Journal", defaultLedger: "", ledgerMap: [] });
    expect(r.vendorTypes.map((t: any) => t.name)).toEqual(["Airline", "Hotel", "Venue"]);
    expect(r.nextVoucherNo).toBe(1);
  });

  it("an unmapped type with no default ledger blocks the export, and no voucher no. is taken", async () => {
    ok(await send("put", ACT.admin, "/tally/settings", {
      companyName: "CSTEP", ledgerMap: [{ vendorTypeId: String(VT.air), ledger: "Air Travel Expenses" }, { vendorTypeId: String(VT.hotel), ledger: "Hotel & Lodging" }],
    }));
    const r = await exportSheet(ACT.admin, "2026-10-01", "2026-10-31");
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body.toString()).unmappedTypes).toEqual(["Venue"]);
    expect(await col("csteparrangements").countDocuments({ tallyVoucherNo: { $exists: true } })).toBe(0);
    expect(await col("counters").countDocuments({ _id: `cstep:${WS}:TALLY` } as any)).toBe(0);
  });

  it("saves the default ledger; a bad vendor type is 400; TALLY start is settable", async () => {
    expect((await send("put", ACT.admin, "/tally/settings", { ledgerMap: [{ vendorTypeId: String(oid()), ledger: "X" }] })).status).toBe(400);
    const saved = ok(await send("put", ACT.admin, "/tally/settings", {
      companyName: "  CSTEP  ", voucherType: "", defaultLedger: "Travel Expenses - Misc",
      ledgerMap: [
        { vendorTypeId: String(VT.air), ledger: "Air Travel Expenses" },
        { vendorTypeId: String(VT.hotel), ledger: "Hotel & Lodging" },
        { vendorTypeId: String(VT.venue), ledger: "  " }, // blank = unmapped
      ],
    })).body.settings;
    expect(saved).toMatchObject({ companyName: "CSTEP", voucherType: "Journal", defaultLedger: "Travel Expenses - Misc" });
    expect(saved.ledgerMap).toHaveLength(2);

    expect(ok(await send("put", ACT.admin, "/sequences/TALLY", { startNumber: 101 })).body).toMatchObject({ series: "TALLY", next: 101, fyStartYear: null });
    const seq = ok(await send("get", ACT.admin, "/sequences")).body.series.find((s: any) => s.series === "TALLY");
    expect(seq).toEqual({ series: "TALLY", next: 101, fyStartYear: null });
  });
});

describe("GET /tally/export", () => {
  let first: any[][];

  it("is open to Finance and Admin only, and needs a valid range", async () => {
    expect((await exportSheet(ACT.plain, "2026-10-01", "2026-10-31")).status).toBe(403);
    expect((await exportSheet(ACT.finA, "2026-10-31", "2026-10-01")).status).toBe(400);
    expect((await exportSheet(ACT.finA, "2026-10", "2026-10-31")).status).toBe(400);
    expect((await exportSheet(ACT.finA, "2026-08-01", "2026-08-31")).status).toBe(404);
  });

  it("Finance A: sheet Upload, the 25 headers in order, a Dr/Cr pair per paid line in the range", async () => {
    const r = await exportSheet(ACT.finA, "2026-10-01", "2026-10-31");
    expect(r.status).toBe(200);
    const { wb, ws, rows } = await readSheet(r.body);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Upload"]);
    expect((ws.getRow(1).values as any[]).slice(1)).toEqual(TALLY_COLUMNS);
    expect(TALLY_COLUMNS).toEqual([
      "Company Name", "Voucher Type", "Voucher Number", "Voucher Date", "Ledger Name", "Dr/Cr", "Projects", "Project CC",
      "Department", "Employee Name", "Test Department", "Test Department CC", "Locations ", "Location CC", "Amount", "Narration",
      "Bill Type", "Bill No", "Bill Due Date", "Bill Amount", "Dr/Cr", "Inst No", "Inst Date",
      "Type of Transfer (e-Fund Transfer, Cheque)", "Transfer Mode (NEFT/RTGS)",
    ]);
    // Traveller B's line (Finance B's) and the September payment are out.
    expect(rows).toHaveLength(6);
    first = rows;

    // Voucher numbers from the TALLY series in paid-on order, shared by each pair.
    expect(rows.map((x) => x[2])).toEqual(["101", "101", "102", "102", "103", "103"]);
    expect(rows.map((x) => x[5])).toEqual(["Dr", "Cr", "Dr", "Cr", "Dr", "Cr"]);
    for (const x of rows) {
      expect(x[0]).toBe("CSTEP");
      expect(x[1]).toBe("Journal");
      expect(x[3]).toBeInstanceOf(Date); // a real date cell
      for (const i of [8, 9, 10, 11, 12, 13, 23, 24]) expect(x[i]).toBe("");
    }

    const [fDr, fCr, hDr, hCr, vDr, vCr] = rows;
    // Flight — Airline → mapped ledger; invoice no. as the bill.
    expect(ymd(fDr[3])).toBe("2026-10-10");
    expect(fDr.slice(4, 8)).toEqual(["Air Travel Expenses", "Dr", "Projects", "PRJ-ENERGY"]);
    expect(fDr[14]).toBe(11850);
    expect(fDr[15]).toBe(`Being Flight for Asha Rao ${REF.tour}`);
    expect(fDr.slice(16, 23)).toEqual(["", "", "", "", "", "", ""]);
    expect(fCr.slice(4, 8)).toEqual(["Skyline Travels", "Cr", "Projects", "PRJ-ENERGY"]);
    expect(fCr[14]).toBe(11850);
    expect(fCr[15]).toBe("");
    expect(fCr.slice(16, 22)).toEqual(["New ref", "INV-AIR-9", "", 11850, "Cr", "UTR111"]);
    expect(ymd(fCr[22])).toBe("2026-10-10");

    // Hotel — mapped ledger; no invoice no. → the payment ref is the bill no.
    expect(hDr.slice(4, 6)).toEqual(["Hotel & Lodging", "Dr"]);
    expect(hDr[14]).toBe(9600);
    expect(hDr[15]).toBe(`Being Hotel for Asha Rao ${REF.tour}`);
    expect(hCr.slice(16, 22)).toEqual(["New ref", "UTR222", "", 9600, "Cr", "UTR222"]);

    // Venue (Event) — unmapped type → default ledger; no project → blank cost centre.
    expect(vDr.slice(4, 8)).toEqual(["Travel Expenses - Misc", "Dr", "", ""]);
    expect(vDr[14]).toBe(24000);
    expect(vDr[15]).toBe(`Being Venue for Asha Rao ${REF.event}`);
    expect(vCr.slice(4, 6)).toEqual(["Lakeside Convention Hall", "Cr"]);
    expect(ymd(vCr[22])).toBe("2026-10-14");
  });

  it("formats: dates dd-mm-yyyy, reference / bill columns text", async () => {
    const { ws } = await readSheet((await exportSheet(ACT.finA, "2026-10-01", "2026-10-31")).body);
    expect(ws.getCell("D2").numFmt).toBe("dd-mm-yyyy");
    expect(ws.getCell("W3").numFmt).toBe("dd-mm-yyyy");
    for (const c of ["C2", "H2", "R3", "V3"]) expect(ws.getCell(c).numFmt).toBe("@");
  });

  it("re-export keeps the voucher numbers; Admin sees everyone and B's line takes the next one", async () => {
    const again = (await readSheet((await exportSheet(ACT.finA, "2026-10-01", "2026-10-31")).body)).rows;
    expect(again.map((x) => x[2])).toEqual(first.map((x) => x[2]));

    const all = (await readSheet((await exportSheet(ACT.admin, "2026-10-01", "2026-10-31")).body)).rows;
    expect(all).toHaveLength(8);
    expect(all.map((x) => x[2])).toEqual(["101", "101", "102", "102", "103", "103", "104", "104"]);
    expect(all[6].slice(4, 8)).toEqual(["Hotel & Lodging", "Dr", "Projects", "PRJ-SOLAR"]);
    expect(all[6][15]).toBe(`Being Hotel for Ravi Kumar ${REF.tourB}`);
    expect(await col("csteparrangements").countDocuments({ tallyVoucherNo: { $exists: true } })).toBe(4);
    expect(ok(await send("get", ACT.admin, "/tally/settings")).body.nextVoucherNo).toBe(105);
  });

  it("the paid-on range is by IST date and inclusive", async () => {
    const r = (await readSheet((await exportSheet(ACT.finA, "2026-10-12", "2026-10-12")).body)).rows;
    expect(r.map((x) => x[2])).toEqual(["102", "102"]);
  });
});
