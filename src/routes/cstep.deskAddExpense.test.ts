// apps/backend/src/routes/cstep.deskAddExpense.test.ts
//
// Module C — POST /requests/:id/settlement/lines: the Travel Desk adds an
// expense while verifying a submitted report (REPORT_SUBMITTED, settlement
// VERIFYING). No Manager re-approval; the document is optional.
//   - Reimbursable → a PERSONAL DESK_EXPENSE line (generated sourceId):
//     amountClaimed rises, and it reaches the reimbursement Tally by its
//     category once Finance pays the case.
//   - Company-paid → a CstepArrangement row (ADDED, ARRANGED) + its OFFICIAL
//     ARRANGEMENT line: totalCostOfTour rises, and it reaches the vendor
//     Tally once its vendor is paid.
// Then the totals are recomputed, both PDFs flagged stale, the packet lists
// the expense, and ADD_SETTLEMENT_LINE is logged with the Desk as actor.
// A company-paid add needs its vendor. Both kinds survive a report
// send-back and come back onto the next settlement as the Desk added them.
//
// Real: cstep + tally routers, models, sequence engine, in-memory Mongo
//   REPLICA SET on a fresh database, cstep_qc_desk_expense. The packet
//   renderer is real in its own test below (no S3 — no documents there).
// Stubbed: S3, mail, the packet/event uploaders, auth (x-test-user), the
//   workspace resolver.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_desk_expense";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async (args: any) => ({ key: `${args.keyPrefix}/qc` })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({ key: "qc-packet" })) }));
// R.ret's no-bill leg makes report/submit render its declaration — never to S3 here.
vi.mock("../utils/cstepClaimPdf.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  uploadCstepClaimDeclarationPdf: vi.fn(async () => ({ key: "qc-declaration" })),
}));

const { default: cstepRouter } = await import("./cstep.js");
const { default: tallyRouter } = await import("./cstep.tally.js");
const packetPdf = await import("../utils/cstepPacketPdf.js");

const DB = "cstep_qc_desk_expense";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const WS = oid();
const U = { traveller: oid(), desk: oid(), finance: oid(), admin: oid(), plain: oid(), approver: oid() };
const TP = oid();
const VT = oid();
const VENDOR = oid();
// R.main: the case the Desk adds to. R.pending: still with the traveller.
// R.unopened: submitted, settlement not opened yet. R.claim: a claim.
// R.ret: sent back to the traveller after the Desk added expenses.
const R = { main: oid(), pending: oid(), unopened: oid(), claim: oid(), ret: oid() };
const FLIGHT_ARR = oid();
const CAB_LEG = oid();

const fakeAuth = (req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceObjectId = WS;
  next();
};
const app = express();
app.use(express.json());
app.use("/api/cstep/tally", fakeAuth, tallyRouter);
app.use("/api/cstep", fakeAuth, cstepRouter);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = {
  traveller: who(U.traveller), desk: who(U.desk), finance: who(U.finance), admin: who(U.admin, ["ADMIN"]), plain: who(U.plain),
  approver: who(U.approver, ["APPROVER"]),
};
const send = (method: "get" | "put" | "post" | "patch", as: any, path: string, body?: any) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as));
  return body === undefined ? r : r.send(body);
};
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const add = (as: any, id: any, body: any) => send("post", as, `/requests/${id}/settlement/lines`, body);
/** The same POST as multipart, with a document. */
const addWithFile = (as: any, id: any, body: Record<string, any>, filename = "bill.pdf") => {
  let r = request(app).post(`/api/cstep/requests/${id}/settlement/lines`).set("x-test-user", JSON.stringify(as));
  for (const [k, v] of Object.entries(body)) r = r.field(k, String(v));
  return r.attach("file", Buffer.from("%PDF-1.4 qc"), { filename, contentType: "application/pdf" });
};

const TODAY = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
const FROM = "2026-10-01";
async function tallyRows(kind: string): Promise<any[][]> {
  const r = await request(app)
    .get(`/api/cstep/tally/export?kind=${kind}&from=${FROM}&to=${TODAY}`)
    .set("x-test-user", JSON.stringify(ACT.admin))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  if (r.status !== 200) throw new Error(`${r.status} ${r.body.toString()}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.body as any);
  const rows: any[][] = [];
  wb.worksheets[0].eachRow((row, n) => n > 1 && rows.push(Array.from({ length: 25 }, (_, i) => row.getCell(i + 1).value ?? "")));
  return rows;
}
/** [ledger, Dr/Cr, amount] per row. */
const shape = (rows: any[][]) => rows.map((x) => [x[4], x[5], x[14]]);

const settlementOf = async (id: any) => (await col("cstepsettlements").findOne({ requestId: id })) as any;
const staleFlags = async (id: any) => {
  const r: any = await col("csteptravelrequests").findOne({ _id: id });
  return { pdfStale: r.pdfStale, packetStale: r.packetStale };
};
const clearStale = (id: any) => col("csteptravelrequests").updateOne({ _id: id }, { $set: { pdfStale: false, packetStale: false } });

let replSet: MongoMemoryReplSet;
beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri(DB);
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  if ((await mongoose.connection.db!.listCollections().toArray()).length) throw new Error(`Step 0: ${DB} is not empty`);
  await mongoose.connection.syncIndexes();

  const now = new Date();
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, firstName: k, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertOne({
    _id: TP, workspaceId: WS, travelerId: "E-001", employeeId: "E-001", firstName: "Asha", lastName: "Rao", isActive: true,
    claimedBy: U.traveller, officialUserId: U.desk, financeUserId: U.finance, tourApproverId: U.approver, workLocation: "Bengaluru",
  } as any);
  await col("cstepvendortypes").insertOne({ _id: VT, workspaceId: WS, name: "Hotel", isActive: true } as any);
  await col("cstepvendors").insertOne({ _id: VENDOR, workspaceId: WS, vendorCode: "CSTEPVEN0001", name: "Lakeview Inn", vendorTypeId: VT, isActive: true, createdAt: now, updatedAt: now } as any);

  const reqDoc = (_id: any, status: string, ref: string, formType = "TOUR_PROPOSAL") => ({
    _id, workspaceId: WS, travelerProfileId: TP, createdBy: U.traveller, formType, type: "DOMESTIC", purpose: `QC ${ref}`,
    departureDate: "2026-10-20", returnDate: "2026-10-22", perDiemEligible: false, status, claimReference: ref,
    project: "PRJ-ENERGY", stations: [{ from: "Bengaluru", to: "Mumbai" }], createdAt: now, updatedAt: now,
  });
  await col("csteptravelrequests").insertMany([
    reqDoc(R.main, "REPORT_SUBMITTED", "0001/1126"),
    reqDoc(R.pending, "REPORT_PENDING", "0002/1126"),
    reqDoc(R.unopened, "REPORT_SUBMITTED", "0003/1126"),
    reqDoc(R.claim, "APPROVED", "EXP0001/1126", "EXPENSE_CLAIM"),
    reqDoc(R.ret, "REPORT_SUBMITTED", "0004/1126"),
  ] as any[]);
  // R.ret: one self-paid cab leg, ticked "No bill available" (so it resubmits).
  await col("cstepreportlegs").insertOne({
    _id: oid(), workspaceId: WS, requestId: R.ret, direction: "ONWARD", travelMode: "CAB", fare: 400, currency: "INR",
    paidBy: "SELF", source: "ADDED", noBill: true, createdBy: U.traveller, createdAt: now, updatedAt: now,
  } as any);
  // R.main: a booked flight (no vendor) and a self-paid cab leg.
  await col("csteparrangements").insertOne({
    _id: FLIGHT_ARR, workspaceId: WS, requestId: R.main, source: "REQUESTED", requestedType: "FLIGHT", arrangedType: "FLIGHT",
    status: "ARRANGED", currency: "INR", amount: 9000, exchangeRate: 1, amountInr: 9000, paymentStatus: "UNPAID",
    createdBy: U.desk, createdAt: now, updatedAt: now,
  } as any);
  await col("cstepreportlegs").insertOne({
    _id: CAB_LEG, workspaceId: WS, requestId: R.main, direction: "ONWARD", travelMode: "CAB", fare: 400, currency: "INR",
    paidBy: "SELF", source: "ADDED", fromLocation: "Airport", toLocation: "Hotel", createdBy: U.traveller, createdAt: now, updatedAt: now,
  } as any);

  // The Tally settings both exports need.
  ok(await send("put", ACT.admin, "/tally/settings", {
    companyName: "CSTEP",
    ledgerMap: [{ vendorTypeId: String(VT), ledger: "Lodging Expenses" }],
    locationMap: [{ location: "Bengaluru", code: "BLR-HQ" }],
    reimbursement: {
      defaultLedger: "Travel Expenses - Other",
      categoryLedgerMap: [
        { category: "CAB", ledger: "Local Conveyance" },
        { category: "FOOD", ledger: "Staff Welfare - Meals" },
      ],
      advanceLedger: "Staff Advances",
    },
  }));

  // The Desk opens the settlement: flight ₹9,000 Official, cab ₹400 Personal.
  const started = ok(await send("post", ACT.desk, `/requests/${R.main}/settlement/start`, {})).body;
  expect(started.lines).toHaveLength(2);
  expect(started.settlement.totalCostOfTour).toBe(9400);
  expect(started.settlement.amountClaimed).toBe(400);
}, 240_000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

const FOOD = { category: "FOOD", amount: 650, currency: "INR", description: "Team dinner, client site", payment: "REIMBURSABLE" };

describe("the gate", () => {
  it("only this traveller's Travel Desk (or a CSTEP Admin) may add", async () => {
    for (const as of [ACT.traveller, ACT.plain, ACT.finance]) {
      const r = await add(as, R.main, FOOD);
      expect(r.status).toBe(403);
    }
    expect(await col("cstepsettlementlines").countDocuments({ requestId: R.main })).toBe(2);
  });

  it("only at REPORT_SUBMITTED with the settlement VERIFYING; never on a claim", async () => {
    expect((await add(ACT.desk, R.pending, FOOD)).status).toBe(409);
    const unopened = await add(ACT.desk, R.unopened, FOOD);
    expect(unopened.status).toBe(409);
    expect(unopened.body.error).toMatch(/Open the settlement/);
    expect((await add(ACT.admin, R.claim, FOOD)).status).toBe(409);
    expect(await col("cstepsettlementlines").countDocuments({ requestId: { $in: [R.pending, R.unopened, R.claim] } })).toBe(0);
  });

  it("bad input is 400 and writes nothing", async () => {
    const bad = async (patch: any) => (await add(ACT.desk, R.main, { ...FOOD, ...patch })).status;
    expect(await bad({ category: "PER_DIEM" })).toBe(400);
    expect(await bad({ category: "NOPE" })).toBe(400);
    expect(await bad({ payment: "" })).toBe(400);
    expect(await bad({ amount: 0 })).toBe(400);
    expect(await bad({ amount: -5 })).toBe(400);
    expect(await bad({ description: "  " })).toBe(400);
    expect(await bad({ currency: "USD" })).toBe(400); // no exchange rate
    expect(await bad({ vendorId: String(VENDOR) })).toBe(400); // a vendor on a reimbursable expense
    expect(await bad({ payment: "COMPANY_PAID", vendorId: String(oid()) })).toBe(404);
    const noVendor = await add(ACT.desk, R.main, { ...FOOD, payment: "COMPANY_PAID" });
    expect(noVendor.status).toBe(400);
    expect(noVendor.body.error).toBe("Choose the vendor for a company-paid expense");
    expect((await add(ACT.desk, R.main, { ...FOOD, payment: "COMPANY_PAID", vendorId: "  " })).status).toBe(400);
    expect(await col("cstepsettlementlines").countDocuments({ requestId: R.main })).toBe(2);
    expect(await col("csteparrangements").countDocuments({ requestId: R.main })).toBe(1);
  });
});

describe("adding", () => {
  it("reimbursable, no document: a PERSONAL DESK_EXPENSE line; amountClaimed rises; stale + audit", async () => {
    await clearStale(R.main);
    const r = ok(await add(ACT.desk, R.main, FOOD));
    expect(r.status).toBe(201);
    const line = r.body.line;
    expect(line).toMatchObject({
      source: "DESK_EXPENSE", classification: "PERSONAL", category: "FOOD", mode: "OTHER", amountInr: 650, claimedAmountInr: 650,
      description: "Team dinner, client site", verified: true, deskAdded: true,
    });
    expect(line.attachmentId).toBeUndefined();
    expect(mongoose.isValidObjectId(line.sourceId)).toBe(true);
    expect(r.body.arrangement).toBeUndefined();
    expect(await col("csteparrangements").countDocuments({ requestId: R.main })).toBe(1);

    expect(r.body.settlement.amountClaimed).toBe(1050);
    expect(r.body.settlement.totalCostOfTour).toBe(10050);
    const s = await settlementOf(R.main);
    expect([s.amountClaimed, s.totalCostOfTour, s.buckets.other]).toEqual([1050, 10050, 650]);
    expect(await staleFlags(R.main)).toEqual({ pdfStale: true, packetStale: true });

    const audit: any[] = await col("cstepapprovals").find({ entityId: R.main, action: "ADD_SETTLEMENT_LINE" }).toArray();
    expect(audit).toHaveLength(1);
    expect(String(audit[0].actor)).toBe(String(U.desk));
    expect(audit[0].stage).toBe("OFFICIAL");
    expect(audit[0].adminOverride).toBeUndefined();
    expect(audit[0].comment).toBe("Added expense — Food: ₹650, reimbursable — Team dinner, client site");
  });

  it("reimbursable, foreign, with a document: INR at the rate, the document on the line", async () => {
    const r = ok(await addWithFile(ACT.desk, R.main, { category: "OTHER", amount: 10, currency: "USD", exchangeRate: 83.5, description: "Visa photos", payment: "REIMBURSABLE" }, "photos.pdf"));
    expect(r.body.line).toMatchObject({ source: "DESK_EXPENSE", amountInr: 835, classification: "PERSONAL" });
    expect(r.body.line.attachmentId).toBeTruthy();
    const att: any = await col("cstepattachments").findOne({ _id: new mongoose.Types.ObjectId(r.body.line.attachmentId) });
    expect(att.originalName).toBe("photos.pdf");
    expect(String(att.travelRequestId)).toBe(String(R.main));
    expect(r.body.settlement.amountClaimed).toBe(1885);
    const comment = ((await col("cstepapprovals").find({ entityId: R.main, action: "ADD_SETTLEMENT_LINE" }).sort({ at: -1 }).limit(1).toArray()) as any[])[0].comment;
    expect(comment).toBe("Added expense — Other: ₹835 (10 USD @ 83.5), reimbursable — Visa photos | Document: photos.pdf");
  });

  it("company-paid, with vendor + document: an ADDED arrangement and its ARRANGEMENT line; total rises, claimed doesn't", async () => {
    await clearStale(R.main);
    const r = ok(await addWithFile(ACT.desk, R.main, { category: "HOTEL", amount: 3200, currency: "INR", description: "Extra night, Lakeview Inn", payment: "COMPANY_PAID", vendorId: String(VENDOR) }, "folio.pdf"));
    const { line, arrangement } = r.body;
    expect(arrangement).toMatchObject({
      source: "ADDED", arrangedType: "HOTEL", status: "ARRANGED", amount: 3200, currency: "INR", amountInr: 3200,
      details: "Extra night, Lakeview Inn", vendorCode: "CSTEPVEN0001", vendorName: "Lakeview Inn", paymentStatus: "UNPAID", addedByRole: "OFFICIAL",
    });
    expect(arrangement.attachmentIds).toHaveLength(1);
    expect(line).toMatchObject({ source: "ARRANGEMENT", sourceId: arrangement._id, classification: "OFFICIAL", category: "HOTEL", mode: "HOTEL", amountInr: 3200, deskAdded: true });
    expect(line.attachmentId).toBeUndefined(); // the document lives on the arrangement, read live

    expect(r.body.settlement.amountClaimed).toBe(1885);
    expect(r.body.settlement.totalCostOfTour).toBe(14085);
    expect(r.body.settlement.buckets.boardingLodging).toBe(3200);
    expect(await staleFlags(R.main)).toEqual({ pdfStale: true, packetStale: true });

    // GET /settlement shows it, with the folio as its booking document.
    const g = ok(await send("get", ACT.desk, `/requests/${R.main}/settlement`)).body;
    expect(g.lines).toHaveLength(5);
    const hotel = g.lines.find((l: any) => l._id === line._id);
    expect(hotel.bookingDocuments.map((d: any) => d.originalName)).toEqual(["folio.pdf"]);
    const comment = ((await col("cstepapprovals").find({ entityId: R.main, action: "ADD_SETTLEMENT_LINE" }).sort({ at: -1 }).limit(1).toArray()) as any[])[0].comment;
    expect(comment).toBe("Added expense — Hotel: ₹3,200, company-paid | Vendor: CSTEPVEN0001 Lakeview Inn — Extra night, Lakeview Inn | Document: folio.pdf");
  });

  it("company-paid, no document, as an Admin: works, and the entry is marked an override", async () => {
    const r = ok(await add(ACT.admin, R.main, { category: "CAB", amount: 1200, currency: "INR", description: "Airport transfer", payment: "COMPANY_PAID", vendorId: String(VENDOR) }));
    expect(r.body.arrangement).toMatchObject({ source: "ADDED", arrangedType: "CAB", amountInr: 1200, addedByRole: "ADMIN", vendorName: "Lakeview Inn", deskExpenseCategory: "CAB" });
    expect(r.body.arrangement.attachmentIds).toBeUndefined();
    expect(r.body.settlement.totalCostOfTour).toBe(15285);
    const last = ((await col("cstepapprovals").find({ entityId: R.main, action: "ADD_SETTLEMENT_LINE" }).sort({ at: -1 }).limit(1).toArray()) as any[])[0];
    expect(String(last.actor)).toBe(String(U.admin));
    expect(last.adminOverride).toBe(true);
  });

  it("the Desk can pick a vendor while verifying (vendor-options open in this window)", async () => {
    const r = ok(await send("get", ACT.desk, `/requests/${R.main}/vendor-options`)).body;
    expect(r.vendors.map((v: any) => v.vendorCode)).toEqual(["CSTEPVEN0001"]);
    expect((await send("get", ACT.desk, `/requests/${R.unopened}/vendor-options`)).status).toBe(409);
  });
});

describe("the packet lists the Travel Desk's expenses", () => {
  it("GET /packet hands the renderer every deskAdded line, with its documents", async () => {
    const upload = vi.mocked(packetPdf.uploadCstepPacketPdf);
    upload.mockClear();
    ok(await send("get", ACT.desk, `/requests/${R.main}/packet`));
    expect(upload).toHaveBeenCalledTimes(1);
    const deskExpenses = upload.mock.calls[0][6]!;
    expect(deskExpenses.map((e: any) => [e.categoryLabel, e.description, e.amountInr, e.companyPaid, e.vendorName, e.documents.map((d: any) => d.originalName)])).toEqual([
      ["Food", "Team dinner, client site", 650, false, undefined, []],
      ["Other", "Visa photos", 835, false, undefined, ["photos.pdf"]],
      ["Hotel", "Extra night, Lakeview Inn", 3200, true, "Lakeview Inn", ["folio.pdf"]],
      ["Cab", "Airport transfer", 1200, true, "Lakeview Inn", []],
    ]);
    // The approval-form figures it prints carry the new totals.
    expect(upload.mock.calls[0][4]).toMatchObject({ totalCostOfTour: 15285, amountClaimed: 1885 });
    // The seeded lines are not "added by the Desk".
    expect(await col("cstepsettlementlines").countDocuments({ requestId: R.main, deskAdded: true })).toBe(4);
  });

  it("the real renderer draws the table and a page per expense", async () => {
    const real = await vi.importActual<typeof import("../utils/cstepPacketPdf.js")>("../utils/cstepPacketPdf.js");
    const reqDoc: any = { _id: R.main, workspaceId: WS, formType: "TOUR_PROPOSAL", type: "DOMESTIC", status: "REPORT_SUBMITTED", purpose: "QC", stations: [], countries: [] };
    const spy = vi.spyOn(PDFDocument.prototype as any, "text");
    try {
      const without = await real.generateCstepPacketPdf(reqDoc, { name: "Asha Rao" }, [], [], undefined, []);
      spy.mockClear();
      const withDesk = await real.generateCstepPacketPdf(reqDoc, { name: "Asha Rao" }, [], [], undefined, [], [
        { categoryLabel: "Food", description: "Team dinner, client site", amountInr: 650, companyPaid: false, documents: [] },
        { categoryLabel: "Hotel", description: "Extra night", amountInr: 3200, companyPaid: true, vendorName: "Lakeview Inn", documents: [] },
      ]);
      const texts = spy.mock.calls.map((c: any[]) => String(c[0]));
      expect(texts).toContain("Expenses added by the Travel Desk");
      expect(texts).toContain("Team dinner, client site");
      expect(texts).toContain("Reimbursable · no document");
      expect(texts).toContain("Company-paid · Lakeview Inn · no document");
      const { PDFDocument: PdfLib } = await import("pdf-lib");
      const pages = async (b: Buffer) => (await PdfLib.load(b)).getPageCount();
      // A caption page and a "no document" note page per expense.
      expect((await pages(withDesk)) - (await pages(without))).toBe(4);
    } finally {
      spy.mockRestore();
    }
  }, 30_000); // two full packet renders — slow under a parallel suite
});

describe("a report send-back keeps the Desk's expenses", () => {
  it("add → /report/return → traveller resubmits → /settlement/start: both come back with amount, document, verified", async () => {
    ok(await send("post", ACT.desk, `/requests/${R.ret}/settlement/start`, {}));
    const reimb = ok(await addWithFile(ACT.desk, R.ret, { category: "FOOD", amount: 500, currency: "INR", description: "Working lunch", payment: "REIMBURSABLE" }, "receipt.pdf")).body.line;
    const paid = ok(await add(ACT.desk, R.ret, { category: "FOOD", amount: 2000, currency: "INR", description: "Caterer, field workshop", payment: "COMPANY_PAID", vendorId: String(VENDOR) })).body;
    expect(paid.arrangement.arrangedType).toBe("OTHER"); // food has no service type of its own
    const firstSettlement = await settlementOf(R.ret);
    expect([firstSettlement.amountClaimed, firstSettlement.totalCostOfTour]).toEqual([900, 2900]);

    // Sent back: the settlement and its seeded lines go; the reimbursable
    // Desk expense is kept, the company-paid one stays an arrangement.
    ok(await send("post", ACT.desk, `/requests/${R.ret}/report/return`, { reason: "Add the hotel bill" }));
    expect(await settlementOf(R.ret)).toBeNull();
    const kept: any[] = await col("cstepsettlementlines").find({ requestId: R.ret }).toArray();
    expect(kept.map((l) => [String(l._id), l.source])).toEqual([[reimb._id, "DESK_EXPENSE"]]);
    expect(await col("csteparrangements").countDocuments({ requestId: R.ret, deskExpenseCategory: "FOOD" })).toBe(1);

    // The traveller can't add the company-paid one to the report (it isn't a
    // leg) — the route refuses it whatever the list offers.
    const addBack = await send("post", ACT.traveller, `/requests/${R.ret}/report/legs`, { direction: "ONWARD", arrangementId: String(paid.arrangement._id) });
    expect(addBack.status).toBe(409);
    expect(addBack.body.error).toMatch(/added by the Travel Desk at settlement/);
    expect(await col("cstepreportlegs").countDocuments({ requestId: R.ret, arrangementId: paid.arrangement._id })).toBe(0);
    // The request the traveller reads carries the marker the list filters on.
    const detail = ok(await send("get", ACT.traveller, `/requests/${R.ret}`)).body;
    expect(detail.arrangements.find((a: any) => String(a._id) === String(paid.arrangement._id)).deskExpenseCategory).toBe("FOOD");

    // The traveller resubmits; the Manager approves it back to the Desk.
    expect(ok(await send("post", ACT.traveller, `/requests/${R.ret}/report/submit`, {})).body.request.status).toBe("REPORT_UNDER_APPROVAL");
    ok(await send("post", ACT.approver, `/requests/${R.ret}/report/approve`, {}));

    const started = ok(await send("post", ACT.desk, `/requests/${R.ret}/settlement/start`, {})).body;
    expect(String(started.settlement._id)).not.toBe(String(firstSettlement._id));
    const back = started.lines.find((l: any) => l.source === "DESK_EXPENSE");
    expect(back).toMatchObject({
      _id: reimb._id, settlementId: started.settlement._id, amountInr: 500, claimedAmountInr: 500, category: "FOOD",
      classification: "PERSONAL", description: "Working lunch", attachmentId: reimb.attachmentId, verified: true, deskAdded: true,
    });
    expect(String(back.verifiedBy)).toBe(String(U.desk));
    const company = started.lines.find((l: any) => l.source === "ARRANGEMENT");
    expect(company).toMatchObject({
      sourceId: paid.arrangement._id, amountInr: 2000, category: "FOOD", classification: "OFFICIAL", verified: true, deskAdded: true,
    });
    expect(String(company.verifiedBy)).toBe(String(U.desk));
    expect(started.lines.filter((l: any) => l.source === "REPORT_LEG").map((l: any) => l.amountInr)).toEqual([400]);
    expect(started.lines).toHaveLength(3);
    expect([started.settlement.amountClaimed, started.settlement.totalCostOfTour]).toEqual([900, 2900]);

    // The document still opens from the settlement, and the packet lists both.
    const g = ok(await send("get", ACT.desk, `/requests/${R.ret}/settlement`)).body;
    expect(g.lines.find((l: any) => l._id === reimb._id).attachment.originalName).toBe("receipt.pdf");
    const upload = vi.mocked(packetPdf.uploadCstepPacketPdf);
    upload.mockClear();
    ok(await send("get", ACT.desk, `/requests/${R.ret}/packet`));
    expect(upload.mock.calls[0][6]!.map((e: any) => [e.description, e.amountInr, e.companyPaid, e.documents.map((d: any) => d.originalName)])).toEqual([
      ["Working lunch", 500, false, ["receipt.pdf"]],
      ["Caterer, field workshop", 2000, true, []],
    ]);

    // A second start is a no-op — nothing moves twice.
    const again = ok(await send("post", ACT.desk, `/requests/${R.ret}/settlement/start`, {})).body;
    expect(again.lines).toHaveLength(3);
  });

  it("another request's kept expense never lands on this settlement", async () => {
    expect(await col("cstepsettlementlines").countDocuments({ requestId: R.main, source: "DESK_EXPENSE" })).toBe(2);
    const retSettlement = await settlementOf(R.ret);
    expect(await col("cstepsettlementlines").countDocuments({ settlementId: retSettlement._id, requestId: { $ne: R.ret } })).toBe(0);
  });
});

describe("through to Tally", () => {
  it("after finalize no more can be added", async () => {
    const fin = ok(await send("post", ACT.desk, `/requests/${R.main}/settlement/finalize`, { force: true })).body;
    expect(fin.request.status).toBe("TRANSFERRED_TO_FINANCE");
    expect(fin.settlement.amountClaimed).toBe(1885);
    const r = await add(ACT.desk, R.main, FOOD);
    expect(r.status).toBe(409);
  });

  it("reimbursable lines reach the reimbursement Tally by category once Finance pays", async () => {
    ok(await send("post", ACT.finance, `/requests/${R.main}/finance/settle`, { reference: "UTR-QC-1" }));
    const rows = await tallyRows("reimbursements");
    expect(shape(rows)).toEqual([
      ["Local Conveyance", "Dr", 400],
      ["Staff Welfare - Meals", "Dr", 650],
      ["Travel Expenses - Other", "Dr", 835],
      [expect.any(String), "Cr", 1885],
    ]);
  });

  it("the company-paid line reaches the vendor Tally once its vendor is paid", async () => {
    const hotel: any = await col("csteparrangements").findOne({ requestId: R.main, arrangedType: "HOTEL" });
    expect((await tallyRows("both")).filter((x) => x[4] === "Lakeview Inn")).toHaveLength(0);
    ok(await send("patch", ACT.finance, `/requests/${R.main}/arrangements/${hotel._id}/payment`, { paymentStatus: "PAID", paymentRef: "UTR-V-QC" }));
    const rows = await tallyRows("vendor");
    expect(shape(rows)).toEqual([
      ["Lodging Expenses", "Dr", 3200],
      ["Lakeview Inn", "Cr", 3200],
    ]);
  });
});
