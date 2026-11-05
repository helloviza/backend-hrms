// apps/backend/src/routes/cstep.rebookCredit.test.ts
//
// Module D — rebooking charges and cancellation credit notes.
//   Part 1: during an OPEN REBOOK change request the Travel Desk adds the
//     rebooking's charge as its OWN arrangement line (POST /arrangements with
//     changeRequestId) — the original fare is never overwritten (PATCH of its
//     amount is refused). Both lines are in the trip cost and the vendor Tally.
//   Part 2: POST /arrangements/:lineId/cancel marks a booking cancelled with
//     the vendor's credit note (0 < credit ≤ booking). The settlement carries
//     it as a NEGATIVE CREDIT_NOTE line, so totalCostOfTour nets it. Vendor
//     Tally: a credit against a PAID booking is its own voucher (Dr vendor,
//     Cr expense) and the paid voucher stays as it was; a credit against an
//     UNPAID booking makes it payable net, and a full credit exports nothing.
//
// Real: cstep + tally + vendor-payables routers, models, sequence engine,
//   in-memory Mongo REPLICA SET, cstep_qc_rebook_credit. The packet renderer
//   is real in its own test (no documents, so no S3).
// Stubbed: S3, mail, the packet/event/declaration uploaders, auth, workspace.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import fontkit from "@pdf-lib/fontkit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_rebook_credit";
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
vi.mock("../utils/cstepClaimPdf.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  uploadCstepClaimDeclarationPdf: vi.fn(async () => ({ key: "qc-declaration" })),
}));

const { default: cstepRouter } = await import("./cstep.js");
const { default: tallyRouter } = await import("./cstep.tally.js");
const { default: payablesRouter } = await import("./cstep.vendorPayables.js");
const { default: CstepSettlementLine } = await import("../models/cstep/CstepSettlementLine.js");
const packetPdf = await import("../utils/cstepPacketPdf.js");

const DB = "cstep_qc_rebook_credit";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const WS = oid();
const U = { traveller: oid(), desk: oid(), finance: oid(), admin: oid(), plain: oid() };
const TP = oid();
const VT = { air: oid(), hotel: oid() };
const VENDOR = { air: oid(), hotel: oid() };
// R.rebook: a rebook (Part 1). R.paid: a credit against a paid booking.
// R.unpaid: credits against unpaid bookings (partial + full). R.claim: a claim.
const R = { rebook: oid(), paid: oid(), unpaid: oid(), claim: oid() };
const A = { flight: oid(), hotel: oid(), cab: oid(), train: oid() };

const fakeAuth = (req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceObjectId = WS;
  next();
};
const app = express();
app.use(express.json());
app.use("/api/cstep/tally", fakeAuth, tallyRouter);
app.use("/api/cstep/vendor-payables", fakeAuth, payablesRouter);
app.use("/api/cstep", fakeAuth, cstepRouter);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = { traveller: who(U.traveller), desk: who(U.desk), finance: who(U.finance), admin: who(U.admin, ["ADMIN"]), plain: who(U.plain) };
const send = (method: "get" | "put" | "post" | "patch", as: any, path: string, body?: any) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as));
  return body === undefined ? r : r.send(body);
};
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const cancel = (as: any, rid: any, aid: any, body: any) => send("post", as, `/requests/${rid}/arrangements/${aid}/cancel`, body);
const pay = (rid: any, aid: any) => send("patch", ACT.finance, `/requests/${rid}/arrangements/${aid}/payment`, { paymentStatus: "PAID", paymentRef: "UTR-QC", vendorInvoiceNo: "INV-QC" });

const TODAY = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
async function tallyRows(kind = "vendor"): Promise<any[][]> {
  const r = await request(app)
    .get(`/api/cstep/tally/export?kind=${kind}&from=2026-01-01&to=${TODAY}`)
    .set("x-test-user", JSON.stringify(ACT.admin))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  if (r.status === 404) return [];
  if (r.status !== 200) throw new Error(`${r.status} ${r.body.toString()}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.body as any);
  const rows: any[][] = [];
  wb.worksheets[0].eachRow((row, n) => n > 1 && rows.push(Array.from({ length: 25 }, (_, i) => row.getCell(i + 1).value ?? "")));
  return rows;
}
/** voucher no → [[ledger, Dr/Cr, amount]…] */
const vouchers = (rows: any[][]) => {
  const m = new Map<string, any[][]>();
  for (const x of rows) m.set(String(x[2]), [...(m.get(String(x[2])) || []), [x[4], x[5], x[14]]]);
  return m;
};
const settlementOf = async (rid: any) => (await col("cstepsettlements").findOne({ requestId: rid })) as any;
const arr = async (aid: any) => (await col("csteparrangements").findOne({ _id: aid })) as any;
const lastAudit = async (rid: any, action: string) =>
  ((await col("cstepapprovals").find({ entityId: rid, action }).sort({ at: -1 }).limit(1).toArray()) as any[])[0];
const setStatus = (rid: any, status: string) => col("csteptravelrequests").updateOne({ _id: rid }, { $set: { status } });

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
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertOne({
    _id: TP, workspaceId: WS, travelerId: "E-001", employeeId: "E-001", firstName: "Asha", lastName: "Rao", isActive: true,
    claimedBy: U.traveller, officialUserId: U.desk, financeUserId: U.finance, workLocation: "Bengaluru",
  } as any);
  await col("cstepvendortypes").insertMany([
    { _id: VT.air, workspaceId: WS, name: "Airline", isActive: true },
    { _id: VT.hotel, workspaceId: WS, name: "Hotel", isActive: true },
  ] as any[]);
  await col("cstepvendors").insertMany([
    { _id: VENDOR.air, workspaceId: WS, vendorCode: "CSTEPVEN0001", name: "Skyline Travels", vendorTypeId: VT.air, isActive: true, createdAt: now, updatedAt: now },
    { _id: VENDOR.hotel, workspaceId: WS, vendorCode: "CSTEPVEN0002", name: "Lakeview Inn", vendorTypeId: VT.hotel, isActive: true, createdAt: now, updatedAt: now },
  ] as any[]);
  const reqDoc = (_id: any, status: string, ref: string, formType = "TOUR_PROPOSAL") => ({
    _id, workspaceId: WS, travelerProfileId: TP, createdBy: U.traveller, formType, type: "DOMESTIC", purpose: `QC ${ref}`,
    departureDate: "2026-10-20", returnDate: "2026-10-22", perDiemEligible: false, status, claimReference: ref,
    project: "PRJ-ENERGY", stations: [{ from: "Bengaluru", to: "Delhi" }], createdAt: now, updatedAt: now,
  });
  await col("csteptravelrequests").insertMany([
    reqDoc(R.rebook, "ARRANGED", "0001/1126"),
    reqDoc(R.paid, "REPORT_SUBMITTED", "0002/1126"),
    reqDoc(R.unpaid, "ARRANGED", "0003/1126"),
    reqDoc(R.claim, "APPROVED", "EXP0001/1126", "EXPENSE_CLAIM"),
  ] as any[]);
  const booking = (_id: any, requestId: any, arrangedType: string, amount: number, vendor: any, vendorCode: string, vendorName: string, details: string) => ({
    _id, workspaceId: WS, requestId, source: "REQUESTED", requestedType: arrangedType, arrangedType, details, status: "ARRANGED",
    currency: "INR", amount, exchangeRate: 1, amountInr: amount, vendorId: vendor, vendorCode, vendorName, paymentStatus: "UNPAID",
    createdBy: U.desk, createdAt: now, updatedAt: now,
  });
  await col("csteparrangements").insertMany([
    booking(A.flight, R.rebook, "FLIGHT", 9000, VENDOR.air, "CSTEPVEN0001", "Skyline Travels", "6E-511 BLR→DEL"),
    booking(A.hotel, R.paid, "HOTEL", 8000, VENDOR.hotel, "CSTEPVEN0002", "Lakeview Inn", "2 nights, Lakeview Inn"),
    booking(A.cab, R.unpaid, "CAB", 2000, VENDOR.air, "CSTEPVEN0001", "Skyline Travels", "Airport transfers"),
    booking(A.train, R.unpaid, "TRAIN", 4000, VENDOR.air, "CSTEPVEN0001", "Skyline Travels", "Vande Bharat DEL→AGC"),
  ] as any[]);

  ok(await send("put", ACT.admin, "/tally/settings", {
    companyName: "CSTEP",
    ledgerMap: [
      { vendorTypeId: String(VT.air), ledger: "Air Travel Expenses" },
      { vendorTypeId: String(VT.hotel), ledger: "Lodging Expenses" },
    ],
    locationMap: [{ location: "Bengaluru", code: "BLR-HQ" }],
  }));
}, 240_000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("Part 1 — a rebooking's charge is its own line", () => {
  let changeId = "";
  let charge: any;

  it("an open REBOOK change request: the Desk adds the charge as a new ADDED line; the original fare stays", async () => {
    changeId = String(ok(await send("post", ACT.traveller, `/requests/${R.rebook}/change-requests`, { arrangementId: String(A.flight), kind: "REBOOK", details: "Move to 3 Nov", reason: "Meeting moved" })).body.changeRequest._id);
    // Overwriting the original fare is refused while the rebook is open.
    const overwrite = await send("patch", ACT.desk, `/requests/${R.rebook}/arrangements/${A.flight}`, { amount: 11500, currency: "INR" });
    expect(overwrite.status).toBe(409);
    expect((await arr(A.flight)).amountInr).toBe(9000);

    const r = await request(app)
      .post(`/api/cstep/requests/${R.rebook}/arrangements`)
      .set("x-test-user", JSON.stringify(ACT.desk))
      .field("changeRequestId", changeId)
      .field("amount", "2500")
      .field("currency", "INR")
      .field("vendorId", String(VENDOR.air))
      .field("details", "fare difference to 3 Nov")
      .attach("file", Buffer.from("%PDF-1.4 qc"), { filename: "rebook-invoice.pdf", contentType: "application/pdf" });
    expect(r.status).toBe(201);
    charge = r.body.line;
    expect(charge).toMatchObject({
      source: "ADDED", arrangedType: "FLIGHT", status: "ARRANGED", amountInr: 2500, vendorName: "Skyline Travels", changeRequestId: changeId,
      details: "Rebooking charge — Flight 6E-511 BLR→DEL: fare difference to 3 Nov",
    });
    expect(charge.attachmentIds).toHaveLength(1);
    const original = await arr(A.flight);
    expect([original.amountInr, original.amount, original.details]).toEqual([9000, 9000, "6E-511 BLR→DEL"]);
    expect((await lastAudit(R.rebook, "ADD_SERVICE")).comment).toMatch(/^Rebooking charge: Added FLIGHT/);
  });

  it("the gate: Desk/Admin only, an OPEN REBOOK only, a vendor and an amount", async () => {
    const base = { changeRequestId: changeId, amount: 100, currency: "INR", vendorId: String(VENDOR.air) };
    for (const as of [ACT.traveller, ACT.finance, ACT.plain]) expect((await send("post", as, `/requests/${R.rebook}/arrangements`, base)).status).toBe(403);
    expect((await send("post", ACT.desk, `/requests/${R.rebook}/arrangements`, { ...base, vendorId: "" })).status).toBe(400);
    expect((await send("post", ACT.desk, `/requests/${R.rebook}/arrangements`, { ...base, amount: 0 })).status).toBe(400);
    expect((await send("post", ACT.desk, `/requests/${R.rebook}/arrangements`, { ...base, changeRequestId: String(oid()) })).status).toBe(404);
    // Without a change request, past ARRANGING stays refused.
    expect((await send("post", ACT.desk, `/requests/${R.rebook}/arrangements`, { arrangedType: "FLIGHT", amount: 100 })).status).toBe(409);
    expect(await col("csteparrangements").countDocuments({ requestId: R.rebook })).toBe(2);
  });

  it("never a travel-report leg: the add-back route refuses it", async () => {
    await setStatus(R.rebook, "REPORT_PENDING");
    const r = await send("post", ACT.traveller, `/requests/${R.rebook}/report/legs`, { direction: "ONWARD", arrangementId: charge._id });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/rebooking charge/i);
    await setStatus(R.rebook, "ARRANGED");
  });

  it("once the change is resolved, no more charges can be added against it", async () => {
    ok(await send("post", ACT.desk, `/change-requests/${changeId}/resolve`, { status: "DONE", note: "Rebooked on 6E-201" }));
    const r = await send("post", ACT.desk, `/requests/${R.rebook}/arrangements`, { changeRequestId: changeId, amount: 100, currency: "INR", vendorId: String(VENDOR.air) });
    expect(r.status).toBe(409);
  });

  it("both lines are in the trip cost and in the vendor Tally", async () => {
    await setStatus(R.rebook, "REPORT_SUBMITTED");
    const s = ok(await send("post", ACT.desk, `/requests/${R.rebook}/settlement/start`, {})).body;
    expect(s.lines.map((l: any) => [l.source, l.amountInr]).sort()).toEqual([["ARRANGEMENT", 2500], ["ARRANGEMENT", 9000]]);
    expect(s.settlement.totalCostOfTour).toBe(11500);
    ok(await pay(R.rebook, A.flight));
    ok(await pay(R.rebook, charge._id));
    const v = [...vouchers(await tallyRows()).values()];
    expect(v).toEqual(expect.arrayContaining([
      [["Air Travel Expenses", "Dr", 9000], ["Skyline Travels", "Cr", 9000]],
      [["Air Travel Expenses", "Dr", 2500], ["Skyline Travels", "Cr", 2500]],
    ]));
  });
});

describe("Part 2 — a credit note against a PAID booking", () => {
  let hotelVoucherNo = "";

  it("set up: the hotel is paid and exported; the settlement is open at ₹8,000", async () => {
    ok(await pay(R.paid, A.hotel));
    const v = vouchers(await tallyRows());
    hotelVoucherNo = [...v.entries()].find(([, rows]) => rows[0][0] === "Lodging Expenses")![0];
    expect(v.get(hotelVoucherNo)).toEqual([["Lodging Expenses", "Dr", 8000], ["Lakeview Inn", "Cr", 8000]]);
    const s = ok(await send("post", ACT.desk, `/requests/${R.paid}/settlement/start`, {})).body;
    expect(s.settlement.totalCostOfTour).toBe(8000);
  });

  it("gate + input: Desk/Admin only; ref required; 0 < credit ≤ booking; a foreign credit needs a rate", async () => {
    const good = { ref: "CN-LV-1", amount: 3000, currency: "INR" };
    for (const as of [ACT.traveller, ACT.finance, ACT.plain]) expect((await cancel(as, R.paid, A.hotel, good)).status).toBe(403);
    expect((await cancel(ACT.desk, R.paid, A.hotel, { ...good, ref: " " })).status).toBe(400);
    expect((await cancel(ACT.desk, R.paid, A.hotel, { ...good, amount: 0 })).status).toBe(400);
    const over = await cancel(ACT.desk, R.paid, A.hotel, { ...good, amount: 8000.01 });
    expect(over.status).toBe(400);
    expect(over.body.bookingAmountInr).toBe(8000);
    expect((await cancel(ACT.desk, R.paid, A.hotel, { ...good, currency: "USD", amount: 30 })).status).toBe(400);
    expect((await cancel(ACT.admin, R.claim, oid(), good)).status).toBe(409);
    expect(await col("cstepcreditnotes").countDocuments({})).toBe(0);
  });

  it("partial credit: booking cancelled, a −₹3,000 CREDIT_NOTE line, total drops by the credit, stale + audit", async () => {
    await col("csteptravelrequests").updateOne({ _id: R.paid }, { $set: { pdfStale: false, packetStale: false } });
    const r = ok(await cancel(ACT.desk, R.paid, A.hotel, { ref: "CN-LV-1", amount: 3000, currency: "INR" })).body;
    expect(r.creditNote).toMatchObject({ ref: "CN-LV-1", amountInr: 3000, againstPaid: true, currency: "INR" });
    expect(r.line).toMatchObject({ cancelled: true, creditInr: 3000, creditNoteRef: "CN-LV-1", creditAgainstPaid: true, amountInr: 8000 });
    expect(r.settlementLine).toMatchObject({ source: "CREDIT_NOTE", sourceId: r.creditNote._id, amountInr: -3000, classification: "OFFICIAL", mode: "HOTEL", verified: true });
    expect(r.settlement.totalCostOfTour).toBe(5000);
    expect(r.settlement.buckets.boardingLodging).toBe(5000);
    expect(r.settlement.amountClaimed).toBe(0);
    const flags: any = await col("csteptravelrequests").findOne({ _id: R.paid });
    expect([flags.pdfStale, flags.packetStale]).toEqual([true, true]);
    const audit = await lastAudit(R.paid, "CANCEL_BOOKING");
    expect(String(audit.actor)).toBe(String(U.desk));
    expect(audit.comment).toBe("Cancelled Hotel — 2 nights, Lakeview Inn (₹8,000) — credit note CN-LV-1: −₹3,000 · against the paid booking · vendor keeps ₹5,000");
    expect((await cancel(ACT.desk, R.paid, A.hotel, { ref: "CN-2", amount: 1 })).status).toBe(409); // once
  });

  it("the credit line's amount is as the note says; a cancelled booking's amount/vendor are locked; it can't be un-paid", async () => {
    const line: any = await col("cstepsettlementlines").findOne({ requestId: R.paid, source: "CREDIT_NOTE" });
    expect((await send("patch", ACT.desk, `/requests/${R.paid}/settlement/lines/${line._id}`, { amountInr: -1000, amountReason: "x" })).status).toBe(409);
    expect((await send("patch", ACT.desk, `/requests/${R.paid}/settlement/lines/${line._id}`, { classification: "PERSONAL", classificationOverrideReason: "x" })).status).toBe(409);
    expect((await send("patch", ACT.desk, `/requests/${R.paid}/settlement/lines/${line._id}`, { verified: false })).status).toBe(200);
    expect((await send("patch", ACT.finance, `/requests/${R.paid}/arrangements/${A.hotel}/payment`, { paymentStatus: "UNPAID" })).status).toBe(409);
  });

  it("Tally: the paid voucher is unchanged; the credit note is its own voucher — Dr the vendor, Cr the expense", async () => {
    const v = vouchers(await tallyRows());
    expect(v.get(hotelVoucherNo)).toEqual([["Lodging Expenses", "Dr", 8000], ["Lakeview Inn", "Cr", 8000]]);
    const noteNo = [...v.entries()].find(([, rows]) => rows[0][0] === "Lakeview Inn" && rows[0][1] === "Dr")![0];
    expect(noteNo).not.toBe(hotelVoucherNo);
    expect(v.get(noteNo)).toEqual([["Lakeview Inn", "Dr", 3000], ["Lodging Expenses", "Cr", 3000]]);
    const note: any = await col("cstepcreditnotes").findOne({ arrangementId: A.hotel });
    expect(note.tallyVoucherNo).toBe(Number(noteNo));
    // Re-export: the same numbers.
    expect([...vouchers(await tallyRows()).keys()]).toEqual([...v.keys()]);
  });

  it("the packet lists the cancelled booking with its credit note; the totals it prints are net", async () => {
    const upload = vi.mocked(packetPdf.uploadCstepPacketPdf);
    upload.mockClear();
    ok(await send("get", ACT.desk, `/requests/${R.paid}/packet`));
    expect(upload.mock.calls[0][7]).toEqual([{ service: "Hotel — 2 nights, Lakeview Inn", amountInr: 8000, creditNoteRef: "CN-LV-1", creditInr: 3000 }]);
    expect(upload.mock.calls[0][4]).toMatchObject({ totalCostOfTour: 5000 });
  });

  it("after finalize: no more cancellations", async () => {
    ok(await send("post", ACT.desk, `/requests/${R.paid}/settlement/finalize`, { force: true }));
    // A second booking on the same case, to have something to try.
    const extra = oid();
    await col("csteparrangements").insertOne({ _id: extra, workspaceId: WS, requestId: R.paid, source: "ADDED", arrangedType: "CAB", status: "ARRANGED", currency: "INR", amount: 900, amountInr: 900, paymentStatus: "UNPAID", createdBy: U.desk } as any);
    const r = await cancel(ACT.desk, R.paid, extra, { ref: "CN-X", amount: 100 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/until the settlement is finalized/);
  });
});

describe("Part 2 — credit notes against UNPAID bookings", () => {
  it("partial: cancelled before the settlement; paid later at the net; the settlement nets it when it opens", async () => {
    const r = ok(await cancel(ACT.desk, R.unpaid, A.cab, { ref: "CN-SK-7", amount: 1500, currency: "INR" })).body;
    expect(r.creditNote.againstPaid).toBe(false);
    expect(r.settlementLine).toBeUndefined(); // no settlement yet
    ok(await pay(R.unpaid, A.cab));
    const cabVoucher = [...vouchers(await tallyRows()).values()].filter((rows) => rows.some((x) => x[2] === 500));
    expect(cabVoucher).toEqual([[["Air Travel Expenses", "Dr", 500], ["Skyline Travels", "Cr", 500]]]);
    const rows = await tallyRows();
    expect(rows.find((x) => x[14] === 500 && x[5] === "Dr")![15]).toMatch(/net of credit note CN-SK-7$/);
    // No separate credit-note voucher for an unpaid booking's credit.
    expect(await col("cstepcreditnotes").countDocuments({ arrangementId: A.cab, tallyVoucherNo: { $exists: true } })).toBe(0);
  });

  it("full credit: nothing owed — payment refused, nothing exported, payables show ₹0 net", async () => {
    ok(await cancel(ACT.desk, R.unpaid, A.train, { ref: "CN-SK-8", amount: 4000, currency: "INR" }));
    const r = await pay(R.unpaid, A.train);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/full credit note/);
    // Even if it were marked paid behind the route's back, it exports nothing.
    await col("csteparrangements").updateOne({ _id: A.train }, { $set: { paymentStatus: "PAID", paidAt: new Date() } });
    const v = [...vouchers(await tallyRows()).values()];
    expect(v.some((rows) => rows.some((x) => x[2] === 4000))).toBe(false);
    await col("csteparrangements").updateOne({ _id: A.train }, { $set: { paymentStatus: "UNPAID" }, $unset: { paidAt: "" } });
    const payables = ok(await send("get", ACT.admin, `/vendor-payables?paymentStatus=UNPAID`)).body;
    const train = payables.rows.find((x: any) => x.lineId === String(A.train));
    expect(train).toMatchObject({ cancelled: true, creditNoteRef: "CN-SK-8", creditInr: 4000, netInr: 0, amountInr: 4000 });
    // Nothing owed: not an unpaid line in the totals (browser QC — it was
    // counted at ₹4,000), and not a row on the payment working sheet.
    const owed = payables.rows.filter((x: any) => x.paymentStatus === "UNPAID" && !(x.cancelled && x.netInr === 0));
    expect(payables.totals.unpaidLines).toBe(owed.length);
    expect(payables.totals.unpaidInr).toBe(owed.reduce((s: number, x: any) => s + x.netInr, 0));
    const sheet = await request(app)
      .get("/api/cstep/vendor-payables/export?paymentStatus=UNPAID&format=csv")
      .set("x-test-user", JSON.stringify(ACT.admin))
      .buffer(true)
      .parse((res, cb) => { let s = ""; res.on("data", (d: any) => (s += d)); res.on("end", () => cb(null, s)); });
    expect(sheet.status).toBe(200);
    expect(sheet.body).not.toContain("Vande Bharat");
  });

  it("the settlement opens with each booking and its credit line: trip cost = 2000 − 1500 + 4000 − 4000", async () => {
    await setStatus(R.unpaid, "REPORT_SUBMITTED");
    const s = ok(await send("post", ACT.desk, `/requests/${R.unpaid}/settlement/start`, {})).body;
    expect(s.lines.map((l: any) => [l.source, l.amountInr])).toEqual([
      ["ARRANGEMENT", 2000],
      ["ARRANGEMENT", 4000],
      ["CREDIT_NOTE", -1500],
      ["CREDIT_NOTE", -4000],
    ]);
    expect(s.settlement.totalCostOfTour).toBe(500);
    expect(s.settlement.buckets).toMatchObject({ cab: 500, airRailBus: 0 });
  });
});

describe("negative amounts — a credit note only", () => {
  const base = { workspaceId: WS, settlementId: oid(), requestId: oid(), sourceId: oid(), mode: "OTHER", classification: "OFFICIAL", createdBy: U.desk };
  it("CREDIT_NOTE may be negative (and not positive); every other source rejects a negative", async () => {
    await expect(new CstepSettlementLine({ ...base, source: "CREDIT_NOTE", amountInr: -250 }).validate()).resolves.toBeUndefined();
    await expect(new CstepSettlementLine({ ...base, source: "CREDIT_NOTE", amountInr: 250 }).validate()).rejects.toThrow(/amountInr/);
    for (const source of ["ARRANGEMENT", "REPORT_LEG", "CLAIM_LINE", "DESK_EXPENSE"]) {
      await expect(new CstepSettlementLine({ ...base, source, amountInr: -1 }).validate()).rejects.toThrow(/amountInr/);
      await expect(new CstepSettlementLine({ ...base, source, amountInr: 0 }).validate()).resolves.toBeUndefined();
    }
  });
});

describe("the packet renderer", () => {
  it("draws the cancelled bookings table", async () => {
    const real = await vi.importActual<typeof import("../utils/cstepPacketPdf.js")>("../utils/cstepPacketPdf.js");
    const reqDoc: any = { _id: R.paid, workspaceId: WS, formType: "TOUR_PROPOSAL", type: "DOMESTIC", status: "REPORT_SUBMITTED", purpose: "QC", stations: [], countries: [] };
    const spy = vi.spyOn(PDFDocument.prototype as any, "text");
    try {
      await real.generateCstepPacketPdf(reqDoc, { name: "Asha Rao" }, [], [], undefined, [], [], [
        { service: "Hotel — 2 nights, Lakeview Inn", amountInr: 8000, creditNoteRef: "CN-LV-1", creditInr: 3000 },
        { service: "Train — Vande Bharat DEL→AGC", amountInr: 4000, creditNoteRef: "CN-SK-7", creditInr: 1500 },
      ]);
      const texts = spy.mock.calls.map((c: any[]) => String(c[0]));
      expect(texts).toContain("Cancelled bookings & credit notes");
      expect(texts).toContain("Hotel — 2 nights, Lakeview Inn — cancelled");
      expect(texts).toContain("Train — Vande Bharat DEL to AGC — cancelled");
      expect(texts).toContain("CN-LV-1");
      expect(texts).toContain("-3,000.00");
      // Browser QC: "−" (U+2212) and "→" have no NotoSans glyph and printed
      // as nothing — every character drawn must be one the font carries.
      const font = fontkit.create(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fonts", "NotoSans-Regular.ttf")));
      const missing = [...new Set(texts.join("").split(""))].filter((ch) => ch.trim() && !font.hasGlyphForCodePoint(ch.codePointAt(0)!));
      expect(missing).toEqual([]);
      expect(real.cancelledBookingText({ service: "Flight — 6E-511 BLR→DEL", amountInr: 9000, creditNoteRef: "CN-1", creditInr: 2000 })).toBe(
        "Flight — 6E-511 BLR to DEL ₹9,000.00 — cancelled · credit note CN-1 -₹2,000.00",
      );
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});
