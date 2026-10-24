// apps/backend/src/scripts/migrate-partner-lead-indexes.ts
//
// The indexes partner lead links rely on. All of them are partial on fields
// no existing document has (or, for the manual-booking one, purely additive),
// so building them changes nothing for existing requests and bookings:
//
//   approvalrequests
//     partner_lead_intake_ref   unique  meta.partnerLead.intakeRef   — one case per
//                                        submission, also under a concurrent double submit
//     partner_lead_case_number  unique  meta.partnerLead.caseNumber  — the student's PL- number
//     partner_lead_workspace            workspaceId + meta.source + createdAt — the tracker list
//   manualbookings
//     workspace_source_booking          workspaceId + sourceBookingId — a case's bookings
//   partnerlinks
//     code_1                    unique  code
//
// Built here rather than by autoIndex, so a deploy never builds them by
// surprise. Idempotent: an index that already exists is left alone.
//
// DRY RUN by default (lists what is missing, writes nothing). Pass --apply to build.
//
//   npx tsx src/scripts/migrate-partner-lead-indexes.ts --expect-db=<db> [--apply]
import "dotenv/config";
import mongoose from "mongoose";

type Spec = { collection: string; name: string; key: Record<string, 1 | -1>; unique?: boolean; partialFilterExpression?: any };

export const PARTNER_LEAD_INDEXES: Spec[] = [
  {
    collection: "approvalrequests",
    name: "partner_lead_intake_ref",
    key: { "meta.partnerLead.intakeRef": 1 },
    unique: true,
    partialFilterExpression: { "meta.partnerLead.intakeRef": { $exists: true } },
  },
  {
    collection: "approvalrequests",
    name: "partner_lead_case_number",
    key: { "meta.partnerLead.caseNumber": 1 },
    unique: true,
    partialFilterExpression: { "meta.partnerLead.caseNumber": { $exists: true } },
  },
  {
    collection: "approvalrequests",
    name: "partner_lead_workspace",
    key: { workspaceId: 1, "meta.source": 1, createdAt: -1 },
    partialFilterExpression: { "meta.source": { $exists: true } },
  },
  {
    collection: "manualbookings",
    name: "workspace_source_booking",
    key: { workspaceId: 1, sourceBookingId: 1 },
    partialFilterExpression: { sourceBookingId: { $exists: true } },
  },
  { collection: "partnerlinks", name: "code_1", key: { code: 1 }, unique: true },
];

export type IndexReport = { db: string; apply: boolean; present: string[]; missing: string[]; created: string[] };

export async function migratePartnerLeadIndexes(opts: {
  expectDb?: string;
  apply: boolean;
  log?: (line: string) => void;
}): Promise<IndexReport> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  log(`db ${db} · ${opts.apply ? "APPLY" : "DRY RUN"}`);

  const report: IndexReport = { db, apply: opts.apply, present: [], missing: [], created: [] };
  for (const spec of PARTNER_LEAD_INDEXES) {
    const label = `${spec.collection}.${spec.name}`;
    const existing = await mongoose.connection
      .collection(spec.collection)
      .indexes()
      .catch(() => [] as any[]); // collection not created yet
    if (existing.some((i: any) => i.name === spec.name)) {
      report.present.push(label);
      log(`  present  ${label}`);
      continue;
    }
    report.missing.push(label);
    if (!opts.apply) {
      log(`  missing  ${label}`);
      continue;
    }
    await mongoose.connection.collection(spec.collection).createIndex(spec.key, {
      name: spec.name,
      ...(spec.unique ? { unique: true } : {}),
      ...(spec.partialFilterExpression ? { partialFilterExpression: spec.partialFilterExpression } : {}),
    });
    report.created.push(label);
    log(`  created  ${label}`);
  }
  if (!opts.apply) log(report.missing.length ? "Dry run — nothing written. Re-run with --apply to build." : "Nothing to do.");
  return report;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
    await migratePartnerLeadIndexes({ expectDb, apply: process.argv.includes("--apply") });
  } finally {
    await mongoose.disconnect();
  }
}

// Run only when executed directly — importing it (the tests) must not connect.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/migrate-partner-lead-indexes.ts");
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
