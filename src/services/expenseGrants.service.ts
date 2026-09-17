// apps/backend/src/services/expenseGrants.service.ts
//
// Read / write helpers for ExpenseApproverGrant plus the ONE middleware that
// makes the grant visible to the synchronous predicates in expense.access.ts.
//
// expense.access.ts#isAdmin / isFinance are called with `req.user` (the JWT
// payload) all over the six expense routers, synchronously. The grant lives in
// Mongo, so it is loaded ONCE per request by attachExpenseGrant (mounted right
// after requireWorkspace on every expense router) and parked on
// `req.user.expenseGrant`; the predicates read that field. For User DOCUMENTS
// (the approver-candidate scan in reports.service.ts, the Team page list) the
// same field is attached from a batched lookup — withGrants().
import mongoose from "mongoose";
import ExpenseApproverGrant, { type IExpenseApproverGrant } from "../models/ExpenseApproverGrant.js";
import Department from "../models/Department.js";

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

/** The reader-facing shape parked on req.user / user docs. */
export type ExpenseGrantView = {
  approver: boolean;
  limitBase: number | null;
  departmentIds: string[];
  finance: boolean;
  expenseAdmin: boolean;
};

export function grantView(g: any): ExpenseGrantView | null {
  if (!g || g.active === false) return null;
  return {
    approver: !!g.approver,
    limitBase: g.limitBase == null ? null : Number(g.limitBase),
    departmentIds: Array.isArray(g.scope?.departmentIds) ? g.scope.departmentIds.map(String) : [],
    finance: !!g.capabilities?.finance,
    expenseAdmin: !!g.capabilities?.expenseAdmin,
  };
}

export async function loadGrant(
  workspaceId: mongoose.Types.ObjectId | string,
  userId: mongoose.Types.ObjectId | string,
): Promise<ExpenseGrantView | null> {
  if (!workspaceId || !userId || !mongoose.Types.ObjectId.isValid(String(userId))) return null;
  const g = await ExpenseApproverGrant.findOne({ workspaceId: oid(workspaceId), userId: oid(userId), active: true }).lean();
  return grantView(g);
}

/**
 * Express middleware — mount AFTER requireWorkspace on every expense router.
 * Attaches `req.user.expenseGrant` (or null). Never fails the request: a
 * lookup error just means "no grant", which is the safe direction.
 */
export async function attachExpenseGrant(req: any, _res: any, next: any) {
  try {
    const ws = req.workspaceObjectId;
    const uid = req.user?.id || req.user?._id || req.user?.sub;
    req.user.expenseGrant = ws && uid ? await loadGrant(ws, uid) : null;
  } catch (err: any) {
    console.error("[attachExpenseGrant]", err?.message || err);
    if (req.user) req.user.expenseGrant = null;
  }
  next();
}

/** Batched: `{ [userId]: view }` for the given users in one workspace. */
export async function grantsByUserId(
  workspaceId: mongoose.Types.ObjectId | string,
  userIds: (mongoose.Types.ObjectId | string)[],
): Promise<Map<string, ExpenseGrantView>> {
  const out = new Map<string, ExpenseGrantView>();
  if (!userIds.length) return out;
  const rows = await ExpenseApproverGrant.find({
    workspaceId: oid(workspaceId),
    userId: { $in: userIds.map(oid) },
    active: true,
  }).lean();
  for (const g of rows) {
    const v = grantView(g);
    if (v) out.set(String(g.userId), v);
  }
  return out;
}

/** Attach `expenseGrant` to each lean User doc so isAdmin()/isFinance() can read it. */
export async function withGrants<T extends { _id: any }>(
  workspaceId: mongoose.Types.ObjectId | string,
  users: T[],
): Promise<(T & { expenseGrant: ExpenseGrantView | null })[]> {
  const map = await grantsByUserId(workspaceId, users.map((u) => u._id));
  return users.map((u) => Object.assign(u, { expenseGrant: map.get(String(u._id)) ?? null }));
}

/** User ids holding an active expense-admin grant in the workspace (candidate scans). */
export async function expenseAdminUserIds(
  workspaceId: mongoose.Types.ObjectId | string,
): Promise<mongoose.Types.ObjectId[]> {
  const rows = await ExpenseApproverGrant.find({
    workspaceId: oid(workspaceId),
    active: true,
    "capabilities.expenseAdmin": true,
  })
    .select("userId")
    .lean();
  return rows.map((r) => r.userId as mongoose.Types.ObjectId);
}

export type GrantPatch = {
  approver?: boolean;
  limitBase?: number | null;
  departmentIds?: string[];
  finance?: boolean;
  expenseAdmin?: boolean;
};

/**
 * Validate a department-id list against THIS workspace's Department rows
 * (same rule as workspace.travellers.ts#resolveDepartmentId: id AND
 * workspaceId AND isActive in one query — a foreign or made-up id is refused
 * with the same message).
 */
export async function resolveDepartmentIds(
  workspaceId: mongoose.Types.ObjectId | string,
  raw: any,
): Promise<{ value?: mongoose.Types.ObjectId[]; error?: string }> {
  if (raw === undefined) return {};
  if (raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: "departmentIds must be an array of department ids" };
  const ids = raw.map((x) => String(x).trim()).filter(Boolean);
  if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    return { error: "departmentIds contains an invalid id" };
  }
  if (ids.length === 0) return { value: [] };
  const found = await Department.find({
    _id: { $in: ids.map(oid) },
    workspaceId: oid(workspaceId),
    isActive: true,
  })
    .select("_id")
    .lean();
  if (found.length !== new Set(ids).size) {
    return { error: "One or more departments are not active departments of this workspace." };
  }
  return { value: found.map((d) => d._id as mongoose.Types.ObjectId) };
}

/**
 * Create-or-update the grant for one user. Only the keys present in `patch`
 * change; every change is appended to the on-document history with the
 * actor. Returns the fresh document.
 */
export async function upsertGrant(params: {
  workspaceId: mongoose.Types.ObjectId | string;
  userId: mongoose.Types.ObjectId | string;
  patch: GrantPatch & { departmentObjectIds?: mongoose.Types.ObjectId[] };
  actorId?: mongoose.Types.ObjectId | string | null;
  reason?: string | null;
}): Promise<IExpenseApproverGrant> {
  const ws = oid(params.workspaceId);
  const uid = oid(params.userId);
  const by = params.actorId ? oid(params.actorId) : null;

  let g = await ExpenseApproverGrant.findOne({ workspaceId: ws, userId: uid });
  if (!g) {
    g = new ExpenseApproverGrant({
      workspaceId: ws,
      userId: uid,
      grantedBy: by,
      grantedAt: new Date(),
    });
  }
  if (g.active === false) {
    // A revoked grant being touched again is a re-grant.
    g.active = true;
    g.revokedAt = null;
    g.revokedBy = null;
    g.revokeReason = null;
    g.grantedBy = by;
    g.grantedAt = new Date();
  }

  const change: Record<string, any> = {};
  const p = params.patch;
  const set = (key: string, before: any, after: any) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) change[key] = { from: before, to: after };
  };
  if (p.approver !== undefined) {
    set("approver", g.approver, !!p.approver);
    g.approver = !!p.approver;
  }
  if (p.limitBase !== undefined) {
    const next = p.limitBase == null ? null : Number(p.limitBase);
    set("limitBase", g.limitBase ?? null, next);
    g.limitBase = next;
  }
  if (p.departmentObjectIds !== undefined) {
    set("departmentIds", (g.scope?.departmentIds || []).map(String), p.departmentObjectIds.map(String));
    g.scope = { departmentIds: p.departmentObjectIds };
  }
  if (p.finance !== undefined) {
    set("finance", !!g.capabilities?.finance, !!p.finance);
    g.capabilities.finance = !!p.finance;
  }
  if (p.expenseAdmin !== undefined) {
    set("expenseAdmin", !!g.capabilities?.expenseAdmin, !!p.expenseAdmin);
    g.capabilities.expenseAdmin = !!p.expenseAdmin;
  }
  if (Object.keys(change).length > 0 || g.isNew) {
    g.updatedBy = by;
    g.history.push({ at: new Date(), by, change, reason: params.reason ?? null });
  }
  await g.save();
  // Sub-step 8: losing the approver flag strands whatever was waiting on them.
  if (change.approver && change.approver.from === true && change.approver.to === false) {
    await rerouteAfterLosingApproverRights(ws, uid);
  }
  return g;
}

/**
 * Sub-step 8 — shared by both ways approver rights end (the flag switched off
 * above, and a whole grant revoked below). Lazily imported and never allowed to
 * throw, exactly like the deactivation hook: the grant change has already been
 * persisted and must stand whatever happens here.
 */
async function rerouteAfterLosingApproverRights(ws: mongoose.Types.ObjectId, uid: mongoose.Types.ObjectId): Promise<void> {
  try {
    const { rerouteForDepartedApprover } = await import("./expenseReroute.service.js");
    await rerouteForDepartedApprover({ userId: uid, workspaceId: ws, trigger: "grant_removed" });
  } catch (err: any) {
    console.error("[expenseGrants] re-route after losing approver rights failed:", err?.message);
  }
}

/** Revoke (soft) — used on user deactivation. Idempotent. */
export async function revokeGrant(params: {
  workspaceId: mongoose.Types.ObjectId | string;
  userId: mongoose.Types.ObjectId | string;
  actorId?: mongoose.Types.ObjectId | string | null;
  reason: string;
}): Promise<boolean> {
  const g = await ExpenseApproverGrant.findOne({
    workspaceId: oid(params.workspaceId),
    userId: oid(params.userId),
    active: true,
  });
  if (!g) return false;
  const by = params.actorId ? oid(params.actorId) : null;
  g.active = false;
  g.revokedAt = new Date();
  g.revokedBy = by;
  g.revokeReason = params.reason;
  g.history.push({ at: new Date(), by, change: { active: { from: true, to: false } }, reason: params.reason });
  const wasApprover = !!g.approver;
  await g.save();
  if (wasApprover) {
    await rerouteAfterLosingApproverRights(oid(params.workspaceId), oid(params.userId));
  }
  return true;
}
