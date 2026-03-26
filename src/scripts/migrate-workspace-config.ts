// apps/backend/src/scripts/migrate-workspace-config.ts
//
// Populates the new config subdocument on every CustomerWorkspace
// that doesn't have one yet, deriving values from the existing travelMode field.
//
// Run:  npx tsx apps/backend/src/scripts/migrate-workspace-config.ts

import { connectDb } from "../config/db.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const SBT_MODES = new Set(["SBT", "FLIGHTS_ONLY", "HOTELS_ONLY", "BOTH"]);

function buildConfig(travelMode: string | undefined | null) {
  const mode = travelMode || "APPROVAL_FLOW";
  const isSBT = SBT_MODES.has(mode);

  return {
    travelFlow: isSBT ? "SBT" : "APPROVAL_FLOW",
    approval: {
      requireL2: true,
      requireL0: false,
      requireProposal: true,
    },
    tokenExpiryHours: 12,
    features: {
      sbtEnabled: isSBT,
      approvalFlowEnabled: !isSBT,
      approvalDirectEnabled: false,
      flightBookingEnabled: true,
      hotelBookingEnabled: true,
      visaEnabled: false,
      miceEnabled: false,
      forexEnabled: false,
    },
  };
}

async function main() {
  await connectDb();

  const docs = await CustomerWorkspace.find({
    $or: [
      { config: { $exists: false } },
      { "config.travelFlow": { $exists: false } },
    ],
  });

  console.log(`Found ${docs.length} workspace(s) to migrate.\n`);

  let migrated = 0;

  for (const doc of docs) {
    const travelMode = (doc as any).travelMode || null;
    const config = buildConfig(travelMode);

    (doc as any).config = config;
    await doc.save();

    migrated++;
    console.log(
      `Migrated workspace [${doc.customerId}]: travelMode=${travelMode ?? "(none)"} → travelFlow=${config.travelFlow}`,
    );
  }

  console.log(`\nDone. Migrated ${migrated} workspace(s).`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
