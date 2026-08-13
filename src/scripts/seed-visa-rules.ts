// apps/backend/src/scripts/seed-visa-rules.ts
//
// Idempotent seed for the Visa module's global reference data: five
// corridors as PUBLISHED VisaRule rows (chosen to exercise the branches
// listed below) plus matching VisaDestinationContent for the same five
// destinations. Safe to re-run — every row is upserted on its natural key,
// never inserted blind, and never deleted.
//
// Fees are PLACEHOLDERS (explicitly requested) — real figures come from the
// fee master later. Destination highlight copy for Germany/UAE/USA is
// reused from the visa-flow design handoff's own country dataset (real
// content, not invented); Cambodia/Nepal highlight copy is LLM-authored
// placeholder text since neither appeared in that dataset — see the SOURCE
// comments on each entry below. All destination content is seeded as
// status: "DRAFT" — none of it is renderable to an applicant until a human
// reviews and publishes it (see VisaDestinationContent.status).
//
// GUARD MODEL — there is no local/dev database; MongoDB Atlas production is
// the only target this ever runs against. A guard keyed on the word "prod"
// appearing in the connection string trains people to bypass it (every real
// run needs the bypass flag), not to respect it. The guards below protect
// against the REAL risk instead — writing the wrong thing — regardless of
// which database is connected:
//   1. assertModelScope()  — only VisaRule/VisaDestinationContent may be
//      registered with mongoose when this runs. Importing (and therefore
//      being able to write to) any other model aborts loudly.
//   2. assertNoDeleteCalls() — reads this file's own source and refuses to
//      run if any delete/drop-shaped method call appears in it. Upsert-only,
//      enforced structurally, not just by convention.
//   3. planWrites() + printPlan() — every write is counted (create vs
//      update, per collection) against the live database BEFORE anything is
//      written, and printed alongside the target host/database name.
//   4. confirmDatabaseName() — the operator must type the exact database
//      name to proceed (or pass --yes for non-interactive runs).
// Every row this script writes is stamped with SEED_SOURCE (see
// models/VisaRule.ts / VisaDestinationContent.ts's `seedSource` field) so
// scripts/purge-visa-seed.ts can find and remove exactly these rows later
// without touching real pricing that lands in the same collection.
//
// Run: pnpm -C apps/backend tsx src/scripts/seed-visa-rules.ts [--yes]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline/promises";
import { stdin as rlInput, stdout as rlOutput } from "node:process";
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import { env } from "../config/env.js";
import VisaRule, { type VisaRuleDocument } from "../models/VisaRule.js";
import VisaDestinationContent from "../models/VisaDestinationContent.js";

const SEED_SOURCE = "seed-visa-rules@2026-07";

type RuleKey = Pick<
  VisaRuleDocument,
  "nationality" | "destinationIso2" | "purpose" | "entryType" | "serviceTier"
>;
type RuleFields = Partial<VisaRuleDocument>;

type PlannedContentFields = {
  businessBlock: { highlights: string[] };
  tourismBlock: { highlights: string[] };
  entrySnapshot: { visaRequired: boolean; headline: string; summary: string };
};

/* ─────────────────────────────────────────────────────────────────────
 * Guard 1 — model scope. Only these two models may ever be registered
 * with mongoose while this script runs. A model becomes "registered" the
 * moment its file is imported (mongoose.model(...) runs at module load,
 * not at write time) — so this catches "imported" directly, and nothing
 * can be written to a model that was never imported, so it covers
 * "written" too for the normal Model-method write path.
 * ───────────────────────────────────────────────────────────────────── */
const ALLOWED_MODELS = ["VisaRule", "VisaDestinationContent"];

function assertModelScope(): void {
  const registered = mongoose.modelNames();
  const unexpected = registered.filter((name) => !ALLOWED_MODELS.includes(name));
  if (unexpected.length > 0) {
    console.error(
      `Refusing to run: this script may only write ${ALLOWED_MODELS.join(" and ")}, but ` +
        `additional model(s) are registered: ${unexpected.join(", ")}.\n` +
        `If this script genuinely needs to touch another model now, that's a deliberate scope ` +
        `change — update ALLOWED_MODELS to say so explicitly, don't just silence this.`,
    );
    process.exit(1);
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Guard 2 — no deletes, enforced structurally. Reads this file's own
 * source and refuses to run if any delete/drop-shaped call appears
 * anywhere in it. The patterns below require a leading "." and a
 * trailing "(" around the method name, so this check does not trip over
 * its own prose (e.g. this comment block, or the header's "never
 * deleted") — only an actual method-call shape matches.
 * ───────────────────────────────────────────────────────────────────── */
const FORBIDDEN_WRITE_CALL = /\.(deleteMany|deleteOne|findOneAndDelete|remove|drop|dropCollection|dropDatabase)\s*\(/;

function assertNoDeleteCalls(): void {
  const selfPath = fileURLToPath(import.meta.url);
  const source = readFileSync(selfPath, "utf8");
  const match = source.match(FORBIDDEN_WRITE_CALL);
  if (match) {
    console.error(
      `Refusing to run: this seed script must be upsert-only, but its own source contains a ` +
        `delete/drop-shaped call ("${match[0]}"). Remove it — this script must never delete.`,
    );
    process.exit(1);
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Target info — printed before anything is written, and before the
 * confirmation prompt. Credentials in the URI are masked.
 * ───────────────────────────────────────────────────────────────────── */
function targetInfo(): { host: string; db: string } {
  const url = new URL(env.MONGO_URI);
  const host = url.hostname;
  const db = url.pathname.replace(/^\//, "") || "(default)";
  return { host, db };
}

/* ─────────────────────────────────────────────────────────────────────
 * Guard 3 — plan before writing. Every planned row is checked against the
 * live database with a read-only findOne (never a write) to classify it
 * as create vs update, so the printed counts are exact, not estimated.
 * ───────────────────────────────────────────────────────────────────── */
async function planRuleCounts(
  planned: { key: RuleKey; fields: RuleFields }[],
): Promise<{ toCreate: number; toUpdate: number }> {
  let toCreate = 0;
  let toUpdate = 0;
  for (const { key } of planned) {
    const existing = await VisaRule.findOne(key).select("_id").lean();
    if (existing) toUpdate++;
    else toCreate++;
  }
  return { toCreate, toUpdate };
}

async function planContentCounts(
  planned: { destinationIso2: string; fields: PlannedContentFields }[],
): Promise<{ toCreate: number; toUpdate: number }> {
  let toCreate = 0;
  let toUpdate = 0;
  for (const { destinationIso2 } of planned) {
    const existing = await VisaDestinationContent.findOne({ destinationIso2 }).select("_id").lean();
    if (existing) toUpdate++;
    else toCreate++;
  }
  return { toCreate, toUpdate };
}

function printPlan(
  target: { host: string; db: string },
  ruleCounts: { toCreate: number; toUpdate: number },
  contentCounts: { toCreate: number; toUpdate: number },
): void {
  console.log("──────────────────────────────────────────────────────");
  console.log(`Target host:       ${target.host}`);
  console.log(`Target database:   ${target.db}`);
  console.log(`Collections written: ${VisaRule.collection.name}, ${VisaDestinationContent.collection.name}`);
  console.log(
    `  ${VisaRule.collection.name}: ${ruleCounts.toCreate} to create, ${ruleCounts.toUpdate} to update`,
  );
  console.log(
    `  ${VisaDestinationContent.collection.name}: ${contentCounts.toCreate} to create, ${contentCounts.toUpdate} to update`,
  );
  console.log(`Every row stamped with seedSource: "${SEED_SOURCE}"`);
  console.log("──────────────────────────────────────────────────────");
}

/* ─────────────────────────────────────────────────────────────────────
 * Guard 4 — interactive confirmation. --yes skips the prompt for
 * non-interactive runs; otherwise the operator must type the exact
 * database name.
 * ───────────────────────────────────────────────────────────────────── */
async function confirmDatabaseName(expectedDb: string): Promise<void> {
  if (process.argv.includes("--yes")) {
    console.log("--yes passed — skipping interactive confirmation.");
    return;
  }
  const rl = readline.createInterface({ input: rlInput, output: rlOutput });
  try {
    const answer = await rl.question(`Type the database name ("${expectedDb}") to proceed: `);
    if (answer.trim() !== expectedDb) {
      console.error("Aborted: input did not match the database name.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Writers — upsert only, always stamped with SEED_SOURCE.
 * ───────────────────────────────────────────────────────────────────── */
let created = 0;
let updated = 0;

async function upsertRule(key: RuleKey, fields: RuleFields): Promise<void> {
  const existing = await VisaRule.findOne(key);
  const stampedFields: RuleFields = { ...fields, seedSource: SEED_SOURCE, lastReviewedAt: new Date() };
  if (existing) {
    Object.assign(existing, stampedFields);
    await existing.save(); // re-runs the displayMode-derivation hook
    updated++;
  } else {
    const doc = new VisaRule({ ...key, ...stampedFields });
    await doc.save();
    created++;
  }
}

async function upsertDestinationContent(
  destinationIso2: string,
  fields: PlannedContentFields,
): Promise<void> {
  await VisaDestinationContent.findOneAndUpdate(
    { destinationIso2 },
    {
      $set: {
        destinationIso2,
        ...fields,
        // Always DRAFT out of this seed — none of this content (including
        // the reused-from-design-handoff Germany/UAE/USA copy) has been
        // through an editorial review pass in THIS pipeline yet, so nothing
        // is renderable to an applicant until a human flips this.
        status: "DRAFT",
        heroImageUrl: "", // placeholder — no real asset yet
        lastReviewedAt: new Date(),
        seedSource: SEED_SOURCE,
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
}

/* ─────────────────────────────────────────────────────────────────────
 * Planned data — five corridors, five destination-content rows. Defined
 * up front (not written inline) so planRuleCounts()/planContentCounts()
 * can classify create-vs-update against the live database before any
 * write happens.
 * ───────────────────────────────────────────────────────────────────── */
const PLANNED_RULES: { key: RuleKey; fields: RuleFields }[] = [];
const PLANNED_CONTENT: { destinationIso2: string; fields: PlannedContentFields }[] = [];

// ── 1. Germany — TOURIST, STICKER, Schengen ────────────────────────────
// Exercises: isSchengen=true, appointmentRequired+biometricsRequired=true,
// fully itemised fee (all three components populated → ITEMISED).
PLANNED_RULES.push({
  key: { nationality: "IN", destinationIso2: "DE", purpose: "TOURIST", entryType: "MULTIPLE", serviceTier: "STANDARD" },
  fields: {
    destinationName: "Germany",
    isSchengen: true,
    productClass: "VISA",
    visaCategory: "STICKER",
    validityDays: 180,
    maxStayDays: 90,
    isExtension: false,
    etaMinDays: 15,
    etaMaxDays: 20,
    etaBasis: "BUSINESS",
    appointmentRequired: true,
    biometricsRequired: true,
    documentRequirements: [
      { docCode: "DOC-01", requirement: "REQUIRED" },
      { docCode: "DOC-02", requirement: "REQUIRED" },
      { docCode: "DOC-03", requirement: "REQUIRED" },
      { docCode: "DOC-04", requirement: "REQUIRED" },
      { docCode: "DOC-05", requirement: "REQUIRED" },
      { docCode: "DOC-08", requirement: "REQUIRED" },
      { docCode: "DOC-07", requirement: "REQUIRED" },
      { docCode: "DOC-09", requirement: "REQUIRED" },
    ],
    embassyFeeInr: 8200,
    vfsFeeInr: 2100,
    plumtripsServiceFeeInr: 1499,
    status: "PUBLISHED",
  } as RuleFields,
});

// ── 2. United Arab Emirates — TOURIST, E_VISA, three service tiers ─────
// Exercises: multiple serviceTier rows for the same corridor, a
// CONDITIONAL document requirement, appointmentRequired/biometricsRequired
// both false.
const uaeShared: RuleFields = {
  destinationName: "United Arab Emirates",
  isSchengen: false,
  productClass: "VISA",
  visaCategory: "E_VISA",
  validityDays: 60,
  maxStayDays: 30,
  isExtension: false,
  etaBasis: "BUSINESS",
  appointmentRequired: false,
  biometricsRequired: false,
  documentRequirements: [
    { docCode: "DOC-01", requirement: "REQUIRED" },
    { docCode: "DOC-02", requirement: "REQUIRED" },
    { docCode: "DOC-03", requirement: "CONDITIONAL", condition: "If requested by immigration on arrival" },
    { docCode: "DOC-08", requirement: "REQUIRED" },
    { docCode: "DOC-07", requirement: "REQUIRED" },
  ],
  embassyFeeInr: 6500,
  vfsFeeInr: 0,
  status: "PUBLISHED",
};
PLANNED_RULES.push({
  key: { nationality: "IN", destinationIso2: "AE", purpose: "TOURIST", entryType: "MULTIPLE", serviceTier: "STANDARD" },
  fields: { ...uaeShared, etaMinDays: 3, etaMaxDays: 5, plumtripsServiceFeeInr: 1499 },
});
PLANNED_RULES.push({
  key: { nationality: "IN", destinationIso2: "AE", purpose: "TOURIST", entryType: "MULTIPLE", serviceTier: "EXPRESS" },
  fields: { ...uaeShared, etaMinDays: 1, etaMaxDays: 2, plumtripsServiceFeeInr: 2499 },
});
PLANNED_RULES.push({
  key: { nationality: "IN", destinationIso2: "AE", purpose: "TOURIST", entryType: "MULTIPLE", serviceTier: "SUPERFAST" },
  fields: { ...uaeShared, etaMinDays: 0, etaMaxDays: 1, plumtripsServiceFeeInr: 3999 },
});

// ── 3. United States — BUSINESS, STAMP, appointment-driven ─────────────
// Exercises: appointmentRequired=true with etaMinDays/etaMaxDays left
// UNSET (processing is interview-slot-dependent, not a fixed day range —
// a deliberately different branch from the four fixed-ETA corridors).
PLANNED_RULES.push({
  key: { nationality: "IN", destinationIso2: "US", purpose: "BUSINESS", entryType: "MULTIPLE", serviceTier: "STANDARD" },
  fields: {
    destinationName: "United States",
    isSchengen: false,
    productClass: "VISA",
    visaCategory: "STAMP",
    validityDays: 3650,
    maxStayDays: 180,
    isExtension: false,
    etaBasis: "CALENDAR",
    appointmentRequired: true,
    biometricsRequired: true,
    documentRequirements: [
      { docCode: "DOC-01", requirement: "REQUIRED" },
      { docCode: "DOC-02", requirement: "REQUIRED" },
      { docCode: "DOC-06", requirement: "REQUIRED" },
      { docCode: "DOC-05", requirement: "REQUIRED" },
      { docCode: "DOC-03", requirement: "REQUIRED" },
      { docCode: "DOC-04", requirement: "CONDITIONAL", condition: "If self-employed or a business owner" },
    ],
    embassyFeeInr: 16500,
    vfsFeeInr: 1900,
    plumtripsServiceFeeInr: 2499,
    status: "PUBLISHED",
  } as RuleFields,
});

// ── 4. Cambodia — TOURIST, E_VISA, simple case ──────────────────────────
// Exercises: entryType SINGLE, minimal document set, no appointment/
// biometrics, no conditional documents.
PLANNED_RULES.push({
  key: { nationality: "IN", destinationIso2: "KH", purpose: "TOURIST", entryType: "SINGLE", serviceTier: "STANDARD" },
  fields: {
    destinationName: "Cambodia",
    isSchengen: false,
    productClass: "VISA",
    visaCategory: "E_VISA",
    validityDays: 90,
    maxStayDays: 30,
    isExtension: false,
    etaMinDays: 3,
    etaMaxDays: 4,
    etaBasis: "BUSINESS",
    appointmentRequired: false,
    biometricsRequired: false,
    documentRequirements: [
      { docCode: "DOC-01", requirement: "REQUIRED" },
      { docCode: "DOC-02", requirement: "REQUIRED" },
      { docCode: "DOC-08", requirement: "REQUIRED" },
    ],
    embassyFeeInr: 3000,
    vfsFeeInr: 0,
    plumtripsServiceFeeInr: 1499,
    status: "PUBLISHED",
  } as RuleFields,
});

// ── 5. Nepal — TOURIST, VISA_FREE, zero-fee path ────────────────────────
// Exercises: no itemised fee fields AND no indicativeVisaCostInr default —
// an explicit 0 (proving the free branch renders, vs. merely absent),
// entryType UNSPECIFIED, and a single-document (ID-only) requirement list.
PLANNED_RULES.push({
  key: { nationality: "IN", destinationIso2: "NP", purpose: "TOURIST", entryType: "UNSPECIFIED", serviceTier: "STANDARD" },
  fields: {
    destinationName: "Nepal",
    isSchengen: false,
    // productClass describes what Plumtrips sells (a visa, of the free
    // kind); visaCategory describes what the traveller needs (VISA_FREE).
    // Nepal is still a VISA product — not a form-filling service.
    productClass: "VISA",
    visaCategory: "VISA_FREE",
    isExtension: false,
    appointmentRequired: false,
    biometricsRequired: false,
    documentRequirements: [{ docCode: "DOC-01", requirement: "REQUIRED" }],
    indicativeVisaCostInr: 0,
    priceNote: "No visa required for Indian passport holders — entry is free of charge.",
    status: "PUBLISHED",
  } as RuleFields,
});

// ── Destination content (same five destinations) ──────────────────────
// SOURCE: Germany/UAE/USA highlight copy is reused verbatim from the
// visa-flow design handoff's country dataset (docs/design/visa-flow).
PLANNED_CONTENT.push({
  destinationIso2: "DE",
  fields: {
    tourismBlock: {
      highlights: [
        "Neuschwanstein Castle",
        "Berlin museums and the Brandenburg Gate",
        "The Black Forest and Rhine valley",
      ],
    },
    businessBlock: {
      highlights: [
        "Hannover Messe and Automechanika",
        "Automotive and machine-tool supply chains",
        "Mittelstand manufacturing partnerships",
      ],
    },
    entrySnapshot: {
      visaRequired: true,
      headline: "Schengen area member",
      summary:
        "Germany participates in the Schengen Agreement — a single Schengen visa covers travel across all member states within its validity.",
    },
  },
});

PLANNED_CONTENT.push({
  destinationIso2: "AE",
  fields: {
    tourismBlock: {
      highlights: [
        "Burj Khalifa and the Dubai Fountain",
        "Desert safari across Al Marmoom",
        "Louvre Abu Dhabi and Sheikh Zayed Mosque",
      ],
    },
    businessBlock: {
      highlights: [
        "Free-zone company setup in DMCC or IFZA",
        "GITEX Global and Gulfood buyer meets",
        "Re-export gateway to the wider GCC",
      ],
    },
    entrySnapshot: {
      visaRequired: true,
      headline: "e-Visa by email",
      summary:
        "An electronic visa is issued by email as a PDF — no embassy visit and no passport sticker.",
    },
  },
});

PLANNED_CONTENT.push({
  destinationIso2: "US",
  fields: {
    tourismBlock: {
      highlights: [
        "New York City and Washington DC",
        "The Grand Canyon and national parks",
        "California coast, Disney and Universal",
      ],
    },
    businessBlock: {
      highlights: [
        "Silicon Valley venture and tech partnerships",
        "CES Las Vegas and industry expos",
        "The largest single consumer market",
      ],
    },
    entrySnapshot: {
      visaRequired: true,
      headline: "Consular interview required",
      summary:
        "The mission stamps the visa into the passport after a personal interview — slot availability drives the timeline.",
    },
  },
});

// PLACEHOLDER — Cambodia was not in the design handoff's country dataset;
// this copy is freshly authored, not sourced, and should be reviewed.
PLANNED_CONTENT.push({
  destinationIso2: "KH",
  fields: {
    tourismBlock: {
      highlights: [
        "Angkor Wat and the temples of Siem Reap",
        "Phnom Penh's riverside and royal palace",
        "Sihanoukville coast and nearby islands",
      ],
    },
    businessBlock: {
      highlights: [
        "Garment and footwear manufacturing sourcing",
        "ASEAN market access via Cambodia's trade agreements",
        "Growing logistics and special economic zones",
      ],
    },
    entrySnapshot: {
      visaRequired: true,
      headline: "e-Visa by email",
      summary: "An electronic visa is issued by email ahead of travel — no embassy visit required.",
    },
  },
});

// PLACEHOLDER — Nepal was not in the design handoff's country dataset;
// this copy is freshly authored, not sourced, and should be reviewed.
PLANNED_CONTENT.push({
  destinationIso2: "NP",
  fields: {
    tourismBlock: {
      highlights: ["Kathmandu's durbar squares and temples", "Pokhara and the Annapurna foothills", "Chitwan jungle safari"],
    },
    businessBlock: {
      highlights: [
        "Hydropower and cross-border transmission projects",
        "Overland trade and logistics via the open border",
        "Hospitality and tourism-infrastructure ventures",
      ],
    },
    entrySnapshot: {
      visaRequired: false,
      headline: "Open border with India",
      summary:
        "Indian nationals may enter Nepal without a visa via any official border crossing or airport, using a valid photo ID.",
    },
  },
});

async function run() {
  assertNoDeleteCalls();

  await connectDb();
  assertModelScope();

  const target = targetInfo();
  const ruleCounts = await planRuleCounts(PLANNED_RULES);
  const contentCounts = await planContentCounts(PLANNED_CONTENT);
  printPlan(target, ruleCounts, contentCounts);

  await confirmDatabaseName(target.db);

  for (const { key, fields } of PLANNED_RULES) {
    await upsertRule(key, fields);
  }
  for (const { destinationIso2, fields } of PLANNED_CONTENT) {
    await upsertDestinationContent(destinationIso2, fields);
  }

  console.log(
    `Seeded visa rules: ${created} created, ${updated} updated. ` +
      `${PLANNED_CONTENT.length} destination-content rows upserted (status: DRAFT).`,
  );
  process.exit(0);
}

run().catch((err) => {
  console.error("seed-visa-rules failed:", err);
  process.exit(1);
});
