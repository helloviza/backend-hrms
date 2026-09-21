// apps/backend/src/routes/plumconnect.ts
//
// PlumConnect Slice 4b — the inbox API (backend only; the UI is 4c).
// Mounted at /api/plumconnect behind requireAuth + requireWorkspace +
// requireFeature("plumconnectEnabled") + requireHouse (server.ts); inside,
// the PLUMCONNECT_ENABLED runtime flag (404 when off — no inbox surface
// exists) and requirePlumConnectAccess (NONE → 403).
//
// Scope is the CRM v2 model (services/plumconnect/inboxScope.ts): OWN sees
// and acts on conversations assigned to them, ALL on every conversation;
// WRITE = reply / note / assign-to-self / resolve / reopen, FULL (+ALL) =
// reassign to others.
//
// Slice 7 — PER LINE. The grant is one {access, scope} per line (plumtrips /
// helloviza / concierge / support — services/plumconnect/access.ts). The
// list is the union of the caller's held lines, each under its own scope;
// every per-conversation route resolves the conversation's line FIRST and
// checks THAT line's grant — no grant on the line is a 403, exactly like a
// scope miss. The API is the control; the UI only mirrors it.
//
// Human takeover contract (Slice 3c bot.ts): assigning a conversation or an
// agent sending on it sets bot.stoppedBy = "human" — the bot is silent on
// that thread for good.
//
// Replies go through the Slice-4a outbound wrapper with the conversation
// and the agent attached, so exactly one OUTBOUND Message with the wamid
// lands on THIS thread. Free-form text is only deliverable inside Meta's
// 24-hour customer-service window; outside it the reply is refused with a
// clear error (templates are Phase 2).
//
// Status lifecycle (D6): OPEN ⇄ PENDING (agent replied, waiting on the
// contact) → RESOLVED (resolvedAt / resolvedBy) → reopen → OPEN.

import express from "express";
import mongoose from "mongoose";
import { isPlumConnectEnabled } from "../config/plumconnect.js";
import { requirePlumConnectAccess } from "../middleware/requirePlumConnectAccess.js";
import PlumConnectConversation, { CONVERSATION_KINDS, CONVERSATION_STATUSES } from "../models/plumconnect/Conversation.js";
import PlumConnectMessage from "../models/plumconnect/Message.js";
import PlumConnectContact from "../models/plumconnect/Contact.js";
import User from "../models/User.js";
import { UserPermission } from "../models/UserPermission.js";
import { activeUserFilter } from "../utils/userActiveStatus.js";
import { inboxScope, conversationMatch, canSee, canWrite, canReassign, lineGrants } from "../services/plumconnect/inboxScope.js";
import { isAccessLine, lineOfConversation, holdsAtLeast, canAccessLine, lineGrantsForUserId, heldLines, PLUMCONNECT_MODULE_KEYS, ACCESS_LINES } from "../services/plumconnect/access.js";
import { buildCampaignRollup } from "../services/plumconnect/campaignRollup.js";
import { getPresence, setPresence, presenceTtlMs } from "../services/plumconnect/presence.js";
import { reResolveHeld, validateRuleTarget, validateRuleUser } from "../services/plumconnect/assignment.js";
import PlumConnectAssignmentRule, { ASSIGNMENT_TARGET_TYPES, assignmentTargetKey } from "../models/plumconnect/AssignmentRule.js";
import Lead from "../models/Lead.js";
import type { ScopeCtx } from "../services/crmScope.js";
import { stopBot, botIsActive } from "../services/plumconnect/bot.js";
import { sendTextOutcome } from "../services/plumconnect/outbound.js";
import logger from "../utils/logger.js";

type AnyObj = Record<string, any>;

/** Free-form replies must land inside Meta's customer-service window. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 100;
// Mirrors routes/leads.ts:39 / middleware/requireHouse.ts:7. NEVER write to it.
const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";
const TEXT_CAP = 4096;

const router = express.Router();

// ── Runtime flag: with PLUMCONNECT_ENABLED off there is no inbox at all ──
router.use((_req, res, next) => {
  if (!isPlumConnectEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});

router.use(requirePlumConnectAccess);

/* ───────────────────────────── helpers ───────────────────────────── */

function oid(v: unknown): mongoose.Types.ObjectId | null {
  return mongoose.isValidObjectId(String(v ?? "")) ? new mongoose.Types.ObjectId(String(v)) : null;
}

async function displayName(userId: mongoose.Types.ObjectId | null | undefined): Promise<string> {
  if (!userId) return "";
  const u: any = await User.findById(userId).select("name firstName lastName email").lean();
  if (!u) return "";
  return (u.name && String(u.name).trim()) || `${u.firstName || ""} ${u.lastName || ""}`.trim() || String(u.email || "");
}

/**
 * Load a conversation the caller may act on. 404 when it does not exist,
 * 403 when it exists but the caller holds nothing on its LINE, or holds it
 * at OWN and it is not theirs — the security property the tests pin. The
 * two 403s are indistinguishable on purpose.
 */
async function loadVisible(req: express.Request, res: express.Response) {
  const id = oid(req.params.id);
  if (!id) {
    res.status(404).json({ error: "Conversation not found." });
    return null;
  }
  const conversation = await PlumConnectConversation.findById(id);
  if (!conversation) {
    res.status(404).json({ error: "Conversation not found." });
    return null;
  }
  if (!canSee(inboxScope(req, lineOfConversation(conversation)), conversation)) {
    res.status(403).json({ error: "This conversation is not in your scope." });
    return null;
  }
  return conversation;
}

/** The caller's scope on the conversation's line (after loadVisible). */
function ctxFor(req: express.Request, conversation: { businessLine?: any; leadId?: any }): ScopeCtx {
  return inboxScope(req, lineOfConversation(conversation));
}

function requireWrite(ctx: ScopeCtx, res: express.Response): boolean {
  if (canWrite(ctx)) return true;
  res.status(403).json({ error: "Write access required." });
  return false;
}

async function systemNote(conversationId: mongoose.Types.ObjectId, text: string, authorUserId: mongoose.Types.ObjectId | null, payload: AnyObj, now: Date) {
  await PlumConnectMessage.create({
    conversationId,
    direction: "OUTBOUND",
    channel: "whatsapp",
    type: "system",
    text,
    payload,
    authorUserId,
    visibleToContact: false,
    sentAt: now,
  });
}

function summarize(c: any, contact: any) {
  return {
    _id: c._id,
    kind: c.kind,
    // Slice 5: which department a lead-kind thread belongs to (null = not
    // yet routed, or not a lead). Additive; the list shows it as the label.
    businessLine: c.businessLine ?? null,
    status: c.status,
    assignedTo: c.assignedTo ?? null,
    leadId: c.leadId ?? null,
    bot: c.bot,
    // Track B: how the matrix routed this thread ("" on a pre-Track-B thread).
    routing: c.routing ? { state: c.routing.state ?? "", targetKey: c.routing.targetKey ?? "", candidates: (c.routing.candidates ?? []).map(String), reason: c.routing.reason ?? "", resolvedAt: c.routing.resolvedAt ?? null } : null,
    lastInboundAt: c.lastInboundAt ?? null,
    lastOutboundAt: c.lastOutboundAt ?? null,
    lastMessageAt: c.lastMessageAt ?? null,
    resolvedAt: c.resolvedAt ?? null,
    resolvedBy: c.resolvedBy ?? null,
    createdAt: c.createdAt,
    contact: contact ? { _id: contact._id, phone: contact.phone, displayName: contact.displayName, identityState: contact.identityState } : null,
  };
}

/* ───────────────────────────── routes ───────────────────────────── */

// GET /agents[?line=] — who can be assigned a conversation. Mirrors
// requirePlumConnectAccess EXACTLY (the /leads/reps posture): HOUSE
// ADMIN/SUPERADMIN by role, unioned with explicit grants on ANY line — or,
// with ?line=, on THAT line, so the reassign picker for a helloviza thread
// offers only people who can see helloviza threads. Resolved against
// ACTIVE HOUSE users. Added for the 4c reassign picker.
router.get("/agents", async (req, res) => {
  try {
    const houseObjectId = new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID);
    const line = String(req.query.line || "");
    if (line && !isAccessLine(line)) return res.status(400).json({ error: "Invalid line." });
    const keys = line ? [PLUMCONNECT_MODULE_KEYS[line]] : ACCESS_LINES.map((l) => PLUMCONNECT_MODULE_KEYS[l]);
    const grants = await UserPermission.find({
      workspaceId: HOUSE_WORKSPACE_ID,
      universe: "STAFF",
      $or: keys.map((k) => ({ [`modules.${k}.access`]: { $in: ["READ", "WRITE", "FULL"] } })),
    })
      .select("userId")
      .lean();
    const roleAgents = await User.find({ workspaceId: houseObjectId, roles: { $in: ["ADMIN", "SUPERADMIN"] } }).select("_id").lean();
    const union = new Map<string, mongoose.Types.ObjectId>();
    for (const g of grants as any[]) {
      const id = String(g.userId || "");
      if (mongoose.isValidObjectId(id)) union.set(id, new mongoose.Types.ObjectId(id));
    }
    for (const u of roleAgents as any[]) union.set(String(u._id), u._id);
    const users = (await User.find({ workspaceId: houseObjectId, _id: { $in: [...union.values()] }, ...activeUserFilter() })
      .select("_id name firstName lastName email")
      .lean()) as any[];
    const agents = users
      .map((u) => ({ _id: String(u._id), name: (u.name && String(u.name).trim()) || `${u.firstName || ""} ${u.lastName || ""}`.trim() || String(u.email || ""), email: String(u.email || "") }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return res.json({ agents });
  } catch (err) {
    logger.error("plumconnect GET /agents error", { err });
    return res.status(500).json({ error: "Failed to list agents." });
  }
});

// GET /campaigns/rollup[?from=&to=] — Slice 8: the Campaign → AdSet → Ad
// drill-down (services/plumconnect/campaignRollup.ts). A cross-line report
// (an ad's leads span departments), so it needs FULL on at least one line
// or ADMIN by role — a WRITE/OWN rep does not get the whole funnel.
router.get("/campaigns/rollup", async (req, res) => {
  try {
    if (heldLines(lineGrants(req), "FULL").length === 0) return res.status(403).json({ error: "FULL access on a PlumConnect line is required for campaign reporting." });
    const parse = (v: unknown): Date | null | undefined => {
      const raw = String(v || "");
      if (!raw) return null;
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    const from = parse(req.query.from);
    const to = parse(req.query.to);
    if (from === undefined || to === undefined) return res.status(400).json({ error: "Invalid date range." });
    const rollup = await buildCampaignRollup({ from, to });
    return res.json(rollup);
  } catch (err) {
    logger.error("plumconnect GET /campaigns/rollup error", { err });
    return res.status(500).json({ error: "Failed to build the campaign roll-up." });
  }
});

// ── Track B — the assignment matrix (CRUD; the admin page is Track D) ────
// Admin-gated: ADMIN by role, or FULL on the target's line. The mapped
// user must hold the target line at WRITE+ (someone who can act); a
// campaign / ad target must name something known (Slice 8 row or Slice 5
// campaign-map entry).

function canManageRules(req: express.Request, line: any): boolean {
  return isAccessLine(line) && holdsAtLeast(canAccessLine(lineGrants(req), line), "FULL");
}

async function ruleView(rule: any) {
  const u: any = await User.findById(rule.userId).select("name firstName lastName email").lean();
  return {
    _id: rule._id,
    target: rule.target,
    targetKey: rule.targetKey,
    userId: String(rule.userId),
    userName: (u?.name && String(u.name).trim()) || `${u?.firstName || ""} ${u?.lastName || ""}`.trim() || String(u?.email || ""),
    priority: rule.priority,
    enabled: rule.enabled,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

// GET /assignment-rules[?line=] — the rules on the lines I may manage.
router.get("/assignment-rules", async (req, res) => {
  try {
    const lineParam = String(req.query.line || "");
    if (lineParam && !isAccessLine(lineParam)) return res.status(400).json({ error: "Invalid line." });
    const manageable = heldLines(lineGrants(req), "FULL").filter((l) => !lineParam || l === lineParam);
    if (manageable.length === 0) return res.status(403).json({ error: "FULL access on a PlumConnect line is required to manage assignment rules." });
    const rules = await PlumConnectAssignmentRule.find({ "target.line": { $in: manageable } }).sort({ "target.line": 1, targetKey: 1, priority: 1, createdAt: 1 }).lean();
    return res.json({ rules: await Promise.all(rules.map(ruleView)), lines: manageable });
  } catch (err) {
    logger.error("plumconnect GET /assignment-rules error", { err });
    return res.status(500).json({ error: "Failed to list assignment rules." });
  }
});

// POST /assignment-rules — { target: { type, line, metaId? }, userId, priority?, enabled? }
router.post("/assignment-rules", async (req, res) => {
  try {
    const body = (req.body as AnyObj) ?? {};
    const target = body.target ?? {};
    if (!(ASSIGNMENT_TARGET_TYPES as readonly string[]).includes(String(target.type))) return res.status(400).json({ error: "target.type must be department, campaign or ad." });
    if (!isAccessLine(target.line)) return res.status(400).json({ error: "target.line must be one of plumtrips, helloviza, concierge, support." });
    if (!canManageRules(req, target.line)) return res.status(403).json({ error: "FULL access on that line is required." });
    const t = { type: target.type, line: target.line, metaId: String(target.metaId || "").trim() };
    const vt = await validateRuleTarget(t);
    if (vt.ok === false) return res.status(400).json({ error: vt.error });
    const vu = await validateRuleUser(body.userId, t.line);
    if (vu.ok === false) return res.status(400).json({ error: vu.error });
    const priority = body.priority === undefined ? 100 : Number(body.priority);
    if (!Number.isInteger(priority) || priority < 0) return res.status(400).json({ error: "priority must be a non-negative integer." });
    const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
    const ctx = inboxScope(req, t.line);
    const existing = await PlumConnectAssignmentRule.findOne({ userId: new mongoose.Types.ObjectId(String(body.userId)), targetKey: assignmentTargetKey(t) });
    if (existing) return res.status(409).json({ error: "This user is already mapped to that target — update the existing rule." });
    const rule = await PlumConnectAssignmentRule.create({ target: t, userId: new mongoose.Types.ObjectId(String(body.userId)), priority, enabled, createdBy: ctx.userId });
    return res.status(201).json({ rule: await ruleView(rule.toObject()) });
  } catch (err) {
    logger.error("plumconnect POST /assignment-rules error", { err });
    return res.status(500).json({ error: "Failed to create the assignment rule." });
  }
});

// PATCH /assignment-rules/:id — { priority?, enabled?, userId? }
router.patch("/assignment-rules/:id", async (req, res) => {
  try {
    const id = oid(req.params.id);
    const rule = id ? await PlumConnectAssignmentRule.findById(id) : null;
    if (!rule) return res.status(404).json({ error: "Rule not found." });
    if (!canManageRules(req, rule.target.line)) return res.status(403).json({ error: "FULL access on that line is required." });
    const body = (req.body as AnyObj) ?? {};
    if (body.priority !== undefined) {
      const priority = Number(body.priority);
      if (!Number.isInteger(priority) || priority < 0) return res.status(400).json({ error: "priority must be a non-negative integer." });
      rule.priority = priority;
    }
    if (body.enabled !== undefined) rule.enabled = Boolean(body.enabled);
    if (body.userId !== undefined) {
      const vu = await validateRuleUser(body.userId, rule.target.line);
      if (vu.ok === false) return res.status(400).json({ error: vu.error });
      rule.userId = new mongoose.Types.ObjectId(String(body.userId));
    }
    await rule.save();
    return res.json({ rule: await ruleView(rule.toObject()) });
  } catch (err: any) {
    if (err?.code === 11000) return res.status(409).json({ error: "This user is already mapped to that target." });
    logger.error("plumconnect PATCH /assignment-rules error", { err });
    return res.status(500).json({ error: "Failed to update the assignment rule." });
  }
});

// DELETE /assignment-rules/:id
router.delete("/assignment-rules/:id", async (req, res) => {
  try {
    const id = oid(req.params.id);
    const rule = id ? await PlumConnectAssignmentRule.findById(id) : null;
    if (!rule) return res.status(404).json({ error: "Rule not found." });
    if (!canManageRules(req, rule.target.line)) return res.status(403).json({ error: "FULL access on that line is required." });
    await rule.deleteOne();
    return res.json({ deleted: true });
  } catch (err) {
    logger.error("plumconnect DELETE /assignment-rules error", { err });
    return res.status(500).json({ error: "Failed to delete the assignment rule." });
  }
});

// ── Track A — agent presence, per line ─────────────────────────────────
// Stored and exposed only; nothing routes on it yet (Track B). The guard
// above already resolved the caller's Slice 7 grants: a line the caller
// does not hold is a 403 and nothing is written.

// GET /presence — my per-line active/away map + the lines I hold.
router.get("/presence", async (req, res) => {
  try {
    const ctx = inboxScope(req, "support"); // only for the caller id
    if (!ctx.userId) return res.status(401).json({ error: "Unauthorized" });
    const presence = await getPresence(ctx.userId, new Date());
    return res.json({ presence, lines: heldLines(lineGrants(req)), ttlMs: presenceTtlMs() });
  } catch (err) {
    logger.error("plumconnect GET /presence error", { err });
    return res.status(500).json({ error: "Failed to load presence." });
  }
});

// POST /presence — { line, active }: set my presence on a line I hold.
router.post("/presence", async (req, res) => {
  try {
    const ctx = inboxScope(req, "support");
    if (!ctx.userId) return res.status(401).json({ error: "Unauthorized" });
    const body = (req.body as AnyObj) ?? {};
    if (!isAccessLine(body.line)) return res.status(400).json({ error: "line must be one of plumtrips, helloviza, concierge, support." });
    if (typeof body.active !== "boolean") return res.status(400).json({ error: "active must be true or false." });
    const r = await setPresence({ userId: ctx.userId, grants: lineGrants(req), line: body.line, active: body.active, now: new Date() });
    if (r.ok === false) {
      if (r.reason === "line_not_held") return res.status(403).json({ error: "You do not hold this PlumConnect line." });
      return res.status(400).json({ error: "Invalid presence request." });
    }
    return res.json({ line: r.line, presence: r.presence, all: await getPresence(ctx.userId, new Date()) });
  } catch (err) {
    logger.error("plumconnect POST /presence error", { err });
    return res.status(500).json({ error: "Failed to set presence." });
  }
});

// GET / — the inbox list: the union of the caller's held lines, each under
// its own scope, newest activity first. ?line= narrows to one held line.
router.get("/conversations", async (req, res) => {
  try {
    const lineParam = String(req.query.line || "");
    if (lineParam && !isAccessLine(lineParam)) return res.status(400).json({ error: "Invalid line." });
    const only = isAccessLine(lineParam) ? lineParam : undefined;
    // Track B: the light re-resolve — held / tied threads on the caller's
    // lines get another look now (an agent may have come active), so the
    // list below already reflects it. Bounded; no background job.
    await reResolveHeld({ lines: heldLines(lineGrants(req)).filter((l) => !only || l === only), now: new Date() });
    const filter: AnyObj = { $and: [conversationMatch(req, only)] };

    const status = String(req.query.status || "").toUpperCase();
    if (status) {
      if (!(CONVERSATION_STATUSES as readonly string[]).includes(status)) return res.status(400).json({ error: "Invalid status." });
      filter.status = status;
    }
    const kind = String(req.query.kind || "").toLowerCase();
    if (kind) {
      if (!(CONVERSATION_KINDS as readonly string[]).includes(kind)) return res.status(400).json({ error: "Invalid kind." });
      filter.kind = kind;
    }
    if (String(req.query.unassigned || "") === "true") {
      // A line held at OWN already pins assignedTo to the caller inside its
      // clause, so "unassigned" can only ever match on a line held at ALL.
      // Never widens OWN.
      filter.assignedTo = null;
    }

    const rows = await PlumConnectConversation.find(filter)
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(LIST_LIMIT)
      .lean();
    const contactIds = [...new Set(rows.map((r: any) => String(r.contactId)))].map((s) => new mongoose.Types.ObjectId(s));
    const contacts = await PlumConnectContact.find({ _id: { $in: contactIds } }).select("phone displayName identityState").lean();
    const byId = new Map(contacts.map((c: any) => [String(c._id), c]));

    return res.json({ conversations: rows.map((r: any) => summarize(r, byId.get(String(r.contactId)))), lines: lineGrants(req) });
  } catch (err) {
    logger.error("plumconnect GET /conversations error", { err });
    return res.status(500).json({ error: "Failed to list conversations." });
  }
});

// GET /:id — one conversation + its thread.
router.get("/conversations/:id", async (req, res) => {
  try {
    const conversation = await loadVisible(req, res);
    if (!conversation) return;
    const contact = await PlumConnectContact.findById(conversation.contactId).lean();
    const messages = await PlumConnectMessage.find({ conversationId: conversation._id }).sort({ createdAt: 1 }).lean();
    return res.json({ conversation: summarize(conversation.toObject(), contact), messages });
  } catch (err) {
    logger.error("plumconnect GET /conversations/:id error", { err });
    return res.status(500).json({ error: "Failed to load conversation." });
  }
});

// POST /:id/assign — assign to self (WRITE) or to someone else (FULL + ALL).
router.post("/conversations/:id/assign", async (req, res) => {
  try {
    const id = oid(req.params.id);
    const conversation = id ? await PlumConnectConversation.findById(id) : null;
    if (!conversation) return res.status(404).json({ error: "Conversation not found." });

    // The line decides which grant applies — before any verb is considered.
    const line = lineOfConversation(conversation);
    const ctx = inboxScope(req, line);
    if (!ctx.userId) return res.status(401).json({ error: "Unauthorized" });
    if (!holdsAtLeast({ access: ctx.access, scope: ctx.scope }, "READ")) return res.status(403).json({ error: "This conversation is not in your scope." });
    if (!requireWrite(ctx, res)) return;

    const target = oid((req.body as AnyObj)?.userId) ?? ctx.userId;
    const toSelf = String(target) === String(ctx.userId);

    // Taking an unassigned conversation for yourself is a WRITE verb, even
    // under OWN scope (nothing is "yours" until you take it). Anything else
    // — moving someone else's, or handing one to someone else — is FULL + ALL.
    const claimingFree = toSelf && !conversation.assignedTo;
    if (!claimingFree) {
      if (!canSee(ctx, conversation)) return res.status(403).json({ error: "This conversation is not in your scope." });
      if (!toSelf && !canReassign(ctx)) return res.status(403).json({ error: "Reassigning to another user needs FULL access." });
    }

    const targetUser: any = await User.findById(target).select("_id roles").lean();
    if (!targetUser) return res.status(400).json({ error: "Assignee not found." });
    // Never hand a thread to someone who cannot see its line — it would
    // vanish from every inbox that could act on it.
    if (!toSelf && !holdsAtLeast(canAccessLine(await lineGrantsForUserId(targetUser._id, targetUser.roles), line), "READ")) {
      return res.status(400).json({ error: "Assignee has no access to this conversation's line." });
    }

    const now = new Date();
    const previous = conversation.assignedTo ?? null;
    conversation.assignedTo = target;
    if (conversation.status === "RESOLVED") conversation.status = "OPEN";
    // Track B: a take / reassign by a person ends any matrix state (a tie is
    // claimed, a hold is over) and IS a human takeover for the bot.
    const prevRouting: AnyObj = (conversation.routing as any)?.toObject?.() ?? conversation.routing ?? {};
    conversation.routing = { ...prevRouting, state: "assigned", candidates: [target], autoAssigned: false, resolvedAt: now, reason: claimingFree ? "taken" : "reassigned" } as any;
    await conversation.save();
    if (botIsActive(conversation)) await stopBot(conversation._id as mongoose.Types.ObjectId, "human", now);

    const name = await displayName(target);
    // The CRM Lead follows the thread's owner.
    if (conversation.leadId) await Lead.updateOne({ _id: conversation.leadId }, { $set: { assignedTo: target, assignedToName: name } });
    await systemNote(conversation._id as mongoose.Types.ObjectId, `Assigned to ${name || String(target)}`, ctx.userId, { kind: "assignment", from: previous, to: target }, now);

    const fresh = await PlumConnectConversation.findById(conversation._id).lean();
    return res.json({ conversation: summarize(fresh, await PlumConnectContact.findById(conversation.contactId).lean()) });
  } catch (err) {
    logger.error("plumconnect POST /assign error", { err });
    return res.status(500).json({ error: "Failed to assign conversation." });
  }
});

// POST /:id/note — internal note: a Message the contact never sees. Never sent.
router.post("/conversations/:id/note", async (req, res) => {
  try {
    const conversation = await loadVisible(req, res);
    if (!conversation) return;
    const ctx = ctxFor(req, conversation);
    if (!requireWrite(ctx, res)) return;

    const text = String((req.body as AnyObj)?.text ?? "").trim().slice(0, TEXT_CAP);
    if (!text) return res.status(400).json({ error: "Note text is required." });

    const note = await PlumConnectMessage.create({
      conversationId: conversation._id,
      direction: "OUTBOUND",
      channel: "whatsapp",
      type: "note",
      text,
      authorUserId: ctx.userId,
      visibleToContact: false,
      sentAt: new Date(),
    });
    return res.status(201).json({ message: note });
  } catch (err) {
    logger.error("plumconnect POST /note error", { err });
    return res.status(500).json({ error: "Failed to add note." });
  }
});

// POST /:id/reply — send a text to the contact; the agent takes over.
router.post("/conversations/:id/reply", async (req, res) => {
  try {
    const conversation = await loadVisible(req, res);
    if (!conversation) return;
    const ctx = ctxFor(req, conversation);
    if (!requireWrite(ctx, res)) return;

    const text = String((req.body as AnyObj)?.text ?? "").trim().slice(0, TEXT_CAP);
    if (!text) return res.status(400).json({ error: "Reply text is required." });

    const now = new Date();
    const lastIn = conversation.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0;
    if (!lastIn || now.getTime() - lastIn > REPLY_WINDOW_MS) {
      return res.status(409).json({
        error: "Outside WhatsApp's 24-hour customer-service window — a free-form reply cannot be delivered. Template messages are not available yet.",
        code: "OUTSIDE_24H_WINDOW",
        lastInboundAt: conversation.lastInboundAt ?? null,
      });
    }

    const contact = await PlumConnectContact.findById(conversation.contactId).lean();
    if (!contact?.phone) return res.status(409).json({ error: "Conversation has no recipient phone." });

    // Human takeover BEFORE the send, so the bot cannot slip a turn in.
    if (botIsActive(conversation)) await stopBot(conversation._id as mongoose.Types.ObjectId, "human", now);

    const { outcome, persisted } = await sendTextOutcome(contact.phone, text, {
      origin: "agent",
      conversationId: conversation._id as mongoose.Types.ObjectId,
      authorUserId: ctx.userId,
      payload: { agentReply: true },
      now,
    });
    if (!outcome.ok || !outcome.wamid) {
      return res.status(502).json({ error: "WhatsApp did not accept the message.", detail: outcome.error ?? null });
    }

    await PlumConnectConversation.updateOne(
      { _id: conversation._id },
      { $set: { status: "PENDING", lastOutboundAt: now, lastMessageAt: now } },
    );

    const message = persisted.messageId ? await PlumConnectMessage.findById(persisted.messageId).lean() : null;
    return res.status(201).json({ sent: true, wamid: outcome.wamid, persistFailed: persisted.persistFailed, message });
  } catch (err) {
    logger.error("plumconnect POST /reply error", { err });
    return res.status(500).json({ error: "Failed to send reply." });
  }
});

// POST /:id/resolve — close the conversation.
router.post("/conversations/:id/resolve", async (req, res) => {
  try {
    const conversation = await loadVisible(req, res);
    if (!conversation) return;
    const ctx = ctxFor(req, conversation);
    if (!requireWrite(ctx, res)) return;
    if (conversation.status === "RESOLVED") return res.status(409).json({ error: "Already resolved." });

    const now = new Date();
    conversation.status = "RESOLVED";
    conversation.resolvedAt = now;
    conversation.resolvedBy = ctx.userId;
    await conversation.save();
    if (botIsActive(conversation)) await stopBot(conversation._id as mongoose.Types.ObjectId, "human", now);
    await systemNote(conversation._id as mongoose.Types.ObjectId, "Resolved", ctx.userId, { kind: "status", to: "RESOLVED" }, now);
    return res.json({ conversation: summarize(conversation.toObject(), await PlumConnectContact.findById(conversation.contactId).lean()) });
  } catch (err) {
    logger.error("plumconnect POST /resolve error", { err });
    return res.status(500).json({ error: "Failed to resolve conversation." });
  }
});

// POST /:id/reopen — back to OPEN.
router.post("/conversations/:id/reopen", async (req, res) => {
  try {
    const conversation = await loadVisible(req, res);
    if (!conversation) return;
    const ctx = ctxFor(req, conversation);
    if (!requireWrite(ctx, res)) return;
    if (conversation.status !== "RESOLVED") return res.status(409).json({ error: "Only a resolved conversation can be reopened." });

    const now = new Date();
    conversation.status = "OPEN";
    conversation.resolvedAt = null;
    conversation.resolvedBy = null;
    await conversation.save();
    await systemNote(conversation._id as mongoose.Types.ObjectId, "Reopened", ctx.userId, { kind: "status", to: "OPEN" }, now);
    return res.json({ conversation: summarize(conversation.toObject(), await PlumConnectContact.findById(conversation.contactId).lean()) });
  } catch (err) {
    logger.error("plumconnect POST /reopen error", { err });
    return res.status(500).json({ error: "Failed to reopen conversation." });
  }
});

export default router;
