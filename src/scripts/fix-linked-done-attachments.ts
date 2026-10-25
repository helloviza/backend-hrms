// apps/backend/src/scripts/fix-linked-done-attachments.ts
//
// One-time repair for Book Now bookings whose ticket / voucher was uploaded as
// "other" (the admin form tagged every upload "other" from 2026-07-10 until
// the type picker), so the request they completed has no documents and the
// partner / student tracker says "Not issued yet" (case PL-T46PH8).
//
// Selects ManualBookings that are
//   - linked to an ApprovalRequest (source ADMIN_QUEUE, sourceBookingId) that
//     is completed (stage COMPLETED or adminState done) and not closed;
//   - live (isActive not false) and Done (CONFIRMED / INVOICED);
//   - a FLIGHT* / HOTEL* booking, or DUMMY_FLIGHT / DUMMY_HOTEL;
//   - carrying at least one "other" file and no ticket / voucher.
// Each such booking's "other" files become ticket (FLIGHT*, DUMMY_FLIGHT) or voucher
// (HOTEL*, DUMMY_HOTEL), recorded on the file (typeChanges, byName = this script), then the
// request's document list is re-synced through the live path
// (syncRequestFromManualBooking): the request is already booked, so it only
// refreshes the list — no trail row, no email.
//
// A booking with more than one "other" file is reported and SKIPPED unless
// --allow-multi: one of them may be an internal file (a supplier invoice)
// that must not reach the customer. "internal" files are never touched.
//
// Idempotent: a fixed booking has a ticket / voucher, so it is not selected
// again. DRY RUN by default (prints each booking, writes nothing).
//
//   npx tsx src/scripts/fix-linked-done-attachments.ts --expect-db=<db> [--apply] [--allow-multi]
import "dotenv/config";
import mongoose from "mongoose";
import { DOCUMENT_BOOKING_TYPE, documentTypeForBookingType } from "../models/ManualBooking.js";

const SCRIPT = "fix-linked-done-attachments";
const DONE = ["CONFIRMED", "INVOICED"];
const str = (v: unknown) => String(v ?? "").trim();

export type BookingLine = {
  bookingId: string;
  bookingRef: string;
  type: string;
  status: string;
  requestId: string;
  caseNumber: string;
  files: Array<{ attachmentId: string; filename: string; from: string; to: string }>;
  action: "fix" | "skip_multi";
  sync?: string;
};

export type Report = { db: string; apply: boolean; bookings: BookingLine[]; fixed: number; skipped: number };

export async function fixLinkedDoneAttachments(opts: {
  expectDb?: string;
  apply: boolean;
  allowMulti?: boolean;
  log?: (line: string) => void;
}): Promise<Report> {
  const { apply, expectDb } = opts;
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);
  log(`db ${db} · ${apply ? "APPLY" : "DRY RUN"}${opts.allowMulti ? " · --allow-multi" : ""}`);

  const bookings = mongoose.connection.collection("manualbookings");
  const requests = mongoose.connection.collection("approvalrequests");

  const candidates = await bookings
    .find({
      source: "ADMIN_QUEUE",
      isActive: { $ne: false },
      status: { $in: DONE },
      type: { $regex: DOCUMENT_BOOKING_TYPE },
      "attachments.type": "other",
      attachments: { $not: { $elemMatch: { type: { $in: ["ticket", "voucher"] } } } },
    })
    .sort({ _id: 1 })
    .toArray();

  const ids = candidates.map((b) => b.sourceBookingId).filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(String(id)));
  const completed = new Map(
    (
      await requests
        .find(
          {
            _id: { $in: ids },
            $or: [{ stage: "COMPLETED" }, { adminState: "done" }],
            adminState: { $ne: "cancelled" },
            stage: { $ne: "BOOKING_CANCELLED" },
            "meta.revoked": { $ne: true },
          },
          { projection: { _id: 1, ticketId: 1, "meta.partnerLead.caseNumber": 1 } },
        )
        .toArray()
    ).map((r) => [String(r._id), r]),
  );

  const report: Report = { db, apply, bookings: [], fixed: 0, skipped: 0 };
  for (const b of candidates) {
    const req = completed.get(str(b.sourceBookingId));
    if (!req) continue;
    const to = documentTypeForBookingType(b.type)!;
    const others = (b.attachments || []).filter((a: any) => a?.type === "other");
    const line: BookingLine = {
      bookingId: String(b._id),
      bookingRef: str(b.bookingRef),
      type: str(b.type),
      status: str(b.status),
      requestId: String(req._id),
      caseNumber: str(req.meta?.partnerLead?.caseNumber || req.ticketId),
      files: others.map((a: any) => ({ attachmentId: String(a._id), filename: str(a.originalFilename), from: "other", to })),
      action: others.length > 1 && !opts.allowMulti ? "skip_multi" : "fix",
    };
    report.bookings.push(line);
    if (line.action === "skip_multi") report.skipped++;
  }

  for (const l of report.bookings) {
    log(`${l.action === "fix" ? "FIX " : "SKIP"} ${l.bookingRef} (${l.bookingId}) ${l.type} ${l.status} · request ${l.caseNumber} (${l.requestId})`);
    for (const f of l.files) log(`       ${f.attachmentId} "${f.filename}": ${f.from} → ${f.to}`);
    if (l.action === "skip_multi") log("       more than one 'other' file — review by hand, or re-run with --allow-multi");
  }
  log(`${report.bookings.length} booking(s) selected · ${report.bookings.length - report.skipped} to fix · ${report.skipped} skipped`);
  if (!apply) return report;

  // The live sync, loaded only when writing (it pulls in the request services).
  const { syncRequestFromManualBooking } = await import("../services/bookingDocuments.js");
  const actor = { name: `System (${SCRIPT})` };
  for (const l of report.bookings.filter((x) => x.action === "fix")) {
    const at = new Date();
    for (const f of l.files) {
      await bookings.updateOne(
        { _id: new mongoose.Types.ObjectId(l.bookingId), attachments: { $elemMatch: { _id: new mongoose.Types.ObjectId(f.attachmentId), type: "other" } } },
        {
          $set: { "attachments.$.type": f.to },
          $push: { "attachments.$.typeChanges": { from: "other", to: f.to, byName: `System (${SCRIPT})`, at } },
        } as any,
      );
    }
    const fresh = await bookings.findOne({ _id: new mongoose.Types.ObjectId(l.bookingId) });
    l.sync = await syncRequestFromManualBooking(fresh as any, actor, { notify: false });
    report.fixed++;
    log(`  ${l.bookingRef}: retyped ${l.files.length} file(s) · request sync: ${l.sync}`);
    // The sync never throws; "none" means it did not update the request (see its log line).
    if (l.sync !== "documents_updated") log(`  WARNING ${l.bookingRef}: the request's documents were not refreshed — check the [bookingDocuments] log above`);
  }
  const unsynced = report.bookings.filter((x) => x.sync && x.sync !== "documents_updated").length;
  log(`Written: ${report.fixed} booking(s) fixed${unsynced ? ` · ${unsynced} request(s) NOT re-synced` : ""}.`);
  return report;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
    await fixLinkedDoneAttachments({ expectDb, apply: process.argv.includes("--apply"), allowMulti: process.argv.includes("--allow-multi") });
  } finally {
    await mongoose.disconnect();
  }
}

// Run only when executed directly — importing it (the test) must not connect.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith(`scripts/${SCRIPT}.ts`);

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
