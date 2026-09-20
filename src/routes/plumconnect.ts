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
import { inboxScope, conversationMatch, canSee, canWrite, canReassign } from "../services/plumconnect/inboxScope.js";
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
 * 403 when it exists but is outside the caller's scope — the security
 * property the tests pin.
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
  if (!canSee(inboxScope(req), conversation)) {
    res.status(403).json({ error: "This conversation is not in your scope." });
    return null;
  }
  return conversation;
}

function requireWrite(req: express.Request, res: express.Response): boolean {
  if (canWrite(inboxScope(req))) return true;
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
    status: c.status,
    assignedTo: c.assignedTo ?? null,
    leadId: c.leadId ?? null,
    bot: c.bot,
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

// GET /agents — who can be assigned a conversation. Mirrors
// requirePlumConnectAccess EXACTLY (the /leads/reps posture): HOUSE
// ADMIN/SUPERADMIN by role, unioned with explicit plumconnect grants;
// resolved against ACTIVE HOUSE users. Added for the 4c reassign picker.
router.get("/agents", async (_req, res) => {
  try {
    const houseObjectId = new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID);
    const grants = await UserPermission.find({
      workspaceId: HOUSE_WORKSPACE_ID,
      universe: "STAFF",
      "modules.plumconnect.access": { $in: ["READ", "WRITE", "FULL"] },
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

// GET / — the inbox list, scoped, newest activity first.
router.get("/conversations", async (req, res) => {
  try {
    const ctx = inboxScope(req);
    const filter: AnyObj = { ...conversationMatch(ctx) };

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
      // OWN scope already pins assignedTo to the caller; "unassigned" can
      // only ever match for an ALL scope. Never widen OWN.
      filter.assignedTo = filter.assignedTo ? { $in: [] } : null;
    }

    const rows = await PlumConnectConversation.find(filter)
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(LIST_LIMIT)
      .lean();
    const contactIds = [...new Set(rows.map((r: any) => String(r.contactId)))].map((s) => new mongoose.Types.ObjectId(s));
    const contacts = await PlumConnectContact.find({ _id: { $in: contactIds } }).select("phone displayName identityState").lean();
    const byId = new Map(contacts.map((c: any) => [String(c._id), c]));

    return res.json({ conversations: rows.map((r: any) => summarize(r, byId.get(String(r.contactId)))), scope: ctx.scope, access: ctx.access });
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
    const ctx = inboxScope(req);
    if (!ctx.userId) return res.status(401).json({ error: "Unauthorized" });
    if (!requireWrite(req, res)) return;

    const id = oid(req.params.id);
    const conversation = id ? await PlumConnectConversation.findById(id) : null;
    if (!conversation) return res.status(404).json({ error: "Conversation not found." });

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

    const targetUser = await User.findById(target).select("_id").lean();
    if (!targetUser) return res.status(400).json({ error: "Assignee not found." });

    const now = new Date();
    const previous = conversation.assignedTo ?? null;
    conversation.assignedTo = target;
    if (conversation.status === "RESOLVED") conversation.status = "OPEN";
    await conversation.save();
    if (botIsActive(conversation)) await stopBot(conversation._id as mongoose.Types.ObjectId, "human", now);

    const name = await displayName(target);
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
    const ctx = inboxScope(req);
    if (!requireWrite(req, res)) return;
    const conversation = await loadVisible(req, res);
    if (!conversation) return;

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
    const ctx = inboxScope(req);
    if (!requireWrite(req, res)) return;
    const conversation = await loadVisible(req, res);
    if (!conversation) return;

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
    const ctx = inboxScope(req);
    if (!requireWrite(req, res)) return;
    const conversation = await loadVisible(req, res);
    if (!conversation) return;
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
    const ctx = inboxScope(req);
    if (!requireWrite(req, res)) return;
    const conversation = await loadVisible(req, res);
    if (!conversation) return;
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
