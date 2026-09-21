// apps/backend/src/workers/plumconnectEnrichmentWorker.ts
//
// PlumConnect Slice 8 — asynchronous Meta campaign enrichment.
//
// A CTWA referral carries ONE identifier: the ad id (Lead.attribution.
// sourceId / Conversation.referralRaw.source_id). The ad set, the campaign
// and every name live only in Meta's ad account and are resolved UPWARD
// from the ad id through the Graph API (ads_read). This worker does that
// resolution off the request path, in the repo's Mongo-collection-as-queue
// convention (expenseCaptureWorker / videoProcessingWorker shape): a
// setInterval tick, an atomic findOneAndUpdate claim, bounded batches.
//
// Two stages per tick:
//
//   1. DISCOVER   every distinct ad id on a Lead (attribution.sourceId) or a
//                 Conversation (referralRaw.source_id) with no Ad row gets
//                 one, `enrichment.status: "pending"`. This is the BACK-FILL
//                 (historical leads) and the ongoing feed (new leads) in one
//                 sweep; it needs no token and never touches the Lead.
//
//   2. ENRICH     claim one pending Ad whose nextAttemptAt has passed →
//                 GET /{ad-id}?fields=…,adset{…,campaign{…}} → upsert
//                 Campaign + AdSet, link the Ad, stamp lastEnrichedAt.
//
// Hard rules (the decisions this slice implements):
//   • NEVER on the capture path. Nothing here is awaited by the webhook or
//     the dispatcher; a lead exists with its raw ad id before this runs and
//     stays exactly as it is whether this runs or not.
//   • No token → stage 2 does not run; rows stay pending; zero errors.
//   • Graph unreachable (no HTTP response) → the row goes back to pending
//     with a short delay and NO attempt is consumed.
//   • Rate limited (HTTP 429 / Graph codes 4, 17, 32, 613, 80000-80014) →
//     no attempt consumed, the row waits RATE_LIMIT_BACKOFF_MS, and the
//     whole worker pauses until then (one signal is enough — every call
//     shares the token's budget).
//   • Any other Graph error (a deleted / invalid / unpermitted ad id) → one
//     attempt consumed, exponential backoff, and after MAX_ATTEMPTS the row
//     is "failed" with the last error kept — never retried forever.
//   • Idempotent: every write is an upsert keyed on Meta's id; a re-run of
//     an enriched ad refreshes names and stamps, never duplicates.
//
// Exported `runEnrichmentTick()` is the unit of work; the interval only
// calls it. Tests drive the tick directly with a fake Graph adapter.

import axios from "axios";
import mongoose from "mongoose";
import Lead from "../models/Lead.js";
import PlumConnectConversation from "../models/plumconnect/Conversation.js";
import PlumConnectAd from "../models/plumconnect/Ad.js";
import PlumConnectAdSet from "../models/plumconnect/AdSet.js";
import PlumConnectCampaign from "../models/plumconnect/Campaign.js";
import { env } from "../config/env.js";
import { adsReadToken, isPlumConnectEnabled } from "../config/plumconnect.js";
import { whatsappLogger } from "../utils/logger.js";

const POLL_INTERVAL_MS = 60_000;
export const BATCH_PER_TICK = 10;
export const MAX_ATTEMPTS = 4;
/** Backoff after a real failure, by attempt number (1-based). */
export const FAILURE_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
/** After a rate-limit signal: the row and the worker both wait this long. */
export const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
/** After a network error (no response): try again soon, no attempt consumed. */
export const NETWORK_BACKOFF_MS = 5 * 60_000;
/** A row stuck in "processing" this long (a crashed tick) is reclaimable. */
const STALE_CLAIM_MS = 10 * 60_000;
const GRAPH_BASE = "https://graph.facebook.com";
const GRAPH_TIMEOUT_MS = 20_000;
const AD_FIELDS = "id,name,effective_status,adset{id,name,effective_status,campaign{id,name,effective_status,objective,account_id}}";

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

let isRunning = false;
let pausedUntil = 0;
let ticking = false;

/* ───────────────────────────── stage 1: discovery ───────────────────────────── */

const ID_RE = /^\d{5,30}$/;

/**
 * Every ad id referenced by a lead or a conversation that has no Ad row yet
 * → one pending Ad row each. Upsert with $setOnInsert so a concurrent
 * discovery (or the same id seen on both a lead and a conversation) cannot
 * duplicate. Returns how many rows were created.
 */
export async function discoverAdIds(now: Date = new Date()): Promise<number> {
  const [fromLeads, fromConversations] = await Promise.all([
    Lead.distinct("attribution.sourceId", { "attribution.sourceId": { $nin: ["", null] } }) as Promise<unknown[]>,
    PlumConnectConversation.distinct("referralRaw.source_id", { "referralRaw.source_id": { $nin: ["", null] } }) as Promise<unknown[]>,
  ]);
  const seen = new Map<string, "lead" | "conversation">();
  for (const raw of fromConversations) {
    const id = String(raw ?? "").trim();
    if (ID_RE.test(id)) seen.set(id, "conversation");
  }
  for (const raw of fromLeads) {
    const id = String(raw ?? "").trim();
    if (ID_RE.test(id)) seen.set(id, "lead"); // a lead is the stronger record; it wins the label
  }
  if (seen.size === 0) return 0;

  const known = new Set((await PlumConnectAd.find({ metaId: { $in: [...seen.keys()] } }).select("metaId").lean()).map((a: any) => String(a.metaId)));
  let created = 0;
  for (const [metaId, discoveredFrom] of seen) {
    if (known.has(metaId)) continue;
    const r = await PlumConnectAd.updateOne(
      { metaId },
      { $setOnInsert: { metaId, discoveredFrom, firstSeenAt: now, enrichment: { status: "pending", attempts: 0, nextAttemptAt: now, claimedAt: null, lastError: "", lastErrorCode: "" } } },
      { upsert: true },
    );
    if (r.upsertedCount) created += 1;
  }
  if (created) whatsappLogger.info("PlumConnect enrichment: discovered ad ids", { created });
  return created;
}

/* ───────────────────────────── stage 2: enrichment ───────────────────────────── */

export interface GraphAdResponse {
  id: string;
  name?: string;
  effective_status?: string;
  adset?: {
    id: string;
    name?: string;
    effective_status?: string;
    campaign?: { id: string; name?: string; effective_status?: string; objective?: string; account_id?: string };
  };
}

/** One Graph read. Throws the axios error so the caller can classify it. */
async function fetchAd(metaId: string, token: string): Promise<GraphAdResponse> {
  const { data } = await axios.get(`${GRAPH_BASE}/${env.WA_GRAPH_VERSION}/${encodeURIComponent(metaId)}`, {
    params: { fields: AD_FIELDS, access_token: token },
    timeout: GRAPH_TIMEOUT_MS,
  });
  return data as GraphAdResponse;
}

type Failure = { kind: "rate_limit" | "network" | "error"; code: string; message: string };

/** Classify an axios / Graph error into what the queue should do with it. */
export function classifyGraphError(err: unknown): Failure {
  const anyErr = err as any;
  const response = anyErr?.response;
  if (!response) {
    return { kind: "network", code: String(anyErr?.code || "ENETWORK"), message: String(anyErr?.message || "no response") };
  }
  const graphErr = response.data?.error ?? {};
  const code = Number(graphErr.code);
  const status = Number(response.status);
  const message = String(graphErr.message || response.statusText || `HTTP ${status}`);
  const codeStr = String(Number.isFinite(code) ? code : status);
  if (status === 429 || RATE_LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014)) {
    return { kind: "rate_limit", code: codeStr, message };
  }
  return { kind: "error", code: codeStr, message };
}

/** Write the resolved tree: campaign, adset, then the ad's links. */
async function applyEnrichment(ad: { _id: mongoose.Types.ObjectId; metaId: string }, data: GraphAdResponse, now: Date): Promise<void> {
  const campaign = data.adset?.campaign;
  const adset = data.adset;

  let campaignRowId: mongoose.Types.ObjectId | null = null;
  if (campaign?.id) {
    const row: any = await PlumConnectCampaign.findOneAndUpdate(
      { metaId: String(campaign.id) },
      {
        $set: { name: String(campaign.name ?? ""), status: String(campaign.effective_status ?? ""), objective: String(campaign.objective ?? ""), accountId: String(campaign.account_id ?? ""), lastEnrichedAt: now, raw: campaign },
        $setOnInsert: { metaId: String(campaign.id) },
      },
      { upsert: true, new: true },
    ).lean();
    campaignRowId = row._id;
  }

  let adSetRowId: mongoose.Types.ObjectId | null = null;
  if (adset?.id) {
    const row: any = await PlumConnectAdSet.findOneAndUpdate(
      { metaId: String(adset.id) },
      {
        $set: { name: String(adset.name ?? ""), status: String(adset.effective_status ?? ""), campaignId: campaignRowId, metaCampaignId: String(campaign?.id ?? ""), lastEnrichedAt: now, raw: { ...adset, campaign: undefined } },
        $setOnInsert: { metaId: String(adset.id) },
      },
      { upsert: true, new: true },
    ).lean();
    adSetRowId = row._id;
  }

  await PlumConnectAd.updateOne(
    { _id: ad._id },
    {
      $set: {
        name: String(data.name ?? ""),
        status: String(data.effective_status ?? ""),
        adSetId: adSetRowId,
        metaAdSetId: String(adset?.id ?? ""),
        campaignId: campaignRowId,
        metaCampaignId: String(campaign?.id ?? ""),
        lastEnrichedAt: now,
        raw: { ...data, adset: undefined },
        "enrichment.status": "enriched",
        "enrichment.claimedAt": null,
        "enrichment.nextAttemptAt": null,
        "enrichment.lastError": "",
        "enrichment.lastErrorCode": "",
      },
    },
  );
}

export type EnrichOutcome = "enriched" | "rate_limited" | "network" | "retry_scheduled" | "failed" | "idle";

/**
 * Claim and enrich ONE pending ad. Returns what happened so the tick can
 * decide whether to continue (a rate limit stops the tick).
 */
export async function enrichOne(token: string, now: Date = new Date()): Promise<EnrichOutcome> {
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  const ad: any = await PlumConnectAd.findOneAndUpdate(
    {
      $or: [
        { "enrichment.status": "pending", $or: [{ "enrichment.nextAttemptAt": null }, { "enrichment.nextAttemptAt": { $lte: now } }] },
        { "enrichment.status": "processing", "enrichment.claimedAt": { $lte: staleBefore } },
      ],
    },
    { $set: { "enrichment.status": "processing", "enrichment.claimedAt": now } },
    { sort: { "enrichment.nextAttemptAt": 1, createdAt: 1 }, new: true },
  ).lean();
  if (!ad) return "idle";

  try {
    const data = await fetchAd(ad.metaId, token);
    await applyEnrichment(ad, data, now);
    whatsappLogger.info("PlumConnect enrichment: ad enriched", { metaId: ad.metaId, campaign: data.adset?.campaign?.id ?? null });
    return "enriched";
  } catch (err) {
    const failure = classifyGraphError(err);
    const attempts = Number(ad.enrichment?.attempts || 0);

    if (failure.kind === "rate_limit") {
      await PlumConnectAd.updateOne(
        { _id: ad._id },
        { $set: { "enrichment.status": "pending", "enrichment.claimedAt": null, "enrichment.nextAttemptAt": new Date(now.getTime() + RATE_LIMIT_BACKOFF_MS), "enrichment.lastError": failure.message, "enrichment.lastErrorCode": failure.code } },
      );
      pausedUntil = now.getTime() + RATE_LIMIT_BACKOFF_MS;
      whatsappLogger.warn("PlumConnect enrichment: Graph rate limit — pausing", { metaId: ad.metaId, code: failure.code, until: new Date(pausedUntil).toISOString() });
      return "rate_limited";
    }

    if (failure.kind === "network") {
      await PlumConnectAd.updateOne(
        { _id: ad._id },
        { $set: { "enrichment.status": "pending", "enrichment.claimedAt": null, "enrichment.nextAttemptAt": new Date(now.getTime() + NETWORK_BACKOFF_MS), "enrichment.lastError": failure.message, "enrichment.lastErrorCode": failure.code } },
      );
      whatsappLogger.warn("PlumConnect enrichment: Graph unreachable — will retry", { metaId: ad.metaId, code: failure.code });
      return "network";
    }

    const nextAttempts = attempts + 1;
    if (nextAttempts >= MAX_ATTEMPTS) {
      await PlumConnectAd.updateOne(
        { _id: ad._id },
        { $set: { "enrichment.status": "failed", "enrichment.attempts": nextAttempts, "enrichment.claimedAt": null, "enrichment.nextAttemptAt": null, "enrichment.lastError": failure.message, "enrichment.lastErrorCode": failure.code } },
      );
      whatsappLogger.warn("PlumConnect enrichment: ad marked failed", { metaId: ad.metaId, code: failure.code, attempts: nextAttempts, error: failure.message });
      return "failed";
    }
    const delay = FAILURE_BACKOFF_MS[Math.min(nextAttempts, FAILURE_BACKOFF_MS.length) - 1];
    await PlumConnectAd.updateOne(
      { _id: ad._id },
      { $set: { "enrichment.status": "pending", "enrichment.attempts": nextAttempts, "enrichment.claimedAt": null, "enrichment.nextAttemptAt": new Date(now.getTime() + delay), "enrichment.lastError": failure.message, "enrichment.lastErrorCode": failure.code } },
    );
    whatsappLogger.info("PlumConnect enrichment: retry scheduled", { metaId: ad.metaId, code: failure.code, attempts: nextAttempts, inMs: delay });
    return "retry_scheduled";
  }
}

/* ───────────────────────────── the tick ───────────────────────────── */

export interface TickResult {
  ran: boolean;
  discovered: number;
  enriched: number;
  failed: number;
  retried: number;
  paused: boolean;
}

const IDLE: TickResult = { ran: false, discovered: 0, enriched: 0, failed: 0, retried: 0, paused: false };

/**
 * One tick. Flag off → nothing. Flag on → discovery always; enrichment only
 * with a token and only while not paused by a rate limit. Never throws.
 */
export async function runEnrichmentTick(now: Date = new Date()): Promise<TickResult> {
  if (!isPlumConnectEnabled()) return IDLE;
  const result: TickResult = { ...IDLE, ran: true };
  try {
    result.discovered = await discoverAdIds(now);
  } catch (err) {
    whatsappLogger.error("PlumConnect enrichment: discovery failed", { error: err instanceof Error ? err.message : String(err) });
  }

  const token = adsReadToken();
  if (!token) return result;
  if (now.getTime() < pausedUntil) {
    result.paused = true;
    return result;
  }

  for (let i = 0; i < BATCH_PER_TICK; i += 1) {
    let outcome: EnrichOutcome;
    try {
      outcome = await enrichOne(token, now);
    } catch (err) {
      // A persistence error (not a Graph one): log and stop this tick; the
      // claimed row is reclaimed after STALE_CLAIM_MS.
      whatsappLogger.error("PlumConnect enrichment: tick step failed", { error: err instanceof Error ? err.message : String(err) });
      break;
    }
    if (outcome === "idle") break;
    if (outcome === "enriched") result.enriched += 1;
    else if (outcome === "failed") result.failed += 1;
    else if (outcome === "retry_scheduled" || outcome === "network") result.retried += 1;
    if (outcome === "rate_limited") {
      result.paused = true;
      break;
    }
  }
  return result;
}

/** Test hook: clear the rate-limit pause. */
export function __resetEnrichmentWorkerState(): void {
  pausedUntil = 0;
  ticking = false;
}

export function startPlumConnectEnrichmentWorker() {
  if (isRunning) return;
  isRunning = true;

  whatsappLogger.info("📣 PlumConnect enrichment worker started (idle unless PLUMCONNECT_ENABLED; enriches only with PLUMCONNECT_ADS_READ_TOKEN)");

  setInterval(async () => {
    if (ticking) return; // a slow Graph call must not overlap the next tick
    ticking = true;
    try {
      await runEnrichmentTick(new Date());
    } catch (err) {
      whatsappLogger.error("PlumConnect enrichment worker tick failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      ticking = false;
    }
  }, POLL_INTERVAL_MS);
}
