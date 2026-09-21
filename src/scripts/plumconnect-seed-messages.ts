// apps/backend/src/scripts/plumconnect-seed-messages.ts
//
// PlumConnect Track C — seed the canned-message store with today's exact
// strings (services/plumconnect/messages.ts MESSAGE_DEFAULTS), one global
// row per key. $setOnInsert only: a row that already exists — edited or
// not — is never touched, so the script is idempotent and safe to re-run
// after a deploy that adds keys. Behaviour is byte-identical with or
// without the rows (getMessage falls back to the same defaults); the rows
// exist so the editor (Track D) has something to show and edit.
//
// Usage:  pnpm -C apps/backend exec tsx src/scripts/plumconnect-seed-messages.ts

import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import { seedCannedMessages, MESSAGE_KEYS } from "../services/plumconnect/messages.js";

async function main() {
  try {
    await connectDb();
    console.log(`db=${mongoose.connection.name}  at=${new Date().toISOString()}  keys=${MESSAGE_KEYS.length}`);
    const r = await seedCannedMessages();
    console.log(`created ${r.created} row(s); ${r.total - r.created} already present (left untouched)`);
    console.log("VERDICT: SEEDED");
  } catch (err) {
    console.error("FAILED:", err);
    console.log("VERDICT: FAILED");
  } finally {
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
}

void main();
