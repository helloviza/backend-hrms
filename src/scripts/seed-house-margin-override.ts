// apps/backend/src/scripts/seed-house-margin-override.ts
//
// Gives House (Plumtrips' own workspace) a 0% SBT margin override on all four
// numbers, so staff test bookings cost exactly net. Logged in SBTMarginChange
// like an edit on the admin page. Idempotent: if House already has an
// override, it is shown and left alone (change it on /admin/sbt/margins).
//
// Dry run by default. Flags:
//   --expect-db=<name>   must equal the connected database, or nothing is read
//   --apply              write the override + the change-log entry
//
//   npx tsx --env-file=.env src/scripts/seed-house-margin-override.ts --expect-db=plumbox
//   npx tsx --env-file=.env src/scripts/seed-house-margin-override.ts --expect-db=plumbox --apply
import "dotenv/config";
import mongoose from "mongoose";
import SBTMarginOverride from "../models/SBTMarginOverride.js";
import SBTMarginChange from "../models/SBTMarginChange.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { HOUSE_WORKSPACE_ID } from "../utils/bookingAccess.js";

const REASON = "House: staff test bookings at net (0%)";
const ZERO = { flight: { domestic: 0, international: 0 }, hotel: { domestic: 0, international: 0 } };

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const expectDb = args.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);

  const house = (await CustomerWorkspace.findById(HOUSE_WORKSPACE_ID).select("companyName customerId").lean()) as any;
  if (!house) throw new Error(`House workspace ${HOUSE_WORKSPACE_ID} not found in "${db}"`);
  const name = String(house.companyName || house.customerId || "House");

  const existing = (await SBTMarginOverride.findOne({ workspaceId: HOUSE_WORKSPACE_ID }).lean()) as any;
  if (existing) {
    console.log(`House (${name}) already has an override — left unchanged:`);
    console.log(JSON.stringify({ flight: existing.flight, hotel: existing.hotel, reason: existing.reason, validUntil: existing.validUntil }));
    return;
  }
  console.log(`${apply ? "Writing" : "Would write"} House (${name}) override in "${db}": all four margins 0%, reason "${REASON}"`);
  if (!apply) {
    console.log("Dry run — re-run with --apply to write.");
    return;
  }
  await SBTMarginOverride.create({
    workspaceId: HOUSE_WORKSPACE_ID, ...ZERO, reason: REASON, validUntil: null,
    createdBy: "script:seed-house-margin-override", updatedBy: "script:seed-house-margin-override",
  });
  await SBTMarginChange.create({
    scope: "WORKSPACE", action: "CREATE", workspaceId: HOUSE_WORKSPACE_ID, workspaceName: name,
    before: null, after: { ...ZERO, validUntil: null }, reason: REASON,
    actorId: "script:seed-house-margin-override", actorName: "Setup script", at: new Date(),
  });
  console.log("Done. Takes effect on every instance within a minute.");
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
