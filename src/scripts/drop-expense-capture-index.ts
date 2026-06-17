// apps/backend/src/scripts/drop-expense-capture-index.ts
//
// One-time migration for Sprint 3b-1. The Expense.expenseCaptureId index changed
// from a non-sparse unique index to unique+sparse (web expenses omit the field).
// Mongoose autoIndex will NOT alter an existing index whose options differ — it
// raises a conflict and keeps the old index. So we drop the old index here and
// let syncIndexes() rebuild it from the current schema (sparse).
//
// Idempotent: safe to run repeatedly. If the index is already sparse (or absent),
// it does nothing destructive.
//
// Run: pnpm -C apps/backend tsx src/scripts/drop-expense-capture-index.ts

import { connectDb } from "../config/db.js";
import Expense from "../models/Expense.js";

const INDEX_NAME = "expenseCaptureId_1";

async function main() {
  await connectDb();
  console.log("✅ Connected to MongoDB");

  const coll = Expense.collection;
  const indexes = await coll.indexes();
  const existing = indexes.find((ix: any) => ix.name === INDEX_NAME);

  if (!existing) {
    console.log(`ℹ️  Index ${INDEX_NAME} not present — nothing to drop.`);
  } else if (existing.sparse) {
    console.log(`✅ Index ${INDEX_NAME} is already sparse — no change needed.`);
  } else {
    console.log(`⚠️  Dropping non-sparse index ${INDEX_NAME}:`, JSON.stringify(existing));
    await coll.dropIndex(INDEX_NAME);
    console.log(`✅ Dropped ${INDEX_NAME}.`);
  }

  // Rebuild indexes from the current schema (creates the sparse unique index).
  console.log("⏳ Running syncIndexes() to rebuild from schema…");
  await Expense.syncIndexes();

  const after = await coll.indexes();
  const rebuilt = after.find((ix: any) => ix.name === INDEX_NAME);
  console.log("📋 Final expenseCaptureId index:", JSON.stringify(rebuilt ?? null));
  console.log(
    rebuilt?.sparse && rebuilt?.unique
      ? "✅ Confirmed: expenseCaptureId index is unique + sparse."
      : "❌ WARNING: expenseCaptureId index is NOT unique+sparse — investigate.",
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
