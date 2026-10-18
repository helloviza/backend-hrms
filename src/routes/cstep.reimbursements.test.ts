// apps/backend/src/routes/cstep.reimbursements.test.ts
//
// CSTEP Finance bulk reimbursement — routes/cstep.reimbursements.ts on the
// shared settleFinanceCase core (routes/cstep.ts). The queue export (one row
// per case at TRANSFERRED_TO_FINANCE, the caller's travellers only, Reference
// / Paid On / Payment Ref as text) that doubles as the template; the
// preview → commit import closing each matched case at the SYSTEM net (a
// sheet amount is ignored) with Paid On + Payment Ref + one batch id, one
// outcome per row, an idempotent re-import, and Finance-user-only access (a
// plain Admin, the Official and the Requester are refused).
//
// Real: reimbursements + cstep routers, models, sheetImport, in-memory Mongo
//   REPLICA SET (settling runs in a transaction) on a fresh database,
//   cstep_qc_reimburse.
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
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_reimburse";
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
const { default: reimburseRouter } = await import("./cstep.reimbursements.js");

const DB = "cstep_qc_reimburse";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const U = { finA: oid(), finB: oid(), admin: oid(), adminFin: oid(), official: oid(), requester: oid() };
const TP = { a: oid(), b: oid(), c: oid() };
const R = { ltc: oid(), exp: oid(), collect: oid(), tour: oid(), ltcB: oid(), done: oid(), early: oid(), ltcC: oid() };
const REF = {
  ltc: "LTC0001/1026", exp: "EXP0001/1026", collect: "EXP0002/1026", tour: "0001/1026",
  ltcB: "LTC0002/1026", done: "LTC0003/1026", early: "LTC0004/1026", ltcC: "LTC0005/1026",
};

const fakeAuth = (req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceObjectId = new mongoose.Types.ObjectId(String(req.headers["x-test-ws"] || WS));
  next();
};
const app = express();
app.use(express.json());
app.use("/api/cstep/reimbursements", fakeAuth, reimburseRouter);
app.use("/api/cstep", fakeAuth, cstepRouter);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = {
  finA: who(U.finA), finB: who(U.finB), admin: who(U.admin, ["ADMIN"]), adminFin: who(U.adminFin, ["ADMIN"]),
  official: who(U.official), requester: who(U.requester),
};
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
const getSheet = (as: any, path: string) =>
  binary(request(app).get(`/api/cstep/reimbursements${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS)));
const upload = (step: "preview" | "commit", as: any, buf: Buffer, name = "reimburse.xlsx") =>
  request(app)
    .post(`/api/cstep/reimbursements/import/${step}`)
    .set("x-test-user", JSON.stringify(as))
    .set("x-test-ws", String(WS))
    .attach("file", buf, name);
const reqDoc = async (id: any) => (await col("csteptravelrequests").findOne({ _id: id })) as any;
const settlementOf = async (id: any) => (await col("cstepsettlements").findOne({ requestId: id })) as any;

let replSet: MongoMemoryReplSet;
let exported: Buffer;

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
  const map = { tourApproverId: U.official, officialUserId: U.official };
  await col("travellerprofiles").insertMany([
    { _id: TP.a, workspaceId: WS, travelerId: "E-001", firstName: "Asha", lastName: "Rao", isActive: true, claimedBy: U.requester, ...map, financeUserId: U.finA },
    { _id: TP.b, workspaceId: WS, travelerId: "E-002", firstName: "Ravi", lastName: "Kumar", isActive: true, ...map, financeUserId: U.finB },
    { _id: TP.c, workspaceId: WS, travelerId: "E-003", firstName: "Meera", lastName: "Nair", isActive: true, ...map, financeUserId: U.adminFin },
  ] as any[]);

  const req = (_id: any, formType: string, ref: string, tp: any, status: string) => ({
    _id, workspaceId: WS, travelerProfileId: tp, createdBy: U.requester, formType, purpose: `QC ${ref}`,
    departureDate: "2026-10-05", returnDate: "2026-10-09", status, claimReference: ref, createdAt: now, updatedAt: now,
  });
  await col("csteptravelrequests").insertMany([
    req(R.ltc, "LOCAL_TRAVEL_CLAIM", REF.ltc, TP.a, "TRANSFERRED_TO_FINANCE"),
    req(R.exp, "EXPENSE_CLAIM", REF.exp, TP.a, "TRANSFERRED_TO_FINANCE"),
    req(R.collect, "EXPENSE_CLAIM", REF.collect, TP.a, "TRANSFERRED_TO_FINANCE"),
    req(R.tour, "TOUR_PROPOSAL", REF.tour, TP.a, "TRANSFERRED_TO_FINANCE"),
    req(R.ltcB, "LOCAL_TRAVEL_CLAIM", REF.ltcB, TP.b, "TRANSFERRED_TO_FINANCE"),
    req(R.done, "LOCAL_TRAVEL_CLAIM", REF.done, TP.a, "REIMBURSED"),
    req(R.early, "LOCAL_TRAVEL_CLAIM", REF.early, TP.a, "APPROVED"),
    req(R.ltcC, "LOCAL_TRAVEL_CLAIM", REF.ltcC, TP.c, "TRANSFERRED_TO_FINANCE"),
  ] as any[]);
  const st = (requestId: any, status: string, amountClaimed: number, claim?: { advance: number; by: number; to: number }) => ({
    workspaceId: WS, requestId, status, amountClaimed, totalCostOfTour: amountClaimed,
    ...(claim ? { advanceTaken: claim.advance, amountDueByCstep: claim.by, amountDueToCstep: claim.to } : { outcome: "TO_FINANCE" }),
    startedBy: U.official, startedAt: now, createdAt: now, updatedAt: now,
  });
  await col("cstepsettlements").insertMany([
    st(R.ltc, "VERIFYING", 850, { advance: 500, by: 350, to: 0 }),
    st(R.exp, "VERIFYING", 3040, { advance: 0, by: 3040, to: 0 }),
    st(R.collect, "VERIFYING", 200, { advance: 500, by: 0, to: 300 }),
    st(R.tour, "FINALIZED", 4200),
    st(R.ltcB, "VERIFYING", 120, { advance: 0, by: 120, to: 0 }),
    st(R.done, "FINALIZED", 90, { advance: 0, by: 90, to: 0 }),
    st(R.early, "VERIFYING", 60, { advance: 0, by: 60, to: 0 }),
    st(R.ltcC, "VERIFYING", 700, { advance: 0, by: 700, to: 0 }),
  ] as any[]);
  await col("cstepclaims").insertOne({
    workspaceId: WS, travelerProfileId: TP.a, travelRequestId: R.tour, claimReference: REF.tour, status: "ADMIN_VERIFIED",
    createdBy: U.requester, createdAt: now, updatedAt: now,
  } as any);
}, 240_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("access — the travellers' Finance users only", () => {
  it("a plain Admin, the Official and the Requester are refused every route", async () => {
    const empty = Buffer.from("Reference,Paid On\n");
    for (const as of [ACT.admin, ACT.official, ACT.requester]) {
      expect((await getSheet(as, "/export")).status).toBe(403);
      expect((await getSheet(as, "/template")).status).toBe(403);
      expect((await upload("preview", as, empty, "x.csv")).status).toBe(403);
      expect((await upload("commit", as, empty, "x.csv")).status).toBe(403);
    }
  });

  it("GET /my-roles tells the UI: isFinanceUser only for a mapped Finance user, not every Admin", async () => {
    const roles = async (as: any) =>
      ok(await request(app).get("/api/cstep/my-roles").set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS))).body;
    expect(await roles(ACT.admin)).toMatchObject({ isAdmin: true, isFinance: true, isFinanceUser: false });
    expect(await roles(ACT.adminFin)).toMatchObject({ isAdmin: true, isFinanceUser: true });
    expect(await roles(ACT.finA)).toMatchObject({ isAdmin: false, isFinance: true, isFinanceUser: true });
    expect(await roles(ACT.official)).toMatchObject({ isFinance: false, isFinanceUser: false });
  });

  it("the template is the columns with no rows; Reference / Paid On / Payment Ref are text", async () => {
    const r = await getSheet(ACT.finA, "/template");
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as any);
    const ws = wb.worksheets[0];
    expect((ws.getRow(1).values as any[]).slice(1)).toEqual([
      "Reference", "Traveller", "Type", "Net Amount INR", "Advance INR", "Status", "Paid On", "Payment Ref",
    ]);
    expect(ws.actualRowCount).toBe(1);
    for (const c of [1, 7, 8]) expect(ws.getColumn(c).numFmt).toBe("@");
  });
});

describe("export — the caller's reimbursement queue", () => {
  it("Finance A gets their four cases at TRANSFERRED_TO_FINANCE, at the system figures", async () => {
    const r = await getSheet(ACT.finA, "/export");
    expect(r.status).toBe(200);
    exported = r.body as Buffer;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(exported as any);
    const rows: any[][] = [];
    wb.worksheets[0].eachRow((row, n) => n > 1 && rows.push((row.values as any[]).slice(1)));
    expect(rows).toEqual([
      [REF.tour, "Asha Rao", "Tour", 4200, 0, "To reimburse", "", ""],
      [REF.exp, "Asha Rao", "Expense", 3040, 0, "To reimburse", "", ""],
      [REF.collect, "Asha Rao", "Expense", 300, 500, "To collect from the claimant", "", ""],
      [REF.ltc, "Asha Rao", "Local Travel", 350, 500, "To reimburse", "", ""],
    ]);
  });

  it("an Admin who is also a traveller's Finance user gets only that traveller's queue", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await getSheet(ACT.adminFin, "/export")).body as any);
    const refs: any[] = [];
    wb.worksheets[0].eachRow((row, n) => n > 1 && refs.push(row.getCell(1).value));
    expect(refs).toEqual([REF.ltcC]);
  });
});

describe("import — preview then commit", () => {
  let filled: Buffer;

  it("builds the file from the export", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(exported as any);
    const ws = wb.worksheets[0];
    const rowOf = (ref: string) => {
      let found: ExcelJS.Row | undefined;
      ws.eachRow((row) => {
        if (row.getCell(1).value === ref) found = row;
      });
      return found!;
    };
    // Paid On + ref on three; the LTC's sheet amount is tampered with.
    rowOf(REF.ltc).getCell(7).value = "2026-10-15";
    rowOf(REF.ltc).getCell(8).value = "UTR-LTC-1";
    rowOf(REF.ltc).getCell(4).value = 99999;
    rowOf(REF.collect).getCell(7).value = "16/10/2026";
    rowOf(REF.collect).getCell(8).value = "RCPT-77";
    rowOf(REF.tour).getCell(7).value = "2026-10-14";
    // REF.exp is left without a date → not marked.
    const add = (v: any[]) => ws.addRow(v);
    add(["LTC9999/1026", "", "", "", "", "", "2026-10-15", ""]); //       unknown
    add([REF.ltcB, "", "", "", "", "", "2026-10-15", "X"]); //            Finance B's traveller
    add([REF.done, "", "", "", "", "", "2026-10-15", "X"]); //            already reimbursed
    add([REF.early, "", "", "", "", "", "2026-10-15", "X"]); //           not with Finance yet
    add([REF.exp, "", "", "", "", "", "2099-01-01", "X"]); //             future date
    add([REF.ltc, "", "", "", "", "", "2026-10-15", "DUP"]); //           same reference twice
    filled = Buffer.from(await wb.xlsx.writeBuffer());
  });

  it("preview: one outcome per row, the system net, and no writes", async () => {
    const r = ok(await upload("preview", ACT.finA, filled)).body;
    expect(r.dryRun).toBe(true);
    expect(r.batchId).toBeNull();
    expect(r.counts).toEqual({
      REIMBURSED: 3, UNKNOWN_REFERENCE: 1, OUT_OF_SCOPE: 1, ALREADY_REIMBURSED: 2, NOT_WITH_FINANCE: 1, NOT_MARKED: 1, INVALID: 1,
    });
    const by = (ref: string) => r.results.filter((x: any) => x.reference === ref);
    expect(by(REF.ltc)[0]).toMatchObject({ outcome: "REIMBURSED", amount: 350, reason: "Will reimburse ₹350 (the sheet said 99999; the system figure is used)" });
    expect(by(REF.ltc)[1]).toMatchObject({ outcome: "ALREADY_REIMBURSED" });
    expect(by(REF.collect)[0]).toMatchObject({ outcome: "REIMBURSED", amount: 300, direction: "COLLECT" });
    expect(by(REF.exp).map((x: any) => x.outcome)).toEqual(["NOT_MARKED", "INVALID"]);
    expect(by(REF.exp)[1].reason).toBe("Paid On 2099-01-01 is in the future");
    expect(by(REF.ltcB)[0].outcome).toBe("OUT_OF_SCOPE");
    expect(by(REF.early)[0].reason).toBe(`${REF.early} is APPROVED — not with Finance yet`);
    expect((await reqDoc(R.ltc)).status).toBe("TRANSFERRED_TO_FINANCE");
    expect(await col("cstepapprovals").countDocuments({ action: "FINANCE_SETTLE" })).toBe(0);
  });

  it("commit closes the matched cases at the system net, recording Paid On + ref + one batch id", async () => {
    const r = ok(await upload("commit", ACT.finA, filled)).body;
    expect(r.counts.REIMBURSED).toBe(3);
    expect(r.reimbursedInr).toBe(4550); // 350 + 4200 paid out; the 300 collected is not counted
    const batch = new mongoose.Types.ObjectId(r.batchId);

    expect((await reqDoc(R.ltc)).status).toBe("REIMBURSED");
    expect((await reqDoc(R.collect)).status).toBe("SETTLED"); // the claimant repaid the advance
    expect((await reqDoc(R.tour)).status).toBe("REIMBURSED");
    expect((await col("cstepclaims").findOne({ travelRequestId: R.tour }))!.status).toBe("SETTLED");
    for (const id of [R.exp, R.ltcB]) expect((await reqDoc(id)).status).toBe("TRANSFERRED_TO_FINANCE");
    expect((await reqDoc(R.early)).status).toBe("APPROVED");

    const ltc = await settlementOf(R.ltc);
    expect(ltc).toMatchObject({ status: "FINALIZED", outcome: "TO_FINANCE", amountDueByCstep: 350, paymentRef: "UTR-LTC-1", paymentSource: "IMPORT" });
    expect(ltc.paidOn.toISOString()).toBe("2026-10-15T06:30:00.000Z");
    expect(String(ltc.paymentBatchId)).toBe(String(batch));
    const collect = await settlementOf(R.collect);
    expect(collect).toMatchObject({ status: "FINALIZED", paymentRef: "RCPT-77" });
    expect(collect.paidOn.toISOString()).toBe("2026-10-16T06:30:00.000Z");
    const tour = await settlementOf(R.tour);
    expect(tour).toMatchObject({ status: "FINALIZED", amountClaimed: 4200, paymentSource: "IMPORT" });
    expect(tour.paymentRef).toBeUndefined();

    const log = async (id: any) => (await col("cstepapprovals").findOne({ entityId: id, action: "FINANCE_SETTLE" }))!.comment;
    expect(await log(R.ltc)).toBe(`₹350 reimbursed to the claimant | Ref: UTR-LTC-1 | Paid on 2026-10-15 | Import batch ${r.batchId}`);
    expect(await log(R.collect)).toBe(`₹300 received back from the claimant | Ref: RCPT-77 | Paid on 2026-10-16 | Import batch ${r.batchId}`);
    expect(await log(R.tour)).toBe(`₹4200 reimbursed to the traveller | Paid on 2026-10-14 | Import batch ${r.batchId} | Claim ${REF.tour}: SETTLED`);
    expect(await col("cstepapprovals").countDocuments({ action: "FINANCE_SETTLE" })).toBe(3);
  });

  it("re-importing the same sheet changes nothing", async () => {
    const before = (await settlementOf(R.ltc)).updatedAt.toISOString();
    const r = ok(await upload("commit", ACT.finA, filled)).body;
    expect(r.counts.REIMBURSED).toBe(0);
    expect(r.batchId).toBeNull();
    expect(r.counts.ALREADY_REIMBURSED).toBe(5); // LTC, EXP collect, Tour, the old one, the duplicate row
    expect(await col("cstepapprovals").countDocuments({ action: "FINANCE_SETTLE" })).toBe(3);
    expect((await settlementOf(R.ltc)).updatedAt.toISOString()).toBe(before);
  });

  it("the exported queue now holds only what is still open", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await getSheet(ACT.finA, "/export")).body as any);
    const refs: any[] = [];
    wb.worksheets[0].eachRow((row, n) => n > 1 && refs.push(row.getCell(1).value));
    expect(refs).toEqual([REF.exp]);
  });

  it("an Admin who is the traveller's Finance user reimburses their case (CSV, reference as text)", async () => {
    const csv = Buffer.from(`Reference,Paid On,Payment Ref\n${REF.ltcC},2026-10-17,UTR-C\n${REF.exp},2026-10-17,X\n`);
    const r = ok(await upload("commit", ACT.adminFin, csv, "c.csv")).body;
    expect(r.results.map((x: any) => x.outcome)).toEqual(["REIMBURSED", "OUT_OF_SCOPE"]);
    expect((await reqDoc(R.ltcC)).status).toBe("REIMBURSED");
    expect((await reqDoc(R.exp)).status).toBe("TRANSFERRED_TO_FINANCE");
  });
});
