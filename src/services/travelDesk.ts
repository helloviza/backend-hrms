// apps/backend/src/services/travelDesk.ts
//
// Travel Desk case assignment for the approvals ops queue.
//
//   • the team: HOUSE staff chosen in TravelDeskSettings, each Available/Away
//   • manual assign / reassign / unassign (any team agent, Away included)
//   • auto-allocation when a request enters the ops queue (approved or
//     auto-approved) and nobody holds it: the customer's Account Manager
//     first (if enabled, on the team and Available), else round robin
//     (persisted pointer, skips Away) or least busy (fewest open assigned
//     cases; ties rotate). No available agent → left unassigned and flagged.
//   • the assignee gets an email; every change is a history row with a
//     staff-only note (customers keep today's single "Assigned" row).
import mongoose from "mongoose";
import ApprovalRequest from "../models/ApprovalRequest.js";
import TravelDeskSettings, { type AllocationMode } from "../models/TravelDeskSettings.js";
import User from "../models/User.js";
import Customer from "../models/Customer.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { activeUserFilter } from "../utils/userActiveStatus.js";
import { PLUMTRIPS_HOUSE_WORKSPACE_ID } from "../routes/approvals.security.js";
import { UserPermission } from "../models/UserPermission.js";
import { actorStamp, personName, SYSTEM_ACTOR, SYSTEM_NAME } from "./actorNames.js";
import { notifySafely } from "./approvalEmails/dispatch.js";

export const HOUSE_WORKSPACE_ID = PLUMTRIPS_HOUSE_WORKSPACE_ID;

/**
 * The booking team: Access Console "Admin Queue" grant at WRITE or above
 * (WRITE = may act on cases; READ only views). Roles play no part — an ADMIN
 * or SUPERADMIN is an agent only if they hold the grant too.
 */
const AGENT_ACCESS = ["WRITE", "FULL"];

/** A case counts toward an agent's load until it is done or cancelled. */
export const OPEN_ADMIN_STATES = ["assigned", "in_progress", "on_hold"];
const QUEUE_ENTRY_STATES = [null, undefined, "", "pending"];

export type AssignReason = "manual" | "rm" | "round_robin" | "least_busy";
export const REASON_LABEL: Record<AssignReason, string> = {
  manual: "Manual",
  rm: "Customer's Account Manager",
  round_robin: "Round robin",
  least_busy: "Least busy",
};

export type Person = { userId: string; name: string; email: string };
export type TeamAgent = Person & { available: boolean; openCount: number; eligible: boolean };
export type DeskSettings = { mode: AllocationMode; rmFirst: boolean; agents: Array<{ userId: string; available: boolean }>; rrLastUserId: string | null };

export class TravelDeskError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const str = (v: any) => (v === null || v === undefined ? "" : String(v).trim());

/** Profile name (first + last, else `name` — services/actorNames.personName), else the email. */
function displayName(u: any) {
  return personName(u) || str(u?.email) || "Unnamed";
}

/**
 * Who may be put on the desk: active HOUSE users whose Admin Queue grant is
 * active at WRITE+ (live read — a revoked, suspended or downgraded grant, or a
 * deactivated user, drops out on the next call; nothing is cached).
 */
export async function candidatePool(): Promise<Person[]> {
  const grants = (await UserPermission.find({
    status: "active",
    universe: "STAFF",
    "modules.adminQueue.access": { $in: AGENT_ACCESS },
  })
    .select("userId")
    .lean()) as any[];
  const ids = grants.map((g) => String(g.userId || "")).filter((id) => mongoose.isValidObjectId(id));
  if (!ids.length) return [];
  const users = (await User.find({
    _id: { $in: ids },
    workspaceId: new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID),
    ...activeUserFilter(),
  })
    .select("_id name firstName lastName email")
    .lean()) as any[];
  return users
    .map((u) => ({ userId: String(u._id), name: displayName(u), email: str(u.email).toLowerCase() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Staff queue rows: mark open cases whose assignee no longer has queue access
 * (grant revoked / suspended / below WRITE, or user deactivated) as
 * `needsReassignment` — computed on read, so it is never stale and never
 * silently left with someone who cannot work it.
 */
export async function flagNeedsReassignment<T extends Record<string, any>>(rows: T[]): Promise<T[]> {
  const held = rows.filter((r) => str(r?.meta?.adminAssigned?.userId) && !["done", "cancelled"].includes(str(r?.adminState).toLowerCase()));
  if (!held.length) return rows;
  const eligible = new Set((await candidatePool()).map((p) => p.userId));
  for (const r of held) {
    if (!eligible.has(str(r.meta.adminAssigned.userId))) (r as any).needsReassignment = true;
  }
  return rows;
}

export async function getSettings(): Promise<DeskSettings> {
  const d: any = await TravelDeskSettings.findOne({ key: "default" }).lean();
  return {
    mode: (d?.mode as AllocationMode) || "off",
    rmFirst: d ? d.rmFirst !== false : true,
    agents: (Array.isArray(d?.agents) ? d.agents : []).map((a: any) => ({ userId: String(a.userId), available: a.available !== false })),
    rrLastUserId: d?.rrLastUserId ? String(d.rrLastUserId) : null,
  };
}

/** Open (assigned, in progress, on hold) approved cases per assignee. */
export async function openCaseCounts(userIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!userIds.length) return out;
  const rows = await ApprovalRequest.aggregate([
    { $match: { status: "approved", adminState: { $in: OPEN_ADMIN_STATES }, "meta.adminAssigned.userId": { $in: userIds } } },
    { $group: { _id: "$meta.adminAssigned.userId", n: { $sum: 1 } } },
  ]);
  for (const r of rows as any[]) out.set(String(r._id), Number(r.n) || 0);
  return out;
}

/** The desk as configured, in settings order. An agent no longer in the pool
 *  (deactivated, lost the ops role) stays listed as not eligible and is never
 *  picked or assignable. */
export async function teamView(settings?: DeskSettings): Promise<TeamAgent[]> {
  const s = settings || (await getSettings());
  const pool = await candidatePool();
  const byId = new Map(pool.map((p) => [p.userId, p]));
  const missing = s.agents.filter((a) => !byId.has(a.userId)).map((a) => a.userId).filter((id) => mongoose.isValidObjectId(id));
  const others = missing.length ? ((await User.find({ _id: { $in: missing } }).select("_id name firstName lastName email").lean()) as any[]) : [];
  const otherById = new Map(others.map((u) => [String(u._id), u]));
  const counts = await openCaseCounts(s.agents.map((a) => a.userId));
  return s.agents.map((a) => {
    const p = byId.get(a.userId);
    const o = otherById.get(a.userId);
    return {
      userId: a.userId,
      name: p?.name || (o ? displayName(o) : "Unknown user"),
      email: p?.email || str(o?.email).toLowerCase(),
      available: a.available,
      openCount: counts.get(a.userId) || 0,
      eligible: !!p,
    };
  });
}

/** The customer's Account Manager (Customer.accountTeam.accountManager.userId), if any. */
export async function resolveAccountManager(request: any): Promise<string | null> {
  const wsId = request?.workspaceId?._id || request?.workspaceId;
  if (!wsId || !mongoose.isValidObjectId(String(wsId))) return null;
  const ws: any = await CustomerWorkspace.findById(wsId).select("customerId").lean();
  const customerId = str(ws?.customerId);
  if (!customerId || !mongoose.isValidObjectId(customerId)) return null;
  const c: any = await Customer.findById(customerId).select("accountTeam.accountManager.userId").lean();
  return str(c?.accountTeam?.accountManager?.userId) || null;
}

/** The first id in `order` after `last` (wrapping) that is in `allowed`. */
export function rotateFrom(order: string[], last: string | null, allowed: Set<string>): string | null {
  if (!order.length) return null;
  const start = last ? order.indexOf(last) : -1;
  for (let step = 1; step <= order.length; step++) {
    const id = order[(start + step + order.length) % order.length];
    if (allowed.has(id)) return id;
  }
  return null;
}

/** Who gets a new case, and why. Null when nobody is available. */
export async function pickAgent(
  settings: DeskSettings,
  request: any,
  team: TeamAgent[],
): Promise<{ userId: string; reason: Exclude<AssignReason, "manual"> } | null> {
  const avail = team.filter((a) => a.available && a.eligible);
  if (!avail.length) return null;

  if (settings.rmFirst) {
    const rm = await resolveAccountManager(request);
    if (rm && avail.some((a) => a.userId === rm)) return { userId: rm, reason: "rm" };
  }

  const order = team.map((a) => a.userId);
  if (settings.mode === "least_busy") {
    const min = Math.min(...avail.map((a) => a.openCount));
    const tied = new Set(avail.filter((a) => a.openCount === min).map((a) => a.userId));
    const id = rotateFrom(order, settings.rrLastUserId, tied);
    return id ? { userId: id, reason: "least_busy" } : null;
  }
  const id = rotateFrom(order, settings.rrLastUserId, new Set(avail.map((a) => a.userId)));
  return id ? { userId: id, reason: "round_robin" } : null;
}

type Actor = { sub: string; email: string; name: string } | null;

/**
 * Assign (agentUserId) or unassign (null) one case. Manual assignment may pick
 * any eligible team agent, Away included; auto-allocation only picks
 * Available ones (pickAgent). Returns the saved document, or the unchanged one
 * when nothing changed.
 */
export async function assignCase(opts: {
  requestId: string;
  agentUserId: string | null;
  actor: Actor;
  note?: string;
  via: "manual" | "auto";
  reason?: AssignReason;
}): Promise<any> {
  const doc: any = await ApprovalRequest.findById(opts.requestId);
  if (!doc) throw new TravelDeskError(404, "NOT_FOUND", "Request not found");
  if (String(doc.status || "").toLowerCase() !== "approved") {
    throw new TravelDeskError(400, "NOT_IN_OPS_QUEUE", "Only approved requests in the ops queue can be assigned");
  }

  doc.meta = doc.meta || {};
  const prev = doc.meta.adminAssigned || null;
  const prevUserId = str(prev?.userId);
  const note = str(opts.note);
  const reason: AssignReason = opts.reason || "manual";
  let action: string;
  let staffNote: string;
  let assignee: TeamAgent | null = null;

  if (opts.agentUserId) {
    const team = await teamView();
    assignee = team.find((a) => a.userId === String(opts.agentUserId)) || null;
    if (!assignee || !assignee.eligible) {
      throw new TravelDeskError(400, "NOT_TEAM_AGENT", "Pick an agent from the Travel Desk team");
    }
    if (prevUserId === assignee.userId) return doc;

    doc.meta.adminAssigned = {
      agentType: "human",
      userId: assignee.userId,
      agentName: assignee.name,
      agentEmail: assignee.email,
      at: new Date().toISOString(),
      byEmail: opts.actor?.email || "",
      via: opts.via,
      reason,
    };
    delete doc.meta.assignmentFlag;
    if (QUEUE_ENTRY_STATES.includes(doc.adminState)) doc.adminState = "assigned";

    action = opts.via === "auto" ? "admin_auto_assigned" : prevUserId ? "admin_reassigned" : "admin_assigned";
    staffNote =
      `Assigned to ${assignee.name}${assignee.email ? ` <${assignee.email}>` : ""}` +
      (opts.via === "auto" ? ` — auto: ${REASON_LABEL[reason]}` : prev ? ` (was ${str(prev.agentName) || "unassigned"})` : "");
  } else {
    if (!prev) throw new TravelDeskError(400, "NOT_ASSIGNED", "This request is not assigned");
    delete doc.meta.adminAssigned;
    if (doc.adminState === "assigned") doc.adminState = "pending";
    action = "admin_unassigned";
    staffNote = `Unassigned from ${str(prev.agentName) || "previous agent"}`;
  }

  // The note is staff-only: it lives in staffNote, never in the customer-visible comment.
  if (note) staffNote += ` — Note: ${note}`;
  doc.history = Array.isArray(doc.history) ? doc.history : [];
  // The actor is the person who clicked (a staff member), or System for
  // auto-allocation; the assignee is who the case went to / came from.
  const target = assignee || (prev ? { name: str(prev.agentName), email: str(prev.agentEmail) } : null);
  doc.history.push({
    action,
    at: new Date(),
    by: opts.actor?.sub || "system:travel-desk",
    userEmail: opts.actor?.email || "",
    userName: opts.actor?.name || (opts.via === "auto" ? SYSTEM_NAME : ""),
    ...(opts.actor && opts.via !== "auto" ? actorStamp(opts.actor, "staff") : SYSTEM_ACTOR),
    ...(target ? { assigneeName: target.name, assigneeEmail: target.email } : {}),
    staffNote,
  });
  doc.markModified("meta");
  await doc.save();

  if (assignee) await notifyAssignee(doc, assignee, opts.via, reason, note);
  return doc;
}

/**
 * Called when a request enters the ops queue. Never throws: allocation is a
 * convenience and must not fail the approval that triggered it.
 */
export async function autoAllocate(requestId: string): Promise<{ assignedTo?: string; reason?: string; flagged?: boolean; skipped?: string }> {
  try {
    const settings = await getSettings();
    if (settings.mode === "off") return { skipped: "off" };

    const doc: any = await ApprovalRequest.findById(requestId).select("status adminState meta workspaceId").lean();
    if (!doc) return { skipped: "not_found" };
    if (String(doc.status || "").toLowerCase() !== "approved") return { skipped: "not_approved" };
    if (str(doc.meta?.adminAssigned?.userId)) return { skipped: "already_assigned" };
    if (!QUEUE_ENTRY_STATES.includes(doc.adminState)) return { skipped: "already_in_progress" };

    const team = await teamView(settings);
    const pick = await pickAgent(settings, doc, team);
    if (!pick) {
      await ApprovalRequest.updateOne(
        { _id: doc._id },
        { $set: { "meta.assignmentFlag": { code: "NO_AGENT_AVAILABLE", at: new Date().toISOString() } } },
      );
      return { flagged: true };
    }
    if (pick.reason !== "rm") {
      await TravelDeskSettings.updateOne({ key: "default" }, { $set: { rrLastUserId: new mongoose.Types.ObjectId(pick.userId) } });
    }
    await assignCase({ requestId: String(doc._id), agentUserId: pick.userId, actor: null, via: "auto", reason: pick.reason });
    return { assignedTo: pick.userId, reason: pick.reason };
  } catch (err: any) {
    console.error("[travel-desk] auto-allocation failed", { requestId, error: err?.message });
    return { skipped: "error" };
  }
}

/* ───────────────────────── assignee email ───────────────────────── */

function isRoundTrip(meta: any) {
  return ["roundtrip", "round_trip", "return"].includes(str(meta?.tripType).toLowerCase());
}

/** One line per item: route and dates (never prices). */
export function caseLines(doc: any): string[] {
  const items: any[] = Array.isArray(doc?.cartItems) ? doc.cartItems : [];
  return items.map((it) => {
    const m = it?.meta || {};
    const type = str(it?.type).toLowerCase();
    if (type === "flight" || m.origin || m.destination) {
      const route = [str(m.origin), str(m.destination)].filter(Boolean).join(" → ");
      const dates = [str(m.departDate), isRoundTrip(m) ? str(m.returnDate) : ""].filter(Boolean).join(" – ");
      return [`Flight ${route}`.trim(), dates].filter(Boolean).join(" · ");
    }
    if (type === "hotel") {
      const dates = [str(m.checkIn), str(m.checkOut)].filter(Boolean).join(" – ");
      return [`Hotel ${str(m.city || m.destination)}`.trim(), dates].filter(Boolean).join(" · ");
    }
    return str(it?.title) || type || "Item";
  });
}

async function notifyAssignee(doc: any, agent: TeamAgent, via: "manual" | "auto", reason: AssignReason, note: string) {
  if (!agent.email) return;
  await notifySafely("case_assigned", {
    ar: doc,
    agent: { name: agent.name, email: agent.email },
    assignWhy: via === "auto" ? `Auto-assigned (${REASON_LABEL[reason]})` : "Assigned by a colleague",
    assignNote: note,
    tripLines: caseLines(doc),
  });
}
