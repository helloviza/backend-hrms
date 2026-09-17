// apps/backend/src/services/expenseReroute.service.ts
//
// Approval-engine sub-step 8 — RE-ROUTE STRANDED WORK when an approver leaves.
//
// Trigger (both hook into the EXISTING write paths, this is not a parallel
// system):
//   • deactivation      — utils/userActiveStatus.setUserActiveStatus(), the one
//                         place User.status is written
//   • approver rights   — services/expenseGrants.upsertGrant({approver:false})
//                         and revokeGrant()
//
// What it does, per claim/advance that is WAITING on the departing person:
//   1. Re-runs the SAME engine (buildRoutingInput → routeClaim) on the item's
//      CURRENT facts — base-currency total, categories, department, pre-checks —
//      exactly as a fresh submit would, with the departing person removed from
//      the candidate pool (and from the manager slot).
//   2. Keeps every level they had ALREADY decided; only the level pending on
//      them, and anything after it, is re-resolved. History is never undone.
//   3. Re-routed → append-only trail entry `re_routed` (actor: System) carrying
//      the new approver, the reason and the engine's reasoning.
//   4. Cannot be placed → NOT silently stranded: `needsAttention` is flagged on
//      the item (visible to admins in the approvals queue, which already shows
//      every submitted claim to an admin) and a `needs_attention` entry is
//      appended.
//
// TWO DELIBERATE NARROWINGS, both to avoid surprising people:
//
//   • The BOT IS OFF for a re-route. A departure must never *upgrade* an item's
//     outcome: a claim a human was already reviewing should not become
//     auto-approved because an unrelated HR action re-ran the engine. The
//     re-route therefore routes among people only, and the recorded decision
//     shows the bot as not evaluated.
//   • Only items whose ball is in the APPROVER's court move: claims that are
//     `submitted` and advances `awaiting_approval`. A `clarification_required`
//     item is waiting on the EMPLOYEE, and its resubmit builds a fresh chain
//     through the normal path anyway, so re-routing it now would be noise.
//
// Everything else is untouched by construction: approved, declined, reimbursed,
// disbursed, settled items are not in the query, and neither is anything whose
// pending level belongs to somebody else.
import mongoose from "mongoose";
import Report from "../models/Report.js";
import ExpenseAdvance from "../models/ExpenseAdvance.js";
import User from "../models/User.js";
import { buildRoutingInput } from "./expenseRoutingInput.service.js";
import { routeClaim, type RoutingDecision, type RoutingInput } from "./expenseRouting.service.js";
import { appendActivity } from "./expenseAudit.service.js";

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));

export type RerouteTrigger = "deactivated" | "grant_removed";

export type RerouteOutcome = {
  kind: "claim" | "advance";
  id: string;
  ref: string | null;
  result: "rerouted" | "needs_attention" | "skipped";
  newApproverId: string | null;
  newApproverName: string | null;
  detail: string;
};

export type RerouteSummary = {
  userId: string;
  workspaceId: string | null;
  trigger: RerouteTrigger;
  examined: number;
  rerouted: number;
  needsAttention: number;
  items: RerouteOutcome[];
};

const TRIGGER_TEXT: Record<RerouteTrigger, string> = {
  deactivated: "was deactivated",
  grant_removed: "lost approver rights",
};

function nameOf(u: any): string {
  return [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() || u?.name || u?.email || "A former approver";
}

/** Strip the departing person from the pool the engine may choose from. */
function withoutPerson(input: RoutingInput, userId: string): RoutingInput {
  return {
    ...input,
    // The bot never decides a re-route (see the header).
    policy: { ...input.policy, bot: { ...input.policy.bot, enabled: false } },
    manager: input.manager && String(input.manager.id) === userId ? null : input.manager,
    candidates: input.candidates.filter((p) => String(p.id) !== userId),
  };
}

/**
 * The chain to store: every level the departing person (or anyone) had already
 * DECIDED stays exactly as it was; the engine's fresh chain is appended after
 * it, renumbered so `level` stays 1..n and `currentLevel` still points at the
 * first pending step.
 */
function rebuildChain(existing: any[], decision: RoutingDecision, now: Date) {
  const decided = (Array.isArray(existing) ? existing : []).filter((l: any) => l?.status && l.status !== "pending");
  const kept = decided.map((l: any, i: number) => ({ ...(l.toObject ? l.toObject() : l), level: i + 1 }));
  const fresh = decision.chain.map((c, i) => ({
    level: kept.length + i + 1,
    approverId: c.approverId ? oid(c.approverId) : null,
    status: "pending" as const,
    decidedAt: null,
    note: null,
    actorType: "user" as const,
    via: c.via,
    routedAt: i === 0 ? now : null,
    heldMs: null,
    overLimit: !!c.overLimit,
    limitBase: c.limitBase ?? null,
  }));
  return { chain: [...kept, ...fresh], currentLevel: kept.length + 1, firstPending: fresh[0] ?? null };
}

/** Re-route one claim or advance. Returns what happened, never throws. */
async function rerouteOne(params: {
  kind: "claim" | "advance";
  doc: any;
  workspaceId: mongoose.Types.ObjectId;
  departing: { id: string; name: string };
  trigger: RerouteTrigger;
}): Promise<RerouteOutcome> {
  const { kind, doc, workspaceId, departing, trigger } = params;
  const id = String(doc._id);
  const ref = doc.ref ?? null;
  const subject = kind === "claim" ? { reportId: id } : { advanceId: id };
  const now = new Date();
  const because = `${departing.name} ${TRIGGER_TEXT[trigger]}`;

  const built = await buildRoutingInput({ workspaceId, ...(kind === "claim" ? { reportId: id } : { advanceId: id }) });
  if (!built.input) {
    // The item could not even be read for routing — flag rather than guess.
    await flagNeedsAttention({ kind, doc, workspaceId, departing, trigger, why: built.error || "the claim could not be re-routed" });
    return { kind, id, ref, result: "needs_attention", newApproverId: null, newApproverName: null, detail: built.error || "could not build routing input" };
  }

  const decision = routeClaim(withoutPerson(built.input, departing.id));
  const placeable = decision.outcome !== "NO_APPROVER" && decision.outcome !== "REFUSE" && !!decision.chain.find((c) => c.approverId);
  if (!placeable) {
    await flagNeedsAttention({ kind, doc, workspaceId, departing, trigger, why: "no approver left can cover it", decision });
    return { kind, id, ref, result: "needs_attention", newApproverId: null, newApproverName: null, detail: "nobody can cover it" };
  }

  const { chain, currentLevel, firstPending } = rebuildChain(doc.approvalChain, decision, now);
  const newApproverId = firstPending?.approverId ?? null;
  const newApprover: any = newApproverId ? await User.findById(newApproverId).select("firstName lastName name email").lean() : null;
  const newApproverName = newApprover ? nameOf(newApprover) : decision.chain[0]?.name || "the new approver";

  doc.approvalChain = chain;
  doc.currentLevel = currentLevel;
  doc.approverId = newApproverId;
  doc.routing = decision as any;
  doc.needsAttention = null; // a successful re-route clears any earlier flag
  await doc.save();

  await appendActivity({
    workspaceId,
    ...subject,
    event: "re_routed",
    actorName: "System",
    actorType: "system",
    note: `Re-routed — ${because}; re-assigned to ${newApproverName} by the engine.`,
    details: {
      trigger,
      formerApproverId: departing.id,
      formerApproverName: departing.name,
      newApproverId: newApproverId ? String(newApproverId) : null,
      newApproverName,
      keptDecidedLevels: chain.length - decision.chain.length,
      routing: decision,
    },
  });

  return { kind, id, ref, result: "rerouted", newApproverId: newApproverId ? String(newApproverId) : null, newApproverName, detail: because };
}

/** Flag an item an admin must look at, and say so on the trail. */
async function flagNeedsAttention(params: {
  kind: "claim" | "advance";
  doc: any;
  workspaceId: mongoose.Types.ObjectId;
  departing: { id: string; name: string };
  trigger: RerouteTrigger;
  why: string;
  decision?: RoutingDecision;
}) {
  const { kind, doc, workspaceId, departing, trigger, why, decision } = params;
  const reason = `Needs admin attention — ${why} after ${departing.name} ${TRIGGER_TEXT[trigger]}.`;
  doc.needsAttention = {
    reason,
    since: new Date(),
    formerApproverId: oid(departing.id),
    trigger,
  };
  // The pointer is cleared so it stops sitting in a departed person's queue;
  // the item stays `submitted`/`awaiting_approval` and an admin sees every one
  // of those, now carrying the flag.
  doc.approverId = null;
  if (decision) doc.routing = decision as any;
  await doc.save();

  await appendActivity({
    workspaceId,
    ...(kind === "claim" ? { reportId: String(doc._id) } : { advanceId: String(doc._id) }),
    event: "needs_attention",
    actorName: "System",
    actorType: "system",
    note: reason,
    details: {
      trigger,
      formerApproverId: departing.id,
      formerApproverName: departing.name,
      why,
      ...(decision ? { routing: decision } : {}),
    },
  });
}

/**
 * THE entry point. Called after the departure has been persisted (the person is
 * already INACTIVE / the grant already off), so the engine's own pool filters
 * would exclude them anyway — the explicit exclusion above is belt and braces.
 *
 * Never throws: a failure here must not roll back the deactivation or the grant
 * change that triggered it. Whatever could not be moved keeps its existing
 * approver and is reported in the summary.
 */
export async function rerouteForDepartedApprover(params: {
  userId: mongoose.Types.ObjectId | string;
  workspaceId?: mongoose.Types.ObjectId | string | null;
  trigger: RerouteTrigger;
}): Promise<RerouteSummary> {
  const userId = String(params.userId);
  const summary: RerouteSummary = {
    userId,
    workspaceId: params.workspaceId ? String(params.workspaceId) : null,
    trigger: params.trigger,
    examined: 0,
    rerouted: 0,
    needsAttention: 0,
    items: [],
  };
  try {
    const uid = oid(userId);
    const person: any = await User.findById(uid).select("firstName lastName name email workspaceId").lean();
    const ws = params.workspaceId ? oid(params.workspaceId) : person?.workspaceId ? oid(person.workspaceId) : null;
    if (!ws) return summary;
    summary.workspaceId = String(ws);
    const departing = { id: userId, name: nameOf(person) };

    // Work whose ball is in THIS person's court (see the header) — PLUS anything
    // already flagged needsAttention in this workspace. A flagged item has no
    // approver at all, so nothing else would ever pick it up again; retrying it
    // on every departure pass is what lets it heal once an admin has fixed the
    // authority (raise a limit, flag another approver) without a manual step.
    const [claims, advances] = await Promise.all([
      Report.find({
        workspaceId: ws,
        status: "submitted",
        $or: [{ approverId: uid }, { needsAttention: { $ne: null } }],
      }),
      ExpenseAdvance.find({
        workspaceId: ws,
        status: "awaiting_approval",
        $or: [{ approverId: uid }, { needsAttention: { $ne: null } }],
      }),
    ]);
    summary.examined = claims.length + advances.length;

    for (const doc of claims) {
      const out = await rerouteOne({ kind: "claim", doc, workspaceId: ws, departing, trigger: params.trigger });
      summary.items.push(out);
    }
    for (const doc of advances) {
      const out = await rerouteOne({ kind: "advance", doc, workspaceId: ws, departing, trigger: params.trigger });
      summary.items.push(out);
    }
    summary.rerouted = summary.items.filter((i) => i.result === "rerouted").length;
    summary.needsAttention = summary.items.filter((i) => i.result === "needs_attention").length;
  } catch (err: any) {
    // Deliberately swallowed — see the doc comment.
    console.error("[expenseReroute] failed:", err?.message);
  }
  return summary;
}
