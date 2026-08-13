// apps/backend/src/services/visaDestinationImageService.ts
//
// Shared core of the destination-image pipeline (2026-08-07 "never
// imageless" follow-up) — extracted out of
// scripts/fetch-visa-destination-images.ts so the exact same fetch/store/
// contrast-gate logic can be called from TWO places: that CLI script
// (dry-run by default, --commit to write) and, new in this phase, a live
// server-side trigger fired when a VisaRule is published for a destination
// with no image candidates yet (routes/admin.visa.rules.ts). Both paths
// share one implementation on purpose — there is exactly one way this
// codebase ever talks to Pixabay, never a second copy that could drift.
//
// Auto-SELECT is new here too, and is a deliberate departure from this
// module's own prior "nothing auto-publishes" posture (see the CLI
// script's header comment, still true for the FETCH half): a human no
// longer has to click before a corridor card can show a photo. What still
// gates it: the SAME deterministic contrast check every candidate has
// always gone through (utils/heroImageContrast.ts, gated against the
// worst of the thirteen retintable palettes) — only a candidate that
// already PASSES that gate is ever eligible for auto-selection. What's
// new is WHO clicks: code picks the single highest-contrast passing
// candidate instead of waiting for ops, and every auto-pick is flagged
// heroImageAutoSelected: true (VisaDestinationContent.ts) so ops still
// sees it as unreviewed and can override it at any time — a manual pick
// (POST .../select-image or .../image-upload) always clears the flag.
//
// Never called from the browser or on page render (task brief §3) — every
// export here either runs inside this Node process on a script invocation
// or is triggered server-side from routes/admin.visa.rules.ts's publish
// handlers, fire-and-forget so Pixabay latency/downtime never blocks that
// HTTP response. Images are always served from our own S3 afterward,
// never hotlinked, same as this module's fetch-time behaviour always was.

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";
import { s3 } from "../config/aws.js";
import VisaDestinationContent, { type VisaImageCandidate } from "../models/VisaDestinationContent.js";
import { computeWorstCaseHeroContrast, MIN_HERO_CONTRAST } from "../utils/heroImageContrast.js";
import logger from "../utils/logger.js";

const imageLogger = logger.child({ module: "visaDestinationImage" });

export const CANDIDATES_PER_DESTINATION = 6;

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
    imageLogger.warn("fetch failed", { srcUrl, message: err?.message });
    return null;
  }
}

async function storeBuffer(buffer: Buffer, contentType: string | null, key: string): Promise<string> {
  const { ext, ct } = extFromContentType(contentType);
  const fullKey = `${key}.${ext}`;
  await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: fullKey, Body: buffer, ContentType: ct }));
  return `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${fullKey}`;
}

// commit:false previews what a real run would find (dry-run mode: still
// queries Pixabay and runs the real contrast check against real pixels —
// only the S3 upload and DB write are skipped). commit:true downloads and
// stores every candidate to S3 immediately, per this module's own
// "fetch once, store forever" rule (Pixabay's webformatURL expires in 24h,
// per_page results aren't guaranteed stable across calls).
export async function fetchCandidatesForDestination(
  iso2: string,
  countryName: string,
  opts: { commit: boolean },
): Promise<VisaImageCandidate[]> {
  const q = encodeURIComponent(`${countryName} landmark`);
  const url =
    `https://pixabay.com/api/?key=${env.PIXABAY_API_KEY}&q=${q}` +
    `&image_type=photo&orientation=horizontal&category=places&safesearch=true&per_page=${CANDIDATES_PER_DESTINATION}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    imageLogger.warn("Pixabay query failed", { iso2, status: resp.status });
    return [];
  }
  const data: any = await resp.json();
  const hits: any[] = Array.isArray(data?.hits) ? data.hits : [];

  const candidates: VisaImageCandidate[] = [];
  for (const hit of hits) {
    const previewSrc: string | undefined = hit.previewURL;
    const fullSrc: string | undefined = hit.largeImageURL || hit.webformatURL;
    if (!previewSrc || !fullSrc) continue;

    // Contrast is computed against real pixels regardless of commit — a
    // read-only fetch, no S3/DB write — so dry-run still previews real
    // PASS/FAIL counts.
    const fullBytes = await fetchBytes(fullSrc);
    if (!fullBytes) continue;
    const contrastRatio = await computeWorstCaseHeroContrast(fullBytes.buffer);
    const contrastStatus: "PASS" | "FAIL" = contrastRatio >= MIN_HERO_CONTRAST ? "PASS" : "FAIL";

    if (!opts.commit) {
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

// Idempotent per destination — imageCandidates is REPLACED wholesale, never
// appended (re-running refreshes the review queue, doesn't grow it).
export async function storeCandidatesForDestination(iso2: string, candidates: VisaImageCandidate[]): Promise<void> {
  if (candidates.length === 0) return;
  await VisaDestinationContent.findOneAndUpdate(
    { destinationIso2: iso2 },
    { $set: { imageCandidates: candidates }, $setOnInsert: { destinationIso2: iso2, status: "DRAFT" } },
    { upsert: true, setDefaultsOnInsert: true },
  );
}

export function pickBestPassingCandidate(candidates: VisaImageCandidate[]): VisaImageCandidate | null {
  let best: VisaImageCandidate | null = null;
  for (const c of candidates) {
    if (c.contrastStatus !== "PASS") continue;
    if (!best || c.contrastRatio > best.contrastRatio) best = c;
  }
  return best;
}

export type AutoSelectResult =
  | { selected: true; sourceId: string; contrastRatio: number }
  | { selected: false; reason: "already-has-image" | "no-content-row" | "no-passing-candidate" };

// The single write path for an AUTOMATIC selection — never called for a
// human pick (that's POST .../select-image / .../image-upload in
// routes/admin.visa.rules.ts, which write heroImageAutoSelected: false
// instead). Never overwrites an existing heroImageUrl — auto-select only
// ever fills a genuinely empty slot, exactly like a human ops pick would
// only ever be reached for a destination missing one.
export async function autoSelectBestPassingCandidate(iso2: string): Promise<AutoSelectResult> {
  const content = await VisaDestinationContent.findOne({ destinationIso2: iso2 });
  if (!content) return { selected: false, reason: "no-content-row" };
  if (content.heroImageUrl) return { selected: false, reason: "already-has-image" };

  const best = pickBestPassingCandidate(content.imageCandidates || []);
  if (!best) return { selected: false, reason: "no-passing-candidate" };

  content.heroImageUrl = best.fullUrl;
  content.thumbnailUrl = best.previewUrl;
  content.imageSource = { provider: "pixabay", sourceId: best.sourceId, pixabayPageUrl: best.pixabayPageUrl };
  content.heroImageAutoSelected = true;
  await content.save();

  return { selected: true, sourceId: best.sourceId, contrastRatio: best.contrastRatio };
}

// Fetch (commit) + auto-select in one call — what both the publish-time
// trigger and (optionally) an ops "fetch now" action would use. Never
// throws; every failure mode (no API key, Pixabay down, zero candidates,
// zero passing) just means the destination stays on the watermark plate
// and shows up in the Bulk Images tab for manual upload, exactly as if
// this function had never run.
export async function fetchAndAutoSelectForDestination(iso2: string, countryName: string): Promise<AutoSelectResult> {
  if (!env.PIXABAY_API_KEY) {
    imageLogger.warn("PIXABAY_API_KEY not set — skipping auto-fetch", { iso2 });
    return { selected: false, reason: "no-passing-candidate" };
  }
  try {
    const candidates = await fetchCandidatesForDestination(iso2, countryName, { commit: true });
    await storeCandidatesForDestination(iso2, candidates);
    const result = await autoSelectBestPassingCandidate(iso2);
    imageLogger.info("publish-time auto-fetch complete", { iso2, candidateCount: candidates.length, result });
    return result;
  } catch (err: any) {
    imageLogger.error("publish-time auto-fetch failed", { iso2, message: err?.message });
    return { selected: false, reason: "no-passing-candidate" };
  }
}

// In-flight guard — synchronous check-and-add (no `await` before the Set
// mutation) so two rules for the same destination published in the same
// bulk-publish loop can never both pass the guard and fire two concurrent
// fetches. Per-process only (not distributed), which is fine here: a
// duplicate fetch would just re-run the same idempotent replace, never
// corrupt anything — this is a cost optimisation, not a correctness
// requirement.
const inFlightIso2 = new Set<string>();

// The publish-route entry point. Callers MUST NOT `await` this in the
// request/response path — call it and let it run, e.g.
// `void triggerAutoFetchForDestination(iso2, name)` — so a slow or down
// Pixabay never delays the publish response (task brief §2). Internally
// awaits its own quick DB existence check before deciding whether there's
// anything to do, but that's a local Mongo read, not a Pixabay round trip.
export async function triggerAutoFetchForDestination(iso2: string, countryName: string): Promise<void> {
  if (inFlightIso2.has(iso2)) return;
  inFlightIso2.add(iso2);
  try {
    const existing = await VisaDestinationContent.findOne({ destinationIso2: iso2 })
      .select("heroImageUrl imageCandidates")
      .lean();
    if (existing?.heroImageUrl) return; // already has a live image — nothing to do
    if ((existing?.imageCandidates?.length ?? 0) > 0) return; // already has candidates — the bulk picker/auto-select backfill owns this one, not a fresh fetch
    await fetchAndAutoSelectForDestination(iso2, countryName);
  } catch (err: any) {
    imageLogger.error("triggerAutoFetchForDestination failed", { iso2, message: err?.message });
  } finally {
    inFlightIso2.delete(iso2);
  }
}
