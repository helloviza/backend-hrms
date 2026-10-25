// apps/backend/src/scripts/attachment-type-scripts.test.ts
//
// fix-linked-done-attachments: refuses without / with the wrong --expect-db;
// the dry run lists exactly the Done FLIGHT/HOTEL bookings of completed
// requests that hold only "other" files and writes nothing; --apply retypes
// them (recorded on the file), re-syncs the request's documents without an
// email, never touches "internal", skips several-"other" bookings unless
// --allow-multi; a re-run selects nothing.
// suggest-attachment-types: the report (booking type wins over the file name,
// no writes) and the apply of a reviewed CSV (only its rows; booked requests
// re-synced, no email; dry run by default).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  JWT_SECRET: "jwt-secret-for-tests",
  JWT_REFRESH_SECRET: "refresh-secret-for-tests",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
})) process.env[k] ||= v;

const { mails } = vi.hoisted(() => ({ mails: [] as any[] }));
vi.mock("../utils/mailer.js", () => ({
  sendMail: async (m: any) => {
    mails.push(m);
    return { messageId: "test" };
  },
}));

const { fixLinkedDoneAttachments } = await import("./fix-linked-done-attachments.js");
const { suggestAttachmentTypes, suggestFor, toCsv, parseCsv, applySuggestionsCsv } = await import("./suggest-attachment-types.js");

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const DB = "attachment-type-scripts-test";
const CUSTOMER = oid();
const STAFF = oid();
const quiet = () => {};

const R = { booked: oid(), bookedHotel: oid(), open: oid(), cancelled: oid(), bookedMulti: oid(), bookedDummy: oid() };
const B = {
  flight: oid(), hotel: oid(), notCompleted: oid(), hasTicket: oid(), cancelledReq: oid(), multi: oid(), visa: oid(), pending: oid(), dummy: oid(),
};
const A = { flightOther: oid(), flightInternal: oid(), hotelOther: oid(), openOther: oid(), multiTicket: oid(), dummyOther: oid() };

const att = (_id: any, type: string, originalFilename: string) => ({ _id, type, originalFilename, s3Key: `bookings/attachments/x/${originalFilename}`, size: 10, mimeType: "application/pdf", uploadedBy: STAFF, uploadedAt: new Date("2026-10-24") });
const booking = (_id: any, rid: any, over: any) => ({ _id, workspaceId: CUSTOMER, source: "ADMIN_QUEUE", sourceBookingId: rid, type: "FLIGHT", status: "CONFIRMED", isActive: true, bookingRef: `MB-${String(_id).slice(-4)}`, attachments: [], ...over });
const req = (_id: any, over: any) => ({ _id, customerId: CUSTOMER, workspaceId: oid(), frontlinerId: STAFF, frontlinerEmail: "asha@acme.test", managerEmail: "meera@acme.test", status: "approved", stage: "COMPLETED", adminState: "done", ticketId: `PL-${String(_id).slice(-4)}`, meta: { manualBookingId: "", bookingDocuments: [] }, history: [], ...over });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(DB));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  mails.length = 0;
  await mongoose.connection.db!.dropDatabase();
  await col("approvalrequests").insertMany([
    req(R.booked, {}),
    req(R.bookedHotel, {}),
    req(R.open, { stage: "BOOKING_IN_PROGRESS", adminState: "in_progress" }),
    req(R.cancelled, { stage: "BOOKING_CANCELLED", adminState: "cancelled" }),
    req(R.bookedMulti, {}),
    req(R.bookedDummy, {}),
  ] as any[]);
  await col("manualbookings").insertMany([
    // selected: PL-T46PH8's shape (+ an internal file that must stay internal)
    booking(B.flight, R.booked, { attachments: [att(A.flightOther, "other", "E-Ticket MR ADITYA.pdf"), att(A.flightInternal, "internal", "supplier invoice.pdf")] }),
    booking(B.hotel, R.bookedHotel, { type: "HOTEL", status: "INVOICED", attachments: [att(A.hotelOther, "other", "Hotel confirmation.pdf")] }),
    // not selected
    booking(B.notCompleted, R.open, { attachments: [att(A.openOther, "other", "t.pdf")] }),
    booking(B.hasTicket, R.booked, { attachments: [att(oid(), "ticket", "t.pdf"), att(oid(), "other", "u.pdf")] }),
    booking(B.cancelledReq, R.cancelled, { attachments: [att(oid(), "other", "t.pdf")] }),
    booking(B.visa, R.booked, { type: "VISA", attachments: [att(oid(), "other", "visa.pdf")] }),
    booking(B.pending, R.booked, { status: "PENDING", attachments: [att(oid(), "other", "t.pdf")] }),
    // selected but skipped: two "other" files
    booking(B.multi, R.bookedMulti, { attachments: [att(A.multiTicket, "other", "ticket.pdf"), att(oid(), "other", "invoice.pdf")] }),
    // selected: a dummy ticket is a ticket
    booking(B.dummy, R.bookedDummy, { type: "DUMMY_FLIGHT", attachments: [att(A.dummyOther, "other", "Dummy ticket.pdf")] }),
  ] as any[]);
});

const snapshot = async () => JSON.stringify([await col("manualbookings").find({}).sort({ _id: 1 }).toArray(), await col("approvalrequests").find({}).sort({ _id: 1 }).toArray()]);

describe("fix-linked-done-attachments", () => {
  it("refuses without --expect-db, or with the wrong one", async () => {
    await expect(fixLinkedDoneAttachments({ apply: false, log: quiet })).rejects.toThrow(/REFUSING/);
    await expect(fixLinkedDoneAttachments({ expectDb: "Plumtrips_hrms", apply: true, log: quiet })).rejects.toThrow(/REFUSING/);
  });

  it("dry run reports each selected booking and writes nothing", async () => {
    const before = await snapshot();
    const lines: string[] = [];
    const r = await fixLinkedDoneAttachments({ expectDb: DB, apply: false, log: (l) => lines.push(l) });
    expect(r.bookings.map((b) => [b.bookingId, b.action, b.files.map((f) => [f.filename, f.to])])).toEqual([
      [String(B.flight), "fix", [["E-Ticket MR ADITYA.pdf", "ticket"]]],
      [String(B.hotel), "fix", [["Hotel confirmation.pdf", "voucher"]]],
      [String(B.multi), "skip_multi", [["ticket.pdf", "ticket"], ["invoice.pdf", "ticket"]]],
      [String(B.dummy), "fix", [["Dummy ticket.pdf", "ticket"]]],
    ]);
    expect(r.bookings[0].caseNumber).toBe(`PL-${String(R.booked).slice(-4)}`);
    expect([r.fixed, r.skipped]).toEqual([0, 1]);
    expect(lines.join("\n")).toContain("DRY RUN");
    expect(await snapshot()).toBe(before);
  });

  it("--apply retypes, records the change, re-syncs documents without an email; internal untouched; re-run selects nothing", async () => {
    const r = await fixLinkedDoneAttachments({ expectDb: DB, apply: true, log: quiet });
    expect(r.fixed).toBe(3);
    expect(r.bookings.filter((b) => b.action === "fix").map((b) => b.sync)).toEqual(["documents_updated", "documents_updated", "documents_updated"]);
    expect((await col("manualbookings").findOne({ _id: B.dummy }) as any).attachments[0].type, "DUMMY_FLIGHT → ticket").toBe("ticket");

    const flight: any = await col("manualbookings").findOne({ _id: B.flight });
    expect(flight.attachments.map((a: any) => a.type)).toEqual(["ticket", "internal"]);
    expect(flight.attachments[0].typeChanges).toEqual([{ from: "other", to: "ticket", byName: "System (fix-linked-done-attachments)", at: expect.any(Date) }]);
    expect(flight.attachments[1].typeChanges).toBeUndefined();

    const doc: any = await col("approvalrequests").findOne({ _id: R.booked });
    expect(doc.meta.bookingDocuments.map((d: any) => [d.type, d.filename, d.attachmentId])).toEqual([["ticket", "E-Ticket MR ADITYA.pdf", String(A.flightOther)]]);
    expect(doc.history).toEqual([]);
    const hotelDoc: any = await col("approvalrequests").findOne({ _id: R.bookedHotel });
    expect(hotelDoc.meta.bookingDocuments.map((d: any) => d.type)).toEqual(["voucher"]);
    expect(mails).toHaveLength(0);
    expect(await col("emailoutboxes").countDocuments()).toBe(0);

    const multi: any = await col("manualbookings").findOne({ _id: B.multi });
    expect(multi.attachments.map((a: any) => a.type)).toEqual(["other", "other"]);

    const again = await fixLinkedDoneAttachments({ expectDb: DB, apply: true, log: quiet });
    expect(again.bookings.map((b) => b.bookingId)).toEqual([String(B.multi)]);
    expect(again.fixed).toBe(0);
  });

  it("--allow-multi includes a booking with several 'other' files", async () => {
    const r = await fixLinkedDoneAttachments({ expectDb: DB, apply: true, allowMulti: true, log: quiet });
    expect(r.fixed).toBe(4);
    expect((await col("manualbookings").findOne({ _id: B.multi }) as any).attachments.map((a: any) => a.type)).toEqual(["ticket", "ticket"]);
  });
});

describe("suggest-attachment-types — report", () => {
  it("the booking type wins over the file name; invoice-like names get no proposal", () => {
    expect(suggestFor("E-Ticket MR ADITYA.pdf", "FLIGHT")).toEqual({ matched: "ticket", proposedType: "ticket", note: "" });
    expect(suggestFor("eticket_6E123.pdf", "FLIGHT_RESCHEDULE")).toMatchObject({ proposedType: "ticket" });
    expect(suggestFor("Hotel Voucher.pdf", "HOTEL")).toEqual({ matched: "voucher", proposedType: "voucher", note: "" });
    expect(suggestFor("Booking Confirmation.pdf", "HOTEL")).toMatchObject({ matched: "confirmation", proposedType: "voucher" });
    expect(suggestFor("Booking Confirmation.pdf", "FLIGHT")).toMatchObject({ matched: "confirmation", proposedType: "ticket" });
    // The 17 prod mismatches: the name says one thing, the booking another.
    expect(suggestFor("flight_voucher_6a6a5afd.pdf", "FLIGHT")).toEqual({ matched: "voucher", proposedType: "ticket", note: "" });
    expect(suggestFor("Trips_Hotel_DownloadETicket.pdf", "HOTEL")).toEqual({ matched: "ticket", proposedType: "voucher", note: "" });
    expect(suggestFor("Dummy ticket.pdf", "DUMMY_FLIGHT")).toMatchObject({ proposedType: "ticket" });
    expect(suggestFor("Dummy voucher.pdf", "DUMMY_HOTEL")).toMatchObject({ proposedType: "voucher" });
    expect(suggestFor("Ticket Invoice.pdf", "FLIGHT")).toEqual({ matched: "ticket", proposedType: "", note: "also reads like an invoice / receipt — review" });
    expect(suggestFor("passport.jpg", "FLIGHT")).toBeNull();
  });

  it("refuses without --expect-db; lists 'other' files on flight / hotel (incl. dummy) bookings; writes nothing", async () => {
    await expect(suggestAttachmentTypes({ log: quiet })).rejects.toThrow(/REFUSING/);
    const before = await snapshot();
    const r = await suggestAttachmentTypes({ expectDb: DB, log: quiet });
    expect(await snapshot()).toBe(before);
    expect(r.scanned).toBe(9); // every "other" file on a flight / hotel booking (the VISA one is out)
    expect(r.rows.map((x) => [x.filename, x.proposedType])).toEqual([
      ["E-Ticket MR ADITYA.pdf", "ticket"],
      ["Hotel confirmation.pdf", "voucher"],
      ["ticket.pdf", "ticket"],
      ["Dummy ticket.pdf", "ticket"],
    ]);
    const csv = toCsv(r.rows);
    expect(csv.split("\n")[0]).toBe("bookingRef,bookingId,bookingType,bookingStatus,linkedRequestId,attachmentId,filename,uploadedAt,matched,proposedType,note");
    expect(csv.trim().split("\n")).toHaveLength(5);
    expect(parseCsv(csv).map((x) => x.attachmentId)).toEqual(r.rows.map((x) => x.attachmentId));
  });

  it("parses quoted cells, doubled quotes, commas and CRLF", () => {
    expect(parseCsv('﻿a,b,c\r\n"x, y","he said ""hi""",3\r\n\r\nz,,\n')).toEqual([
      { a: "x, y", b: 'he said "hi"', c: "3" },
      { a: "z", b: "", c: "" },
    ]);
  });
});

describe("suggest-attachment-types — apply a reviewed CSV", () => {
  /** The report's CSV, minus the rows a reviewer deleted. */
  async function reviewedCsv(drop: (r: Record<string, string>) => boolean, extra: string[] = []) {
    const { rows } = await suggestAttachmentTypes({ expectDb: DB, log: quiet });
    const lines = toCsv(rows).trim().split("\n");
    return [lines[0], ...lines.slice(1).filter((_l, i) => !drop(rows[i] as any)), ...extra].join("\n") + "\n";
  }

  it("refuses without --expect-db, or a CSV without the needed columns", async () => {
    await expect(applySuggestionsCsv({ csvText: "x\n", apply: false, log: quiet })).rejects.toThrow(/REFUSING/);
    await expect(applySuggestionsCsv({ expectDb: DB, csvText: "bookingId,filename\n1,a.pdf\n", apply: false, log: quiet })).rejects.toThrow(/no attachmentId, proposedType/);
  });

  it("dry run (default) reports what it would do and writes nothing", async () => {
    const csv = await reviewedCsv(() => false);
    const before = await snapshot();
    const r = await applySuggestionsCsv({ expectDb: DB, csvText: csv, apply: false, log: quiet });
    expect(await snapshot()).toBe(before);
    expect([r.rows, r.applied, r.skipped]).toEqual([4, 4, 0]);
    expect(r.lines.every((l) => l.result === "would apply")).toBe(true);
    expect(r.synced).toEqual([]);
  });

  it("--apply changes ONLY the rows left in the CSV, records the script, re-syncs booked requests, sends no email", async () => {
    // The reviewer deleted the "ticket.pdf" row of the two-file booking.
    const csv = await reviewedCsv((row) => row.attachmentId === String(A.multiTicket), [
      // and added a row for a booking whose request is still in progress
      `MB-x,${B.notCompleted},FLIGHT,CONFIRMED,${R.open},${A.openOther},t.pdf,,ticket,ticket,`,
      // rows that must be skipped
      `MB-y,${B.flight},FLIGHT,CONFIRMED,,${A.flightInternal},supplier invoice.pdf,,,ticket,`,
      `MB-z,${B.hotel},HOTEL,INVOICED,,${A.hotelOther},Hotel confirmation.pdf,,,,also reads like an invoice`,
      `MB-w,not-an-id,FLIGHT,,,${A.flightOther},x.pdf,,,ticket,`,
    ]);
    const openBefore: any = await col("approvalrequests").findOne({ _id: R.open });
    const r = await applySuggestionsCsv({ expectDb: DB, csvText: csv, apply: true, log: quiet });

    expect(r.lines.map((l) => [l.attachmentId, l.result])).toEqual([
      [String(A.flightOther), "applied"],
      [String(A.hotelOther), "applied"],
      [String(A.dummyOther), "applied"],
      [String(A.openOther), "applied"],
      [String(A.flightInternal), 'skip: file is "internal" now, not "other"'],
      [String(A.hotelOther), 'skip: proposedType "" is not ticket / voucher'],
      [String(A.flightOther), "skip: bad bookingId / attachmentId"],
    ]);
    expect([r.applied, r.skipped]).toEqual([4, 3]);

    const types = async (id: any) => ((await col("manualbookings").findOne({ _id: id })) as any).attachments.map((a: any) => a.type);
    expect(await types(B.flight)).toEqual(["ticket", "internal"]);
    expect(await types(B.hotel)).toEqual(["voucher"]);
    expect(await types(B.dummy)).toEqual(["ticket"]);
    expect(await types(B.multi), "the deleted row is untouched").toEqual(["other", "other"]);
    expect(await types(B.notCompleted)).toEqual(["ticket"]);
    expect(((await col("manualbookings").findOne({ _id: B.flight })) as any).attachments[0].typeChanges).toEqual([
      { from: "other", to: "ticket", byName: "System (suggest-attachment-types)", at: expect.any(Date) },
    ]);

    // Booked requests: documents refreshed. The in-progress one: left alone (no booking_started, no email).
    expect(r.synced).toEqual([
      { requestId: String(R.booked), result: "documents_updated" },
      { requestId: String(R.bookedHotel), result: "documents_updated" },
      { requestId: String(R.bookedDummy), result: "documents_updated" },
      { requestId: String(R.open), result: "not synced: request not booked" },
    ]);
    expect(((await col("approvalrequests").findOne({ _id: R.booked })) as any).meta.bookingDocuments.map((d: any) => [d.type, d.filename])).toEqual([["ticket", "E-Ticket MR ADITYA.pdf"]]);
    expect(await col("approvalrequests").findOne({ _id: R.open })).toEqual(openBefore);
    expect(mails).toHaveLength(0);
    expect(await col("emailoutboxes").countDocuments()).toBe(0);

    // Re-applying the same CSV changes nothing more.
    const again = await applySuggestionsCsv({ expectDb: DB, csvText: csv, apply: true, log: quiet });
    expect(again.applied).toBe(0);
  });
});
