// apps/backend/src/scripts/migrate-expense-policy-thresholds-2026-09-16.ts
//
// ONE-TIME, DELIVERED NOT RUN: move the three retired expense settings off
// CustomerWorkspace.config into the per-workspace ExpenseApprovalPolicy
// document (approval-engine sub-step 4):
//
//   config.expenseEscalationThreshold  → policy.legacyEscalation.claimThresholdBase
//   config.advanceEscalationThreshold  → policy.legacyEscalation.advanceThresholdBase
//   config.seniorApproverId            → policy.legacyEscalation.seniorApproverId
//
//   pnpm -C apps/backend tsx src/scripts/migrate-expense-policy-thresholds-2026-09-16.ts
//   pnpm -C apps/backend tsx src/scripts/migrate-expense-policy-thresholds-2026-09-16.ts --apply
//
// DRY RUN BY DEFAULT. With --apply it upserts the policy (only the legacy
// block; every other rule stays at its OFF default) and $unsets the three
// fields from config so no second copy lingers. Reads the RAW collection
// because the schema no longer declares the fields (Mongoose would strip
// them). The audit found all three null on every prod workspace, so the
// expected listing is "nothing to move" — this exists so that fact is
// verified, not assumed. Idempotent.

import "../bootstrap/loadSecrets.js";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import { updatePolicy, getPolicy } from "../services/expensePolicy.service.js";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  await mongoose.connect(env.MONGO_URI);
  console.log(`[migrate-policy-thresholds] ${APPLY ? "APPLY" : "DRY RUN"} — db: ${mongoose.connection.name}`);

  const raw = await CustomerWorkspace.collection
    .find(
      {
        $or: [
          { "config.expenseEscalationThreshold": { $exists: true } },
          { "config.advanceEscalationThreshold": { $exists: true } },
          { "config.seniorApproverId": { $exists: true } },
        ],
      },
      { projection: { name: 1, "config.expenseEscalationThreshold": 1, "config.advanceEscalationThreshold": 1, "config.seniorApproverId": 1 } },
    )
    .toArray();

  console.log(`\n${raw.length} workspace(s) still carry one of the retired fields:`);
  let moves = 0;
  let unsetsOnly = 0;
  for (const w of raw) {
    const c: any = (w as any).config || {};
    const claim = c.expenseEscalationThreshold ?? null;
    const adv = c.advanceEscalationThreshold ?? null;
    const senior = c.seniorApproverId ?? null;
    const hasValue = claim != null || adv != null || senior != null;
    let seniorNote = "";
    if (senior) {
      const u: any = await User.findOne({ _id: senior, workspaceId: w._id }).select("email").lean();
      seniorNote = u ? ` (${u.email})` : " (!! not a user of this workspace — will be dropped)";
    }
    const existing = await getPolicy(w._id);
    console.log(
      `  - ${(w as any).name || w._id}: claimThreshold=${claim ?? "null"} advanceThreshold=${adv ?? "null"} seniorApproverId=${senior ?? "null"}${seniorNote}` +
        (hasValue
          ? `\n      → policy.legacyEscalation { claimThresholdBase: ${claim ?? "null"}, advanceThresholdBase: ${adv ?? "null"}, seniorApproverId: ${senior ?? "null"} }` +
            `${existing.exists ? " (policy exists, v" + existing.version + ")" : " (creates the policy doc)"}` +
            ` · then $unset the three config fields`
          : `\n      → all null: nothing to move, $unset the three (now-undeclared) config fields`),
    );
    if (hasValue) moves++;
    else unsetsOnly++;

    if (APPLY) {
      if (hasValue) {
        const seniorOk = senior ? await User.exists({ _id: senior, workspaceId: w._id }) : null;
        await updatePolicy({
          workspaceId: w._id,
          actorId: null,
          patch: {
            legacyEscalation: {
              claimThresholdBase: claim,
              advanceThresholdBase: adv,
              seniorApproverId: seniorOk ? String(senior) : null,
            },
          },
        });
      }
      await CustomerWorkspace.collection.updateOne(
        { _id: w._id },
        { $unset: { "config.expenseEscalationThreshold": "", "config.advanceEscalationThreshold": "", "config.seniorApproverId": "" } },
      );
    }
  }
  console.log(`\n${APPLY ? "MOVED" : "WOULD MOVE"} ${moves} workspace(s) with real values · ${unsetsOnly} with only nulls to clean up.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[migrate-policy-thresholds] failed:", err?.message || err);
  process.exit(1);
});
