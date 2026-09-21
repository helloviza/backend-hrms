// apps/backend/src/services/plumconnect/access.ts
//
// PlumConnect Slice 7 — per-department access resolution.
//
// Slice 4b gated the whole inbox on one `plumconnect` {access, scope}. This
// replaces it with one capability per LINE — the three business lines the
// Intent Engine routes to (Slice 5) plus "support" for every thread on no
// line — and answers one question: what does THIS caller hold on THIS line?
//
//   lineOfConversation(c)  → which of the four lines a thread belongs to
//   resolveLineGrants(u)   → the caller's {access, scope} on all four
//   canAccessLine(g, line) → that line's grant (NONE/NONE when unheld)
//
// ADMIN / SUPERADMIN are FULL / ALL on every line by role, exactly as the 4b
// guard and requireLeadsAccess treat them. Everyone else is whatever their
// UserPermission row says per key; a missing key is NONE.
//
// The "support" rule (decided here, not folded under a department): a
// conversation with businessLine null and no Lead — a support thread, a
// menu-pending lead thread, or a system kind (expense bot / arrival / trip
// alerts) — needs the plumconnectSupport capability. A pre-Slice-5 lead
// thread (Lead exists, no line stamped) was a holiday lead by construction
// and reads as concierge, the same rule dispatch/flows use. Nothing is
// unreachable: an ADMIN sees all four lines, and the support desk gets the
// one row. A line-scoped sales agent never sees support threads unless
// granted that row explicitly.

import mongoose from "mongoose";
import type { BusinessLine, IPlumConnectConversation } from "../../models/plumconnect/Conversation.js";
import { UserPermission } from "../../models/UserPermission.js";
import { threadBusinessLine } from "./flows/index.js";

type AnyObj = Record<string, any>;

export type AccessLine = BusinessLine | "support";
export const ACCESS_LINES: readonly AccessLine[] = ["plumtrips", "helloviza", "concierge", "support"] as const;

/** The UserPermission.modules key each line is granted through — the four rows of the PLUMCONNECT group. */
export const PLUMCONNECT_MODULE_KEYS: Readonly<Record<AccessLine, string>> = {
  plumtrips: "plumconnectPlumtrips",
  helloviza: "plumconnectHelloviza",
  concierge: "plumconnectConcierge",
  support: "plumconnectSupport",
};

export interface LineGrant {
  access: string; // NONE | READ | WRITE | FULL
  scope: string; // NONE | OWN | TEAM | ALL
}
export type LineGrants = Record<AccessLine, LineGrant>;

const NO_GRANT: LineGrant = { access: "NONE", scope: "NONE" };
const FULL_ALL: LineGrant = { access: "FULL", scope: "ALL" };
const ACCESS_RANK: Record<string, number> = { NONE: 0, READ: 1, WRITE: 2, FULL: 3 };

export function isAccessLine(v: unknown): v is AccessLine {
  return (ACCESS_LINES as readonly string[]).includes(String(v));
}

/** Which of the four lines a conversation is checked against. */
export function lineOfConversation(
  conversation: Pick<IPlumConnectConversation, "businessLine" | "leadId">,
): AccessLine {
  return threadBusinessLine(conversation as IPlumConnectConversation) ?? "support";
}

/** The Mongo match for "conversations on this line" — the inverse of lineOfConversation. */
export function lineMatch(line: AccessLine): AnyObj {
  switch (line) {
    case "support":
      return { businessLine: null, leadId: null };
    case "concierge":
      return { $or: [{ businessLine: "concierge" }, { businessLine: null, leadId: { $ne: null } }] };
    default:
      return { businessLine: line };
  }
}

export function noLineGrants(): LineGrants {
  return { plumtrips: NO_GRANT, helloviza: NO_GRANT, concierge: NO_GRANT, support: NO_GRANT };
}

export function adminLineGrants(): LineGrants {
  return { plumtrips: FULL_ALL, helloviza: FULL_ALL, concierge: FULL_ALL, support: FULL_ALL };
}

export function isAdminByRole(roles: unknown): boolean {
  const list = (Array.isArray(roles) ? roles : []).map((r) => String(r).toUpperCase());
  return list.includes("SUPERADMIN") || list.includes("ADMIN");
}

/** The four grants out of a UserPermission.modules map (missing key → NONE/NONE). */
export function lineGrantsFromModules(modules: AnyObj | null | undefined): LineGrants {
  const out = noLineGrants();
  for (const line of ACCESS_LINES) {
    const mod = modules?.[PLUMCONNECT_MODULE_KEYS[line]];
    out[line] = { access: String(mod?.access || "NONE"), scope: String(mod?.scope || "NONE") };
  }
  return out;
}

/**
 * The caller's grants on all four lines. ADMIN / SUPERADMIN → FULL / ALL
 * everywhere by role (no row read); everyone else → their row's keys.
 */
export async function resolveLineGrants(user: AnyObj): Promise<LineGrants> {
  if (isAdminByRole(user?.roles)) return adminLineGrants();
  const ids = [user?.sub, user?.id].filter(Boolean).map(String);
  if (ids.length === 0) return noLineGrants();
  const perm = (await UserPermission.findOne({ userId: { $in: ids } }).select("modules").lean()) as AnyObj | null;
  return lineGrantsFromModules(perm?.modules);
}

/** What the caller holds on ONE line. */
export function canAccessLine(grants: LineGrants, line: AccessLine): LineGrant {
  return grants[line] ?? NO_GRANT;
}

export function holdsAtLeast(grant: LineGrant, min: "READ" | "WRITE" | "FULL"): boolean {
  return (ACCESS_RANK[grant.access] ?? 0) >= ACCESS_RANK[min];
}

/** The lines the caller holds at `min` or above. Empty = no inbox at all. */
export function heldLines(grants: LineGrants, min: "READ" | "WRITE" | "FULL" = "READ"): AccessLine[] {
  return ACCESS_LINES.filter((line) => holdsAtLeast(canAccessLine(grants, line), min));
}

/**
 * Grants for another user (an assignment target) — the same resolution as
 * the caller's, by User._id. Used so a conversation is never handed to
 * someone who cannot see its line.
 */
export async function lineGrantsForUserId(userId: mongoose.Types.ObjectId | string, roles: unknown): Promise<LineGrants> {
  if (isAdminByRole(roles)) return adminLineGrants();
  const perm = (await UserPermission.findOne({ userId: String(userId) }).select("modules").lean()) as AnyObj | null;
  return lineGrantsFromModules(perm?.modules);
}
