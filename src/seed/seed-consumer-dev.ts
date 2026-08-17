// apps/backend/src/seed/seed-consumer-dev.ts
//
// RERUNNABLE local seed for the D2C consumer surface.
// `pnpm -C apps/backend seed:consumer`
//
// Stands up the synthetic "Helloviza D2C" workspace and TWO consumers:
//
//   test@helloviza.dev   — the one you log in as while building
//   other@helloviza.dev  — exists ONLY so isolation is demonstrable
//
// ── WHY A SECOND CONSUMER ───────────────────────────────────────────────
// Per-consumer isolation on this surface is ROW-LEVEL on Consumer._id, not
// workspace-level — every consumer shares one workspace id
// (services/consumerWorkspace.ts). A single-consumer dev database therefore
// cannot show the difference between "scoped correctly" and "not scoped at
// all": both look identical when there is only one row. The second consumer
// is what makes a leak visible, in the automated test and by hand.
//
// ── WHY IT DOES NOT MINT TOKENS ─────────────────────────────────────────
// This script only creates rows. Sessions come from the REAL cookie-issuing
// path (routes/consumer.devAuth.ts calls the same issueConsumerSession() the
// production login calls), so nothing here can drift away from how a real
// login behaves.

import "../bootstrap/loadSecrets.js";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { assertLocalDatabase } from "./assertLocalDatabase.js";
import Consumer from "../models/Consumer.js";
import {
  ensureD2CWorkspace,
  HELLOVIZA_D2C_WORKSPACE_ID,
} from "../services/consumerWorkspace.js";

const BCRYPT_COST = 12; // same as routes/consumer.auth.ts

/** The password both seeded consumers get. Dev-only, and printed on purpose. */
export const DEV_CONSUMER_PASSWORD = "Passw0rd!";

export const DEV_CONSUMER_EMAIL = "test@helloviza.dev";
export const DEV_OTHER_CONSUMER_EMAIL = "other@helloviza.dev";

const SEEDED = [
  {
    email: DEV_CONSUMER_EMAIL,
    name: "Ananya Test",
    phone: "+919000000001",
  },
  {
    email: DEV_OTHER_CONSUMER_EMAIL,
    name: "Other Consumer",
    phone: "+919000000002",
  },
];

/**
 * Upserted, not torn down.
 *
 * seed-dev.ts rebuilds its workspace from scratch on every run because its
 * rows are a dozen cross-referenced collections that would drift. These two
 * are single rows with a stable natural key (email), and a teardown here
 * would throw away the profile you were halfway through filling in by hand —
 * which is the whole thing you are trying to look at. $setOnInsert on the
 * identity fields, so a re-run never resets tokenVersion (that would silently
 * log you out) and never clobbers a status you changed to test the disabled
 * path.
 */
async function upsertConsumer(spec: (typeof SEEDED)[number]): Promise<void> {
  const existing = await Consumer.findOne({ email: spec.email }).select("_id").lean();

  if (existing) {
    console.log(`[seed:consumer] ${spec.email} — already present (${String(existing._id)})`);
    return;
  }

  const passwordHash = await bcrypt.hash(DEV_CONSUMER_PASSWORD, BCRYPT_COST);
  const created = await Consumer.create({
    email: spec.email,
    name: spec.name,
    phone: spec.phone,
    passwordHash,
  });

  console.log(`[seed:consumer] ${spec.email} — created (${String(created._id)})`);
}

async function main(): Promise<void> {
  const uri = env.MONGO_URI;
  assertLocalDatabase(uri);

  await mongoose.connect(uri);
  console.log(`[seed:consumer] connected to ${uri} (db: ${mongoose.connection.name})`);

  await ensureD2CWorkspace();
  console.log(`[seed:consumer] D2C workspace ensured (${HELLOVIZA_D2C_WORKSPACE_ID})`);

  for (const spec of SEEDED) {
    await upsertConsumer(spec);
  }

  console.log("");
  console.log("  Log in as the test consumer:");
  console.log(`    email:    ${DEV_CONSUMER_EMAIL}`);
  console.log(`    password: ${DEV_CONSUMER_PASSWORD}`);
  console.log("");
  console.log("  …or skip the password entirely (dev only):");
  console.log("    POST /api/consumer/dev-auth/login");
  console.log("");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[seed:consumer] FAILED:", err?.message ?? err);
  process.exit(1);
});
