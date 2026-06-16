/**
 * Backfill: combined-invoice date labels → booking-CREATION span.
 *
 * Historical COMBINED invoices were generated before the date-logic fix and
 * carry a TRAVEL-date span on their line-item `subDescription`/`travelDate`.
 * This script rewrites those date labels to the new SET-WIDE creation span,
 * byte-identical to what the shipped `combinedCreationDateRange` /
 * `oldestCreationDate` now produce for new invoices. NOTHING financial changes
 * (amounts, descriptions, GST, totals, invoice date are all untouched).
 *
 * USAGE
 *   tsx scripts/backfill-combined-invoice-dates.ts          # DRY (default): prints diff, writes backup, NO writes
 *   tsx scripts/backfill-combined-invoice-dates.ts --apply  # APPLY: DB + editHistory + S3 PDF regen
 *
 * Reuses the shipped helpers (date logic) and the existing PDF/S3 path — no
 * re-implementation of date math, no hand-rolled PDF rendering.
 */

import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { connectDb } from "../src/config/db.js";
import { env } from "../src/config/env.js";
import Invoice from "../src/models/Invoice.js";
import ManualBooking from "../src/models/ManualBooking.js";
import {
  combinedCreationDateRange,
  oldestCreationDate,
} from "../src/utils/invoiceLineItems.js";
import { generateInvoicePdf, prefetchInvoiceAssets } from "../src/utils/invoicePdf.js";
import { enrichClientDetails } from "../src/routes/invoices.js";

const APPLY = process.argv.includes("--apply");

/* ── Authoritative target set (from the prior dry-run) ───────────────── */
const EXPECTED = ["INV-20260077", "INV-20260164", "INV-20260205"].sort();

/* ── Combined detection (scope guard) — NEVER the no-pipe heuristic ──────
 * A line item is combined iff its COST description is a combined-only label,
 * or any line's bookingRef is a comma-joined list (only buildCombinedLineItems
 * joins refs). Demo invoices are excluded via isDemo:false. */
const COMBINED_ONLY = new Set([
  "Flight Booking",
  "Hotel Booking",
  "Train Booking",
  "VISA",
  "Dummy Hotel",
  "Dummy Flight",
  "Dummy Hotel & Flight",
]);

function isCombinedInvoice(inv: any): boolean {
  const lis: any[] = Array.isArray(inv.lineItems) ? inv.lineItems : [];
  if (lis.length === 0) return false;
  const anyCombinedLabel = lis.some(
    (l) => l && l.rowType === "COST" && COMBINED_ONLY.has(String(l.description || "").trim()),
  );
  const anyMultiRef = lis.some((l) => l && String(l.bookingRef || "").includes(","));
  return anyCombinedLabel || anyMultiRef;
}

/* ── Date-bearing line detection ─────────────────────────────────────────
 * In a combined invoice EVERY line's subDescription is a date span (or "").
 * We rewrite a line only when its subDescription looks like a date span and
 * is NOT a separate-style descriptor. A separate-style descriptor (route /
 * pipe-joined body) is left untouched and logged for manual review. */
function isDateSpanSubDescription(s: string): boolean {
  const v = String(s || "").trim();
  if (v === "") return true; // empty span — still a (degenerate) date slot
  if (v.includes("||")) return false; // separate-format body
  if (v.includes("→") || v.includes("->")) return false; // route string
  // starts with a day-of-month + month abbrev, e.g. "01 May", "30 Sept 2026"
  return /^\d{1,2}\s+[A-Za-z]{3,5}\b/.test(v);
}

function sameDate(a: any, b: any): boolean {
  const ta = a ? new Date(a).getTime() : NaN;
  const tb = b ? new Date(b).getTime() : NaN;
  if (isNaN(ta) && isNaN(tb)) return true;
  return ta === tb;
}

interface LineChange {
  index: number;
  rowType: string;
  description: string;
  oldSub: string;
  newSub: string;
  oldTravelDate: any;
  newTravelDate: any;
}

interface PlannedInvoice {
  _id: any;
  invoiceNo: string;
  status: string;
  bookingCount: number;
  newSpan: string;
  newOldest: Date | undefined;
  originalLineItems: any[];
  updatedLineItems: any[];
  changes: LineChange[];
  skippedNonDate: { index: number; description: string; sub: string }[];
  pdfUrl?: string;
}

async function main() {
  await connectDb();
  console.log(`\n=== backfill-combined-invoice-dates  [${APPLY ? "APPLY" : "DRY-RUN"}] ===\n`);

  /* 1. Re-derive the target set from the live DB (fail-closed). */
  const all = await Invoice.find({}).lean();
  const derived = all
    .filter((inv: any) => inv.isDemo !== true && isCombinedInvoice(inv))
    .map((inv: any) => inv.invoiceNo)
    .sort();

  console.log(`Total invoices scanned: ${all.length}`);
  console.log(`Derived COMBINED (isDemo:false): ${derived.join(", ") || "(none)"}`);

  const extra = derived.filter((n) => !EXPECTED.includes(n));
  const missing = EXPECTED.filter((n) => !derived.includes(n));
  if (extra.length || missing.length || derived.length !== EXPECTED.length) {
    console.error("\n!! SCOPE GUARD TRIPPED — derived set != authoritative set. ABORTING, nothing touched.");
    if (extra.length) console.error("   Unexpected extra invoices:", extra.join(", "));
    if (missing.length) console.error("   Expected but missing:", missing.join(", "));
    await mongoose.disconnect();
    process.exit(2);
  }
  console.log("Scope guard OK — derived set == { " + EXPECTED.join(", ") + " }\n");

  /* 2. Build the plan per invoice (runtime re-verify linkage + createdAt). */
  const targets = all.filter((inv: any) => EXPECTED.includes(inv.invoiceNo));
  const plans: PlannedInvoice[] = [];

  for (const inv of targets as any[]) {
    const ids = (inv.bookingIds || []).map((x: any) => x);
    const bookings = await ManualBooking.find({ _id: { $in: ids } }).lean();

    // Linkage re-verification.
    if (!ids.length || bookings.length !== ids.length) {
      console.error(
        `!! ${inv.invoiceNo}: linkage mismatch (bookingIds=${ids.length}, resolved=${bookings.length}). ABORTING.`,
      );
      await mongoose.disconnect();
      process.exit(3);
    }
    const missingCreated = bookings.filter((b: any) => !b.createdAt).length;
    if (missingCreated > 0) {
      console.error(`!! ${inv.invoiceNo}: ${missingCreated} booking(s) missing createdAt. ABORTING.`);
      await mongoose.disconnect();
      process.exit(4);
    }

    const newSpan = combinedCreationDateRange(bookings as any[]);
    const newOldest = oldestCreationDate(bookings as any[]);

    const original: any[] = Array.isArray(inv.lineItems) ? inv.lineItems : [];
    const updated: any[] = original.map((l) => ({ ...l }));
    const changes: LineChange[] = [];
    const skippedNonDate: { index: number; description: string; sub: string }[] = [];

    original.forEach((li, idx) => {
      const sub = String(li.subDescription ?? "");
      if (!isDateSpanSubDescription(sub)) {
        // Separate-style / fallback line indistinguishable from a non-combined
        // descriptor — never modify; surface for manual review.
        skippedNonDate.push({ index: idx, description: String(li.description || ""), sub });
        return;
      }
      const subUnchanged = sub === newSpan;
      const travelUnchanged = sameDate(li.travelDate, newOldest);
      if (subUnchanged && travelUnchanged) return; // idempotent no-op

      updated[idx].subDescription = newSpan;
      updated[idx].travelDate = newOldest;
      changes.push({
        index: idx,
        rowType: String(li.rowType || ""),
        description: String(li.description || ""),
        oldSub: sub,
        newSub: newSpan,
        oldTravelDate: li.travelDate ?? null,
        newTravelDate: newOldest ?? null,
      });
    });

    plans.push({
      _id: inv._id,
      invoiceNo: inv.invoiceNo,
      status: inv.status,
      bookingCount: ids.length,
      newSpan,
      newOldest,
      originalLineItems: original,
      updatedLineItems: updated,
      changes,
      skippedNonDate,
      pdfUrl: inv.pdfUrl,
    });
  }

  /* 3. Write rollback backup (read-only capture; allowed even in dry mode). */
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.resolve(process.cwd(), `backfill-backup-${ts}.json`);
  const backup = plans.map((p) => ({
    _id: String(p._id),
    invoiceNo: p.invoiceNo,
    status: p.status,
    pdfUrl: p.pdfUrl ?? null,
    lineItems: p.originalLineItems,
  }));
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf8");
  console.log(`Rollback backup written: ${backupPath}\n`);

  /* 4. Print the full diff. */
  for (const p of plans) {
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${p.invoiceNo}  [${p.status}]  bookings=${p.bookingCount}`);
    console.log(`   set-wide NEW span : "${p.newSpan}"`);
    console.log(`   set-wide oldest   : ${p.newOldest ? new Date(p.newOldest).toISOString() : "(none)"}`);
    console.log(`   lines: ${p.originalLineItems.length} total | ${p.changes.length} to change | ` +
      `${p.originalLineItems.length - p.changes.length - p.skippedNonDate.length} no-op | ${p.skippedNonDate.length} skipped(non-date)`);

    for (const c of p.changes) {
      console.log(`   #${c.index} [${c.rowType}] ${c.description}`);
      console.log(`       subDescription: "${c.oldSub}"  ->  "${c.newSub}"`);
      const ot = c.oldTravelDate ? new Date(c.oldTravelDate).toISOString() : "null";
      const nt = c.newTravelDate ? new Date(c.newTravelDate).toISOString() : "null";
      console.log(`       travelDate    : ${ot}  ->  ${nt}`);
    }
    for (const s of p.skippedNonDate) {
      console.log(`   #${s.index} SKIPPED (non-date subDescription) [${s.description}] "${s.sub}"  → manual review`);
    }

    // Uniformity check: every date-bearing line ends on the same span.
    const dateBearing = p.updatedLineItems.filter((l) => isDateSpanSubDescription(String(l.subDescription ?? "")));
    const uniform = dateBearing.every((l) => String(l.subDescription ?? "") === p.newSpan);
    console.log(`   set-wide span uniform across all date lines: ${uniform ? "YES" : "NO !!"}`);
    if (!uniform) {
      const distinct = [...new Set(dateBearing.map((l) => String(l.subDescription ?? "")))];
      console.log(`     distinct spans found: ${JSON.stringify(distinct)}`);
    }
  }

  const totalChanges = plans.reduce((s, p) => s + p.changes.length, 0);
  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(`SUMMARY: ${plans.length} invoices | ${totalChanges} line changes planned`);

  if (!APPLY) {
    console.log("\nDRY-RUN: no DB writes, no PDF regeneration, no pdfUrl changes.");
    console.log("Review the diff above. Re-run with --apply to commit.\n");
    await mongoose.disconnect();
    process.exit(0);
  }

  /* 5. APPLY — sequential; stop on first failure so state is known. */
  console.log("\n!! APPLY MODE — mutating production invoice data sequentially.\n");
  const s3 = new S3Client({
    region: env.AWS_REGION,
    credentials:
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
        : undefined,
  });
  const bucket = env.S3_BUCKET;
  const prefetch = await prefetchInvoiceAssets();
  const succeeded: string[] = [];

  try {
    for (const p of plans) {
      if (p.changes.length === 0) {
        console.log(`${p.invoiceNo}: nothing to change (idempotent) — skipped.`);
        succeeded.push(p.invoiceNo);
        continue;
      }

      // a + b. DB lineItems update + editHistory entry (raw collection write,
      // same pattern as the generation route, bypasses schema validation).
      const oldValues = { lineItems: p.changes.map((c) => ({ index: c.index, subDescription: c.oldSub, travelDate: c.oldTravelDate })) };
      const newValues = { lineItems: p.changes.map((c) => ({ index: c.index, subDescription: c.newSub, travelDate: c.newTravelDate })) };
      await Invoice.collection.updateOne(
        { _id: p._id },
        {
          $set: { lineItems: p.updatedLineItems, editedAt: new Date() },
          $push: {
            editHistory: {
              editedAt: new Date(),
              editedBy: "system:backfill",
              fieldsChanged: ["lineItems"],
              oldValues,
              newValues,
              reason: "Combined-invoice date label corrected to booking-creation span (backfill)",
            },
          },
        },
      );
      console.log(`${p.invoiceNo}: DB updated (${p.changes.length} lines) + editHistory appended.`);

      // c. PDF regen via the existing util, then overwrite S3 + pdfUrl.
      const fresh = await Invoice.collection.findOne({ _id: p._id });
      const enrichedClient = await enrichClientDetails(fresh);
      const pdfBuffer = await generateInvoicePdf({ ...fresh, clientDetails: enrichedClient } as any, prefetch);
      const key = `invoices/${p.invoiceNo}.pdf`;
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: pdfBuffer, ContentType: "application/pdf" }));
      const pdfUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: `inline; filename="${p.invoiceNo}.pdf"` }),
        { expiresIn: 3600 },
      );
      await Invoice.collection.updateOne({ _id: p._id }, { $set: { pdfUrl } });
      console.log(`${p.invoiceNo}: PDF regenerated + S3 overwritten (${key}).`);

      succeeded.push(p.invoiceNo);
    }
    console.log(`\nDONE. Updated: ${succeeded.join(", ")}`);
  } catch (err: any) {
    console.error(`\n!! FAILURE during apply: ${err?.message}`);
    console.error(`   Succeeded (state changed): ${succeeded.join(", ") || "(none)"}`);
    const remaining = plans.map((p) => p.invoiceNo).filter((n) => !succeeded.includes(n));
    console.error(`   NOT processed: ${remaining.join(", ") || "(none)"}`);
    console.error(`   Restore from backup: ${backupPath}`);
    await mongoose.disconnect();
    process.exit(5);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("FATAL:", err?.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
