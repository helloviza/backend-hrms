// apps/backend/src/scripts/verify-workspace-config.ts
//
// Reads all CustomerWorkspace docs and prints a summary table.
// Flags any workspace where config is missing or inconsistent with travelMode.
//
// Run:  npx tsx src/scripts/verify-workspace-config.ts

import { connectDb } from "../config/db.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const SBT_MODES = new Set(["SBT", "FLIGHTS_ONLY", "HOTELS_ONLY", "BOTH"]);

function expectedFlow(travelMode: string | undefined): string {
  if (!travelMode) return "APPROVAL_FLOW";
  return SBT_MODES.has(travelMode) ? "SBT" : travelMode;
}

async function main() {
  await connectDb();

  const docs = await CustomerWorkspace.find({}).lean();
  console.log(`Total workspaces: ${docs.length}\n`);

  let issues = 0;

  console.log(
    "customerId".padEnd(28) +
    "travelMode".padEnd(18) +
    "travelFlow".padEnd(18) +
    "sbt".padEnd(6) +
    "approval".padEnd(10) +
    "expiry".padEnd(8) +
    "status"
  );
  console.log("-".repeat(96));

  for (const doc of docs) {
    const d = doc as any;
    const tm = d.travelMode || "(none)";
    const cfg = d.config;
    const tf = cfg?.travelFlow || "(missing)";
    const sbt = cfg?.features?.sbtEnabled ?? "?";
    const appr = cfg?.features?.approvalFlowEnabled ?? "?";
    const expiry = cfg?.tokenExpiryHours ?? "?";

    const flags: string[] = [];

    if (!cfg || !cfg.travelFlow) {
      flags.push("NO_CONFIG");
    } else {
      const expect = expectedFlow(d.travelMode);
      if (cfg.travelFlow !== expect) {
        flags.push(`MISMATCH(expect=${expect})`);
      }
    }

    const status = flags.length ? flags.join(", ") : "OK";
    if (flags.length) issues++;

    console.log(
      String(d.customerId || "").padEnd(28) +
      String(tm).padEnd(18) +
      String(tf).padEnd(18) +
      String(sbt).padEnd(6) +
      String(appr).padEnd(10) +
      String(expiry).padEnd(8) +
      status
    );
  }

  console.log("-".repeat(96));
  console.log(`\nIssues: ${issues}  |  Clean: ${docs.length - issues}`);

  process.exit(0);
}

main().catch((e) => {
  console.error("Verification failed:", e);
  process.exit(1);
});
