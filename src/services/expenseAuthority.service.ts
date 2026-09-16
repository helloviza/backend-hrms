// apps/backend/src/services/expenseAuthority.service.ts
//
// "How much can this person approve?" — approval-engine sub-step 3.
//
// Two inputs, one rule:
//   • RANK DEFAULT  — ExpenseBand.defaultApprovalLimitBase for the person's
//                     rank (User.bandNumber, L1–L10). Per workspace; ships
//                     EMPTY; base currency.
//   • PERSONAL      — ExpenseApproverGrant.limitBase (sub-step 1).
//
//   effective = max(rankDefault ?? 0, personal ?? 0)        — RAISE-ONLY (D1)
//
// A personal grant can lift someone above their rank's default, never below
// it. No rank + no grant → 0 (cannot finally approve on limit alone — the
// engine treats such a person as endorse-only, D3). A rank whose default is
// not configured counts as 0. Everything is in the workspace base currency.
//
// The engine (sub-step 5) reads effectiveLimit(); nothing here routes.
import mongoose from "mongoose";
import ExpenseBand from "../models/ExpenseBand.js";
import User from "../models/User.js";
import { grantsByUserId, loadGrant, type ExpenseGrantView } from "./expenseGrants.service.js";

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export type RankRow = {
  bandNumber: number;
  label: string; // display only ("Team Lead"); default "L<n>"
  defaultApprovalLimitBase: number | null; // null = not configured (= 0 for resolution)
  configured: boolean; // a row exists for this rank
};

export type EffectiveLimit = {
  bandNumber: number | null;
  rankLabel: string | null;
  rankDefaultLimitBase: number | null; // null when no rank, or rank not configured
  personalLimitBase: number | null; // null when no grant / no personal limit
  effectiveLimitBase: number; // 0 = none
  // Which input produced the effective figure. "none" when it is 0.
  limitSource: "none" | "rank" | "personal";
};

export function defaultRankLabel(n: number): string {
  return `L${n}`;
}

/** The 10-row rank table for a workspace (missing rows filled, unconfigured). */
export async function getRankTable(workspaceId: mongoose.Types.ObjectId | string): Promise<RankRow[]> {
  const rows: any[] = await ExpenseBand.find({ workspaceId: oid(workspaceId) })
    .select("bandNumber bandName defaultApprovalLimitBase")
    .lean();
  const byRank = new Map<number, any>(rows.map((r) => [Number(r.bandNumber), r]));
  return RANKS.map((n) => {
    const r = byRank.get(n);
    const limit = r?.defaultApprovalLimitBase;
    return {
      bandNumber: n,
      label: (r?.bandName && String(r.bandName).trim()) || defaultRankLabel(n),
      defaultApprovalLimitBase: limit == null ? null : Number(limit),
      configured: !!r,
    };
  });
}

/**
 * THE RESOLUTION RULE — pure, so it can be tested without a database and
 * reused by the engine on already-loaded data.
 */
export function effectiveApprovalLimit(input: {
  bandNumber: number | null | undefined;
  rankTable: Pick<RankRow, "bandNumber" | "label" | "defaultApprovalLimitBase">[];
  grant: Pick<ExpenseGrantView, "limitBase"> | null | undefined;
}): EffectiveLimit {
  const band = input.bandNumber != null && Number.isFinite(Number(input.bandNumber)) ? Number(input.bandNumber) : null;
  const rankRow = band != null ? input.rankTable.find((r) => r.bandNumber === band) : undefined;
  const rankDefault =
    rankRow && rankRow.defaultApprovalLimitBase != null && Number(rankRow.defaultApprovalLimitBase) > 0
      ? Number(rankRow.defaultApprovalLimitBase)
      : null;
  const personal =
    input.grant && input.grant.limitBase != null && Number(input.grant.limitBase) > 0
      ? Number(input.grant.limitBase)
      : null;

  // Raise-only: the higher of the two wins; a lower personal figure never
  // pulls someone below their rank default.
  const effective = Math.max(rankDefault ?? 0, personal ?? 0);
  const limitSource: EffectiveLimit["limitSource"] =
    effective <= 0 ? "none" : personal != null && personal > (rankDefault ?? 0) ? "personal" : "rank";

  return {
    bandNumber: band,
    rankLabel: band != null ? rankRow?.label ?? defaultRankLabel(band) : null,
    rankDefaultLimitBase: rankDefault,
    personalLimitBase: personal,
    effectiveLimitBase: effective,
    limitSource,
  };
}

/** One person's effective limit, from the database. */
export async function getEffectiveLimitForUser(
  workspaceId: mongoose.Types.ObjectId | string,
  userId: mongoose.Types.ObjectId | string,
): Promise<EffectiveLimit> {
  const [user, grant, rankTable] = await Promise.all([
    User.findOne({ _id: oid(userId), workspaceId: oid(workspaceId) }).select("bandNumber").lean(),
    loadGrant(workspaceId, userId),
    getRankTable(workspaceId),
  ]);
  return effectiveApprovalLimit({ bandNumber: (user as any)?.bandNumber ?? null, rankTable, grant });
}

/** Batched: effective limits for many users of one workspace (Team list, engine pool). */
export async function getEffectiveLimitsForUsers(
  workspaceId: mongoose.Types.ObjectId | string,
  users: { _id: any; bandNumber?: number | null }[],
): Promise<Map<string, EffectiveLimit>> {
  const [grants, rankTable] = await Promise.all([
    grantsByUserId(workspaceId, users.map((u) => u._id)),
    getRankTable(workspaceId),
  ]);
  const out = new Map<string, EffectiveLimit>();
  for (const u of users) {
    out.set(
      String(u._id),
      effectiveApprovalLimit({ bandNumber: u.bandNumber ?? null, rankTable, grant: grants.get(String(u._id)) ?? null }),
    );
  }
  return out;
}

/** Write one rank row (label and/or default limit). Only the keys given change. */
export async function setRankRow(params: {
  workspaceId: mongoose.Types.ObjectId | string;
  bandNumber: number;
  label?: string | null;
  defaultApprovalLimitBase?: number | null;
}): Promise<RankRow> {
  const update: Record<string, any> = {};
  if (params.label !== undefined) update.bandName = String(params.label ?? "").trim();
  if (params.defaultApprovalLimitBase !== undefined) {
    update.defaultApprovalLimitBase = params.defaultApprovalLimitBase == null ? null : Number(params.defaultApprovalLimitBase);
  }
  const row: any = await ExpenseBand.findOneAndUpdate(
    { workspaceId: oid(params.workspaceId), bandNumber: params.bandNumber },
    { $set: update, $setOnInsert: { workspaceId: oid(params.workspaceId), bandNumber: params.bandNumber, currency: "INR" } },
    { upsert: true, new: true, runValidators: true },
  ).lean();
  return {
    bandNumber: params.bandNumber,
    label: (row?.bandName && String(row.bandName).trim()) || defaultRankLabel(params.bandNumber),
    defaultApprovalLimitBase: row?.defaultApprovalLimitBase == null ? null : Number(row.defaultApprovalLimitBase),
    configured: true,
  };
}
