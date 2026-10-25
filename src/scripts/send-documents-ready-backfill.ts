// apps/backend/src/scripts/send-documents-ready-backfill.ts
//
// One-time: the "documents ready" email for requests whose "booking done"
// email went out WITHOUT the customer's documents (they were uploaded as
// "other" before the attachment types, or after Done) but which hold them
// now (meta.bookingDocuments, after fix-linked-done-attachments).
//
// Selects requests that are
//   - booked (stage COMPLETED or adminState done), not cancelled / revoked;
//   - holding customer documents (ticket / voucher / document, an S3 file);
//   - never recorded as emailed (no meta.documentsEmailed);
//   - whose booking-done delivery row ("Notified: …") carried no files.
// Each gets ONE "documents ready" email with those documents, through the
// live path (approvalProgress.notifyDocumentsReady: same recipients as
// booking done — a partner lead case: the student only), and
// meta.documentsEmailed is set first, so a re-run (or the live sync) never
// sends them again.
//
// DRY RUN by default: prints each request, its files and its recipients.
//
//   npx tsx src/scripts/send-documents-ready-backfill.ts --expect-db=<db> [--apply]
import "dotenv/config";
import mongoose from "mongoose";

const SCRIPT = "send-documents-ready-backfill";
const CUSTOMER_TYPES = new Set(["ticket", "voucher", "document"]);
const str = (v: unknown) => String(v ?? "").trim();

export type BackfillLine = {
  requestId: string;
  caseCode: string;
  files: string[];
  to: string[];
  cc: string[];
  result?: string;
};
export type BackfillReport = { db: string; apply: boolean; lines: BackfillLine[]; skipped: Array<{ requestId: string; why: string }>; sent: number };

const emailable = (list: any[]) =>
  (Array.isArray(list) ? list : []).filter((d) => CUSTOMER_TYPES.has(str(d?.type).toLowerCase()) && str(d?.s3Key) && str(d?.attachmentId));

/** The booking-done delivery row: "Notified: to=… [cc=…] [attachments=N]". */
function bookingDoneDelivery(history: any[]): { found: boolean; files: number } {
  const rows = (Array.isArray(history) ? history : []).filter((h) => h?.action === "admin_notify_sent" && /^Notified:/.test(str(h?.comment)));
  const last = rows[rows.length - 1];
  if (!last) return { found: false, files: 0 };
  const m = str(last.comment).match(/attachments=(\d+)/);
  return { found: true, files: m ? Number(m[1]) : 0 };
}

export async function sendDocumentsReadyBackfill(opts: { expectDb?: string; apply: boolean; log?: (line: string) => void }): Promise<BackfillReport> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  log(`db ${db} · ${opts.apply ? "APPLY" : "DRY RUN"}`);

  // The live recipients / sender (loaded lazily: they pull in the email services).
  const { recipientsFor } = await import("../services/approvalEmails/dispatch.js");
  const { caseCode } = await import("../services/approvalEmails/links.js");
  const requests = mongoose.connection.collection("approvalrequests");

  const candidates = await requests
    .find({
      $or: [{ stage: "COMPLETED" }, { adminState: "done" }],
      adminState: { $ne: "cancelled" },
      stage: { $ne: "BOOKING_CANCELLED" },
      "meta.revoked": { $ne: true },
      "meta.documentsEmailed": { $exists: false },
      "meta.bookingDocuments.0": { $exists: true },
    })
    .sort({ _id: 1 })
    .toArray();

  const report: BackfillReport = { db, apply: opts.apply, lines: [], skipped: [], sent: 0 };
  for (const r of candidates as any[]) {
    const docs = emailable(r.meta?.bookingDocuments);
    if (!docs.length) continue;
    const delivery = bookingDoneDelivery(r.history);
    if (!delivery.found) {
      report.skipped.push({ requestId: String(r._id), why: "no booking-done delivery recorded — review by hand" });
      continue;
    }
    if (delivery.files > 0) {
      report.skipped.push({ requestId: String(r._id), why: `booking done already carried ${delivery.files} file(s)` });
      continue;
    }
    const who = await recipientsFor("documents_ready", { ar: r });
    report.lines.push({ requestId: String(r._id), caseCode: caseCode(r), files: docs.map((d) => str(d.filename)), to: who.to, cc: who.cc });
  }

  for (const l of report.lines) {
    log(`${l.caseCode} (${l.requestId}) · ${l.files.length} file(s): ${l.files.join(", ")}`);
    log(`    to: ${l.to.join(", ") || "(nobody)"}${l.cc.length ? ` · cc: ${l.cc.join(", ")}` : ""}`);
  }
  for (const s of report.skipped) log(`SKIP ${s.requestId}: ${s.why}`);
  log(`${report.lines.length} request(s) to email · ${report.skipped.length} skipped`);
  if (!opts.apply) return report;

  const { notifyDocumentsReady } = await import("../services/approvalProgress.js");
  for (const l of report.lines) {
    const r: any = await requests.findOne({ _id: new mongoose.Types.ObjectId(l.requestId) });
    const docs = emailable(r?.meta?.bookingDocuments);
    // Claim first: only the run that sets the record sends (no double send on a re-run or race).
    const claim = await requests.updateOne(
      { _id: r._id, "meta.documentsEmailed": { $exists: false } },
      { $set: { "meta.documentsEmailed": docs.map((d) => str(d.attachmentId)) } },
    );
    if (!claim.modifiedCount) {
      l.result = "skipped: already recorded";
      continue;
    }
    const files = docs.map((d) => ({ filename: str(d.filename) || "document.pdf", s3Key: str(d.s3Key), contentType: str(d.mime) || "application/pdf" }));
    const out = await notifyDocumentsReady(r, files, { name: `System (${SCRIPT})` });
    l.result = out.queued ? `sent to ${out.to.join(", ")}${out.cc.length ? ` cc ${out.cc.join(", ")}` : ""}` : `not sent: ${out.skipped}`;
    if (out.queued) report.sent++;
    log(`  ${l.caseCode}: ${l.result}`);
  }
  log(`Written: ${report.sent} email(s) sent.`);
  return report;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
    await sendDocumentsReadyBackfill({ expectDb, apply: process.argv.includes("--apply") });
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
