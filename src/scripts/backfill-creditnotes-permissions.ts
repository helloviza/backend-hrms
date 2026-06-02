/**
 * Backfill the "creditnotes" permission module onto existing UserPermission docs.
 * Idempotent — safe to re-run. For each user, the creditnotes access mirrors the
 * user's existing invoices access (FULL→FULL, WRITE→WRITE, READ→READ; NONE or
 * absent → NONE), copying the same scope. Credit notes are a child of invoicing,
 * so whoever can act on invoices gets the matching credit-note grant.
 *
 * Skips users that already have a non-NONE creditnotes entry (preserves any
 * manual grants/revokes made later from the admin UI).
 *
 * Run: pnpm -C apps/backend tsx src/scripts/backfill-creditnotes-permissions.ts
 */

import { connectDb } from "../config/db.js";
import { UserPermission } from "../models/UserPermission.js";

async function main() {
  await connectDb();

  const docs = await UserPermission.find({}).lean();
  console.log(`Total UserPermission docs: ${docs.length}\n`);

  let added = 0;
  let alreadyHad = 0;
  let matchedFromInvoices = 0;

  for (const doc of docs as any[]) {
    const modules = doc.modules || {};
    const creditnotesAccess = modules?.creditnotes?.access ?? "NONE";

    // Idempotent: a non-NONE creditnotes entry already exists — leave it alone.
    if (creditnotesAccess !== "NONE") {
      alreadyHad++;
      console.log(`= already present ${doc.email} (creditnotes: ${creditnotesAccess})`);
      continue;
    }

    const invoicesAccess = modules?.invoices?.access ?? "NONE";
    const invoicesScope = modules?.invoices?.scope ?? "NONE";

    await UserPermission.updateOne(
      { _id: doc._id },
      { $set: { "modules.creditnotes": { access: invoicesAccess, scope: invoicesScope } } },
    );

    if (invoicesAccess !== "NONE") {
      matchedFromInvoices++;
      console.log(`↻ matched-invoices ${doc.email} → creditnotes: ${invoicesAccess} / ${invoicesScope}`);
    } else {
      added++;
      console.log(`✓ added ${doc.email} → creditnotes: NONE / NONE`);
    }
  }

  console.log(
    `\nSummary: ${docs.length} total, ${matchedFromInvoices} matched-from-invoices, ` +
      `${added} added (NONE), ${alreadyHad} already-had`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
