// apps/backend/src/routes/cstep.tallyReimbursements.test.ts
//
// Finance-a Stage 2 — the reimbursement Tally export (routes/cstep.tally.ts,
// ?kind=reimbursements / both) and its settings (the "reimbursement" block
// of CstepTallySettings). Reimbursed cases paid in the range → one journal
// voucher each: Dr one row per expense ledger (each line's category → its
// ledger, the tax ledger for TAX, else the default; lines summed), Cr the
// employee (the control ledger with the employee as cost centre, or the
// employee's own ledger). An advance: Cr the advance ledger, Cr the employee
// the net; owed back: Dr the employee, Cr the advance. Company-paid,
// disallowed and ₹0 lines are left out. Covers the 409s (an unmapped
// category, no advance ledger, a per-employee ledger that can't be named,
// lines that don't add up, all numbering nothing), the TALLY numbering
// shared with vendor lines and stable on re-export, Finance/Admin scoping,
// the 25-column sheet, and one case paid through the real
// /finance/settle route.
//
// Real: cstep + tally routers, models, sheetImport, sequence engine,
//   in-memory Mongo REPLICA SET on a fresh database, cstep_qc_tally_reimb.
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
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_tally_reimb";
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
const { default: tallyRouter, TALLY_COLUMNS, reimbursementJournal, employeeLedgerOf } = await import("./cstep.tally.js");

const DB = "cstep_qc_tally_reimb";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const U = { travA: oid(), travB: oid(), finA: oid(), finB: oid(), admin: oid(), plain: oid() };
const TP = { a: oid(), b: oid() };
const DEPT = oid();
const VT = oid();
const VENDOR = oid();
const ARR = oid();
// tour1 / claimA: traveller A. tourB / claimB: traveller B. The rest never export.
const R = { tour1: oid(), claimA: oid(), tourB: oid(), claimB: oid(), closedZero: oid(), unpaid: oid(), sept: oid() };
const S = { tour1: oid(), claimA: oid(), tourB: oid(), claimB: oid(), closedZero: oid(), unpaid: oid(), sept: oid() };
const REF = {
  tour1: "0001/1026", claimA: "EXP0001/1026", tourB: "0002/1026", claimB: "LTC0001/1026",
  closedZero: "0003/1026", unpaid: "0004/1026", sept: "0005/0926",
};

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
const send = (method: "get" | "put" | "post", as: any, path: string, body?: any) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS));
  return body === undefined ? r : r.send(body);
};
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};

const TODAY = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
const FROM = "2026-10-01";
const exportSheet = (as: any, kind: string, from = FROM, to = TODAY) =>
  request(app)
    .get(`/api/cstep/tally/export?kind=${kind}&from=${from}&to=${to}`)
    .set("x-test-user", JSON.stringify(as))
    .set("x-test-ws", String(WS))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
const exportJson = async (as: any, kind: string) => {
  const r = await exportSheet(as, kind);
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
const sheetRows = async (as: any, kind: string) => {
  const r = await exportSheet(as, kind);
  if (r.status !== 200) throw new Error(`${r.status} ${r.body.toString()}`);
  return (await readSheet(r.body)).rows;
};
/** The rows grouped by voucher number, in sheet order. */
const byVoucher = (rows: any[][]) => {
  const m = new Map<string, any[][]>();
  for (const x of rows) m.set(x[2], [...(m.get(x[2]) || []), x]);
  return m;
};
/** [ledger, Dr/Cr, amount] per row — the journal's shape. */
const shape = (rows: any[][]) => rows.map((x) => [x[4], x[5], x[14]]);
const ymd = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
const counterCount = () => col("counters").countDocuments({ _id: `cstep:${WS}:TALLY` } as any);
const numbered = () => col("cstepsettlements").countDocuments({ tallyVoucherNo: { $exists: true } });

const VENDOR_SETTINGS = {
  companyName: "CSTEP",
  ledgerMap: [{ vendorTypeId: String(VT), ledger: "Air Travel Expenses" }],
  locationMap: [{ location: "Bengaluru", code: "BLR-HQ" }],
};
// A test ledger map (the real names come from CSTEP later).
const REIMB = {
  defaultLedger: "Travel Expenses - Other",
  categoryLedgerMap: [
    { category: "FLIGHT", ledger: "Travel - Air" },
    { category: "HOTEL", ledger: "Travel - Lodging" },
    { category: "CAB", ledger: "Local Conveyance" },
    { category: "FOOD", ledger: "Staff Welfare - Meals" },
  ],
  taxLedger: "Input IGST",
  advanceLedger: "Staff Advances",
};
const saveSettings = async (reimbursement: any) => ok(await send("put", ACT.admin, "/tally/settings", { ...VENDOR_SETTINGS, reimbursement }));

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
  // B has no employee id — what a per-employee ledger named by ID needs.
  await col("travellerprofiles").insertMany([
    { _id: TP.a, workspaceId: WS, travelerId: "E-001", employeeId: "E-001", firstName: "Asha", lastName: "Rao", isActive: true, claimedBy: U.travA, financeUserId: U.finA, departmentId: DEPT, workLocation: "Bengaluru" },
    { _id: TP.b, workspaceId: WS, travelerId: "", firstName: "Ravi", lastName: "Kumar", isActive: true, claimedBy: U.travB, financeUserId: U.finB, workLocation: "New Delhi" },
  ] as any[]);

  const reqDoc = (_id: any, formType: string, ref: string, tp: any, status: string) => ({
    _id, workspaceId: WS, travelerProfileId: tp, createdBy: tp === TP.a ? U.travA : U.travB, formType, purpose: `QC ${ref}`,
    departureDate: "2026-09-28", returnDate: "2026-09-30", status, claimReference: ref,
    project: tp === TP.a ? "PRJ-ENERGY" : "PRJ-SOLAR", type: "DOMESTIC", stations: [{ from: "Bengaluru", to: "Mumbai" }],
    createdAt: now, updatedAt: now,
  });
  await col("csteptravelrequests").insertMany([
    reqDoc(R.tour1, "TOUR_PROPOSAL", REF.tour1, TP.a, "REIMBURSED"),
    reqDoc(R.claimA, "EXPENSE_CLAIM", REF.claimA, TP.a, "REIMBURSED"),
    reqDoc(R.tourB, "TOUR_PROPOSAL", REF.tourB, TP.b, "REIMBURSED"),
    reqDoc(R.claimB, "LOCAL_TRAVEL_CLAIM", REF.claimB, TP.b, "TRANSFERRED_TO_FINANCE"),
    reqDoc(R.closedZero, "TOUR_PROPOSAL", REF.closedZero, TP.a, "SETTLED"),
    reqDoc(R.unpaid, "TOUR_PROPOSAL", REF.unpaid, TP.a, "TRANSFERRED_TO_FINANCE"),
    reqDoc(R.sept, "TOUR_PROPOSAL", REF.sept, TP.a, "REIMBURSED"),
  ] as any[]);

  const settlement = (_id: any, requestId: any, extra: any) => ({
    _id, workspaceId: WS, requestId, status: "FINALIZED", outcome: "TO_FINANCE",
    perDiem: { days: 0, rate: 0, currency: "INR", amountInr: 0, computedDays: 0 },
    startedBy: U.admin, startedAt: now, createdAt: now, updatedAt: now, ...extra,
  });
  const ist = (d: string) => new Date(`${d}T11:00:00+05:30`);
  await col("cstepsettlements").insertMany([
    settlement(S.tour1, R.tour1, { amountClaimed: 9700, paidOn: ist("2026-10-05"), paymentRef: "UTR-T1", perDiem: { days: 3, rate: 500, currency: "INR", amountInr: 1500, computedDays: 3 } }),
    settlement(S.claimA, R.claimA, { amountClaimed: 7360, advanceTaken: 5000, amountDueByCstep: 2360, amountDueToCstep: 0, paidOn: ist("2026-10-08"), paymentRef: "UTR-CA" }),
    settlement(S.tourB, R.tourB, { amountClaimed: 3300, paidOn: ist("2026-10-12"), paymentRef: "UTR-TB" }),
    // Settled through the real route below.
    settlement(S.claimB, R.claimB, { status: "VERIFYING", outcome: undefined, amountClaimed: 1000, advanceTaken: 3000, amountDueByCstep: 0, amountDueToCstep: 2000 }),
    // Closed with nothing paid, with Finance but not paid yet, paid in September.
    settlement(S.closedZero, R.closedZero, { amountClaimed: 0, financeClosedAt: ist("2026-10-07") }),
    settlement(S.unpaid, R.unpaid, { amountClaimed: 800 }),
    settlement(S.sept, R.sept, { amountClaimed: 450, paidOn: ist("2026-09-20") }),
  ] as any[]);

  const line = (settlementId: any, requestId: any, category: string | null, amountInr: number, extra: any = {}) => ({
    _id: oid(), workspaceId: WS, settlementId, requestId, source: "REPORT_LEG", sourceId: oid(), mode: "OTHER",
    description: `${category} line`, amountInr, claimedAmountInr: amountInr, classification: "PERSONAL",
    classificationOverridden: false, verified: true, createdBy: U.admin, createdAt: now, updatedAt: now,
    ...(category ? { category } : {}), ...extra,
  });
  await col("cstepsettlementlines").insertMany([
    // tour1 — two cab lines (summed into one row), a company-paid flight, a
    // disallowed meal and a ₹0 line, none of which go in.
    line(S.tour1, R.tour1, "FLIGHT", 4000),
    line(S.tour1, R.tour1, "HOTEL", 3000),
    line(S.tour1, R.tour1, "CAB", 500),
    line(S.tour1, R.tour1, "CAB", 700),
    line(S.tour1, R.tour1, "FLIGHT", 9000, { classification: "OFFICIAL", source: "ARRANGEMENT" }),
    line(S.tour1, R.tour1, "FOOD", 0, { financeRejected: true, financeRejectedFromInr: 650, financeRejectedReason: "No bill" }),
    line(S.tour1, R.tour1, "OTHER", 0),
    // claimA — tax to the IGST ledger, an advance of 5000.
    line(S.claimA, R.claimA, "FOOD", 2000, { source: "CLAIM_LINE" }),
    line(S.claimA, R.claimA, "HOTEL", 5000, { source: "CLAIM_LINE" }),
    line(S.claimA, R.claimA, "TAX", 360, { source: "CLAIM_LINE" }),
    // tourB — Visa has no ledger of its own, and an old line with no category.
    line(S.tourB, R.tourB, "VISA", 2500),
    line(S.tourB, R.tourB, null, 800),
    // claimB — 1000 spent against a 3000 advance.
    line(S.claimB, R.claimB, "CAB", 1000, { source: "CLAIM_LINE" }),
    line(S.unpaid, R.unpaid, "HOTEL", 800),
    line(S.sept, R.sept, "CAB", 450),
  ] as any[]);

  // One paid vendor line (traveller A, 2026-10-06), for the shared numbering.
  await col("cstepvendortypes").insertOne({ _id: VT, workspaceId: WS, name: "Airline", isActive: true } as any);
  await col("cstepvendors").insertOne({ _id: VENDOR, workspaceId: WS, vendorCode: "CSTEPVEN0001", name: "Skyline Travels", vendorTypeId: VT, isActive: true, createdAt: now, updatedAt: now } as any);
  await col("csteparrangements").insertOne({
    _id: ARR, workspaceId: WS, requestId: R.tour1, source: "ADDED", arrangedType: "FLIGHT", status: "ARRANGED", currency: "INR",
    amount: 9000, exchangeRate: 1, amountInr: 9000, vendorId: VENDOR, vendorCode: "CSTEPVEN0001", vendorName: "Skyline Travels",
    paymentStatus: "PAID", paidAt: ist("2026-10-06"), paymentRef: "UTR-V1", createdBy: U.admin, createdAt: now, updatedAt: now,
  } as any);

  // claimB's Finance user receives the unspent advance back through the
  // real settle route: SETTLED, paid on today.
  const settled = ok(await send("post", ACT.finB, `/requests/${R.claimB}/finance/settle`, { reference: "RCPT-CB" }));
  expect(settled.body.request.status).toBe("SETTLED");
}, 240_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("the journal shape (pure)", () => {
  const s = { ...REIMB, employeeLedgerMode: "CONTROL", controlLedger: "Staff Reimbursement Payable", employeeLedgerName: "NAME_AND_ID" } as any;

  it("Dr one row per ledger with its lines summed, Cr the employee the gross", () => {
    const j = reimbursementJournal(
      [
        { category: "CAB", amountInr: 500 }, { category: "FLIGHT", amountInr: 4000 }, { category: "CAB", amountInr: 700.25 },
        { category: "VISA", amountInr: 100 }, { category: "PER_DIEM", amountInr: 900 }, { category: "FOOD", amountInr: 0 },
      ],
      0, "Staff Reimbursement Payable", s,
    );
    expect(j.gross).toBe(6200.25);
    expect(j.entries.map((e) => [e.ledger, e.side, e.amount])).toEqual([
      ["Travel - Air", "Dr", 4000],
      ["Local Conveyance", "Dr", 1200.25],
      // Visa and Per diem both fall to the default ledger → one row.
      ["Travel Expenses - Other", "Dr", 1000],
      ["Staff Reimbursement Payable", "Cr", 6200.25],
    ]);
    expect(j.entries[2].categories).toEqual(["PER_DIEM", "VISA"]);
    expect(j.unmapped).toEqual([]);
  });

  it("an advance: Cr the advance, Cr the employee the net; owed back: Dr the employee, Cr the advance", () => {
    const paid = reimbursementJournal([{ category: "HOTEL", amountInr: 5000 }, { category: "TAX", amountInr: 360 }], 3000, "EMP", s);
    expect(paid.entries.map((e) => [e.ledger, e.side, e.amount])).toEqual([
      ["Travel - Lodging", "Dr", 5000], ["Input IGST", "Dr", 360], ["Staff Advances", "Cr", 3000], ["EMP", "Cr", 2360],
    ]);
    const back = reimbursementJournal([{ category: "CAB", amountInr: 1000 }], 3000, "EMP", s);
    expect(back.entries.map((e) => [e.ledger, e.side, e.amount])).toEqual([
      ["Local Conveyance", "Dr", 1000], ["EMP", "Dr", 2000], ["Staff Advances", "Cr", 3000],
    ]);
    // Exactly used up: nothing to or from the employee.
    expect(reimbursementJournal([{ category: "CAB", amountInr: 3000 }], 3000, "EMP", s).entries.map((e) => e.role)).toEqual(["EXPENSE", "ADVANCE"]);
    // Everything disallowed: the whole advance is owed back.
    expect(reimbursementJournal([], 3000, "EMP", s).entries.map((e) => [e.ledger, e.side, e.amount])).toEqual([["EMP", "Dr", 3000], ["Staff Advances", "Cr", 3000]]);
  });

  it("no default ledger: an unmapped category is reported, not guessed; TAX with no tax ledger is unmapped too", () => {
    const j = reimbursementJournal(
      [{ category: "VISA", amountInr: 1 }, { category: null, amountInr: 1 }, { category: "TAX", amountInr: 1 }, { category: "FLIGHT", amountInr: 1 }],
      0, "EMP", { ...s, defaultLedger: "", taxLedger: "" },
    );
    expect(j.unmapped).toEqual(["VISA", "TAX", null]);
    // With a default ledger but no tax ledger, tax falls to the default.
    expect(reimbursementJournal([{ category: "TAX", amountInr: 5 }], 0, "EMP", { ...s, taxLedger: "" }).entries[0].ledger).toBe("Travel Expenses - Other");
  });

  it("the employee ledger: the control ledger, or one named from the traveller", () => {
    expect(employeeLedgerOf(s, "Asha Rao", "E-001")).toBe("Staff Reimbursement Payable");
    const per = { ...s, employeeLedgerMode: "PER_EMPLOYEE" };
    expect(employeeLedgerOf({ ...per, employeeLedgerName: "NAME" }, "Asha Rao", "E-001")).toBe("Asha Rao");
    expect(employeeLedgerOf({ ...per, employeeLedgerName: "EMPLOYEE_ID" }, "Asha Rao", "E-001")).toBe("E-001");
    expect(employeeLedgerOf(per, "Asha Rao", "E-001")).toBe("Asha Rao (E-001)");
    expect(employeeLedgerOf(per, "Asha Rao", "")).toBe("");
  });
});

describe("reimbursement settings — CSTEP Admin only", () => {
  it("Finance can't save; bad input is 400; a save without the block leaves it alone", async () => {
    expect((await send("put", ACT.finA, "/tally/settings", { reimbursement: REIMB })).status).toBe(403);
    const bad = async (reimbursement: any) => (await send("put", ACT.admin, "/tally/settings", { ...VENDOR_SETTINGS, reimbursement })).body.error;
    expect(await bad({ categoryLedgerMap: [{ category: "TAX", ledger: "X" }] })).toBe("Tax goes to the tax (IGST) ledger, not the category map");
    expect(await bad({ categoryLedgerMap: [{ category: "LUNCH", ledger: "X" }] })).toBe("Unknown expense category in the ledger map");
    expect(await bad({ employeeLedgerMode: "BOTH" })).toBe("Employee ledger must be CONTROL or PER_EMPLOYEE");
    expect(await bad({ employeeLedgerName: "EMAIL" })).toBe("Employee ledger name must be NAME, EMPLOYEE_ID or NAME_AND_ID");
    expect(await bad("x")).toBe("reimbursement must be an object");

    const saved = (await saveSettings({ ...REIMB, controlLedger: "  ", categoryLedgerMap: [...REIMB.categoryLedgerMap, { category: "VISA", ledger: " " }] })).body.settings.reimbursement;
    expect(saved).toEqual({ ...REIMB, employeeLedgerMode: "CONTROL", controlLedger: "Staff Reimbursement Payable", employeeLedgerName: "NAME_AND_ID" });
    ok(await send("put", ACT.admin, "/tally/settings", VENDOR_SETTINGS));
    const r = ok(await send("get", ACT.admin, "/tally/settings")).body;
    expect(r.settings.reimbursement.advanceLedger).toBe("Staff Advances");
    expect(r.expenseCategories).toHaveLength(14);
    expect(r.expenseCategories[0]).toEqual({ category: "FLIGHT", label: "Flight" });
  });
});

describe("GET /tally/export?kind=reimbursements — refusals number nothing", () => {
  it("an unmapped category with no default ledger: 409 listing the categories and the cases", async () => {
    await saveSettings({ ...REIMB, defaultLedger: "", taxLedger: "" });
    const r = await exportJson(ACT.admin, "reimbursements");
    expect(r.status).toBe(409);
    expect(r.body.unmappedCategories).toEqual(["Per diem", "Tax", "Visa", "(no category)"]);
    expect(r.body.references).toEqual([REF.tour1, REF.claimA, REF.tourB]);
    expect(r.body.error).toMatch(/Tally settings$/);
    // "both" refuses for the same reason, though the vendor side is fine.
    expect((await exportJson(ACT.admin, "both")).status).toBe(409);
    expect(await numbered()).toBe(0);
    expect(await counterCount()).toBe(0);
  });

  it("an advance with no advance ledger: 409 naming the cases", async () => {
    await saveSettings({ ...REIMB, advanceLedger: "" });
    const r = await exportJson(ACT.admin, "reimbursements");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ missingSettings: ["advanceLedger"], references: [REF.claimA, REF.claimB] });
    expect(await numbered()).toBe(0);
  });

  it("a per-employee ledger by ID with a traveller who has none: 409 naming them", async () => {
    await saveSettings({ ...REIMB, employeeLedgerMode: "PER_EMPLOYEE", employeeLedgerName: "EMPLOYEE_ID" });
    const r = await exportJson(ACT.admin, "reimbursements");
    expect(r.status).toBe(409);
    expect(r.body.employeesWithoutLedger).toEqual([`Ravi Kumar on ${REF.tourB}`, `Ravi Kumar on ${REF.claimB}`]);
    expect(r.body.error).toMatch(/needs an employee ID/);
    expect(await numbered()).toBe(0);
  });

  it("lines that don't add up to the amount paid: 409 (break, then restore)", async () => {
    await saveSettings(REIMB);
    await col("cstepsettlements").updateOne({ _id: S.tour1 }, { $set: { amountClaimed: 9999 } });
    const r = await exportJson(ACT.admin, "reimbursements");
    expect(r.status).toBe(409);
    expect(r.body.mismatchedReferences).toEqual([REF.tour1]);
    await col("cstepsettlements").updateOne({ _id: S.tour1 }, { $set: { amountClaimed: 9700 } });
    expect(await numbered()).toBe(0);
    expect(await counterCount()).toBe(0);
  });

  it("no company name: 409, as with vendor payments", async () => {
    ok(await send("put", ACT.admin, "/tally/settings", { ...VENDOR_SETTINGS, companyName: "" }));
    const r = await exportJson(ACT.admin, "reimbursements");
    expect(r.status).toBe(409);
    expect(r.body.missingSettings).toEqual(["companyName"]);
    await saveSettings(REIMB);
  });

  it("access and input: plain users 403, a bad kind 400, an empty range 404", async () => {
    expect((await exportSheet(ACT.plain, "reimbursements")).status).toBe(403);
    expect((await exportSheet(ACT.admin, "payroll")).status).toBe(400);
    const empty = await exportSheet(ACT.admin, "reimbursements", "2026-08-01", "2026-08-31");
    expect(empty.status).toBe(404);
    expect(JSON.parse(empty.body.toString()).error).toBe("No reimbursements were marked paid between 2026-08-01 and 2026-08-31");
  });
});

describe("GET /tally/export?kind=reimbursements — the vouchers", () => {
  let financeA: any[][];

  it("Finance A: sheet Upload, the 25 headers; A's two cases only, numbered in paid order", async () => {
    const r = await exportSheet(ACT.finA, "reimbursements");
    expect(r.status).toBe(200);
    expect(String(r.headers["content-disposition"])).toContain(`cstep-tally-reimbursements-${FROM}-to-${TODAY}.xlsx`);
    const { wb, ws, rows } = await readSheet(r.body);
    expect(wb.worksheets.map((x) => x.name)).toEqual(["Upload"]);
    expect((ws.getRow(1).values as any[]).slice(1)).toEqual(TALLY_COLUMNS);
    expect(TALLY_COLUMNS).toHaveLength(25);
    expect(ws.getCell("D2").numFmt).toBe("dd-mm-yyyy");
    for (const c of ["C2", "E2", "H2", "J2", "N2", "R2"]) expect(ws.getCell(c).numFmt).toBe("@");
    financeA = rows;

    const v = byVoucher(rows);
    expect([...v.keys()]).toEqual(["1", "2"]);
    for (const x of rows) {
      expect(x.slice(0, 2)).toEqual(["CSTEP", "Journal"]);
      expect(x[3]).toBeInstanceOf(Date);
      for (const i of [10, 11, 21, 22, 23, 24]) expect(x[i]).toBe("");
    }
    // Every voucher balances.
    for (const vr of v.values()) {
      const dr = vr.filter((x) => x[5] === "Dr").reduce((a, x) => a + x[14], 0);
      const cr = vr.filter((x) => x[5] === "Cr").reduce((a, x) => a + x[14], 0);
      expect(Math.round(dr * 100)).toBe(Math.round(cr * 100));
    }
  });

  it("a Tour: Dr per ledger (the cabs summed, the per diem to the default), Cr the control ledger with the employee", async () => {
    const t = byVoucher(financeA).get("1")!;
    expect(ymd(t[0][3])).toBe("2026-10-05");
    // The company-paid flight, the disallowed meal and the ₹0 line are not here.
    expect(shape(t)).toEqual([
      ["Travel - Air", "Dr", 4000],
      ["Travel - Lodging", "Dr", 3000],
      ["Local Conveyance", "Dr", 1200],
      ["Travel Expenses - Other", "Dr", 1500],
      ["Staff Reimbursement Payable", "Cr", 9700],
    ]);
    // Narration once, on the voucher's first row.
    expect(t[0][15]).toBe(`Being Flight, Hotel, Cab, Per diem reimbursed to Asha Rao ${REF.tour1}`);
    expect(t.slice(1).map((x) => x[15])).toEqual(["", "", "", ""]);
    // Dr rows: the vendor export's cost centres.
    for (const x of t.slice(0, 4)) {
      expect(x.slice(6, 14)).toEqual(["Projects", "PRJ-ENERGY", "Energy Research", "Asha Rao", "", "", "Locations", "BLR-HQ"]);
      expect(x.slice(16, 21)).toEqual(["", "", "", "", ""]);
    }
    // Cr employee: the employee as cost centre, bill-wise New ref = the case.
    const cr = t[4];
    expect(cr.slice(6, 14)).toEqual(["Projects", "PRJ-ENERGY", "", "Asha Rao", "", "", "", ""]);
    expect(cr.slice(16, 21)).toEqual(["New ref", REF.tour1, "", 9700, "Cr"]);
  });

  it("an Expense Claim with an advance: Dr the expenses (tax to IGST), Cr the advance, Cr the employee the net", async () => {
    const c = byVoucher(financeA).get("2")!;
    expect(ymd(c[0][3])).toBe("2026-10-08");
    expect(shape(c)).toEqual([
      ["Travel - Lodging", "Dr", 5000],
      ["Staff Welfare - Meals", "Dr", 2000],
      ["Input IGST", "Dr", 360],
      ["Staff Advances", "Cr", 5000],
      ["Staff Reimbursement Payable", "Cr", 2360],
    ]);
    expect(c[0][15]).toBe(`Being Hotel, Food, Tax reimbursed to Asha Rao ${REF.claimA} less advance 5000`);
    // The advance row: the employee as cost centre, no bill-wise.
    expect(c[3].slice(8, 10)).toEqual(["", "Asha Rao"]);
    expect(c[3].slice(16, 21)).toEqual(["", "", "", "", ""]);
    expect(c[4].slice(16, 21)).toEqual(["New ref", REF.claimA, "", 2360, "Cr"]);
  });

  it("Finance B: B's cases only — and the owed-back claim: Dr the expense, Dr the employee, Cr the advance", async () => {
    const rows = await sheetRows(ACT.finB, "reimbursements");
    const v = byVoucher(rows);
    expect([...v.keys()]).toEqual(["3", "4"]);
    const [tourB, claimB] = [v.get("3")!, v.get("4")!];
    // Visa and the uncategorised line both go to the default ledger: one row.
    expect(shape(tourB)).toEqual([["Travel Expenses - Other", "Dr", 3300], ["Staff Reimbursement Payable", "Cr", 3300]]);
    expect(tourB[0][15]).toBe(`Being Visa, (no category) reimbursed to Ravi Kumar ${REF.tourB}`);
    // No department, an unmapped base location → its own text.
    expect(tourB[0].slice(6, 14)).toEqual(["Projects", "PRJ-SOLAR", "", "Ravi Kumar", "", "", "Locations", "New Delhi"]);

    expect(ymd(claimB[0][3])).toBe(TODAY); // paid through the real route, today
    expect(shape(claimB)).toEqual([
      ["Local Conveyance", "Dr", 1000],
      ["Staff Reimbursement Payable", "Dr", 2000],
      ["Staff Advances", "Cr", 3000],
    ]);
    expect(claimB[0][15]).toBe(`Being advance 3000 settled by Ravi Kumar ${REF.claimB} against Cab, 2000 recovered`);
    expect(claimB[1].slice(16, 21)).toEqual(["New ref", REF.claimB, "", 2000, "Dr"]);
  });

  it("closed-at-₹0, not-yet-paid and out-of-range cases never export or take a number", async () => {
    const refs = (await sheetRows(ACT.admin, "reimbursements")).map((x) => x[17]).filter(Boolean);
    expect(new Set(refs)).toEqual(new Set([REF.tour1, REF.claimA, REF.tourB, REF.claimB]));
    expect(await col("cstepsettlements").countDocuments({ _id: { $in: [S.closedZero, S.unpaid, S.sept] }, tallyVoucherNo: { $exists: true } })).toBe(0);
  });
});

describe("shared TALLY numbering", () => {
  it("the vendor line takes the next number; Both writes the two kinds into one sheet; re-export keeps every number", async () => {
    const both = await exportSheet(ACT.admin, "both");
    expect(both.status).toBe(200);
    expect(String(both.headers["content-disposition"])).toContain(`cstep-tally-all-${FROM}-to-${TODAY}.xlsx`);
    const v = byVoucher((await readSheet(both.body)).rows);
    expect([...v.keys()]).toEqual(["1", "2", "3", "4", "5"]);
    // The vendor voucher (paid 2026-10-06, exported last) is 5.
    expect(shape(v.get("5")!)).toEqual([["Air Travel Expenses", "Dr", 9000], ["Skyline Travels", "Cr", 9000]]);
    expect(((await col("csteparrangements").findOne({ _id: ARR })) as any).tallyVoucherNo).toBe(5);

    // Again, as Finance A and as vendor-only: the same numbers.
    expect([...byVoucher(await sheetRows(ACT.finA, "reimbursements")).keys()]).toEqual(["1", "2"]);
    expect([...byVoucher(await sheetRows(ACT.admin, "vendor")).keys()]).toEqual(["5"]);
    const again = byVoucher(await sheetRows(ACT.admin, "both"));
    expect([...again.keys()]).toEqual(["1", "2", "3", "4", "5"]);
    expect(ok(await send("get", ACT.admin, "/tally/settings")).body.nextVoucherNo).toBe(6);
    expect(
      ((await col("cstepsettlements").find({ tallyVoucherNo: { $exists: true } }).sort({ tallyVoucherNo: 1 }).toArray()) as any[]).map((x) => [String(x._id), x.tallyVoucherNo]),
    ).toEqual([[String(S.tour1), 1], [String(S.claimA), 2], [String(S.tourB), 3], [String(S.claimB), 4]]);
  });

  it("vendor-only is still the default kind", async () => {
    const r = await request(app)
      .get(`/api/cstep/tally/export?from=${FROM}&to=${TODAY}`)
      .set("x-test-user", JSON.stringify(ACT.admin))
      .set("x-test-ws", String(WS));
    expect(r.status).toBe(200);
    expect(String(r.headers["content-disposition"])).toContain(`cstep-tally-${FROM}-to-${TODAY}.xlsx`);
  });
});

describe("per-employee ledger", () => {
  it("Name (ID): the employee's own ledger, no employee cost centre on it; the advance row keeps it", async () => {
    await saveSettings({ ...REIMB, employeeLedgerMode: "PER_EMPLOYEE", employeeLedgerName: "NAME_AND_ID" });
    const v = byVoucher(await sheetRows(ACT.finA, "reimbursements"));
    const tour = v.get("1")!;
    expect(shape(tour).at(-1)).toEqual(["Asha Rao (E-001)", "Cr", 9700]);
    expect(tour.at(-1)!.slice(8, 10)).toEqual(["", ""]);
    const claim = v.get("2")!;
    expect(shape(claim).slice(3)).toEqual([["Staff Advances", "Cr", 5000], ["Asha Rao (E-001)", "Cr", 2360]]);
    expect(claim[3][9]).toBe("Asha Rao");

    await saveSettings({ ...REIMB, employeeLedgerMode: "PER_EMPLOYEE", employeeLedgerName: "NAME" });
    const b = byVoucher(await sheetRows(ACT.finB, "reimbursements"));
    expect(shape(b.get("4")!)[1]).toEqual(["Ravi Kumar", "Dr", 2000]);
    await saveSettings(REIMB);
  });
});
