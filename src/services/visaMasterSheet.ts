// apps/backend/src/services/visaMasterSheet.ts
//
// THE UNIFIED MASTER SHEET — one row per PERSON, across three collections.
//
// ══════════════════════════════════════════════════════════════════════
// THE PROBLEM THIS SOLVES
// ══════════════════════════════════════════════════════════════════════
// Three collections hold three views of the same funnel and none of them
// knows about the others:
//
//   VisaScoreLead   — checked their odds. Usually has NO account, so no
//                     consumerId; keyed on email (see its header).
//   VisaD2CLead     — opened an application. Has a consumerId and, since
//                     2026-09-10, a denormalised email.
//   Consumer        — registered and may have done nothing at all.
//
// Read separately they answer three questions and none of the one that
// matters commercially: WHO are the people, and how far did each get. A
// person who checked Australia, started Thailand and paid for Vietnam is
// three rows in two collections; on this sheet they are one row, at their
// furthest rung, with three corridors.
//
// ── EMAIL IS THE JOIN KEY, BECAUSE IT IS THE ONLY ONE ────────────────
// consumerId cannot be it: the commonest score-check row has none. That is
// the whole reason VisaD2CLead gained its email copy — see that model.
//
// ── WHY $unionWith AND NOT THREE QUERIES MERGED IN NODE ──────────────
// Merging in Node means fetching every row of all three collections into
// process memory to group them, which is unbounded by construction and gets
// slower exactly as the funnel succeeds. The union groups, filters, counts
// and paginates in the database, and only a PAGE ever crosses the wire.
//
// ⚠ $unionWith needs MongoDB 4.4+, $sortArray needs 5.2+. Both are checked
// once per connection by aggregationCapabilities() below; the 5.2 feature
// has a Node fallback (it only ever runs over one page), the 4.4 one does
// not and is reported rather than silently producing a partial sheet.
//
// ══════════════════════════════════════════════════════════════════════
// MASKING IS SERVER-SIDE AND HAS EXACTLY ONE HOME
// ══════════════════════════════════════════════════════════════════════
// shapeRow() below is the only place a contact value is written into a
// response, and every surface — the row list, the expanded per-person
// signals, and the CSV export — goes through it. That is deliberate: the
// export is the surface where a leak matters most (it leaves the building
// as a file), and the only way to guarantee it honours the grant is to make
// it structurally incapable of formatting an unshaped row.
//
// The grant is consumerContactPII (models/UserPermission.ts). visaApplication
// gets you the SHEET; this gets you the CONTACT COLUMN. See the capability's
// own note for why it is a sibling and not a tier.
import mongoose from "mongoose";

import Consumer from "../models/Consumer.js";
import VisaD2CLead from "../models/VisaD2CLead.js";
import VisaScoreLead from "../models/VisaScoreLead.js";
import { RUNG, rungExpressionForLeadArm, rungLabel, type Rung } from "../models/visaMasterSheetRungs.js";
import { maskEmailAddress, maskPhoneNumber } from "../utils/piiMask.js";

/* ═════════════════════════════════════════════════════════════════════
 * CAPABILITY PRE-FLIGHT
 * ═════════════════════════════════════════════════════════════════════ */

export interface AggregationCapabilities {
  version: string;
  major: number;
  minor: number;
  /** $unionWith — 4.4+. Hard requirement; there is no two-arm fallback that
   *  would still be the unified sheet. */
  hasUnionWith: boolean;
  /** $sortArray — 5.2+. Soft: the winner-pick falls back to Node, which is
   *  cheap because it only ever runs over the rows of ONE page. */
  hasSortArray: boolean;
}

let cachedCapabilities: AggregationCapabilities | null = null;

/**
 * Ask the server what it can do, once per process.
 *
 * Cached because it cannot change under a live connection, and because this
 * runs on a read path a console polls. A failure to read buildInfo is
 * reported as the PESSIMISTIC answer (no $sortArray) rather than throwing —
 * an unavailable admin command must not take the sheet down when the Node
 * fallback would have served it correctly.
 */
export async function aggregationCapabilities(force = false): Promise<AggregationCapabilities> {
  if (cachedCapabilities && !force) return cachedCapabilities;

  let version = "0.0.0";
  try {
    const info: any = await mongoose.connection.db?.admin().command({ buildInfo: 1 });
    version = String(info?.version || "0.0.0");
  } catch {
    // Left at 0.0.0 — see the pessimistic-answer note above.
  }

  const [major = 0, minor = 0] = version.split(".").map((n) => Number.parseInt(n, 10) || 0);
  cachedCapabilities = {
    version,
    major,
    minor,
    hasUnionWith: major > 4 || (major === 4 && minor >= 4),
    hasSortArray: major > 5 || (major === 5 && minor >= 2),
  };
  return cachedCapabilities;
}

/** Test seam — the cache is per-process and tests swap servers. */
export function resetAggregationCapabilities(): void {
  cachedCapabilities = null;
}

/* ═════════════════════════════════════════════════════════════════════
 * FILTERS
 * ═════════════════════════════════════════════════════════════════════ */

export type FunnelFilter = "SCORE" | "APPLY" | "REGISTERED";

export interface MasterSheetFilters {
  /** Free text. What it searches depends on the reader — see the oracle note. */
  q?: string | null;
  /** Inclusive rung floor. `>= 0` is what omits the Consumer arm entirely. */
  rungMin?: number | null;
  rungMax?: number | null;
  /** ISO2 corridor the person touched in either funnel. */
  destination?: string | null;
  funnel?: FunnelFilter | null;
  sort?: "lastActivity" | "firstSeen" | "rung" | null;
  direction?: "asc" | "desc" | null;
  page?: number;
  pageSize?: number;
}

export interface MasterSheetOptions {
  /** Resolved ONCE per request by the route, from holdsCapability(). */
  canSeeContacts: boolean;
}

const MAX_PAGE_SIZE = 200;
const EXPORT_MAX_ROWS = 10_000;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ═════════════════════════════════════════════════════════════════════
 * THE PIPELINE
 * ═════════════════════════════════════════════════════════════════════ */

/**
 * Every arm projects to THIS shape and nothing else. The union is only
 * coherent because all three arms agree on it field-for-field — a field
 * present in one arm and absent in another silently becomes null after the
 * group, which is how a union quietly starts lying.
 *
 * `at` is activity time, `firstAt` is first-seen time; they differ on a
 * score row that was re-checked (firstCheckedAt vs lastCheckedAt) and that
 * difference is what lets one $group produce both columns.
 */
interface SignalProjection {
  email: unknown;
  rung: unknown;
  iso2: unknown;
  destinationName: unknown;
  funnel: unknown;
  name: unknown;
  at: unknown;
  firstAt: unknown;
  utm: unknown;
  utmPresent: unknown;
  utmAt: unknown;
  score: unknown;
  band: unknown;
  stage: unknown;
  status: unknown;
  paymentStatus: unknown;
  applicationId: unknown;
  referenceNumber: unknown;
  hadAccount: unknown;
}

/** True when any UTM member carries a value. Computed per arm so the
 *  first-touch pick can filter on a boolean instead of re-deriving it. */
function utmPresentExpr(): Record<string, unknown> {
  return {
    $gt: [
      {
        $strLenCP: {
          $concat: [
            { $ifNull: ["$utm.source", ""] },
            { $ifNull: ["$utm.medium", ""] },
            { $ifNull: ["$utm.campaign", ""] },
            { $ifNull: ["$utm.content", ""] },
            { $ifNull: ["$utm.term", ""] },
          ],
        },
      },
      0,
    ],
  };
}

/** Arm 1 — score checks. The ROOT of the union. */
function scoreArmProjection(): SignalProjection {
  return {
    // $toLower on every arm rather than trusting three schemas to agree
    // forever. The union key is the one thing that cannot afford drift.
    email: { $toLower: "$email" },
    rung: { $literal: RUNG.CHECKED_SCORE },
    iso2: "$destinationIso2",
    destinationName: "$destinationName",
    funnel: { $literal: "SCORE" },
    name: "$name",
    at: "$lastCheckedAt",
    firstAt: "$firstCheckedAt",
    utm: "$utm",
    utmPresent: utmPresentExpr(),
    utmAt: "$firstCheckedAt",
    score: "$score",
    band: "$band",
    stage: { $literal: null },
    status: { $literal: null },
    paymentStatus: { $literal: null },
    applicationId: { $literal: null },
    referenceNumber: { $literal: null },
    hadAccount: "$hadAccount",
  };
}

/** Arm 2 — applications. */
function leadArmProjection(): SignalProjection {
  return {
    email: { $toLower: "$email" },
    rung: rungExpressionForLeadArm(),
    iso2: "$destinationIso2",
    destinationName: "$destinationName",
    funnel: { $literal: "APPLY" },
    // VisaD2CLead carries no name — the person's name lives on Consumer and
    // is joined page-scoped. Explicitly null so the arm shapes agree.
    name: { $literal: null },
    at: { $ifNull: ["$submittedAt", "$updatedAt", "$startedAt"] },
    firstAt: "$startedAt",
    utm: "$utm",
    utmPresent: utmPresentExpr(),
    utmAt: "$startedAt",
    score: { $literal: null },
    band: { $literal: null },
    stage: "$stage",
    status: "$status",
    paymentStatus: "$paymentStatus",
    applicationId: "$applicationId",
    referenceNumber: "$referenceNumber",
    // A lead row only exists for someone who signed in, so by construction.
    hadAccount: { $literal: true },
  };
}

/**
 * Arm 3 — registered-and-nothing-else.
 *
 * ── iso2 IS $$REMOVE, NOT null, AND THAT IS THE WHOLE TRAP ───────────
 * $addToSet on a MISSING field contributes nothing; on a null it
 * contributes null, and the corridor count for a person who has merely
 * registered comes out as 1 — a corridor they never touched, on a sheet
 * whose entire purpose is counting corridors. $$REMOVE drops the field so
 * the set stays genuinely empty. B6 pins this.
 */
function consumerArmProjection(): SignalProjection {
  return {
    email: { $toLower: "$email" },
    rung: { $literal: RUNG.REGISTERED },
    iso2: "$$REMOVE",
    destinationName: "$$REMOVE",
    funnel: { $literal: "REGISTERED" },
    name: "$name",
    at: "$createdAt",
    firstAt: "$createdAt",
    utm: { $literal: null },
    utmPresent: { $literal: false },
    utmAt: { $literal: null },
    score: { $literal: null },
    band: { $literal: null },
    stage: { $literal: null },
    status: { $literal: null },
    paymentStatus: { $literal: null },
    applicationId: { $literal: null },
    referenceNumber: { $literal: null },
    hadAccount: { $literal: true },
  };
}

/**
 * Build the aggregation.
 *
 * Stage order is load-bearing and worth stating, because each stage exists
 * to keep the next one small:
 *
 *   1. root arm + $unionWith ×2   — one document per SIGNAL
 *   2. $group by email            — one document per PERSON
 *   3. $match                     — post-group, because every filter is
 *                                   about the PERSON (their furthest rung,
 *                                   the set of corridors they touched), and
 *                                   none of those facts exists before the
 *                                   group. Filtering earlier would filter
 *                                   signals and silently change what "how
 *                                   far did they get" means.
 *   4. $facet                     — rows / total / histogram from one pass
 *   5. $set over rows only        — the expensive per-person derivations
 *                                   (winner, first-touch) run over ONE PAGE,
 *                                   never over the whole funnel.
 */
export function buildMasterSheetPipeline(
  filters: MasterSheetFilters,
  caps: Pick<AggregationCapabilities, "hasSortArray">,
): any[] {
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(filters.pageSize) || 50));
  const rungMin = filters.rungMin ?? null;
  const rungMax = filters.rungMax ?? null;

  /* ── THE THIRD-ARM SKIP ────────────────────────────────────────────
   * A registered-only person is rung -1 BY DEFINITION, so any filter with
   * a floor at 0 or above cannot match one. Scanning the whole Consumer
   * collection to union in rows the very next $match is guaranteed to
   * discard is pure cost — and "rung >= 0" is the query ops actually runs
   * most (it is "people who did something"). Omitting the arm restores the
   * two-arm cost profile for exactly those reads. */
  const includeConsumerArm = rungMin === null || rungMin < RUNG.CHECKED_SCORE;

  const pipeline: any[] = [
    { $project: scoreArmProjection() as any },

    {
      $unionWith: {
        // .collection.name, never a string literal: the collection name is
        // the model's business (VisaScoreLead sets its own explicitly), and
        // a literal here is a rename away from silently unioning nothing.
        coll: VisaD2CLead.collection.name,
        pipeline: [
          // Legacy rows written before the email denormalisation cannot be
          // keyed to a person; grouping them under a common null would
          // invent a person. Excluded here and COUNTED separately by the
          // route, so the backfill's remaining work stays visible rather
          // than looking like an empty funnel.
          { $match: { email: { $type: "string", $ne: "" } } },
          { $project: leadArmProjection() as any },
        ],
      },
    },
  ];

  if (includeConsumerArm) {
    pipeline.push({
      $unionWith: {
        coll: Consumer.collection.name,
        pipeline: [
          { $match: { email: { $type: "string", $ne: "" } } },
          { $project: consumerArmProjection() as any },
        ],
      },
    });
  }

  /* ── ONE DOCUMENT PER PERSON ─────────────────────────────────────── */
  pipeline.push({
    $group: {
      _id: "$email",
      // FURTHEST PROGRESS. The whole ladder exists to make this one $max
      // meaningful across three vocabularies.
      rung: { $max: "$rung" },
      // $$REMOVE'd on the consumer arm — see consumerArmProjection.
      corridors: { $addToSet: "$iso2" },
      destinationNames: { $addToSet: "$destinationName" },
      names: { $addToSet: "$name" },
      firstSeen: { $min: "$firstAt" },
      lastActivity: { $max: "$at" },
      scoreCount: { $sum: { $cond: [{ $eq: ["$funnel", "SCORE"] }, 1, 0] } },
      applyCount: { $sum: { $cond: [{ $eq: ["$funnel", "APPLY"] }, 1, 0] } },
      hadAccount: { $max: { $cond: [{ $eq: ["$hadAccount", true] }, 1, 0] } },
      signals: {
        $push: {
          funnel: "$funnel",
          rung: "$rung",
          iso2: "$iso2",
          destinationName: "$destinationName",
          at: "$at",
          score: "$score",
          band: "$band",
          stage: "$stage",
          status: "$status",
          paymentStatus: "$paymentStatus",
          applicationId: "$applicationId",
          referenceNumber: "$referenceNumber",
          utm: "$utm",
          utmPresent: "$utmPresent",
          utmAt: "$utmAt",
        },
      },
    },
  });

  /* ── POST-GROUP FILTERS ──────────────────────────────────────────── */
  const match: Record<string, unknown> = {};
  if (rungMin !== null || rungMax !== null) {
    const r: Record<string, number> = {};
    if (rungMin !== null) r.$gte = rungMin;
    if (rungMax !== null) r.$lte = rungMax;
    match.rung = r;
  }
  if (filters.destination) {
    match.corridors = String(filters.destination).trim().toUpperCase();
  }
  if (filters.funnel === "SCORE") match.scoreCount = { $gt: 0 };
  if (filters.funnel === "APPLY") match.applyCount = { $gt: 0 };
  if (filters.funnel === "REGISTERED") match.rung = { ...(match.rung as any), $eq: RUNG.REGISTERED };

  if (filters.q && String(filters.q).trim()) {
    const rx = new RegExp(escapeRegex(String(filters.q).trim()), "i");
    /* ── THE SEARCH ORACLE, AND WHY THE EMAIL CLAUSE IS CONDITIONAL ──
     * A masked reader is shown "i•••@gmail.com". If q also searched email,
     * that reader could type a full address and learn from a single hit
     * whether that exact person is in the funnel — recovering the value the
     * mask exists to withhold, one guess at a time, with no rate limit and
     * no audit trail. A mask that can be interrogated is not a mask.
     *
     * So the email clause is added ONLY for a reader already entitled to
     * read addresses, for whom it discloses nothing new. Name and
     * destination stay searchable for everyone: they are on screen
     * unmasked, so searching them reveals nothing the row does not. */
    const or: any[] = [{ names: rx }, { destinationNames: rx }, { corridors: rx }];
    // NOTE: the caller injects the email clause — see applyEmailSearch().
    match.$or = or;
  }
  if (Object.keys(match).length) pipeline.push({ $match: match });

  /* ── PAGE / TOTAL / HISTOGRAM IN ONE PASS ────────────────────────── */
  const sortKey = filters.sort || "lastActivity";
  const dir = filters.direction === "asc" ? 1 : -1;
  // _id (the email) is the tiebreaker on EVERY sort, so paging is stable:
  // without it two people with the same lastActivity can swap between page
  // 1 and page 2 and a row is seen twice or never.
  const sort: Record<string, 1 | -1> = { [sortKey]: dir as 1 | -1, _id: 1 };

  pipeline.push({
    $facet: {
      rows: [{ $sort: sort }, { $skip: (page - 1) * pageSize }, { $limit: pageSize }],
      total: [{ $count: "n" }],
      // The histogram counts PEOPLE per rung over the filtered set, so it
      // always sums to `total` — B6 pins that, because a histogram that
      // disagrees with the row count is the classic $facet mistake (running
      // the branch against the unfiltered collection).
      funnel: [{ $group: { _id: "$rung", n: { $sum: 1 } } }, { $sort: { _id: 1 } }],
    },
  });

  /* ── PAGE-SCOPED DERIVATIONS ─────────────────────────────────────── */
  if (caps.hasSortArray) {
    pipeline.push({ $set: { rows: { $map: { input: "$rows", as: "r", in: pageDerivationsExpr() } } } });
  }

  return pipeline;
}

/**
 * winner + firstTouchUtm, as a Mongo expression over ONE row.
 *
 * winner = the signal that JUSTIFIES the person's rung. Not simply the
 * latest signal: the sheet's claim is "this is how far they got", so the
 * cell has to point at the thing that got them there. Ties (two corridors
 * both at the top rung) break on latest activity, then iso2 ascending —
 * total and deterministic, so the same data always renders the same cell.
 *
 * firstTouchUtm = the earliest signal that actually CARRIES tags. Skipping
 * the empty ones is the point: a person's first touch is often an untagged
 * score check followed by a tagged application, and taking the
 * chronologically-first signal regardless would report them as untagged
 * forever — the same first-touch mistake pages/helloviza/utm.ts guards
 * against on the client.
 */
function pageDerivationsExpr(): Record<string, unknown> {
  return {
    $mergeObjects: [
      "$$r",
      {
        winner: {
          $first: {
            $sortArray: {
              input: {
                $filter: { input: "$$r.signals", as: "s", cond: { $eq: ["$$s.rung", "$$r.rung"] } },
              },
              sortBy: { at: -1, iso2: 1 },
            },
          },
        },
        firstTouchUtm: {
          $getField: {
            field: "utm",
            input: {
              $ifNull: [
                {
                  $first: {
                    $sortArray: {
                      input: {
                        $filter: { input: "$$r.signals", as: "s", cond: { $eq: ["$$s.utmPresent", true] } },
                      },
                      sortBy: { utmAt: 1 },
                    },
                  },
                },
                { utm: null },
              ],
            },
          },
        },
      },
    ],
  };
}

/**
 * The same two derivations in Node, for a server below 5.2.
 *
 * Cheap because it is page-scoped by construction — it only ever sees the
 * rows $facet already limited. Exported so B6 can assert it agrees with the
 * Mongo expression rather than trusting that it does.
 */
export function applyPageDerivations<T extends Record<string, any>>(row: T): T {
  const signals: any[] = Array.isArray(row.signals) ? row.signals : [];

  const atTop = signals.filter((s) => s?.rung === row.rung);
  atTop.sort((a, b) => {
    const at = new Date(b?.at ?? 0).getTime() - new Date(a?.at ?? 0).getTime();
    if (at !== 0) return at;
    return String(a?.iso2 ?? "").localeCompare(String(b?.iso2 ?? ""));
  });

  const tagged = signals.filter((s) => s?.utmPresent === true);
  tagged.sort((a, b) => new Date(a?.utmAt ?? 0).getTime() - new Date(b?.utmAt ?? 0).getTime());

  return { ...row, winner: atTop[0] ?? null, firstTouchUtm: tagged[0]?.utm ?? null };
}

/* ═════════════════════════════════════════════════════════════════════
 * THE ONE SHAPING FUNCTION
 * ═════════════════════════════════════════════════════════════════════ */

export interface MasterSheetRow {
  email: string | null;
  name: string | null;
  phone: string | null;
  consumerId: string | null;
  hasAccount: boolean;
  rung: number;
  rungLabel: string;
  corridors: string[];
  corridorCount: number;
  firstSeen: Date | null;
  lastActivity: Date | null;
  scoreCount: number;
  applyCount: number;
  furthest: {
    funnel: string | null;
    iso2: string | null;
    destinationName: string | null;
    at: Date | null;
    stage: string | null;
    status: string | null;
    paymentStatus: string | null;
    score: number | null;
    band: string | null;
    referenceNumber: string | null;
    applicationId: string | null;
  } | null;
  firstTouchUtm: Record<string, string> | null;
  /** The drill-down. Same shaping call, so it cannot leak what the row hides. */
  signals: Array<Record<string, unknown>>;
}

/**
 * Raw aggregation row + page-scoped Consumer facts -> the response row.
 *
 * ⚠ THE ONLY PLACE A CONTACT VALUE IS WRITTEN INTO A RESPONSE. Rows,
 * drill-down and export all call this; nothing else may format a row. If a
 * future surface needs a different shape, it calls this and reshapes the
 * OUTPUT — it must not read the raw aggregation row, because the raw row
 * carries the unmasked address by construction.
 *
 * There is no `?unmask=` parameter and no sibling field carrying the raw
 * value beside the masked one — the same posture routes/admin.consumers.ts
 * takes, and for the same reason: a masked response with the real value one
 * field away has not masked anything.
 */
export function shapeRow(
  raw: any,
  account: { name?: string | null; phone?: string | null; consumerId?: string | null } | null,
  opts: MasterSheetOptions,
): MasterSheetRow {
  const full = opts.canSeeContacts;
  const email = raw?._id ?? null;

  // Name is NOT masked: it is the column that makes the sheet readable, and
  // it is not a channel — knowing a name does not let anyone contact them.
  // The grant is consumerContactPII, and a name is not a contact detail.
  const name =
    account?.name ??
    (Array.isArray(raw?.names) ? raw.names.find((n: unknown) => typeof n === "string" && n) : null) ??
    null;

  const w = raw?.winner ?? null;
  /* Sorted, because $addToSet is a SET and returns its members in no
   * guaranteed order — the same person can render [TH,AU] on one read and
   * [AU,TH] on the next. A column that reshuffles between refreshes reads
   * as data changing when nothing has, and it would make the CSV differ
   * from itself run to run for no reason. */
  const corridors: string[] = (Array.isArray(raw?.corridors) ? raw.corridors : [])
    .filter((c: unknown) => typeof c === "string" && c)
    .sort();

  return {
    email: full ? (email ?? null) : maskEmailAddress(email),
    name,
    phone: full ? (account?.phone ?? null) : maskPhoneNumber(account?.phone),
    consumerId: account?.consumerId ?? null,
    // Resolved LIVE from the page lookup, not from the denormalised
    // hadAccount flag: a person who checked a score anonymously and signed
    // up afterwards has hadAccount:false frozen on their score row, and the
    // sheet should say they have an account today.
    hasAccount: Boolean(account?.consumerId),
    rung: raw?.rung ?? RUNG.REGISTERED,
    rungLabel: rungLabel(raw?.rung ?? RUNG.REGISTERED),
    corridors,
    corridorCount: corridors.length,
    firstSeen: raw?.firstSeen ?? null,
    lastActivity: raw?.lastActivity ?? null,
    scoreCount: raw?.scoreCount ?? 0,
    applyCount: raw?.applyCount ?? 0,
    furthest: w
      ? {
          funnel: w.funnel ?? null,
          iso2: w.iso2 ?? null,
          destinationName: w.destinationName ?? null,
          at: w.at ?? null,
          stage: w.stage ?? null,
          status: w.status ?? null,
          paymentStatus: w.paymentStatus ?? null,
          score: w.score ?? null,
          band: w.band ?? null,
          referenceNumber: w.referenceNumber ?? null,
          applicationId: w.applicationId ? String(w.applicationId) : null,
        }
      : null,
    firstTouchUtm: raw?.firstTouchUtm ?? null,
    signals: (Array.isArray(raw?.signals) ? raw.signals : []).map((s: any) => ({
      funnel: s?.funnel ?? null,
      rung: s?.rung ?? null,
      rungLabel: rungLabel(s?.rung ?? RUNG.REGISTERED),
      iso2: s?.iso2 ?? null,
      destinationName: s?.destinationName ?? null,
      at: s?.at ?? null,
      score: s?.score ?? null,
      band: s?.band ?? null,
      stage: s?.stage ?? null,
      status: s?.status ?? null,
      paymentStatus: s?.paymentStatus ?? null,
      referenceNumber: s?.referenceNumber ?? null,
      applicationId: s?.applicationId ? String(s.applicationId) : null,
      utm: s?.utm ?? null,
    })),
  };
}

/* ═════════════════════════════════════════════════════════════════════
 * THE RUN
 * ═════════════════════════════════════════════════════════════════════ */

export interface MasterSheetResult {
  rows: MasterSheetRow[];
  total: number;
  page: number;
  pageSize: number;
  funnel: Array<{ rung: number; label: string; count: number }>;
  contactsMasked: boolean;
  /** VisaD2CLead rows with no email yet — the backfill's remaining work,
   *  surfaced rather than silently excluded. */
  legacyUnkeyedLeads: number;
  meta: { durationMs: number; mongoVersion: string; consumerArmIncluded: boolean; sortArrayUsed: boolean };
}

export async function runMasterSheet(
  filters: MasterSheetFilters,
  opts: MasterSheetOptions,
): Promise<MasterSheetResult> {
  const started = Date.now();
  const caps = await aggregationCapabilities();

  if (!caps.hasUnionWith) {
    // Reported, never worked around. A two-arm sheet would look like a
    // working sheet while silently omitting a whole population.
    throw new Error(
      `The Master Sheet needs MongoDB 4.4+ for $unionWith; this server reports ${caps.version}.`,
    );
  }

  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(filters.pageSize) || 50));

  const pipeline = buildMasterSheetPipeline({ ...filters, page, pageSize }, caps);
  applyEmailSearch(pipeline, filters, opts);

  const [facet] = await VisaScoreLead.aggregate(pipeline)
    // The union spans three collections and the group is unbounded by
    // construction; a sheet that dies at 100MB is a sheet that dies exactly
    // when the funnel starts working.
    .allowDiskUse(true);

  let rows: any[] = facet?.rows ?? [];
  if (!caps.hasSortArray) rows = rows.map(applyPageDerivations);

  const accounts = await lookupAccountsForPage(rows);
  const shaped = rows.map((r) => shapeRow(r, accounts.get(String(r?._id ?? "")) ?? null, opts));

  const legacyUnkeyedLeads = await VisaD2CLead.countDocuments({ email: { $exists: false } });

  return {
    rows: shaped,
    total: facet?.total?.[0]?.n ?? 0,
    page,
    pageSize,
    funnel: (facet?.funnel ?? []).map((f: any) => ({
      rung: f._id,
      label: rungLabel(f._id),
      count: f.n,
    })),
    contactsMasked: !opts.canSeeContacts,
    legacyUnkeyedLeads,
    meta: {
      durationMs: Date.now() - started,
      mongoVersion: caps.version,
      consumerArmIncluded: (filters.rungMin ?? null) === null || (filters.rungMin as number) < RUNG.CHECKED_SCORE,
      sortArrayUsed: caps.hasSortArray,
    },
  };
}

/**
 * Adds the email clause to the search $or — and ONLY for a reader entitled
 * to read addresses.
 *
 * Separate from buildMasterSheetPipeline so the rule has one home and so a
 * test can assert the negative directly: build the pipeline for a masked
 * reader and prove no stage anywhere mentions `_id` in a $or. A conditional
 * buried inside the builder would be much easier to accidentally invert.
 */
export function applyEmailSearch(pipeline: any[], filters: MasterSheetFilters, opts: MasterSheetOptions): void {
  if (!opts.canSeeContacts) return;
  const q = filters.q ? String(filters.q).trim() : "";
  if (!q) return;

  const stage = pipeline.find((s) => s?.$match?.$or);
  if (stage) stage.$match.$or.push({ _id: new RegExp(escapeRegex(q), "i") });
}

/**
 * Name / phone / consumerId for the emails ON THIS PAGE.
 *
 * ── WHY NOT A $lookup IN THE PIPELINE ────────────────────────────────
 * A $lookup would run per grouped person across the WHOLE funnel, to
 * populate a column that at most `pageSize` rows will ever display. This is
 * one indexed $in over at most 200 addresses, and it is also what keeps
 * `hasAccount` honest — see shapeRow.
 */
async function lookupAccountsForPage(
  rows: any[],
): Promise<Map<string, { name: string | null; phone: string | null; consumerId: string }>> {
  const emails = rows.map((r) => String(r?._id ?? "")).filter(Boolean);
  const out = new Map<string, { name: string | null; phone: string | null; consumerId: string }>();
  if (!emails.length) return out;

  const consumers = await Consumer.find({ email: { $in: emails } })
    .select("_id email name phone")
    .lean();

  for (const c of consumers as any[]) {
    out.set(String(c.email).toLowerCase(), {
      name: c.name ?? null,
      phone: c.phone ?? null,
      consumerId: String(c._id),
    });
  }
  return out;
}

/* ═════════════════════════════════════════════════════════════════════
 * EXPORT
 * ═════════════════════════════════════════════════════════════════════ */

const CSV_COLUMNS = [
  "Name",
  "Email",
  "Phone",
  "Has account",
  "Furthest rung",
  "Furthest stage",
  "Corridors",
  "Corridor count",
  "Score checks",
  "Applications",
  "First seen",
  "Last activity",
  "UTM source",
  "UTM medium",
  "UTM campaign",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = value instanceof Date ? value.toISOString() : String(value);
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
  // The sheet is exported to be opened in Excel by definition, so this is
  // not theoretical: an address or a name is untrusted text.
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * CSV over ALREADY-SHAPED rows.
 *
 * The signature is the guarantee: it takes MasterSheetRow[], which only
 * shapeRow() can produce, so the export cannot format a value the reader was
 * not entitled to see. Honouring the grant is structural here rather than a
 * rule someone has to remember.
 */
export function toCsv(rows: MasterSheetRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.name,
        r.email,
        r.phone,
        r.hasAccount ? "yes" : "no",
        r.rungLabel,
        r.furthest?.destinationName ?? r.furthest?.iso2 ?? "",
        r.corridors.join(" "),
        r.corridorCount,
        r.scoreCount,
        r.applyCount,
        r.firstSeen,
        r.lastActivity,
        r.firstTouchUtm?.source ?? "",
        r.firstTouchUtm?.medium ?? "",
        r.firstTouchUtm?.campaign ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

export const MASTER_SHEET_EXPORT_MAX_ROWS = EXPORT_MAX_ROWS;
