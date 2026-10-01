// apps/backend/src/services/approvalSearch/optionRef.ts
//
// optionRef = "<sid>.<index>" for a flight option, "<sid>.<index>.<room>"
// for a hotel room. sid is 128 random bits (base64url), so refs can't be
// guessed. A ref resolves ONLY for the user and workspace that ran the search,
// and only while the session is unexpired (checked here, not just by TTL).

import crypto from "crypto";
import type { Types } from "mongoose";
import ApprovalSearchSession, {
  SEARCH_SESSION_TTL_MS,
  type ApprovalSearchKind,
  type IApprovalSearchSession,
} from "../../models/ApprovalSearchSession.js";

const REF_RX = /^([A-Za-z0-9_-]{22})\.(\d{1,5})(?:\.(\d{1,4}))?$/;

export function newSessionId(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export function optionRefFor(sid: string, index: number, roomIndex?: number): string {
  return roomIndex == null ? `${sid}.${index}` : `${sid}.${index}.${roomIndex}`;
}

export function parseOptionRef(ref: unknown): { sid: string; index: number; roomIndex: number | null } | null {
  const m = String(ref ?? "").match(REF_RX);
  if (!m) return null;
  return { sid: m[1], index: Number(m[2]), roomIndex: m[3] == null ? null : Number(m[3]) };
}

/** Persists one search run. S1/S2 call this with the raw TBO results they return refs for. */
export async function createSearchSession(args: {
  workspaceId: Types.ObjectId | string;
  userId: string;
  kind: ApprovalSearchKind;
  params: Record<string, any>;
  traceId?: string;
  results: any[];
  now?: Date;
}): Promise<IApprovalSearchSession> {
  const now = args.now ?? new Date();
  return ApprovalSearchSession.create({
    sid: newSessionId(),
    workspaceId: args.workspaceId,
    userId: String(args.userId),
    kind: args.kind,
    params: args.params,
    traceId: args.traceId,
    results: args.results,
    expiresAt: new Date(now.getTime() + SEARCH_SESSION_TTL_MS),
  });
}

export type ResolvedOption = {
  session: IApprovalSearchSession;
  raw: any;
  /** Hotel only: the chosen room. */
  room: any | null;
};

export type OptionRefFailure = "MALFORMED" | "NOT_FOUND" | "EXPIRED" | "NO_SUCH_OPTION" | "WRONG_KIND";

/**
 * Same user + same workspace + unexpired, or a failure reason. A session that
 * exists for someone else reads as NOT_FOUND (never reveal it exists).
 */
export async function resolveOptionRef(
  ref: unknown,
  scope: { userId: string; workspaceId: Types.ObjectId | string; kind: ApprovalSearchKind; now?: Date },
): Promise<{ ok: true; value: ResolvedOption } | { ok: false; reason: OptionRefFailure }> {
  const parsed = parseOptionRef(ref);
  if (!parsed) return { ok: false, reason: "MALFORMED" };

  const session = await ApprovalSearchSession.findOne({
    sid: parsed.sid,
    userId: String(scope.userId),
    workspaceId: scope.workspaceId,
  });
  if (!session) return { ok: false, reason: "NOT_FOUND" };
  if (session.expiresAt.getTime() <= (scope.now ?? new Date()).getTime()) return { ok: false, reason: "EXPIRED" };
  if (session.kind !== scope.kind) return { ok: false, reason: "WRONG_KIND" };

  const raw = session.results?.[parsed.index];
  if (raw == null) return { ok: false, reason: "NO_SUCH_OPTION" };

  let room: any = null;
  if (session.kind === "hotel") {
    room = Array.isArray(raw?.Rooms) ? raw.Rooms[parsed.roomIndex ?? -1] : undefined;
    if (room == null) return { ok: false, reason: "NO_SUCH_OPTION" };
  } else if (parsed.roomIndex != null) {
    return { ok: false, reason: "MALFORMED" };
  }

  return { ok: true, value: { session, raw, room } };
}
