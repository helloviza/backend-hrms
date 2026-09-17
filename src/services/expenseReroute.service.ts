// apps/backend/src/services/expenseReroute.service.ts
//
// Approval-engine sub-step 8 — RE-ROUTE STRANDED WORK when an approver leaves,
// and the EXPLICIT ADMIN RETRY for whatever could not be placed.
//
// ── Pass 1: a departure (automatic) ──────────────────────────────────────
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
//      NOBODY IS ASKED TWICE: the engine rebuilds its chain from scratch and
//      will put the line manager's endorsement back at the front of it, so any
//      step belonging to someone whose answer this claim already holds — an
//      endorsement exactly as much as a final approval — is dropped instead of
//      re-created. No claim ever carries two decisions from one person. If that
//      leaves NO step to ask, the item is flagged for an admin rather than
//      auto-approved: a re-route must never upgrade an outcome (see below).
//   3. Re-routed → append-only trail entry `re_routed` (actor: System) carrying
//      the new approver, the reason and the engine's reasoning.
//   4. Cannot be placed → NOT silently stranded: `needsAttention` is flagged on
//      the item (visible to admins in the approvals queue, which already shows
//      every submitted claim to an admin) and a `needs_attention` entry is
//      appended.
//
// ── Pass 2: an admin retries (explicit) ──────────────────────────────────
// A flagged item is NOT retried by later departure passes. Nothing un-sticks
// itself from an unrelated event: the reason it is flagged is that the
// workspace's approval authority cannot cover it, and only an admin changing
// that authority — raising a limit, flagging another approver — can fix it. So
// the admin fixes the setup and THEN deliberately asks for a retry, which calls
// retryRoutingNow() below: the same engine and the same chain rules, but the
// actor on the trail is the admin and the result is reported back to them
// instead of being swallowed. A failed retry leaves the item flagged, with a
// message saying what to change next.
//
// Two consequences of that choice, both deliberate:
//   • an item stays flagged until a person looks at it — which is the point of
//     the flag; it is never quietly resolved by an unrelated HR action
//   • the retry does NOT exclude the person who left. The candidate pool
//     already drops anyone inactive or without the approver flag, so if the
//     admin's fix was to REACTIVATE them they are eligible again — a legitimate
//     outcome of a deliberate retry, unlike of an automatic sweep.
//
// TWO DELIBERATE NARROWINGS on both passes, both to avoid surprising people:
//
//   • The BOT IS OFF for a re-route. A departure must never *upgrade* an item's
//     outcome: a claim a human was already reviewing should not become
//     auto-approved because an unrelated HR action re-ran the engine. The
//     re-route therefore routes among people only, and the recorded decision
//     shows the bot as not evaluated. The same holds for the admin retry — an
//     admin asking "who should hold this?" is not asking to close it.
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

/** What made someone stop being an approver — the automatic pass. */
export type DepartureTrigger = "deactivated" | "grant_removed";
/** Everything that can put an item through the engine again; stored on the flag. */
export type RerouteTrigger = DepartureTrigger | "manual_retry";

/** Copy shown to an admin when the engine still cannot place a retried item. */
export const STILL_UNCOVERED_MESSAGE =
  "Still no approver can cover this — raise a limit or add an approver, then retry.";

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
  trigger: DepartureTrigger;
  examined: number;
  rerouted: number;
  needsAttention: number;
  items: RerouteOutcome[];
};

/** The outcome of ONE explicit admin retry, reported straight back to them. */
export type ManualRetryResult = {
  ok: boolean;
  result: "rerouted" | "needs_attention";
  message: string;
  newApproverId: string | null;
  newApproverName: string | null;
};

const TRIGGER_TEXT: Record<DepartureTrigger, string> = {
  deactivated: "was deactivated",
  grant_removed: "lost approver rights",
};

/**
 * Who caused this pass and how it should read on the trail. One shape for both
 * passes, so the routing, the chain rebuild and the audit entry have exactly
 * one implementation; only the copy and the actor differ.
 */
type RerouteContext = {
  trigger: RerouteTrigger;
  /** Reason clause in the note: "Meera T was deactivated" / "retried by Lena T". */
  because: string;
  /** Stripped from the candidate pool — the departing person, or null on a retry. */
  excludeUserId: string | null;
  /** The approver who left; carried into the audit details and kept on the flag. */
  formerApprover: { id: string | null; name: string };
  actor: { id: string | null; name: string; type: "system" | "user" };
  /** True for the explicit admin retry — changes the copy and the failure message. */
  manual: boolean;
};

function nameOf(u: any): string {
  return [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() || u?.name || u?.email || "A former approver";
}

/** Strip the departing person from the pool the engine may choose from. */
function withoutPerson(input: RoutingInput, userId: string | null): RoutingInput {
  return {
    ...input,
    // The bot never decides a re-route (see the header).
    policy: { ...input.policy, bot: { ...input.policy.bot, enabled: false } },
    manager: userId && input.manager && String(input.manager.id) === userId ? null : input.manager,
    candidates: userId ? input.candidates.filter((p) => String(p.id) !== userId) : input.candidates,
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

  // NOBODY IS ASKED TWICE. `approverId` on a decided level is who actually
  // decided it (the approve route stamps the real actor, not the routed one),
  // so this is the set of people whose answer this claim already holds — an
  // endorsement exactly as much as a final approval. The engine builds its
  // chain from scratch and will happily put the line manager back at the front
  // of it; their endorsement is already on record, so that step is dropped
  // rather than re-created. Only genuinely open steps survive into `fresh`.
  const alreadyDecided = new Set<string>(
    kept.map((l: any) => (l.approverId ? String(l.approverId) : "")).filter(Boolean),
  );
  const skippedAlreadyDecided: string[] = [];
  const fresh = decision.chain
    .filter((c) => {
      const who = c.approverId ? String(c.approverId) : "";
      if (who && alreadyDecided.has(who)) {
        skippedAlreadyDecided.push(who);
        return false;
      }
      return true;
    })
    .map((c, i) => ({
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
  return {
    chain: [...kept, ...fresh],
    currentLevel: kept.length + 1,
    firstPending: fresh[0] ?? null,
    keptCount: kept.length,
    skippedAlreadyDecided,
  };
}

/** Re-route one claim or advance. Returns what happened, never throws. */
async function rerouteOne(params: {
  kind: "claim" | "advance";
  doc: any;
  workspaceId: mongoose.Types.ObjectId;
  ctx: RerouteContext;
}): Promise<RerouteOutcome> {
  const { kind, doc, workspaceId, ctx } = params;
  const id = String(doc._id);
  const ref = doc.ref ?? null;
  const subject = kind === "claim" ? { reportId: id } : { advanceId: id };
  const now = new Date();

  const built = await buildRoutingInput({ workspaceId, ...(kind === "claim" ? { reportId: id } : { advanceId: id }) });
  if (!built.input) {
    // The item could not even be read for routing — flag rather than guess.
    await flagNeedsAttention({ kind, doc, workspaceId, ctx, why: built.error || "the claim could not be re-routed" });
    return { kind, id, ref, result: "needs_attention", newApproverId: null, newApproverName: null, detail: built.error || "could not build routing input" };
  }

  const decision = routeClaim(withoutPerson(built.input, ctx.excludeUserId));
  const placeable = decision.outcome !== "NO_APPROVER" && decision.outcome !== "REFUSE" && !!decision.chain.find((c) => c.approverId);
  if (!placeable) {
    await flagNeedsAttention({ kind, doc, workspaceId, ctx, why: "no approver left can cover it", decision });
    return { kind, id, ref, result: "needs_attention", newApproverId: null, newApproverName: null, detail: "nobody can cover it" };
  }

  const { chain, currentLevel, firstPending, keptCount, skippedAlreadyDecided } = rebuildChain(doc.approvalChain, decision, now);
  if (!firstPending) {
    // Every step the engine would ask for is one this claim already holds an
    // answer to. There is nobody new to route to, and re-asking them is exactly
    // what this guards against — but auto-approving would UPGRADE the outcome,
    // which a re-route must never do. So it goes to an admin, who can decide it
    // directly from the queue.
    await flagNeedsAttention({ kind, doc, workspaceId, ctx, why: "everyone the engine would route it to has already decided it", decision });
    return { kind, id, ref, result: "needs_attention", newApproverId: null, newApproverName: null, detail: "no step left to ask" };
  }
  const newApproverId = firstPending?.approverId ?? null;
  const newApprover: any = newApproverId ? await User.findById(newApproverId).select("firstName lastName name email").lean() : null;
  const newApproverName = newApprover ? nameOf(newApprover) : decision.chain[0]?.name || "the new approver";
  // Names, not ids, for the people whose step was dropped — the trail is read.
  // Keyed by id: a $in query answers in its own order, not the argument's.
  const skippedNames = new Map<string, string>();
  if (skippedAlreadyDecided.length) {
    const people: any[] = await User.find({ _id: { $in: skippedAlreadyDecided.map(oid) } })
      .select("firstName lastName name email")
      .lean();
    for (const p of people) skippedNames.set(String(p._id), nameOf(p));
  }

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
    actorName: ctx.actor.name,
    actorType: ctx.actor.type,
    ...(ctx.actor.id ? { actorId: ctx.actor.id } : {}),
    note: `Re-routed — ${ctx.because}; re-assigned to ${newApproverName} by the engine.`,
    details: {
      trigger: ctx.trigger,
      manual: ctx.manual,
      formerApproverId: ctx.formerApprover.id,
      formerApproverName: ctx.formerApprover.name,
      newApproverId: newApproverId ? String(newApproverId) : null,
      newApproverName,
      keptDecidedLevels: keptCount,
      // Who the engine would have asked again, and was not.
      skippedAlreadyDecided: skippedAlreadyDecided.map((sid) => ({ userId: sid, name: skippedNames.get(sid) ?? null })),
      routing: decision,
    },
  });

  return { kind, id, ref, result: "rerouted", newApproverId: newApproverId ? String(newApproverId) : null, newApproverName, detail: ctx.because };
}

/** Flag an item an admin must look at, and say so on the trail. */
async function flagNeedsAttention(params: {
  kind: "claim" | "advance";
  doc: any;
  workspaceId: mongoose.Types.ObjectId;
  ctx: RerouteContext;
  why: string;
  decision?: RoutingDecision;
}) {
  const { kind, doc, workspaceId, ctx, why, decision } = params;
  // An automatic pass explains the departure that caused it; a retry the admin
  // just asked for explains what THEY have to change next.
  const reason = ctx.manual ? STILL_UNCOVERED_MESSAGE : `Needs admin attention — ${why} after ${ctx.because}.`;
  // A retry that fails keeps the flag it already had: the same clock (how long
  // this has been stuck is an admin's business) and the departure that began it.
  const prior: any = doc.needsAttention || null;
  doc.needsAttention = {
    reason,
    since: prior?.since ?? new Date(),
    formerApproverId: prior?.formerApproverId ?? (ctx.formerApprover.id ? oid(ctx.formerApprover.id) : null),
    trigger: prior?.trigger ?? ctx.trigger,
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
    actorName: ctx.actor.name,
    actorType: ctx.actor.type,
    ...(ctx.actor.id ? { actorId: ctx.actor.id } : {}),
    note: reason,
    details: {
      trigger: ctx.trigger,
      manual: ctx.manual,
      formerApproverId: ctx.formerApprover.id,
      formerApproverName: ctx.formerApprover.name,
      why,
      ...(decision ? { routing: decision } : {}),
    },
  });
}

/**
 * THE departure entry point. Called after the departure has been persisted (the
 * person is already INACTIVE / the grant already off), so the engine's own pool
 * filters would exclude them anyway — the explicit exclusion above is belt and
 * braces.
 *
 * Never throws: a failure here must not roll back the deactivation or the grant
 * change that triggered it. Whatever could not be moved keeps its existing
 * approver and is reported in the summary.
 */
export async function rerouteForDepartedApprover(params: {
  userId: mongoose.Types.ObjectId | string;
  workspaceId?: mongoose.Types.ObjectId | string | null;
  trigger: DepartureTrigger;
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
    const ctx: RerouteContext = {
      trigger: params.trigger,
      because: `${departing.name} ${TRIGGER_TEXT[params.trigger]}`,
      excludeUserId: userId,
      formerApprover: departing,
      actor: { id: null, name: "System", type: "system" },
      manual: false,
    };

    // ONLY work whose ball is in THIS person's court (see the header). Items
    // already flagged needsAttention are deliberately NOT swept up here: they
    // are waiting on an admin to change the workspace's approval authority, and
    // an unrelated departure is not that. They move again when an admin retries
    // them explicitly — retryRoutingNow() below.
    const [claims, advances] = await Promise.all([
      Report.find({ workspaceId: ws, status: "submitted", approverId: uid }),
      ExpenseAdvance.find({ workspaceId: ws, status: "awaiting_approval", approverId: uid }),
    ]);
    summary.examined = claims.length + advances.length;

    for (const doc of claims) {
      const out = await rerouteOne({ kind: "claim", doc, workspaceId: ws, ctx });
      summary.items.push(out);
    }
    for (const doc of advances) {
      const out = await rerouteOne({ kind: "advance", doc, workspaceId: ws, ctx });
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

/**
 * THE explicit-retry entry point — an admin asked to re-route a flagged item,
 * having (presumably) just fixed the authority that made it unplaceable.
 *
 * Unlike the departure pass, this one does NOT swallow its errors: the admin is
 * standing there waiting for an answer, so a genuine failure must reach the
 * route and become a 500 rather than a false "nothing happened". The caller has
 * already loaded `doc` within the tenant and checked the admin gate, the status
 * and the flag.
 */
export async function retryRoutingNow(params: {
  kind: "claim" | "advance";
  doc: any;
  workspaceId: mongoose.Types.ObjectId | string;
  actor: { id: string; name: string };
}): Promise<ManualRetryResult> {
  const ws = oid(params.workspaceId);
  const flagged: any = params.doc.needsAttention || null;
  const formerId = flagged?.formerApproverId ? String(flagged.formerApproverId) : null;
  let formerName = "a former approver";
  if (formerId) {
    const p: any = await User.findById(formerId).select("firstName lastName name email").lean();
    if (p) formerName = nameOf(p);
  }

  const ctx: RerouteContext = {
    trigger: "manual_retry",
    because: `retried by ${params.actor.name}`,
    // No exclusion — the pool's own active/approver filters decide. See header.
    excludeUserId: null,
    formerApprover: { id: formerId, name: formerName },
    actor: { id: params.actor.id, name: params.actor.name, type: "user" },
    manual: true,
  };

  const out = await rerouteOne({ kind: params.kind, doc: params.doc, workspaceId: ws, ctx });
  const ok = out.result === "rerouted";
  return {
    ok,
    result: ok ? "rerouted" : "needs_attention",
    message: ok ? `Re-routed to ${out.newApproverName}.` : STILL_UNCOVERED_MESSAGE,
    newApproverId: out.newApproverId,
    newApproverName: out.newApproverName,
  };
}
