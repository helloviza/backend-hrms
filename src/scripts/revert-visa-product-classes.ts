// apps/backend/src/scripts/revert-visa-product-classes.ts
//
// The undo for retype-visa-product-classes.ts.
//
// Reads that script's audit file and restores `oldProductClass` on every
// _id it lists. The audit file is written in dry-run mode too, so the undo
// manifest exists BEFORE the forward migration is ever applied — the revert
// is never something that has to be reconstructed after the fact.
//
// Same guarantees as the forward script: writes productClass and nothing
// else, via updateOne so no document middleware fires (a .save() would
// recompute displayMode — see the forward script's header).
//
// ── USAGE ─────────────────────────────────────────────────────────────
//   Dry run:
//     tsx src/scripts/revert-visa-product-classes.ts \
//       --db="mongodb://127.0.0.1:27017/plumbox_dev" --audit=retype-audit-<stamp>.json
//   Apply:
//     ... --apply            (add --confirm-prod for a non-loopback target)
import mongoose from "mongoose";
import fs from "node:fs";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const DB = arg("db");
const AUDIT = arg("audit");
const APPLY = has("apply");
const CONFIRM_PROD = has("confirm-prod");

if (!DB || !AUDIT) {
  console.error("Refusing to run: both --db=<uri> and --audit=<file> are required.");
  process.exit(1);
}
const isLoopback = /^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(DB);
if (APPLY && !isLoopback && !CONFIRM_PROD) {
  console.error("Refusing to APPLY against a non-loopback database without --confirm-prod.");
  process.exit(1);
}

interface Change {
  _id: string;
  iso2: string;
  variantKey: string | null;
  oldProductClass: string;
  newProductClass: string;
}

async function main() {
  const audit = JSON.parse(fs.readFileSync(AUDIT!, "utf8")) as { changes: Change[]; generatedAt?: string };
  const changes = audit.changes ?? [];

  console.log(`mode       : ${APPLY ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
  console.log(`target     : ${isLoopback ? "local (loopback)" : "REMOTE"}`);
  console.log(`audit      : ${AUDIT}  (generated ${audit.generatedAt ?? "unknown"})`);
  console.log(`rows listed: ${changes.length}\n`);

  await mongoose.connect(DB!, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.collection("visarules");

  // Report the CURRENT state so a revert against a database that was never
  // migrated (or was already reverted) is visible as a no-op rather than
  // reported as success.
  let toRestore = 0;
  let alreadyOld = 0;
  let unexpected = 0;
  for (const c of changes) {
    const doc: any = await col.findOne(
      { _id: new mongoose.Types.ObjectId(c._id) },
      { projection: { productClass: 1 } },
    );
    if (!doc) { unexpected++; continue; }
    if (doc.productClass === c.newProductClass) toRestore++;
    else if (doc.productClass === c.oldProductClass) alreadyOld++;
    else unexpected++;
  }
  console.log(`currently at the NEW class (will restore): ${toRestore}`);
  console.log(`already at the OLD class (no-op)         : ${alreadyOld}`);
  console.log(`missing or at an unexpected class        : ${unexpected}`);

  if (!APPLY) {
    console.log("\nDRY RUN — no database writes were performed.");
    return;
  }

  let written = 0;
  for (const c of changes) {
    const res = await col.updateOne(
      { _id: new mongoose.Types.ObjectId(c._id) },
      { $set: { productClass: c.oldProductClass } },
    );
    written += res.modifiedCount;
  }
  console.log(`\nREVERTED — documents modified: ${written} (expected ${toRestore})`);
}

main()
  .catch((err) => {
    console.error("FAILED:", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
    console.log(isLoopback ? "\nLOCAL CONNECTION CLOSED" : "\nPROD CONNECTION CLOSED");
  });
