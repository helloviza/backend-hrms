// apps/backend/src/services/expenseRoutingInput.service.ts
//
// Builds the input for routeClaim() from the database — the ONE place that
// knows how to turn a workspace + a submitter + an amount into the pool of
// candidates, the manager, the rank table, the policy and the bot pre-checks.
// Used by the simulator now (sub-step 4) and by the live engine next
// (sub-step 5), so both route from identical facts. Read-only.
//
// Department of the submitter: the engine keys on the managed Department
// collection (ids). Today HRMS users carry a free-text `department` NAME;
// travellers carry TravellerProfile.departmentId. Resolution order:
//   explicit departmentId (simulator) → TravellerProfile.departmentId for
//   this user → Department by name = User.department (within the workspace)
//   → null.
import mongoose from "mongoose";
import User from "../models/User.js";
import Report from "../models/Report.js";
import Expense from "../models/Expense.js";
import Department from "../models/Department.js";
import TravellerProfile from "../models/TravellerProfile.js";
import ExpenseApproverGrant from "../models/ExpenseApproverGrant.js";
import { getPolicy } from "./expensePolicy.service.js";
import { getRankTable, effectiveApprovalLimit } from "./expenseAuthority.service.js";
import { getWorkspaceBaseCurrency, effectiveAmountBase } from "./expenseFx.service.js";
import { activeUserFilter } from "../utils/userActiveStatus.js";
import ExpenseAdvance from "../models/ExpenseAdvance.js";
import ExpenseCategory, { categoryBotLimit } from "../models/ExpenseCategory.js";
import type { RoutingInput, RoutingPerson, RoutingChecks, ClaimChecks, AdvanceChecks, CategoryBotLimit } from "./expenseRouting.service.js";

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

function nameOf(u: any): string {
  return [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() || u?.name || u?.email || String(u?._id || "");
}

export async function resolveSubmitterDepartmentId(workspaceId: any, user: any): Promise<string | null> {
  if (!user) return null;
  const tp: any = await TravellerProfile.findOne({ workspaceId: oid(workspaceId), officialUserId: user._id })
    .select("departmentId")
    .lean()
    .catch(() => null);
  if (tp?.departmentId) return String(tp.departmentId);
  const name = String(user.department || "").trim();
  if (!name) return null;
  const d: any = await Department.findOne({ workspaceId: oid(workspaceId), name, isActive: true }).select("_id").lean();
  return d ? String(d._id) : null;
}

/**
 * Bot pre-checks for an ADVANCE (sub-step 6). There are no bills yet, so the
 * claim checks (receipts / categories / duplicate lines) do not apply. An
 * advance is "clean" when the amount is a positive number, a purpose is
 * given, and every date it carries is a real date that is not in the past
 * (neededBy is optional; absent = fine).
 */
export function checksForAdvance(a: { amount: any; purpose?: any; neededBy?: any; submittedAt?: any }): AdvanceChecks {
  const amount = Number(a.amount);
  const purpose = String(a.purpose ?? "").trim();
  let validDates = true;
  if (a.neededBy != null && String(a.neededBy).trim() !== "") {
    const d = new Date(a.neededBy);
    if (Number.isNaN(d.getTime())) validDates = false;
    else {
      const ref = a.submittedAt ? new Date(a.submittedAt) : new Date();
      const startOfRefDay = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
      if (d.getTime() < startOfRefDay.getTime()) validDates = false; // needed-by in the past
    }
  }
  return { positiveAmount: Number.isFinite(amount) && amount > 0, purposePresent: purpose.length > 0, validDates };
}

/** Bot pre-checks from a claim's lines (the same facts validateReportForSubmit warns on). */
export function checksFromLines(lines: any[]): ClaimChecks {
  const seen = new Set<string>();
  let dupes = 0;
  for (const e of lines) {
    const day = e.date ? new Date(e.date).toISOString().slice(0, 10) : "";
    const key = [String(e.merchant || "").trim().toLowerCase(), Number(e.amount) || 0, day].join("|");
    if (seen.has(key)) dupes++;
    else seen.add(key);
  }
  return {
    receipt: lines.length > 0 && lines.every((e) => !!e.imageKey),
    category: lines.length > 0 && lines.every((e) => !!e.categoryId),
    noDuplicate: dupes === 0,
    positiveAmounts: lines.length > 0 && lines.every((e) => Number(e.amount) > 0),
  };
}

/**
 * The bot limit of every category ON THIS CLAIM, in the shape routeClaim()
 * reads. A category id that no longer resolves (deleted/foreign) is returned
 * as "na" — an unknown ceiling can never justify an auto-approval.
 */
export async function loadCategoryBotLimits(workspaceId: any, categoryIds: string[]): Promise<CategoryBotLimit[]> {
  const ids = [...new Set(categoryIds.map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (ids.length === 0) return [];
  const cats: any[] = await ExpenseCategory.find({ _id: { $in: ids.map(oid) }, workspaceId: oid(workspaceId) })
    .select("name botLimitMode botLimitBase")
    .lean();
  const byId = new Map(cats.map((c) => [String(c._id), c]));
  return ids.map((id) => {
    const c = byId.get(id);
    const lim = categoryBotLimit(c);
    return { categoryId: id, name: c?.name ? String(c.name) : "Unknown category", mode: lim.mode, amountBase: lim.amountBase, set: lim.set && !!c };
  });
}

/** Everyone in the workspace who could be an approver, with their grant. */
export async function loadRoutingPeople(workspaceId: any): Promise<RoutingPerson[]> {
  const ws = oid(workspaceId);
  const [users, grants] = await Promise.all([
    User.find({ workspaceId: ws }).select("firstName lastName name email status bandNumber").lean(),
    ExpenseApproverGrant.find({ workspaceId: ws, active: true }).lean(),
  ]);
  const gById = new Map<string, any>(grants.map((g: any) => [String(g.userId), g]));
  const activeFilter: any = activeUserFilter();
  const isActive = (u: any) => String(u.status || "ACTIVE").toUpperCase() !== "INACTIVE" && (activeFilter ? true : true);
  return users.map((u: any) => {
    const g = gById.get(String(u._id));
    return {
      id: String(u._id),
      name: nameOf(u),
      active: isActive(u),
      bandNumber: u.bandNumber ?? null,
      approver: !!g?.approver,
      personalLimitBase: g?.limitBase == null ? null : Number(g.limitBase),
      departmentIds: Array.isArray(g?.scope?.departmentIds) ? g.scope.departmentIds.map(String) : [],
    };
  });
}

/**
 * ENGINE READINESS (setup console, sub-step 7a). The engine has no admin
 * fallback: with nobody in the pool able to cover anything, EVERY submit would
 * be refused. So before the master switch may be turned on there must be at
 * least one active, approver-flagged person whose effective limit is > 0.
 * Returned in full so the console can say exactly what is missing.
 */
export type EngineReadiness = {
  ready: boolean;
  usableApprovers: { id: string; name: string; effectiveLimitBase: number; limitSource: string }[];
  approversWithoutLimit: { id: string; name: string }[];
  inactiveApprovers: number;
  ranksWithDefault: number;
  peopleWithRank: number;
  missing: string[];
};

export async function engineReadiness(workspaceId: any): Promise<EngineReadiness> {
  const [people, rankTable] = await Promise.all([loadRoutingPeople(workspaceId), getRankTable(workspaceId)]);
  const usable: EngineReadiness["usableApprovers"] = [];
  const noLimit: EngineReadiness["approversWithoutLimit"] = [];
  let inactive = 0;
  for (const p of people) {
    if (!p.approver) continue;
    if (!p.active) {
      inactive++;
      continue;
    }
    const lim = effectiveApprovalLimit({ bandNumber: p.bandNumber, rankTable, grant: { limitBase: p.personalLimitBase } });
    if (lim.effectiveLimitBase > 0) usable.push({ id: p.id, name: p.name, effectiveLimitBase: lim.effectiveLimitBase, limitSource: lim.limitSource });
    else noLimit.push({ id: p.id, name: p.name });
  }
  const ranksWithDefault = rankTable.filter((r) => r.defaultApprovalLimitBase != null && r.defaultApprovalLimitBase > 0).length;
  const peopleWithRank = people.filter((p) => p.bandNumber != null).length;
  const missing: string[] = [];
  if (usable.length === 0) {
    if (people.filter((p) => p.approver).length === 0) missing.push("No one is marked as an approver on the Team page.");
    else if (noLimit.length > 0) missing.push(`${noLimit.length} approver${noLimit.length === 1 ? " has" : "s have"} no approval limit — set a rank default or a personal limit.`);
    if (ranksWithDefault === 0) missing.push("No rank has a default approval limit in the rulebook.");
  }
  return { ready: usable.length > 0, usableApprovers: usable, approversWithoutLimit: noLimit, inactiveApprovers: inactive, ranksWithDefault, peopleWithRank, missing };
}

export type BuildRoutingParams = {
  workspaceId: any;
  kind?: "claim" | "advance";
  reportId?: string; // existing claim → amount, categories, checks, submitter from it
  advanceId?: string; // existing advance → amount, purpose, dates, checks, requester from it
  submitterId?: string; // hypothetical: who submits
  amountBase?: number;
  categoryIds?: string[];
  departmentId?: string | null;
  checks?: Partial<RoutingChecks>; // hypothetical: assume these (default all pass)
  // hypothetical advance facts (kind "advance") — drive the advance checks
  advance?: { purpose?: string | null; neededBy?: string | Date | null };
};

export type BuildRoutingResult = {
  input?: RoutingInput;
  summary?: Record<string, any>;
  error?: string;
  status?: number;
};

export async function buildRoutingInput(p: BuildRoutingParams): Promise<BuildRoutingResult> {
  const ws = oid(p.workspaceId);
  // An existing advance is an advance whatever the caller said.
  const kind: "claim" | "advance" = p.advanceId ? "advance" : p.kind ?? "claim";

  let submitterId = p.submitterId;
  let amountBase = p.amountBase;
  let categoryIds = p.categoryIds ?? [];
  // Default checks per kind — a hypothetical claim assumes clean lines; a
  // hypothetical advance is checked on the facts given (amount / purpose /
  // dates). Explicit `checks` override either.
  let checks: RoutingChecks =
    kind === "advance"
      ? { ...checksForAdvance({ amount: amountBase, purpose: p.advance?.purpose, neededBy: p.advance?.neededBy }), ...(p.checks || {}) }
      : { receipt: true, category: true, noDuplicate: true, positiveAmounts: true, ...(p.checks || {}) };
  let fromClaim: any = null;
  let fromAdvance: any = null;

  if (p.advanceId) {
    if (!mongoose.Types.ObjectId.isValid(p.advanceId)) return { error: "Invalid advanceId", status: 400 };
    const adv: any = await ExpenseAdvance.findOne({ _id: oid(p.advanceId), workspaceId: ws }).lean();
    if (!adv) return { error: "Advance not found", status: 404 };
    amountBase = Number(adv.amount);
    categoryIds = [];
    checks = { ...checksForAdvance(adv), ...(p.checks || {}) };
    submitterId = submitterId ?? String(adv.requesterId);
    fromAdvance = { advanceId: String(adv._id), ref: adv.ref, status: adv.status, currency: adv.currency, purpose: adv.purpose ?? null, neededBy: adv.neededBy ?? null };
  }

  if (p.reportId) {
    if (!mongoose.Types.ObjectId.isValid(p.reportId)) return { error: "Invalid reportId", status: 400 };
    const report: any = await Report.findOne({ _id: oid(p.reportId), workspaceId: ws }).lean();
    if (!report) return { error: "Claim not found", status: 404 };
    const baseCurrency = await getWorkspaceBaseCurrency(ws);
    const lines: any[] = await Expense.find({ workspaceId: ws, reportId: report._id }).lean();
    const pending = lines.filter((l) => effectiveAmountBase(l, baseCurrency) == null).length;
    amountBase = Math.round(lines.reduce((s, l) => s + (effectiveAmountBase(l, baseCurrency) ?? 0), 0) * 100) / 100;
    categoryIds = [...new Set(lines.map((l) => (l.categoryId ? String(l.categoryId) : null)).filter(Boolean) as string[])];
    checks = checksFromLines(lines);
    submitterId = submitterId ?? String(report.employeeId);
    fromClaim = { reportId: String(report._id), ref: report.ref, status: report.status, lineCount: lines.length, pendingConversion: pending };
  }

  if (!submitterId || !mongoose.Types.ObjectId.isValid(submitterId)) return { error: "submitterId (or reportId / advanceId) is required", status: 400 };
  if (amountBase == null || !Number.isFinite(Number(amountBase)) || Number(amountBase) < 0) {
    return { error: "amountBase must be a non-negative number (or pass reportId / advanceId)", status: 400 };
  }
  if (categoryIds.some((c) => !mongoose.Types.ObjectId.isValid(String(c)))) return { error: "categoryIds contains an invalid id", status: 400 };

  const submitter: any = await User.findOne({ _id: oid(submitterId), workspaceId: ws })
    .select("firstName lastName name email department managerId status bandNumber")
    .lean();
  if (!submitter) return { error: "Submitter not found in this workspace", status: 404 };

  let departmentId: string | null;
  if (p.departmentId !== undefined) {
    if (p.departmentId === null) departmentId = null;
    else {
      if (!mongoose.Types.ObjectId.isValid(p.departmentId)) return { error: "departmentId is not a valid id", status: 400 };
      const d = await Department.findOne({ _id: oid(p.departmentId), workspaceId: ws }).select("_id").lean();
      if (!d) return { error: "departmentId is not a department of this workspace", status: 400 };
      departmentId = String(d._id);
    }
  } else {
    departmentId = await resolveSubmitterDepartmentId(ws, submitter);
  }

  const [policy, rankTable, people, baseCurrency, categoryBotLimits] = await Promise.all([
    getPolicy(ws),
    getRankTable(ws),
    loadRoutingPeople(ws),
    getWorkspaceBaseCurrency(ws),
    loadCategoryBotLimits(ws, categoryIds.map(String)),
  ]);
  const manager = submitter.managerId ? people.find((x) => x.id === String(submitter.managerId)) ?? null : null;

  const input: RoutingInput = {
    kind,
    amountBase: Number(amountBase),
    baseCurrency,
    categoryIds: categoryIds.map(String),
    categoryBotLimits,
    submitter: { id: String(submitter._id), name: nameOf(submitter), departmentId, managerId: submitter.managerId ? String(submitter.managerId) : null },
    manager,
    candidates: people,
    checks,
    policy,
    rankTable,
  };
  const summary = {
    kind,
    amountBase: input.amountBase,
    baseCurrency,
    submitter: input.submitter,
    departmentId,
    categoryIds: input.categoryIds,
    categoryBotLimits,
    checks,
    fromClaim,
    fromAdvance,
    policyVersion: policy.version,
    engineEnabled: policy.engineEnabled,
    approverPoolSize: people.filter((x) => x.approver && x.active && x.id !== input.submitter.id).length,
  };
  return { input, summary };
}
