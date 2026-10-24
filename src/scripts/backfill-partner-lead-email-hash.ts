// apps/backend/src/scripts/backfill-partner-lead-email-hash.ts
//
// Stamps meta.partnerLead.contactEmailHash on partner lead cases created
// before the field existed, so "Track my case" finds them on the
// partner_lead_contact_email_hash index instead of the slow fallback
// (services/partnerTrack.ts). Also builds that index if it is missing.
//
// The hash is the same salted hash the intake writes (services/
// partnerTrackHash.ts) — so this must run with the production
// PARTNER_LEAD_IP_SALT, i.e. against the live backend's secrets.
//
// meta.partnerLead is immutable through the model (models/ApprovalRequest.ts
// refuses any update naming it); this one additive field is written through
// the raw collection, only where it is absent, and nothing else is touched.
// Idempotent: a re-run finds nothing to do.
//
// DRY RUN by default (counts, writes nothing). Pass --apply to write.
//
//   npx tsx src/scripts/backfill-partner-lead-email-hash.ts --expect-db=<db> [--apply]
import "dotenv/config";
import mongoose from "mongoose";
import { contactEmailHashOf } from "../services/partnerTrackHash.js";
import { PARTNER_LEAD_INDEXES } from "./migrate-partner-lead-indexes.js";

const INDEX = PARTNER_LEAD_INDEXES.find((i) => i.name === "partner_lead_contact_email_hash")!;

export type BackfillReport = {
  db: string;
  apply: boolean;
  index: "present" | "missing" | "created";
  missingHash: number;
  noEmail: number;
  updated: number;
};

export async function backfillPartnerLeadEmailHash(opts: {
  expectDb?: string;
  apply: boolean;
  log?: (line: string) => void;
}): Promise<BackfillReport> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  if (!process.env.PARTNER_LEAD_IP_SALT) throw new Error("REFUSING: PARTNER_LEAD_IP_SALT is not set — the hashes would not match the live backend's.");
  log(`db ${db} · ${opts.apply ? "APPLY" : "DRY RUN"}`);

  const col = mongoose.connection.collection("approvalrequests");
  const report: BackfillReport = { db, apply: opts.apply, index: "present", missingHash: 0, noEmail: 0, updated: 0 };

  const existing = await col.indexes().catch(() => [] as any[]);
  if (!existing.some((i: any) => i.name === INDEX.name)) {
    report.index = "missing";
    if (opts.apply) {
      await col.createIndex(INDEX.key, { name: INDEX.name, partialFilterExpression: INDEX.partialFilterExpression });
      report.index = "created";
    }
  }
  log(`  index ${INDEX.name}: ${report.index}`);

  const filter = { "meta.source": "PARTNER_LINK", "meta.partnerLead": { $exists: true }, "meta.partnerLead.contactEmailHash": { $exists: false } };
  const rows = await col.find(filter, { projection: { _id: 1, "meta.partnerLead.contact.email": 1 } }).toArray();
  for (const r of rows) {
    const hash = contactEmailHashOf((r as any).meta?.partnerLead?.contact?.email);
    if (!hash) {
      report.noEmail += 1;
      continue;
    }
    report.missingHash += 1;
    if (!opts.apply) continue;
    const res = await col.updateOne({ _id: r._id, "meta.partnerLead.contactEmailHash": { $exists: false } }, { $set: { "meta.partnerLead.contactEmailHash": hash } });
    report.updated += res.modifiedCount;
  }
  log(`  partner cases without the hash: ${report.missingHash} (+${report.noEmail} with no contact email, left alone)`);
  if (opts.apply) log(`  updated: ${report.updated}`);
  else log(report.missingHash || report.index === "missing" ? "Dry run — nothing written. Re-run with --apply." : "Nothing to do.");
  return report;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
    await backfillPartnerLeadEmailHash({ expectDb, apply: process.argv.includes("--apply") });
  } finally {
    await mongoose.disconnect();
  }
}

// Run only when executed directly — importing it (the tests) must not connect.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/backfill-partner-lead-email-hash.ts");
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
