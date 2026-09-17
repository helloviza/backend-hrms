// apps/backend/src/services/expenseRouting.service.ts
//
// THE routing walk — approval-engine sub-step 4. ONE pure function,
// routeClaim(), used by the simulator now (read-only "what-if") and by the
// live engine in sub-step 5 to route real claims. It never touches the
// database: every input is passed in, every output is a plain object in the
// same shape the audit trail's `routed` record already carries
// (Report.routing / ExpenseActivity.details for event "routed").
//
// The walk, in order (spec v2 §2.4–2.6):
//   1. category modifiers — strictest of each lever across the claim's
//      categories: neverAutoApprove (any), floor (max), weight (max, ≥1)
//   2. required limit = max(amount × weight, floor)
//   3. the bot — enabled ∧ amount ≤ the ceiling that applies (a single-category
//      claim: THAT category's bot limit, "Not Applicable" = never; otherwise the
//      workspace-wide threshold) ∧ not category-blocked ∧ every ENFORCED
//      pre-check (policy.bot.require) passes → auto-approve; otherwise it hands
//      off (never declines)
//   4. candidates — approver-flagged, active, in scope, ≠ submitter, sorted by
//      effective limit ascending
//   5. manager first (firstStep) — covers → FINAL; else endorses, then …
//   6. … the LOWEST-limit candidate that covers `required` (skipping every
//      smaller one — that is the "climb")
//   7. nobody covers → topOfChain: top approver flagged (+ a second senior
//      co-approver = four eyes), or refuse
//
// Everything is in the workspace base currency.
import { effectiveApprovalLimit, type EffectiveLimit, type RankRow } from "./expenseAuthority.service.js";
import type { PolicyView } from "./expensePolicy.service.js";

export type RoutingPerson = {
  id: string;
  name: string;
  active: boolean;
  bandNumber: number | null;
  approver: boolean; // grant.approver
  personalLimitBase: number | null; // grant.limitBase
  departmentIds: string[]; // grant scope ([] = all)
};

/**
 * Bot pre-checks. The KEYS depend on what is being routed — the walk only
 * asks "did every check pass?" and names the failed ones:
 *   claim   { receipt, category, noDuplicate, positiveAmounts }   (from the lines)
 *   advance { positiveAmount, purposePresent, validDates }         (no bills exist yet —
 *            receipts / categories / duplicate bills are NOT applied)
 */
export type RoutingChecks = Record<string, boolean>;

/** A category on the claim + the ceiling under which the bot may approve it. */
export type CategoryBotLimit = {
  categoryId: string;
  name: string;
  mode: "amount" | "na";
  amountBase: number | null;
  /** false = the admin has never answered for this category (legacy row). */
  set: boolean;
};
export type ClaimChecks = { receipt: boolean; category: boolean; noDuplicate: boolean; positiveAmounts: boolean };
export type AdvanceChecks = { positiveAmount: boolean; purposePresent: boolean; validDates: boolean };

export type RoutingInput = {
  kind: "claim" | "advance";
  amountBase: number;
  baseCurrency: string;
  categoryIds: string[];
  /** Per-category bot ceilings for the categories on this claim (see the bot step). */
  categoryBotLimits?: CategoryBotLimit[];
  submitter: { id: string; name: string; departmentId: string | null; managerId: string | null };
  manager: RoutingPerson | null; // the submitter's line manager, if any (may not be an approver)
  candidates: RoutingPerson[]; // everyone in the workspace who could be an approver (the walk filters)
  checks: RoutingChecks; // bot pre-checks, computed by the caller from the lines
  policy: PolicyView;
  rankTable: Pick<RankRow, "bandNumber" | "label" | "defaultApprovalLimitBase">[];
  now?: Date;
};

export type RoutingTraceEntry = {
  step: "bot" | "manager" | "limit" | "top" | "four_eyes";
  level: number | null;
  userId: string | null;
  name: string | null;
  outcome: "chosen" | "skipped" | "considered" | "none" | "approved";
  reason: string;
  limitBase?: number | null;
  covers?: boolean | null;
};

export type RoutingChainLevel = {
  level: number;
  actorType: "user" | "bot";
  approverId: string | null;
  name: string;
  via: "bot" | "manager" | "limit" | "top" | "four_eyes";
  limitBase: number | null;
  overLimit: boolean;
  final: boolean; // this level's approval finalises the claim (last level)
};

export type RoutingOutcome =
  | "BOT_AUTO_APPROVE"
  | "MANAGER_FINAL"
  | "MANAGER_THEN_LIMIT"
  | "LIMIT"
  | "TOP_FLAGGED"
  | "TOP_FLAGGED_FOUR_EYES"
  | "REFUSE"
  | "NO_APPROVER";

export type RoutingDecision = {
  mode: "engine";
  engineVersion: 1;
  policyVersion: number;
  kind: "claim" | "advance";
  amountBase: number;
  baseCurrency: string;
  bot: {
    evaluated: boolean;
    enabled: boolean;
    /** The ceiling actually applied — a category's for a single-category claim, the global one otherwise. */
    thresholdBase: number | null;
    /** Which rule supplied it. */
    limitSource: "category" | "global" | null;
    /** The single category that governed it (null for mixed / none). */
    limitCategory: { categoryId: string; name: string } | null;
    /** true = a single-category claim whose category is Not Applicable → never auto-approves. */
    categoryNotApplicable: boolean;
    /** The workspace-wide threshold, kept for reference even when a category governed. */
    globalThresholdBase: number | null;
    underThreshold: boolean | null;
    blockedByCategory: boolean;
    checks: RoutingChecks;
    /** Only the checks the policy actually enforces (policy.bot.require). */
    checksEnforced: string[];
    checksPassed: boolean | null;
    wouldAutoApprove: boolean;
    reason: string;
  };
  rule: {
    kind: "engine_limit_table";
    departmentId: string | null;
    categoryIds: string[];
    matchedCategoryRules: PolicyView["categoryRules"];
    weight: number;
    categoryFloorBase: number | null;
    neverAutoApprove: boolean;
    departmentScopeEnforced: boolean;
    firstStep: PolicyView["firstStep"];
    topOfChain: PolicyView["topOfChain"];
    managerAllowance: PolicyView["managerAllowance"];
  };
  requiredLimitBase: number;
  candidatesConsidered: number;
  trace: RoutingTraceEntry[];
  chosen: { level: number; userId: string | null; name: string; via: RoutingChainLevel["via"]; limitBase: number | null }[];
  chain: RoutingChainLevel[];
  climbed: boolean;
  overLimit: boolean;
  fourEyes: boolean;
  outcome: RoutingOutcome;
  explain: string[];
  decidedAt: Date;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function limitOf(p: RoutingPerson, rankTable: RoutingInput["rankTable"]): EffectiveLimit {
  return effectiveApprovalLimit({ bandNumber: p.bandNumber, rankTable, grant: { limitBase: p.personalLimitBase } });
}

export function routeClaim(input: RoutingInput): RoutingDecision {
  const now = input.now ?? new Date();
  const policy = input.policy;
  const amount = round2(Number(input.amountBase) || 0);
  const trace: RoutingTraceEntry[] = [];
  const explain: string[] = [];
  const chain: RoutingChainLevel[] = [];

  // ── 1. category modifiers — strictest wins ──
  const cats = new Set(input.categoryIds.map(String));
  const matched = policy.categoryRules.filter((r) => cats.has(String(r.categoryId)));
  const weight = Math.max(1, ...matched.map((r) => (r.weight != null && r.weight >= 1 ? r.weight : 1)));
  const floor = matched.reduce<number | null>((m, r) => {
    const v = r.minApproverLimitBase;
    if (v == null || v <= 0) return m;
    return m == null ? v : Math.max(m, v);
  }, null);
  const neverBot = matched.some((r) => r.neverAutoApprove);

  // ── 2. required limit ──
  const required = round2(Math.max(amount * weight, floor ?? 0));
  explain.push(
    `Claim total ${fmt(amount, input.baseCurrency)}` +
      (weight > 1 ? ` × ${weight} (category weight)` : "") +
      (floor != null ? ` · category floor ${fmt(floor, input.baseCurrency)}` : "") +
      ` → an approver needs a limit of at least ${fmt(required, input.baseCurrency)}.`,
  );

  // ── 3. the bot ──
  //
  // (a) WHICH CEILING APPLIES. A claim whose bills are all ONE category is
  //     governed by THAT category's bot limit — including "Not Applicable",
  //     which means it never auto-approves however small it is. A claim
  //     spanning MORE THAN ONE category (or carrying none at all, and every
  //     advance) is governed by the workspace-wide threshold on the Rulebook
  //     tab. A category limit is never overridden by the global one.
  const globalThreshold = policy.bot.thresholdBase;
  const catLimits = input.categoryBotLimits ?? [];
  const singleCat = input.kind === "claim" && cats.size === 1
    ? catLimits.find((c) => cats.has(String(c.categoryId))) ?? null
    : null;
  const categoryNotApplicable = !!singleCat && singleCat.mode !== "amount";
  const limitSource: "category" | "global" | null = singleCat ? "category" : "global";
  const appliedLimit: number | null = singleCat ? (singleCat.mode === "amount" ? singleCat.amountBase : null) : globalThreshold;

  // (b) WHICH PRE-CHECKS ARE ENFORCED (audit F-22). The engine used to demand
  //     that EVERY computed check pass, ignoring policy.bot.require entirely —
  //     so switching a pre-check off changed nothing. Now a check is enforced
  //     only when the policy says so. Keys the policy has no switch for (the
  //     advance checks) stay enforced, as before.
  const isEnforced = (key: string): boolean => {
    const req = policy.bot.require as Record<string, boolean> | undefined;
    if (!req || !(key in req)) return true;
    return !!req[key];
  };
  const enforcedEntries = Object.entries(input.checks).filter(([k]) => isEnforced(k));
  const checksEnforced = enforcedEntries.map(([k]) => k);
  const checksPassed = enforcedEntries.every(([, v]) => v);

  const botEnabled = !!policy.bot.enabled && (appliedLimit != null || categoryNotApplicable);
  // null = no ceiling was applied at all (bot off, or the category is N/A).
  const under = botEnabled && appliedLimit != null ? amount <= Number(appliedLimit) : null;
  const wouldAuto = !!(botEnabled && !categoryNotApplicable && under && !neverBot && checksPassed);
  const ceiling = () => `${fmt(Number(appliedLimit), input.baseCurrency)}${singleCat ? ` (${singleCat.name} limit)` : " (mixed-category limit)"}`;
  let botReason = "bot not enabled";
  if (botEnabled) {
    if (categoryNotApplicable) {
      botReason = `${singleCat!.name} never auto-approves (bot limit: Not Applicable)`;
    } else if (!under) {
      botReason = `over the bot limit ${ceiling()}`;
    } else if (neverBot) {
      botReason = "a category on this claim is marked never-auto-approve";
    } else if (!checksPassed) {
      const failed = enforcedEntries.filter(([, v]) => !v).map(([k]) => k);
      botReason = `pre-check failed: ${failed.join(", ")}`;
    } else {
      botReason = `under the bot limit ${ceiling()} and every enforced pre-check passed`;
    }
  }
  const bot: RoutingDecision["bot"] = {
    evaluated: botEnabled,
    enabled: !!policy.bot.enabled,
    thresholdBase: appliedLimit,
    limitSource: botEnabled || singleCat ? limitSource : null,
    limitCategory: singleCat ? { categoryId: String(singleCat.categoryId), name: singleCat.name } : null,
    categoryNotApplicable,
    globalThresholdBase: globalThreshold,
    underThreshold: under,
    blockedByCategory: neverBot,
    checks: input.checks,
    checksEnforced,
    checksPassed: botEnabled ? checksPassed : null,
    wouldAutoApprove: wouldAuto,
    reason: botReason,
  };
  trace.push({ step: "bot", level: wouldAuto ? 1 : null, userId: null, name: "Approval Bot", outcome: wouldAuto ? "approved" : botEnabled ? "skipped" : "none", reason: botReason });

  const base = (outcome: RoutingOutcome, extra: Partial<RoutingDecision> = {}): RoutingDecision => ({
    mode: "engine",
    engineVersion: 1,
    policyVersion: policy.version,
    kind: input.kind,
    amountBase: amount,
    baseCurrency: input.baseCurrency,
    bot,
    rule: {
      kind: "engine_limit_table",
      departmentId: input.submitter.departmentId,
      categoryIds: [...cats],
      matchedCategoryRules: matched,
      weight,
      categoryFloorBase: floor,
      neverAutoApprove: neverBot,
      departmentScopeEnforced: policy.departmentScopeEnforced,
      firstStep: policy.firstStep,
      topOfChain: policy.topOfChain,
      managerAllowance: policy.managerAllowance,
    },
    requiredLimitBase: required,
    candidatesConsidered: 0,
    trace,
    chosen: chain.map((c) => ({ level: c.level, userId: c.approverId, name: c.name, via: c.via, limitBase: c.limitBase })),
    chain,
    climbed: false,
    overLimit: false,
    fourEyes: false,
    outcome,
    explain,
    decidedAt: now,
    ...extra,
  });

  if (wouldAuto) {
    chain.push({ level: 1, actorType: "bot", approverId: null, name: "Approval Bot", via: "bot", limitBase: appliedLimit, overLimit: false, final: true });
    explain.push(
      `The Approval Bot approves it: under the ${singleCat ? `${singleCat.name} limit` : "mixed-category limit"} ` +
        `${fmt(Number(appliedLimit), input.baseCurrency)}, clean, no blocked category.`,
    );
    return base("BOT_AUTO_APPROVE");
  }
  if (botEnabled) explain.push(`The Bot steps aside — ${botReason}.`);

  // ── 4. candidates ──
  const me = String(input.submitter.id);
  const scoped = (p: RoutingPerson) =>
    !policy.departmentScopeEnforced ||
    !input.submitter.departmentId ||
    p.departmentIds.length === 0 ||
    p.departmentIds.map(String).includes(String(input.submitter.departmentId));
  const pool = input.candidates
    .filter((p) => String(p.id) !== me)
    .map((p) => ({ p, lim: limitOf(p, input.rankTable) }))
    .filter(({ p }) => p.active && p.approver)
    .filter(({ p }) => {
      const ok = scoped(p);
      if (!ok) trace.push({ step: "limit", level: null, userId: p.id, name: p.name, outcome: "skipped", reason: "outside the submitter's department scope" });
      return ok;
    })
    .sort((a, b) => {
      if (a.lim.effectiveLimitBase !== b.lim.effectiveLimitBase) return a.lim.effectiveLimitBase - b.lim.effectiveLimitBase;
      // ties: department-scoped before unscoped, then higher rank, then name
      const sa = a.p.departmentIds.length ? 0 : 1;
      const sb = b.p.departmentIds.length ? 0 : 1;
      if (sa !== sb) return sa - sb;
      if ((b.p.bandNumber ?? 0) !== (a.p.bandNumber ?? 0)) return (b.p.bandNumber ?? 0) - (a.p.bandNumber ?? 0);
      return a.p.name.localeCompare(b.p.name);
    });
  const candidatesConsidered = pool.length;

  // ── 5. manager first ──
  let level = 1;
  let managerEndorses = false;
  const mgr = input.manager;
  const mgrEligible = !!mgr && String(mgr.id) !== me && mgr.active && policy.firstStep === "MANAGER_THEN_AUTHORITY";
  let mgrLimit: number | null = null;
  if (mgrEligible && mgr) {
    const own = limitOf(mgr, input.rankTable).effectiveLimitBase;
    // D3: a manager with NO limit of their own may finally approve up to the allowance.
    const allowance = policy.managerAllowance.enabled && policy.managerAllowance.limitBase != null ? Number(policy.managerAllowance.limitBase) : 0;
    mgrLimit = own > 0 ? own : allowance;
    const covers = mgrLimit >= required && mgrLimit > 0;
    if (covers) {
      chain.push({ level, actorType: "user", approverId: mgr.id, name: mgr.name, via: "manager", limitBase: mgrLimit, overLimit: false, final: true });
      trace.push({ step: "manager", level, userId: mgr.id, name: mgr.name, outcome: "chosen", reason: own > 0 ? "line manager; own limit covers the claim" : "line manager; manager allowance covers the claim", limitBase: mgrLimit, covers: true });
      explain.push(`${mgr.name} (line manager, limit ${fmt(mgrLimit, input.baseCurrency)}) covers it and is the final approver.`);
      return base("MANAGER_FINAL", { candidatesConsidered });
    }
    chain.push({ level, actorType: "user", approverId: mgr.id, name: mgr.name, via: "manager", limitBase: mgrLimit, overLimit: false, final: false });
    trace.push({ step: "manager", level, userId: mgr.id, name: mgr.name, outcome: "chosen", reason: mgrLimit > 0 ? "line manager endorses; limit too small to finalise" : "line manager endorses; no limit of their own (allowance off)", limitBase: mgrLimit, covers: false });
    explain.push(`${mgr.name} (line manager, limit ${fmt(mgrLimit, input.baseCurrency)}) endorses first but cannot finalise.`);
    managerEndorses = true;
    level++;
  } else if (mgr && policy.firstStep === "MANAGER_THEN_AUTHORITY") {
    trace.push({ step: "manager", level: null, userId: mgr.id, name: mgr.name, outcome: "skipped", reason: String(mgr.id) === me ? "manager is the submitter" : "manager is inactive" });
  } else if (!mgr && policy.firstStep === "MANAGER_THEN_AUTHORITY") {
    trace.push({ step: "manager", level: null, userId: null, name: null, outcome: "none", reason: "no line manager set" });
  }

  // ── 6. lowest covering approver (the climb) ──
  let chosenEntry: { p: RoutingPerson; lim: EffectiveLimit } | null = null;
  let skipped = 0;
  for (const c of pool) {
    if (mgr && String(c.p.id) === String(mgr.id)) {
      trace.push({ step: "limit", level: null, userId: c.p.id, name: c.p.name, outcome: "skipped", reason: "already in the chain as line manager", limitBase: c.lim.effectiveLimitBase, covers: c.lim.effectiveLimitBase >= required });
      continue;
    }
    const covers = c.lim.effectiveLimitBase >= required && c.lim.effectiveLimitBase > 0;
    if (!covers) {
      skipped++;
      trace.push({ step: "limit", level: null, userId: c.p.id, name: c.p.name, outcome: "skipped", reason: `limit ${fmt(c.lim.effectiveLimitBase, input.baseCurrency)} too small (${c.lim.limitSource})`, limitBase: c.lim.effectiveLimitBase, covers: false });
      continue;
    }
    chosenEntry = c;
    trace.push({ step: "limit", level, userId: c.p.id, name: c.p.name, outcome: "chosen", reason: `lowest limit that covers ${fmt(required, input.baseCurrency)} (${c.lim.limitSource})`, limitBase: c.lim.effectiveLimitBase, covers: true });
    break;
  }
  if (chosenEntry) {
    // Everyone above the chosen one was merely considered.
    for (const c of pool) {
      if (c === chosenEntry || (mgr && String(c.p.id) === String(mgr.id))) continue;
      if (c.lim.effectiveLimitBase >= chosenEntry.lim.effectiveLimitBase && !trace.some((t) => t.userId === c.p.id)) {
        trace.push({ step: "limit", level: null, userId: c.p.id, name: c.p.name, outcome: "considered", reason: "covers too, but a smaller covering limit was chosen", limitBase: c.lim.effectiveLimitBase, covers: true });
      }
    }
    chain.push({ level, actorType: "user", approverId: chosenEntry.p.id, name: chosenEntry.p.name, via: "limit", limitBase: chosenEntry.lim.effectiveLimitBase, overLimit: false, final: true });
    explain.push(
      `${skipped > 0 ? `Climbed past ${skipped} approver${skipped === 1 ? "" : "s"} whose limit was too small; ` : ""}` +
        `${chosenEntry.p.name} (limit ${fmt(chosenEntry.lim.effectiveLimitBase, input.baseCurrency)}) is the lowest who covers it and is the final approver.`,
    );
    return base(managerEndorses ? "MANAGER_THEN_LIMIT" : "LIMIT", { candidatesConsidered, climbed: skipped > 0 });
  }

  // ── 7. nobody covers ──
  const ranked = pool.filter((c) => !(mgr && String(c.p.id) === String(mgr.id))).sort((a, b) => b.lim.effectiveLimitBase - a.lim.effectiveLimitBase);
  const top = ranked[0] ?? null;
  const second = ranked[1] ?? null;
  if (!top || top.lim.effectiveLimitBase <= 0) {
    explain.push("Nobody in the approver pool holds a limit at all.");
    if (managerEndorses) explain.push("Only the line manager's endorsement is possible — the claim has no final approver.");
    trace.push({ step: "top", level: null, userId: null, name: null, outcome: "none", reason: "no approver with a limit in the pool" });
    return base("NO_APPROVER", { candidatesConsidered });
  }
  if (policy.topOfChain === "REFUSE_SUBMIT") {
    trace.push({ step: "top", level: null, userId: top.p.id, name: top.p.name, outcome: "skipped", reason: `highest limit ${fmt(top.lim.effectiveLimitBase, input.baseCurrency)} still below ${fmt(required, input.baseCurrency)}; policy refuses`, limitBase: top.lim.effectiveLimitBase, covers: false });
    explain.push(`No approver holds authority for ${fmt(required, input.baseCurrency)} — policy is to refuse the submit.`);
    return base("REFUSE", { candidatesConsidered, overLimit: true });
  }
  chain.push({ level, actorType: "user", approverId: top.p.id, name: top.p.name, via: "top", limitBase: top.lim.effectiveLimitBase, overLimit: true, final: policy.topOfChain !== "TOP_APPROVES_FLAGGED_FOUR_EYES" || !second });
  trace.push({ step: "top", level, userId: top.p.id, name: top.p.name, outcome: "chosen", reason: `highest limit ${fmt(top.lim.effectiveLimitBase, input.baseCurrency)} is still below ${fmt(required, input.baseCurrency)} — approves FLAGGED over limit`, limitBase: top.lim.effectiveLimitBase, covers: false });
  explain.push(`Nobody's limit covers ${fmt(required, input.baseCurrency)}: ${top.p.name} (highest, ${fmt(top.lim.effectiveLimitBase, input.baseCurrency)}) approves, flagged OVER LIMIT.`);
  let fourEyes = false;
  if (policy.topOfChain === "TOP_APPROVES_FLAGGED_FOUR_EYES") {
    if (second) {
      level++;
      chain.push({ level, actorType: "user", approverId: second.p.id, name: second.p.name, via: "four_eyes", limitBase: second.lim.effectiveLimitBase, overLimit: true, final: true });
      trace.push({ step: "four_eyes", level, userId: second.p.id, name: second.p.name, outcome: "chosen", reason: "second senior co-approver (four eyes)", limitBase: second.lim.effectiveLimitBase, covers: false });
      explain.push(`Four eyes: ${second.p.name} (next highest, ${fmt(second.lim.effectiveLimitBase, input.baseCurrency)}) must also approve.`);
      fourEyes = true;
    } else {
      trace.push({ step: "four_eyes", level: null, userId: null, name: null, outcome: "none", reason: "no second senior approver exists — top approves alone, flag stays on record" });
      explain.push("No second senior approver exists — the top approver signs alone; the over-limit flag stays on the record.");
    }
  }
  return base(fourEyes ? "TOP_FLAGGED_FOUR_EYES" : "TOP_FLAGGED", { candidatesConsidered, climbed: skipped > 0, overLimit: true, fourEyes });
}

function fmt(n: number, ccy: string): string {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: ccy || "INR", maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${ccy} ${n.toFixed(2)}`;
  }
}
