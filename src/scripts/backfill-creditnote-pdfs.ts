/**
 * Backfill rendered PDFs for ISSUED credit notes that have no pdfUrl yet.
 * Generates the credit-note PDF, uploads it to S3, and stores a fresh presigned
 * inline URL on the document. Idempotent — safe to re-run; only ISSUED notes
 * missing a pdfUrl are processed (pass --force to re-render every ISSUED note).
 *
 * Company settings + logo are prefetched once and injected into every render to
 * avoid N network round-trips.
 *
 * Run: pnpm -C apps/backend tsx src/scripts/backfill-creditnote-pdfs.ts
 *      pnpm -C apps/backend tsx src/scripts/backfill-creditnote-pdfs.ts --force
 */

import { connectDb } from "../config/db.js";
import CreditNote from "../models/CreditNote.js";
import { generateCreditNotePdf, prefetchCreditNoteAssets } from "../utils/creditNotePdf.js";
import { uploadAndPresign } from "../utils/s3Upload.js";

async function main() {
  const force = process.argv.includes("--force");

  await connectDb();
  console.log("✅ Connected to MongoDB");

  const filter: Record<string, any> = { status: "ISSUED" };
  if (!force) filter.pdfUrl = { $in: [null, ""] };

  const notes = await CreditNote.find(filter).sort({ generatedAt: 1 }).lean();
  console.log(`Found ${notes.length} ISSUED credit note(s) to process${force ? " (forced re-render)" : ""}.\n`);

  if (notes.length === 0) {
    process.exit(0);
  }

  const prefetch = await prefetchCreditNoteAssets();

  let ok = 0;
  let failed = 0;

  for (const cn of notes as any[]) {
    try {
      const buffer = await generateCreditNotePdf(cn, prefetch);
      const pdfUrl = await uploadAndPresign(
        `credit-notes/${cn.creditNoteNo}.pdf`,
        buffer,
        `${cn.creditNoteNo}.pdf`,
      );
      await CreditNote.collection.updateOne({ _id: cn._id }, { $set: { pdfUrl } });
      ok++;
      console.log(`✓ ${cn.creditNoteNo}`);
    } catch (err: any) {
      failed++;
      console.error(`✗ ${cn.creditNoteNo} — ${err?.message}`);
    }
  }

  console.log(`\nSummary: ${ok} rendered, ${failed} failed, ${notes.length} total.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
