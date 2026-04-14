// apps/backend/src/scripts/enable-sbt-inteletekai.ts
//
// Enables SBT / flight / hotel features for the inteletekai.com workspace.
// workspaceId (customerId): 69679a7628330a58d29f2254
//
// Run: pnpm -C apps/backend tsx src/scripts/enable-sbt-inteletekai.ts

import { connectDb } from "../config/db.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

// NOTE: The originally provided ID 69679a7628330a58d29f2254 doesn't exist.
// The inteletekai.com workspace was found by domain lookup: customerId = 69cc496b20f2a4a00c4bf4b3
const WORKSPACE_ID = "69cc496b20f2a4a00c4bf4b3";

async function main() {
  await connectDb();

  const ws = await CustomerWorkspace.findOne({ customerId: WORKSPACE_ID });
  if (!ws) {
    console.error(`No CustomerWorkspace found for customerId: ${WORKSPACE_ID}`);
    process.exit(1);
  }

  // ── Log current state ────────────────────────────────────────────────
  console.log("=== Current state ===");
  console.log("companyName    :", ws.companyName);
  console.log("plan           :", ws.plan);
  console.log("travelMode     :", ws.travelMode);
  console.log("config.travelFlow            :", ws.config?.travelFlow);
  console.log("config.features.sbtEnabled   :", ws.config?.features?.sbtEnabled);
  console.log("config.features.flightBookingEnabled :", ws.config?.features?.flightBookingEnabled);
  console.log("config.features.hotelBookingEnabled  :", ws.config?.features?.hotelBookingEnabled);

  // ── Determine what needs changing ───────────────────────────────────
  const updates: Record<string, unknown> = {};

  if (!ws.config?.features?.sbtEnabled) {
    updates["config.features.sbtEnabled"] = true;
    console.log("\n[+] Will enable config.features.sbtEnabled");
  }
  if (!ws.config?.features?.flightBookingEnabled) {
    updates["config.features.flightBookingEnabled"] = true;
    console.log("[+] Will enable config.features.flightBookingEnabled");
  }
  if (!ws.config?.features?.hotelBookingEnabled) {
    updates["config.features.hotelBookingEnabled"] = true;
    console.log("[+] Will enable config.features.hotelBookingEnabled");
  }
  // Also align travelFlow and travelMode to SBT
  if (ws.config?.travelFlow !== "SBT") {
    updates["config.travelFlow"] = "SBT";
    console.log("[+] Will set config.travelFlow = SBT");
  }
  if (ws.travelMode !== "SBT") {
    updates["travelMode"] = "SBT";
    console.log("[+] Will set travelMode = SBT");
  }

  if (Object.keys(updates).length === 0) {
    console.log("\nAll required features already enabled — nothing to do.");
    process.exit(0);
  }

  // ── Apply ────────────────────────────────────────────────────────────
  await CustomerWorkspace.updateOne({ customerId: WORKSPACE_ID }, { $set: updates });
  console.log("\n=== Update applied ===");

  // Re-fetch and confirm
  const after = await CustomerWorkspace.findOne({ customerId: WORKSPACE_ID });
  console.log("config.travelFlow            :", after?.config?.travelFlow);
  console.log("config.features.sbtEnabled   :", after?.config?.features?.sbtEnabled);
  console.log("config.features.flightBookingEnabled :", after?.config?.features?.flightBookingEnabled);
  console.log("config.features.hotelBookingEnabled  :", after?.config?.features?.hotelBookingEnabled);
  console.log("\nDone.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Script failed:", e);
  process.exit(1);
});
