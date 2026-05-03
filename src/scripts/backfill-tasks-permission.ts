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
  let countWriteOwn = 0;
  let countSkipped = 0;

  for (const doc of docs) {
    const modules = (doc.modules as any) || {};
    const current = modules?.tasks?.access ?? "NONE";

    // Idempotent: skip if already explicitly set
    if (current !== "NONE") {
      countSkipped++;
      continue;
    }

    const allEntries = Object.values(modules) as Array<{ access?: string; scope?: string }>;

    const hasFullAll = allEntries.some((m) => m?.access === "FULL" && m?.scope === "ALL");
    const hasFullWs = allEntries.some((m) => m?.access === "FULL" && (m?.scope === "WORKSPACE" || m?.scope === "ALL"));
    const hasWrite = allEntries.some((m) => m?.access === "WRITE" || m?.access === "FULL");

    if (hasFullAll) {
      await UserPermission.updateOne(
        { _id: doc._id },
        { $set: { "modules.tasks": { access: "FULL", scope: "ALL" } } }
      );
      countFullAll++;
    } else if (hasFullWs) {
      await UserPermission.updateOne(
        { _id: doc._id },
        { $set: { "modules.tasks": { access: "FULL", scope: "WORKSPACE" } } }
      );
      countFullWs++;
    } else if (hasWrite) {
      await UserPermission.updateOne(
        { _id: doc._id },
        { $set: { "modules.tasks": { access: "WRITE", scope: "OWN" } } }
      );
      countWriteOwn++;
    } else {
      countSkipped++;
    }
  }

  console.log("Backfill complete:");
  console.log(`  Set FULL/ALL       : ${countFullAll}`);
  console.log(`  Set FULL/WORKSPACE : ${countFullWs}`);
  console.log(`  Set WRITE/OWN      : ${countWriteOwn}`);
  console.log(`  Left as NONE/skip  : ${countSkipped}`);

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
