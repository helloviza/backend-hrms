// apps/backend/src/scripts/plumconnect-permission-lines-migrate.ts
//
// PlumConnect Slice 7 — fold the Slice 4b single `modules.plumconnect`
// grant into the four per-line keys (plumconnectPlumtrips / Helloviza /
// Concierge / Support) and drop the legacy key.
//
// Expected prod state: NOTHING to do. The 4b key shipped dark (flag off,
// NONE in every level template, granted per-user only) and no pilot grant
// was ever issued — so the dry run should print "legacy grants: 0" and
// VERDICT: CLEAN. If it does not, this script is the migration: a legacy
// {access, scope} is copied verbatim onto ALL FOUR lines (the 4b grant
// meant "the whole inbox", and the least surprising translation keeps that
// reach; an admin narrows it per line in AccessConsole afterwards), then
// the legacy key is $unset. A legacy NONE/NONE row is just $unset. Per-line
// keys that are ALREADY set (non-NONE) are never overwritten.
//
// Idempotent: a second run finds no legacy key. Reads and writes the raw
// collection (no model import → no autoIndex side effect). Always exits 0.
//   VERDICT: CLEAN | PENDING (dry run found rows) | MIGRATED | FAILED
//
// --dry-run   prints what WOULD change and writes nothing (DEFAULT).
// --apply     performs the writes.
//
// Usage:  pnpm -C apps/backend exec tsx src/scripts/plumconnect-permission-lines-migrate.ts [--apply]

import mongoose from "mongoose";
import { connectDb } from "../config/db.js";

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const COLLECTION = "userpermissions";
const APPLY = process.argv.includes("--apply");
const LEGACY_KEY = "plumconnect";
const LINE_KEYS = ["plumconnectPlumtrips", "plumconnectHelloviza", "plumconnectConcierge", "plumconnectSupport"] as const;

type Verdict = "CLEAN" | "PENDING" | "MIGRATED" | "FAILED";

async function main() {
  let verdict: Verdict = "FAILED";
  try {
    await connectDb();
    const col = mongoose.connection.db!.collection(COLLECTION);
    console.log(`db=${mongoose.connection.name}  collection=${col.collectionName}  mode=${APPLY ? "APPLY" : "dry-run"}  at=${new Date().toISOString()}`);

    const rows = await col
      .find({ [`modules.${LEGACY_KEY}`]: { $exists: true } }, { projection: { email: 1, userId: 1, workspaceId: 1, modules: 1 } })
      .toArray();
    const granted = rows.filter((r: any) => String(r.modules?.[LEGACY_KEY]?.access || "NONE") !== "NONE");
    console.log(`rows carrying the legacy key: ${rows.length}   legacy grants (access != NONE): ${granted.length}`);

    for (const r of rows as any[]) {
      const legacy = r.modules[LEGACY_KEY];
      const $set: Record<string, unknown> = {};
      if (String(legacy?.access || "NONE") !== "NONE") {
        for (const k of LINE_KEYS) {
          const cur = r.modules?.[k];
          if (!cur || String(cur.access || "NONE") === "NONE") $set[`modules.${k}`] = { access: legacy.access, scope: legacy.scope || "NONE" };
        }
      }
      console.log(`  ${r.email}  userId=${r.userId}  legacy=${JSON.stringify(legacy)}  → set ${JSON.stringify($set)}  unset modules.${LEGACY_KEY}`);
      if (APPLY) {
        await col.updateOne({ _id: r._id }, { ...(Object.keys($set).length ? { $set } : {}), $unset: { [`modules.${LEGACY_KEY}`]: "" } });
      }
    }

    verdict = rows.length === 0 ? "CLEAN" : APPLY ? "MIGRATED" : "PENDING";
    if (rows.length > 0 && !APPLY) console.log(`(dry-run) would rewrite ${rows.length} row(s); re-run with --apply`);
  } catch (err) {
    console.error("FAILED:", err);
    verdict = "FAILED";
  } finally {
    console.log(`VERDICT: ${verdict}${APPLY ? "" : "  (dry run)"}`);
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
}

void main();
