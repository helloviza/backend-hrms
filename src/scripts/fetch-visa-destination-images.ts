// apps/backend/src/scripts/fetch-visa-destination-images.ts
//
// Populates VisaDestinationContent.imageCandidates for ops review — never
// heroImageUrl/thumbnailUrl directly. Those two only ever get set by a
// human, via the admin destination-content picker (routes/
// admin.visa.rules.ts's POST .../select-image or .../image-upload). An
// auto-selected top search result would eventually put a beer festival on
// a business visa page (task brief) — this script has no code path that
// could publish anything.
//
// Source: Pixabay — already integrated in this codebase (services/
// cityImage.service.ts, the SBT landing bento's city photos), reused here
// rather than adding a second image API. Two differences from that
// integration, both deliberate:
//   1. That one auto-accepts hit[0] on a live per-request cache miss. This
//      fetches several candidates (CANDIDATES_PER_DESTINATION below) in a
//      one-off batch run and stores ALL of them for review — nothing here
//      is ever called from a page load.
//   2. That one downloads only the single accepted hit. This downloads
//      BOTH Pixabay's previewURL (thumbnail-sized) and webformatURL/
//      largeImageURL (hero-sized) for EVERY candidate, so picking one in
//      the admin UI is a database write, not a second network fetch.
//
// Licence (Pixabay Content License, checked 2026-08-03 — see this
// repo's PR/task notes for the full research, not restated here):
// commercial use is free and attribution is not required, but Pixabay
// explicitly does NOT warrant that a photo's identifiable people, logos/
// trademarks, or well-known landmarks are cleared for use — that
// responsibility sits with us. `category=places` + a "landmark" query
// biases results toward scenery/skyline shots and away from people/
// events, matching cityImage.service.ts's own existing query shape — but
// that's a bias, not a guarantee, which is exactly why nothing here
// publishes automatically (task brief §2): a human looks at every
// candidate before it can reach a customer.
//
// Storage: every candidate is downloaded to OUR S3 the moment it's
// fetched (never hotlinked) — Pixabay's own webformatURL is only valid
// 24h, and per_page results aren't guaranteed stable across calls, so
// "fetch once, store forever" (task brief §1) means downloading
// candidates up front, not just the one that ends up selected.
//
// Contrast (2026-08-04 follow-up, gradient-scrim + per-theme revision same
// day): ops reviewing a raw, untreated thumbnail was judging a photo
// against text they can't see — the gradient scrim / 80% saturation the
// requirements hero applies (see RequirementsPage.tsx) doesn't guarantee
// 4.5:1 against every photo on its own, so every candidate's full-size
// image is run through utils/heroImageContrast.ts here, at fetch time,
// against the REAL treatment — gated against the worst of the thirteen
// retintable palettes (Ivory), not just the Midnight production default,
// since VisaThemePicker lets staff switch theme at runtime and a
// candidate must stay safe under any of them. A candidate below 4.5:1 is
// still stored (audit trail, not silently dropped) but flagged
// contrastStatus: "FAIL" — the admin picker disables it, and POST
// .../select-image refuses it server-side even if someone bypasses the
// UI. This runs in dry-run mode too (a read-only fetch, not a write) so
// `--iso2=XX` without `--commit` is still a fast way to see whether a
// destination has any passing candidates at all.
//
// Run:
//   DRY RUN (default) — queries Pixabay for real (so you can see candidate
//   counts) but uploads nothing and writes nothing:
//     pnpm -C apps/backend tsx src/scripts/fetch-visa-destination-images.ts
//   COMMIT — downloads candidates to S3 and writes imageCandidates:
//     pnpm -C apps/backend tsx src/scripts/fetch-visa-destination-images.ts --commit
//   --iso2=DE,US   limit to specific destinations (default: every
//                  destination with at least one PUBLISHED VisaRule)
//   --force        re-fetch even for a destination that already has a
//                  live heroImageUrl (default: skipped, so re-running
//                  this never disturbs an already-published image)
//
// Idempotent per destination: imageCandidates is REPLACED wholesale on
// each run for that destination, never appended — re-running doesn't
// grow the array, it just refreshes the review queue.

import "dotenv/config";
import mongoose from "mongoose";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { connectDb } from "../config/db.js";
import { env } from "../config/env.js";
import { s3 } from "../config/aws.js";
import VisaRule from "../models/VisaRule.js";
import VisaDestinationContent, { type VisaImageCandidate } from "../models/VisaDestinationContent.js";
import { getCountryByIso2 } from "../utils/countryCodes.js";
import { computeWorstCaseHeroContrast, MIN_HERO_CONTRAST } from "../utils/heroImageContrast.js";

const COMMIT = process.argv.includes("--commit");
const FORCE = process.argv.includes("--force");
const CANDIDATES_PER_DESTINATION = 6;

function argValue(flag: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.slice(flag.length + 3) : null;
}

function extFromContentType(ct: string | null): { ext: string; ct: string } {
  if (ct?.includes("png")) return { ext: "png", ct: "image/png" };
  if (ct?.includes("webp")) return { ext: "webp", ct: "image/webp" };
  return { ext: "jpg", ct: "image/jpeg" };
}

async function fetchBytes(srcUrl: string): Promise<{ buffer: Buffer; contentType: string | null } | null> {
  try {
    const resp = await fetch(srcUrl);
    if (!resp.ok) return null;
    return { buffer: Buffer.from(await resp.arrayBuffer()), contentType: resp.headers.get("content-type") };
  } catch (err: any) {
    console.warn(`    fetch failed for ${srcUrl}: ${err?.message}`);
    return null;
  }
}

async function storeBuffer(buffer: Buffer, contentType: string | null, key: string): Promise<string> {
  const { ext, ct } = extFromContentType(contentType);
  const fullKey = `${key}.${ext}`;
  await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: fullKey, Body: buffer, ContentType: ct }));
  return `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${fullKey}`;
}

async function fetchCandidates(iso2: string, countryName: string): Promise<VisaImageCandidate[]> {
  const q = encodeURIComponent(`${countryName} landmark`);
  const url =
    `https://pixabay.com/api/?key=${env.PIXABAY_API_KEY}&q=${q}` +
    `&image_type=photo&orientation=horizontal&category=places&safesearch=true&per_page=${CANDIDATES_PER_DESTINATION}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    console.warn(`  Pixabay query failed: HTTP ${resp.status}`);
    return [];
  }
  const data: any = await resp.json();
  const hits: any[] = Array.isArray(data?.hits) ? data.hits : [];

  const candidates: VisaImageCandidate[] = [];
  for (const hit of hits) {
    const previewSrc: string | undefined = hit.previewURL;
    const fullSrc: string | undefined = hit.largeImageURL || hit.webformatURL;
    if (!previewSrc || !fullSrc) continue;

    // Contrast is computed against real pixels regardless of dry-run —
    // this is a read-only fetch (no S3 write, no DB write), so it doesn't
    // break dry-run's "writes nothing" contract, and it's the whole point
    // of being able to preview a destination without --commit.
    const fullBytes = await fetchBytes(fullSrc);
    if (!fullBytes) {
      console.warn(`    hit ${hit.id} — couldn't download full image to check contrast, skipping`);
      continue;
    }
    const contrastRatio = await computeWorstCaseHeroContrast(fullBytes.buffer);
    const contrastStatus: "PASS" | "FAIL" = contrastRatio >= MIN_HERO_CONTRAST ? "PASS" : "FAIL";
    console.log(`    hit ${hit.id}: contrast ${contrastRatio.toFixed(2)}:1 (need ${MIN_HERO_CONTRAST}:1) — ${contrastStatus}`);

    if (!COMMIT) {
      // Dry run — report what a commit WOULD store, but these are still
      // live Pixabay URLs (webformatURL expires in 24h) and are never
      // written to the database in this branch.
      candidates.push({
        source: "pixabay",
        sourceId: String(hit.id),
        previewUrl: previewSrc,
        fullUrl: fullSrc,
        pixabayPageUrl: hit.pageURL,
        tags: hit.tags,
        status: "PENDING",
        fetchedAt: new Date(),
        contrastRatio,
        contrastStatus,
      });
      continue;
    }

    const previewBytes = await fetchBytes(previewSrc);
    if (!previewBytes) continue;

    const keyBase = `visa-destination-images/candidates/${iso2}/${hit.id}`;
    const [preview, full] = await Promise.all([
      storeBuffer(previewBytes.buffer, previewBytes.contentType, `${keyBase}-preview`),
      storeBuffer(fullBytes.buffer, fullBytes.contentType, `${keyBase}-full`),
    ]);

    candidates.push({
      source: "pixabay",
      sourceId: String(hit.id),
      previewUrl: preview,
      fullUrl: full,
      pixabayPageUrl: hit.pageURL,
      tags: hit.tags,
      status: "PENDING",
      fetchedAt: new Date(),
      contrastRatio,
      contrastStatus,
    });
  }
  return candidates;
}

async function main() {
  if (!env.PIXABAY_API_KEY) {
    console.error("PIXABAY_API_KEY is not set — nothing to do.");
    process.exit(1);
  }

  await connectDb();

  const isoFilter = argValue("iso2")
    ?.split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const allIso2: string[] = await VisaRule.distinct("destinationIso2", { status: "PUBLISHED" });
  const targets = (isoFilter ? allIso2.filter((iso2) => isoFilter.includes(iso2)) : allIso2).sort();

  if (targets.length === 0) {
    console.log("No destinations to process (no PUBLISHED VisaRule rows match).");
    await mongoose.disconnect();
    return;
  }

  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — ${targets.length} destination(s): ${targets.join(", ")}`);
  if (!COMMIT) {
    console.log("(dry run — queries Pixabay for real counts, but uploads/writes nothing; pass --commit to store)\n");
  }

  // Batch summary (2026-08-06) — the per-destination console lines above
  // always existed, but nothing rolled them up across a whole run. Ops
  // needs one number to decide "does this look right, safe to --commit?"
  // rather than reading N individual lines — and, separately, a named list
  // of destinations that came back with zero PASSING candidates, since
  // those are the ones no bulk picker click can resolve — they need a
  // manual upload, not a re-run.
  const skipped: string[] = [];
  const zeroPassDestinations: string[] = [];
  let totalCandidates = 0;
  let totalPass = 0;
  let totalFail = 0;

  for (const iso2 of targets) {
    const countryName = getCountryByIso2(iso2)?.name ?? iso2;

    const existing = await VisaDestinationContent.findOne({ destinationIso2: iso2 }).lean();
    if (existing?.heroImageUrl && !FORCE) {
      console.log(`${iso2} (${countryName}) — already has a live hero image, skipping (--force to re-fetch anyway)`);
      skipped.push(`${iso2} (${countryName})`);
      continue;
    }

    console.log(`${iso2} (${countryName}) — querying Pixabay...`);
    const candidates = await fetchCandidates(iso2, countryName);
    const passCount = candidates.filter((c) => c.contrastStatus === "PASS").length;
    console.log(
      `  ${candidates.length} candidate(s)${candidates.length === 0 ? " — nothing to review yet" : ` — ${passCount} pass contrast, ${candidates.length - passCount} fail`}.`,
    );

    totalCandidates += candidates.length;
    totalPass += passCount;
    totalFail += candidates.length - passCount;
    if (passCount === 0) zeroPassDestinations.push(`${iso2} (${countryName})`);

    if (!COMMIT || candidates.length === 0) continue;

    await VisaDestinationContent.findOneAndUpdate(
      { destinationIso2: iso2 },
      { $set: { imageCandidates: candidates }, $setOnInsert: { destinationIso2: iso2, status: "DRAFT" } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    console.log(`  Stored ${candidates.length} candidate(s) in S3 and wrote them for ops review.`);
  }

  const processed = targets.length - skipped.length;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`SUMMARY — ${COMMIT ? "COMMIT" : "DRY RUN"}`);
  console.log(`  ${targets.length} destination(s) targeted, ${skipped.length} already had a live image (skipped), ${processed} processed.`);
  console.log(`  ${totalCandidates} candidate(s) fetched across ${processed} destination(s) — ${totalPass} pass contrast, ${totalFail} fail.`);
  if (zeroPassDestinations.length > 0) {
    console.log(`  ${zeroPassDestinations.length} destination(s) with ZERO passing candidates — need a manual upload:`);
    for (const d of zeroPassDestinations) console.log(`    - ${d}`);
  } else if (processed > 0) {
    console.log("  Every processed destination has at least one passing candidate.");
  }
  console.log(`${"─".repeat(60)}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
