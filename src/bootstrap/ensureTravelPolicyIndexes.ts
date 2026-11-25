// apps/backend/src/bootstrap/ensureTravelPolicyIndexes.ts
//
// Boot step for the Travel Policy collections. Same reason as
// ensurePlutoIndexes / ensureInvoiceReissueIndexes: Mongoose autoIndex is on
// but async and unawaited, and two of these indexes carry correctness —
// "one draft per workspace" and "versionNumber unique per workspace" on
// travelpolicyversions. Building them (and the collections) before traffic
// also means the publish transaction never has to create a collection.
// Idempotent, never drops an index, log-and-continue.
import TravelPolicyVersion from "../models/TravelPolicyVersion.js";
import TravelPolicyCity from "../models/TravelPolicyCity.js";
import TravelPolicyTierAssignment from "../models/TravelPolicyTierAssignment.js";
import TravelPolicyAudit from "../models/TravelPolicyAudit.js";

/**
 * Cities created before cityKey existed get their current name key, which is
 * what the CITY rules written back then already store. Idempotent; must run
 * before the unique {workspaceId, cityKey} index is built.
 */
export async function backfillCityKeys(): Promise<number> {
  const coll = TravelPolicyCity.collection;
  const rows = await coll.find({ cityKey: { $exists: false } }).sort({ createdAt: 1, _id: 1 }).toArray();
  for (const r of rows) {
    let key = String(r.nameKey);
    for (let n = 2; await coll.findOne({ workspaceId: r.workspaceId, cityKey: key }); n++) key = `${r.nameKey} ${n}`;
    await coll.updateOne({ _id: r._id, cityKey: { $exists: false } }, { $set: { cityKey: key } });
  }
  return rows.length;
}

const MODELS: Array<[string, any]> = [
  ["TravelPolicyVersion", TravelPolicyVersion],
  ["TravelPolicyCity", TravelPolicyCity],
  ["TravelPolicyTierAssignment", TravelPolicyTierAssignment],
  ["TravelPolicyAudit", TravelPolicyAudit],
];

export async function ensureTravelPolicyIndexes(log: Pick<Console, "warn" | "log"> = console): Promise<string[]> {
  const failed: string[] = [];
  for (const [name, model] of MODELS) {
    try {
      await model.createCollection().catch((e: any) => {
        if (e?.code !== 48) throw e; // 48 = NamespaceExists
      });
      if (name === "TravelPolicyCity") await backfillCityKeys();
      await model.createIndexes();
    } catch (e: any) {
      failed.push(name);
      log.warn(`[TRAVEL POLICY INDEXES] ✖ ${name}: ${e?.message || e}`);
    }
  }
  if (!failed.length) log.log("[TRAVEL POLICY INDEXES] ✓ ensured");
  return failed;
}
