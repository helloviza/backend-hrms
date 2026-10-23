// apps/backend/src/routes/cstep.financeVisibility.test.ts
//
// UAT fixes:
//  1. A case Finance has closed stays visible to Finance. GET /finance-queue
//     used to list only TRANSFERRED_TO_FINANCE, so a case vanished the moment
//     it was reimbursed (Finance was left with its vendor lines on Vendor
//     payments). Now `closed` carries REIMBURSED and repayment-SETTLED cases
//     with what Finance paid; `requests` is still only the to-do list. A
//     nothing-owed SETTLED case never reached Finance and stays off.
//     GET /requests/:id returns the same payment record (financePaid). The
//     My Team report's Closed bucket keeps REIMBURSED (it always did).
//  2. CSV downloads are UTF-8 with a BOM (sendSheet), so Excel shows "—" and
//     "→" instead of "â€”" / "â†’" — and the importer still reads them back.
//
// Real: cstep router, models, sendSheet/parseUploadedRows, in-memory Mongo
//   REPLICA SET on a fresh database, cstep_qc_finance_visibility.
// Stubbed: S3, mail, the PDF helpers, auth (x-test-user), the workspace
//   resolver (x-test-ws). Notifications stay off.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_finance_visibility";
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
  PutObjectCommand: class {},
  GetObjectCommand: class {},
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async () => ({ key: "qc" })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({ key: "qc-packet" })) }));

const { default: cstepRouter } = await import("./cstep.js");
const { sendSheet, parseUploadedRows } = await import("../utils/sheetImport.js");

const DB = "cstep_qc_finance_visibility";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const QC_PROJECT = oid();
const U = { traveller: oid(), manager: oid(), official: oid(), finance: oid(), admin: oid(), stranger: oid() };
const TP = oid();

const app = express();
app.use(express.json());
app.use(
  "/api/cstep",
  (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    req.workspaceObjectId = new mongoose.Types.ObjectId(String(req.headers["x-test-ws"] || WS));
    next();
  },
  cstepRouter,
);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = {
  traveller: who(U.traveller),
  manager: who(U.manager),
  official: who(U.official),
  finance: who(U.finance),
  admin: who(U.admin, ["ADMIN"]),
  stranger: who(U.stranger),
};
const send = (method: "get" | "post" | "patch", as: any, path: string, body?: any) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS));
  return body === undefined ? r : r.send(body);
};
const get = (as: any, path: string) => send("get", as, path);
const post = (as: any, path: string, body: any = {}) =>
  send("post", as, path, path === "/requests" && body.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body);
const patch = (as: any, path: string, body: any = {}) => send("patch", as, path, body);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const ids = (rows: any[] | undefined) => (rows || []).map((r: any) => String(r._id));

const TOUR = {
  type: "DOMESTIC",
  purpose: "Grid study — site visit",
  departureDate: "2026-11-02",
  returnDate: "2026-11-04",
  stations: [{ from: "Bengaluru", to: "Delhi", durationOfStay: "3 days" }],
  modesRequested: ["AIR"],
  transportRequired: false,
  accommodationRequired: false,
  sponsored: false,
  perDiemEligible: false,
};

/** A Tour taken through report → Manager approval → settlement; `fare` 0
 * means nothing is owed. Returns the request id at REPORT_SUBMITTED with a
 * started settlement. */
async function tourToSettlement(fare: number): Promise<string> {
  const id = String(ok(await post(ACT.traveller, "/requests", TOUR)).body.request._id);
  ok(await post(ACT.manager, `/requests/${id}/approve`));
  ok(await post(ACT.official, `/requests/${id}/start-arranging`));
  ok(await post(ACT.official, `/requests/${id}/mark-arranged`));
  ok(await post(ACT.traveller, `/requests/${id}/report/start`));
  if (fare > 0) {
    const leg = ok(
      await post(ACT.traveller, `/requests/${id}/report/legs`, {
        direction: "ONWARD", travelMode: "CAB", paidBy: "SELF", fare, currency: "INR",
        fromLocation: "Airport", toLocation: "Office", fromDate: "2026-11-02", toDate: "2026-11-02",
      }),
    ).body.leg;
    await col("cstepreportlegs").updateOne({ _id: new mongoose.Types.ObjectId(leg._id) }, { $set: { attachmentId: oid() } });
  }
  ok(await post(ACT.traveller, `/requests/${id}/report/submit`));
  ok(await post(ACT.manager, `/requests/${id}/report/approve`));
  ok(await post(ACT.official, `/requests/${id}/settlement/start`));
  return id;
}

let replSet: MongoMemoryReplSet;
const R: { reimbursed: string; withFinance: string; nothingOwed: string; repaid: string } = { reimbursed: "", withFinance: "", nothingOwed: "", repaid: "" };

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

  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "Rajasthan Solar — Phase 2", tallyProjectCC: "100 QC 01", isActive: true } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertOne({
    _id: TP, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "Rao", isActive: true,
    email: `${U.traveller}@qc.local`, claimedBy: U.traveller,
    tourApproverId: U.manager, officialUserId: U.official, financeUserId: U.finance,
  } as any);

  // Reimbursed: paid out by Finance with a reference.
  R.reimbursed = await tourToSettlement(1200);
  ok(await post(ACT.official, `/requests/${R.reimbursed}/settlement/finalize`, { force: true }));
  ok(await post(ACT.finance, `/requests/${R.reimbursed}/finance/settle`, { reference: "UTR-QC-1" }));
  // Still with Finance.
  R.withFinance = await tourToSettlement(800);
  ok(await post(ACT.official, `/requests/${R.withFinance}/settlement/finalize`, { force: true }));
  // Nothing owed: SETTLED at finalize, never with Finance.
  R.nothingOwed = await tourToSettlement(0);
  ok(await post(ACT.official, `/requests/${R.nothingOwed}/settlement/finalize`, { force: true }));
  // A claim whose advance exceeds it: Finance records the repayment → SETTLED.
  const claim = ok(
    await post(ACT.traveller, "/requests", {
      formType: "LOCAL_TRAVEL_CLAIM", purpose: "Local travel — Jaipur → Sanganer", departureDate: "2026-10-05", returnDate: "2026-10-09",
      travelLines: [{ date: "2026-10-06", from: "Office", to: "Sanganer", mode: "CAB", fare: 300, noBill: true }],
      foodLines: [], otherExpenses: 0, advanceTaken: 500,
    }),
  ).body.request;
  R.repaid = String(claim._id);
  ok(await post(ACT.manager, `/requests/${R.repaid}/approve`));
  ok(await post(ACT.admin, `/requests/${R.repaid}/claim/verify`, { force: true }));
  ok(await post(ACT.finance, `/requests/${R.repaid}/finance/settle`, { reference: "RCPT-QC-9" }));
}, 240_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("Finance keeps the cases it has closed", () => {
  it("the fixtures landed where expected", async () => {
    const status = async (id: string) => (await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }))!.status;
    expect(await status(R.reimbursed)).toBe("REIMBURSED");
    expect(await status(R.withFinance)).toBe("TRANSFERRED_TO_FINANCE");
    expect(await status(R.nothingOwed)).toBe("SETTLED");
    expect(await status(R.repaid)).toBe("SETTLED");
  });

  it("finance-queue: `requests` is still only the to-do list; `closed` keeps the paid cases with their payment", async () => {
    const body = ok(await get(ACT.finance, "/finance-queue")).body;
    expect(ids(body.requests)).toEqual([R.withFinance]);
    expect(ids(body.closed).sort()).toEqual([R.reimbursed, R.repaid].sort());
    const reimbursed = body.closed.find((r: any) => r._id === R.reimbursed);
    expect(reimbursed).toMatchObject({ status: "REIMBURSED", travellerName: "Asha Rao" });
    expect(reimbursed.financePaid).toMatchObject({ amountInr: 1200, direction: "PAY_OUT", reference: "UTR-QC-1", source: "MANUAL" });
    expect(reimbursed.financePaid.paidOn).toBeTruthy();
    expect(body.closed.find((r: any) => r._id === R.repaid).financePaid).toMatchObject({ amountInr: 200, direction: "COLLECT", reference: "RCPT-QC-9" });
    expect(body.stageCounts).toEqual({ TRANSFERRED_TO_FINANCE: 1, REIMBURSED: 1, SETTLED: 1 });
  });

  it("a nothing-owed SETTLED case never reached Finance and stays off its board", async () => {
    const body = ok(await get(ACT.finance, "/finance-queue")).body;
    expect(ids(body.closed)).not.toContain(R.nothingOwed);
    expect(ids(body.requests)).not.toContain(R.nothingOwed);
  });

  it("an Admin sees the same; someone mapped to nobody gets an empty board", async () => {
    expect(ids(ok(await get(ACT.admin, "/finance-queue")).body.closed).sort()).toEqual([R.reimbursed, R.repaid].sort());
    const none = ok(await get(ACT.stranger, "/finance-queue")).body;
    expect(none.requests).toEqual([]);
    expect(none.closed || []).toEqual([]);
  });

  it("the case page keeps its Finance record after it is paid", async () => {
    const asFinance = ok(await get(ACT.finance, `/requests/${R.reimbursed}`)).body;
    expect(asFinance.request.status).toBe("REIMBURSED");
    expect(asFinance.financePaid).toMatchObject({ amountInr: 1200, direction: "PAY_OUT", reference: "UTR-QC-1" });
    // The traveller reads it too — it is their own reimbursement.
    expect(ok(await get(ACT.traveller, `/requests/${R.reimbursed}`)).body.financePaid).toMatchObject({ amountInr: 1200 });
    expect(ok(await get(ACT.finance, `/requests/${R.repaid}`)).body.financePaid).toMatchObject({ direction: "COLLECT", amountInr: 200 });
    // Nothing was ever paid on a nothing-owed case.
    expect(ok(await get(ACT.official, `/requests/${R.nothingOwed}`)).body.financePaid).toBeUndefined();
    // Still with Finance: no payment yet, the to-do card's figure instead.
    const pending = ok(await get(ACT.finance, `/requests/${R.withFinance}`)).body;
    expect(pending.financePaid).toBeUndefined();
    expect(pending.financeAmountClaimed).toBe(800);
  });

  it("My Team keeps the reimbursed case in Closed with its figures (unchanged behaviour)", async () => {
    const team = ok(await get(ACT.manager, "/approver-report?period=fy&anchor=2026-11-02")).body;
    const row = team.buckets.closed.find((r: any) => r._id === R.reimbursed);
    expect(row).toMatchObject({ status: "REIMBURSED" });
    expect(row.amounts).toMatchObject({ amountClaimed: 1200, settlementStatus: "FINALIZED" });
  });
});

describe("CSV downloads are UTF-8 with a BOM (sendSheet)", () => {
  const fakeRes = () => {
    const out: { headers: Record<string, string>; body?: Buffer } = { headers: {} };
    return {
      out,
      setHeader: (k: string, v: string) => (out.headers[k.toLowerCase()] = v),
      send: (b: any) => (out.body = Buffer.isBuffer(b) ? b : Buffer.from(String(b), "utf8")),
    };
  };

  it("starts with EF BB BF, says utf-8, and carries — and → as UTF-8 (never mojibake)", async () => {
    const res = fakeRes();
    await sendSheet(res, {
      format: "csv",
      filename: "qc",
      sheetName: "QC",
      columns: ["Project", "Route"],
      rows: [["Rajasthan Solar — Phase 2", "Jaipur → Jodhpur"]],
    });
    const bytes = res.out.body!;
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.out.headers["content-type"]).toBe("text/csv; charset=utf-8");
    const text = bytes.toString("utf8");
    expect(text).toContain("Rajasthan Solar — Phase 2");
    expect(text).toContain("Jaipur → Jodhpur");
    expect(text).not.toContain("â€");
    // The em dash is E2 80 94 and the arrow E2 86 92 — the bytes Excel
    // shows as "â€”" / "â†’" when it is not told the file is UTF-8.
    expect(bytes.includes(Buffer.from([0xe2, 0x80, 0x94]))).toBe(true);
    expect(bytes.includes(Buffer.from([0xe2, 0x86, 0x92]))).toBe(true);
  });

  it("the importer reads a BOM'd export back with its first header intact", async () => {
    const res = fakeRes();
    await sendSheet(res, { format: "csv", filename: "qc", sheetName: "QC", columns: ["Project", "Route"], rows: [["Solar — Phase 2", "A → B"]] });
    const rows = await parseUploadedRows({ originalname: "qc.csv", mimetype: "text/csv", buffer: res.out.body });
    expect(rows).toEqual([{ Project: "Solar — Phase 2", Route: "A → B" }]);
  });

  it("the xlsx path is untouched (no BOM, binary workbook)", async () => {
    const res = fakeRes();
    await sendSheet(res, { format: "xlsx", filename: "qc", sheetName: "QC", columns: ["Project"], rows: [["Solar — Phase 2"]] });
    const bytes = res.out.body!;
    expect([...bytes.subarray(0, 2)]).toEqual([0x50, 0x4b]); // "PK" — a zip
    const rows = await parseUploadedRows({ originalname: "qc.xlsx", buffer: bytes });
    expect(rows).toEqual([{ Project: "Solar — Phase 2" }]);
  });
});
