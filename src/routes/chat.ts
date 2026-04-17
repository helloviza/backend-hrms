import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { verifyToken } from "../utils/jwt.js";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import User from "../models/User.js";
import {
  addClient,
  removeClient,
  sendToUsers,
  getOnlineUsers,
  getClientCount,
  isOnline,
} from "../services/chatSSE.js";
import logger from "../utils/logger.js";

const router = Router();

// ─── GET /stream ──────────────────────────────────────────────────────────────
// SSE endpoint — browser EventSource cannot set headers so the JWT is passed
// as a query param: /api/chat/stream?token=<jwt>
router.get("/stream", async (req: Request, res: Response) => {
  // Accept token from query param (EventSource) or Authorization header (fetch)
  const rawToken =
    (req.query.token as string | undefined) ||
    req.headers.authorization?.replace("Bearer ", "").trim();

  if (!rawToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let userId: string;
  let workspaceId: string;
  let decoded: any;

  try {
    decoded = verifyToken(rawToken) as any;
    userId = String(decoded._id || decoded.id || decoded.sub || "");
    workspaceId = String(decoded.workspaceId || decoded.customerId || "");
    if (!userId) throw new Error("no user id in token");
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  // Disable Nagle's algorithm — without this, small SSE frames get buffered
  // and may not be flushed to the client for hundreds of milliseconds.
  const socket = (res as any).socket;
  if (socket) {
    socket.setNoDelay(true);
    socket.setTimeout(0);
  }
  console.log('[SSE] Client connected:', userId);

  addClient(userId, res);

  res.write(
    `event: connected\ndata: ${JSON.stringify({
      userId,
      onlineUsers: getOnlineUsers(),
    })}\n\n`
  );

  // Send immediate ping so the client's heartbeat timer resets right away.
  // Without this, a reconnect leaves a 0–15s window with no ping → the 30s
  // heartbeat fires → triggers another reconnect → infinite loop.
  res.write("event: ping\ndata: {}\n\n");
  if (typeof (res as any).flush === "function") {
    (res as any).flush();
  }

  // Notify workspace peers this user came online
  // Guard: skip DB query if workspaceId is absent from token (CastError prevention)
  const workspaceUsers = workspaceId
    ? await User.find({ workspaceId }, "_id").lean()
    : [];
  const allUserIds = (workspaceUsers as any[])
    .map((u) => String(u._id))
    .filter((id) => id !== userId);

  sendToUsers(allUserIds, "user_online", { userId });

  const keepaliveInterval = setInterval(() => {
    if (!res.writableEnded) {
      const wrote = res.write("event: ping\ndata: {}\n\n");
      if (!wrote) {
        // Backpressure — resume when drained
        res.once("drain", () => {});
      }
      if (typeof (res as any).flush === "function") {
        (res as any).flush();
      }
      const sock = (res as any).socket;
      if (sock && typeof sock.flush === "function") {
        sock.flush();
      }
    } else {
      clearInterval(keepaliveInterval);
    }
  }, 10_000);

  req.on("close", async () => {
    console.log('[SSE] Client disconnected:', userId);
    clearInterval(keepaliveInterval);
    removeClient(userId, res);
    sendToUsers(allUserIds, "user_offline", { userId });
    try {
      await User.findByIdAndUpdate(userId, { lastSeenAt: new Date() });
    } catch (err) {
      logger.error("[chat/stream] lastSeenAt update failed", { err });
    }
  });
});

// ─── GET /conversations ───────────────────────────────────────────────────────
router.get("/conversations", requireAuth, requireWorkspace, async (req: Request, res: Response) => {
  const userId = String((req as any).user._id || (req as any).user.id);
  const wsId = String((req as any).workspaceObjectId);

  const conversations = await Conversation.find({
    workspaceId: wsId,
    participants: userId,
    isActive: true,
  })
    .sort({ updatedAt: -1 })
    .lean();

  const enriched = (conversations as any[]).map((c) => {
    if (c.type === "direct") {
      const otherId = (c.participants as any[]).map((p: any) => String(p)).find((p: string) => p !== userId);
      return { ...c, otherUserId: otherId, isOnline: isOnline(otherId || "") };
    }
    return c;
  });

  return res.json({ ok: true, conversations: enriched });
});

// ─── GET /conversations/:id/messages ─────────────────────────────────────────
router.get(
  "/conversations/:id/messages",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    const userId = String((req as any).user._id || (req as any).user.id);
    const { id } = req.params;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const before = req.query.before as string | undefined;

    const conv = await Conversation.findOne({
      _id: id,
      participants: userId,
      workspaceId: String((req as any).workspaceObjectId),
    }).lean();

    if (!conv) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const query: Record<string, unknown> = { conversationId: id, deleted: false };
    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    // Mark unread messages as read (avoid duplicate readBy entries)
    await Message.updateMany(
      {
        conversationId: id,
        senderId: { $ne: userId },
        "readBy.userId": { $ne: userId },
      },
      { $push: { readBy: { userId, readAt: new Date() } } }
    );

    // Reset this user's unread counter
    await Conversation.findByIdAndUpdate(id, {
      [`unreadCounts.${userId}`]: 0,
    });

    return res.json({ ok: true, messages: messages.reverse() });
  }
);

// ─── POST /conversations ──────────────────────────────────────────────────────
router.post("/conversations", requireAuth, requireWorkspace, async (req: Request, res: Response) => {
  const userId = String((req as any).user._id || (req as any).user.id);
  const wsId = String((req as any).workspaceObjectId);
  const { type, participantIds, name, description } = req.body as {
    type?: string;
    participantIds?: string[];
    name?: string;
    description?: string;
  };

  // For direct chats, return existing conversation if it already exists
  if (type === "direct") {
    const otherId = participantIds?.[0];
    const existing = await Conversation.findOne({
      type: "direct",
      workspaceId: wsId,
      participants: { $all: [userId, otherId], $size: 2 },
    }).lean();

    if (existing) {
      return res.json({ ok: true, conversation: existing, existing: true });
    }
  }

  const sender = (await User.findById(userId, "name firstName lastName").lean()) as any;
  const senderName =
    sender?.name ||
    `${sender?.firstName || ""} ${sender?.lastName || ""}`.trim() ||
    "Unknown";

  const allParticipants =
    type === "direct" ? [userId, participantIds![0]] : [userId, ...(participantIds || [])];

  const conv = await Conversation.create({
    type: type || "direct",
    workspaceId: wsId,
    name: name || "",
    description: description || "",
    participants: allParticipants,
    createdBy: userId,
    adminOnly: type === "announcement",
    lastMessage: {},
    unreadCounts: new Map(),
    isActive: true,
  });

  sendToUsers(
    allParticipants.filter((p) => p !== userId),
    "new_conversation",
    conv
  );

  return res.json({ ok: true, conversation: conv });
});

// ─── POST /conversations/:id/messages ────────────────────────────────────────
router.post(
  "/conversations/:id/messages",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    const userId = String((req as any).user._id || (req as any).user.id);
    const { id } = req.params;
    const { text } = req.body as { text?: string };

    if (!text?.trim()) {
      return res.status(400).json({ error: "Message text required" });
    }

    const conv = (await Conversation.findOne({
      _id: id,
      participants: userId,
      workspaceId: String((req as any).workspaceObjectId),
    }).lean()) as any;

    if (!conv) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    if (conv.adminOnly && conv.createdBy !== userId) {
      return res.status(403).json({ error: "Only admins can post here" });
    }

    const sender = (await User.findById(userId, "name firstName lastName avatarUrl").lean()) as any;
    const senderName =
      sender?.name || `${sender?.firstName || ""} ${sender?.lastName || ""}`.trim();

    const message = await Message.create({
      conversationId: id,
      workspaceId: String((req as any).workspaceObjectId),
      senderId: userId,
      senderName,
      senderAvatar: sender?.avatarUrl || "",
      text: text.trim(),
      readBy: [{ userId, readAt: new Date() }],
      edited: false,
      deleted: false,
    });

    const others: string[] = (conv.participants as any[])
      .map((p: any) => String(p))
      .filter((p: string) => p !== userId);

    // Update lastMessage preview + increment unread counts for all other participants
    await Conversation.findByIdAndUpdate(id, {
      lastMessage: {
        text: text.trim(),
        senderId: userId,
        senderName,
        sentAt: new Date(),
      },
      $inc: Object.fromEntries(others.map((uid) => [`unreadCounts.${uid}`, 1])),
    });

    const allParticipantIds = (conv.participants as any[]).map((p: any) => String(p));

    sendToUsers(
      allParticipantIds,
      "new_message",
      { conversationId: id, message }
    );

    return res.json({ ok: true, message });
  }
);

// ─── GET /users ───────────────────────────────────────────────────────────────
// All workspace users for the People tab, with online presence
router.get("/users", requireAuth, requireWorkspace, async (req: Request, res: Response) => {
  const userId = String((req as any).user._id || (req as any).user.id);
  const wsId = String((req as any).workspaceObjectId);

  const users = await User.find(
    { workspaceId: wsId, _id: { $ne: userId } },
    "name firstName lastName avatarUrl email hrmsAccessRole lastSeenAt"
  ).lean();

  const enriched = (users as any[]).map((u) => ({
    ...u,
    isOnline: isOnline(String(u._id)),
    displayName: u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim(),
  }));

  return res.json({ ok: true, users: enriched });
});

// ─── GET /unread-count ────────────────────────────────────────────────────────
// Total unread badge count for the current user
router.get("/unread-count", requireAuth, requireWorkspace, async (req: Request, res: Response) => {
  const userId = String((req as any).user._id || (req as any).user.id);
  const wsId = String((req as any).workspaceObjectId);

  const conversations = await Conversation.find(
    { workspaceId: wsId, participants: userId, isActive: true },
    `unreadCounts.${userId}`
  ).lean();

  const total = (conversations as any[]).reduce((sum, c) => {
    const count = c.unreadCounts instanceof Map
      ? c.unreadCounts.get(userId) || 0
      : c.unreadCounts?.[userId] || 0;
    return sum + count;
  }, 0);

  return res.json({ ok: true, unread: total });
});

export default router;
