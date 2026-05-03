/**
 * Backfill gstRegisteredState from address.state for customers that have it.
 * Idempotent — safe to re-run. Does NOT overwrite an already-set gstRegisteredState.
 */

import "../config/db.js";
import Customer from "../models/Customer.js";
import { GST_STATE_CODES } from "../utils/gstDetection.js";

const knownStates = new Set(Object.keys(GST_STATE_CODES));

async function run() {
  const customers = await Customer.find({}).lean();

  let migrated = 0;
  let alreadySet = 0;
  const missing: { id: string; name: string }[] = [];

  for (const c of customers as any[]) {
    if (c.gstRegisteredState) {
      alreadySet++;
      continue;
    }

    const state = c.address?.state || c.shippingAddress?.state || "";
    const name = c.legalName || c.companyName || c.name || "Unknown";

    if (state && knownStates.has(state)) {
      const stateCode = GST_STATE_CODES[state];
      await Customer.updateOne(
        { _id: c._id, gstRegisteredState: { $exists: false } },
        { $set: { gstRegisteredState: state, gstRegisteredStateCode: stateCode } },
      );
      migrated++;
      console.log(`  ✓ ${name} → ${state} (${stateCode})`);
    } else {
      missing.push({ id: String(c._id), name });
    }
  }

  console.log("\n=== Backfill Summary ===");
  console.log(`Already had gstRegisteredState : ${alreadySet}`);
  console.log(`Migrated from address.state    : ${migrated}`);
  console.log(`Missing state (manual fix req'd): ${missing.length}`);

  if (missing.length) {
    console.log("\nCustomers still missing state:");
    for (const m of missing) console.log(`  [${m.id}] ${m.name}`);
  }

  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
