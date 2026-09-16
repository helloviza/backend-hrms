// apps/backend/src/services/expensePolicy.service.ts
//
// Read / default / write for the per-workspace ExpenseApprovalPolicy
// (approval-engine sub-step 4). Readers get a DEFAULT (everything off) when
// no document exists, without creating one — a workspace that never opened
// the policy screen has no row and behaves exactly as today.
import mongoose from "mongoose";
import ExpenseApprovalPolicy, {
  type IExpenseApprovalPolicy,
  type TopOfChainMode,
  type FirstStepMode,
} from "../models/ExpenseApprovalPolicy.js";
import ExpenseCategory from "../models/ExpenseCategory.js";
import User from "../models/User.js";

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/** Plain, reader-facing shape (also what the routing walk consumes). */
export type PolicyView = {
  workspaceId: string;
  version: number;
  exists: boolean;
  engineEnabled: boolean;
  bot: {
    enabled: boolean;
    thresholdBase: number | null;
    require: { receipt: boolean; category: boolean; noDuplicate: boolean; positiveAmounts: boolean };
  };
  managerAllowance: { enabled: boolean; limitBase: number | null };
  categoryRules: { categoryId: string; neverAutoApprove: boolean; minApproverLimitBase: number | null; weight: number | null }[];
  departmentScopeEnforced: boolean;
  topOfChain: TopOfChainMode;
  firstStep: FirstStepMode;
  legacyEscalation: { claimThresholdBase: number | null; advanceThresholdBase: number | null; seniorApproverId: string | null };
  updatedAt: Date | null;
};

export function defaultPolicyView(workspaceId: mongoose.Types.ObjectId | string): PolicyView {
  return {
    workspaceId: String(workspaceId),
    version: 0,
    exists: false,
    engineEnabled: false,
    bot: { enabled: false, thresholdBase: null, require: { receipt: true, category: true, noDuplicate: true, positiveAmounts: true } },
    managerAllowance: { enabled: false, limitBase: null },
    categoryRules: [],
    departmentScopeEnforced: false,
    topOfChain: "TOP_APPROVES_FLAGGED_FOUR_EYES",
    firstStep: "MANAGER_THEN_AUTHORITY",
    legacyEscalation: { claimThresholdBase: null, advanceThresholdBase: null, seniorApproverId: null },
    updatedAt: null,
  };
}

export function policyView(doc: any, workspaceId: mongoose.Types.ObjectId | string): PolicyView {
  if (!doc) return defaultPolicyView(workspaceId);
  const d = defaultPolicyView(workspaceId);
  return {
    workspaceId: String(doc.workspaceId ?? workspaceId),
    version: Number(doc.version ?? 1),
    exists: true,
    engineEnabled: !!doc.engineEnabled,
    bot: {
      enabled: !!doc.bot?.enabled,
      thresholdBase: doc.bot?.thresholdBase == null ? null : Number(doc.bot.thresholdBase),
      require: { ...d.bot.require, ...(doc.bot?.require || {}) },
    },
    managerAllowance: {
      enabled: !!doc.managerAllowance?.enabled,
      limitBase: doc.managerAllowance?.limitBase == null ? null : Number(doc.managerAllowance.limitBase),
    },
    categoryRules: (Array.isArray(doc.categoryRules) ? doc.categoryRules : []).map((r: any) => ({
      categoryId: String(r.categoryId),
      neverAutoApprove: !!r.neverAutoApprove,
      minApproverLimitBase: r.minApproverLimitBase == null ? null : Number(r.minApproverLimitBase),
      weight: r.weight == null ? null : Number(r.weight),
    })),
    departmentScopeEnforced: !!doc.departmentScopeEnforced,
    topOfChain: doc.topOfChain || d.topOfChain,
    firstStep: doc.firstStep || d.firstStep,
    legacyEscalation: {
      claimThresholdBase: doc.legacyEscalation?.claimThresholdBase == null ? null : Number(doc.legacyEscalation.claimThresholdBase),
      advanceThresholdBase: doc.legacyEscalation?.advanceThresholdBase == null ? null : Number(doc.legacyEscalation.advanceThresholdBase),
      seniorApproverId: doc.legacyEscalation?.seniorApproverId ? String(doc.legacyEscalation.seniorApproverId) : null,
    },
    updatedAt: doc.updatedAt ?? null,
  };
}

/** Read without creating — defaults when absent. */
export async function getPolicy(workspaceId: mongoose.Types.ObjectId | string): Promise<PolicyView> {
  const doc = await ExpenseApprovalPolicy.findOne({ workspaceId: oid(workspaceId) }).lean();
  return policyView(doc, workspaceId);
}

export type PolicyPatch = {
  engineEnabled?: boolean;
  bot?: { enabled?: boolean; thresholdBase?: number | null; require?: Partial<PolicyView["bot"]["require"]> };
  managerAllowance?: { enabled?: boolean; limitBase?: number | null };
  categoryRules?: { categoryId: string; neverAutoApprove?: boolean; minApproverLimitBase?: number | null; weight?: number | null }[];
  departmentScopeEnforced?: boolean;
  topOfChain?: TopOfChainMode;
  firstStep?: FirstStepMode;
  legacyEscalation?: { claimThresholdBase?: number | null; advanceThresholdBase?: number | null; seniorApproverId?: string | null };
};

const TOP: TopOfChainMode[] = ["TOP_APPROVES_FLAGGED_FOUR_EYES", "TOP_APPROVES_FLAGGED", "REFUSE_SUBMIT"];
const FIRST: FirstStepMode[] = ["MANAGER_THEN_AUTHORITY", "AUTHORITY_ONLY"];

function nonNegOrNull(v: any, name: string, errors: string[]): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) errors.push(`${name} must be a non-negative number, or null`);
  return n;
}

/**
 * Validate a patch against THIS workspace (category ids must be its own
 * categories; seniorApproverId its own user). Returns the errors, if any.
 */
export async function validatePolicyPatch(
  workspaceId: mongoose.Types.ObjectId | string,
  patch: PolicyPatch,
): Promise<string[]> {
  const errors: string[] = [];
  if (patch.bot) {
    nonNegOrNull(patch.bot.thresholdBase, "bot.thresholdBase", errors);
  }
  if (patch.managerAllowance) {
    nonNegOrNull(patch.managerAllowance.limitBase, "managerAllowance.limitBase", errors);
  }
  if (patch.topOfChain !== undefined && !TOP.includes(patch.topOfChain)) errors.push(`topOfChain must be one of ${TOP.join(", ")}`);
  if (patch.firstStep !== undefined && !FIRST.includes(patch.firstStep)) errors.push(`firstStep must be one of ${FIRST.join(", ")}`);
  if (patch.categoryRules !== undefined) {
    if (!Array.isArray(patch.categoryRules)) {
      errors.push("categoryRules must be an array");
    } else {
      const ids = patch.categoryRules.map((r) => String(r?.categoryId || ""));
      if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) errors.push("categoryRules: every rule needs a valid categoryId");
      if (new Set(ids).size !== ids.length) errors.push("categoryRules: one rule per category");
      for (const r of patch.categoryRules) {
        nonNegOrNull(r.minApproverLimitBase, "categoryRules.minApproverLimitBase", errors);
        if (r.weight !== undefined && r.weight !== null) {
          const w = Number(r.weight);
          if (!Number.isFinite(w) || w < 1) errors.push("categoryRules.weight must be a number ≥ 1, or null");
        }
      }
      if (errors.length === 0 && ids.length) {
        const found = await ExpenseCategory.find({ _id: { $in: ids.map(oid) }, workspaceId: oid(workspaceId) }).select("_id").lean();
        if (found.length !== ids.length) errors.push("categoryRules: one or more categories are not categories of this workspace");
      }
    }
  }
  if (patch.legacyEscalation) {
    nonNegOrNull(patch.legacyEscalation.claimThresholdBase, "legacyEscalation.claimThresholdBase", errors);
    nonNegOrNull(patch.legacyEscalation.advanceThresholdBase, "legacyEscalation.advanceThresholdBase", errors);
    const s = patch.legacyEscalation.seniorApproverId;
    if (s !== undefined && s !== null && String(s).trim() !== "") {
      if (!mongoose.Types.ObjectId.isValid(String(s))) errors.push("legacyEscalation.seniorApproverId is not a valid id");
      else if (!(await User.exists({ _id: oid(s), workspaceId: oid(workspaceId) }))) {
        errors.push("legacyEscalation.seniorApproverId must be a user in this workspace");
      }
    }
  }
  return errors;
}

/** Create-or-update; only the keys present change; version bumps; history appended. */
export async function updatePolicy(params: {
  workspaceId: mongoose.Types.ObjectId | string;
  patch: PolicyPatch;
  actorId?: mongoose.Types.ObjectId | string | null;
}): Promise<PolicyView> {
  const ws = oid(params.workspaceId);
  let doc = await ExpenseApprovalPolicy.findOne({ workspaceId: ws });
  if (!doc) doc = new ExpenseApprovalPolicy({ workspaceId: ws, version: 0 });
  const before = policyView(doc.toObject(), ws);
  const p = params.patch;

  if (p.engineEnabled !== undefined) doc.engineEnabled = !!p.engineEnabled;
  if (p.bot) {
    if (p.bot.enabled !== undefined) doc.bot.enabled = !!p.bot.enabled;
    if (p.bot.thresholdBase !== undefined) doc.bot.thresholdBase = p.bot.thresholdBase == null ? null : Number(p.bot.thresholdBase);
    if (p.bot.require) doc.bot.require = { ...doc.bot.require, ...p.bot.require } as any;
  }
  if (p.managerAllowance) {
    if (p.managerAllowance.enabled !== undefined) doc.managerAllowance.enabled = !!p.managerAllowance.enabled;
    if (p.managerAllowance.limitBase !== undefined) {
      doc.managerAllowance.limitBase = p.managerAllowance.limitBase == null ? null : Number(p.managerAllowance.limitBase);
    }
  }
  if (p.categoryRules !== undefined) {
    doc.categoryRules = p.categoryRules.map((r) => ({
      categoryId: oid(r.categoryId),
      neverAutoApprove: !!r.neverAutoApprove,
      minApproverLimitBase: r.minApproverLimitBase == null ? null : Number(r.minApproverLimitBase),
      weight: r.weight == null ? null : Number(r.weight),
    })) as any;
  }
  if (p.departmentScopeEnforced !== undefined) doc.departmentScopeEnforced = !!p.departmentScopeEnforced;
  if (p.topOfChain !== undefined) doc.topOfChain = p.topOfChain;
  if (p.firstStep !== undefined) doc.firstStep = p.firstStep;
  if (p.legacyEscalation) {
    const le = p.legacyEscalation;
    if (le.claimThresholdBase !== undefined) doc.legacyEscalation.claimThresholdBase = le.claimThresholdBase == null ? null : Number(le.claimThresholdBase);
    if (le.advanceThresholdBase !== undefined) doc.legacyEscalation.advanceThresholdBase = le.advanceThresholdBase == null ? null : Number(le.advanceThresholdBase);
    if (le.seniorApproverId !== undefined) {
      doc.legacyEscalation.seniorApproverId = le.seniorApproverId && String(le.seniorApproverId).trim() ? oid(le.seniorApproverId) : null;
    }
  }

  const after = policyView(doc.toObject(), ws);
  const change: Record<string, any> = {};
  for (const k of ["engineEnabled", "bot", "managerAllowance", "categoryRules", "departmentScopeEnforced", "topOfChain", "firstStep", "legacyEscalation"] as const) {
    if (JSON.stringify((before as any)[k]) !== JSON.stringify((after as any)[k])) change[k] = { from: (before as any)[k], to: (after as any)[k] };
  }
  if (Object.keys(change).length > 0 || doc.isNew) {
    doc.version = (doc.version || 0) + 1;
    doc.updatedBy = params.actorId ? oid(params.actorId) : null;
    doc.history.push({ at: new Date(), by: params.actorId ? oid(params.actorId) : null, version: doc.version, change });
  }
  await doc.save();
  return policyView(doc.toObject(), ws);
}

export type { IExpenseApprovalPolicy };
