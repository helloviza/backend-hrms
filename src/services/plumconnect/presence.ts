// apps/backend/src/services/plumconnect/presence.ts
//
// PlumConnect Track A — agent presence, per department line. Track A
// stores and exposes the signal; Track B (services/plumconnect/
// assignment.ts, the matrix) consumes activeAgentsForLine() to route a
// captured lead to a present agent who can act on it.
//
//   setPresence          only on a line the agent HOLDS (Slice 7 grant ≥
//                        READ — access.ts is the authority, nothing here
//                        re-implements the check)
//   getPresence          the user's per-line map; absent row = away
//   activeAgentsForLine  users active on a line, FRESH, still holding the
//                        grant, and ACTIVE users — resolved against current
//                        grants on every read, never trusted from the row
//
// Staleness: an active row older than PLUMCONNECT_PRESENCE_TTL_MS (default
// 8 h) reads as away, so a forgotten "active" cannot route leads to
// someone who closed their laptop. Computed on read, like the Slice 2
// expense-flow TTL (expenseInFlow.ts); no sweep, nothing is rewritten.

import mongoose from "mongoose";
import PlumConnectAgentPresence from "../../models/plumconnect/AgentPresence.js";
import User from "../../models/User.js";
import { activeUserFilter } from "../../utils/userActiveStatus.js";
import { ACCESS_LINES, canAccessLine, holdsAtLeast, isAccessLine, lineGrantsForUserId, type AccessLine, type LineGrants } from "./access.js";

export const PRESENCE_TTL_ENV = "PLUMCONNECT_PRESENCE_TTL_MS";
export const DEFAULT_PRESENCE_TTL_MS = 8 * 60 * 60 * 1000;

export function presenceTtlMs(): number {
  const raw = Number(process.env[PRESENCE_TTL_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PRESENCE_TTL_MS;
}

/** An active row counts only while it was touched inside the TTL. */
export function isPresenceFresh(updatedAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!updatedAt) return false;
  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < presenceTtlMs();
}

export interface LinePresence {
  /** Effective state: the row says active AND it is fresh. */
  active: boolean;
  /** The stored flag, before staleness is applied (for the UI to say "went stale"). */
  stored: boolean;
  stale: boolean;
  activeSince: Date | null;
  updatedAt: Date | null;
}
export type PresenceMap = Record<AccessLine, LinePresence>;

const AWAY: LinePresence = { active: false, stored: false, stale: false, activeSince: null, updatedAt: null };

function toId(v: mongoose.Types.ObjectId | string): mongoose.Types.ObjectId | null {
  return mongoose.isValidObjectId(String(v)) ? new mongoose.Types.ObjectId(String(v)) : null;
}

export type SetPresenceResult =
  | { ok: true; line: AccessLine; presence: LinePresence }
  | { ok: false; reason: "invalid_line" | "line_not_held" | "invalid_user" };

/**
 * Set my presence on ONE line. `grants` are the caller's CURRENT Slice 7
 * grants (the guard already resolved them — routes pass lineGrants(req));
 * a line not held at READ+ is refused and nothing is written.
 */
export async function setPresence(input: {
  userId: mongoose.Types.ObjectId | string;
  grants: LineGrants;
  line: unknown;
  active: boolean;
  now?: Date;
}): Promise<SetPresenceResult> {
  const now = input.now ?? new Date();
  if (!isAccessLine(input.line)) return { ok: false, reason: "invalid_line" };
  const userId = toId(input.userId);
  if (!userId) return { ok: false, reason: "invalid_user" };
  if (!holdsAtLeast(canAccessLine(input.grants, input.line), "READ")) return { ok: false, reason: "line_not_held" };

  const existing: any = await PlumConnectAgentPresence.findOne({ userId, line: input.line }).lean();
  // activeSince starts a new stretch only on an away → active edge (or a
  // stale active refreshed), so a repeated "active" heartbeat keeps its start.
  const wasEffectivelyActive = Boolean(existing?.active) && isPresenceFresh(existing?.updatedAt, now);
  const activeSince = input.active ? (wasEffectivelyActive && existing?.activeSince ? new Date(existing.activeSince) : now) : null;

  const row: any = await PlumConnectAgentPresence.findOneAndUpdate(
    { userId, line: input.line },
    { $set: { active: input.active, activeSince, updatedAt: now }, $setOnInsert: { userId, line: input.line, createdAt: now } },
    { upsert: true, new: true, timestamps: false },
  ).lean();
  return { ok: true, line: input.line, presence: fromRow(row, now) };
}

function fromRow(row: any, now: Date): LinePresence {
  if (!row) return AWAY;
  const stored = Boolean(row.active);
  const fresh = isPresenceFresh(row.updatedAt, now);
  return {
    active: stored && fresh,
    stored,
    stale: stored && !fresh,
    activeSince: row.activeSince ? new Date(row.activeSince) : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt) : null,
  };
}

/** The user's per-line map. A line with no row (or a stale active row) reads away. */
export async function getPresence(userId: mongoose.Types.ObjectId | string, now: Date = new Date()): Promise<PresenceMap> {
  const map = Object.fromEntries(ACCESS_LINES.map((l) => [l, AWAY])) as PresenceMap;
  const id = toId(userId);
  if (!id) return map;
  const rows: any[] = await PlumConnectAgentPresence.find({ userId: id }).lean();
  for (const row of rows) if (isAccessLine(row.line)) map[row.line] = fromRow(row, now);
  return map;
}

/**
 * The agents Track B may route a `line` lead to: an active, FRESH presence
 * row, an ACTIVE User, and — resolved right now, never from the row — a
 * Slice 7 grant at `min` or above on that line (READ by default; the
 * router passes WRITE — present ≠ able). A revoked grant with a
 * stale-but-true row is not eligible.
 */
export async function activeAgentsForLine(line: AccessLine, now: Date = new Date(), min: "READ" | "WRITE" | "FULL" = "READ"): Promise<mongoose.Types.ObjectId[]> {
  const since = new Date(now.getTime() - presenceTtlMs());
  const rows: any[] = await PlumConnectAgentPresence.find({ line, active: true, updatedAt: { $gt: since } }).select("userId").lean();
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => String(r.userId)))].map((s) => new mongoose.Types.ObjectId(s));
  const users: any[] = await User.find({ _id: { $in: ids }, ...activeUserFilter() }).select("_id roles").lean();
  const eligible: mongoose.Types.ObjectId[] = [];
  for (const u of users) {
    const grants = await lineGrantsForUserId(u._id, u.roles);
    if (holdsAtLeast(canAccessLine(grants, line), min)) eligible.push(u._id);
  }
  return eligible;
}
