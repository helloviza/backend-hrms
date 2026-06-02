// apps/backend/src/services/ownerStatusReport.ts
//
// Shared owner-status CRM aggregation, extracted verbatim from the
// GET /leads/reports/owner-status route handler so it can be reused by both
// that route AND the Sales Pulse snapshot service (services/crmSalesPulseSnapshot).
//
// Read-only. The snapshot is keyed on last_activity_date =
//   max(latest LeadActivity.createdAt, Lead.createdAt)
// which is computed per lead FIRST, then the date-range filter is applied to it
// (the other filters are plain lead fields, matched in Mongo up front).
//
// Inputs are ALREADY validated/parsed by the caller (objectid strings, known
// stage values, day-bounded dates) — this service does the queries + math only.

import mongoose from "mongoose";
import Lead, { LEAD_STAGES } from "../models/Lead.js";
import LeadActivity from "../models/LeadActivity.js";

type AnyObj = Record<string, any>;

export interface OwnerStatusParams {
  /** Validated ObjectId strings. */
  assignedTo?: string[];
  /** Validated stage values (subset of LEAD_STAGES). */
  stage?: string[];
  source?: string[];
  /** "company" | "individual". */
  type?: string[];
  /** Day-bounded Date (or null) — filter on last_activity_date. */
  dateFrom?: Date | null;
  dateTo?: Date | null;
}

export interface OwnerStatusReport {
  generatedAt: string;
  filters: {
    dateFrom: string | null;
    dateTo: string | null;
    assignedTo: string[];
    stage: string[];
    source: string[];
    type: string[];
  };
  totals: { totalLeads: number; byStatus: Record<string, number> };
  statusSnapshot: Array<{ stage: string; label: string; count: number; pct: number }>;
  ownerMatrix: {
    stages: Array<{ key: string; label: string }>;
    owners: Array<{ ownerId: string; ownerName: string; total: number; byStatus: Record<string, number> }>;
  };
  performance: Array<{
    ownerId: string; ownerName: string; total: number; won: number; lost: number;
    closed: number; conversionPct: number; winPct: number | null; avgAgeDays: number;
  }>;
  ageing: {
    openTotal: number;
    buckets: Array<{ key: string; label: string; count: number; pct: number }>;
    byOwner: Array<{ ownerId: string; ownerName: string; total: number; buckets: Record<string, number>; bucketPct: Record<string, number> }>;
  };
  stale: {
    thresholdDays: number; criticalDays: number; totalStale: number; totalPotentialValue: number;
    byOwner: Array<{ ownerId: string; ownerName: string; count: number; potentialValue: number; criticalCount: number; critical: boolean }>;
  };
  pipeline: {
    totalPipelineValue: number; hasAnyValue: boolean;
    byOwner: Array<{ ownerId: string; ownerName: string; openLeads: number; pipelineValue: number; valuedLeads: number }>;
  };
  activityEffectiveness: {
    types: Array<{ key: string; label: string }>;
    presentTypes: Array<{ key: string; label: string; count: number }>;
    absentTypes: Array<{ key: string; label: string }>;
    byOwner: Array<{ ownerId: string; ownerName: string; activityCounts: Record<string, number>; totalActivities: number; conversionPct: number }>;
  };
}

export const OWNER_STATUS_STAGE_LABEL: Record<string, string> = {
  new: "New", email_sent: "Email Sent", contacted: "Contacted", demo_scheduled: "Demo Scheduled",
  proposal_sent: "Proposal Sent", negotiation: "Negotiation", follow_up: "Follow Up",
  won: "Won", lost: "Lost",
};

export const OWNER_STATUS_INTERACTION_TYPES = ["call", "email", "meeting", "note", "follow_up"] as const;
const TYPE_LABEL: Record<string, string> = {
  call: "Calls", email: "Emails", meeting: "Meetings", note: "Notes", follow_up: "Follow-ups",
};

export async function buildOwnerStatusReport(params: OwnerStatusParams): Promise<OwnerStatusReport> {
  const assignedToF = (params.assignedTo ?? []).filter((s) => mongoose.isValidObjectId(s));
  const stageF = (params.stage ?? []).filter((s) => (LEAD_STAGES as readonly string[]).includes(s));
  const sourceF = params.source ?? [];
  const typeF = (params.type ?? []).filter((s) => s === "company" || s === "individual");

  const fromMs = params.dateFrom && !isNaN(params.dateFrom.getTime()) ? params.dateFrom.getTime() : null;
  const toMs = params.dateTo && !isNaN(params.dateTo.getTime()) ? params.dateTo.getTime() : null;

  // Lead-level filters (cheap, in Mongo). The date filter depends on activities
  // and is therefore applied after last_activity_date is computed below.
  const leadMatch: AnyObj = {};
  if (assignedToF.length)
    leadMatch.assignedTo = { $in: assignedToF.map((s) => new mongoose.Types.ObjectId(s)) };
  if (stageF.length) leadMatch.stage = { $in: stageF };
  if (sourceF.length) leadMatch.source = { $in: sourceF };
  if (typeF.length) leadMatch.type = { $in: typeF };

  const leads = (await Lead.find(leadMatch)
    .select("_id assignedTo assignedToName stage source type dealValue currency createdAt")
    .lean()) as any[];

  const leadIds = leads.map((l) => l._id);
  const activities = leadIds.length
    ? ((await LeadActivity.find({ leadId: { $in: leadIds } })
        .select("leadId type createdAt")
        .lean()) as any[])
    : [];

  const actByLead = new Map<string, any[]>();
  for (const a of activities) {
    const k = String(a.leadId);
    if (!actByLead.has(k)) actByLead.set(k, []);
    actByLead.get(k)!.push(a);
  }

  const now = Date.now();
  const DAY = 86400000;

  // last_activity_date + lead age, then date-range filter on last_activity_date.
  const scoped = leads
    .map((l) => {
      const acts = actByLead.get(String(l._id)) || [];
      let lastAct = 0;
      for (const a of acts) {
        const t = new Date(a.createdAt).getTime();
        if (t > lastAct) lastAct = t;
      }
      const created = new Date(l.createdAt).getTime();
      return { ...l, _acts: acts, _lastActivity: Math.max(created, lastAct), _created: created };
    })
    .filter((l) => {
      if (fromMs != null && l._lastActivity < fromMs) return false;
      if (toMs != null && l._lastActivity > toMs) return false;
      return true;
    });

  // ── Identity + constants ──
  const ownerKey = (l: any) => (l.assignedTo ? String(l.assignedTo) : "unassigned");
  const ownerLabel = (l: any) =>
    (l.assignedToName && String(l.assignedToName).trim()) ||
    (l.assignedTo ? "Unknown" : "Unassigned");
  const STAGES = LEAD_STAGES as readonly string[];
  const STAGE_LABEL = OWNER_STATUS_STAGE_LABEL;
  const isClosed = (s: string) => s === "won" || s === "lost";
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const total = scoped.length;

  // ── S1 — status snapshot ──
  const statusCount: Record<string, number> = {};
  for (const s of STAGES) statusCount[s] = 0;
  for (const l of scoped) statusCount[l.stage] = (statusCount[l.stage] || 0) + 1;
  const statusSnapshot = STAGES.map((s) => ({
    stage: s, label: STAGE_LABEL[s], count: statusCount[s],
    pct: total ? r1((statusCount[s] / total) * 100) : 0,
  }));

  // ── Owner buckets ──
  const ownerMap = new Map<string, { ownerId: string; ownerName: string; leads: any[] }>();
  for (const l of scoped) {
    const k = ownerKey(l);
    if (!ownerMap.has(k)) ownerMap.set(k, { ownerId: k, ownerName: ownerLabel(l), leads: [] });
    ownerMap.get(k)!.leads.push(l);
  }
  const owners = [...ownerMap.values()].sort((a, b) => b.leads.length - a.leads.length);

  // ── S2 — owner × status matrix ──
  const ownerMatrix = {
    stages: STAGES.map((s) => ({ key: s, label: STAGE_LABEL[s] })),
    owners: owners.map((o) => {
      const byStatus: Record<string, number> = {};
      for (const s of STAGES) byStatus[s] = 0;
      for (const l of o.leads) byStatus[l.stage]++;
      return { ownerId: o.ownerId, ownerName: o.ownerName, total: o.leads.length, byStatus };
    }),
  };

  // ── S3 — performance (conversion%, win% null-safe, avgAgeDays) ──
  const performance = owners.map((o) => {
    const t = o.leads.length;
    const won = o.leads.filter((l) => l.stage === "won").length;
    const lost = o.leads.filter((l) => l.stage === "lost").length;
    const closed = won + lost;
    const ageSum = o.leads.reduce((s, l) => s + Math.max(0, Math.floor((now - l._created) / DAY)), 0);
    return {
      ownerId: o.ownerId, ownerName: o.ownerName, total: t, won, lost, closed,
      conversionPct: t ? r1((won / t) * 100) : 0,
      winPct: closed ? r1((won / closed) * 100) : null, // null-safe: no closed deals yet
      avgAgeDays: t ? Math.round(ageSum / t) : 0,
    };
  });

  // ── S5 — ageing (OPEN leads, by days since last activity) ──
  const BUCKETS = [
    { key: "0-7", label: "0–7 days", min: 0, max: 7 },
    { key: "8-14", label: "8–14 days", min: 8, max: 14 },
    { key: "15-30", label: "15–30 days", min: 15, max: 30 },
    { key: "31-60", label: "31–60 days", min: 31, max: 60 },
    { key: "60+", label: "60+ days", min: 61, max: Infinity },
  ];
  const daysSinceAct = (l: any) => Math.max(0, Math.floor((now - l._lastActivity) / DAY));
  const bucketOf = (d: number) => BUCKETS.find((b) => d >= b.min && d <= b.max)!.key;
  const openLeads = scoped.filter((l) => !isClosed(l.stage));
  const openTotal = openLeads.length;
  const ageingCount: Record<string, number> = {};
  for (const b of BUCKETS) ageingCount[b.key] = 0;
  for (const l of openLeads) ageingCount[bucketOf(daysSinceAct(l))]++;
  const ageing = {
    openTotal,
    buckets: BUCKETS.map((b) => ({
      key: b.key, label: b.label, count: ageingCount[b.key],
      pct: openTotal ? r1((ageingCount[b.key] / openTotal) * 100) : 0,
    })),
    byOwner: owners.map((o) => {
      const open = o.leads.filter((l) => !isClosed(l.stage));
      const bc: Record<string, number> = {};
      for (const b of BUCKETS) bc[b.key] = 0;
      for (const l of open) bc[bucketOf(daysSinceAct(l))]++;
      const ot = open.length;
      const bp: Record<string, number> = {};
      for (const b of BUCKETS) bp[b.key] = ot ? r1((bc[b.key] / ot) * 100) : 0;
      return { ownerId: o.ownerId, ownerName: o.ownerName, total: ot, buckets: bc, bucketPct: bp };
    }),
  };

  // ── S6 — stale (OPEN, days since last activity ≥ 14; critical ≥ 30) ──
  const STALE_DAYS = 14;
  const CRIT_DAYS = 30;
  let totalStale = 0;
  let totalPotential = 0;
  const staleByOwner = owners
    .map((o) => {
      const staleLeads = o.leads.filter((l) => !isClosed(l.stage) && daysSinceAct(l) >= STALE_DAYS);
      const potentialValue = staleLeads.reduce((s, l) => s + (Number(l.dealValue) || 0), 0);
      const criticalCount = staleLeads.filter((l) => daysSinceAct(l) >= CRIT_DAYS).length;
      totalStale += staleLeads.length;
      totalPotential += potentialValue;
      return {
        ownerId: o.ownerId, ownerName: o.ownerName, count: staleLeads.length,
        potentialValue, criticalCount, critical: criticalCount > 0,
      };
    })
    .filter((o) => o.count > 0)
    .sort((a, b) => b.count - a.count);
  const stale = {
    thresholdDays: STALE_DAYS, criticalDays: CRIT_DAYS,
    totalStale, totalPotentialValue: totalPotential, byOwner: staleByOwner,
  };

  // ── S7 — pipeline value by owner (OPEN leads) ──
  let totalPipeline = 0;
  let anyValue = false;
  const pipelineByOwner = owners
    .map((o) => {
      const open = o.leads.filter((l) => !isClosed(l.stage));
      const pipelineValue = open.reduce((s, l) => s + (Number(l.dealValue) || 0), 0);
      const valuedLeads = open.filter((l) => (Number(l.dealValue) || 0) > 0).length;
      if (pipelineValue > 0) anyValue = true;
      totalPipeline += pipelineValue;
      return {
        ownerId: o.ownerId, ownerName: o.ownerName,
        openLeads: open.length, pipelineValue, valuedLeads,
      };
    })
    .sort((a, b) => b.pipelineValue - a.pipelineValue);
  const pipeline = { totalPipelineValue: totalPipeline, hasAnyValue: anyValue, byOwner: pipelineByOwner };

  // ── S8 — activity effectiveness (attributed to the lead's owner) ──
  // Counts activities DONE IN THE PERIOD: each activity is included only when
  // its own createdAt falls in [dateFrom, dateTo] (when a range is set), scoped
  // to the report's leads. Not "all activities of snapshot leads".
  const INTERACTION_TYPES = OWNER_STATUS_INTERACTION_TYPES as readonly string[];
  const typeTotals: Record<string, number> = {};
  for (const t of INTERACTION_TYPES) typeTotals[t] = 0;
  const actByOwner = new Map<string, Record<string, number>>();
  for (const o of owners) {
    const m: Record<string, number> = {};
    for (const t of INTERACTION_TYPES) m[t] = 0;
    actByOwner.set(o.ownerId, m);
  }
  for (const l of scoped) {
    const m = actByOwner.get(ownerKey(l));
    for (const a of l._acts) {
      const at = new Date(a.createdAt).getTime();
      if (fromMs != null && at < fromMs) continue;
      if (toMs != null && at > toMs) continue;
      if (INTERACTION_TYPES.includes(a.type)) {
        typeTotals[a.type]++;
        if (m) m[a.type]++;
      }
    }
  }
  const activityEffectiveness = {
    types: INTERACTION_TYPES.map((t) => ({ key: t, label: TYPE_LABEL[t] })),
    presentTypes: INTERACTION_TYPES.filter((t) => typeTotals[t] > 0).map((t) => ({
      key: t, label: TYPE_LABEL[t], count: typeTotals[t],
    })),
    absentTypes: INTERACTION_TYPES.filter((t) => typeTotals[t] === 0).map((t) => ({
      key: t, label: TYPE_LABEL[t],
    })),
    byOwner: owners.map((o) => {
      const counts = actByOwner.get(o.ownerId)!;
      const won = o.leads.filter((l) => l.stage === "won").length;
      return {
        ownerId: o.ownerId, ownerName: o.ownerName, activityCounts: counts,
        totalActivities: INTERACTION_TYPES.reduce((s, k) => s + counts[k], 0),
        conversionPct: o.leads.length ? r1((won / o.leads.length) * 100) : 0,
      };
    }),
  };

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      dateFrom: fromMs != null ? new Date(fromMs).toISOString() : null,
      dateTo: toMs != null ? new Date(toMs).toISOString() : null,
      assignedTo: assignedToF, stage: stageF, source: sourceF, type: typeF,
    },
    totals: { totalLeads: total, byStatus: statusCount },
    statusSnapshot,
    ownerMatrix,
    performance,
    ageing,
    stale,
    pipeline,
    activityEffectiveness,
  };
}
