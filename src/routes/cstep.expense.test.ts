// apps/backend/src/routes/cstep.expense.test.ts
//
// CSTEP claims module 2 — the Expense Claim driven end to end through the
// real CSTEP router on the module-1 claim foundation: intake (expense lines,
// one tax amount, line-level and claim-level tax invoices staged before the
// claim exists), submit → manager (Tour Approver slot) approve → CSTEP Admin
// verify → Finance pay, with subtotal + tax − advance math in every
// direction. Also: an approved expense claim is never pulled into
// arrangement or a report-based settlement and never reaches the Official's
// Processing board; its lines land in the settlement "other" bucket; it
// renders its own PDF (never the Tour Proposal or Local Travel layout); and
// it stays OUT of the Travel Register.
//
// Real: cstep router, models, the claim PDF renderer (its S3 put is
//   captured), the register workbook, in-memory Mongo REPLICA SET (approve
//   runs in a transaction) on a fresh database, cstep_qc_expense.
// Stubbed: S3 upload/presign, mail, the Event Request + packet PDF helpers,
//   auth (x-test-user) and the workspace resolver (x-test-ws).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_expense";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
// Notifications ship dormant — and stay off here.
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

const s3Puts = vi.hoisted(() => [] as Array<{ Key: string; Body: Buffer }>);
const presigned = vi.hoisted(() => [] as any[]);
let uploadSeq = 0;
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: any) {
      s3Puts.push(cmd.input);
      return {};
    }
  },
  PutObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async (args: any) => ({ key: `${args.keyPrefix}/qc-${++uploadSeq}` })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({
  presignGetObject: vi.fn(async (args: any) => {
    presigned.push(args);
    return "http://qc/presigned";
  }),
}));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({ key: "qc-packet" })) }));

const { default: cstepRouter } = await import("./cstep.js");

const DB = "cstep_qc_expense";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
// Project Master — every request needs a project picked from the master.
// One QC project, added to a create body that names none (QC_PROJECT seeded
// in beforeAll).
const QC_PROJECT = oid();
const withProject = (path: string, body: any) =>
  path === "/requests" && body && body.projectId === undefined ? { ...body, projectId: String(QC_PROJECT) } : body;
const U = { traveller: oid(), approver: oid(), official: oid(), finance: oid(), admin: oid(), other: oid() };
const TP = { main: oid(), other: oid() };

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
  approver: who(U.approver, ["APPROVER"]),
  official: who(U.official),
  finance: who(U.finance),
  admin: who(U.admin, ["ADMIN"]),
  other: who(U.other),
};
const send = (method: "get" | "post" | "patch", as: any, path: string, body?: any) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS));
  return body === undefined ? r : r.send(body);
};
const post = (as: any, path: string, body: any = {}) => send("post", as, path, withProject(path, body));
const patch = (as: any, path: string, body: any = {}) => send("patch", as, path, body);
const get = (as: any, path: string) => send("get", as, path);
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const stage = async (as: any, name = "invoice.pdf") =>
  String(
    ok(
      await request(app)
        .post("/api/cstep/attachments/staging")
        .set("x-test-user", JSON.stringify(as))
        .set("x-test-ws", String(WS))
        .field("documentType", "TAX_INVOICE")
        .attach("file", Buffer.from("%PDF-1.4 qc tax invoice"), { filename: name, contentType: "application/pdf" }),
    ).body.attachment._id,
  );

// References carry the IST month (utils/cstepSequence.ts), not server time.
const MMYY = (() => {
  const d = new Date(Date.now() + 330 * 60 * 1000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
})();

const expenseBody = (over: any = {}) => ({
  formType: "EXPENSE_CLAIM",
  purpose: "Workshop materials and courier",
  project: "PRJ-BILL-TO",
  departureDate: "2026-10-12",
  returnDate: "2026-10-16",
  expenseLines: [],
  ...over,
});

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
  await col("cstepprojects").insertOne({ _id: QC_PROJECT, workspaceId: WS, projectCode: "PRJ-QC", projectName: "QC Project", tallyProjectCC: "100 QC 01", isActive: true } as any);

  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertMany([
    {
      _id: TP.main, workspaceId: WS, travelerId: "CSTEP-001", firstName: "Asha", lastName: "Rao", isActive: true,
      email: `${U.traveller}@qc.local`, claimedBy: U.traveller,
      tourApproverId: U.approver, officialUserId: U.official, financeUserId: U.finance,
    },
    { _id: TP.other, workspaceId: WS, travelerId: "CSTEP-002", firstName: "Ravi", lastName: "K", isActive: true, email: `${U.other}@qc.local`, claimedBy: U.other, tourApproverId: U.approver },
  ] as any[]);
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("Expense Claim — validation and intake", () => {
  it("needs at least one expense line", async () => {
    const r = await post(ACT.traveller, "/requests", expenseBody());
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Add at least one expense line");
  });

  it("a line with no invoice of its own needs a claim-level tax invoice (no declaration path)", async () => {
    const r = await post(ACT.traveller, "/requests", expenseBody({
      expenseLines: [{ date: "2026-10-12", description: "Stationery", amount: 300 }],
    }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/attach its invoice, or attach the tax invoice for the whole claim/);
  });

  it("lines must have a description, a positive amount and a date inside the period", async () => {
    const inv = await stage(ACT.traveller);
    for (const [line, msg] of [
      [{ date: "2026-10-12", amount: 300, attachmentId: inv }, /description is required/],
      [{ date: "2026-10-12", description: "X", amount: 0, attachmentId: inv }, /amount must be more than zero/],
      [{ date: "2026-10-30", description: "X", amount: 10, attachmentId: inv }, /within the claim period/],
    ] as const) {
      const r = await post(ACT.traveller, "/requests", expenseBody({ expenseLines: [line] }));
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(msg);
    }
    const tax = await post(ACT.traveller, "/requests", expenseBody({
      expenseLines: [{ date: "2026-10-12", description: "X", amount: 10, attachmentId: inv }], taxAmount: -5,
    }));
    expect(tax.status).toBe(400);
    expect(tax.body.error).toMatch(/Tax amount/);
  });

  it("someone else's staged invoice cannot be attached, at line or claim level", async () => {
    const theirs = await stage(ACT.other, "theirs.pdf");
    const line = await post(ACT.traveller, "/requests", expenseBody({
      expenseLines: [{ date: "2026-10-12", description: "X", amount: 10, attachmentId: theirs }],
    }));
    expect(line.status).toBe(400);
    expect(line.body.error).toMatch(/not yours to attach/);
    const claimLevel = await post(ACT.traveller, "/requests", expenseBody({
      expenseLines: [{ date: "2026-10-12", description: "X", amount: 10 }], invoiceAttachmentIds: [theirs],
    }));
    expect(claimLevel.status).toBe(400);
    expect(claimLevel.body.error).toMatch(/not yours to attach/);
  });
});

describe("Expense Claim — end to end: submit → approve → Admin verify → Finance pay", () => {
  let id = "";
  let ref = "";
  let lineInvoice = "";
  let claimInvoice = "";
  let lineIds: string[] = [];

  it("saves a draft: Local Travel / Tour fields stripped, both invoices linked, subtotal + tax − advance stored", async () => {
    lineInvoice = await stage(ACT.traveller, "cartridges-invoice.pdf");
    claimInvoice = await stage(ACT.traveller, "igst-tax-invoice.pdf");
    const r = ok(
      await post(ACT.traveller, "/requests", expenseBody({
        saveDraft: true,
        type: "DOMESTIC", // Tour-only — dropped
        travelLines: [{ date: "2026-10-12", from: "A", to: "B", mode: "CAB", fare: 99, noBill: true }], // Local Travel-only — dropped
        otherExpenses: 77, // Local Travel-only — dropped
        expenseLines: [
          { date: "2026-10-12", description: "Printer cartridges", amount: 2000, attachmentId: lineInvoice },
          { date: "2026-10-13", description: "Courier to client", amount: 500 },
        ],
        invoiceAttachmentIds: [claimInvoice],
        taxAmount: 450,
        advanceTaken: 1000,
      })),
    );
    const doc = r.body.request;
    id = String(doc._id);
    expect(doc.formType).toBe("EXPENSE_CLAIM");
    expect(doc.type).toBeUndefined();
    expect(doc.travelLines).toBeUndefined();
    expect(doc.otherExpenses).toBeUndefined();
    expect(doc.foodLines).toBeUndefined();
    expect(doc.claimTotals).toEqual({
      travel: 0, food: 0, other: 0, subtotal: 2500, tax: 450, gross: 2950, advance: 1000, net: 1950, dueByCstep: 1950, dueToCstep: 0,
    });
    lineIds = doc.expenseLines.map((l: any) => String(l._id));
    expect(doc.invoiceAttachmentIds.map(String)).toEqual([claimInvoice]);

    for (const att of [lineInvoice, claimInvoice]) {
      const a = await col("cstepattachments").findOne({ _id: new mongoose.Types.ObjectId(att) });
      expect(String(a!.travelRequestId)).toBe(id);
      expect(a!.documentType).toBe("TAX_INVOICE");
    }
  });

  it("an edit re-stores the totals (tax changed)", async () => {
    const r = ok(await patch(ACT.traveller, `/requests/${id}`, { taxAmount: 360 }));
    expect(r.body.request.claimTotals).toMatchObject({ subtotal: 2500, tax: 360, gross: 2860, net: 1860, dueByCstep: 1860 });
    ok(await patch(ACT.traveller, `/requests/${id}`, { taxAmount: 450 }));
  });

  it("submits → the traveller's manager (Tour Approver) sees it; return → resubmit works", async () => {
    ok(await post(ACT.traveller, `/requests/${id}/submit`));
    expect(ok(await get(ACT.approver, "/approvals")).body.requests.map((r: any) => String(r._id))).toContain(id);
    ok(await post(ACT.approver, `/requests/${id}/return`, { reason: "Name the courier vendor" }));
    ok(await patch(ACT.traveller, `/requests/${id}`, {
      expenseLines: [
        { _id: lineIds[0], date: "2026-10-12", description: "Printer cartridges", amount: 2000, attachmentId: lineInvoice },
        { _id: lineIds[1], date: "2026-10-13", description: "Courier to client (BlueDart)", amount: 500 },
      ],
    }));
    ok(await post(ACT.traveller, `/requests/${id}/submit`));
    const trail = await col("cstepapprovals").find({ entityId: new mongoose.Types.ObjectId(id) }).sort({ at: 1 }).toArray();
    expect(trail.map((t: any) => t.action)).toEqual(["SUBMIT", "RETURN", "RESUBMIT"]);
  });

  it("APPROVE → EXC reference, no TIN/CstepClaim, settlement seeded: expense lines + tax, all in the 'other' bucket", async () => {
    const r = ok(await post(ACT.approver, `/requests/${id}/approve`));
    ref = r.body.claimReference;
    expect(ref).toBe(`EXP0001/${MMYY}`);
    expect(r.body.claim).toBeNull();
    expect(await col("cstepclaims").countDocuments({})).toBe(0);

    const settlement = (await col("cstepsettlements").findOne({ requestId: new mongoose.Types.ObjectId(id) }))!;
    expect(settlement.status).toBe("VERIFYING");
    expect(settlement.perDiem.amountInr).toBe(0);
    expect(settlement.buckets).toEqual({ airRailBus: 0, perDiem: 0, boardingLodging: 0, cab: 0, other: 2950 });
    expect(settlement.amountClaimed).toBe(2950);
    expect(settlement.advanceTaken).toBe(1000);
    expect(settlement.amountDueByCstep).toBe(1950);
    expect(settlement.amountDueToCstep).toBe(0);

    const lines = await col("cstepsettlementlines").find({ settlementId: settlement._id }).sort({ _id: 1 }).toArray();
    expect(lines.map((l: any) => [l.source, l.mode, l.description, l.amountInr])).toEqual([
      ["CLAIM_LINE", "OTHER", "Printer cartridges", 2000],
      ["CLAIM_LINE", "OTHER", "Courier to client (BlueDart)", 500],
      ["CLAIM_LINE", "OTHER", "Tax (IGST)", 450],
    ]);
    expect(lines.map((l: any) => String(l.sourceId))).toEqual([...lineIds, id]);
    // The line's own invoice; the claim-level invoice covers the line without one and the tax row.
    expect(lines.map((l: any) => String(l.attachmentId))).toEqual([lineInvoice, claimInvoice, claimInvoice]);
  });

  it("opening the approved expense claim triggers neither arranging nor settlement", async () => {
    for (const as of [ACT.official, ACT.admin]) {
      const g = ok(await get(as, `/requests/${id}`)).body;
      expect(g.canArrange).toBe(false);
      expect(g.arrangements).toEqual([]);
      expect(g.claimDeclaration).toBeUndefined(); // no Declaration path for an Expense Claim
    }
    expect(ok(await get(ACT.admin, `/requests/${id}`)).body.canVerifyClaim).toBe(true);
    expect((await post(ACT.official, `/requests/${id}/start-arranging`)).status).toBe(409);
    expect((await post(ACT.admin, `/requests/${id}/start-arranging`)).status).toBe(409);
    expect((await post(ACT.admin, `/requests/${id}/settlement/start`)).status).toBe(409);
    const doc = (await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }))!;
    expect(doc.status).toBe("APPROVED");
    expect(await col("cstepapprovals").countDocuments({ entityId: doc._id, action: { $in: ["START_ARRANGING", "START_VERIFICATION"] } })).toBe(0);
    expect(await col("cstepsettlements").countDocuments({ requestId: doc._id })).toBe(1);

    expect(ok(await get(ACT.official, "/official-queue")).body.requests.map((r: any) => String(r._id))).not.toContain(id);
    expect(ok(await get(ACT.admin, "/official-queue")).body.requests.map((r: any) => String(r._id))).not.toContain(id);
    const verify = ok(await get(ACT.admin, "/claim-verification-queue")).body;
    expect(verify.requests.map((r: any) => String(r._id))).toContain(id);
  });

  it("the detail payload carries both invoices", async () => {
    const g = ok(await get(ACT.traveller, `/requests/${id}`)).body;
    expect(Object.keys(g.claimAttachments).sort()).toEqual([lineInvoice, claimInvoice].sort());
  });

  it("only the Admin verifies; every line verified → TRANSFERRED_TO_FINANCE with the net figure", async () => {
    expect((await get(ACT.official, `/requests/${id}/settlement`)).status).toBe(403);
    const lines = ok(await get(ACT.admin, `/requests/${id}/settlement`)).body.lines;
    expect((await patch(ACT.official, `/requests/${id}/settlement/lines/${lines[0]._id}`, { verified: true })).status).toBe(403);
    expect((await post(ACT.admin, `/requests/${id}/claim/verify`)).status).toBe(409); // unverified lines
    for (const l of lines) ok(await patch(ACT.admin, `/requests/${id}/settlement/lines/${l._id}`, { verified: true }));
    expect((await post(ACT.official, `/requests/${id}/claim/verify`)).status).toBe(403);

    const v = ok(await post(ACT.admin, `/requests/${id}/claim/verify`)).body;
    expect(v.request.status).toBe("TRANSFERRED_TO_FINANCE");
    expect(v.settlement.amountDueByCstep).toBe(1950);

    const g = ok(await get(ACT.finance, `/requests/${id}`)).body;
    expect(g.canFinance).toBe(true);
    expect(g.financeClaimDue).toEqual({ amountDueByCstep: 1950, amountDueToCstep: 0, advanceTaken: 1000 });
    expect(ok(await get(ACT.finance, "/finance-queue")).body.requests.map((r: any) => String(r._id))).toContain(id);
  });

  it("Finance pays → REIMBURSED, settlement finalized", async () => {
    ok(await post(ACT.finance, `/requests/${id}/finance/settle`, { reference: "UTR-EXP-1" }));
    const doc = (await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }))!;
    expect(doc.status).toBe("REIMBURSED");
    const settlement = (await col("cstepsettlements").findOne({ requestId: doc._id }))!;
    expect(settlement.status).toBe("FINALIZED");
    const pay = await col("cstepapprovals").findOne({ entityId: doc._id, action: "FINANCE_SETTLE" });
    expect(pay!.comment).toBe("₹1950 reimbursed to the claimant | Ref: UTR-EXP-1");
  });

  it("renders the Expense Claim PDF — not the Tour Proposal or Local Travel layout; no packet", async () => {
    s3Puts.length = 0;
    presigned.length = 0;
    ok(await get(ACT.traveller, `/requests/${id}/pdf`));
    expect(s3Puts).toHaveLength(1);
    expect(s3Puts[0].Key).toMatch(/^cstep-claims\/.+\/expense-claim-\d+\.pdf$/);
    expect(Buffer.from(s3Puts[0].Body).subarray(0, 5).toString()).toBe("%PDF-");
    expect(presigned[0].filename).toBe(`Expense-Claim-${ref}.pdf`);
    expect((await get(ACT.traveller, `/requests/${id}/packet`)).status).toBe(409);
  });

  it("stays OUT of the Travel Register", async () => {
    const r = await request(app)
      .get("/api/cstep/reports/travel-register?period=custom&from=2026-10-01&to=2026-10-31")
      .set("x-test-user", JSON.stringify(ACT.finance))
      .set("x-test-ws", String(WS))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as any); // exceljs types want a non-generic Buffer
    const rows: any[][] = [];
    wb.getWorksheet("Travel Register")!.eachRow((row) => rows.push((row.values as any[]).slice(1)));
    expect(rows.length).toBeGreaterThanOrEqual(2); // title + header still render
    expect(rows.some((v) => v[1] === ref)).toBe(false);
    expect(rows.some((v) => v[4] === "Workshop materials and courier")).toBe(false);
  });
});

describe("Expense Claim — advance in the other directions", () => {
  const fileAndApprove = async (over: any) => {
    const inv = await stage(ACT.traveller);
    const r = ok(await post(ACT.traveller, "/requests", expenseBody({ invoiceAttachmentIds: [inv], ...over })));
    const cid = String(r.body.request._id);
    ok(await post(ACT.approver, `/requests/${cid}/approve`));
    const lines = ok(await get(ACT.admin, `/requests/${cid}/settlement`)).body.lines;
    for (const l of lines) ok(await patch(ACT.admin, `/requests/${cid}/settlement/lines/${l._id}`, { verified: true }));
    return { cid, totals: r.body.request.claimTotals };
  };

  it("advance > total → due TO CSTEP; Finance records the repayment → SETTLED", async () => {
    const { cid, totals } = await fileAndApprove({
      expenseLines: [{ date: "2026-10-14", description: "Taxi to venue", amount: 400 }], taxAmount: 72, advanceTaken: 1000,
    });
    expect(totals).toMatchObject({ subtotal: 400, tax: 72, gross: 472, net: -528, dueByCstep: 0, dueToCstep: 528 });
    const v = ok(await post(ACT.admin, `/requests/${cid}/claim/verify`)).body;
    expect(v.request.status).toBe("TRANSFERRED_TO_FINANCE");
    expect(v.settlement.amountDueToCstep).toBe(528);
    ok(await post(ACT.finance, `/requests/${cid}/finance/settle`));
    expect((await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(cid) }))!.status).toBe("SETTLED");
    const pay = await col("cstepapprovals").findOne({ entityId: new mongoose.Types.ObjectId(cid), action: "FINANCE_SETTLE" });
    expect(pay!.comment).toBe("₹528 received back from the claimant");
  });

  it("advance == total → Admin verify closes it SETTLED without Finance; later claims take the next EXP serials", async () => {
    const { cid } = await fileAndApprove({
      expenseLines: [{ date: "2026-10-15", description: "Hall booking", amount: 1000 }], taxAmount: 180, advanceTaken: 1180,
    });
    const v = ok(await post(ACT.admin, `/requests/${cid}/claim/verify`)).body;
    expect(v.request.status).toBe("SETTLED");
    expect(v.settlement.outcome).toBe("CLOSE");
    const refs = (await col("csteptravelrequests").find({ formType: "EXPENSE_CLAIM", claimReference: { $exists: true } }).toArray()).map(
      (d: any) => d.claimReference,
    );
    expect(refs).toEqual(expect.arrayContaining([`EXP0001/${MMYY}`, `EXP0002/${MMYY}`, `EXP0003/${MMYY}`]));
  });
});
