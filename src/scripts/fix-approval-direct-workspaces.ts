/**
 * One-off: fix all APPROVAL_DIRECT workspaces that have
 * approvalFlowEnabled: false (the bug from FLOW_TO_FEATURES mapping).
 *
 * Usage: pnpm -C apps/backend tsx src/scripts/fix-approval-direct-workspaces.ts
 */
import "../config/db.js";
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

async function main() {
  await mongoose.connection.asPromise();

  // Fix the specific known workspace
  const target = await CustomerWorkspace.findOneAndUpdate(
    { customerId: new mongoose.Types.ObjectId("69661b3ce82304bcddacd885") },
    {
      $set: {
        "config.features.approvalFlowEnabled": true,
        "config.travelFlow": "APPROVAL_DIRECT",
      },
    },
    { new: true },
  );
  if (target) {
    console.log("Fixed target workspace:", target._id, target.config?.features);
  } else {
    console.log("Target workspace not found (customerId 69661b3ce82304bcddacd885)");
  }

  // Fix any other APPROVAL_DIRECT workspaces with the same bug
  const result = await CustomerWorkspace.updateMany(
    {
      "config.travelFlow": "APPROVAL_DIRECT",
      "config.features.approvalFlowEnabled": { $ne: true },
    },
    { $set: { "config.features.approvalFlowEnabled": true } },
  );
  console.log("Additional APPROVAL_DIRECT workspaces fixed:", result.modifiedCount);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
