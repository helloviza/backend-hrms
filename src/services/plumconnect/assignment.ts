// apps/backend/src/services/plumconnect/assignment.ts
//
// PlumConnect Track B — matrix-driven, presence-aware routing. REPLACES
// the Slice 3b static assignee (configured user, else first ADMIN): a
// captured lead is now assigned only to someone who is mapped for it
// (AssignmentRule), present-active on its line (Track A) and able to act
// on it (Slice 7 grant ≥ WRITE) — or it is HELD, unassigned, for the next
// eligible agent. Never to someone who is not available.
//
//   resolveAssignee(conversation)
//     1. target: an AD rule for attribution.sourceId if one exists, else a
//        CAMPAIGN rule for that ad's campaign (Slice 8 Ad.metaCampaignId),
//        else the DEPARTMENT rule for the conversation's line
//     2. candidates: enabled rules for that target, priority asc; a
//        campaign / ad rule applies only when its line is the thread's line
//     3. eligible: activeAgentsForLine(line, now, "WRITE") ∩ candidates
//     4. one at the best priority → ASSIGNED; several → TIE (unassigned,
//        surfaced to all of them; first to take wins — the 4b "take" verb)
//     5. none → HELD (OPEN, unassigned, "awaiting agent"; the bot's ack
//        already told the contact someone will respond — Slice 3c)
//
//   applyRouting(conversation, decision)
//     writes Conversation.assignedTo (+ routing.autoAssigned so the bot does
//     NOT read it as a human takeover) and Conversation.routing — the
//     decision, its reason and time live THERE, not as a system Message:
//     the thread's message ledger stays byte-identical to Slice 8; syncs
//     Lead.assignedTo / assignedToName when the thread has a Lead.
//
//   reResolveHeld({ lines, now })
//     the light re-resolve: held / tied, unassigned, non-resolved threads
//     on the given lines are resolved again — called from the inbox list
//     read, bounded, no background job (the repo's no-heavy-jobs rule).

import mongoose from "mongoose";
import Lead from "../../models/Lead.js";
import User from "../../models/User.js";
import PlumConnectConversation, { type IPlumConnectConversation } from "../../models/plumconnect/Conversation.js";
import PlumConnectAssignmentRule, { assignmentTargetKey, type AssignmentTargetType } from "../../models/plumconnect/AssignmentRule.js";
import PlumConnectAd from "../../models/plumconnect/Ad.js";
import PlumConnectCampaign from "../../models/plumconnect/Campaign.js";
import PlumConnectCampaignMap from "../../models/plumconnect/CampaignMap.js";
import { activeUserFilter } from "../../utils/userActiveStatus.js";
import { lineMatch, lineOfConversation, canAccessLine, holdsAtLeast, lineGrantsForUserId, type AccessLine } from "./access.js";
import { activeAgentsForLine } from "./presence.js";
import { whatsappLogger } from "../../utils/logger.js";

type AnyObj = Record<string, any>;

export interface RoutingTarget {
  type: AssignmentTargetType;
  key: string;
}

export interface RoutingDecision {
  state: "assigned" | "tie" | "held";
  line: AccessLine;
  target: RoutingTarget;
  /** Set when state is "assigned". */
  assignee: { id: mongoose.Types.ObjectId; name: string } | null;
  /** assigned → [assignee]; tie → the tied agents; held → []. */
  candidates: mongoose.Types.ObjectId[];
  /** How many mapped agents the target had (before eligibility). */
  mapped: number;
  reason: string;
}

const RE_RESOLVE_LIMIT = 100;

function displayName(u: any): string {
  return (u?.name && String(u.name).trim()) || `${u?.firstName || ""} ${u?.lastName || ""}`.trim() || (u?.email ? String(u.email).trim() : "");
}

/** The ad id a thread came from: the referral on the thread, else its Lead's attribution. */
export async function sourceIdOf(conversation: Pick<IPlumConnectConversation, "referralRaw" | "leadId">, explicit?: string): Promise<string> {
  const fromArg = String(explicit || "").trim();
  if (fromArg) return fromArg;
  const fromThread = String((conversation.referralRaw as AnyObj | null)?.source_id || "").trim();
  if (fromThread) return fromThread;
  if (conversation.leadId) {
    const lead: any = await Lead.findById(conversation.leadId).select("attribution.sourceId").lean();
    return String(lead?.attribution?.sourceId || "").trim();
  }
  return "";
}

/**
 * Which matrix row set applies: ad → campaign → department, by EXISTENCE of
 * an enabled rule (a campaign mapping wins over the department row).
 */
export async function resolveTarget(line: AccessLine, sourceId: string): Promise<RoutingTarget> {
  if (sourceId) {
    const adKey = assignmentTargetKey({ type: "ad", line, metaId: sourceId });
    if (await PlumConnectAssignmentRule.exists({ targetKey: adKey, enabled: true, "target.line": line })) return { type: "ad", key: adKey };
    const ad: any = await PlumConnectAd.findOne({ metaId: sourceId }).select("metaCampaignId").lean();
    if (ad?.metaCampaignId) {
      const campaignKey = assignmentTargetKey({ type: "campaign", line, metaId: String(ad.metaCampaignId) });
      if (await PlumConnectAssignmentRule.exists({ targetKey: campaignKey, enabled: true, "target.line": line })) return { type: "campaign", key: campaignKey };
    }
  }
  return { type: "department", key: assignmentTargetKey({ type: "department", line, metaId: "" }) };
}

export async function resolveAssignee(input: {
  conversation: IPlumConnectConversation;
  /** The line being captured (capture knows it before the thread is stamped); else derived from the thread. */
  line?: AccessLine;
  /** The referral's ad id when the caller already parsed it (capture). */
  sourceId?: string;
  now?: Date;
}): Promise<RoutingDecision> {
  const now = input.now ?? new Date();
  const line = input.line ?? lineOfConversation(input.conversation);
  const sourceId = await sourceIdOf(input.conversation, input.sourceId);
  const target = await resolveTarget(line, sourceId);

  const rules: any[] = await PlumConnectAssignmentRule.find({ targetKey: target.key, enabled: true, "target.line": line })
    .sort({ priority: 1, createdAt: 1 })
    .lean();
  if (rules.length === 0) {
    return { state: "held", line, target, assignee: null, candidates: [], mapped: 0, reason: "nobody mapped" };
  }

  const present = new Set((await activeAgentsForLine(line, now, "WRITE")).map(String));
  const eligible = rules.filter((r) => present.has(String(r.userId)));
  if (eligible.length === 0) {
    return { state: "held", line, target, assignee: null, candidates: [], mapped: rules.length, reason: "nobody eligible (away or cannot act)" };
  }

  const best = eligible[0].priority;
  const top = eligible.filter((r) => r.priority === best);
  if (top.length > 1) {
    return { state: "tie", line, target, assignee: null, candidates: top.map((r) => r.userId), mapped: rules.length, reason: `tie at priority ${best}` };
  }
  const winner = top[0];
  const user: any = await User.findById(winner.userId).select("name firstName lastName email").lean();
  return {
    state: "assigned",
    line,
    target,
    assignee: { id: winner.userId, name: displayName(user) },
    candidates: [winner.userId],
    mapped: rules.length,
    reason: `priority ${best}`,
  };
}

/** Persist a decision on the thread (and its Lead). */
export async function applyRouting(conversation: IPlumConnectConversation, decision: RoutingDecision, now: Date = new Date()): Promise<void> {
  const conversationId = conversation._id as mongoose.Types.ObjectId;
  const assignedTo = decision.state === "assigned" ? decision.assignee!.id : null;
  const routing = {
    state: decision.state,
    targetType: decision.target.type,
    targetKey: decision.target.key,
    candidates: decision.candidates,
    autoAssigned: decision.state === "assigned",
    resolvedAt: now,
    reason: decision.reason,
  };
  await PlumConnectConversation.updateOne({ _id: conversationId }, { $set: { assignedTo, routing } });
  conversation.assignedTo = assignedTo;
  (conversation as any).routing = routing;

  // The Lead follows an assignment. A held / tied thread's Lead keeps the
  // 3b shape exactly (owner fields untouched — absent when created so).
  if (conversation.leadId && assignedTo) {
    await Lead.updateOne({ _id: conversation.leadId }, { $set: { assignedTo, assignedToName: decision.assignee?.name ?? "" } });
  }

  whatsappLogger.info("PlumConnect routing", { conversationId: String(conversationId), state: decision.state, target: decision.target.key, assignedTo: assignedTo ? String(assignedTo) : null, reason: decision.reason });
}

/**
 * Re-resolve the held / tied, unassigned threads on `lines` (the inbox
 * list read calls this for the caller's held lines). Bounded; a thread
 * that resolves the same way is rewritten only when its candidates changed.
 */
export async function reResolveHeld(input: { lines: AccessLine[]; now?: Date }): Promise<{ checked: number; assigned: number; tied: number }> {
  const now = input.now ?? new Date();
  const out = { checked: 0, assigned: 0, tied: 0 };
  if (input.lines.length === 0) return out;
  const threads = await PlumConnectConversation.find({
    assignedTo: null,
    status: { $ne: "RESOLVED" },
    "routing.state": { $in: ["held", "tie"] },
    $or: input.lines.map((line) => lineMatch(line)),
  })
    .sort({ createdAt: 1 })
    .limit(RE_RESOLVE_LIMIT);
  for (const thread of threads) {
    out.checked += 1;
    const decision = await resolveAssignee({ conversation: thread, now });
    const before = thread.routing;
    const sameCandidates = before.state === decision.state && before.candidates.map(String).sort().join(",") === decision.candidates.map(String).sort().join(",");
    if (sameCandidates) continue;
    await applyRouting(thread, decision, now);
    if (decision.state === "assigned") out.assigned += 1;
    if (decision.state === "tie") out.tied += 1;
  }
  return out;
}

/* ───────────────────────────── CRUD validation ───────────────────────────── */

export type RuleValidation = { ok: true } | { ok: false; error: string };

/** A campaign / ad target must name something we know: a Slice 8 row or a Slice 5 map entry. */
export async function validateRuleTarget(target: { type: AssignmentTargetType; line: AccessLine; metaId: string }): Promise<RuleValidation> {
  if (target.type === "department") return { ok: true };
  const metaId = String(target.metaId || "").trim();
  if (!metaId) return { ok: false, error: "A campaign / ad target needs a metaId." };
  if (target.type === "campaign") {
    if (await PlumConnectCampaign.exists({ metaId })) return { ok: true };
    return { ok: false, error: `Unknown campaign ${metaId} — it must have been enriched (Slice 8) first.` };
  }
  if ((await PlumConnectAd.exists({ metaId })) || (await PlumConnectCampaignMap.exists({ adId: metaId }))) return { ok: true };
  return { ok: false, error: `Unknown ad ${metaId} — no enriched Ad row and no campaign-map entry.` };
}

/** The mapped agent must be an ACTIVE user holding the target line at WRITE+ (someone who can act). */
export async function validateRuleUser(userId: unknown, line: AccessLine): Promise<RuleValidation> {
  if (!mongoose.isValidObjectId(String(userId ?? ""))) return { ok: false, error: "userId is not a valid id." };
  const user: any = await User.findOne({ _id: new mongoose.Types.ObjectId(String(userId)), ...activeUserFilter() }).select("_id roles").lean();
  if (!user) return { ok: false, error: "User not found or not active." };
  const grants = await lineGrantsForUserId(user._id, user.roles);
  if (!holdsAtLeast(canAccessLine(grants, line), "WRITE")) return { ok: false, error: `User does not hold the ${line} line at WRITE or above.` };
  return { ok: true };
}
