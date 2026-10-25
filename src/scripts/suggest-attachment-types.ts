// apps/backend/src/scripts/suggest-attachment-types.ts
//
// Every upload from 2026-07-10 until the type picker was tagged "other". Two
// modes, both behind --expect-db:
//
// 1. REPORT (default) — writes nothing to the database. Lists the "other"
//    files on FLIGHT* / HOTEL* / DUMMY_FLIGHT / DUMMY_HOTEL bookings whose
//    file name looks like a customer document (ticket / e-ticket / voucher /
//    confirmation), as a CSV for a person to review. The proposed type is the
//    BOOKING's, not the file name's: flight bookings → ticket, hotel bookings
//    → voucher. A name that also reads like an invoice / bill / receipt /
//    credit note gets no proposal (internal more often than not).
//
//      npx tsx src/scripts/suggest-attachment-types.ts --expect-db=<db> [--out=<file.csv>]
//
// 2. APPLY FROM A REVIEWED CSV — only the rows left in the file are applied
//    (delete the rows you don't want). Dry run unless --apply. A row is
//    applied only if its file still exists, is still "other", and its
//    proposedType is ticket or voucher; anything else is reported and
//    skipped. Each change is recorded on the file (typeChanges, byName = this
//    script). A booked request linked to the booking gets its document list
//    refreshed through the live sync — that path sends no email. A linked
//    request that is NOT booked is left alone (reported "not synced"): the
//    sync would complete / start it, and those send emails. Its documents
//    follow on the booking's next save.
//
//      npx tsx src/scripts/suggest-attachment-types.ts --expect-db=<db> --from-csv=<file.csv> [--apply]
import "dotenv/config";
import fs from "fs";
import mongoose from "mongoose";
import { DOCUMENT_BOOKING_TYPE, documentTypeForBookingType } from "../models/ManualBooking.js";

const SCRIPT = "suggest-attachment-types";
const ACTOR_NAME = `System (${SCRIPT})`;
const str = (v: unknown) => String(v ?? "").trim();

const VOUCHER = /voucher/i;
const TICKET = /ticket/i; // ticket, e-ticket, eticket, E_Ticket …
const CONFIRMATION = /confirm/i;
const INVOICE_LIKE = /invoice|\bbill\b|receipt|credit[\s._-]?note|\bgst\b|tax/i;

export const CSV_COLUMNS = [
  "bookingRef", "bookingId", "bookingType", "bookingStatus", "linkedRequestId",
  "attachmentId", "filename", "uploadedAt", "matched", "proposedType", "note",
] as const;

export type Suggestion = Record<(typeof CSV_COLUMNS)[number], string>;

function refuseUnlessDb(expectDb: string | undefined) {
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);
  return db;
}

/** The proposal for one file name on a booking of `bookingType`, or null when the name says nothing. */
export function suggestFor(filename: string, bookingType: string): { matched: string; proposedType: string; note: string } | null {
  const matched = VOUCHER.test(filename) ? "voucher" : TICKET.test(filename) ? "ticket" : CONFIRMATION.test(filename) ? "confirmation" : "";
  if (!matched) return null;
  if (INVOICE_LIKE.test(filename)) return { matched, proposedType: "", note: "also reads like an invoice / receipt — review" };
  // The booking type wins over the file name (a generated "flight_voucher_…" is a flight ticket).
  return { matched, proposedType: documentTypeForBookingType(bookingType) ?? "", note: "" };
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsv = (rows: Suggestion[]) =>
  [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";

/** RFC 4180 CSV → rows keyed by the header line (quoted cells, "" escapes, CRLF or LF). */
export function parseCsv(text: string): Array<Record<string, string>> {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c !== "")) records.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) records.push(row);
  const [header = [], ...body] = records;
  const keys = header.map((h) => h.replace(/^﻿/, "").trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, str(r[i])])));
}

/* ─────────────────────────── 1. report ─────────────────────────── */

export async function suggestAttachmentTypes(opts: { expectDb?: string; log?: (line: string) => void }): Promise<{ db: string; scanned: number; rows: Suggestion[] }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = refuseUnlessDb(opts.expectDb);
  log(`db ${db} · REPORT ONLY (no writes)`);

  const cursor = mongoose.connection
    .collection("manualbookings")
    .find(
      { type: { $regex: DOCUMENT_BOOKING_TYPE }, "attachments.type": "other" },
      { projection: { bookingRef: 1, type: 1, status: 1, source: 1, sourceBookingId: 1, attachments: 1 } },
    )
    .sort({ _id: 1 });

  const rows: Suggestion[] = [];
  let scanned = 0;
  for await (const b of cursor) {
    for (const a of (b.attachments || []).filter((x: any) => x?.type === "other")) {
      scanned++;
      const s = suggestFor(str(a.originalFilename), str(b.type));
      if (!s) continue;
      rows.push({
        bookingRef: str(b.bookingRef),
        bookingId: String(b._id),
        bookingType: str(b.type),
        bookingStatus: str(b.status),
        linkedRequestId: str(b.source).toUpperCase() === "ADMIN_QUEUE" ? str(b.sourceBookingId) : "",
        attachmentId: String(a._id),
        filename: str(a.originalFilename),
        uploadedAt: a.uploadedAt ? new Date(a.uploadedAt).toISOString() : "",
        ...s,
      });
    }
  }
  const by = (k: keyof Suggestion) => rows.reduce<Record<string, number>>((m, r) => ((m[r[k] || "(none)"] = (m[r[k] || "(none)"] || 0) + 1), m), {});
  log(`"other" files on flight / hotel bookings: ${scanned} · matching a document name: ${rows.length}`);
  log(`  by match: ${JSON.stringify(by("matched"))}`);
  log(`  by proposed type: ${JSON.stringify(by("proposedType"))}`);
  log(`  with a note: ${rows.filter((r) => r.note).length}`);
  return { db, scanned, rows };
}

/* ─────────────────────────── 2. apply a reviewed CSV ─────────────────────────── */

export type ApplyLine = { line: number; bookingRef: string; bookingId: string; attachmentId: string; filename: string; to: string; result: string };
export type ApplyReport = {
  db: string;
  apply: boolean;
  rows: number;
  lines: ApplyLine[];
  applied: number;
  skipped: number;
  synced: Array<{ requestId: string; result: string }>;
};

export async function applySuggestionsCsv(opts: {
  expectDb?: string;
  csvText: string;
  apply: boolean;
  log?: (line: string) => void;
}): Promise<ApplyReport> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = refuseUnlessDb(opts.expectDb);
  log(`db ${db} · ${opts.apply ? "APPLY" : "DRY RUN"} from CSV`);

  const rows = parseCsv(opts.csvText);
  const missing = ["bookingId", "attachmentId", "proposedType"].filter((k) => rows.length && !(k in rows[0]));
  if (missing.length) throw new Error(`REFUSING: the CSV has no ${missing.join(", ")} column(s).`);

  const bookings = mongoose.connection.collection("manualbookings");
  const report: ApplyReport = { db, apply: opts.apply, rows: rows.length, lines: [], applied: 0, skipped: 0, synced: [] };
  const seen = new Set<string>();
  const touched = new Map<string, any>(); // bookingId → booking (for the request sync)

  for (const [i, r] of rows.entries()) {
    const line: ApplyLine = { line: i + 2, bookingRef: r.bookingRef || "", bookingId: r.bookingId, attachmentId: r.attachmentId, filename: r.filename || "", to: r.proposedType, result: "" };
    report.lines.push(line);
    const skip = (why: string) => { line.result = `skip: ${why}`; report.skipped++; };

    if (!mongoose.isValidObjectId(r.bookingId) || !mongoose.isValidObjectId(r.attachmentId)) { skip("bad bookingId / attachmentId"); continue; }
    if (r.proposedType !== "ticket" && r.proposedType !== "voucher") { skip(`proposedType "${r.proposedType}" is not ticket / voucher`); continue; }
    if (seen.has(r.attachmentId)) { skip("duplicate row"); continue; }
    seen.add(r.attachmentId);

    const b: any = await bookings.findOne({ _id: new mongoose.Types.ObjectId(r.bookingId) });
    const a = (b?.attachments || []).find((x: any) => String(x._id) === r.attachmentId);
    if (!b || !a) { skip("file not found on that booking"); continue; }
    if (a.type !== "other") { skip(`file is "${a.type}" now, not "other"`); continue; }

    if (opts.apply) {
      const w = await bookings.updateOne(
        { _id: b._id, attachments: { $elemMatch: { _id: a._id, type: "other" } } },
        {
          $set: { "attachments.$.type": r.proposedType },
          $push: { "attachments.$.typeChanges": { from: "other", to: r.proposedType, byName: ACTOR_NAME, at: new Date() } },
        } as any,
      );
      if (!w.modifiedCount) { skip("changed meanwhile"); continue; }
      touched.set(String(b._id), b);
    }
    line.result = opts.apply ? "applied" : "would apply";
    report.applied++;
  }

  for (const l of report.lines) log(`  line ${l.line} ${l.bookingRef} ${l.attachmentId} "${l.filename}" → ${l.to}: ${l.result}`);
  log(`${report.rows} row(s) · ${report.applied} ${opts.apply ? "applied" : "would apply"} · ${report.skipped} skipped`);
  if (!opts.apply) return report;

  // Refresh the documents of BOOKED requests only (no email on that path).
  const { syncRequestFromManualBooking } = await import("../services/bookingDocuments.js");
  const requests = mongoose.connection.collection("approvalrequests");
  for (const [bookingId, b] of touched) {
    const rid = str(b.sourceBookingId);
    if (str(b.source).toUpperCase() !== "ADMIN_QUEUE" || !mongoose.isValidObjectId(rid)) continue;
    const req: any = await requests.findOne({ _id: new mongoose.Types.ObjectId(rid) }, { projection: { stage: 1, adminState: 1, "meta.revoked": 1 } });
    const booked = req && (str(req.stage).toUpperCase() === "COMPLETED" || str(req.adminState) === "done");
    const closed = req && (str(req.adminState) === "cancelled" || str(req.stage).toUpperCase() === "BOOKING_CANCELLED" || !!req.meta?.revoked);
    if (!booked || closed) {
      report.synced.push({ requestId: rid, result: "not synced: request not booked" });
      continue;
    }
    const fresh = await bookings.findOne({ _id: new mongoose.Types.ObjectId(bookingId) });
    report.synced.push({ requestId: rid, result: await syncRequestFromManualBooking(fresh as any, { name: ACTOR_NAME }) });
  }
  for (const s of report.synced) log(`  request ${s.requestId}: ${s.result}`);
  log(`Written: ${report.applied} file(s) retyped · ${report.synced.filter((s) => s.result === "documents_updated").length} request(s) re-synced.`);
  return report;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const apply = process.argv.includes("--apply");
  const fromCsv = arg("from-csv");
  if (apply && !fromCsv) throw new Error("REFUSING: --apply needs --from-csv=<reviewed file.csv>.");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    if (fromCsv) {
      await applySuggestionsCsv({ expectDb: arg("expect-db"), csvText: fs.readFileSync(fromCsv, "utf8"), apply });
      return;
    }
    const { db, rows } = await suggestAttachmentTypes({ expectDb: arg("expect-db") });
    const out = arg("out") || `attachment-type-suggestions-${db}-${new Date().toISOString().slice(0, 10)}.csv`;
    fs.writeFileSync(out, toCsv(rows));
    console.log(`CSV: ${out} (${rows.length} rows)`);
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
