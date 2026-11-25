// apps/backend/src/services/travelPolicy.service.ts
//
// Travel Policy module — every DB read/write (docs/audits/travel-policy-audit.md).
// Routes (routes/travelPolicy.ts) resolve WHO is acting and WHICH workspace,
// then call these with an explicit workspaceId; nothing here trusts a
// workspace id from the request body.
//
// Pure rules (validation, tier resolution, precedence, dates) live in
// services/travelPolicy/core.ts.
import mongoose from "mongoose";
import TravelPolicyVersion, { type ITravelPolicyVersion, type PolicyActor } from "../models/TravelPolicyVersion.js";
import TravelPolicyCity from "../models/TravelPolicyCity.js";
import TravelPolicyTierAssignment from "../models/TravelPolicyTierAssignment.js";
import TravelPolicyAudit, { type TravelPolicyAuditAction } from "../models/TravelPolicyAudit.js";
import TravellerProfile from "../models/TravellerProfile.js";
import Department from "../models/Department.js";
import Designation from "../models/Designation.js";
import ExpenseBand from "../models/ExpenseBand.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import logger from "../utils/logger.js";
import { DOMESTIC_BASES, readDomesticBasis, type DomesticBasis } from "./policyCompliance/evaluate.js";
import { ISO_COUNTRIES, ISO_CURRENCIES, isIsoCountry } from "../data/isoCodes.js";
import { TEMPLATE_CITIES, TEMPLATE_RULES, TEMPLATE_TIERS, TEMPLATE_VERSION } from "../data/travelPolicyTemplate.js";
import {
  CATEGORIES,
  CITY_CLASSES,
  CITY_CLASS_LABEL,
  MAX_AMOUNT,
  NOT_COMPARED,
  PolicyInputError,
  REGIONS,
  SOFT_LIMITS,
  addDays,
  cityKeyOf,
  diffContent,
  gapLines,
  isIsoDate,
  istToday,
  normalizeKey,
  pickVersionAt,
  policyGaps,
  resolveTier,
  samePolicy,
  sanitizeDraft,
  validateForPublish,
  valueWarnings,
  versionState,
  windowsOverlap,
  type CityClass,
  type DraftContent,
  type DraftLists,
  type Gap,
  type Rule,
  type Tier,
  type TierResolution,
} from "./travelPolicy/core.js";

type Oid = mongoose.Types.ObjectId;
const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export class TravelPolicyError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    public code?: string,
  ) {
    super(message);
  }
}

/* ── Audit ────────────────────────────────────────────────────────────── */

const MAX_AUDIT_CHANGES = 4500;

export async function appendAudit(entry: {
  workspaceId: Oid;
  action: TravelPolicyAuditAction;
  entity: "VERSION" | "CITY" | "ASSIGNMENT" | "TRAVELLER" | "ORG";
  entityId?: string;
  version?: Pick<ITravelPolicyVersion, "_id" | "versionNumber"> | null;
  categories?: string[];
  summary: string;
  changes?: { category: string; field: string; from: unknown; to: unknown }[];
  reason?: string;
  actor: PolicyActor;
  session?: mongoose.ClientSession;
}): Promise<void> {
  try {
    const ws: any = await CustomerWorkspace.findById(entry.workspaceId).select("companyName").lean();
    // 30 tiers + 2000 rules, each at most removed and added once: nothing a
    // draft can do exceeds this, and it stays far under Mongo's 16 MB.
    const all = entry.changes ?? [];
    const changes = all.slice(0, MAX_AUDIT_CHANGES);
    const omitted = all.length - changes.length;
    const categories = entry.categories ?? Array.from(new Set(changes.map((c) => c.category)));
    await TravelPolicyAudit.create(
      [
        {
          workspaceId: entry.workspaceId,
          workspaceName: ws?.companyName || "",
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId ?? (entry.version ? String(entry.version._id) : ""),
          versionId: entry.version ? String(entry.version._id) : null,
          versionNumber: entry.version?.versionNumber ?? null,
          categories,
          summary: omitted ? `${entry.summary} — ${omitted} more changes not listed` : entry.summary,
          changes,
          reason: (entry.reason ?? "").slice(0, 1000),
          actor: entry.actor,
        },
      ],
      entry.session ? { session: entry.session } : undefined,
    );
  } catch (err: any) {
    // Inside a transaction a failed audit write must fail the transaction.
    if (entry.session) throw err;
    logger.error("[travelPolicy] audit write failed", { message: err?.message, action: entry.action });
  }
}

/** Actions that are about a version as a whole: always found under the "Version" filter, whatever categories they touched. */
const VERSION_ACTIONS: TravelPolicyAuditAction[] = [
  "DRAFT_CREATED",
  "DRAFT_DISCARDED",
  "VERSION_PUBLISHED",
  "VERSION_CLOSED",
  "VERSION_REOPENED",
  "VERSION_REPLACED",
  "VERSION_CANCELLED",
];

export const AUDIT_PAGE = 100;

/**
 * One page of the audit log, newest first. `before` is the `next` of the
 * previous page. `hideVersionId` leaves out the open draft's rows for people
 * who may not see the draft itself.
 */
export async function listAudit(
  workspaceId: Oid,
  f: { category?: string; actor?: string; versionId?: string; from?: string; to?: string; limit?: number; before?: string; hideVersionId?: string | null },
) {
  const q: any = { workspaceId };
  const and: any[] = [];
  const category = f.category ? String(f.category).toUpperCase() : "";
  if (category === "VERSION") and.push({ $or: [{ categories: "VERSION" }, { action: { $in: VERSION_ACTIONS } }] });
  else if (category) q.categories = category;
  if (f.versionId && mongoose.isValidObjectId(f.versionId)) q.versionId = String(f.versionId);
  if (f.hideVersionId) and.push({ versionId: { $ne: String(f.hideVersionId) } });
  if (f.actor) q["actor.id"] = String(f.actor);
  const range: any = {};
  if (f.from && isIsoDate(f.from)) range.$gte = new Date(`${f.from}T00:00:00+05:30`);
  if (f.to && isIsoDate(f.to)) range.$lt = new Date(`${addDays(f.to, 1)}T00:00:00+05:30`);
  if (Object.keys(range).length) q.createdAt = range;
  const [beforeAt, beforeId] = String(f.before ?? "").split("|");
  if (beforeAt && mongoose.isValidObjectId(beforeId) && !Number.isNaN(new Date(beforeAt).getTime())) {
    const at = new Date(beforeAt);
    and.push({ $or: [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: oid(beforeId) } }] });
  }
  if (and.length) q.$and = and;
  const limit = Math.min(Math.max(Number(f.limit) || AUDIT_PAGE, 1), 1000);
  const found: any[] = await TravelPolicyAudit.find(q).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
  const rows = found.slice(0, limit);
  const last = rows[rows.length - 1];
  const actors = await TravelPolicyAudit.aggregate([
    { $match: { workspaceId } },
    { $sort: { createdAt: 1 } },
    { $group: { _id: "$actor.id", name: { $last: "$actor.name" }, email: { $last: "$actor.email" }, kind: { $last: "$actor.kind" } } },
    { $sort: { name: 1 } },
  ]);
  return {
    rows,
    next: found.length > limit && last ? `${new Date(last.createdAt).toISOString()}|${String(last._id)}` : null,
    actors: actors.map((a) => ({ id: a._id, name: a.name, email: a.email, kind: a.kind })),
  };
}

/* ── Versions ─────────────────────────────────────────────────────────── */

function contentOf(v: Pick<ITravelPolicyVersion, "name" | "changeSummary" | "effectiveFrom" | "tiers" | "rules">): DraftContent {
  const plain = (x: any) => JSON.parse(JSON.stringify(x ?? []));
  return {
    name: v.name || "",
    changeSummary: v.changeSummary || "",
    effectiveFrom: v.effectiveFrom ?? null,
    tiers: plain(v.tiers),
    rules: plain(v.rules),
  };
}

export function summarizeVersion(v: any, today: string) {
  return {
    _id: String(v._id),
    status: v.status,
    state: versionState(v, today),
    versionNumber: v.versionNumber ?? null,
    name: v.name || "",
    changeSummary: v.changeSummary || "",
    effectiveFrom: v.effectiveFrom ?? null,
    effectiveTo: v.effectiveTo ?? null,
    tierCount: (v.tiers || []).filter((t: Tier) => t.active).length,
    ruleCount: (v.rules || []).length,
    source: v.source,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
    updatedBy: v.updatedBy,
    updatedAt: v.updatedAt,
    publishedBy: v.publishedBy,
    publishedAt: v.publishedAt,
    archivedBy: v.archivedBy,
    archivedAt: v.archivedAt,
    archiveReason: v.archiveReason || "",
    archiveKind: v.archiveKind ?? (v.status === "ARCHIVED" ? "CANCELLED" : null),
    replacedByVersion: v.replacedByVersion ?? null,
  };
}

export async function listVersions(workspaceId: Oid) {
  const rows = await TravelPolicyVersion.find({ workspaceId }).sort({ versionNumber: -1, createdAt: -1 }).lean();
  // The draft has no number yet, so the database sorts it last; people look for it first.
  return rows.sort((a, b) => Number(b.status === "DRAFT") - Number(a.status === "DRAFT"));
}

/** The version in force on `day` (IST), or null = Not configured. Never falls back to the template. */
export async function resolveVersionAt(workspaceId: Oid, day: string) {
  const rows = await TravelPolicyVersion.find({ workspaceId, status: "PUBLISHED", effectiveFrom: { $lte: day } })
    .lean();
  return pickVersionAt(rows, day);
}

export async function getVersion(workspaceId: Oid, id: string) {
  if (!mongoose.isValidObjectId(id)) throw new TravelPolicyError(404, "Version not found");
  const v = await TravelPolicyVersion.findOne({ _id: oid(id), workspaceId }).lean();
  if (!v) throw new TravelPolicyError(404, "Version not found");
  return v;
}

async function getDraft(workspaceId: Oid) {
  return TravelPolicyVersion.findOne({ workspaceId, status: "DRAFT" }).lean();
}

/** The workspace's city list as the rule sanitiser needs it. */
async function draftLists(workspaceId: Oid, session?: mongoose.ClientSession): Promise<Required<DraftLists>> {
  const cities: any[] = await TravelPolicyCity.find({ workspaceId }).select("name nameKey cityKey").session(session ?? null).lean();
  return { cityKeys: new Set(cities.map(cityKeyOf)), cityNames: new Map(cities.map((c) => [cityKeyOf(c), c.name])) };
}

/** Build the starting content for a new draft. `note` is anything the person should be told about it. */
async function startingContent(
  workspaceId: Oid,
  from: string,
  versionId?: string,
): Promise<{ content: DraftContent; source: ITravelPolicyVersion["source"]; note?: string }> {
  const today = istToday();
  if (from === "TEMPLATE") {
    return {
      content: { name: "", changeSummary: "Started from the Plumtrips default template", effectiveFrom: null, tiers: TEMPLATE_TIERS, rules: TEMPLATE_RULES },
      source: { kind: "TEMPLATE", versionId: null, templateVersion: TEMPLATE_VERSION },
    };
  }
  if (from === "BLANK") {
    return { content: { name: "", changeSummary: "", effectiveFrom: null, tiers: [], rules: [] }, source: { kind: "BLANK" } };
  }
  if (from === "VERSION" || from === "CURRENT") {
    let base: any = null;
    if (from === "VERSION") base = versionId ? await getVersion(workspaceId, versionId) : null;
    else
      base =
        (await resolveVersionAt(workspaceId, today)) ??
        (await TravelPolicyVersion.findOne({ workspaceId, status: "PUBLISHED" }).sort({ versionNumber: -1 }).lean());
    if (!base || base.status === "DRAFT") throw new TravelPolicyError(400, "There is no published version to copy");
    const c = contentOf(base);
    return {
      content: { ...c, name: "", changeSummary: "", effectiveFrom: null },
      source: { kind: "VERSION", versionId: String(base._id) },
    };
  }
  if (from === "EXPENSE_BANDS") {
    // Audit §2 migration path: one tier per configured band, its caps as rules.
    const bands: any[] = await ExpenseBand.find({ workspaceId }).sort({ bandNumber: 1 }).lean();
    const withCaps = bands.filter((b) => (b.maxFlightFarePerPerson ?? 0) > 0 || (b.maxHotelFarePerNight ?? 0) > 0);
    if (!withCaps.length) throw new TravelPolicyError(400, "This workspace has no Expense Band travel caps to import");
    const bandTitle = (b: any) => (b.bandName && String(b.bandName).trim()) || `Band L${Number(b.bandNumber)}`;
    const skipped = bands.filter((b) => !withCaps.includes(b)).map((b) => {
      const code = `L${Number(b.bandNumber)}`;
      const name = String(b.bandName ?? "").trim();
      return name && name.toUpperCase() !== code ? `${code} (${name})` : code;
    });
    const note = skipped.length ? `Skipped ${skipped.join(", ")}: no travel caps set. Add a tier for ${skipped.length === 1 ? "it" : "them"} if needed.` : "";
    const tiers: Tier[] = [];
    const rules: Rule[] = [];
    withCaps.forEach((b, i) => {
      const n = Number(b.bandNumber);
      const key = `band-${n}`;
      const title = bandTitle(b);
      tiers.push({
        tierKey: key,
        // Two bands may carry the same name; two tiers may not.
        name: tiers.some((t) => t.name.toLowerCase() === title.toLowerCase()) ? `${title} (L${n})` : title,
        code: `L${n}`,
        description: `Imported from Expense Band L${n}`,
        sortOrder: i,
        active: true,
        designationIds: [],
        bandNumbers: [n],
      });
      const ccy = b.currency || "INR";
      const fare = (b.maxFlightFarePerPerson ?? 0) > 0 ? Number(b.maxFlightFarePerPerson) : null;
      const night = (b.maxHotelFarePerNight ?? 0) > 0 ? Number(b.maxHotelFarePerNight) : null;
      if (fare != null) {
        rules.push({
          ruleKey: `${key}-flight`, category: "FLIGHT", tierKey: key, scope: { kind: "DEFAULT", value: null }, currency: ccy,
          notes: "Imported from Expense Bands — the same cap applied to domestic and international; review before publishing.",
          params: { allowedCabins: [], maxFareDomestic: fare, maxFareInternational: fare, minAdvanceDaysDomestic: null, minAdvanceDaysInternational: null, fareLimitBasis: "ONE_WAY" },
        });
      }
      if (night != null) {
        for (const cls of CITY_CLASSES) {
          rules.push({
            ruleKey: `${key}-hotel-${cls.toLowerCase()}`, category: "HOTEL", tierKey: key, scope: { kind: "CITY_CLASS", value: cls }, currency: ccy,
            notes: "Imported from Expense Bands — one cap for every city class.",
            params: { maxPerNight: night, taxesIncluded: true, maxStarRating: null },
          });
        }
      }
    });
    return {
      content: { name: "", changeSummary: ["Imported from Expense Band travel caps.", note].filter(Boolean).join(" "), effectiveFrom: null, tiers, rules },
      source: { kind: "EXPENSE_BANDS" },
      note,
    };
  }
  throw new TravelPolicyError(400, `Unknown starting point "${from}"`);
}

async function sourceText(workspaceId: Oid, source: ITravelPolicyVersion["source"]): Promise<string> {
  if (source.kind === "TEMPLATE") return "from the Plumtrips template";
  if (source.kind === "EXPENSE_BANDS") return "imported from Expense Bands";
  if (source.kind === "BLANK") return "blank";
  const v: any = source.versionId ? await TravelPolicyVersion.findOne({ _id: oid(source.versionId), workspaceId }).select("versionNumber").lean() : null;
  return v?.versionNumber ? `copy of v${v.versionNumber}` : "copy of a published version";
}

export async function createDraft(workspaceId: Oid, actor: PolicyActor, opts: { from: string; versionId?: string }) {
  if (await getDraft(workspaceId)) throw new TravelPolicyError(409, "A draft already exists — open it, or discard it first", undefined, "DRAFT_EXISTS");
  const { content, source, note } = await startingContent(workspaceId, String(opts.from || "").toUpperCase(), opts.versionId);
  let doc;
  try {
    doc = await TravelPolicyVersion.create({
      workspaceId,
      status: "DRAFT",
      versionNumber: null,
      ...content,
      source,
      createdBy: actor,
      updatedBy: actor,
    });
  } catch (err: any) {
    if (err?.code === 11000) throw new TravelPolicyError(409, "A draft already exists — open it, or discard it first", undefined, "DRAFT_EXISTS");
    throw err;
  }
  // Every starting point needs the Metro / Tier-2 list: without it every Indian city counts as Other.
  const citiesSeeded = await seedCitiesIfEmpty(workspaceId, actor);
  await appendAudit({
    workspaceId,
    action: "DRAFT_CREATED",
    entity: "VERSION",
    version: doc,
    categories: ["VERSION"],
    summary: `Draft created: ${await sourceText(workspaceId, source)}${note ? `. ${note}` : ""}`,
    actor,
  });
  return { ...doc.toObject(), notice: [note, citiesSeeded ? `The Plumtrips city list was added (${citiesSeeded} cities).` : ""].filter(Boolean).join(" ") };
}

/** `body` over `before`: a field the caller leaves out keeps its current value. */
function mergeContent(before: DraftContent, body: any): any {
  const src = body && typeof body === "object" ? body : {};
  const merged: any = { ...before };
  for (const k of ["name", "changeSummary", "effectiveFrom", "tiers", "rules"] as const) if (k in src) merged[k] = src[k];
  return merged;
}

export async function saveDraft(
  workspaceId: Oid,
  actor: PolicyActor,
  body: any,
  opts: { baseUpdatedAt?: string | null; reason?: string } = {},
) {
  const draft = await getDraft(workspaceId);
  if (!draft) throw new TravelPolicyError(404, "There is no draft to save. Create a new version first", undefined, "DRAFT_GONE");
  if (opts.baseUpdatedAt && new Date(opts.baseUpdatedAt).getTime() !== new Date(draft.updatedAt).getTime()) {
    throw new TravelPolicyError(409, "Someone else saved this draft since you opened it.", undefined, "DRAFT_CHANGED");
  }
  const before = contentOf(draft as any);
  const lists = await draftLists(workspaceId);
  const next = sanitizeDraft(mergeContent(before, body), lists);
  const changes = diffContent(before, next, lists.cityNames);
  const updated = await TravelPolicyVersion.findOneAndUpdate(
    { _id: draft._id, workspaceId, status: "DRAFT", updatedAt: draft.updatedAt },
    { $set: { ...next, updatedBy: actor } },
    { new: true },
  ).lean();
  if (!updated) throw new TravelPolicyError(409, "The draft was saved, published or discarded by someone else just now.", undefined, "DRAFT_CHANGED");
  if (changes.length) {
    await appendAudit({
      workspaceId,
      action: "DRAFT_SAVED",
      entity: "VERSION",
      version: updated as any,
      summary: `Draft saved (${changes.length} change${changes.length === 1 ? "" : "s"})`,
      changes,
      reason: opts.reason,
      actor,
    });
  }
  return updated;
}

export async function discardDraft(workspaceId: Oid, actor: PolicyActor, reason?: string) {
  const draft = await getDraft(workspaceId);
  if (!draft) throw new TravelPolicyError(404, "There is no draft to discard");
  await TravelPolicyVersion.deleteOne({ _id: draft._id, workspaceId, status: "DRAFT" });
  await appendAudit({
    workspaceId,
    action: "DRAFT_DISCARDED",
    entity: "VERSION",
    version: draft as any,
    categories: ["VERSION"],
    summary: "Draft discarded",
    reason,
    actor,
  });
}

async function knownDesignationIds(workspaceId: Oid): Promise<Set<string>> {
  const rows = await Designation.find({ workspaceId }).select("_id").lean();
  return new Set(rows.map((r: any) => String(r._id)));
}

const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * May `v` (in force since today) be replaced today? Returns a reason why not,
 * or null.
 *
 * TODO(Phase 3): refuse when any booking or expense was already evaluated
 * against `v` (TravelPolicyEvaluation.versionId === v._id): those snapshots
 * say the version applied, so it can no longer be set aside.
 */
async function sameDayReplaceProblem(_v: any, _session?: mongoose.ClientSession): Promise<string | null> {
  return null;
}

/** The last published version on the timeline, which decides the first date a new one may start. */
async function latestPublished(workspaceId: Oid, session?: mongoose.ClientSession): Promise<any> {
  return TravelPolicyVersion.findOne({ workspaceId, status: "PUBLISHED" }).sort({ effectiveFrom: -1 }).session(session ?? null).lean();
}

/** The first date a new version may start, and why when it is not today. */
export function earliestPublish(latest: { versionNumber?: number | null; effectiveFrom?: string | null } | null, today: string): { date: string; reason: string; replacesVersion: number | null } {
  if (!latest?.effectiveFrom || latest.effectiveFrom < today) return { date: today, reason: "", replacesVersion: null };
  if (latest.effectiveFrom === today) {
    return { date: today, reason: `v${latest.versionNumber} started today. Publishing today replaces it.`, replacesVersion: latest.versionNumber ?? null };
  }
  const date = addDays(latest.effectiveFrom, 1);
  return { date, reason: `v${latest.versionNumber} is scheduled from ${fmtDay(latest.effectiveFrom)}. To start earlier, cancel it first.`, replacesVersion: null };
}

async function dateProblems(workspaceId: Oid, from: string | null | undefined, today: string, session?: mongoose.ClientSession) {
  if (!from || !isIsoDate(from)) return ["Choose an effective-from date"];
  const problems: string[] = [];
  if (from < today) problems.push(`The effective date cannot be in the past (today is ${fmtDay(today)})`);
  const latest = await latestPublished(workspaceId, session);
  if (!latest) return problems;
  const sameDay = from === today && latest.effectiveFrom === today;
  if (sameDay) {
    const why = await sameDayReplaceProblem(latest, session);
    if (why) problems.push(why);
  } else if (from <= latest.effectiveFrom) {
    problems.push(
      latest.effectiveFrom > today
        ? `v${latest.versionNumber} is scheduled from ${fmtDay(latest.effectiveFrom)}. The effective date must be after v${latest.versionNumber}'s start, or cancel v${latest.versionNumber} first`
        : `The effective date must be after v${latest.versionNumber}'s start (${fmtDay(latest.effectiveFrom)})`,
    );
  }
  return problems;
}

/** Everything that decides whether this content can go live on `from`. Shared by preview and publish so they cannot disagree. */
async function publishChecks(workspaceId: Oid, content: DraftContent, from: string | null | undefined, today: string, cityNames: Map<string, string>, session?: mongoose.ClientSession) {
  const problems = [...validateForPublish(content, await knownDesignationIds(workspaceId)), ...(await dateProblems(workspaceId, from, today, session))];
  const latest = await latestPublished(workspaceId, session);
  if (latest && samePolicy(content, contentOf(latest))) problems.push(`Nothing has changed since v${latest.versionNumber}`);
  const gaps = policyGaps(content);
  return { problems, gaps, gapLines: gapLines(gaps), warnings: valueWarnings(content, cityNames) };
}

/**
 * The Preview: what would change, and whether it can be published. Checks the
 * content on screen when it is sent (nothing is saved), else the saved draft.
 */
export async function previewPublish(workspaceId: Oid, effectiveFrom: string | null | undefined, today = istToday(), body?: any) {
  const draft: any = await getDraft(workspaceId);
  if (!draft) throw new TravelPolicyError(404, "There is no draft");
  const lists = await draftLists(workspaceId);
  const before = contentOf(draft);
  let content = before;
  const invalid: string[] = [];
  try {
    content = sanitizeDraft(body ? mergeContent(before, body) : before, lists);
  } catch (err) {
    if (!(err instanceof PolicyInputError)) throw err;
    invalid.push(...err.errors);
  }
  const from = effectiveFrom || content.effectiveFrom;
  const checks = await publishChecks(workspaceId, content, from, today, lists.cityNames);
  const active: any = await resolveVersionAt(workspaceId, today);
  const scheduled: any[] = await TravelPolicyVersion.find({ workspaceId, status: "PUBLISHED", effectiveFrom: { $gt: today } }).sort({ effectiveFrom: -1 }).limit(1).lean();
  const against = [active && { v: active, kind: "IN_FORCE" as const }, scheduled[0] && { v: scheduled[0], kind: "SCHEDULED" as const }].filter(Boolean) as { v: any; kind: "IN_FORCE" | "SCHEDULED" }[];
  return {
    problems: [...invalid, ...checks.problems],
    gaps: checks.gapLines,
    warnings: checks.warnings,
    earliest: earliestPublish(await latestPublished(workspaceId), today),
    compare: (against.length ? against : [{ v: null, kind: "NONE" as const }]).map(({ v, kind }) => ({
      kind,
      versionNumber: v?.versionNumber ?? null,
      effectiveFrom: v?.effectiveFrom ?? null,
      changes: diffContent(v ? contentOf(v) : { tiers: [], rules: [] }, content, lists.cityNames).filter((c) => c.category !== "VERSION"),
    })),
  };
}

export async function publishDraft(
  workspaceId: Oid,
  actor: PolicyActor,
  opts: {
    effectiveFrom?: string | null;
    reason?: string;
    changeSummary?: string;
    baseUpdatedAt?: string | null;
    /** Unsaved edits, saved and published as one step: a refused publish changes nothing. */
    content?: any;
    acknowledgeGaps?: boolean;
    confirmValues?: boolean;
  },
  today = istToday(),
) {
  const session = await mongoose.startSession();
  let published: any = null;
  try {
    await session.withTransaction(async () => {
      const draft: any = await TravelPolicyVersion.findOne({ workspaceId, status: "DRAFT" }).session(session).lean();
      if (!draft) throw new TravelPolicyError(404, "There is no draft to publish", undefined, "DRAFT_GONE");
      if (opts.baseUpdatedAt && new Date(opts.baseUpdatedAt).getTime() !== new Date(draft.updatedAt).getTime()) {
        throw new TravelPolicyError(409, "Someone else saved this draft since you opened it.", undefined, "DRAFT_CHANGED");
      }
      const lists = await draftLists(workspaceId, session);
      const before = contentOf(draft);
      const effectiveFrom = opts.effectiveFrom || (opts.content && opts.content.effectiveFrom) || draft.effectiveFrom;
      const next = sanitizeDraft(
        {
          ...mergeContent(before, opts.content),
          effectiveFrom,
          ...(opts.changeSummary !== undefined ? { changeSummary: String(opts.changeSummary) } : {}),
        },
        lists,
      );
      const checks = await publishChecks(workspaceId, next, effectiveFrom, today, lists.cityNames, session);
      const problems = [...checks.problems];
      if (!next.changeSummary) problems.push("Say what changed in this version (change summary)");
      if (problems.length) throw new TravelPolicyError(400, "This draft cannot be published yet", problems, "NOT_PUBLISHABLE");
      if (checks.gapLines.length && opts.acknowledgeGaps !== true) {
        throw new TravelPolicyError(400, "Confirm that you understand the gaps before publishing", checks.gapLines.map((g) => g.text), "GAPS_NOT_ACKNOWLEDGED");
      }
      if (checks.warnings.length && opts.confirmValues !== true) {
        throw new TravelPolicyError(400, "Confirm the unusual values before publishing", checks.warnings.map((w) => w.text), "VALUES_NOT_CONFIRMED");
      }

      const maxRow: any = await TravelPolicyVersion.findOne({ workspaceId, versionNumber: { $type: "number" } })
        .sort({ versionNumber: -1 })
        .session(session)
        .lean();
      const versionNumber = (maxRow?.versionNumber ?? 0) + 1;

      const saved = diffContent(before, next, lists.cityNames).filter((c) => !(c.category === "VERSION" && c.field === "effectiveFrom"));
      if (saved.length) {
        await appendAudit({
          workspaceId,
          action: "DRAFT_SAVED",
          entity: "VERSION",
          version: draft,
          summary: `Draft saved while publishing (${saved.length} change${saved.length === 1 ? "" : "s"})`,
          changes: saved,
          reason: opts.reason,
          actor,
          session,
        });
      }

      const open: any = await TravelPolicyVersion.findOne({ workspaceId, status: "PUBLISHED", effectiveTo: null }).session(session).lean();
      if (open && open.effectiveFrom === effectiveFrom && effectiveFrom === today) {
        // Same-day correction: the version that started today gives way entirely.
        const now = new Date();
        await TravelPolicyVersion.updateOne(
          { _id: open._id, workspaceId, status: "PUBLISHED", effectiveTo: null },
          { $set: { status: "ARCHIVED", archivedBy: actor, archivedAt: now, archiveReason: replacedLabel(versionNumber, now), archiveKind: "REPLACED_SAME_DAY", replacedByVersion: versionNumber } },
          { session, tpInternal: true } as any,
        );
        await appendAudit({
          workspaceId,
          action: "VERSION_REPLACED",
          entity: "VERSION",
          version: open,
          categories: ["VERSION"],
          summary: `v${open.versionNumber}: ${replacedLabel(versionNumber, now)}`,
          changes: [
            { category: "VERSION", field: "status", from: "PUBLISHED", to: "ARCHIVED" },
            { category: "VERSION", field: "replacedByVersion", from: null, to: versionNumber },
          ],
          reason: opts.reason,
          actor,
          session,
        });
      } else if (open) {
        // Close the open-ended latest version the day before.
        const closeOn = addDays(effectiveFrom, -1);
        await TravelPolicyVersion.updateOne(
          { _id: open._id, workspaceId, status: "PUBLISHED", effectiveTo: null },
          { $set: { effectiveTo: closeOn } },
          { session, tpInternal: true } as any,
        );
        await appendAudit({
          workspaceId,
          action: "VERSION_CLOSED",
          entity: "VERSION",
          version: open,
          summary: `v${open.versionNumber} ends ${fmtDay(closeOn)} (superseded by v${versionNumber})`,
          changes: [{ category: "VERSION", field: "effectiveTo", from: null, to: closeOn }],
          reason: opts.reason,
          actor,
          session,
        });
      }

      // Overlap guard — re-checked inside the transaction.
      const others: any[] = await TravelPolicyVersion.find({ workspaceId, status: "PUBLISHED" }).session(session).lean();
      const mine = { effectiveFrom, effectiveTo: null };
      const clash = others.find((o) => windowsOverlap(o, mine));
      if (clash) {
        throw new TravelPolicyError(409, `The new window overlaps v${clash.versionNumber} (${fmtDay(clash.effectiveFrom)} – ${clash.effectiveTo ? fmtDay(clash.effectiveTo) : "open"})`, undefined, "OVERLAP");
      }

      published = await TravelPolicyVersion.findOneAndUpdate(
        { _id: draft._id, workspaceId, status: "DRAFT", updatedAt: draft.updatedAt },
        { $set: { ...next, status: "PUBLISHED", versionNumber, effectiveFrom, effectiveTo: null, publishedBy: actor, publishedAt: new Date(), updatedBy: actor } },
        { new: true, session },
      ).lean();
      if (!published) throw new TravelPolicyError(409, "The draft changed while publishing. Reload and try again.", undefined, "DRAFT_CHANGED");
      await appendAudit({
        workspaceId,
        action: "VERSION_PUBLISHED",
        entity: "VERSION",
        version: published,
        categories: ["VERSION", ...Array.from(new Set((published.rules || []).map((r: Rule) => r.category)))] as string[],
        summary: `v${versionNumber} published, effective ${fmtDay(effectiveFrom)}${effectiveFrom > today ? " (scheduled)" : ""}`,
        changes: [
          { category: "VERSION", field: "status", from: "DRAFT", to: "PUBLISHED" },
          ...(draft.effectiveFrom === effectiveFrom ? [] : [{ category: "VERSION", field: "effectiveFrom", from: draft.effectiveFrom ?? null, to: effectiveFrom }]),
          ...checks.gapLines.map((g) => ({ category: "VERSION", field: "gapAcknowledged", from: null, to: g.text })),
          ...checks.warnings.map((w) => ({ category: "VERSION", field: "valueConfirmed", from: null, to: w.text })),
        ],
        reason: opts.reason,
        actor,
        session,
      });
    });
  } catch (err: any) {
    if (err?.code === 11000) throw new TravelPolicyError(409, "Another publish happened at the same time. Reload and try again.");
    throw err;
  } finally {
    await session.endSession();
  }
  return published;
}

/** "Replaced same day at 19:20 (IST) by v2" */
export function replacedLabel(byVersion: number, at: Date): string {
  const hhmm = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
  return `Replaced same day at ${hhmm} (IST) by v${byVersion}`;
}

/** Cancel a version that is published but not yet in force (archive it, give its window back). */
export async function cancelScheduled(workspaceId: Oid, actor: PolicyActor, versionId: string, reason: string, today = istToday()) {
  if (!String(reason || "").trim()) throw new TravelPolicyError(400, "A reason is required to cancel a scheduled version");
  const session = await mongoose.startSession();
  let out: any = null;
  try {
    await session.withTransaction(async () => {
      if (!mongoose.isValidObjectId(versionId)) throw new TravelPolicyError(404, "Version not found");
      const v: any = await TravelPolicyVersion.findOne({ _id: oid(versionId), workspaceId }).session(session).lean();
      if (!v) throw new TravelPolicyError(404, "Version not found");
      if (versionState(v, today) !== "SCHEDULED") {
        throw new TravelPolicyError(400, "Only a scheduled version (not yet in force) can be cancelled");
      }
      // The version that ends the day before this one starts gets this window back.
      const prev: any = await TravelPolicyVersion.findOne({
        workspaceId,
        status: "PUBLISHED",
        effectiveTo: addDays(v.effectiveFrom, -1),
      })
        .session(session)
        .lean();
      out = await TravelPolicyVersion.findOneAndUpdate(
        { _id: v._id, workspaceId, status: "PUBLISHED" },
        { $set: { status: "ARCHIVED", archivedBy: actor, archivedAt: new Date(), archiveReason: String(reason).slice(0, 1000), archiveKind: "CANCELLED" } },
        { new: true, session, tpInternal: true } as any,
      ).lean();
      await appendAudit({
        workspaceId,
        action: "VERSION_CANCELLED",
        entity: "VERSION",
        version: v,
        summary: `Scheduled v${v.versionNumber} (from ${fmtDay(v.effectiveFrom)}) cancelled`,
        changes: [{ category: "VERSION", field: "status", from: "PUBLISHED", to: "ARCHIVED" }],
        reason,
        actor,
        session,
      });
      if (prev) {
        await TravelPolicyVersion.updateOne(
          { _id: prev._id, workspaceId, status: "PUBLISHED" },
          { $set: { effectiveTo: v.effectiveTo ?? null } },
          { session, tpInternal: true } as any,
        );
        await appendAudit({
          workspaceId,
          action: "VERSION_REOPENED",
          entity: "VERSION",
          version: prev,
          summary: `v${prev.versionNumber} now runs ${v.effectiveTo ? "to " + fmtDay(v.effectiveTo) : "until superseded"}`,
          changes: [{ category: "VERSION", field: "effectiveTo", from: prev.effectiveTo, to: v.effectiveTo ?? null }],
          reason,
          actor,
          session,
        });
      }
    });
  } finally {
    await session.endSession();
  }
  return out;
}

/* ── Cities ───────────────────────────────────────────────────────────── */

export async function listCities(workspaceId: Oid) {
  return TravelPolicyCity.find({ workspaceId }).sort({ category: 1, name: 1 }).lean();
}

export async function seedCitiesIfEmpty(workspaceId: Oid, actor: PolicyActor): Promise<number> {
  const n = await TravelPolicyCity.countDocuments({ workspaceId });
  if (n > 0) return 0;
  const docs = TEMPLATE_CITIES.map((c) => ({ ...c, workspaceId, nameKey: normalizeKey(c.name), cityKey: normalizeKey(c.name), isActive: true }));
  try {
    await TravelPolicyCity.insertMany(docs, { ordered: false });
  } catch (err: any) {
    if (err?.code !== 11000 && !err?.writeErrors) throw err; // a concurrent seed wins; ignore its duplicates
  }
  await appendAudit({
    workspaceId,
    action: "CITIES_SEEDED",
    entity: "CITY",
    categories: ["CITY"],
    summary: `City list seeded from the Plumtrips template (${docs.filter((d) => d.category === "METRO").length} Metro, ${docs.filter((d) => d.category === "TIER2").length} Tier-2)`,
    actor,
  });
  return docs.length;
}

function cleanCity(body: any, partial: boolean) {
  const errors: string[] = [];
  const out: any = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? "").trim().slice(0, 80);
    if (!name) errors.push("City name is required");
    out.name = name;
    out.nameKey = normalizeKey(name);
  }
  if (!partial || body.category !== undefined) {
    const c = String(body.category ?? "").toUpperCase();
    if (!CITY_CLASSES.includes(c as CityClass)) errors.push(`Category must be one of ${CITY_CLASSES.map((x) => CITY_CLASS_LABEL[x]).join(", ")}`);
    out.category = c;
  }
  if (!partial || body.country !== undefined) {
    const c = String(body.country ?? "IN").trim().toUpperCase();
    if (!isIsoCountry(c)) errors.push(`"${c}" is not a country code`);
    out.country = c;
  }
  if (body.code !== undefined) out.code = String(body.code ?? "").trim().toUpperCase().slice(0, 8);
  if (body.state !== undefined) out.state = String(body.state ?? "").trim().slice(0, 80);
  if (body.isActive !== undefined) out.isActive = body.isActive === true;
  if (out.country && out.category && out.country !== "IN" && out.category !== "INTERNATIONAL") {
    errors.push("A city outside India is always International");
  }
  if (out.country === "IN" && out.category === "INTERNATIONAL") errors.push("A city in India cannot be International");
  if (errors.length) throw new TravelPolicyError(400, errors.join("; "), errors);
  return out;
}

/** A key no other city of this workspace has ever held: a renamed city keeps its own, so the name's key may be taken. */
async function freshCityKey(workspaceId: Oid, nameKey: string): Promise<string> {
  const taken = new Set((await TravelPolicyCity.find({ workspaceId }).select("cityKey nameKey").lean()).map((c: any) => cityKeyOf(c)));
  let key = nameKey;
  for (let n = 2; taken.has(key); n++) key = `${nameKey} ${n}`;
  return key;
}

export async function createCity(workspaceId: Oid, actor: PolicyActor, body: any) {
  const data = cleanCity(body, false);
  try {
    const doc = await TravelPolicyCity.create({ workspaceId, isActive: true, code: "", state: "", ...data, cityKey: await freshCityKey(workspaceId, data.nameKey) });
    await appendAudit({
      workspaceId,
      action: "CITY_CREATED",
      entity: "CITY",
      entityId: String(doc._id),
      categories: ["CITY"],
      summary: `${doc.name} added as ${CITY_CLASS_LABEL[doc.category as CityClass]}`,
      changes: [{ category: "CITY", field: doc.name, from: null, to: { category: doc.category, code: doc.code, state: doc.state, country: doc.country } }],
      actor,
    });
    return doc.toObject();
  } catch (err: any) {
    if (err?.code === 11000) throw new TravelPolicyError(409, "That city is already in the list");
    throw err;
  }
}

export async function updateCity(workspaceId: Oid, actor: PolicyActor, id: string, body: any) {
  if (!mongoose.isValidObjectId(id)) throw new TravelPolicyError(404, "City not found");
  const before: any = await TravelPolicyCity.findOne({ _id: oid(id), workspaceId }).lean();
  if (!before) throw new TravelPolicyError(404, "City not found");
  const data = cleanCity({ country: before.country, category: before.category, ...body }, true);
  try {
    const after: any = await TravelPolicyCity.findOneAndUpdate({ _id: before._id, workspaceId }, { $set: data }, { new: true }).lean();
    const changes = ["name", "code", "state", "country", "category", "isActive"]
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => ({ category: "CITY", field: `${before.name} · ${k}`, from: before[k] ?? null, to: after[k] ?? null }));
    if (changes.length) {
      await appendAudit({
        workspaceId,
        action: "CITY_UPDATED",
        entity: "CITY",
        entityId: String(before._id),
        categories: ["CITY"],
        summary: `${after.name} updated`,
        changes,
        reason: body?.reason,
        actor,
      });
    }
    return after;
  } catch (err: any) {
    if (err?.code === 11000) throw new TravelPolicyError(409, "Another city already has that name");
    throw err;
  }
}

/* ── Mapping + overview ───────────────────────────────────────────────── */

/** Which version the mapping/KPIs are measured against: in force today → next scheduled → draft (only for people who may see it). */
export async function basisVersion(workspaceId: Oid, today = istToday(), includeDraft = true) {
  const active = await resolveVersionAt(workspaceId, today);
  if (active) return active;
  const scheduled = await TravelPolicyVersion.findOne({ workspaceId, status: "PUBLISHED", effectiveFrom: { $gt: today } })
    .sort({ effectiveFrom: 1 })
    .lean();
  if (scheduled) return scheduled;
  return includeDraft ? getDraft(workspaceId) : null;
}

export interface MappingRow {
  travellerProfileId: string;
  employeeId: string;
  name: string;
  email: string;
  departmentId: string | null;
  department: string;
  designationId: string | null;
  designation: string;
  bandNumber: number | null;
  /** Where the band came from: the policy's own traveller import, or the login's expense band. */
  bandSource: "PROFILE" | "LOGIN" | null;
  hasLogin: boolean;
  resolution: TierResolution;
  override: { tierKey: string | null; excluded: "GUEST" | null; reason: string; setBy: any; updatedAt: Date } | null;
}

/** Everything buildMapping needs from the database, read once so several tier sets can be resolved against it. */
export async function loadTravellers(workspaceId: Oid, opts: { includeInactive?: boolean } = {}) {
  const travellers: any[] = await TravellerProfile.find(opts.includeInactive ? { workspaceId } : { workspaceId, isActive: true })
    .select("firstName middleName lastName email employeeId travelerId departmentId designationId bandNumber claimedBy workLocation isActive")
    .sort({ firstName: 1, lastName: 1, _id: 1 })
    .limit(20000)
    .lean();
  const userIds = travellers.map((t) => t.claimedBy).filter(Boolean);
  const [users, depts, desigs, assigns] = await Promise.all([
    userIds.length ? User.find({ _id: { $in: userIds } }).select("bandNumber").lean() : Promise.resolve([]),
    Department.find({ workspaceId }).select("name").lean(),
    Designation.find({ workspaceId }).select("name").lean(),
    TravelPolicyTierAssignment.find({ workspaceId }).lean(),
  ]);
  return {
    travellers,
    band: new Map((users as any[]).map((u) => [String(u._id), u.bandNumber ?? null])),
    deptName: new Map((depts as any[]).map((d) => [String(d._id), d.name as string])),
    desigName: new Map((desigs as any[]).map((d) => [String(d._id), d.name as string])),
    assign: new Map((assigns as any[]).map((a) => [String(a.travellerProfileId), a])),
  };
}

function resolveRows(loaded: Awaited<ReturnType<typeof loadTravellers>>, tiers: Tier[]): MappingRow[] {
  return loaded.travellers.map((t) => {
    const a = loaded.assign.get(String(t._id)) ?? null;
    const loginBand = t.claimedBy ? (loaded.band.get(String(t.claimedBy)) ?? null) : null;
    const bandNumber = t.bandNumber ?? loginBand;
    const designationId = t.designationId ? String(t.designationId) : null;
    return {
      travellerProfileId: String(t._id),
      employeeId: t.employeeId || t.travelerId || "",
      name: [t.firstName, t.middleName, t.lastName].filter(Boolean).join(" "),
      email: t.email || "",
      departmentId: t.departmentId ? String(t.departmentId) : null,
      department: t.departmentId ? loaded.deptName.get(String(t.departmentId)) || "" : "",
      designationId,
      designation: designationId ? loaded.desigName.get(designationId) || "" : "",
      bandNumber,
      bandSource: t.bandNumber != null ? "PROFILE" : loginBand != null ? "LOGIN" : null,
      hasLogin: !!t.claimedBy,
      resolution: travellerTier(loaded, t, tiers),
      override: a
        ? { tierKey: a.tierKey ?? null, excluded: a.excluded ?? null, reason: a.reason || "", setBy: a.setBy, updatedAt: a.updatedAt }
        : null,
    };
  });
}

/** One traveller's tier under `tiers`, from what loadTravellers read (the profile's band wins over the login's). */
export function travellerTier(loaded: Awaited<ReturnType<typeof loadTravellers>>, t: any, tiers: Tier[]): TierResolution {
  const bandNumber = t.bandNumber ?? (t.claimedBy ? (loaded.band.get(String(t.claimedBy)) ?? null) : null);
  return resolveTier({ designationId: t.designationId ? String(t.designationId) : null, bandNumber }, tiers, loaded.assign.get(String(t._id)) ?? null);
}

export async function buildMapping(workspaceId: Oid, tiers: Tier[]): Promise<MappingRow[]> {
  return resolveRows(await loadTravellers(workspaceId), tiers);
}

export async function getMapping(workspaceId: Oid, today = istToday(), includeDraft = true) {
  const basis: any = await basisVersion(workspaceId, today, includeDraft);
  const tiers: Tier[] = basis ? JSON.parse(JSON.stringify(basis.tiers || [])) : [];
  const rows = await buildMapping(workspaceId, tiers);
  return {
    basis: basis ? { _id: String(basis._id), state: versionState(basis, today), versionNumber: basis.versionNumber ?? null } : null,
    tiers,
    rows,
  };
}

export async function setAssignments(
  workspaceId: Oid,
  actor: PolicyActor,
  body: { travellerProfileIds?: string[]; tierKey?: string | null; excluded?: "GUEST" | null; clear?: boolean; reason?: string },
) {
  const ids = Array.from(new Set((body.travellerProfileIds ?? []).map(String))).filter((x) => mongoose.isValidObjectId(x));
  if (!ids.length) throw new TravelPolicyError(400, "Pick at least one traveller");
  if (ids.length > 2000) throw new TravelPolicyError(400, "At most 2000 travellers at a time");
  const clear = body.clear === true;
  const excluded = body.excluded === "GUEST" ? "GUEST" : null;
  const tierKey = !clear && !excluded && body.tierKey ? String(body.tierKey).toLowerCase() : null;
  if (!clear && !excluded && !tierKey) throw new TravelPolicyError(400, "Choose a tier, mark as Guest, or clear the override");
  const basis: any = await basisVersion(workspaceId);
  const tierNames = new Map<string, string>((basis?.tiers ?? []).map((t: Tier) => [t.tierKey, t.name]));
  if (tierKey && !tierNames.has(tierKey)) throw new TravelPolicyError(400, "That tier is not in the current policy");
  const words = (x: { tierKey?: string | null; excluded?: string | null } | null | undefined) =>
    !x ? null : x.excluded === "GUEST" ? "Guest" : x.tierKey ? `Pinned to ${tierNames.get(x.tierKey) ?? x.tierKey}` : null;
  // Only this workspace's travellers — the filter, not the caller, decides.
  const travellers: any[] = await TravellerProfile.find({ workspaceId, _id: { $in: ids.map(oid) } })
    .select("firstName lastName")
    .lean();
  if (travellers.length !== ids.length) throw new TravelPolicyError(404, "Some travellers are not in this workspace");
  const before = new Map(
    ((await TravelPolicyTierAssignment.find({ workspaceId, travellerProfileId: { $in: ids.map(oid) } }).lean()) as any[]).map((a) => [
      String(a.travellerProfileId),
      a,
    ]),
  );
  const setBy = { id: actor.id, name: actor.name, kind: actor.kind };
  let updated = 0;
  for (const t of travellers) {
    const prev = before.get(String(t._id));
    const label = [t.firstName, t.lastName].filter(Boolean).join(" ");
    if (clear) {
      if (!prev) continue;
      await TravelPolicyTierAssignment.deleteOne({ workspaceId, travellerProfileId: t._id });
      updated++;
      await appendAudit({
        workspaceId,
        action: "ASSIGNMENT_CLEARED",
        entity: "ASSIGNMENT",
        entityId: String(t._id),
        categories: ["MAPPING"],
        summary: `${label}: override cleared (back to designation / band)`,
        changes: [{ category: "MAPPING", field: label, from: words(prev), to: null }],
        reason: body.reason,
        actor,
      });
      continue;
    }
    // Same tier (or already a Guest): nothing happened, so nothing is written or logged.
    if (prev && (prev.tierKey ?? null) === tierKey && (prev.excluded ?? null) === excluded) continue;
    updated++;
    await TravelPolicyTierAssignment.updateOne(
      { workspaceId, travellerProfileId: t._id },
      { $set: { tierKey, excluded, reason: String(body.reason ?? "").slice(0, 500), setBy } },
      { upsert: true },
    );
    await appendAudit({
      workspaceId,
      action: "ASSIGNMENT_SET",
      entity: "ASSIGNMENT",
      entityId: String(t._id),
      categories: ["MAPPING"],
      summary: excluded ? `${label}: marked Guest` : `${label}: pinned to ${tierNames.get(tierKey!) ?? tierKey}`,
      changes: [{ category: "MAPPING", field: label, from: words(prev), to: words({ tierKey, excluded }) }],
      reason: body.reason,
      actor,
    });
  }
  return { updated, unchanged: travellers.length - updated };
}

export async function getLookups(workspaceId: Oid) {
  const [departments, designations, bands, cities] = await Promise.all([
    Department.find({ workspaceId, isActive: { $ne: false } }).select("name").sort({ name: 1 }).lean(),
    // Inactive ones too: a tier (or an old audit row) may still name one.
    Designation.find({ workspaceId }).select("name level department isActive").sort({ name: 1 }).lean(),
    ExpenseBand.find({ workspaceId }).select("bandNumber bandName maxFlightFarePerPerson maxHotelFarePerNight").sort({ bandNumber: 1 }).lean(),
    TravelPolicyCity.find({ workspaceId }).select("name nameKey cityKey country category isActive").sort({ name: 1 }).lean(),
  ]);
  const countryNames = new Map(ISO_COUNTRIES.map((c) => [c.code, c.name]));
  return {
    departments: departments.map((d: any) => ({ _id: String(d._id), name: d.name })),
    designations: designations.map((d: any) => ({ _id: String(d._id), name: d.name, level: d.level ?? null, department: d.department || "", isActive: d.isActive !== false })),
    bands: Array.from({ length: 10 }, (_, i) => {
      const n = i + 1;
      const row: any = (bands as any[]).find((b) => Number(b.bandNumber) === n);
      return { bandNumber: n, label: (row?.bandName && String(row.bandName).trim()) || `L${n}` };
    }),
    expenseBandCapsConfigured: (bands as any[]).some((b) => (b.maxFlightFarePerPerson ?? 0) > 0 || (b.maxHotelFarePerNight ?? 0) > 0),
    regions: Object.entries(REGIONS).map(([key, r]) => ({ key, label: r.label, countries: r.countries, countryNames: r.countries.map((c) => countryNames.get(c) ?? c) })),
    cities: (cities as any[]).map((c) => ({ key: cityKeyOf(c), name: c.name, country: c.country, category: c.category, isActive: c.isActive !== false })),
    currencies: ISO_CURRENCIES,
    countries: ISO_COUNTRIES,
    limits: { maxAmount: MAX_AMOUNT, ...SOFT_LIMITS, notCompared: [...NOT_COMPARED] },
    categories: CATEGORIES,
    cityClasses: CITY_CLASSES,
  };
}

interface Measure {
  kpis: {
    travellers: number;
    employees: number;
    guests: number;
    mapped: number;
    unmapped: number;
    stale: number;
    coverage: number | null;
    rules: number;
    categoriesCovered: number;
  };
  perTier: { tierKey: string; count: number }[];
  perCategory: { category: (typeof CATEGORIES)[number]; rules: number }[];
  gaps: Gap[];
}

/** The numbers for ONE version: so the cards always describe the version on screen. */
function measure(loaded: Awaited<ReturnType<typeof loadTravellers>>, version: any): Measure {
  const tiers: Tier[] = version ? JSON.parse(JSON.stringify(version.tiers || [])) : [];
  const rules: Rule[] = version ? JSON.parse(JSON.stringify(version.rules || [])) : [];
  const rows = resolveRows(loaded, tiers);
  const guests = rows.filter((r) => r.resolution.status === "GUEST").length;
  const employees = rows.length - guests;
  const mapped = rows.filter((r) => r.resolution.status === "MAPPED").length;
  const perCategory = CATEGORIES.map((c) => ({ category: c, rules: rules.filter((r) => r.category === c).length }));
  return {
    kpis: {
      travellers: rows.length,
      employees,
      guests,
      mapped,
      unmapped: rows.filter((r) => r.resolution.status === "UNMAPPED").length,
      stale: rows.filter((r) => r.resolution.staleOverride).length,
      coverage: employees > 0 ? Math.round((mapped / employees) * 1000) / 10 : null,
      rules: rules.length,
      categoriesCovered: perCategory.filter((c) => c.rules > 0).length,
    },
    perTier: tiers
      .filter((t) => t.active)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((t) => ({ tierKey: t.tierKey, count: rows.filter((r) => r.resolution.tierKey === t.tierKey).length })),
    perCategory,
    gaps: version ? policyGaps({ tiers, rules }) : [],
  };
}

export interface HealthItem {
  id: string;
  severity: "ok" | "warn" | "error" | "info";
  text: string;
  /** `do` says what the button does; a tab alone opens that tab. */
  action?: { label: string; tab?: string; do?: "create" | "draft" | "preview"; category?: string; tierKey?: string; needsWrite?: boolean };
}

/**
 * `showDraft` false (client approvers): the draft is left out entirely except
 * for `draftPending`, so nobody mistakes a draft for the policy.
 */
export async function getOverview(workspaceId: Oid, today = istToday(), opts: { showDraft?: boolean; canWrite?: boolean; entry?: "CLIENT" | "STAFF" } = {}) {
  const showDraft = opts.showDraft !== false;
  const canWrite = opts.canWrite ?? showDraft;
  const ws: any = await CustomerWorkspace.findById(workspaceId).select("companyName customerId config.features config.policyDomesticBasis").lean();
  const all: any[] = await listVersions(workspaceId);
  const realDraft = all.find((v) => v.status === "DRAFT") ?? null;
  const versions = showDraft ? all : all.filter((v) => v.status !== "DRAFT");
  const active = versions.find((v) => versionState(v, today) === "ACTIVE") ?? null;
  const scheduled = versions
    .filter((v) => versionState(v, today) === "SCHEDULED")
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  const draft = showDraft ? realDraft : null;
  const inForce = active ?? scheduled[0] ?? null;
  const basis = inForce ?? draft ?? null;
  const loaded = await loadTravellers(workspaceId);
  const inForceView = inForce ? measure(loaded, inForce) : null;
  const draftView = draft ? measure(loaded, draft) : null;
  const main = inForceView ?? draftView ?? measure(loaded, null);
  const cityCount = await TravelPolicyCity.countDocuments({ workspaceId, isActive: true });
  const latest = versions.filter((v) => v.status === "PUBLISHED").sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;

  const { unmapped, stale, employees } = main.kpis;
  const health: HealthItem[] = [];
  if (!active) {
    health.push({
      id: "not-configured",
      severity: "error",
      text: scheduled.length ? `No policy in force today: v${scheduled[0].versionNumber} starts ${fmtDay(scheduled[0].effectiveFrom)}` : "Not configured: no policy has been published",
      action: draft
        ? { label: "Open draft", do: "draft", tab: "tiers" }
        : scheduled.length
          ? { label: "View", tab: "versions" }
          : realDraft
            ? undefined
            : { label: "Create", do: "create", needsWrite: true },
    });
  } else {
    health.push({ id: "active", severity: "ok", text: `Active policy v${active.versionNumber} is valid` });
  }
  if (basis) {
    const lines = gapLines(main.gaps);
    for (const g of lines) {
      health.push({ id: `gap-${g.category}`, severity: "warn", text: g.text, action: { tab: "rules", label: canWrite ? "Fix" : "View", category: g.category, tierKey: g.tierKey } });
    }
    if (!lines.length) health.push({ id: "categories", severity: "ok", text: "All policy categories configured" });
  }
  const fix = canWrite ? "Fix" : "View";
  if (unmapped > 0) health.push({ id: "unmapped", severity: "warn", text: `${unmapped} employee${unmapped === 1 ? "" : "s"} not mapped to a tier`, action: { tab: "mapping", label: fix } });
  else if (basis && employees > 0) health.push({ id: "mapped", severity: "ok", text: "Every employee is mapped to a tier" });
  if (stale > 0) health.push({ id: "stale", severity: "warn", text: `${stale} override${stale === 1 ? " points" : "s point"} at a tier this version no longer has`, action: { tab: "mapping", label: fix } });
  if (draft) health.push({ id: "draft", severity: "info", text: "A draft has not been published yet", action: canWrite ? { label: "Review", do: "preview", tab: "overview" } : { label: "View", do: "draft", tab: "overview" } });
  for (const s of scheduled) health.push({ id: `scheduled-${s._id}`, severity: "info", text: `v${s.versionNumber} is scheduled from ${fmtDay(s.effectiveFrom)}`, action: { label: "View", tab: "versions" } });
  if (cityCount === 0) health.push({ id: "cities", severity: "warn", text: "City list is empty: every Indian city counts as Other", action: { tab: "cities", label: canWrite ? "Add cities" : "View" } });
  if (active && ws?.config?.features?.expenseBandEnabled) {
    health.push({
      id: "expense-band",
      severity: "warn",
      text:
        opts.entry === "STAFF"
          ? "Expense Band travel caps are still on for flight and hotel search. Turn them off in Workspace Manager once this client is on Travel Policy."
          : "Expense Band travel caps are still on for flight and hotel search. Ask your Plumtrips account team to turn them off.",
    });
  }

  const pendingActions = health.filter((h) => h.severity === "warn" || h.severity === "error").length;
  const tierNames: Record<string, string> = {};
  for (const v of [...versions].reverse()) for (const t of v.tiers || []) tierNames[t.tierKey] = t.name;
  return {
    workspace: { _id: String(workspaceId), name: ws?.companyName || "", travelPolicyEnabled: !!ws?.config?.features?.travelPolicyEnabled },
    settings: { domesticBasis: readDomesticBasis(ws?.config?.policyDomesticBasis) },
    today,
    active: active ? summarizeVersion(active, today) : null,
    scheduled: scheduled.map((s) => summarizeVersion(s, today)),
    draft: draft ? summarizeVersion(draft, today) : null,
    /** Someone is preparing a draft this person may not see. */
    draftPending: !showDraft && !!realDraft,
    basis: basis ? summarizeVersion(basis, today) : null,
    inForce: inForce ? summarizeVersion(inForce, today) : null,
    versions: versions.map((v) => summarizeVersion(v, today)),
    earliestPublish: earliestPublish(latest, today),
    tierNames,
    kpis: { ...main.kpis, pendingActions },
    perTier: main.perTier,
    perCategory: main.perCategory,
    views: { inForce: inForceView, draft: draftView },
    health,
  };
}

/** Id of the open draft, if any (to keep its audit rows from people who may not see it). */
const BASIS_LABEL: Record<DomesticBasis, string> = { INDIA: "Within India", WORK_COUNTRY: "Within the traveller's work country" };

/** What "domestic" means for this workspace's Policy Compliance. Not versioned: it applies to past trips too. */
export async function setDomesticBasis(workspaceId: Oid, actor: PolicyActor, value: unknown, reason?: string) {
  if (!DOMESTIC_BASES.includes(value as DomesticBasis)) throw new TravelPolicyError(400, "Choose what domestic means");
  const next = value as DomesticBasis;
  const prev: any = await CustomerWorkspace.findOneAndUpdate({ _id: workspaceId }, { $set: { "config.policyDomesticBasis": next } }, { new: false })
    .select("config.policyDomesticBasis")
    .lean();
  if (!prev) throw new TravelPolicyError(404, "Workspace not found");
  const before = readDomesticBasis(prev.config?.policyDomesticBasis);
  if (before !== next) {
    await appendAudit({
      workspaceId,
      action: "SETTING_CHANGED",
      entity: "ORG",
      categories: ["SETTING"],
      summary: `Domestic now means: ${BASIS_LABEL[next].toLowerCase().replace("india", "India")}`,
      changes: [{ category: "SETTING", field: "Domestic means", from: BASIS_LABEL[before], to: BASIS_LABEL[next] }],
      reason,
      actor,
    });
  }
  return { domesticBasis: next };
}

export async function openDraftId(workspaceId: Oid): Promise<string | null> {
  const d: any = await TravelPolicyVersion.findOne({ workspaceId, status: "DRAFT" }).select("_id").lean();
  return d ? String(d._id) : null;
}
