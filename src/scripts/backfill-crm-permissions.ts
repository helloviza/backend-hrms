import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { UserPermission } from "../models/UserPermission.js";

async function main() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(env.MONGO_URI);
  console.log("Connected.\n");

  const docs = await UserPermission.find({}).lean();
  console.log(`Total UserPermission docs: ${docs.length}\n`);

  let countFullAll = 0;
  let countFullWs = 0;
  let countSkipped = 0;

  for (const doc of docs) {
    const modules = (doc.modules as any) || {};

    const contactsAccess = modules?.crmContacts?.access ?? "NONE";
    const companiesAccess = modules?.crmCompanies?.access ?? "NONE";
    const leadsAccess = modules?.leads?.access ?? "NONE";

    // Idempotent: skip if all three are already explicitly set beyond NONE
    if (
      contactsAccess !== "NONE" &&
      companiesAccess !== "NONE" &&
      leadsAccess !== "NONE"
    ) {
      countSkipped++;
      continue;
    }

    const allEntries = Object.values(modules) as Array<{ access?: string; scope?: string }>;

    const hasFullAll = allEntries.some(
      (m) => m?.access === "FULL" && m?.scope === "ALL"
    );
    const hasFullWs = allEntries.some(
      (m) => m?.access === "FULL" && m?.scope === "WORKSPACE"
    );

    if (hasFullAll) {
      const updates: Record<string, any> = {};
      if (contactsAccess === "NONE") updates["modules.crmContacts"] = { access: "FULL", scope: "ALL" };
      if (companiesAccess === "NONE") updates["modules.crmCompanies"] = { access: "FULL", scope: "ALL" };
      if (leadsAccess === "NONE") updates["modules.leads"] = { access: "FULL", scope: "ALL" };
      await UserPermission.updateOne({ _id: doc._id }, { $set: updates });
      countFullAll++;
    } else if (hasFullWs) {
      const updates: Record<string, any> = {};
      if (contactsAccess === "NONE") updates["modules.crmContacts"] = { access: "FULL", scope: "WORKSPACE" };
      if (companiesAccess === "NONE") updates["modules.crmCompanies"] = { access: "FULL", scope: "WORKSPACE" };
      if (leadsAccess === "NONE") updates["modules.leads"] = { access: "FULL", scope: "WORKSPACE" };
      await UserPermission.updateOne({ _id: doc._id }, { $set: updates });
      countFullWs++;
    } else {
      countSkipped++;
    }
  }

  console.log("Backfill complete:");
  console.log(`  Set FULL/ALL       : ${countFullAll}`);
  console.log(`  Set FULL/WORKSPACE : ${countFullWs}`);
  console.log(`  Left as NONE/skip  : ${countSkipped}`);

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
