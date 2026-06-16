/**
 * Backfill: BUNDLEOJOY PRIVATE LIMITED GSTIN correction on frozen invoice snapshots.
 *
 * Forward generation is already correct (Customer.gstNumber holds NEW). This
 * script fixes ONLY the 5 invoices whose clientDetails.gstin froze the OLD value
 * at generation time. The ONLY field changed is clientDetails.gstin (OLD→NEW) —
 * nothing financial: amounts, tax fields, totals, state, status, dates and line
 * items are all untouched. Both GSTINs are 06 (Haryana), so CGST/SGST stays.
 *
 * USAGE
 *   tsx scripts/backfill-bundleojoy-gstin.ts          # DRY (default): diff + backup, NO writes
 *   tsx scripts/backfill-bundleojoy-gstin.ts --apply  # APPLY: DB + editHistory + S3 PDF regen
 */

import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { connectDb } from "../src/config/db.js";
import { env } from "../src/config/env.js";
import Invoice from "../src/models/Invoice.js";
import CustomerWorkspace from "../src/models/CustomerWorkspace.js";
import { generateInvoicePdf, prefetchInvoiceAssets } from "../src/utils/invoicePdf.js";
import { enrichClientDetails } from "../src/routes/invoices.js";

const APPLY = process.argv.includes("--apply");

const OLD = "06AAKCB4816A1Z3";
const NEW = "06AAKCB4816A2Z2";
const CUSTOMER_ID = "6985c7672fe533bae9ac9a84"; // BUNDLEOJOY PRIVATE LIMITED
const TARGETS = ["INV-20260072", "INV-20260075", "INV-20260118", "INV-20260171", "INV-20260179"];

// Resolve an invoice's workspaceId → owning Customer._id (CWS → customerId, or
// legacy direct Customer._id). Read-only; mirrors enrichClientDetails routing.
async function resolveCustomerId(workspaceId: any): Promise<string | null> {
  if (!workspaceId) return null;
  const cws = await CustomerWorkspace.findById(workspaceId).lean<any>();
  if (cws?.customerId) return String(cws.customerId);
  return String(workspaceId); // legacy: workspaceId stored as Customer._id
}

interface Plan {
  _id: any;
  invoiceNo: string;
  status: string;
  oldGstin: string;
  state: string;
  supplyType: string;
  customerId: string | null;
  originalClientDetails: any;
  pdfUrl?: string;
  noop: boolean;
}

async function main() {
  await connectDb();
  console.log(`\n=== backfill-bundleojoy-gstin  [${APPLY ? "APPLY" : "DRY-RUN"}] ===`);
  console.log(`OLD ${OLD}  ->  NEW ${NEW}\n`);

  const plans: Plan[] = [];

  for (const invoiceNo of TARGETS) {
    const inv = await Invoice.findOne({ invoiceNo }).lean<any>();

    // SCOPE GUARD — fail closed.
    if (!inv) {
      console.error(`!! ${invoiceNo}: NOT FOUND. ABORTING, nothing touched.`);
      await mongoose.disconnect();
      process.exit(2);
    }
    const custId = await resolveCustomerId(inv.workspaceId);
    if (custId !== CUSTOMER_ID) {
      console.error(`!! ${invoiceNo}: resolves to customer ${custId}, expected ${CUSTOMER_ID} (not BUNDLEOJOY). ABORTING.`);
      await mongoose.disconnect();
      process.exit(3);
    }
    const cur = String(inv.clientDetails?.gstin ?? "");
    const noop = cur === NEW;
    if (!noop && cur !== OLD) {
      console.error(`!! ${invoiceNo}: clientDetails.gstin is "${cur}" — neither OLD nor NEW. ABORTING.`);
      await mongoose.disconnect();
      process.exit(4);
    }

    plans.push({
      _id: inv._id,
      invoiceNo,
      status: inv.status,
      oldGstin: cur,
      state: String(inv.clientDetails?.state ?? inv.clientState ?? ""),
      supplyType: String(inv.supplyType ?? ""),
      customerId: custId,
      originalClientDetails: inv.clientDetails ?? {},
      pdfUrl: inv.pdfUrl,
      noop,
    });
  }

  // Rollback backup (read-only capture; written even in dry mode).
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.resolve(process.cwd(), `backfill-gstin-backup-${ts}.json`);
  fs.writeFileSync(
    backupPath,
    JSON.stringify(
      plans.map((p) => ({
        _id: String(p._id),
        invoiceNo: p.invoiceNo,
        status: p.status,
        pdfUrl: p.pdfUrl ?? null,
        clientDetails: p.originalClientDetails,
      })),
      null,
      2,
    ),
    "utf8",
  );
  console.log(`Scope guard OK — all 5 resolve to BUNDLEOJOY (${CUSTOMER_ID}).`);
  console.log(`Rollback backup written: ${backupPath}\n`);

  // Diff.
  console.log("invoiceNo      | status | gstin change                         | state   | supplyType");
  console.log("---------------|--------|--------------------------------------|---------|-----------");
  for (const p of plans) {
    const change = p.noop ? `${p.oldGstin} (already NEW — skip)` : `${p.oldGstin} -> ${NEW}`;
    console.log(`${p.invoiceNo} | ${p.status.padEnd(6)} | ${change.padEnd(36)} | ${p.state.padEnd(7)} | ${p.supplyType}`);
  }
  const toChange = plans.filter((p) => !p.noop);
  const stateOk = plans.every((p) => p.state.toLowerCase() === "haryana");
  const splitOk = plans.every((p) => p.supplyType === "CGST_SGST");
  console.log(`\n${toChange.length} to change | ${plans.length - toChange.length} no-op`);
  console.log(`All resolved state == Haryana: ${stateOk} | all supplyType == CGST_SGST (unchanged): ${splitOk}`);
  console.log(`(Only clientDetails.gstin changes — amounts, tax, totals, state, status, dates, line items untouched.)`);

  if (!APPLY) {
    console.log("\nDRY-RUN: no DB writes, no PDF regeneration, no pdfUrl changes.");
    console.log("Review above. Re-run with --apply to commit.\n");
    await mongoose.disconnect();
    process.exit(0);
  }

  // APPLY — sequential; stop on first failure.
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
      if (p.noop) {
        console.log(`${p.invoiceNo}: already NEW — skipped.`);
        succeeded.push(p.invoiceNo);
        continue;
      }

      await Invoice.collection.updateOne(
        { _id: p._id },
        {
          $set: { "clientDetails.gstin": NEW, editedAt: new Date() },
          $push: {
            editHistory: {
              editedAt: new Date(),
              editedBy: "system:backfill",
              fieldsChanged: ["clientDetails.gstin"],
              oldValues: { "clientDetails.gstin": p.oldGstin },
              newValues: { "clientDetails.gstin": NEW },
              reason: "BUNDLEOJOY GSTIN corrected old->new",
            },
          },
        },
      );
      console.log(`${p.invoiceNo}: DB updated (clientDetails.gstin -> NEW) + editHistory appended.`);

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
    console.error(`   Succeeded: ${succeeded.join(", ") || "(none)"}`);
    console.error(`   NOT processed: ${plans.map((p) => p.invoiceNo).filter((n) => !succeeded.includes(n)).join(", ") || "(none)"}`);
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
