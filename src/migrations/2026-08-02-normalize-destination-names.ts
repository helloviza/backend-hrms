// apps/backend/src/migrations/2026-08-02-normalize-destination-names.ts
//
// VisaRule.destinationName is a denormalised display copy of what
// destinationIso2 already identifies — it exists purely for readability
// (reports, the admin console's table), never as a second source of
// truth. Nothing enforced that it actually agreed with destinationIso2
// until now: scripts/import-visa-checklist-rules.ts used to write
// whatever the source PDF's own extracted destinationName said verbatim
// (fixed in the same commit as this migration — see that file's own
// destinationName comment), so ISO2 "US" ended up with both "United
// States" (the seeded PUBLISHED rule) and "United States of America" (the
// checklist-import DRAFT rule, from the PDF's own title).
//
// This corrects every VisaRule whose destinationName doesn't match
// utils/countryCodes.ts's own canonical name for its destinationIso2 —
// not scoped to any one seedSource, since this is a data-integrity
// correction, not a business-term change requiring ops review (same
// posture the price-list merge and template-relink migrations already
// take for documentGroups/pricing fields on ANY rule regardless of
// status). A destinationIso2 countryCodes.ts doesn't recognise at all is
// left untouched and reported — never blanked or guessed.
//
// Reports the full sweep — every ISO2 currently carrying more than one
// distinct destinationName — not just the one this migration already
// knows about (US), so a NEW divergence introduced some other way is
// never silently missed.
//
// Ledger (Phase 10d) — dry-run by default, --apply to write, recorded via
// migrations/lib/migrationRunner.ts; a second --apply is refused unless
// --force.
//
// Usage (run from apps/backend):
//   pnpm exec tsx src/migrations/2026-08-02-normalize-destination-names.ts              # dry-run
//   pnpm exec tsx src/migrations/2026-08-02-normalize-destination-names.ts --apply       # write
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRule from "../models/VisaRule.js";
import { getCountryByIso2 } from "../utils/countryCodes.js";
import { runMigration } from "./lib/migrationRunner.js";

export interface DivergentIso2 {
  destinationIso2: string;
  names: string[];
}

export interface DestinationNameChange {
  ruleId: string;
  destinationIso2: string;
  from: string;
  to: string;
}

export interface NormalizeDestinationNamesSummary {
  scanned: number;
  updated: number;
  unchanged: number;
  skippedNoCanonicalName: { ruleId: string; destinationIso2: string; destinationName: string }[];
  divergentIso2sBeforeRun: DivergentIso2[];
  changes: DestinationNameChange[];
}

export async function normalizeDestinationNames(dryRun: boolean): Promise<NormalizeDestinationNamesSummary> {
  const rules = await VisaRule.find({}).select("_id destinationIso2 destinationName").lean();

  // Sweep — computed from the PRE-run state, so it always answers "what
  // was actually wrong before this migration touched anything", even on
  // a dry run.
  const namesByIso2 = new Map<string, Set<string>>();
  for (const r of rules as any[]) {
    const set = namesByIso2.get(r.destinationIso2) || new Set<string>();
    set.add(r.destinationName);
    namesByIso2.set(r.destinationIso2, set);
  }
  const divergentIso2sBeforeRun: DivergentIso2[] = [...namesByIso2.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([destinationIso2, names]) => ({ destinationIso2, names: [...names].sort() }));

  const summary: NormalizeDestinationNamesSummary = {
    scanned: rules.length,
    updated: 0,
    unchanged: 0,
    skippedNoCanonicalName: [],
    divergentIso2sBeforeRun,
    changes: [],
  };

  for (const r of rules as any[]) {
    const canonical = getCountryByIso2(r.destinationIso2)?.name;
    if (!canonical) {
      summary.skippedNoCanonicalName.push({ ruleId: String(r._id), destinationIso2: r.destinationIso2, destinationName: r.destinationName });
      continue;
    }
    if (canonical === r.destinationName) {
      summary.unchanged += 1;
      continue;
    }

    summary.updated += 1;
    summary.changes.push({ ruleId: String(r._id), destinationIso2: r.destinationIso2, from: r.destinationName, to: canonical });
    if (!dryRun) {
      await VisaRule.updateOne({ _id: r._id, destinationName: r.destinationName }, { $set: { destinationName: canonical } });
    }
  }

  return summary;
}

/* ─────────────────────────────────────────────────────────────────────
 * Entry point.
 * ───────────────────────────────────────────────────────────────────── */
async function main() {
  const dryRun = !process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  console.log("=== Normalize VisaRule.destinationName against countryCodes.ts ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    await runMigration({
      migrationName: "2026-08-02-normalize-destination-names",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const summary = await normalizeDestinationNames(dryRun);

        console.log(`Rules scanned: ${summary.scanned}`);
        console.log(`  to update: ${summary.updated}, already correct: ${summary.unchanged}, no canonical name available: ${summary.skippedNoCanonicalName.length}`);
        console.log("");

        console.log(`ISO2s with more than one distinct destinationName (before this run): ${summary.divergentIso2sBeforeRun.length}`);
        for (const d of summary.divergentIso2sBeforeRun) {
          console.log(`  ${d.destinationIso2}: ${d.names.map((n) => `"${n}"`).join(", ")}`);
        }

        if (summary.changes.length) {
          console.log("\nChanges:");
          for (const c of summary.changes) {
            console.log(`  ${c.ruleId} (${c.destinationIso2}): "${c.from}" -> "${c.to}"`);
          }
        }
        if (summary.skippedNoCanonicalName.length) {
          console.log("\nSkipped — ISO2 not recognised by countryCodes.ts (left untouched):");
          for (const s of summary.skippedNoCanonicalName) {
            console.log(`  ${s.ruleId}: ${s.destinationIso2} ("${s.destinationName}")`);
          }
        }

        if (dryRun) {
          console.log("\nRe-run with --apply to write these changes.");
        }

        return {
          outcome: "SUCCESS",
          summary:
            `scanned=${summary.scanned} updated=${summary.updated} unchanged=${summary.unchanged} ` +
            `skippedNoCanonicalName=${summary.skippedNoCanonicalName.length} divergentIso2sBeforeRun=${summary.divergentIso2sBeforeRun.length}`,
        };
      },
    });
  } finally {
    await mongoose.connection.close();
  }
}

const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Normalize destination names failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
