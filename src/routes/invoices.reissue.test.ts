// apps/backend/src/routes/invoices.reissue.test.ts
//
// Invoice "Cancel for reissue" + "Delete invoice" (services/invoiceReissue.ts,
// docs/audits/invoice-reissue-audit.md). The Counter is never written by a
// reissue: the reserved number is preset on the new invoice.
//
// Real: invoices router, requireBillingStaff, requirePermission, in-memory
//   REPLICA SET (archive + generation run in transactions), models, the
//   generation service.
// Stubbed: requireAuth (x-test-user), workspace resolver (x-test-ws), PDF
//   renderer, invoice PDF S3 store, task automation.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../utils/invoicePdf.js", () => ({
  generateInvoicePdf: vi.fn(async () => Buffer.from("%PDF")),
  prefetchInvoiceAssets: vi.fn(async () => ({})),
}));
const pdfStore = vi.hoisted(() => ({
  archiveInvoicePdf: vi.fn(async (_no: string, id: string) => `invoices/archived/${id}.pdf` as string | null),
  storeInvoicePdf: vi.fn(async (no: string) => `https://s3.test/invoices/${no}.pdf`),
  presignArchivedInvoicePdf: vi.fn(async (k: string) => `https://s3.test/${k}`),
}));
vi.mock("../utils/invoicePdfStore.js", () => ({
  ...pdfStore,
  invoicePdfKey: (no: string) => `invoices/${no}.pdf`,
  archivedInvoicePdfKey: (id: string) => `invoices/archived/${id}.pdf`,
}));
vi.mock("../services/taskAutomation.js", () => ({ triggerTaskAutomation: vi.fn(async () => undefined) }));

const { default: invoicesRouter } = await import("./invoices.js");
const { createInvoiceFromBookings } = await import("../services/invoiceGeneration.service.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { default: InvoiceNumberReservation } = await import("../models/InvoiceNumberReservation.js");
const { default: ArchivedInvoice } = await import("../models/ArchivedInvoice.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { todayIST } = await import("../utils/dateIST.js");

const oid = (s?: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);
const HOUSE = "69679a7628330a58d29f2254";
const KA = "29ABCDE1234F1Z5"; // default profile — bare series INV-2026xxxx
const MH = "27ABCDE1234F1Z5"; // prefixed series INV-MH…
const SA_ID = oid();
const SA = { _id: String(SA_ID), id: String(SA_ID), sub: String(SA_ID), roles: ["SUPERADMIN"], workspaceId: HOUSE };

const withWs = (req: any, _res: any, next: any) => {
  const ws = String(req.headers["x-test-ws"] || HOUSE);
  req.workspaceId = ws;
  req.workspaceObjectId = oid(ws);
  next();
};
const app = express();
app.use(express.json());
app.use("/api/admin/invoices", withWs, invoicesRouter);

const as = (user: any, r: request.Test) => r.set("x-test-user", JSON.stringify(user)).set("x-test-ws", HOUSE);
const post = (path: string, body: any = {}, user: any = SA) => as(user, request(app).post(`/api/admin/invoices${path}`)).send(body);
const get = (path: string, user: any = SA) => as(user, request(app).get(`/api/admin/invoices${path}`));
const REASON = "Wrong fare on the booking, regenerating";
const TODAY = todayIST();

let CUST: mongoose.Types.ObjectId;
let refSeq = 0;
async function booking(extra: Record<string, unknown> = {}) {
  refSeq += 1;
  const b: any = await ManualBooking.create({
    workspaceId: CUST, bookedBy: SA_ID, type: "FLIGHT", supplierName: "TBO", givenBy: "Ops",
    status: "CONFIRMED", bookingRef: `MB-RI-${refSeq}`,
    travelDate: new Date("2026-12-01T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
    pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 10000, quotedPrice: 11180 },
    ...extra,
  });
  return String(b._id);
}

async function generate(bookingIds: string[], extra: Record<string, unknown> = {}, user: any = SA) {
  return post("/generate", { bookingIds, invoiceDate: TODAY, ...extra }, user);
}
async function generated(bookingIds: string[], extra: Record<string, unknown> = {}) {
  const r = await generate(bookingIds, extra);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.invoice as any;
}
const counterSeqs = async () =>
  Object.fromEntries((await col("counters").find({}).toArray()).map((c: any) => [c._id, c.seq]));

async function staff(grants: Record<string, string>, extra: Record<string, unknown> = {}) {
  const id = oid();
  const email = `${id}@test.local`;
  await col("users").insertOne({ _id: id, email, name: "Test", roles: ["EMPLOYEE"], workspaceId: HOUSE } as any);
  const modules: any = {};
  for (const [k, v] of Object.entries(grants)) modules[k] = { access: v, scope: "ALL" };
  await UserPermission.create({
    userId: String(id), email, workspaceId: HOUSE, universe: "STAFF",
    level: { code: "L1", name: "Employee" }, modules, grantedBy: "test", ...extra,
  } as any);
  return { _id: String(id), id: String(id), sub: String(id), roles: ["EMPLOYEE"], workspaceId: HOUSE, email };
}

let mongod: MongoMemoryReplSet;
beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("invoice-reissue-test"));
  await InvoiceNumberReservation.init(); // the partial unique index must exist before any test relies on it
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  vi.clearAllMocks();
  await col("companysettings").insertOne({
    companyName: "Plumtrips", invoiceSeriesCadence: "annual",
    gstProfiles: [
      { gstin: KA, state: "Karnataka", stateCode: "29", legalName: "Plumtrips KA", addressLine1: "", addressLine2: "", city: "Bengaluru", pincode: "560001", isDefault: true, active: true, invoiceSeriesPrefix: "" },
      { gstin: MH, state: "Maharashtra", stateCode: "27", legalName: "Plumtrips MH", addressLine1: "", addressLine2: "", city: "Mumbai", pincode: "400001", isDefault: false, active: true, invoiceSeriesPrefix: "MH" },
    ],
  } as any);
  const c: any = await Customer.create({ name: "Acme", legalName: "Acme Pvt Ltd", gstRegisteredState: "Karnataka" });
  CUST = c._id;
  await CustomerWorkspace.create({ customerId: String(c._id), companyName: "Acme" });
});

async function cancelForReissue(inv: any, body: Record<string, unknown> = {}, user: any = SA) {
  return post(`/${inv._id}/cancel-for-reissue`, { reason: REASON, confirmText: inv.invoiceNo, ...body }, user);
}

/* ── happy path ─────────────────────────────────────────────────────── */

describe("cancel for reissue → regenerate with the same number", () => {
  it("archives, reserves, then reuses the number with the Counter untouched", async () => {
    const b = await booking();
    const inv = await generated([b]);
    expect(inv.invoiceNo).toMatch(/^INV-2026\d{4}$/);
    const before = await counterSeqs();

    const r = await cancelForReissue(inv);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await col("invoices").countDocuments({ _id: oid(inv._id) })).toBe(0);
    const archived: any = await col("archived_invoices").findOne({ invoiceNo: inv.invoiceNo });
    expect(archived.mode).toBe("REISSUE");
    expect(archived.snapshot.invoiceNo).toBe(inv.invoiceNo);
    expect(archived.pdfArchiveKey).toBe(`invoices/archived/${archived._id}.pdf`);
    expect(pdfStore.archiveInvoicePdf).toHaveBeenCalledWith(inv.invoiceNo, String(archived._id));
    const res: any = await col("invoice_number_reservations").findOne({ number: inv.invoiceNo });
    expect(res).toMatchObject({ status: "RESERVED", issuerGstin: KA, seriesPrefix: "", cadence: "annual", period: "2026", counterKey: "invoice:FY2026" });
    const bk: any = await col("manualbookings").findOne({ _id: oid(b) });
    expect(bk.status).toBe("CONFIRMED");
    expect(bk.invoiceId ?? null).toBeNull();

    // The operator must decide — never silent (D5).
    const undecided = await generate([b]);
    expect(undecided.status).toBe(409);
    expect(undecided.body.code).toBe("RESERVATION_DECISION_REQUIRED");
    expect(undecided.body.reservation.number).toBe(inv.invoiceNo);

    const reused = await generate([b], { reservation: { action: "REUSE", reservationId: String(res._id) } });
    expect(reused.status, JSON.stringify(reused.body)).toBe(201);
    expect(reused.body.invoice.invoiceNo).toBe(inv.invoiceNo);
    expect(reused.body.reissued).toMatchObject({ invoiceNo: inv.invoiceNo, pdfUrl: `https://s3.test/invoices/${inv.invoiceNo}.pdf` });
    expect(pdfStore.storeInvoicePdf).toHaveBeenCalledWith(inv.invoiceNo, expect.anything());

    expect(await counterSeqs()).toEqual(before);
    const consumed: any = await col("invoice_number_reservations").findOne({ _id: res._id });
    expect(consumed.status).toBe("CONSUMED");
    expect(String(consumed.consumedInvoiceId)).toBe(String(reused.body.invoice._id));
    const arch2: any = await col("archived_invoices").findOne({ _id: archived._id });
    expect(String(arch2.reissuedAsInvoiceId)).toBe(String(reused.body.invoice._id));
    const live: any = await col("invoices").findOne({ _id: oid(reused.body.invoice._id) });
    expect(live.editHistory[0]).toMatchObject({ fieldsChanged: ["invoiceNo"], newValues: { invoiceNo: inv.invoiceNo } });
    expect(String(live.editHistory[0].newValues.reservationId)).toBe(String(res._id));

    // The history tab reads the archive + reservation rows.
    const h = await get("/reissue-history");
    expect(h.status).toBe(200);
    expect(h.body.archived[0]).toMatchObject({ invoiceNo: inv.invoiceNo, mode: "REISSUE", reissuedAsInvoiceNo: inv.invoiceNo, reason: REASON });
    expect(h.body.reservations[0].status).toBe("CONSUMED");
  });

  it("KEEP takes a fresh number and leaves the reservation RESERVED; RELEASE frees the bookings with a reason", async () => {
    const b1 = await booking();
    const inv1 = await generated([b1]);
    await cancelForReissue(inv1);
    const res1: any = await col("invoice_number_reservations").findOne({ number: inv1.invoiceNo });
    const kept = await generate([b1], { reservation: { action: "KEEP", reservationId: String(res1._id) } });
    expect(kept.status).toBe(201);
    expect(kept.body.invoice.invoiceNo).not.toBe(inv1.invoiceNo);
    expect((await col("invoice_number_reservations").findOne({ _id: res1._id }))!.status).toBe("RESERVED");

    const b2 = await booking();
    const inv2 = await generated([b2]);
    await cancelForReissue(inv2);
    const res2: any = await col("invoice_number_reservations").findOne({ number: inv2.invoiceNo });
    const short = await generate([b2], { reservation: { action: "RELEASE", reservationId: String(res2._id), releaseReason: "nope" } });
    expect(short.status).toBe(400);
    expect((await col("invoice_number_reservations").findOne({ _id: res2._id }))!.status).toBe("RESERVED");
    const released = await generate([b2], { reservation: { action: "RELEASE", reservationId: String(res2._id), releaseReason: "Reissue abandoned, customer changed plans" } });
    expect(released.status).toBe(201);
    expect(released.body.invoice.invoiceNo).not.toBe(inv2.invoiceNo);
    expect((await col("invoice_number_reservations").findOne({ _id: res2._id }))).toMatchObject({ status: "RELEASED", releaseReason: "Reissue abandoned, customer changed plans" });
  });

  it("a reservation can be released on its own (reason ≥ 10 chars)", async () => {
    const b = await booking();
    const inv = await generated([b]);
    await cancelForReissue(inv);
    const res: any = await col("invoice_number_reservations").findOne({ number: inv.invoiceNo });
    expect((await post(`/reservations/${res._id}/release`, { reason: "short" })).status).toBe(400);
    const ok = await post(`/reservations/${res._id}/release`, { reason: "Booking was cancelled by the client" });
    expect(ok.status).toBe(200);
    expect(ok.body.reservation.status).toBe("RELEASED");
    expect((await post(`/reservations/${res._id}/release`, { reason: "Booking was cancelled by the client" })).status).toBe(409);
    // No reservation left → plain generate, fresh number.
    const again = await generate([b]);
    expect(again.status).toBe(201);
    expect(again.body.invoice.invoiceNo).not.toBe(inv.invoiceNo);
  });
});

/* ── splits (D4) ────────────────────────────────────────────────────── */

describe("split: one reservation, several invoices", () => {
  it("bulk-generate gives the reserved number to the picked booking; the rest take fresh numbers", async () => {
    const a = await booking();
    const b = await booking();
    const inv = await generated([a, b]);
    await cancelForReissue(inv);
    const res: any = await col("invoice_number_reservations").findOne({ number: inv.invoiceNo });
    const before = await counterSeqs();

    const noPick = await post("/bulk-generate", { bookingIds: [a, b], invoiceDate: TODAY, reservation: { action: "REUSE", reservationId: String(res._id) } });
    expect(noPick.status).toBe(400);
    expect(noPick.body.code).toBe("RESERVATION_BOOKING_REQUIRED");
    expect(await col("invoices").countDocuments()).toBe(0);

    const r = await post("/bulk-generate", { bookingIds: [a, b], invoiceDate: TODAY, reservation: { action: "REUSE", reservationId: String(res._id), bookingId: b } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.generated).toHaveLength(2);
    const byBooking = Object.fromEntries(r.body.generated.map((g: any) => [g.bookingId, g.invoiceNo]));
    expect(byBooking[b]).toBe(inv.invoiceNo);
    expect(byBooking[a]).not.toBe(inv.invoiceNo);
    expect(r.body.reissued.invoiceNo).toBe(inv.invoiceNo);

    const after = await counterSeqs();
    expect(after["invoice:FY2026"]).toBe(before["invoice:FY2026"] + 1); // only the fresh one drew a number
    expect((await col("invoice_number_reservations").findOne({ _id: res._id }))!.status).toBe("CONSUMED");
  });

  it("/generate on a subset of the reserved bookings may reuse; a booking outside the reservation may not", async () => {
    const a = await booking();
    const b = await booking();
    const inv = await generated([a, b]);
    await cancelForReissue(inv);
    const res: any = await col("invoice_number_reservations").findOne({ number: inv.invoiceNo });
    const c = await booking();

    const mixed = await generate([a, c], { reservation: { action: "REUSE", reservationId: String(res._id) } });
    expect(mixed.status).toBe(400);
    expect(mixed.body.code).toBe("RESERVATION_BOOKINGS_MISMATCH");

    const subset = await generate([a], { reservation: { action: "REUSE", reservationId: String(res._id) } });
    expect(subset.status).toBe(201);
    expect(subset.body.invoice.invoiceNo).toBe(inv.invoiceNo);
    // b no longer holds a reservation (it was consumed) → plain generate.
    const rest = await generate([b]);
    expect(rest.status).toBe(201);
    expect(rest.body.invoice.invoiceNo).not.toBe(inv.invoiceNo);
  });
});

/* ── series (D1) ────────────────────────────────────────────────────── */

describe("the reserved number is only reused in its own series and period", () => {
  it("a different issuer GSTIN refuses reuse and says why; nothing is written", async () => {
    const b = await booking();
    const inv = await generated([b]);
    await cancelForReissue(inv);
    const res: any = await col("invoice_number_reservations").findOne({ number: inv.invoiceNo });

    const check = await get(`/reservations/check?bookingIds=${b}&sellerGstin=${MH}&invoiceDate=${TODAY}`);
    expect(check.status).toBe(200);
    expect(check.body.reservations[0]).toMatchObject({ number: inv.invoiceNo, reuseOffered: false, whyCode: "RESERVATION_SERIES_MISMATCH" });
    expect(check.body.reservations[0].why).toContain(MH);
    const okCheck = await get(`/reservations/check?bookingIds=${b}&invoiceDate=${TODAY}`);
    expect(okCheck.body.reservations[0]).toMatchObject({ reuseOffered: true, coversAll: true, suggestedInvoiceDate: TODAY });

    const before = await counterSeqs();
    const r = await generate([b], { sellerGstin: MH, reservation: { action: "REUSE", reservationId: String(res._id) } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("RESERVATION_SERIES_MISMATCH");
    expect(await col("invoices").countDocuments()).toBe(0);
    expect(await counterSeqs()).toEqual(before);
    expect((await col("invoice_number_reservations").findOne({ _id: res._id }))!.status).toBe("RESERVED");
    expect(((await col("manualbookings").findOne({ _id: oid(b) })) as any).invoiceId ?? null).toBeNull();
  });

  it("an invoice date outside the number's FY refuses reuse (annual series)", async () => {
    const b = await booking();
    const inv = await generated([b]);
    await cancelForReissue(inv);
    const res: any = await col("invoice_number_reservations").findOne({ number: inv.invoiceNo });
    const r = await generate([b], { invoiceDate: "2027-04-02", reservation: { action: "REUSE", reservationId: String(res._id) } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("RESERVATION_PERIOD_MISMATCH");
    expect(r.body.error).toContain("FY 2026-27");
  });

  it("monthly series: the date must fall in the number's own month", async () => {
    await col("companysettings").updateOne({}, { $set: { invoiceSeriesCadence: "monthly" } });
    const b = await booking();
    const inv = await generated([b], { sellerGstin: MH });
    const ym = TODAY.slice(0, 7).replace("-", "");
    expect(inv.invoiceNo).toMatch(new RegExp(`^INV-MH${ym}\\d{4}$`));
    await cancelForReissue(inv);
    const res: any = await col("invoice_number_reservations").findOne({ number: inv.invoiceNo });
    expect(res).toMatchObject({ issuerGstin: MH, seriesPrefix: "MH", cadence: "monthly", period: ym, counterKey: `invoice:${ym}:${MH}` });

    const [y, m] = TODAY.split("-").map(Number);
    const otherMonth = m === 12 ? `${y}-11-15` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const wrong = await generate([b], { sellerGstin: MH, invoiceDate: otherMonth, reservation: { action: "REUSE", reservationId: String(res._id) } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("RESERVATION_PERIOD_MISMATCH");

    const right = await generate([b], { sellerGstin: MH, reservation: { action: "REUSE", reservationId: String(res._id) } });
    expect(right.status).toBe(201);
    expect(right.body.invoice.invoiceNo).toBe(inv.invoiceNo);
  });
});

/* ── delete (gap) ───────────────────────────────────────────────────── */

describe("delete invoice", () => {
  it("archives without reserving; the number is never handed out again", async () => {
    const b = await booking();
    const inv = await generated([b]);
    const r = await post(`/${inv._id}/delete`, { reason: REASON, confirmText: inv.invoiceNo });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.reservationId).toBeNull();
    expect(await col("invoice_number_reservations").countDocuments()).toBe(0);
    expect(((await col("archived_invoices").findOne({ invoiceNo: inv.invoiceNo })) as any).mode).toBe("DELETE");

    const again = await generate([b]);
    expect(again.status).toBe(201);
    const seqOf = (no: string) => Number(no.slice(-4));
    expect(seqOf(again.body.invoice.invoiceNo)).toBe(seqOf(inv.invoiceNo) + 1); // a gap, not a reuse
  });
});

/* ── blockers / confirm / permissions ───────────────────────────────── */

describe("blockers and confirmation", () => {
  it("wrong confirm text or a short reason is refused and nothing changes", async () => {
    const b = await booking();
    const inv = await generated([b]);
    const wrong = await cancelForReissue(inv, { confirmText: inv.invoiceNo.toLowerCase() });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("CONFIRM_TEXT_MISMATCH");
    const short = await cancelForReissue(inv, { reason: "too short" });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe("REASON_TOO_SHORT");
    expect(await col("invoices").countDocuments({ _id: oid(inv._id) })).toBe(1);
    expect(await col("archived_invoices").countDocuments()).toBe(0);
    expect(pdfStore.archiveInvoicePdf).not.toHaveBeenCalled();
  });

  it("PAID, PAYMENT_DECLARED and CANCELLED are refused for both actions; a draft credit note blocks with its own message", async () => {
    for (const status of ["PAID", "PAYMENT_DECLARED", "CANCELLED"]) {
      const inv = await generated([await booking()]);
      await col("invoices").updateOne({ _id: oid(inv._id) }, { $set: { status } });
      for (const path of ["cancel-for-reissue", "delete"]) {
        const r = await post(`/${inv._id}/${path}`, { reason: REASON, confirmText: inv.invoiceNo });
        expect(r.status, `${status} ${path}`).toBe(400);
        expect(r.body.code).toBe("ARCHIVE_BLOCKED");
      }
    }
    const inv = await generated([await booking()]);
    await col("creditnotes").insertOne({ _id: oid(), creditNoteNo: "CN-DRAFT-1", originalInvoiceId: oid(inv._id), status: "DRAFT" } as any);
    const r = await cancelForReissue(inv);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("Delete the draft credit note first");
    const preview = await get(`/${inv._id}/archive-preview?mode=DELETE`);
    expect(preview.body.blockers.join(" ")).toContain("CN-DRAFT-1");
  });

  it("a received payment link blocks; an open one is only a warning", async () => {
    const inv = await generated([await booking()]);
    await col("paymentrequests").insertOne({ _id: oid(), subject: "INVOICE", subjectId: oid(inv._id), status: "OPEN", links: [{ referenceId: "ref-open" }] } as any);
    const p1 = await get(`/${inv._id}/archive-preview?mode=REISSUE`);
    expect(p1.body.blockers).toEqual([]);
    expect(p1.body.warnings.join(" ")).toContain("open payment link");
    await col("paymentrequests").insertOne({ _id: oid(), subject: "INVOICE", subjectId: oid(inv._id), status: "PARTLY_PAID", links: [{ referenceId: "ref-paid" }] } as any);
    const p2 = await get(`/${inv._id}/archive-preview?mode=REISSUE`);
    expect(p2.body.blockers.join(" ")).toContain("received money");
  });

  it("previous-month warning shows for SENT only (D10)", async () => {
    const inv = await generated([await booking()]);
    const old = new Date(Date.now() - 70 * 86400000);
    await col("invoices").updateOne({ _id: oid(inv._id) }, { $set: { invoiceDate: old } });
    const draft = await get(`/${inv._id}/archive-preview?mode=REISSUE`);
    expect(draft.body.warnings.join(" ")).not.toContain("GSTR-1");
    await col("invoices").updateOne({ _id: oid(inv._id) }, { $set: { status: "SENT", sentAt: new Date() } });
    const sent = await get(`/${inv._id}/archive-preview?mode=REISSUE`);
    expect(sent.body.blockers).toEqual([]);
    expect(sent.body.warnings.join(" ")).toContain("GSTR-1");
  });
});

describe("permissions (D9)", () => {
  it("needs invoices WRITE AND the action's own key; SuperAdmin always passes", async () => {
    const inv = await generated([await booking()]);
    const writeOnly = await staff({ invoices: "WRITE" });
    expect((await cancelForReissue(inv, {}, writeOnly)).status).toBe(403);
    expect((await post(`/${inv._id}/delete`, { reason: REASON, confirmText: inv.invoiceNo }, writeOnly)).status).toBe(403);

    const keyOnly = await staff({ invoices: "READ", invoiceReissue: "FULL" });
    expect((await cancelForReissue(inv, {}, keyOnly)).status).toBe(403);

    const deleter = await staff({ invoices: "WRITE", invoiceDelete: "READ" });
    expect((await cancelForReissue(inv, {}, deleter)).status).toBe(403); // delete key ≠ reissue key

    // A tenant-admin style doc (roleType SUPERADMIN) without the key is refused too.
    const tenantAdmin = await staff({ invoices: "FULL" }, { roleType: "SUPERADMIN" });
    expect((await cancelForReissue(inv, {}, tenantAdmin)).status).toBe(403);

    // The history tab is platform SuperAdmin only.
    expect((await get("/reissue-history", deleter)).status).toBe(403);

    const reissuer = await staff({ invoices: "WRITE", invoiceReissue: "READ" });
    const ok = await cancelForReissue(inv, {}, reissuer);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await col("invoices").countDocuments({ _id: oid(inv._id) })).toBe(0);
  });

  it("releasing at generate needs the reissue key; reusing does not", async () => {
    const b = await booking();
    const inv = await generated([b]);
    await cancelForReissue(inv);
    const res: any = await col("invoice_number_reservations").findOne({ number: inv.invoiceNo });
    const writer = await staff({ invoices: "WRITE" });
    const rel = await generate([b], { reservation: { action: "RELEASE", reservationId: String(res._id), releaseReason: "Reissue abandoned by finance" } }, writer);
    expect(rel.status).toBe(403);
    const reuse = await generate([b], { reservation: { action: "REUSE", reservationId: String(res._id) } }, writer);
    expect(reuse.status, JSON.stringify(reuse.body)).toBe(201);
    expect(reuse.body.invoice.invoiceNo).toBe(inv.invoiceNo);
  });

  it("invoices WRITE alone cannot release by any route but can keep; the reissue key can release", async () => {
    const b = await booking();
    const inv = await generated([b]);
    await cancelForReissue(inv);
    const res: any = await col("invoice_number_reservations").findOne({ number: inv.invoiceNo });
    const id = String(res._id);
    const releaseReason = "Reissue abandoned by finance";
    const writer = await staff({ invoices: "WRITE" });

    expect((await post(`/reservations/${id}/release`, { reason: releaseReason }, writer)).status).toBe(403);
    expect((await generate([b], { reservation: { action: "RELEASE", reservationId: id, releaseReason } }, writer)).status).toBe(403);
    const bulk = await post("/bulk-generate", { bookingIds: [b], invoiceDate: TODAY, reservation: { action: "RELEASE", reservationId: id, releaseReason } }, writer);
    expect(bulk.status).toBe(403);
    expect(await col("invoice_number_reservations").findOne({ _id: res._id })).toMatchObject({ status: "RESERVED" });

    const kept = await generate([b], { reservation: { action: "KEEP", reservationId: id } }, writer);
    expect(kept.status, JSON.stringify(kept.body)).toBe(201);
    expect(kept.body.invoice.invoiceNo).not.toBe(inv.invoiceNo);
    expect(await col("invoice_number_reservations").findOne({ _id: res._id })).toMatchObject({ status: "RESERVED" });

    const reissuer = await staff({ invoices: "WRITE", invoiceReissue: "READ" });
    const released = await post(`/reservations/${id}/release`, { reason: releaseReason }, reissuer);
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.reservation.status).toBe("RELEASED");
  });
});

/* ── atomicity / concurrency ────────────────────────────────────────── */

describe("transactions", () => {
  it("a failure inside the archive transaction rolls everything back", async () => {
    const b = await booking();
    const inv = await generated([b]);
    const spy = vi.spyOn(InvoiceNumberReservation, "create").mockRejectedValueOnce(new Error("server died mid-write"));
    try {
      const r = await cancelForReissue(inv);
      expect(r.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await col("invoices").countDocuments({ _id: oid(inv._id) })).toBe(1);
    expect(await col("archived_invoices").countDocuments()).toBe(0);
    expect(await col("invoice_number_reservations").countDocuments()).toBe(0);
    const bk: any = await col("manualbookings").findOne({ _id: oid(b) });
    expect(bk.status).toBe("INVOICED");
    expect(String(bk.invoiceId)).toBe(String(inv._id));
  });

  it("only one RESERVED row per number (partial unique index); consumed rows don't count", async () => {
    const base = { counterKey: "invoice:FY2026", issuerGstin: KA, seriesPrefix: "", cadence: "annual", period: "2026",
      workspaceId: oid(), bookingIds: [], archivedInvoiceId: oid(), createdAt: new Date(), createdBy: SA_ID };
    await InvoiceNumberReservation.create({ ...base, number: "INV-20269999", status: "CONSUMED" });
    await InvoiceNumberReservation.create({ ...base, number: "INV-20269999", status: "RESERVED" });
    await expect(InvoiceNumberReservation.create({ ...base, number: "INV-20269999", status: "RESERVED" })).rejects.toMatchObject({ code: 11000 });
  });

  it("two users reusing one reservation at the same time: exactly one gets the number, the Counter is untouched", async () => {
    const a = await booking();
    const b = await booking();
    const inv = await generated([a, b]);
    await cancelForReissue(inv);
    const res: any = await col("invoice_number_reservations").findOne({ number: inv.invoiceNo });
    const before = await counterSeqs();

    const decision = { action: "REUSE" as const, reservationId: String(res._id) };
    const runs = await Promise.allSettled([
      createInvoiceFromBookings([a], { format: "COMBINED", createdBy: String(SA_ID), reservation: decision, invoiceDate: new Date() }),
      createInvoiceFromBookings([b], { format: "COMBINED", createdBy: String(SA_ID), reservation: decision, invoiceDate: new Date() }),
    ]);
    const won = runs.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any[]>[];
    const lost = runs.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason.httpStatus).toBe(409);
    expect(lost[0].reason.body.code).toBe("RESERVATION_ALREADY_USED");
    expect(won[0].value[0].invoiceNo).toBe(inv.invoiceNo);

    expect(await col("invoices").countDocuments({ invoiceNo: inv.invoiceNo })).toBe(1);
    expect(await col("invoices").countDocuments()).toBe(1);
    expect(await counterSeqs()).toEqual(before);
    const loserBooking = String(won[0].value[0].bookingIds[0]) === a ? b : a;
    const lb: any = await col("manualbookings").findOne({ _id: oid(loserBooking) });
    expect(lb.status).toBe("CONFIRMED");
    expect(lb.invoiceId ?? null).toBeNull();

    // A concurrent ordinary generate for another booking still draws normally.
    const c = await booking();
    const fresh = await generated([c]);
    expect(fresh.invoiceNo).not.toBe(inv.invoiceNo);
  });
});

/* ── unit: series parsing ───────────────────────────────────────────── */

describe("seriesOfInvoice / periodOfDate", async () => {
  const { seriesOfInvoice, periodOfDate } = await import("../services/invoiceReissue.js");
  const cs = { invoiceSeriesCadence: "monthly", gstProfiles: [{ gstin: KA, invoiceSeriesPrefix: "" }, { gstin: MH, invoiceSeriesPrefix: "MH" }] };
  it("parses both number styles", () => {
    expect(seriesOfInvoice({ invoiceNo: "INV-20260970", issuerDetails: { gstin: KA } }, cs))
      .toEqual({ issuerGstin: KA, seriesPrefix: "", cadence: "annual", period: "2026", counterKey: "invoice:FY2026" });
    expect(seriesOfInvoice({ invoiceNo: "INV-MH2026070005", issuerDetails: { gstin: MH } }, cs))
      .toEqual({ issuerGstin: MH, seriesPrefix: "MH", cadence: "monthly", period: "202607", counterKey: `invoice:202607:${MH}` });
    expect(seriesOfInvoice({ invoiceNo: "INV-20260970", issuerDetails: { gstin: MH } }, cs)).toBeNull();
  });
  it("uses the IST calendar, FY from April", () => {
    expect(periodOfDate(new Date("2026-03-31T20:00:00Z"), "annual")).toBe("2026"); // 1 Apr 01:30 IST
    expect(periodOfDate(new Date("2026-03-31T18:00:00Z"), "annual")).toBe("2025"); // 31 Mar 23:30 IST
    expect(periodOfDate(new Date("2026-06-30T19:00:00Z"), "monthly")).toBe("202607");
  });
});

/* ── follow-up 1: post-commit side effects are reported, stored, retryable ── */

const { archiveSideEffectSteps } = await import("../services/invoiceReissue.js");

describe("post-archive side effects", () => {
  it("a payment-link cancel that throws is returned, stored on the archive row, shown in history and retryable", async () => {
    const b = await booking();
    const inv = await generated([b]);
    const spy = vi.spyOn(archiveSideEffectSteps, "paymentLinks").mockRejectedValueOnce(new Error("Razorpay unreachable"));
    let r: request.Response;
    try {
      r = await cancelForReissue(inv);
    } finally {
      spy.mockRestore();
    }
    // The archive itself stands — the failure is a follow-up, not a rollback.
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await col("invoices").countDocuments({ _id: oid(inv._id) })).toBe(0);
    expect(r.body.sideEffectFailures).toHaveLength(1);
    expect(r.body.sideEffectFailures[0]).toMatchObject({ step: "paymentLinks", label: "Cancel open payment links", error: "Razorpay unreachable" });

    const row: any = await col("archived_invoices").findOne({ _id: oid(r.body.archivedInvoiceId) });
    expect(row.sideEffectFailures.map((f: any) => f.step)).toEqual(["paymentLinks"]);
    // The other two steps still ran.
    expect(row.sideEffectLog.map((l: any) => [l.step, l.ok])).toEqual([["paymentLinks", false], ["partnerShare", true], ["loyalty", true]]);

    const h = await get("/reissue-history");
    expect(h.body.archived[0].sideEffectFailures[0]).toMatchObject({ step: "paymentLinks", error: "Razorpay unreachable" });

    // Retry is platform SuperAdmin only.
    const reissuer = await staff({ invoices: "FULL", invoiceReissue: "FULL" });
    expect((await post(`/archived/${row._id}/retry-side-effects`, {}, reissuer)).status).toBe(403);

    const retried = await post(`/archived/${row._id}/retry-side-effects`);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.sideEffectFailures).toEqual([]);
    const after: any = await col("archived_invoices").findOne({ _id: row._id });
    expect(after.sideEffectFailures).toEqual([]);
    expect(after.sideEffectLog.at(-1)).toMatchObject({ step: "paymentLinks", ok: true }); // only the failed step re-ran
    expect(after.sideEffectLog).toHaveLength(4);
    expect((await post(`/archived/${row._id}/retry-side-effects`)).body.code).toBe("NOTHING_TO_RETRY");
  });

  it("a retry that fails again keeps the failure (with the new error)", async () => {
    const inv = await generated([await booking()]);
    const spy = vi.spyOn(archiveSideEffectSteps, "loyalty")
      .mockRejectedValueOnce(new Error("lease busy"))
      .mockRejectedValueOnce(new Error("still busy"));
    try {
      const r = await post(`/${inv._id}/delete`, { reason: REASON, confirmText: inv.invoiceNo });
      expect(r.body.sideEffectFailures[0]).toMatchObject({ step: "loyalty", error: "lease busy" });
      const again = await post(`/archived/${r.body.archivedInvoiceId}/retry-side-effects`);
      expect(again.body.sideEffectFailures[0]).toMatchObject({ step: "loyalty", error: "still busy" });
      const row: any = await col("archived_invoices").findOne({ _id: oid(r.body.archivedInvoiceId) });
      expect(row.sideEffectFailures[0].error).toBe("still busy");
    } finally {
      spy.mockRestore();
    }
  });
});

/* ── follow-up 2: a TENANT ADMIN never passes, whatever my-access says ── */

const { default: permissionsRouter } = await import("./permissions.js");
const permApp = express();
permApp.use(express.json());
permApp.use("/api/permissions", withWs, permissionsRouter);

describe("tenant admin (not platform SuperAdmin)", () => {
  async function tenantAdmin(extraModules: Record<string, string> = {}) {
    const cws: any = await col("customerworkspaces").findOne({ customerId: String(CUST) });
    const ws = String(cws._id);
    const id = oid();
    const email = `${id}@tenant.test`;
    await col("users").insertOne({ _id: id, email, name: "Tenant Admin", roles: ["ADMIN"], workspaceId: ws } as any);
    const modules: any = { invoices: { access: "FULL", scope: "ALL" } };
    for (const [k, v] of Object.entries(extraModules)) modules[k] = { access: v, scope: "ALL" };
    await UserPermission.create({
      userId: String(id), email, workspaceId: ws, universe: "STAFF", roleType: "SUPERADMIN",
      level: { code: "L8", name: "Workspace Admin" }, modules, grantedBy: "test",
    } as any);
    return { user: { _id: String(id), id: String(id), sub: String(id), roles: ["ADMIN"], workspaceId: ws, email }, ws };
  }
  const tcall = (who: { user: any; ws: string }, r: request.Test) => r.set("x-test-user", JSON.stringify(who.user)).set("x-test-ws", who.ws);

  async function expectAllRefused(who: { user: any; ws: string }, inv: any, reservationId: string, archivedId: string) {
    const base = "/api/admin/invoices";
    const calls: Array<[string, request.Test]> = [
      ["cancel-for-reissue", request(app).post(`${base}/${inv._id}/cancel-for-reissue`).send({ reason: REASON, confirmText: inv.invoiceNo })],
      ["delete", request(app).post(`${base}/${inv._id}/delete`).send({ reason: REASON, confirmText: inv.invoiceNo })],
      ["archive-preview", request(app).get(`${base}/${inv._id}/archive-preview?mode=REISSUE`)],
      ["release", request(app).post(`${base}/reservations/${reservationId}/release`).send({ reason: "Tenant admin trying to release" })],
      ["history", request(app).get(`${base}/reissue-history`)],
      ["archived pdf", request(app).get(`${base}/archived/${archivedId}/pdf`)],
      ["retry", request(app).post(`${base}/archived/${archivedId}/retry-side-effects`).send({})],
    ];
    for (const [name, call] of calls) {
      const res = await tcall(who, call);
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(403);
    }
    // Nothing moved.
    expect(await col("invoices").countDocuments({ _id: oid(inv._id) })).toBe(1);
    expect((await col("invoice_number_reservations").findOne({ _id: oid(reservationId) }))!.status).toBe("RESERVED");
  }

  async function fixtures() {
    // A live invoice in the tenant admin's own workspace, plus a reservation
    // and an archive row from an earlier reissue.
    const inv = await generated([await booking()]);
    const old = await generated([await booking()]);
    await cancelForReissue(old);
    const res: any = await col("invoice_number_reservations").findOne({ number: old.invoiceNo });
    return { inv, reservationId: String(res._id), archivedId: String(res.archivedInvoiceId) };
  }

  it("default grants (no reissue/delete keys): 403 on archive, delete, preview, release, history, archived PDF, retry", async () => {
    const { inv, reservationId, archivedId } = await fixtures();
    const ta = await tenantAdmin();
    // They are inside the door for their own workspace — the 403s below are the reissue gates, not the mount.
    const read = await tcall(ta, request(app).get(`/api/admin/invoices/${inv._id}`));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    await expectAllRefused(ta, inv, reservationId, archivedId);
  });

  it("even with the keys stored FULL on their permission doc (independent of my-access) they are still refused", async () => {
    const { inv, reservationId, archivedId } = await fixtures();
    const ta = await tenantAdmin({ invoiceReissue: "FULL", invoiceDelete: "FULL" });
    await expectAllRefused(ta, inv, reservationId, archivedId);
  });

  it("my-access does not hand a tenant admin the two keys in its synthesised full-access map", async () => {
    const ta = await tenantAdmin();
    const r = await tcall(ta, request(permApp).get("/api/permissions/my-access"));
    expect(r.status).toBe(200);
    expect(r.body.isSuperAdmin).toBe(true); // the synthesised tenant-admin view…
    expect(r.body.modules.invoices.access).toBe("FULL");
    expect(r.body.modules.invoiceReissue).toEqual({ access: "NONE", scope: "NONE" }); // …but not these
    expect(r.body.modules.invoiceDelete).toEqual({ access: "NONE", scope: "NONE" });
  });
});

/* ── follow-up 3: the reissued invoice recalculates partner share + loyalty ── */

const { default: LoyaltyLedger } = await import("../models/LoyaltyLedger.js");

describe("regenerating the reissued invoice goes through the normal generate path", () => {
  const pointsFor = async (invoiceId: string) => {
    const rows = await LoyaltyLedger.find({ invoiceId: String(invoiceId) }).lean();
    return rows.reduce((s, r: any) => s + r.points, 0);
  };

  it("partner share is snapshotted afresh (current config) and loyalty is reversed, then earned on the new invoice", async () => {
    const cws: any = await col("customerworkspaces").findOne({ customerId: String(CUST) });
    await col("partnerrevenueconfigs").insertOne({ workspaceId: cws._id, enabled: true, visiblePct: 50, sharePct: 40, version: 1, reason: "test" } as any);
    await col("customers").updateOne({ _id: CUST }, { $set: { gstNumber: "29AAACA1234A1Z5" } }); // enrolled in loyalty

    const b = await booking();
    const base = ((await col("manualbookings").findOne({ _id: oid(b) })) as any).pricing.basePrice;
    expect(base).toBeGreaterThan(0);
    const inv = await generated([b]);
    expect(((await col("manualbookings").findOne({ _id: oid(b) })) as any).partnerShare)
      .toMatchObject({ sharePct: 40, configVersion: 1, share: Math.round(base * 0.5 * 0.4 * 100) / 100 });

    // Sent → it earns points (loyalty follows status: SENT / PAID count, DRAFT does not).
    expect((await as(SA, request(app).put(`/api/admin/invoices/${inv._id}/status`)).send({ status: "SENT" })).status).toBe(200);
    await vi.waitFor(async () => expect(await pointsFor(inv._id)).toBeGreaterThan(0), { timeout: 5000, interval: 100 });
    const earned = await pointsFor(inv._id);

    const r = await cancelForReissue(inv);
    expect(r.status).toBe(200);
    expect(r.body.sideEffectFailures).toEqual([]);
    expect(((await col("manualbookings").findOne({ _id: oid(b) })) as any).partnerShare).toBeUndefined();
    expect(await pointsFor(inv._id)).toBe(0); // reversed

    // The partner terms change before the reissue: the new invoice must use them.
    await col("partnerrevenueconfigs").updateOne({ workspaceId: cws._id }, { $set: { sharePct: 20, version: 2 } });
    const res: any = await col("invoice_number_reservations").findOne({ number: inv.invoiceNo });
    const reused = await generate([b], { reservation: { action: "REUSE", reservationId: String(res._id) } });
    expect(reused.status).toBe(201);
    const newId = String(reused.body.invoice._id);
    expect(newId).not.toBe(String(inv._id));
    expect(((await col("manualbookings").findOne({ _id: oid(b) })) as any).partnerShare)
      .toMatchObject({ sharePct: 20, configVersion: 2, share: Math.round(base * 0.5 * 0.2 * 100) / 100 });

    expect(await pointsFor(newId)).toBe(0); // a DRAFT earns nothing yet — same as any new invoice
    expect((await as(SA, request(app).put(`/api/admin/invoices/${newId}/status`)).send({ status: "SENT" })).status).toBe(200);
    await vi.waitFor(async () => expect(await pointsFor(newId)).toBe(earned), { timeout: 5000, interval: 100 });
    expect(await pointsFor(inv._id)).toBe(0);
  });
});

/* ── fail closed: no reserved-number unique index → reissue + reuse are 503 ── */

const { resetReservedIndexCheck, RESERVED_INDEX_RECHECK_MS } = await import("../bootstrap/ensureInvoiceReissueIndexes.js");

describe("reserved-number index missing", () => {
  const MSG = "Invoice reissue is temporarily unavailable — reservation index missing, contact SuperAdmin";
  const dropIndex = async () => {
    await col("invoice_number_reservations").dropIndex("number_reserved_unique");
    resetReservedIndexCheck(); // as if the server had booted without it
  };
  let clock: ReturnType<typeof vi.spyOn> | null = null;
  afterEach(async () => {
    clock?.mockRestore();
    clock = null;
    await InvoiceNumberReservation.createIndexes();
    resetReservedIndexCheck();
  });

  it("cancel-for-reissue and REUSE (generate + bulk) return 503; delete, KEEP, RELEASE, history and plain generate still work", async () => {
    // Reservations made while the index was there.
    const [b1, b2, b3, b4] = [await booking(), await booking(), await booking(), await booking()];
    const reserve = async (b: string) => {
      const inv = await generated([b]);
      expect((await cancelForReissue(inv)).status).toBe(200);
      return { inv, res: (await col("invoice_number_reservations").findOne({ number: inv.invoiceNo })) as any };
    };
    const r1 = await reserve(b1);
    const r2 = await reserve(b2);
    const r3 = await reserve(b3);
    const live = await generated([b4]);

    // With the index there, nothing on open says otherwise.
    expect((await get(`/${live._id}/archive-preview?mode=REISSUE`)).body.reservationIndexAvailable).toBe(true);
    const okCheck = await get(`/reservations/check?bookingIds=${b1}&invoiceDate=${TODAY}`);
    expect(okCheck.body.reservations[0]).toMatchObject({ reuseOffered: true, why: null });

    await dropIndex();

    // The lookups the modal and the generate popups make on open report it.
    expect((await get(`/${live._id}/archive-preview?mode=REISSUE`)).body.reservationIndexAvailable).toBe(false);
    const delPreview = await get(`/${live._id}/archive-preview?mode=DELETE`);
    expect(delPreview.body.reservationIndexAvailable).toBe(false);
    expect(delPreview.body.blockers).toEqual([]); // the flag alone never blocks Delete
    const check = await get(`/reservations/check?bookingIds=${b1}&invoiceDate=${TODAY}`);
    expect(check.body.reservations[0]).toMatchObject({ reuseOffered: false, why: MSG, whyCode: "RESERVATION_INDEX_MISSING" });

    const cancel = await cancelForReissue(live);
    expect(cancel.status).toBe(503);
    expect(cancel.body).toMatchObject({ error: MSG, code: "RESERVATION_INDEX_MISSING" });
    expect(await col("invoices").countDocuments({ _id: oid(live._id) })).toBe(1); // nothing moved

    const reuse = await generate([b1], { reservation: { action: "REUSE", reservationId: String(r1.res._id) } });
    expect(reuse.status).toBe(503);
    expect(reuse.body).toMatchObject({ error: MSG, code: "RESERVATION_INDEX_MISSING" });
    const bulkReuse = await post("/bulk-generate", { bookingIds: [b1], invoiceDate: TODAY, reservation: { action: "REUSE", reservationId: String(r1.res._id), bookingId: b1 } });
    expect(bulkReuse.status).toBe(503);
    expect((await col("invoice_number_reservations").findOne({ _id: r1.res._id }))!.status).toBe("RESERVED");

    // The rest is unaffected.
    expect((await generate([b2], { reservation: { action: "KEEP", reservationId: String(r2.res._id) } })).status).toBe(201);
    expect((await generate([b3], { reservation: { action: "RELEASE", reservationId: String(r3.res._id), releaseReason: "Not reusing this number" } })).status).toBe(201);
    expect((await post(`/reservations/${r1.res._id}/release`, { reason: "Releasing while reissue is down" })).status).toBe(200);
    expect((await get("/reissue-history")).status).toBe(200);
    expect((await generated([await booking()])).invoiceNo).toMatch(/^INV-/);
    const del = await post(`/${live._id}/delete`, { reason: REASON, confirmText: live.invoiceNo });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
  });

  it("re-enables within a minute of the index being built, without a restart", async () => {
    const b = await booking();
    const inv = await generated([b]);
    await dropIndex();
    const t0 = Date.now();
    clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    expect((await cancelForReissue(inv)).status).toBe(503);

    await InvoiceNumberReservation.createIndexes(); // built by hand
    // Still the cached answer inside the minute…
    clock.mockReturnValue(t0 + RESERVED_INDEX_RECHECK_MS - 1);
    expect((await cancelForReissue(inv)).status).toBe(503);
    // …re-checked after it.
    clock.mockReturnValue(t0 + RESERVED_INDEX_RECHECK_MS);
    expect((await get(`/${inv._id}/archive-preview?mode=REISSUE`)).body.reservationIndexAvailable).toBe(true);
    // The recheck is proven. Don't run real transactions on a frozen clock.
    clock.mockRestore();
    clock = null;
    const ok = await cancelForReissue(inv);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const res: any = await col("invoice_number_reservations").findOne({ number: inv.invoiceNo });
    const reused = await generate([b], { reservation: { action: "REUSE", reservationId: String(res._id) } });
    expect(reused.status, JSON.stringify(reused.body)).toBe(201);
    expect(reused.body.invoice.invoiceNo).toBe(inv.invoiceNo);
  });
});
