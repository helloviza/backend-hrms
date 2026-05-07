// Diagnostic — manually invoke the static-data-refresh job to verify CityCode
// resolution against TBO's CityList. Used to verify the dynamic resolver
// against TBO id drift without waiting for the 1st/16th cron tick.
//
// Run: pnpm exec tsx src/scripts/diag-tbo-static-refresh.ts
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { runStaticDataRefresh } from "../jobs/static-data-refresh.js";

async function main() {
  await mongoose.connect(env.MONGO_URI);
  console.log("[diag] Connected to MongoDB");
  const result = await runStaticDataRefresh("manual");
  console.log("[diag] Result:", JSON.stringify(result, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("[diag] FAILED:", e);
  process.exit(1);
});
