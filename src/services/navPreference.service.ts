// apps/backend/src/services/navPreference.service.ts
//
// The ONLY writer of User.visibleNavGroups (docs/audits/nav-visible-groups-audit.md).
// Used by PUT /api/admin/nav-preferences/:userId (SUPERADMIN) and by
// scripts/set-visible-nav-groups.ts. Every real change writes one
// NavPreferenceAudit row; a no-op change writes nothing.
import { isValidObjectId } from "mongoose";
import User from "../models/User.js";
import NavPreferenceAudit from "../models/NavPreferenceAudit.js";
import { normalizeStoredNavGroups, parseVisibleNavGroups } from "../config/navGroups.js";

export type NavPrefActor = { id?: string | null; email?: string | null };

export type SetNavGroupsResult =
  | { ok: true; changed: boolean; userId: string; email: string; before: string[] | null; after: string[] | null }
  | { ok: false; status: 400 | 404; error: string };

function sameList(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/** Current value of one user (null = full Header). */
export async function getVisibleNavGroups(userId: string) {
  if (!isValidObjectId(userId)) return null;
  const u: any = await User.findById(userId).select("_id email visibleNavGroups").lean();
  if (!u) return null;
  return { userId: String(u._id), email: String(u.email || ""), visibleNavGroups: normalizeStoredNavGroups(u.visibleNavGroups) };
}

/**
 * Plans the change without writing (dryRun) or applies it. Clearing unsets the
 * field, so the document goes back to exactly what it was before.
 */
export async function setVisibleNavGroups(opts: {
  userId: string;
  value: unknown;
  actor: NavPrefActor;
  via: "api" | "script";
  dryRun?: boolean;
}): Promise<SetNavGroupsResult> {
  const parsed = parseVisibleNavGroups(opts.value);
  if ("error" in parsed) return { ok: false, status: 400, error: parsed.error };
  if (!isValidObjectId(opts.userId)) return { ok: false, status: 404, error: "User not found" };

  const user: any = await User.findById(opts.userId).select("_id email visibleNavGroups").lean();
  if (!user) return { ok: false, status: 404, error: "User not found" };

  const before = normalizeStoredNavGroups(user.visibleNavGroups);
  const after = parsed.value ? [...parsed.value] : null;
  const changed = !sameList(before, after);
  const base = { userId: String(user._id), email: String(user.email || ""), before, after };
  if (!changed || opts.dryRun) return { ok: true, changed, ...base };

  await User.updateOne(
    { _id: user._id },
    after ? { $set: { visibleNavGroups: after } } : { $unset: { visibleNavGroups: 1 } },
  );
  await NavPreferenceAudit.create({
    userId: user._id,
    email: base.email,
    before: before ?? undefined,
    after: after ?? undefined,
    actorId: opts.actor.id && isValidObjectId(opts.actor.id) ? opts.actor.id : undefined,
    actorEmail: opts.actor.email || undefined,
    via: opts.via,
  });
  return { ok: true, changed: true, ...base };
}
