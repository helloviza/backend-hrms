// apps/backend/src/scripts/backfill-visa-type-name.ts
//
// Backfill VisaRule.visaTypeName from the product name that priceNote has
// been carrying.
//
// ── WHY ───────────────────────────────────────────────────────────────
// 248 of 258 published rules author priceNote as "<product name> | validity
// <term>", and routes/public.visa.ts's variantDisplayName() splits the pipe
// back off at render time to recover the name. The product name is
// therefore a parse of a free-text note, which means it is only as good as
// the punctuation ops typed: IN->AM's Tourist Visa row uses a DASH where
// the pipe belongs, so the parse keeps the whole string and the customer is
// shown "Tourist Visa - 21 Days (Single Entry) - validity 90 days post
// issue" as if that were a product name.
//
// models/VisaRule.ts now has a dedicated `visaTypeName`. This script fills
// it. Repointing variantDisplayName() at it is a SEPARATE, LATER change —
// this script only ever writes data.
//
// ── THE PARSE IS variantDisplayName's, CHARACTER FOR CHARACTER ────────
// parseVisaTypeName() below is deliberately the same expression the render
// path runs today:
//
//   String(priceNote ?? "").split("|")[0].trim().replace(/\.+$/, "").trim()
//
// That is the whole point of copying it rather than improving it: for every
// clean row the value written is EXACTLY the string the customer already
// sees, so migrating and then repointing the reader changes nothing on
// screen. Improving the parse here would silently rename products. The
// script ASSERTS this equality per row (see `displayMatches`) and refuses
// to call a row clean without it.
//
// The half after the pipe is discarded, not stored: it is a validity term,
// and validityDays already holds that structurally.
//
// -- THE STAGE-1 DRY RUN, AND WHAT WAS RULED ON IT --------------------
// The 2026-08-31 read-only dry run against production scanned all 258
// published IN rules: 252 parsed cleanly, 6 were held back for a human.
// Both questions have since been answered, and the answers are encoded
// below rather than left in a chat log:
//
//   5 long names (US x3, HU, HK -- 63 to 83 chars) ACCEPTED AS PARSED.
//     They were never wrong, only unusual. Length is now recorded as an
//     informational `longName` note and no longer withholds a write; see
//     NAME_LENGTH_FLAG.
//
//   1 dash-typo row (IN->AM, variantKey TOURIST_VISA_120_DAYS) OVERRIDDEN.
//     Its priceNote separates the validity term with a DASH instead of the
//     pipe, so the parse keeps the whole string and the customer is shown
//     "Tourist Visa - 21 Days (Single Entry) - validity 90 days post issue"
//     as if that were a product name. The approved name lives in
//     NAME_OVERRIDES -- an explicit, auditable entry keyed on the rule's
//     identity, never a magic string buried in the parse.
//
// Net: 258 of 258 rows get a visaTypeName -- 257 from the parse, 1 from
// the override.
//
// -- WHAT IT STILL REFUSES TO GUESS ----------------------------------
//   DASH_TYPO   priceNote has no "|" but does state a validity term, and
//               no override covers it. Nothing is written; a human names
//               it. (Zero such rows on today's production data -- the AM
//               row is the only one, and it now has an override.)
//   NO_NAME     priceNote is absent/empty, so there is no name to take.
//               These stay UNSET -- visaTypeName is optional precisely so
//               a reader keeps its existing fallback for them. variantKey
//               is NOT harvested as a substitute: the 2026-08-27 catalogue
//               audit found it disagrees with the product it names across
//               the board (AT's MEET_ASSIST row reads "Appointment &
//               Document Assistance"). (Also zero such rows today -- every
//               published IN rule has a priceNote.)
//
// -- priceNote IS NEVER TOUCHED --------------------------------------
// The $set below carries visaTypeName and nothing else. Clearing priceNote
// is deliberately NOT part of this migration: 60 rows state a numeric
// validity term ONLY in that string (validityDays and maxStayDays are both
// null on all 60), so erasing it would destroy data this field does not
// replace. That cleanup is its own task, with its own rescue of those 60
// terms first.
//
// ── WHY updateOne AND NOT .save() ─────────────────────────────────────
// Same reason as retype-visa-product-classes.ts: VisaRuleSchema has a
// pre("validate") hook that RECOMPUTES displayMode from the fee fields, so
// a hydrated .save() would write a second field as a side effect. updateOne
// does not run document middleware, so the $set below is exactly and only
// what lands. `visarules` carries no encrypted fields, and `effectiveFrom`
// is untouched by a $set on an existing document.
//
// ── USAGE ─────────────────────────────────────────────────────────────
//   Dry run (THE DEFAULT — parses, prints the full before/after, writes the
//   audit file, performs NO database writes):
//     tsx src/scripts/backfill-visa-type-name.ts --db="<uri>"
//
//   Apply, local:
//     ... --db="mongodb://127.0.0.1:27017/plumbox_dev" --apply
//
//   Apply, production (both flags required, deliberately):
//     ... --db="<prod uri>" --apply --confirm-prod
//
// The audit file is written in BOTH modes. It carries the old priceNote per
// row, so it is both the human-review artifact and the undo manifest.
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";

/**
 * variantDisplayName's parse (routes/public.visa.ts), lifted verbatim.
 * Do not "fix" it here — see the header. Returns "" when there is nothing
 * to take.
 */
export function parseVisaTypeName(priceNote: unknown): string {
  return String(priceNote ?? "")
    .split("|")[0]
    .trim()
    .replace(/\.+$/, "")
    .trim();
}

/**
 * What the customer is shown TODAY for this row, reproduced exactly —
 * including the variantKey fallback the render path takes when there is no
 * priceNote at all. The invariant check compares against this.
 */
export function currentDisplayName(rule: { priceNote?: unknown; variantKey?: unknown }): string {
  const note = parseVisaTypeName(rule?.priceNote);
  if (note) return note;
  return String(rule?.variantKey ?? "").trim() || "Visa";
}

/**
 * Names longer than this are REPORTED, not withheld.
 *
 * Stage 1 held them back so a human could look; the human looked, and all
 * five were correct (a US "Visitor Visa (B1/B2) - Super Priority
 * Appointment (Appointment Date within 45 days)" really is 83 characters
 * long). So this is now an informational threshold only -- it annotates a
 * row, it no longer decides whether the row is written.
 */
export const NAME_LENGTH_FLAG = 60;

/**
 * Names a human has ruled on, because the parse cannot produce them.
 *
 * Keyed on {destinationIso2, variantKey} -- the rule's stable business
 * identity, not its _id, so the entry stays readable and survives a
 * re-seed.
 *
 * THAT KEY IS NOT UNIQUE, and the script checks rather than assumes.
 * Production holds three {iso2, variantKey} pairs that match two rules
 * each (DZ/VISIT_VISA_90_DAYS, DZ/VISIT_VISA_30_DAYS,
 * CN/TOURIST_VISA_EXPRESS_MUM -- the members differ by purpose or
 * entryType, which the 6-field unique index allows). An override is a
 * ruling on ONE product, so an entry landing on two of them would put one
 * human-approved name on two different products silently. Both failure
 * directions therefore abort the whole run:
 *
 *   matches 0 rows  -> `unmatchedOverrides` -- the catalogue moved
 *                      underneath this list (variantKey renamed, rule
 *                      retired, corridor dropped) and somebody must look.
 *   matches >1 rows -> `ambiguousOverrides` -- the key does not identify
 *                      one product. Narrow it (add purpose/entryType, or
 *                      key on _id) rather than letting it spread.
 *
 * Exactly one match is the only acceptable outcome. Both checks run in dry
 * run too, so an ambiguous entry is visible before anyone reaches for
 * --apply.
 *
 * Keep this list SHORT. It is for rows whose source data is malformed, not
 * a place to retitle products -- a rename belongs in the admin console,
 * where ops can see it.
 */
export const NAME_OVERRIDES: Array<{
  iso2: string;
  variantKey: string;
  visaTypeName: string;
  why: string;
}> = [
  {
    iso2: "AM",
    variantKey: "TOURIST_VISA_120_DAYS",
    visaTypeName: "Tourist Visa - 21 Days (Single Entry)",
    why:
      "priceNote separates the validity term with a DASH instead of the pipe " +
      '("Tourist Visa - 21 Days (Single Entry) - validity 90 days post issue"), ' +
      "so the parse keeps the whole string including the validity clause. " +
      "Approved 2026-08-31. This is the ONE row whose displayed name changes, " +
      "and it changes from broken to correct.",
  },
];

export function findOverride(rule: {
  destinationIso2?: unknown;
  variantKey?: unknown;
}): (typeof NAME_OVERRIDES)[number] | null {
  const iso2 = String(rule?.destinationIso2 ?? "").trim().toUpperCase();
  const variantKey = String(rule?.variantKey ?? "").trim().toUpperCase();
  if (!iso2 || !variantKey) return null;
  return NAME_OVERRIDES.find((o) => o.iso2 === iso2 && o.variantKey === variantKey) ?? null;
}

export type FlagKind = "DASH_TYPO" | "NO_NAME";

export interface Verdict {
  /** Where `value` came from. null means nothing is written for this row. */
  source: "OVERRIDE" | "PARSE" | null;
  /** Exactly what would be written. "" when `source` is null. */
  value: string;
  /** What the naive parse produces -- recorded even when it is not used. */
  parsed: string;
  /** Informational only: the parsed name exceeds NAME_LENGTH_FLAG. */
  longName: boolean;
  /** Non-null only when nothing is written and a human must decide. */
  flag: FlagKind | null;
  why: string;
  /** The half after the pipe, discarded on purpose. */
  discardedValidityClause: string | null;
}

export function classify(rule: {
  priceNote?: unknown;
  variantKey?: unknown;
  destinationIso2?: unknown;
}): Verdict {
  const raw = String(rule?.priceNote ?? "");
  const parsed = parseVisaTypeName(raw);
  const pipeAt = raw.indexOf("|");
  const discarded = pipeAt >= 0 ? raw.slice(pipeAt + 1).trim() || null : null;
  const longName = parsed.length > NAME_LENGTH_FLAG;

  // An override wins over everything, including the malformed-row checks
  // below -- resolving exactly such a row is what it exists for.
  const override = findOverride(rule);
  if (override) {
    return {
      source: "OVERRIDE",
      value: override.visaTypeName,
      parsed,
      longName,
      flag: null,
      why: override.why,
      discardedValidityClause: discarded,
    };
  }

  if (!parsed) {
    return {
      source: null,
      value: "",
      parsed,
      longName,
      flag: "NO_NAME",
      why: "priceNote is absent/empty, so there is nothing to take. Left UNSET; the reader keeps its fallback.",
      discardedValidityClause: discarded,
    };
  }
  // No pipe at all, but the note is still stating a validity term: the
  // separator was mistyped (a dash, a comma, nothing), so the parse has
  // swallowed the validity clause into the product name.
  if (pipeAt < 0 && /validity|valid\s+for|post\s+issue/i.test(raw)) {
    return {
      source: null,
      value: "",
      parsed,
      longName,
      flag: "DASH_TYPO",
      why:
        'no "|" separator but the note states a validity term, so the parse keeps it ' +
        "inside the name -- and no NAME_OVERRIDES entry covers this row",
      discardedValidityClause: discarded,
    };
  }
  return {
    source: "PARSE",
    value: parsed,
    parsed,
    longName,
    flag: null,
    why: longName
      ? `clean; long name (${parsed.length} chars) accepted as parsed, ruled 2026-08-31`
      : "clean",
    discardedValidityClause: discarded,
  };
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
const auditPath = path.join(OUT_DIR, `visa-type-name-audit-${stamp}.json`);

interface Row {
  _id: string;
  iso2: string | null;
  destinationName: string | null;
  purpose: string | null;
  entryType: string | null;
  serviceTier: string | null;
  variantKey: string | null;
  productClass: string | null;
  validityDays: number | null;
  priceNote: string | null;
  existingVisaTypeName: string | null;
  /** Where the written value came from; null when nothing is written. */
  source: "OVERRIDE" | "PARSE" | null;
  /** Exactly what would land in visaTypeName. */
  value: string;
  /** The naive parse, recorded even where an override supersedes it. */
  parsed: string;
  longName: boolean;
  discardedValidityClause: string | null;
  /** What variantDisplayName() returns for this row BEFORE the migration. */
  currentDisplay: string;
  /** value === currentDisplay. True for every PARSE row, false for the override. */
  displayMatches: boolean;
  flag: FlagKind | null;
  why: string;
}

const pad = (s: unknown, n: number) => String(s ?? "").padEnd(n);
const clip = (s: unknown, n: number) => {
  const v = String(s ?? "");
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
};

async function main() {
  console.log(`mode        : ${APPLY ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
  console.log(`target      : ${isLoopback ? "local (loopback)" : "REMOTE"}`);
  console.log(`audit file  : ${auditPath}\n`);

  await mongoose.connect(DB!, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.collection("visarules");

  // Catalogue fields only. This collection carries no PII.
  const rules = await col
    .find(
      { status: "PUBLISHED", nationality: "IN" },
      {
        projection: {
          _id: 1, destinationIso2: 1, destinationName: 1, purpose: 1, entryType: 1,
          serviceTier: 1, variantKey: 1, productClass: 1, validityDays: 1,
          priceNote: 1, visaTypeName: 1,
        },
      },
    )
    .toArray();

  const rows: Row[] = (rules as any[]).map((r) => {
    const v = classify(r);
    const currentDisplay = currentDisplayName(r);
    return {
      _id: String(r._id),
      iso2: r.destinationIso2 ?? null,
      destinationName: r.destinationName ?? null,
      purpose: r.purpose ?? null,
      entryType: r.entryType ?? null,
      serviceTier: r.serviceTier ?? null,
      variantKey: r.variantKey ?? null,
      productClass: r.productClass ?? null,
      validityDays: r.validityDays ?? null,
      priceNote: r.priceNote ?? null,
      existingVisaTypeName: r.visaTypeName ?? null,
      source: v.source,
      value: v.value,
      parsed: v.parsed,
      longName: v.longName,
      discardedValidityClause: v.discardedValidityClause,
      currentDisplay,
      displayMatches: v.value === currentDisplay,
      flag: v.flag,
      why: v.why,
    };
  });

  rows.sort(
    (a, b) =>
      (a.iso2 ?? "").localeCompare(b.iso2 ?? "") ||
      (a.purpose ?? "").localeCompare(b.purpose ?? "") ||
      (a.variantKey ?? "").localeCompare(b.variantKey ?? ""),
  );

  const parseRows = rows.filter((r) => r.source === "PARSE");
  const overrideRows = rows.filter((r) => r.source === "OVERRIDE");
  const toWrite = rows.filter((r) => r.source !== null);
  const flagged = rows.filter((r) => r.source === null);

  // THE INVARIANT, and the only hard stop in this script.
  //
  // Every PARSE row must write EXACTLY the string variantDisplayName()
  // returns today. That is what makes Stage 2 (repointing the reader at
  // visaTypeName) a no-op on screen. A PARSE row that fails it would rename
  // a product silently, so one failure aborts the whole run rather than
  // writing the rest.
  //
  // OVERRIDE rows are excluded by construction: an override exists PRECISELY
  // to change what is displayed, and the AM row's whole purpose is to stop
  // showing the customer a validity clause as if it were a product name.
  const brokenInvariant = parseRows.filter((r) => !r.displayMatches);

  // Every override must resolve to EXACTLY ONE rule. See NAME_OVERRIDES'
  // own comment for why both directions are errors: zero means the
  // catalogue moved underneath the list, and more than one means the key
  // does not identify a single product — {iso2, variantKey} is not unique
  // in this collection, so an entry can land on two rules that differ by
  // purpose or entryType and label both with one human's ruling.
  //
  // Matched the same way findOverride() matches, so what is counted here
  // is exactly what would be written.
  const overrideMatches = NAME_OVERRIDES.map((o) => ({
    override: o,
    rows: rows.filter(
      (r) =>
        r.source === "OVERRIDE" &&
        String(r.iso2 ?? "").toUpperCase() === o.iso2.toUpperCase() &&
        String(r.variantKey ?? "").toUpperCase() === o.variantKey.toUpperCase(),
    ),
  }));
  const unmatchedOverrides = overrideMatches.filter((m) => m.rows.length === 0).map((m) => m.override);
  const ambiguousOverrides = overrideMatches.filter((m) => m.rows.length > 1);

  console.log("=".repeat(128));
  console.log("FULL BEFORE / AFTER — every published IN rule");
  console.log("=".repeat(128));
  console.log(
    pad("ISO", 4) +
      pad("PURPOSE", 20) +
      pad("ENTRY", 10) +
      pad("priceNote (BEFORE, kept as-is)", 52) +
      pad("visaTypeName (AFTER)", 40) +
      "SOURCE",
  );
  console.log("-".repeat(128));
  for (const r of rows) {
    console.log(
      pad(r.iso2, 4) +
        pad(clip(r.purpose, 19), 20) +
        pad(clip(r.entryType, 9), 10) +
        pad(clip(r.priceNote ?? "—", 51), 52) +
        pad(clip(r.source ? r.value : "(not written)", 39), 40) +
        (r.source ?? `FLAG:${r.flag}`) +
        (r.longName ? "  [long]" : "") +
        (r.source === "OVERRIDE" ? "  ← DISPLAY CHANGES" : ""),
    );
  }

  console.log("\n" + "=".repeat(128));
  console.log("OVERRIDES — human-ruled names, the only rows whose display changes");
  console.log("=".repeat(128));
  if (!overrideRows.length) console.log("(none)");
  for (const r of overrideRows) {
    console.log(
      `\n  ${r.iso2} · ${r.destinationName} · ${r.purpose} · ${r.entryType} · ${r.serviceTier} · variantKey ${r.variantKey}`,
    );
    console.log(`     priceNote (UNCHANGED) : ${JSON.stringify(r.priceNote)}`);
    console.log(`     naive parse (rejected): ${JSON.stringify(r.parsed)}`);
    console.log(`     shown BEFORE          : ${JSON.stringify(r.currentDisplay)}`);
    console.log(`     shown AFTER           : ${JSON.stringify(r.value)}`);
    console.log(`     why                   : ${r.why}`);
  }

  console.log("\n  override resolution (each entry must match EXACTLY ONE rule):");
  for (const m of overrideMatches) {
    const verdict = m.rows.length === 1 ? "OK" : m.rows.length === 0 ? "STALE" : "AMBIGUOUS";
    console.log(
      `      ${m.override.iso2} / ${m.override.variantKey}  -> ${m.rows.length} row(s)  [${verdict}]`,
    );
  }

  if (unmatchedOverrides.length) {
    console.log("\n  ✗ STALE OVERRIDE(S) — matched no rule in this database:");
    for (const o of unmatchedOverrides) console.log(`      ${o.iso2} / ${o.variantKey}`);
  }
  if (ambiguousOverrides.length) {
    console.log("\n  ✗ AMBIGUOUS OVERRIDE(S) — matched more than one rule, so the key does");
    console.log("    not identify a single product. Narrow it before applying:");
    for (const m of ambiguousOverrides) {
      console.log(`      ${m.override.iso2} / ${m.override.variantKey} -> ${m.rows.length} rows:`);
      for (const r of m.rows) {
        console.log(
          `         ${r.purpose} · ${r.entryType} · ${r.serviceTier}  ${JSON.stringify(r.priceNote)}`,
        );
      }
    }
  }

  console.log("\n" + "=".repeat(128));
  console.log("FLAGGED — NOT WRITTEN, needs a human ruling");
  console.log("=".repeat(128));
  if (!flagged.length) console.log("(none — every published IN rule resolves to a name)");
  for (const r of flagged) {
    console.log(`\n  [${r.flag}]  ${r.iso2} · ${r.destinationName} · ${r.purpose} · ${r.entryType}`);
    console.log(`     variantKey  : ${r.variantKey}`);
    console.log(`     priceNote   : ${r.priceNote === null ? "(absent)" : JSON.stringify(r.priceNote)}`);
    console.log(`     naive parse : ${JSON.stringify(r.parsed)}`);
    console.log(`     shown today : ${JSON.stringify(r.currentDisplay)}`);
    console.log(`     why flagged : ${r.why}`);
  }

  const longRows = rows.filter((r) => r.longName && r.source === "PARSE");
  console.log("\n" + "=".repeat(128));
  console.log(`LONG NAMES — accepted as parsed (ruled 2026-08-31), written normally`);
  console.log("=".repeat(128));
  if (!longRows.length) console.log("(none)");
  for (const r of longRows) {
    console.log(`  ${r.iso2}  (${String(r.value.length).padStart(3)} chars)  ${JSON.stringify(r.value)}`);
  }

  console.log("\n" + "=".repeat(128));
  console.log("COUNTS");
  console.log("=".repeat(128));
  console.log(`  published IN rules scanned            : ${rows.length}`);
  console.log(`  will receive a visaTypeName           : ${toWrite.length}`);
  console.log(`       from the priceNote parse         : ${parseRows.length}`);
  console.log(`       from NAME_OVERRIDES              : ${overrideRows.length}`);
  console.log(`  left UNSET (flagged)                  : ${flagged.length}`);
  for (const k of ["DASH_TYPO", "NO_NAME"] as FlagKind[]) {
    const n = flagged.filter((r) => r.flag === k).length;
    if (n) console.log(`       ${String(n).padStart(3)}  ${k}`);
  }
  console.log(`  long names accepted as parsed         : ${longRows.length}`);
  console.log(`  already had visaTypeName              : ${rows.filter((r) => r.existingVisaTypeName).length}`);
  console.log(`  priceNote values this run modifies    : 0  (the $set carries visaTypeName only)`);

  console.log("\n" + "=".repeat(128));
  console.log("INVARIANT — every PARSE row writes exactly what the screen shows today");
  console.log("=".repeat(128));
  if (brokenInvariant.length) {
    console.log(`  ✗ FAILED on ${brokenInvariant.length} PARSE row(s):`);
    for (const r of brokenInvariant) {
      console.log(
        `      ${r.iso2} ${r.variantKey}: would write ${JSON.stringify(r.value)} vs shown ${JSON.stringify(r.currentDisplay)}`,
      );
    }
  } else {
    console.log(
      `  ✓ HOLDS on all ${parseRows.length} PARSE rows — repointing variantDisplayName() at`,
    );
    console.log(`    visaTypeName changes NOTHING on screen for them.`);
  }
  console.log(
    `  Deliberate display changes: ${overrideRows.length} (the override${overrideRows.length === 1 ? "" : "s"} above, broken → correct).`,
  );

  fs.writeFileSync(
    auditPath,
    JSON.stringify(
      {
        generatedAt: stamp,
        applied: APPLY,
        scanned: rows.length,
        writeCount: toWrite.length,
        parseCount: parseRows.length,
        overrideCount: overrideRows.length,
        flaggedCount: flagged.length,
        invariantHolds: brokenInvariant.length === 0,
        unmatchedOverrides,
        ambiguousOverrides: ambiguousOverrides.map((m) => ({
          override: m.override,
          matchedRuleIds: m.rows.map((r) => r._id),
        })),
        overrides: NAME_OVERRIDES,
        rows,
      },
      null,
      1,
    ),
    "utf8",
  );
  console.log(`\naudit written: ${auditPath} (${rows.length} rows)`);

  if (!APPLY) {
    console.log("\nDRY RUN — no database writes were performed.");
    return;
  }

  if (brokenInvariant.length) {
    throw new Error(
      `Refusing to APPLY: the display invariant failed on ${brokenInvariant.length} PARSE row(s). Nothing was written.`,
    );
  }
  if (unmatchedOverrides.length) {
    throw new Error(
      `Refusing to APPLY: ${unmatchedOverrides.length} NAME_OVERRIDES entr(y/ies) matched no rule. Nothing was written.`,
    );
  }
  if (ambiguousOverrides.length) {
    const detail = ambiguousOverrides
      .map((m) => `${m.override.iso2}/${m.override.variantKey} (${m.rows.length} rows)`)
      .join(", ");
    throw new Error(
      `Refusing to APPLY: ${ambiguousOverrides.length} NAME_OVERRIDES entr(y/ies) matched more than one rule — ` +
        `${detail}. An override names ONE product; narrow the key. Nothing was written.`,
    );
  }

  let written = 0;
  for (const r of toWrite) {
    // visaTypeName ONLY. priceNote is not in this $set and is never
    // unset — 60 rows hold a validity term that exists nowhere else.
    const res = await col.updateOne(
      { _id: new mongoose.Types.ObjectId(r._id) },
      { $set: { visaTypeName: r.value } },
    );
    written += res.modifiedCount;
  }
  console.log(
    `\nAPPLIED — documents modified: ${written} (expected up to ${toWrite.length}; a row already carrying the same value reports 0)`,
  );
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
