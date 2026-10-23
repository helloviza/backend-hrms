// apps/backend/src/routes/cstep.tally.test.ts
//
// CSTEP Finance "Export to Tally" — routes/cstep.tally.ts, plus the vendor
// invoice no. captured on mark-paid and the amount a line must carry before
// it is paid (routes/cstep.ts), and the TALLY series (utils/cstepSequence.ts).
// Paid vendor lines across vendor types → Dr/Cr pairs sharing one voucher
// number, the mapped expense ledger (or the default for an unmapped type),
// amounts / narration / bill-wise fields, the Dr row's cost centres
// (department, employee, the Locations label + the mapped code or the raw
// location, from the traveller's base or the trip's destination), no
// instrument columns, the "Upload" sheet with its 25 headers in order and
// real date cells, a paidAt range, stable voucher numbers on re-export,
// Finance/Admin-only access, and the 409s — no company name, an unmapped
// type, a paid line with no amount — that number nothing.
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
const DEPT = oid();
const VT = { air: oid(), hotel: oid(), venue: oid() };
const V = { sky: oid(), lake: oid(), hall: oid() };
const R = { tour: oid(), event: oid(), tourB: oid() };
const L = { flight: oid(), hotel: oid(), hotelSept: oid(), hall: oid(), hotelB: oid(), cabNoAmount: oid(), usdNoRate: oid(), legacy: oid() };

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
const exportJson = async (as: any, from: string, to: string) => {
  const r = await exportSheet(as, from, to);
  return { status: r.status, body: JSON.parse(r.body.toString()) };
};
async function readSheet(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0];
  const rows: any[][] = [];
  ws.eachRow((row, n) => n > 1 && rows.push(Array.from({ length: 25 }, (_, i) => row.getCell(i + 1).value ?? "")));
  return { wb, ws, rows };
}
const pay = (as: any, req: any, line: any, body: any) => send("patch", as, `/requests/${req}/arrangements/${line}/payment`, body);
const setMissingAmount = (as: any, req: any, line: any, body: any) => send("patch", as, `/requests/${req}/arrangements/${line}/missing-amount`, body);

const MMYY = (() => {
  const d = new Date(Date.now() + 330 * 60 * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
})();
const REF = { tour: `0001/${MMYY}`, event: `EVR0001/${MMYY}`, tourB: `0002/${MMYY}` };
const ymd = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

const SETTINGS = {
  companyName: "CSTEP",
  defaultLedger: "Travel Expenses - Misc",
  ledgerMap: [
    { vendorTypeId: String(VT.air), ledger: "Air Travel Expenses" },
    { vendorTypeId: String(VT.hotel), ledger: "Hotel & Lodging" },
  ],
  locationMap: [{ location: "bengaluru ", code: "BLR-HQ" }],
};

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
  await col("departments").insertOne({ _id: DEPT, workspaceId: WS, name: "Energy Research", isActive: true } as any);
  await col("travellerprofiles").insertMany([
    { _id: TP.a, workspaceId: WS, travelerId: "E-001", firstName: "Asha", lastName: "Rao", isActive: true, claimedBy: U.travA, financeUserId: U.finA, departmentId: DEPT, workLocation: "Bengaluru" },
    { _id: TP.b, workspaceId: WS, travelerId: "E-002", firstName: "Ravi", lastName: "Kumar", isActive: true, claimedBy: U.travB, financeUserId: U.finB, workLocation: "New Delhi" },
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

  const reqDoc = (_id: any, formType: string, ref: string, tp: any, extra: any = {}) => ({
    _id, workspaceId: WS, travelerProfileId: tp, createdBy: U.travA, formType, purpose: `QC ${ref}`,
    departureDate: "2026-11-10", returnDate: "2026-11-12", status: "ARRANGED", claimReference: ref,
    ...extra, createdAt: now, updatedAt: now,
  });
  await col("csteptravelrequests").insertMany([
    reqDoc(R.tour, "TOUR_PROPOSAL", REF.tour, TP.a, { project: "PRJ-ENERGY", type: "DOMESTIC", stations: [{ from: "Bengaluru", to: "Mumbai" }, { from: "Mumbai", to: "Pune" }] }),
    reqDoc(R.event, "EVENT_REQUEST", REF.event, TP.a, { eventLocation: "Goa" }),
    reqDoc(R.tourB, "TOUR_PROPOSAL", REF.tourB, TP.b, { project: "PRJ-SOLAR", type: "INTERNATIONAL", countries: [{ country: "Germany" }] }),
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
  const noAmount = (l: any) => {
    const { amount, exchangeRate, amountInr, ...rest } = l;
    void amount; void exchangeRate; void amountInr;
    return rest;
  };
  await col("csteparrangements").insertMany([
    line(L.flight, R.tour, "FLIGHT", V.sky, 11850),
    line(L.hotel, R.tour, "HOTEL", V.lake, 9600),
    line(L.hotelSept, R.tour, "HOTEL", V.lake, 1200),
    line(L.hall, R.event, "OTHER", V.hall, 24000),
    line(L.hotelB, R.tourB, "HOTEL", V.lake, 5000),
    // A seeded line nobody priced, and a foreign one with no rate.
    noAmount(line(L.cabNoAmount, R.tour, "CAB", V.sky, 0)),
    { ...noAmount(line(L.usdNoRate, R.tour, "HOTEL", V.lake, 0)), currency: "USD", amount: 300 },
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
  it("Finance and plain users are refused; Admin reads the defaults, the locations seen and the next voucher no.", async () => {
    expect((await send("get", ACT.finA, "/tally/settings")).status).toBe(403);
    expect((await send("put", ACT.finA, "/tally/settings", { companyName: "X" })).status).toBe(403);
    expect((await send("get", ACT.plain, "/tally/settings")).status).toBe(403);
    const r = ok(await send("get", ACT.admin, "/tally/settings")).body;
    expect(r.settings).toEqual({
      companyName: "", voucherType: "Journal", defaultLedger: "", ledgerMap: [],
      locationLabel: "Locations", locationSource: "BASE", locationMap: [],
    });
    expect(r.vendorTypes.map((t: any) => t.name)).toEqual(["Airline", "Hotel", "Venue"]);
    // Base = travellers' work locations; destination = event location, an
    // international tour's first country, a domestic tour's first station.
    expect(r.locations).toEqual({ base: ["Bengaluru", "New Delhi"], destination: ["Germany", "Goa", "Mumbai"] });
    expect(r.nextVoucherNo).toBe(1);
  });

  it("no company name blocks the export, and no voucher no. is taken", async () => {
    const r = await exportJson(ACT.admin, "2026-10-01", "2026-10-31");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ missingSettings: ["companyName"] });
    expect(r.body.error).toMatch(/Tally settings/);
    expect(await col("csteparrangements").countDocuments({ tallyVoucherNo: { $exists: true } })).toBe(0);
  });

  it("an unmapped type with no default ledger blocks the export, and no voucher no. is taken", async () => {
    ok(await send("put", ACT.admin, "/tally/settings", { companyName: "CSTEP", ledgerMap: SETTINGS.ledgerMap }));
    const r = await exportJson(ACT.admin, "2026-10-01", "2026-10-31");
    expect(r.status).toBe(409);
    expect(r.body.unmappedTypes).toEqual(["Venue"]);
    expect(await col("csteparrangements").countDocuments({ tallyVoucherNo: { $exists: true } })).toBe(0);
    expect(await col("counters").countDocuments({ _id: `cstep:${WS}:TALLY` } as any)).toBe(0);
  });

  it("saves the default ledger and the location map; bad input is 400; TALLY start is settable", async () => {
    expect((await send("put", ACT.admin, "/tally/settings", { ledgerMap: [{ vendorTypeId: String(oid()), ledger: "X" }] })).status).toBe(400);
    expect((await send("put", ACT.admin, "/tally/settings", { locationSource: "OFFICE" })).status).toBe(400);
    expect((await send("put", ACT.admin, "/tally/settings", { locationMap: "BLR" })).status).toBe(400);
    const saved = ok(await send("put", ACT.admin, "/tally/settings", {
      companyName: "  CSTEP  ", voucherType: "", defaultLedger: "Travel Expenses - Misc", locationLabel: "",
      ledgerMap: [...SETTINGS.ledgerMap, { vendorTypeId: String(VT.venue), ledger: "  " }], // blank = unmapped
      locationMap: [
        { location: " Bengaluru ", code: " BLR-HQ " },
        { location: "BENGALURU", code: "DUPLICATE" }, // same key — the first one wins
        { location: "New Delhi", code: "  " }, // blank = unmapped
      ],
    })).body.settings;
    expect(saved).toMatchObject({ companyName: "CSTEP", voucherType: "Journal", defaultLedger: "Travel Expenses - Misc", locationLabel: "Locations", locationSource: "BASE" });
    expect(saved.ledgerMap).toHaveLength(2);
    expect(saved.locationMap).toEqual([{ location: "Bengaluru", code: "BLR-HQ" }]);

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
      // Test Department / CC, Inst No / Date, transfer type / mode: always blank.
      for (const i of [10, 11, 21, 22, 23, 24]) expect(x[i]).toBe("");
    }
    // The Dr row carries the cost centres — department, employee, location
    // (Bengaluru mapped to its code); the Cr row none of them.
    for (const [dr, cr] of [[rows[0], rows[1]], [rows[2], rows[3]], [rows[4], rows[5]]]) {
      expect(dr.slice(8, 14)).toEqual(["Energy Research", "Asha Rao", "", "", "Locations", "BLR-HQ"]);
      expect(cr.slice(8, 14)).toEqual(["", "", "", "", "", ""]);
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
    // Bill-wise New ref with the invoice no.; no instrument (Inst No / Date).
    expect(fCr.slice(16, 23)).toEqual(["New ref", "INV-AIR-9", "", 11850, "Cr", "", ""]);

    // Hotel — mapped ledger; no invoice no. → a blank bill no. (never the UTR).
    expect(hDr.slice(4, 6)).toEqual(["Hotel & Lodging", "Dr"]);
    expect(hDr[14]).toBe(9600);
    expect(hDr[15]).toBe(`Being Hotel for Asha Rao ${REF.tour}`);
    expect(hCr.slice(16, 23)).toEqual(["New ref", "", "", 9600, "Cr", "", ""]);

    // Venue (Event) — unmapped type → default ledger; no project → blank cost centre.
    expect(vDr.slice(4, 8)).toEqual(["Travel Expenses - Misc", "Dr", "", ""]);
    expect(vDr[14]).toBe(24000);
    expect(vDr[15]).toBe(`Being Venue for Asha Rao ${REF.event}`);
    expect(vCr.slice(4, 6)).toEqual(["Lakeside Convention Hall", "Cr"]);
    expect(vCr[19]).toBe(24000);
  });

  it("formats: dates dd-mm-yyyy, reference / bill / cost-centre columns text", async () => {
    const { ws } = await readSheet((await exportSheet(ACT.finA, "2026-10-01", "2026-10-31")).body);
    expect(ws.getCell("D2").numFmt).toBe("dd-mm-yyyy");
    for (const c of ["C2", "H2", "I2", "J2", "M2", "N2", "R3", "V3"]) expect(ws.getCell(c).numFmt).toBe("@");
  });

  it("re-export keeps the voucher numbers; Admin sees everyone and B's line takes the next one", async () => {
    const again = (await readSheet((await exportSheet(ACT.finA, "2026-10-01", "2026-10-31")).body)).rows;
    expect(again.map((x) => x[2])).toEqual(first.map((x) => x[2]));

    const all = (await readSheet((await exportSheet(ACT.admin, "2026-10-01", "2026-10-31")).body)).rows;
    expect(all).toHaveLength(8);
    expect(all.map((x) => x[2])).toEqual(["101", "101", "102", "102", "103", "103", "104", "104"]);
    expect(all[6].slice(4, 8)).toEqual(["Hotel & Lodging", "Dr", "Projects", "PRJ-SOLAR"]);
    expect(all[6][15]).toBe(`Being Hotel for Ravi Kumar ${REF.tourB}`);
    // No department; New Delhi has no code → its own text, still labelled.
    expect(all[6].slice(8, 14)).toEqual(["", "Ravi Kumar", "", "", "Locations", "New Delhi"]);
    expect(await col("csteparrangements").countDocuments({ tallyVoucherNo: { $exists: true } })).toBe(4);
    expect(ok(await send("get", ACT.admin, "/tally/settings")).body.nextVoucherNo).toBe(105);
  });

  it("the paid-on range is by IST date and inclusive", async () => {
    const r = (await readSheet((await exportSheet(ACT.finA, "2026-10-12", "2026-10-12")).body)).rows;
    expect(r.map((x) => x[2])).toEqual(["102", "102"]);
  });

  it("Location CC from the trip's destination when the settings say so; a label of their own", async () => {
    ok(await send("put", ACT.admin, "/tally/settings", {
      ...SETTINGS, locationSource: "DESTINATION", locationLabel: "Site",
      locationMap: [{ location: "Mumbai", code: "BOM-02" }, { location: "Bengaluru", code: "BLR-HQ" }],
    }));
    const all = (await readSheet((await exportSheet(ACT.admin, "2026-10-01", "2026-10-31")).body)).rows;
    const dr = all.filter((x) => x[5] === "Dr");
    // Tour → first station travelled to (mapped); event → its location and
    // the international tour → its country (both unmapped → their text).
    expect(dr.map((x) => [x[12], x[13]])).toEqual([["Site", "BOM-02"], ["Site", "BOM-02"], ["Site", "Goa"], ["Site", "Germany"]]);
    ok(await send("put", ACT.admin, "/tally/settings", SETTINGS));
  });
});

describe("a line needs its amount before it is paid", () => {
  it("mark-paid refuses a line with no amount, and a foreign amount with no rate, naming the line", async () => {
    const none = await pay(ACT.finA, R.tour, L.cabNoAmount, { paymentStatus: "PAID", paymentRef: "UTR555", paidAt: "2026-09-05" });
    expect(none.status).toBe(409);
    expect(none.body.error).toBe(`Cab — Skyline Travels on ${REF.tour} has no amount — enter the amount before marking it paid`);
    const usd = await pay(ACT.finA, R.tour, L.usdNoRate, { paymentStatus: "PAID", paymentRef: "UTR556", paidAt: "2026-09-05" });
    expect(usd.status).toBe(409);
    expect(usd.body.error).toBe(`Hotel — Hotel Lakeview on ${REF.tour} has an amount in USD but no exchange rate — enter the amount before marking it paid`);
    expect(await col("csteparrangements").countDocuments({ _id: { $in: [L.cabNoAmount, L.usdNoRate] }, paymentStatus: "PAID" })).toBe(0);
  });

  it("GET /requests/:id tells Finance and Admin they may set a missing amount — no one else", async () => {
    expect(ok(await send("get", ACT.finA, `/requests/${R.tour}`)).body.canSetMissingAmounts).toBe(true);
    expect(ok(await send("get", ACT.admin, `/requests/${R.tour}`)).body.canSetMissingAmounts).toBe(true);
    expect((await send("get", ACT.finB, `/requests/${R.tour}`)).body.canSetMissingAmounts).not.toBe(true);
  });

  it("Finance sets the missing amount past the arrange step; then the line pays", async () => {
    // Another traveller's Finance user, or a plain user, may not.
    for (const as of [ACT.finB, ACT.plain]) {
      expect((await setMissingAmount(as, R.tour, L.cabNoAmount, { currency: "INR", amount: 1800 })).status).toBe(403);
    }
    expect((await setMissingAmount(ACT.finA, R.tour, L.cabNoAmount, { currency: "INR", amount: 0 })).status).toBe(400);
    expect((await setMissingAmount(ACT.finA, R.tour, L.cabNoAmount, {})).status).toBe(400);
    const set = ok(await setMissingAmount(ACT.finA, R.tour, L.cabNoAmount, { currency: "INR", amount: 1800 })).body.line;
    expect(set).toMatchObject({ currency: "INR", amount: 1800, exchangeRate: 1, amountInr: 1800, paymentStatus: "UNPAID" });
    const log: any = await col("cstepapprovals").findOne({ entityId: R.tour, action: "VENDOR_PAYMENT", comment: /missing amount set/ });
    expect(log).toMatchObject({ stage: "FINANCE", actor: U.finA });
    expect(log.comment).toBe("CAB — CSTEPVEN0001 Skyline Travels: missing amount set | Amount: 1800 INR | unpaid");
    // Narrow: a line that has an amount is refused here.
    expect((await setMissingAmount(ACT.finA, R.tour, L.cabNoAmount, { currency: "INR", amount: 1 })).status).toBe(409);
    expect((await setMissingAmount(ACT.finA, R.tour, L.flight, { currency: "INR", amount: 1 })).status).toBe(409);
    ok(await pay(ACT.finA, R.tour, L.cabNoAmount, { paymentStatus: "PAID", paymentRef: "UTR555", paidAt: "2026-09-05" }));

    // A foreign amount takes its rate here too.
    expect((await setMissingAmount(ACT.admin, R.tour, L.usdNoRate, { currency: "USD", amount: 300 })).status).toBe(400);
    const usd = ok(await setMissingAmount(ACT.admin, R.tour, L.usdNoRate, { currency: "USD", amount: 300, exchangeRate: 83.5 })).body.line;
    expect(usd).toMatchObject({ currency: "USD", amount: 300, exchangeRate: 83.5, amountInr: 25050, rateSource: "MANUAL" });
    // Setting the amount is Finance-or-Admin; recording the payment is the
    // assigned Finance user's alone — the Admin who set it can't pay it.
    const adminPay = await pay(ACT.admin, R.tour, L.usdNoRate, { paymentStatus: "PAID", paymentRef: "UTR556", paidAt: "2026-09-05" });
    expect(adminPay.status).toBe(403);
    expect(adminPay.body.error).toBe("Only the assigned finance user can record payments");
    ok(await pay(ACT.finA, R.tour, L.usdNoRate, { paymentStatus: "PAID", paymentRef: "UTR556", paidAt: "2026-09-05" }));
  });
});

describe("the export refuses a paid line with no amount", () => {
  it("409 naming the claim references; nothing numbered; Finance sets the amount and it exports", async () => {
    // A line paid before amounts were enforced (as the import used to allow).
    const hall: any = await col("csteparrangements").findOne({ _id: L.hall });
    const { _id, amount, exchangeRate, amountInr, tallyVoucherNo, ...rest } = hall;
    void _id; void amount; void exchangeRate; void amountInr; void tallyVoucherNo;
    await col("csteparrangements").insertOne({ ...rest, _id: L.legacy, paidAt: new Date("2026-10-20T06:30:00Z"), paymentSource: "IMPORT" });
    const counterBefore: any = await col("counters").findOne({ _id: `cstep:${WS}:TALLY` } as any);

    const r = await exportJson(ACT.admin, "2026-10-01", "2026-10-31");
    expect(r.status).toBe(409);
    expect(r.body.missingAmountReferences).toEqual([REF.event]);
    expect(r.body.error).toBe(`1 paid vendor line has no amount, on ${REF.event} — Finance or a CSTEP Admin sets it on the request, then export again`);
    expect(((await col("csteparrangements").findOne({ _id: L.legacy })) as any).tallyVoucherNo).toBeUndefined();
    expect(await col("counters").findOne({ _id: `cstep:${WS}:TALLY` } as any)).toEqual(counterBefore);
    // A range without it still exports.
    expect((await exportSheet(ACT.admin, "2026-10-01", "2026-10-15")).status).toBe(200);

    ok(await setMissingAmount(ACT.finA, R.event, L.legacy, { currency: "INR", amount: 6500 }));
    const all = (await readSheet((await exportSheet(ACT.admin, "2026-10-01", "2026-10-31")).body)).rows;
    expect(all.at(-2)!.slice(14, 16)).toEqual([6500, `Being Venue for Asha Rao ${REF.event}`]);
    expect(all.at(-1)![19]).toBe(6500);
  });
});
