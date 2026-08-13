// apps/backend/src/scripts/auto-select-visa-destination-images.ts
//
// "Corridor card never imageless" (2026-08-07), backfill half. 33
// destinations already have contrast-passing candidates from
// fetch-visa-destination-images.ts but no live heroImageUrl — nobody has
// clicked one yet. This picks the single highest-contrast PASS candidate
// for each and writes it live, flagged heroImageAutoSelected: true
// (services/visaDestinationImageService.ts's autoSelectBestPassingCandidate
// — the same write path the publish-time trigger uses) so ops still sees
// it as unreviewed and can override it at any time. A manual pick (POST
// .../select-image or .../image-upload) always clears the flag.
//
// Only ever fills a genuinely empty heroImageUrl — never overwrites an
// existing live image, auto-selected or human-picked. Only ever picks a
// PASS candidate — a destination with zero passing candidates is left
// alone; it still needs a manual upload via the Bulk Images tab.
//
// Run:
//   DRY RUN (default) — reports what WOULD be selected, writes nothing:
//     pnpm -C apps/backend tsx src/scripts/auto-select-visa-destination-images.ts
//   COMMIT — actually writes heroImageUrl/thumbnailUrl/imageSource/heroImageAutoSelected:
//     pnpm -C apps/backend tsx src/scripts/auto-select-visa-destination-images.ts --commit

import "dotenv/config";
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import VisaDestinationContent from "../models/VisaDestinationContent.js";
import { pickBestPassingCandidate, autoSelectBestPassingCandidate } from "../services/visaDestinationImageService.js";

const COMMIT = process.argv.includes("--commit");

async function main() {
  await connectDb();

  // Every content row still missing a live image — the fetch script only
  // ever writes candidates, never heroImageUrl, so this is exactly the set
  // that's been sitting unselected since the last fetch run.
  const rows = await VisaDestinationContent.find({
    // Mongo's `field: null` already matches both "missing entirely" and
    // "explicitly null" — the empty-string arm covers a row some other
    // path saved with "" instead of unsetting the field.
    $or: [{ heroImageUrl: null }, { heroImageUrl: "" }],
  }).lean();

  const eligible = rows
    .map((row) => ({ row, best: pickBestPassingCandidate(row.imageCandidates || []) }))
    .filter((r): r is { row: (typeof rows)[number]; best: NonNullable<ReturnType<typeof pickBestPassingCandidate>> } =>
      Boolean(r.best),
    );
  const zeroPass = rows.length - eligible.length;

  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — ${rows.length} destination(s) missing an image.`);
  if (!COMMIT) {
    console.log("(dry run — reports what would be selected; pass --commit to write)\n");
  }

  for (const { row, best } of eligible) {
    console.log(
      `${row.destinationIso2} — would select sourceId ${best.sourceId} (${best.contrastRatio.toFixed(2)}:1, ${
        (row.imageCandidates || []).filter((c) => c.contrastStatus === "PASS").length
      } passing of ${(row.imageCandidates || []).length} total)`,
    );
  }

  let selectedCount = 0;
  if (COMMIT) {
    for (const { row } of eligible) {
      const result = await autoSelectBestPassingCandidate(row.destinationIso2);
      if (result.selected === true) {
        selectedCount += 1;
        console.log(`  ${row.destinationIso2} — selected (${result.contrastRatio.toFixed(2)}:1), flagged unreviewed.`);
      } else if (result.selected === false) {
        console.log(`  ${row.destinationIso2} — skipped (${result.reason}).`);
      }
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`SUMMARY — ${COMMIT ? "COMMIT" : "DRY RUN"}`);
  console.log(`  ${rows.length} destination(s) missing an image, ${eligible.length} had a passing candidate to auto-select.`);
  if (zeroPass > 0) {
    const names = rows
      .filter((r) => !pickBestPassingCandidate(r.imageCandidates || []))
      .map((r) => r.destinationIso2);
    console.log(`  ${zeroPass} destination(s) with NO passing candidate — still need a manual upload: ${names.join(", ")}`);
  }
  if (COMMIT) {
    console.log(`  ${selectedCount} destination(s) auto-selected and now live.`);
  }
  console.log(`${"─".repeat(60)}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
