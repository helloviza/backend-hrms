// apps/backend/src/services/crmSalesPulseSnapshot.ts
//
// COMPUTE layer for the CRM Sales Pulse report. Mirrors eodSnapshot.ts: a pure
// data-assembly module with NO delivery/render concerns. Produces one immutable
// SalesPulseSnapshot for the "today-so-far" window (00:00 IST → now).
//
// Reuse: the per-stage distribution, open-pipeline value, lead-ageing buckets
// and the rep roster all come from buildOwnerStatusReport() — the SAME shared
// aggregation the /leads/reports/owner-status route uses, so the numbers can
// never drift. Everything that is genuinely "today-only" (activity events,
// stage movement, new leads, heatmap) is queried directly here, scoped to IST.
//
// Honesty rules baked in (per spec):
//   • Deltas are computed from the prior comparable window (same elapsed time
//     yesterday). They are real timestamp diffs — never fabricated.
//   • Estimated Closure Value = Σ open dealValue. When no deal carries a value
//     we expose closureValueKnown=false so the template shows an honest
//     "deal values not yet captured" state instead of a ₹0 headline.
//   • Productivity % is explicitly flagged as derived (see meta.productivityNote).

import Lead, { LEAD_STAGES, type LeadStage } from "../models/Lead.js";
import LeadActivity from "../models/LeadActivity.js";
import { parseISTStart } from "../utils/dateIST.js";
import {
  buildOwnerStatusReport,
  OWNER_STATUS_STAGE_LABEL,
  type OwnerStatusReport,
} from "./ownerStatusReport.js";
import {
  normalizeSalesPulseSections,
  CrmSalesPulseConfig,
  type ICrmSalesPulseSections,
} from "../models/CrmSalesPulseConfig.js";

/* ─────────────────────────── Stage palette ──────────────────────────── */
// Mirrors the frontend STAGE_COLORS (apps/frontend/src/types/leads.ts), incl.
// the indigo email_sent added in feat/crm-stage-email-sent.
export const STAGE_COLORS: Record<string, string> = {
  new: "#64748b",
  email_sent: "#6366f1",
  contacted: "#3b82f6",
  demo_scheduled: "#8b5cf6",
  proposal_sent: "#f59e0b",
  negotiation: "#f97316",
  follow_up: "#06b6d4",
  won: "#10b981",
  lost: "#ef4444",
};
const STAGE_LABEL = OWNER_STATUS_STAGE_LABEL;

/* ── Activity Score weights (TRANSPARENT — surfaced in the report footer) ──
 * Weighted by sales effort/intent. Only the five "interaction" activity types
 * score; system events (stage_change, assignment, won, lost, invite_sent) do
 * not represent rep effort and carry no weight. */
export const ACTIVITY_WEIGHTS: Record<string, number> = {
  meeting: 5,
  call: 3,
  follow_up: 2,
  email: 2,
  note: 1,
};
const SCORED_TYPES = Object.keys(ACTIVITY_WEIGHTS);

/* ── Heatmap slots — the four IST fire times. A slot is "reached" once the
 * current time has passed its start hour; later slots stay empty until then. */
const HEATMAP_SLOTS = [
  { key: "12", label: "12 PM", startHour: 12 },
  { key: "14", label: "2 PM", startHour: 14 },
  { key: "16", label: "4 PM", startHour: 16 },
  { key: "19", label: "7 PM", startHour: 19 },
];

/* ─────────────────────────── Types ─────────────────────────── */
export interface KpiCard {
  key: string;
  label: string;
  icon: string;
  value: number;
  /** Δ vs prior comparable window; null when not meaningfully comparable. */
  delta: number | null;
  deltaDir: "up" | "down" | "flat" | null;
}

export interface LeaderboardRep {
  ownerId: string;
  ownerName: string;
  score: number;
  activities: number;
  status: "green" | "amber" | "red" | "neutral";
}

export interface SalesPulseSnapshot {
  generatedAt: string;
  dateLabel: string;
  timeLabel: string;
  windowLabel: string;
  fireSlotLabel: string;
  sections: ICrmSalesPulseSections;

  kpis: KpiCard[];

  leaderboard: {
    teamAverage: number;
    weights: Record<string, number>;
    reps: LeaderboardRep[];
  };

  /** Pipeline movement — leads that moved INTO each stage today (all 9 stages). */
  movement: Array<{ stage: string; label: string; color: string; count: number }>;

  /** Current stage distribution snapshot (donut). */
  stageDistribution: Array<{ stage: string; label: string; color: string; count: number; pct: number }>;

  heatmap: {
    slots: Array<{ key: string; label: string; reached: boolean }>;
    reachedCount: number;
    reps: Array<{ ownerId: string; ownerName: string; counts: number[]; total: number }>;
    maxCell: number;
  };

  companiesTouched: {
    total: number;
    byRep: Array<{ ownerId: string; ownerName: string; count: number }>;
  };

  repCards: Array<{
    ownerId: string;
    ownerName: string;
    activities: number;
    leads: number;
    demos: number;
    won: number;
    productivityPct: number;
  }>;

  ageingAlert: Array<{
    leadId: string;
    name: string;
    ownerName: string;
    stage: string;
    stageLabel: string;
    color: string;
    daysSince: number;
  }>;

  conversion: {
    basis: string;
    steps: Array<{ key: string; label: string; count: number }>;
    stepRates: Array<{ from: string; to: string; pct: number | null }>;
  };

  insights: {
    lines: string[];
    estimatedClosureValue: number;
    closureValueKnown: boolean;
  };

  meta: {
    weights: Record<string, number>;
    productivityNote: string;
    conversionNote: string;
    movementNote: string;
  };
}

/* ─────────────────────────── Formatters ──────────────────────── */
export function fmtInr(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Math.round(n || 0));
}
function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-IN").format(n || 0);
}

/* ─────────────────────────── IST helpers ─────────────────────── */
function todayInIST(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function shiftDateStr(istDateStr: string, deltaDays: number): string {
  const [y, m, d] = istDateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}
function istHour(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "0";
  const n = parseInt(hh, 10);
  return n === 24 ? 0 : n; // some ICU builds emit 24 at midnight
}

/* ─────────────────────────── Activity fetch ──────────────────── */
interface ActLite {
  leadId: string;
  type: string;
  toStage?: string;
  createdAt: Date;
}
async function fetchActivities(start: Date, end: Date): Promise<ActLite[]> {
  const rows = (await LeadActivity.find({ createdAt: { $gte: start, $lte: end } })
    .select("leadId type toStage createdAt")
    .lean()) as any[];
  return rows.map((a) => ({
    leadId: String(a.leadId),
    type: String(a.type),
    toStage: a.toStage ? String(a.toStage) : undefined,
    createdAt: new Date(a.createdAt),
  }));
}

interface LeadLite {
  _id: string;
  assignedTo: string | null;
  assignedToName: string;
  companyId: string | null;
  companyName: string;
  contactName: string;
  stage: string;
}
async function fetchLeadsByIds(ids: string[]): Promise<Map<string, LeadLite>> {
  const map = new Map<string, LeadLite>();
  if (!ids.length) return map;
  const rows = (await Lead.find({ _id: { $in: ids } })
    .select("_id assignedTo assignedToName companyId companyName contactName stage")
    .lean()) as any[];
  for (const l of rows) {
    map.set(String(l._id), {
      _id: String(l._id),
      assignedTo: l.assignedTo ? String(l.assignedTo) : null,
      assignedToName: l.assignedToName || "",
      companyId: l.companyId ? String(l.companyId) : null,
      companyName: l.companyName || "",
      contactName: l.contactName || "",
      stage: l.stage,
    });
  }
  return map;
}

/* Movement into a stage today: stage_change.toStage for new→follow_up; the
 * dedicated won/lost activity types for the terminal stages (those routes don't
 * write a stage_change). "new" movement is creation, handled separately. */
function movementInto(stage: string, acts: ActLite[]): number {
  if (stage === "won") return acts.filter((a) => a.type === "won").length;
  if (stage === "lost") return acts.filter((a) => a.type === "lost").length;
  return acts.filter((a) => a.type === "stage_change" && a.toStage === stage).length;
}

/* ── Window KPI counts (reused for today + prior so deltas are honest). ── */
interface WindowKpis {
  totalActivities: number;
  activeReps: number;
  companiesTouched: number;
  newLeads: number;
  demos: number;
  proposals: number;
  negotiation: number;
  won: number;
  lost: number;
}
async function computeWindowKpis(start: Date, end: Date): Promise<WindowKpis> {
  const acts = await fetchActivities(start, end);
  const leadIds = [...new Set(acts.map((a) => a.leadId))];
  const leadsMap = await fetchLeadsByIds(leadIds);
  const newLeads = await Lead.countDocuments({ createdAt: { $gte: start, $lte: end } });

  const activeOwners = new Set<string>();
  const companies = new Set<string>();
  for (const a of acts) {
    const l = leadsMap.get(a.leadId);
    if (!l) continue;
    if (l.assignedTo) activeOwners.add(l.assignedTo);
    const co = l.companyId || (l.companyName ? `name:${l.companyName.toLowerCase()}` : "");
    if (co) companies.add(co);
  }

  return {
    totalActivities: acts.length,
    activeReps: activeOwners.size,
    companiesTouched: companies.size,
    newLeads,
    demos: movementInto("demo_scheduled", acts),
    proposals: movementInto("proposal_sent", acts),
    negotiation: movementInto("negotiation", acts),
    won: movementInto("won", acts),
    lost: movementInto("lost", acts),
  };
}

function deltaCard(
  key: string,
  label: string,
  icon: string,
  today: number,
  prior: number,
): KpiCard {
  const delta = today - prior;
  const deltaDir: KpiCard["deltaDir"] = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return { key, label, icon, value: today, delta, deltaDir };
}

/* ── Conversion funnel from stage history (ever-entered milestones). ── */
async function computeConversion(): Promise<SalesPulseSnapshot["conversion"]> {
  const [allLeads, stageChanges, wins] = await Promise.all([
    Lead.find({}).select("_id stage").lean() as any,
    LeadActivity.find({ type: "stage_change" }).select("leadId toStage").lean() as any,
    LeadActivity.find({ type: "won" }).select("leadId").lean() as any,
  ]);

  const reached = new Map<string, Set<string>>();
  const ensure = (id: string) => {
    if (!reached.has(id)) reached.set(id, new Set());
    return reached.get(id)!;
  };
  for (const l of allLeads as any[]) ensure(String(l._id)).add(l.stage); // current stage
  for (const sc of stageChanges as any[]) if (sc.toStage) ensure(String(sc.leadId)).add(String(sc.toStage));
  for (const w of wins as any[]) ensure(String(w.leadId)).add("won");

  const totalLeads = (allLeads as any[]).length;
  const has = (id: string, stage: string) => reached.get(id)?.has(stage) ?? false;
  let demos = 0, proposals = 0, won = 0;
  for (const id of reached.keys()) {
    if (has(id, "demo_scheduled")) demos++;
    if (has(id, "proposal_sent")) proposals++;
    if (has(id, "won")) won++;
  }

  const pct = (num: number, den: number): number | null =>
    den > 0 ? Math.round((num / den) * 1000) / 10 : null;

  return {
    basis: "Leads that have ever entered each milestone (current stage + stage-change history).",
    steps: [
      { key: "leads", label: "Leads", count: totalLeads },
      { key: "demos", label: "Demos", count: demos },
      { key: "proposals", label: "Proposals", count: proposals },
      { key: "won", label: "Won", count: won },
    ],
    stepRates: [
      { from: "leads", to: "demos", pct: pct(demos, totalLeads) },
      { from: "demos", to: "proposals", pct: pct(proposals, demos) },
      { from: "proposals", to: "won", pct: pct(won, proposals) },
    ],
  };
}

/* ── Top-5 oldest open leads by days since last activity. ── */
async function computeAgeingAlert(): Promise<SalesPulseSnapshot["ageingAlert"]> {
  const openLeads = (await Lead.find({ stage: { $nin: ["won", "lost"] } })
    .select("_id companyName contactName assignedToName stage createdAt")
    .lean()) as any[];
  if (!openLeads.length) return [];

  const ids = openLeads.map((l) => l._id);
  const lastActAgg = (await LeadActivity.aggregate([
    { $match: { leadId: { $in: ids } } },
    { $group: { _id: "$leadId", last: { $max: "$createdAt" } } },
  ])) as any[];
  const lastMap = new Map<string, number>();
  for (const r of lastActAgg) lastMap.set(String(r._id), new Date(r.last).getTime());

  const now = Date.now();
  const DAY = 86400000;
  return openLeads
    .map((l) => {
      const created = new Date(l.createdAt).getTime();
      const last = Math.max(created, lastMap.get(String(l._id)) ?? 0);
      const daysSince = Math.max(0, Math.floor((now - last) / DAY));
      return {
        leadId: String(l._id),
        name: l.companyName || l.contactName || "Unnamed lead",
        ownerName: (l.assignedToName && String(l.assignedToName).trim()) || "Unassigned",
        stage: l.stage,
        stageLabel: STAGE_LABEL[l.stage] ?? l.stage,
        color: STAGE_COLORS[l.stage] ?? "#64748b",
        daysSince,
      };
    })
    .sort((a, b) => b.daysSince - a.daysSince)
    .slice(0, 5);
}

/* ─────────────────────────── Public: snapshot ─────────────────── */
export async function computeSalesPulseSnapshot(
  sectionsOverride?: Partial<ICrmSalesPulseSections>,
): Promise<SalesPulseSnapshot> {
  const config = await CrmSalesPulseConfig.findOne().lean();
  const baseSections = normalizeSalesPulseSections(config?.sections);
  const sections: ICrmSalesPulseSections = sectionsOverride
    ? { ...baseSections, ...sectionsOverride }
    : baseSections;

  const now = new Date();
  const todayStr = todayInIST(now);
  const todayStart = parseISTStart(todayStr);
  const elapsedMs = now.getTime() - todayStart.getTime();

  // Prior comparable window: same elapsed duration, yesterday.
  const yStr = shiftDateStr(todayStr, -1);
  const yStart = parseISTStart(yStr);
  const yEnd = new Date(yStart.getTime() + elapsedMs);

  // Reused aggregation (whole-pipeline snapshot): donut, closure value, roster.
  const allReport: OwnerStatusReport = await buildOwnerStatusReport({});

  // Today + prior KPI windows (for deltas), plus today's raw activities for the
  // per-rep breakdowns the windowed counts don't carry.
  const [todayKpis, priorKpis, todayActs, conversion, ageingAlert] = await Promise.all([
    computeWindowKpis(todayStart, now),
    computeWindowKpis(yStart, yEnd),
    fetchActivities(todayStart, now),
    sections.conversionTracker ? computeConversion() : Promise.resolve(null),
    sections.leadAgeing ? computeAgeingAlert() : Promise.resolve([]),
  ]);

  const todayLeadIds = [...new Set(todayActs.map((a) => a.leadId))];
  const leadsMap = await fetchLeadsByIds(todayLeadIds);

  /* ── Labels ── */
  const dateLabel = now.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "short", year: "numeric",
  });
  const timeLabel = now.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true,
  });
  const windowLabel = `12:00 AM – ${timeLabel} IST`;
  const nowHour = istHour(now);
  const reachedSlots = HEATMAP_SLOTS.map((s) => nowHour >= s.startHour);
  const reachedCount = reachedSlots.filter(Boolean).length;
  const fireSlotLabel =
    HEATMAP_SLOTS.filter((s) => nowHour >= s.startHour).slice(-1)[0]?.label ?? "Pre-noon";

  /* ── KPIs (2×4 grid uses the first 8; all are exposed). ── */
  const kpis: KpiCard[] = [
    deltaCard("active_reps", "Active Reps", "👥", todayKpis.activeReps, priorKpis.activeReps),
    deltaCard("companies_touched", "Companies Touched", "🏢", todayKpis.companiesTouched, priorKpis.companiesTouched),
    deltaCard("total_activities", "Total Activities", "⚡", todayKpis.totalActivities, priorKpis.totalActivities),
    deltaCard("new_leads", "New Leads", "✨", todayKpis.newLeads, priorKpis.newLeads),
    deltaCard("demos", "Demos", "🎯", todayKpis.demos, priorKpis.demos),
    deltaCard("proposals", "Proposals", "📄", todayKpis.proposals, priorKpis.proposals),
    deltaCard("won", "Won", "🏆", todayKpis.won, priorKpis.won),
    deltaCard("lost", "Lost", "💔", todayKpis.lost, priorKpis.lost),
    deltaCard("negotiation", "Negotiation", "🤝", todayKpis.negotiation, priorKpis.negotiation),
  ];

  /* ── Roster (every rep that owns leads), from the reused report. ── */
  const roster = allReport.performance.map((p) => ({
    ownerId: p.ownerId,
    ownerName: p.ownerName,
    totalLeads: p.total,
  }));

  /* ── Per-rep today aggregates from raw activities. ── */
  const perRepScore = new Map<string, number>();
  const perRepActivityCount = new Map<string, number>();
  const perRepCompanies = new Map<string, Set<string>>();
  const perRepActiveLeadIds = new Map<string, Set<string>>();
  const perRepDemos = new Map<string, number>();
  const perRepWon = new Map<string, number>();
  const heatByRep = new Map<string, number[]>();

  const ownerOf = (leadId: string): { id: string; name: string } | null => {
    const l = leadsMap.get(leadId);
    if (!l) return null;
    return { id: l.assignedTo ?? "unassigned", name: (l.assignedToName && l.assignedToName.trim()) || (l.assignedTo ? "Unknown" : "Unassigned") };
  };

  for (const a of todayActs) {
    const o = ownerOf(a.leadId);
    if (!o) continue;
    perRepActivityCount.set(o.id, (perRepActivityCount.get(o.id) ?? 0) + 1);
    if (!perRepActiveLeadIds.has(o.id)) perRepActiveLeadIds.set(o.id, new Set());
    perRepActiveLeadIds.get(o.id)!.add(a.leadId);

    if (SCORED_TYPES.includes(a.type)) {
      perRepScore.set(o.id, (perRepScore.get(o.id) ?? 0) + ACTIVITY_WEIGHTS[a.type]);
    }
    if (a.type === "stage_change" && a.toStage === "demo_scheduled") {
      perRepDemos.set(o.id, (perRepDemos.get(o.id) ?? 0) + 1);
    }
    if (a.type === "won") perRepWon.set(o.id, (perRepWon.get(o.id) ?? 0) + 1);

    const co = leadsMap.get(a.leadId);
    if (co) {
      const cKey = co.companyId || (co.companyName ? `name:${co.companyName.toLowerCase()}` : "");
      if (cKey) {
        if (!perRepCompanies.has(o.id)) perRepCompanies.set(o.id, new Set());
        perRepCompanies.get(o.id)!.add(cKey);
      }
    }

    // Heatmap slot by activity IST hour.
    const h = istHour(a.createdAt);
    const slotIdx = h < 14 ? 0 : h < 16 ? 1 : h < 19 ? 2 : 3;
    if (!heatByRep.has(o.id)) heatByRep.set(o.id, [0, 0, 0, 0]);
    heatByRep.get(o.id)![slotIdx]++;
  }

  /* ── Leaderboard ── */
  const scoredReps = roster.map((r) => ({
    ownerId: r.ownerId,
    ownerName: r.ownerName,
    score: perRepScore.get(r.ownerId) ?? 0,
    activities: perRepActivityCount.get(r.ownerId) ?? 0,
  }));
  const repCountForAvg = scoredReps.length || 1;
  const teamAverage = Math.round((scoredReps.reduce((s, r) => s + r.score, 0) / repCountForAvg) * 10) / 10;
  const leaderboard = {
    teamAverage,
    weights: ACTIVITY_WEIGHTS,
    reps: scoredReps
      .map((r): LeaderboardRep => {
        let status: LeaderboardRep["status"] = "neutral";
        if (teamAverage > 0) {
          if (r.score >= teamAverage && r.score > 0) status = "green";
          else if (r.score >= teamAverage * 0.5) status = "amber";
          else status = "red";
        }
        return { ...r, status };
      })
      .sort((a, b) => b.score - a.score),
  };

  /* ── Movement funnel (all 9 stages). "new" = leads created today. ── */
  const movement = (LEAD_STAGES as readonly string[]).map((stage) => ({
    stage,
    label: STAGE_LABEL[stage],
    color: STAGE_COLORS[stage] ?? "#64748b",
    count: stage === "new" ? todayKpis.newLeads : movementInto(stage, todayActs),
  }));

  /* ── Stage distribution donut (reused, current snapshot). ── */
  const stageDistribution = allReport.statusSnapshot.map((s) => ({
    stage: s.stage,
    label: s.label,
    color: STAGE_COLORS[s.stage] ?? "#64748b",
    count: s.count,
    pct: s.pct,
  }));

  /* ── Heatmap ── */
  const heatReps = roster
    .map((r) => {
      const counts = heatByRep.get(r.ownerId) ?? [0, 0, 0, 0];
      return { ownerId: r.ownerId, ownerName: r.ownerName, counts, total: counts.reduce((a, b) => a + b, 0) };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);
  const maxCell = heatReps.reduce((m, r) => Math.max(m, ...r.counts), 0);
  const heatmap = {
    slots: HEATMAP_SLOTS.map((s, i) => ({ key: s.key, label: s.label, reached: reachedSlots[i] })),
    reachedCount,
    reps: heatReps,
    maxCell,
  };

  /* ── Companies touched per rep ── */
  const companiesTouched = {
    total: todayKpis.companiesTouched,
    byRep: roster
      .map((r) => ({ ownerId: r.ownerId, ownerName: r.ownerName, count: perRepCompanies.get(r.ownerId)?.size ?? 0 }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count),
  };

  /* ── Rep performance cards ── */
  const repCards = roster
    .map((r) => {
      const activities = perRepActivityCount.get(r.ownerId) ?? 0;
      const activeLeads = perRepActiveLeadIds.get(r.ownerId)?.size ?? 0;
      // Productivity % = % of the rep's leads with ≥1 activity today (DERIVED).
      const productivityPct = r.totalLeads > 0 ? Math.round((activeLeads / r.totalLeads) * 1000) / 10 : 0;
      return {
        ownerId: r.ownerId,
        ownerName: r.ownerName,
        activities,
        leads: r.totalLeads,
        demos: perRepDemos.get(r.ownerId) ?? 0,
        won: perRepWon.get(r.ownerId) ?? 0,
        productivityPct,
      };
    })
    .sort((a, b) => b.activities - a.activities || b.leads - a.leads);

  /* ── Insights (rule-based templated lines, no LLM). ── */
  const estimatedClosureValue = allReport.pipeline.totalPipelineValue;
  const closureValueKnown = allReport.pipeline.hasAnyValue;
  const insightLines: string[] = [];

  const topRep = leaderboard.reps[0];
  if (topRep && topRep.score > 0) {
    insightLines.push(`${topRep.ownerName} is leading today with ${topRep.activities} activit${topRep.activities === 1 ? "y" : "ies"} (score ${topRep.score}).`);
  }
  insightLines.push(
    todayKpis.newLeads > 0
      ? `${fmtNum(todayKpis.newLeads)} new lead${todayKpis.newLeads === 1 ? "" : "s"} entered the pipeline today.`
      : "No new leads have been added yet today.",
  );
  const topMove = movement.filter((m) => m.stage !== "new").sort((a, b) => b.count - a.count)[0];
  if (topMove && topMove.count > 0) {
    insightLines.push(`${fmtNum(topMove.count)} lead${topMove.count === 1 ? "" : "s"} moved into ${topMove.label} today.`);
  }
  if (allReport.stale.totalStale > 0) {
    const crit = allReport.stale.byOwner.reduce((s, o) => s + o.criticalCount, 0);
    insightLines.push(
      `${fmtNum(allReport.stale.totalStale)} open lead${allReport.stale.totalStale === 1 ? "" : "s"} have seen no activity in 14+ days${crit > 0 ? `, ${fmtNum(crit)} critically (30+ days)` : ""}.`,
    );
  }
  if (conversion) {
    const d2l = conversion.stepRates.find((s) => s.from === "leads");
    if (d2l && d2l.pct != null) insightLines.push(`Lead-to-Demo conversion stands at ${d2l.pct}%.`);
  }
  insightLines.push(
    closureValueKnown
      ? `Estimated closure value across open deals: ${fmtInr(estimatedClosureValue)}.`
      : "Open deal values not yet captured — closure value unavailable.",
  );

  return {
    generatedAt: now.toISOString(),
    dateLabel,
    timeLabel,
    windowLabel,
    fireSlotLabel,
    sections,
    kpis,
    leaderboard,
    movement,
    stageDistribution,
    heatmap,
    companiesTouched,
    repCards,
    ageingAlert,
    conversion: conversion ?? {
      basis: "",
      steps: [],
      stepRates: [],
    },
    insights: {
      lines: insightLines.slice(0, 5),
      estimatedClosureValue,
      closureValueKnown,
    },
    meta: {
      weights: ACTIVITY_WEIGHTS,
      productivityNote: "Productivity % is derived: share of a rep's assigned leads with ≥1 activity logged today.",
      conversionNote: conversion?.basis ?? "",
      movementNote: "Movement counts leads that entered each stage today (stage-change events; New = leads created today; Won/Lost = win/lose events).",
    },
  };
}
