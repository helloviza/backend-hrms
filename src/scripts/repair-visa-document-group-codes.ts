// apps/backend/src/scripts/repair-visa-document-group-codes.ts
//
// REPAIR — documentGroups whose docTypeCode contradicts the group's own
// label, which is what makes the Apply flow's document slots cross-fill.
//
// ══════════════════════════════════════════════════════════════════════
// THE BUG THIS REPAIRS
// ══════════════════════════════════════════════════════════════════════
// buildRequiredGroups (apply/draft.ts) joins the corridor's required
// documents to the consumer's locker on docCode, and only on docCode. That
// join is correct. The data is not: 103 of 259 published IN rules list the
// SAME docTypeCode in more than one group, so one uploaded file satisfies
// every group carrying that code at once.
//
// Two of those collisions are not "a code used twice" but "a code that is
// simply wrong for this group", and they are the two the customer noticed:
//
//   AM Armenia   [Photograph: Passports size image]  <- PASSPORT_ORIGINAL
//   AT Austria   [Hotel reservation: hotel ticket]   <- FLIGHT_ITINERARY
//
// Uploading a passport-size photo therefore also ticked the passport
// section; a flight ticket also ticked the hotel reservation.
//
// ══════════════════════════════════════════════════════════════════════
// THE MATCHING RULE — narrow on purpose, and stated so it can be argued
// ══════════════════════════════════════════════════════════════════════
// A row is proposed for re-mapping ONLY when all four hold:
//
//   1. the group's LABEL clearly names one kind of document — the label
//      matches PHOTO_LABEL (photo/photograph) or HOTEL_LABEL
//      (hotel/accommodation/lodging), and NOT the other family;
//   2. the code it carries belongs to a DIFFERENT family — a PASSPORT_*
//      code under a photo label, or FLIGHT_ITINERARY under a hotel label;
//   3. the correct code (PHOTOGRAPH / HOTEL_BOOKING) is NOT already
//      present on that same group — if it is, the group is already
//      satisfiable and the extra code is a separate question;
//   4. the correct code EXISTS in the document-code catalogue (asserted at
//      startup, not assumed).
//
// Everything else is left alone and reported. In particular this script
// does NOT touch:
//   · a group listing several codes where all of them plausibly belong
//     (Singapore's "Marriage Certificate" carries PASSPORT_BACK +
//     MARRIAGE_CERTIFICATE — that is a real question about whether the
//     passport back should be re-collected there, not a mislabel);
//   · the groups carrying NO codes at all (377 across all published rows,
//     147 across unique corridors — a corridor can have several rule rows
//     and each is its own document). They are inert: nothing can ever
//     satisfy them. But choosing a code for a group labelled "Company
//     Identity Card" is a CONTENT decision, not a repair, so they are
//     LISTED for review instead of guessed at.
//
// A NOTE ON COUNTS. This script scans ROWS, not corridors, because each
// row is a document that has to be fixed on its own — which is why China
// appears eleven times below and the totals are larger than the
// per-corridor figures from the diagnosis.
//
// ══════════════════════════════════════════════════════════════════════
// DRY RUN IS THE DEFAULT
// ══════════════════════════════════════════════════════════════════════
//   tsx src/scripts/repair-visa-document-group-codes.ts --db="mongodb://127.0.0.1:27017/plumbox_dev"
//   ... --apply                      (loopback only)
//   ... --apply --confirm-prod       (anything else)
//
// The same posture as backfill-visa-type-name.ts: the target is never
// implicit, APPLY against a non-loopback host needs a second explicit
// flag, and every proposed write is printed before any is made.
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";

import { getVisaDocumentCodeDef } from "../config/visaDocumentCodes.js";

/* ── The two families we are willing to correct ─────────────────────── */

const PHOTO_LABEL = /\bphoto|photograph/i;
const HOTEL_LABEL = /\bhotel|accommodat|lodging/i;
/** A label that names BOTH families is ambiguous and is never rewritten. */
const FLIGHT_LABEL = /\bflight|air\s*ticket|itinerar|onward|return\s*ticket/i;
const PASSPORT_LABEL = /\bpassport/i;

const WRONG_UNDER_PHOTO = /^PASSPORT_/;
const WRONG_UNDER_HOTEL = /^FLIGHT_ITINERARY$/;

const PHOTO_CODE = "PHOTOGRAPH";
const HOTEL_CODE = "HOTEL_BOOKING";

interface Proposal {
  ruleId: string;
  iso2: string;
  destinationName: string;
  groupKey: string;
  groupLabel: string;
  family: "PHOTO" | "HOTEL";
  from: string;
  to: string;
}

interface CodelessGroup {
  iso2: string;
  destinationName: string;
  groupKey: string;
  groupLabel: string;
}

/* ── CLI ────────────────────────────────────────────────────────────── */

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
const auditPath = path.join(OUT_DIR, `visa-document-group-codes-${stamp}.json`);

const pad = (s: unknown, n: number) => String(s ?? "").padEnd(n);
const clip = (s: unknown, n: number) => {
  const v = String(s ?? "");
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
};

/**
 * Does this group's label name exactly one of the two families?
 *
 * A label mentioning both ("hotel and flight bookings") returns null and
 * is left alone — the whole point of the rule is that the label has to be
 * unambiguous before it is trusted over the code.
 */
function familyOf(label: string): "PHOTO" | "HOTEL" | null {
  /* "PASSPORT SIZE" IS PHOTO VOCABULARY, NOT PASSPORT VOCABULARY.
   *
   * The first pass of this rule excluded any label containing "passport"
   * as ambiguous, and that silently skipped every row it was written to
   * fix: Armenia's group is labelled "Photograph: Passports size image",
   * Algeria's "Photographs: Two recent passport size photos". In both the
   * word describes the DIMENSIONS of a photo. Stripped before the
   * passport test so the exclusion still catches a genuine "Passport
   * front page" label and no longer catches its own target. */
  const deSized = label.replace(/passports?\s*[-\s]?\s*siz(e|ed)/gi, " ");

  const photo = PHOTO_LABEL.test(label);
  const hotel = HOTEL_LABEL.test(label);
  const flight = FLIGHT_LABEL.test(deSized);
  const passport = PASSPORT_LABEL.test(deSized);

  if (photo && !hotel && !flight && !passport) return "PHOTO";
  if (hotel && !photo && !flight && !passport) return "HOTEL";
  return null;
}

async function main() {
  console.log(`mode        : ${APPLY ? "APPLY (writes)" : "DRY RUN (no writes)"}`);
  console.log(`target      : ${isLoopback ? "local (loopback)" : "REMOTE"}`);
  console.log(`audit file  : ${auditPath}\n`);

  /* GUARD 4 — the destination codes must be real. Asserted before a single
   * row is read, so a renamed catalogue entry stops the run rather than
   * writing a code nothing can resolve. */
  for (const code of [PHOTO_CODE, HOTEL_CODE]) {
    const def = getVisaDocumentCodeDef(code);
    if (!def) {
      console.error(`Refusing to run: "${code}" is not in the document-code catalogue.`);
      process.exit(1);
    }
    console.log(`catalogue ok: ${pad(code, 14)} -> ${def.name}`);
  }
  console.log();

  await mongoose.connect(DB!, { serverSelectionTimeoutMS: 20000 });
  const col = mongoose.connection.collection("visarules");

  // Catalogue fields only. This collection carries no PII.
  const rules = await col
    .find(
      { status: "PUBLISHED", nationality: "IN" },
      { projection: { _id: 1, destinationIso2: 1, destinationName: 1, documentGroups: 1 } },
    )
    .toArray();

  const proposals: Proposal[] = [];
  const codeless: CodelessGroup[] = [];
  let groupsSeen = 0;
  let alreadyCorrect = 0;

  for (const rule of rules as any[]) {
    for (const g of rule.documentGroups ?? []) {
      groupsSeen += 1;
      const label = String(g.label ?? "");
      const codes: string[] = Array.isArray(g.docTypeCodes) ? g.docTypeCodes.map(String) : [];

      if (codes.length === 0) {
        codeless.push({
          iso2: rule.destinationIso2,
          destinationName: rule.destinationName,
          groupKey: String(g.key ?? ""),
          groupLabel: label,
        });
        continue;
      }

      const family = familyOf(label); // GUARD 1
      if (!family) continue;

      const want = family === "PHOTO" ? PHOTO_CODE : HOTEL_CODE;
      // GUARD 3 — the group can already be satisfied correctly; leave it.
      if (codes.includes(want)) {
        alreadyCorrect += 1;
        continue;
      }

      const wrongRe = family === "PHOTO" ? WRONG_UNDER_PHOTO : WRONG_UNDER_HOTEL;
      for (const code of codes) {
        if (!wrongRe.test(code)) continue; // GUARD 2
        proposals.push({
          ruleId: String(rule._id),
          iso2: rule.destinationIso2,
          destinationName: rule.destinationName,
          groupKey: String(g.key ?? ""),
          groupLabel: label,
          family,
          from: code,
          to: want,
        });
      }
    }
  }

  /* ── The report ──────────────────────────────────────────────────── */

  console.log(`published IN rules      : ${rules.length}`);
  console.log(`document groups scanned : ${groupsSeen}`);
  console.log(`already correctly coded : ${alreadyCorrect}`);
  console.log(`PROPOSED re-maps        : ${proposals.length}`);
  console.log(`groups with NO code     : ${codeless.length}  (reported only — never auto-fixed)\n`);

  if (proposals.length) {
    console.log("PROPOSED RE-MAPS");
    console.log(
      `  ${pad("ISO", 5)}${pad("DESTINATION", 22)}${pad("GROUP LABEL", 42)}${pad("FROM", 20)}TO`,
    );
    for (const p of proposals) {
      console.log(
        `  ${pad(p.iso2, 5)}${pad(clip(p.destinationName, 21), 22)}${pad(clip(p.groupLabel, 41), 42)}${pad(p.from, 20)}${p.to}`,
      );
    }
    console.log();
  }

  if (codeless.length) {
    const byIso = new Map<string, CodelessGroup[]>();
    for (const c of codeless) {
      if (!byIso.has(c.iso2)) byIso.set(c.iso2, []);
      byIso.get(c.iso2)!.push(c);
    }
    console.log(`GROUPS WITH NO docTypeCodes — inert slots, nothing can ever satisfy them`);
    console.log(`  ${byIso.size} corridors, ${codeless.length} groups. First 40:\n`);
    let shown = 0;
    for (const [iso, rows] of byIso) {
      for (const r of rows) {
        if (shown++ >= 40) break;
        console.log(`  ${pad(iso, 5)}${pad(clip(r.destinationName, 21), 22)}${clip(r.groupLabel, 60)}`);
      }
      if (shown >= 40) break;
    }
    console.log(`\n  Full list in the audit file. These need a CONTENT decision (which`);
    console.log(`  code does "Company Identity Card" mean?), not a mechanical repair.\n`);
  }

  fs.writeFileSync(
    auditPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), mode: APPLY ? "APPLY" : "DRY_RUN", rules: rules.length, groupsSeen, alreadyCorrect, proposals, codeless },
      null,
      2,
    ),
  );

  if (!APPLY) {
    console.log("DRY RUN — no database writes were performed.");
    await mongoose.disconnect();
    return;
  }

  /* ── The write ───────────────────────────────────────────────────────
   * Positional per group, one updateOne per proposal, and the filter
   * re-states the condition rather than trusting the index the read saw:
   * documentGroups is an array and a concurrent edit could have reordered
   * it between the scan and the write. arrayFilters pins the group by its
   * own key and the code by its value, so a row that moved is simply not
   * matched — the run reports it as skipped rather than rewriting whatever
   * is now in that slot. */
  let written = 0;
  let skipped = 0;
  for (const p of proposals) {
    const r = await col.updateOne(
      { _id: new mongoose.Types.ObjectId(p.ruleId) },
      { $set: { "documentGroups.$[g].docTypeCodes.$[c]": p.to } },
      { arrayFilters: [{ "g.key": p.groupKey }, { c: p.from }] },
    );
    if (r.modifiedCount === 1) written += 1;
    else {
      skipped += 1;
      console.log(`  SKIPPED (moved or already changed): ${p.iso2} ${p.groupKey} ${p.from}`);
    }
  }
  console.log(`\nAPPLIED — ${written} re-mapped, ${skipped} skipped.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
