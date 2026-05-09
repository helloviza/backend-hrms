// apps/backend/src/migrations/2026-05-06-backfill-feature-flags.ts
//
// Backfills the 5 new coarse-grained feature flags onto existing
// CustomerWorkspace docs:
//   hrmsEnabled, crmEnabled, vouchersEnabled, invoicesEnabled, ticketsEnabled
//
// Behavior:
//   - SaaS HRMS tenants (tenantType === "SAAS_HRMS"):
//       hrmsEnabled=true, crmEnabled=false, vouchersEnabled=false,
//       invoicesEnabled=false, ticketsEnabled=false
//   - Travel CRM customers (tenantType absent or any non-SAAS_HRMS,
//     non-HOUSE value):
//       hrmsEnabled=true, crmEnabled=true, vouchersEnabled=true,
//       invoicesEnabled=true, ticketsEnabled=true
//
// CRITICAL — Plumtrips HOUSE workspace is EXPLICITLY EXCLUDED at every
// query layer. Internal Plumtrips users have SUPERADMIN role, which
// bypasses requireFeature middleware, so this workspace never needs
// flags set on it.
//
// Usage:
//   pnpm -C apps/backend tsx src/migrations/2026-05-06-backfill-feature-flags.ts            # dry-run
//   pnpm -C apps/backend tsx src/migrations/2026-05-06-backfill-feature-flags.ts --apply    # write
//   pnpm -C apps/backend tsx src/migrations/2026-05-06-backfill-feature-flags.ts --rollback # $unset the 5 flags
//
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const PLUMTRIPS_WORKSPACE_ID = "69679a7628330a58d29f2254";
const MAX_WORKSPACES_TO_TOUCH = 50;

const NEW_FLAGS = [
  "hrmsEnabled",
  "crmEnabled",
  "vouchersEnabled",
  "invoicesEnabled",
  "ticketsEnabled",
] as const;

type FlagSet = {
  hrmsEnabled: boolean;
  crmEnabled: boolean;
  vouchersEnabled: boolean;
  invoicesEnabled: boolean;
  ticketsEnabled: boolean;
};

const SAAS_HRMS_FLAGS: FlagSet = {
  hrmsEnabled: true,
  crmEnabled: false,
  vouchersEnabled: false,
  invoicesEnabled: false,
  ticketsEnabled: false,
};

const TRAVEL_CUSTOMER_FLAGS: FlagSet = {
  hrmsEnabled: true,
  crmEnabled: true,
  vouchersEnabled: true,
  invoicesEnabled: true,
  ticketsEnabled: true,
};

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply") && !args.includes("--rollback");
const ROLLBACK = args.includes("--rollback");

/**
 * Plumtrips-exclusion filter — applied to EVERY find/update query in
 * this migration. Excludes both by ObjectId equality and by tenantType.
 */
function buildTargetFilter() {
  return {
    $and: [
      { _id: { $ne: new mongoose.Types.ObjectId(PLUMTRIPS_WORKSPACE_ID) } },
      { tenantType: { $ne: "HOUSE" } },
    ],
  };
}

async function main() {
  console.log("=== Backfill feature flags migration ===");
  console.log(`Mode: ${ROLLBACK ? "ROLLBACK" : DRY_RUN ? "DRY RUN" : "APPLY"}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    const targetFilter = buildTargetFilter();

    // ── SAFETY CHECK: confirm Plumtrips workspace would be EXCLUDED ──
    const plumtripsRaw = await CustomerWorkspace.findById(PLUMTRIPS_WORKSPACE_ID).lean();
    if (!plumtripsRaw) {
      console.warn(
        `WARNING: Plumtrips HOUSE workspace _id=${PLUMTRIPS_WORKSPACE_ID} not found. ` +
          `Continuing anyway — exclusion filter still applied defensively.`,
      );
    } else {
      console.log("Plumtrips HOUSE workspace located:");
      console.log(`  _id:         ${plumtripsRaw._id}`);
      console.log(`  companyName: ${(plumtripsRaw as any).companyName ?? "(unknown)"}`);
      console.log(`  tenantType:  ${(plumtripsRaw as any).tenantType ?? "(absent)"}`);
      console.log("");
    }

    const plumtripsInTarget = await CustomerWorkspace.findOne({
      $and: [
        targetFilter,
        { _id: new mongoose.Types.ObjectId(PLUMTRIPS_WORKSPACE_ID) },
      ],
    }).lean();
    if (plumtripsInTarget) {
      console.error(
        "FATAL: Plumtrips HOUSE workspace was returned by the target filter. " +
          "Exclusion is broken. Aborting.",
      );
      process.exit(1);
    }
    console.log(
      `[OK] Exclusion filter verified — Plumtrips HOUSE workspace ` +
        `(${PLUMTRIPS_WORKSPACE_ID}) is NOT in target set.`,
    );
    console.log("");

    // ── Find all candidate workspaces ──
    const candidates = await CustomerWorkspace.find(targetFilter)
      .select("_id customerId companyName tenantType config.features status")
      .lean();

    console.log(`Found ${candidates.length} candidate workspaces (Plumtrips excluded).`);
    console.log("");

    // Hard safety guard
    if (candidates.length > MAX_WORKSPACES_TO_TOUCH) {
      console.error(
        `FATAL: ${candidates.length} workspaces would be modified, ` +
          `exceeding safety limit of ${MAX_WORKSPACES_TO_TOUCH}. Aborting.`,
      );
      process.exit(1);
    }

    // Final paranoia: scan candidate IDs for the Plumtrips ID
    const plumtripsIdStr = PLUMTRIPS_WORKSPACE_ID;
    const containsPlumtrips = candidates.some(
      (ws: any) => String(ws._id) === plumtripsIdStr,
    );
    if (containsPlumtrips) {
      console.error(
        "FATAL: Plumtrips HOUSE workspace appeared in candidate list despite filter. Aborting.",
      );
      process.exit(1);
    }

    // ── Plan updates ──
    type Plan = {
      _id: any;
      customerId: string;
      companyName: string;
      tenantType: string;
      cohort: "SAAS_HRMS" | "TRAVEL_CUSTOMER";
      flags: FlagSet;
    };

    const plans: Plan[] = candidates.map((ws: any) => {
      const isSaas = ws.tenantType === "SAAS_HRMS";
      return {
        _id: ws._id,
        customerId: String(ws.customerId ?? ""),
        companyName: String(ws.companyName ?? "(no name)"),
        tenantType: ws.tenantType ?? "(absent)",
        cohort: isSaas ? "SAAS_HRMS" : "TRAVEL_CUSTOMER",
        flags: isSaas ? SAAS_HRMS_FLAGS : TRAVEL_CUSTOMER_FLAGS,
      };
    });

    const saasCount = plans.filter((p) => p.cohort === "SAAS_HRMS").length;
    const travelCount = plans.filter((p) => p.cohort === "TRAVEL_CUSTOMER").length;
    console.log(`Cohort breakdown: ${saasCount} SaaS HRMS, ${travelCount} Travel CRM customers.`);
    console.log("");

    console.log("Workspaces that WILL BE updated:");
    console.log("─".repeat(80));
    for (const p of plans) {
      console.log(
        `  [${p.cohort}] ${p.companyName} ` +
          `(_id=${p._id}, customerId=${p.customerId}, tenantType=${p.tenantType})`,
      );
    }
    console.log("─".repeat(80));
    console.log("");

    if (DRY_RUN) {
      console.log(
        `DRY RUN — would update ${plans.length} workspaces. ` +
          `Plumtrips HOUSE workspace excluded.`,
      );
      console.log("Re-run with --apply to commit, or --rollback to $unset the 5 flags.");
      return;
    }

    // ── APPLY or ROLLBACK ──
    let totalModified = 0;

    if (ROLLBACK) {
      // Rollback: $unset the 5 flag fields on the SAME exclusion-filtered set
      const unsetSpec: Record<string, ""> = {};
      for (const flag of NEW_FLAGS) {
        unsetSpec[`config.features.${flag}`] = "";
      }
      const result = await CustomerWorkspace.updateMany(targetFilter, {
        $unset: unsetSpec,
      });
      totalModified = result.modifiedCount ?? 0;
      console.log(
        `ROLLBACK complete. matchedCount=${result.matchedCount} modifiedCount=${totalModified}`,
      );
    } else {
      // Apply: per-cohort updateMany, each scoped to the target filter +
      // tenantType discriminator.
      const saasFilter = {
        $and: [targetFilter, { tenantType: "SAAS_HRMS" }],
      };
      const travelFilter = {
        $and: [targetFilter, { tenantType: { $ne: "SAAS_HRMS" } }],
      };

      const saasSet: Record<string, boolean> = {};
      for (const flag of NEW_FLAGS) {
        saasSet[`config.features.${flag}`] = SAAS_HRMS_FLAGS[flag];
      }
      const travelSet: Record<string, boolean> = {};
      for (const flag of NEW_FLAGS) {
        travelSet[`config.features.${flag}`] = TRAVEL_CUSTOMER_FLAGS[flag];
      }

      const saasResult = await CustomerWorkspace.updateMany(saasFilter, {
        $set: saasSet,
      });
      console.log(
        `APPLY (SaaS HRMS): matchedCount=${saasResult.matchedCount} modifiedCount=${saasResult.modifiedCount}`,
      );

      const travelResult = await CustomerWorkspace.updateMany(travelFilter, {
        $set: travelSet,
      });
      console.log(
        `APPLY (Travel CRM):   matchedCount=${travelResult.matchedCount} modifiedCount=${travelResult.modifiedCount}`,
      );

      totalModified = (saasResult.modifiedCount ?? 0) + (travelResult.modifiedCount ?? 0);
      console.log("");
      console.log(`Total documents modified: ${totalModified}`);
    }

    // ── Verification pass ──
    console.log("");
    console.log("Verification:");
    console.log("─".repeat(80));

    // 1. Spot-check each workspace in the candidate set
    for (const p of plans) {
      const after = await CustomerWorkspace.findById(p._id)
        .select("_id companyName tenantType config.features")
        .lean();
      if (!after) {
        console.warn(`  [VERIFY] ${p.companyName}: not found after migration.`);
        continue;
      }
      const features = (after as any).config?.features ?? {};
      const summary = NEW_FLAGS.map((flag) => {
        const val = features[flag];
        return `${flag}=${ROLLBACK ? (val === undefined ? "absent" : String(val)) : String(val)}`;
      }).join(" ");
      console.log(`  [${p.cohort}] ${p.companyName}: ${summary}`);
    }

    // 2. Verify Plumtrips workspace flags are UNCHANGED
    const plumtripsAfter = await CustomerWorkspace.findById(PLUMTRIPS_WORKSPACE_ID)
      .select("_id companyName tenantType config.features")
      .lean();
    if (!plumtripsAfter) {
      console.warn("  [VERIFY] Plumtrips HOUSE workspace not found after run.");
    } else {
      const before = (plumtripsRaw as any)?.config?.features ?? {};
      const after = (plumtripsAfter as any).config?.features ?? {};
      const drift = NEW_FLAGS.filter((f) => before[f] !== after[f]);
      if (drift.length > 0) {
        console.error(
          `  [VERIFY] FATAL: Plumtrips workspace flags drifted on fields: ${drift.join(", ")}`,
        );
        process.exit(1);
      }
      console.log(
        `  [VERIFY] Plumtrips HOUSE workspace flags UNCHANGED — confirmed safe.`,
      );
    }

    console.log("─".repeat(80));
    console.log("");
    console.log("Migration completed successfully.");
  } finally {
    await mongoose.connection.close();
  }
}

main().catch(async (err) => {
  console.error("Migration failed:", err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
