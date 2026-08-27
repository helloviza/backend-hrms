// apps/backend/src/scripts/retype-visa-product-classes.ts
//
// Retype the ancillary products the StampMyVisa import flattened into
// productClass "VISA".
//
// ── WHY ───────────────────────────────────────────────────────────────
// All 258 published rules arrived as productClass "VISA". 103 of them are
// not visas at all — meet-and-assist, appointment booking, arrival cards,
// transit visas, visa transfers, corrections, a tourist levy, a guarantee
// letter. Because they are cheap, they win the public "from" price:
// AU headlined a Rs1,416 Visa Transfer over a Rs19,610 visitor visa, and
// US would have headlined a Rs590 Meet & Assist over a Rs18,130 visa.
//
// utils/visaHeadlineRule.ts's preferred pool is an ALLOWLIST
// (productClass === "VISA" OR visaCategory === "VISA_FREE"), so retyping a
// row is all it takes to remove it from headline contention. No code change
// accompanies this migration.
//
// ── CLASSIFY ON priceNote, NEVER variantKey ───────────────────────────
// The two disagree systematically and variantKey is the unreliable one:
//
//   AT  variantKey MEET_ASSIST              priceNote "Appointment & Document Assistance"
//   BE  variantKey APPOINTMENT_DOCUMENT_ASS priceNote "Meet & Assist"
//   TH  variantKey TOURIST_VISA_TDAC        priceNote "Tourist Visa TDAC."  (an arrival card)
//
// A variantKey-keyed migration would mis-file a large fraction of the
// catalogue. priceNote is the product name an ops person actually typed, so
// it is the only trustworthy signal here.
//
// ── WHY updateOne AND NOT .save() ─────────────────────────────────────
// VisaRuleSchema has a pre("validate") hook that RECOMPUTES displayMode
// from the fee fields. A hydrated .save() would therefore write a second
// field as a side effect, which breaks the one guarantee this migration
// makes: it writes productClass and nothing else. updateOne does not run
// document middleware, so the $set below is exactly and only what lands.
//
// `visarules` carries no encrypted fields (plugins/fieldEncryption.plugin.ts
// is attached to ConsumerProfile and VisaDocument only), so the direct-update
// refusal that plugin installs does not apply here.
//
// `effectiveFrom` is `{ required: true, default: Date.now }`. A $set on an
// existing document neither reads nor rewrites it, so the rules keep the
// effective dates they already have.
//
// ── USAGE ─────────────────────────────────────────────────────────────
//   Dry run (default — classifies, prints, writes the audit file, NO writes):
//     tsx src/scripts/retype-visa-product-classes.ts --db="mongodb://127.0.0.1:27017/plumbox_dev"
//
//   Apply, local:
//     ... --db="mongodb://127.0.0.1:27017/plumbox_dev" --apply
//
//   Apply, production (both flags required, deliberately):
//     ... --db="<prod uri>" --apply --confirm-prod
//
// The audit file is written in BOTH modes. It is the human-review artifact
// and the undo manifest: revert-visa-product-classes.ts replays it backwards.
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";

/* ─────────────────────────────────────────────────────────────────────
 * THE CLASSIFICATION RULES.
 *
 * Ordered. First match wins. KEEPS are evaluated before ANCILLARY so a
 * broad pattern can never sweep a product we deliberately decided is a
 * genuine visa.
 * ───────────────────────────────────────────────────────────────────── */

/** Products that LOOK ancillary but are genuine primary visas. */
export const KEEP_AS_VISA: Array<{ label: string; test: RegExp; why: string }> = [
  {
    label: "Priority / Super Priority visa",
    // "Priority Visa - 10 years" (GB). Deliberately requires the word VISA:
    // "Super Priority Appointment" (US) is an appointment slot, not a visa,
    // and must fall through to the ancillary rules below.
    test: /(super\s+)?priority\s+visa/i,
    why: "A real visa with expedited processing — the visa is the product.",
  },
  {
    label: "ETA (electronic travel authorisation)",
    // Case-SENSITIVE: "ETA" is an initialism. A case-insensitive \beta\b
    // would match any stray lowercase "eta".
    test: /\bETA\b/,
    why: "An ETA is a real travel authorisation, equivalent to an e-visa.",
  },
  {
    label: "Invitation letter bundled with a visa",
    test: /invitation\s+letter\s*\+\s*visa/i,
    why: "Bundles an actual visa, so it can legitimately headline.",
  },
];

/** Ancillary families → the productClass each should carry. */
export const ANCILLARY_RULES: Array<{ label: string; test: RegExp; target: string }> = [
  { label: "Appointment / document assistance", target: "APPOINTMENT_SERVICE",
    test: /appointment\s*&\s*document|appointment\s+only|dropbox\s+appointment|appointment\s+assist/i },
  { label: "Meet & assist", target: "APPOINTMENT_SERVICE",
    test: /meet\s*(&|and)\s*assist/i },
  { label: "Early / priority appointment slot", target: "APPOINTMENT_SERVICE",
    test: /early\s+appointment|super\s+priority\s+appointment|priority\s+appointment/i },
  { label: "Form filling", target: "FORM_SERVICE",
    test: /form\s+filling/i },
  { label: "Arrival card / pre-arrival registration", target: "ARRIVAL_CARD",
    test: /arrival\s*card|pre-?arrival|tdac|twac/i },
  { label: "Transit visa", target: "TRANSIT_VISA",
    test: /transit\s+visa/i },
  { label: "Visa transfer", target: "VISA_AMENDMENT",
    test: /visa\s+transfer/i },
  { label: "Correction / amendment", target: "VISA_AMENDMENT",
    test: /correction/i },
  { label: "Tourist levy / tax", target: "TRAVEL_LEVY",
    test: /levy/i },
  { label: "Guarantee / sponsor letter", target: "DOCUMENT_SERVICE",
    test: /guarantee\s+letter/i },
];

export type Verdict =
  | { kind: "KEEP"; target: "VISA"; label: string }
  | { kind: "ANCILLARY"; target: string; label: string }
  | { kind: "PRIMARY"; target: "VISA"; label: string }
  | { kind: "UNCLASSIFIABLE"; target: "VISA"; label: string };

/**
 * Decide what a rule actually sells, from its priceNote alone.
 *
 * A row with no priceNote is NOT guessed at from its variantKey — it is
 * reported as unclassifiable and left exactly as it is. Silently falling
 * back to the unreliable field is how a migration mis-files a row nobody
 * then re-checks.
 */
export function classifyRule(rule: { priceNote?: string | null }): Verdict {
  const note = String(rule?.priceNote ?? "").trim();
  if (!note) {
    return { kind: "UNCLASSIFIABLE", target: "VISA", label: "no priceNote — left untouched" };
  }
  for (const k of KEEP_AS_VISA) {
    if (k.test.test(note)) return { kind: "KEEP", target: "VISA", label: k.label };
  }
  for (const a of ANCILLARY_RULES) {
    if (a.test.test(note)) return { kind: "ANCILLARY", target: a.target, label: a.label };
  }
  return { kind: "PRIMARY", target: "VISA", label: "Primary visa" };
}

/* ── CLI ──────────────────────────────────────────────────────────── */

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const DB = arg("db");
const APPLY = has("apply");
const CONFIRM_PROD = has("confirm-prod");
const OUT_DIR = arg("out") ?? ".";

if (!DB) {
  console.error("Refusing to run: --db=<connection string> is required, so the target is never implicit.");
  process.exit(1);
}
const isLoopback = /^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(DB);
if (APPLY && !isLoopback && !CONFIRM_PROD) {
  console.error("Refusing to APPLY against a non-loopback database without --confirm-prod.");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const auditPath = path.join(OUT_DIR, `retype-audit-${stamp}.json`);

interface Change {
  _id: string;
  iso2: string;
  variantKey: string | null;
  priceNote: string | null;
  family: string;
  oldProductClass: string;
  newProductClass: string;
}

async function main() {
  console.log(`mode        : ${APPLY ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
  console.log(`target      : ${isLoopback ? "local (loopback)" : "REMOTE"}`);
  console.log(`audit file  : ${auditPath}\n`);

  await mongoose.connect(DB!, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.collection("visarules");

  // Catalogue + classification fields only. No PII exists on this
  // collection, and nothing outside this projection is read.
  const rules = await col
    .find(
      { status: "PUBLISHED", nationality: "IN" },
      { projection: { _id: 1, destinationIso2: 1, variantKey: 1, priceNote: 1, productClass: 1 } },
    )
    .toArray();

  const changes: Change[] = [];
  const tally: Record<string, number> = {};
  const keeps: string[] = [];
  const unclassifiable: string[] = [];

  for (const r of rules as any[]) {
    const v = classifyRule(r);
    if (v.kind === "KEEP") keeps.push(`${r.destinationIso2} ${r.priceNote}`);
    if (v.kind === "UNCLASSIFIABLE") unclassifiable.push(`${r.destinationIso2} ${r.variantKey}`);

    // Write ONLY when the row is ancillary AND actually differs. A genuine
    // primary visa is never written, even to the same value.
    if (v.kind !== "ANCILLARY" || v.target === r.productClass) continue;

    changes.push({
      _id: String(r._id),
      iso2: r.destinationIso2,
      variantKey: r.variantKey ?? null,
      priceNote: r.priceNote ?? null,
      family: v.label,
      oldProductClass: r.productClass,
      newProductClass: v.target,
    });
    tally[v.target] = (tally[v.target] ?? 0) + 1;
  }

  console.log(`published rules scanned : ${rules.length}`);
  console.log(`rows to retype          : ${changes.length}`);
  console.log(`kept as VISA (explicit) : ${keeps.length}`);
  console.log(`unclassifiable          : ${unclassifiable.length}`);
  if (unclassifiable.length) for (const u of unclassifiable) console.log(`   ! ${u}`);
  console.log("\nby target class:");
  for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(3)}  ${k}`);
  }

  console.log("\nby corridor:");
  const byIso = new Map<string, Change[]>();
  for (const c of changes) {
    if (!byIso.has(c.iso2)) byIso.set(c.iso2, []);
    byIso.get(c.iso2)!.push(c);
  }
  for (const iso of [...byIso.keys()].sort()) {
    console.log(`  ${iso}`);
    for (const c of byIso.get(iso)!) {
      console.log(
        `     ${String(c.variantKey).padEnd(28)} ${String(c.priceNote).slice(0, 46).padEnd(46)} ${c.oldProductClass} -> ${c.newProductClass}`,
      );
    }
  }

  fs.writeFileSync(auditPath, JSON.stringify({ generatedAt: stamp, applied: APPLY, changes }, null, 1), "utf8");
  console.log(`\naudit written: ${auditPath} (${changes.length} rows)`);

  if (!APPLY) {
    console.log("\nDRY RUN — no database writes were performed.");
    return;
  }

  let written = 0;
  for (const c of changes) {
    const res = await col.updateOne(
      { _id: new mongoose.Types.ObjectId(c._id) },
      { $set: { productClass: c.newProductClass } },
    );
    written += res.modifiedCount;
  }
  console.log(`\nAPPLIED — documents modified: ${written} (expected ${changes.length})`);
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
