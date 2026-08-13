// apps/backend/src/migrations/2026-08-02-flag-uae-overlap.ts
//
// The checklist-import DRAFT rule for UAE (IN/AE/TOURIST/UNSPECIFIED/
// STANDARD/DEFAULT) doesn't collide with the 3 already-PUBLISHED UAE
// rules (IN/AE/TOURIST/MULTIPLE/{EXPRESS,STANDARD,SUPERFAST}/DEFAULT) —
// different entryType keeps the natural key distinct — but it's
// conceptually the same product (a UAE tourist e-visa), extracted from a
// fuller checklist PDF than whatever seed-visa-rules.ts's own placeholder
// data was built from.
//
// This ONLY sets opsNotes (a display-only annotation — see VisaRule.ts's
// own field comment) on the DRAFT rule, flagging the overlap for a human
// to weigh. It deliberately does NOT merge, retire, or touch status on
// anything — whether to keep both, retire the old ones, or fold the
// checklist content into the published rules is an ops decision made
// through the rule console, not something a migration should decide for
// them.
//
// Idempotent: if the rule's opsNotes already contains this exact note
// (e.g. a prior --apply, or ops copied it in by hand), this is a no-op —
// appends to whatever's already there otherwise, never overwrites an
// unrelated existing note.
//
// Ledger (Phase 10d) — dry-run by default, --apply to write, recorded via
// migrations/lib/migrationRunner.ts; a second --apply is refused unless
// --force.
//
// Usage (run from apps/backend):
//   pnpm exec tsx src/migrations/2026-08-02-flag-uae-overlap.ts              # dry-run
//   pnpm exec tsx src/migrations/2026-08-02-flag-uae-overlap.ts --apply       # write
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRule from "../models/VisaRule.js";
import { runMigration } from "./lib/migrationRunner.js";

export const UAE_DRAFT_RULE_KEY = {
  nationality: "IN",
  destinationIso2: "AE",
  purpose: "TOURIST",
  entryType: "UNSPECIFIED",
  serviceTier: "STANDARD",
  variantKey: "DEFAULT",
} as const;

export const UAE_OVERLAP_NOTE =
  "Overlaps with 3 already-PUBLISHED UAE tourist e-visa rules (TOURIST/MULTIPLE, service tiers " +
  "EXPRESS/STANDARD/SUPERFAST) — same nationality, destination and purpose; this rule's entryType " +
  "(UNSPECIFIED) is what keeps it from colliding with them on the natural key. Conceptually the same " +
  "product, extracted from a fuller checklist PDF than the published rules' placeholder data. Flagged " +
  "for ops review — not merged or retired automatically; that decision belongs in the rule console.";

export interface FlagUaeOverlapSummary {
  ruleFound: boolean;
  ruleId: string | null;
  status: string | null;
  alreadyFlagged: boolean;
  applied: boolean;
}

export async function flagUaeOverlap(dryRun: boolean): Promise<FlagUaeOverlapSummary> {
  const rule = await VisaRule.findOne(UAE_DRAFT_RULE_KEY);

  if (!rule) {
    return { ruleFound: false, ruleId: null, status: null, alreadyFlagged: false, applied: false };
  }

  const existingNotes = rule.opsNotes || "";
  if (existingNotes.includes(UAE_OVERLAP_NOTE)) {
    return { ruleFound: true, ruleId: String(rule._id), status: rule.status, alreadyFlagged: true, applied: false };
  }

  if (!dryRun) {
    rule.opsNotes = existingNotes ? `${existingNotes}\n\n${UAE_OVERLAP_NOTE}` : UAE_OVERLAP_NOTE;
    await rule.save();
  }

  return { ruleFound: true, ruleId: String(rule._id), status: rule.status, alreadyFlagged: false, applied: true };
}

/* ─────────────────────────────────────────────────────────────────────
 * Entry point.
 * ───────────────────────────────────────────────────────────────────── */
async function main() {
  const dryRun = !process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  console.log("=== Flag the UAE draft/published overlap ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    await runMigration({
      migrationName: "2026-08-02-flag-uae-overlap",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const summary = await flagUaeOverlap(dryRun);

        if (!summary.ruleFound) {
          console.log("No rule found for IN/AE/TOURIST/UNSPECIFIED/STANDARD/DEFAULT — nothing to flag.");
        } else if (summary.alreadyFlagged) {
          console.log(`Rule ${summary.ruleId} (status ${summary.status}) already carries this note — no change.`);
        } else {
          console.log(`Rule ${summary.ruleId} (status ${summary.status}) — ${dryRun ? "would add" : "added"} the overlap note to opsNotes.`);
        }

        if (dryRun && summary.ruleFound && !summary.alreadyFlagged) {
          console.log("\nRe-run with --apply to write this change.");
        }

        return {
          outcome: "SUCCESS",
          summary: `ruleFound=${summary.ruleFound} ruleId=${summary.ruleId ?? "n/a"} alreadyFlagged=${summary.alreadyFlagged} applied=${summary.applied}`,
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
    console.error("Flag UAE overlap failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
