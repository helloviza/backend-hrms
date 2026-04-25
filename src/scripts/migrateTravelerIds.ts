// apps/backend/src/scripts/migrateTravelerIds.ts
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), ".env") });
if (!process.env.MONGO_URI && !process.env.MONGODB_URI) {
  config({ path: resolve(process.cwd(), "apps/backend/.env") });
}

import mongoose from "mongoose";
import CustomerMember from "../models/CustomerMember.js";
import Customer from "../models/Customer.js";
import { deriveWorkspaceCode } from "../utils/travelerId.js";

async function migrate() {
  const mongoUri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.DATABASE_URL;

  if (!mongoUri) {
    console.error("No MongoDB URI found in environment.");
    console.error("Checked: MONGODB_URI, MONGO_URI, DATABASE_URL");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to DB");

  const customerIds = await CustomerMember.distinct("customerId");
  console.log(`Found ${customerIds.length} workspaces`);

  let totalAssigned = 0;

  for (const customerId of customerIds) {
    // Skip slug-based customerIds (SaaS HRMS tenants) — valid ObjectIds are 24-char hex
    if (!/^[a-f\d]{24}$/i.test(String(customerId))) {
      console.log(`Skipping non-ObjectId customerId: ${customerId}`);
      continue;
    }

    const customer = await Customer.findById(customerId)
      .select("legalName name workspaceCode")
      .lean() as any;

    const companyName = customer?.legalName || customer?.name || "PLUM";
    const code = deriveWorkspaceCode(companyName, customer?.workspaceCode);

    const members = await CustomerMember.find({ customerId })
      .sort({ createdAt: 1 })
      .select("_id travelerId email")
      .lean() as any[];

    const ops: any[] = [];
    let counter = 1;

    // Find the max existing counter to continue sequence
    for (const m of members) {
      if (m.travelerId) {
        const parts = (m.travelerId as string).split("-");
        const num = parseInt(parts[parts.length - 1] || "0", 10);
        if (!isNaN(num) && num >= counter) counter = num + 1;
      }
    }

    // Assign to members that don't have a travelerId yet
    for (const m of members) {
      if (m.travelerId) continue;
      const padded = counter < 1000 ? String(counter).padStart(3, "0") : String(counter);
      ops.push({
        updateOne: {
          filter: { _id: m._id },
          update: { $set: { travelerId: `${code}-${padded}` } },
        },
      });
      counter++;
    }

    if (ops.length > 0) {
      await CustomerMember.bulkWrite(ops, { ordered: false });
      totalAssigned += ops.length;
      console.log(`  ${companyName} (${code}): assigned ${ops.length} IDs`);
    }
  }

  console.log(`Migration complete — ${totalAssigned} traveler IDs assigned`);
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
