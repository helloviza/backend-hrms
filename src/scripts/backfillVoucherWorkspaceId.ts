// apps/backend/src/scripts/backfillVoucherWorkspaceId.ts
//
// ONE-SHOT BACKFILL — stamp the correct `workspaceId` onto historical
// voucherextractions rows that predate the tenant migration.
//
// Background: POST /api/vouchers/extract was migrated to require workspaceId
// (schema marks workspaceId required:true), and the READ routes (GET /my, GET /)
// now scope strictly by workspaceId. Rows created before that fix have a
// missing/empty workspaceId and are therefore invisible to the scoped readers.
// This script resolves the correct workspaceId per row and writes it.
//
// Resolution strategy (most reliable signal first):
//   1. createdBy → User.workspaceId   (the uploader's own workspace; primary)
//   2. legacy customerId → CustomerWorkspace.findOne({ customerId })._id  (fallback)
// A row that resolves by NEITHER is SKIPPED and logged (never guessed).
//
// Idempotent: rows that already carry a workspaceId are skipped. Safe to re-run.
// Writes via updateOne (NOT hooked by the workspaceScope plugin, so no filter
// injection interferes with the targeted _id update).
//
// This script is invoked MANUALLY only — it is never imported or run on boot.
//
// Run (dry-run — logs what it WOULD do, writes nothing):
//   pnpm -C apps/backend tsx src/scripts/backfillVoucherWorkspaceId.ts --dry-run
//
// Run for real (writes workspaceId):
//   pnpm -C apps/backend tsx src/scripts/backfillVoucherWorkspaceId.ts
//
// (Equivalent from repo root: pnpm tsx apps/backend/src/scripts/backfillVoucherWorkspaceId.ts [--dry-run])

import "dotenv/config";
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import VoucherExtraction from "../models/VoucherExtraction.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const DRY_RUN = process.argv.includes("--dry-run");

// Cache customerId → workspace _id lookups (many rows can share a customerId).
const customerIdToWsId = new Map<string, string | null>();

async function resolveWsIdByCustomerId(customerId: string): Promise<string | null> {
  if (customerIdToWsId.has(customerId)) return customerIdToWsId.get(customerId)!;
  const ws: any = await CustomerWorkspace.findOne({ customerId })
    .select("_id")
    .lean();
  const id = ws?._id ? String(ws._id) : null;
  customerIdToWsId.set(customerId, id);
  return id;
}

async function run() {
  console.log(
    `\n📦 Voucher workspaceId backfill ${DRY_RUN ? "(DRY RUN — no writes)" : "(LIVE)"}\n`,
  );

  await connectDb();

  // Rows missing/empty workspaceId. The workspaceScope plugin only auto-injects
  // when the `_workspaceId` query option is set (it isn't here) and skips when
  // the filter already names workspaceId — so this filter is honored as written.
  const rows: any[] = await (VoucherExtraction as any)
    .find({
      $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }],
    })
    .lean()
    .exec();

  console.log(`Found ${rows.length} voucherextractions row(s) with missing workspaceId.\n`);

  let scanned = 0; // rows examined
  let resolvedByUser = 0; // workspaceId resolved via createdBy user
  let resolvedByCustomer = 0; // workspaceId resolved via legacy customerId
  let skippedUnresolvable = 0; // no reliable signal — left untouched
  let updated = 0; // rows written (or would-write in dry-run)
  let errors = 0; // per-row failures

  for (const row of rows) {
    scanned++;
    const label = `${String(row._id)} (docType=${row.docType ?? "?"}, customerId=${row.customerId ?? "—"})`;

    try {
      let wsId: string | null = null;
      let via = "";

      // 1) createdBy user's workspace (primary, most reliable)
      if (row.createdBy) {
        const user: any = await User.findById(row.createdBy)
          .select("_id workspaceId")
          .lean();
        if (user?.workspaceId) {
          wsId = String(user.workspaceId);
          via = "createdBy→User.workspaceId";
        }
      }

      // 2) legacy customerId → CustomerWorkspace (fallback)
      if (!wsId && row.customerId) {
        const byCustomer = await resolveWsIdByCustomerId(String(row.customerId));
        if (byCustomer) {
          wsId = byCustomer;
          via = "customerId→CustomerWorkspace._id";
        }
      }

      if (!wsId) {
        skippedUnresolvable++;
        console.log(`• ${label}: SKIP — unresolvable (no user.workspaceId, no customerId match).`);
        continue;
      }

      if (via.startsWith("createdBy")) resolvedByUser++;
      else resolvedByCustomer++;

      if (DRY_RUN) {
        updated++;
        console.log(`• ${label}: WOULD set workspaceId=${wsId} [via ${via}].`);
        continue;
      }

      await VoucherExtraction.updateOne(
        { _id: row._id },
        { $set: { workspaceId: new mongoose.Types.ObjectId(wsId) } },
      );
      updated++;
      console.log(`• ${label}: set workspaceId=${wsId} [via ${via}].`);
    } catch (err: any) {
      errors++;
      console.error(`• ${label}: ERROR — ${err?.message || err}`);
    }
  }

  console.log(`\n──────────── SUMMARY ${DRY_RUN ? "(DRY RUN)" : ""} ────────────`);
  console.log(`Rows scanned (missing workspaceId)  : ${scanned}`);
  console.log(`  resolved via createdBy user       : ${resolvedByUser}`);
  console.log(`  resolved via legacy customerId    : ${resolvedByCustomer}`);
  console.log(`  skipped — unresolvable            : ${skippedUnresolvable}`);
  console.log(`Rows ${DRY_RUN ? "that would update" : "updated"}             : ${updated}`);
  console.log(`Per-row errors                      : ${errors}`);
  console.log(`────────────────────────────────────────────\n`);

  if (DRY_RUN) {
    console.log("ℹ️  Dry run — nothing was written. Re-run without --dry-run to apply.\n");
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
