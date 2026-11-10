// apps/backend/src/utils/plutoMemory.ts
//
// Capstone — TENANT-SCOPED, durable conversation memory (closes audit RED #1).
// The bare in-process Map (keyed by conversationId alone → cross-tenant leak,
// per-instance, lost on restart) is GONE. Reads/writes are scoped by
// {workspaceId, conversationId} against the PlutoConversation Mongo store.
//
// SECURITY: a read for a conversationId that belongs to another workspace returns
// null EXACTLY as a genuine miss does — indistinguishable, so there is no oracle
// for probing which ids exist. Tenant identity comes from req, never from
// client-supplied body fields.
//
// RESILIENCE: a Mongo blip must never kill a turn. Read failure → null (fall back
// to client context) + pluto.memory.read_failed. Write failure → turn still
// succeeds + pluto.memory.write_failed. No in-process cache in v1 (correctness
// first; a measured cache is a later decision).

import mongoose from "mongoose";
import PlutoConversation from "../models/PlutoConversation.js";
import { emitMetric } from "./plutoMetricsSink.js";
import { memoryReadFailed, memoryWriteFailed } from "./plutoMetricsBuilder.js";

const MAX_CONVERSATION_ID_LEN = 64;

/**
 * conversationId hygiene (Amendment Q): the id flows from client input straight
 * into a Mongo filter, so validate its SHAPE first. Reject non-strings
 * (objects/arrays — no operator injection), empty, and over-long ids. A string
 * value in a filter is a literal match, so a valid string cannot inject.
 */
export function isValidConversationId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_CONVERSATION_ID_LEN;
}

function connected(): boolean {
  return mongoose.connection?.readyState === 1;
}

export interface MemoryReadArgs {
  workspaceObjectId: any;
  userId?: any;
  conversationId: unknown;
}
export interface MemorySaveArgs extends MemoryReadArgs {
  context: any;
  handoffDelivered?: boolean;
}

/**
 * OWNERSHIP (all reads and writes in this file). A conversation belongs to the
 * user who created it — `userId`, stamped on insert and never overwritten.
 * Workspace scope alone let any user in the workspace who held a
 * conversationId read it and, through the {workspaceId, conversationId}
 * upsert, overwrite it. A doc with no recorded owner (legacy) is nobody's.
 *
 * The outcome of an OWNER-scoped read. The owner is the user
 * who created the conversation (userId, stamped on insert and never
 * overwritten). There is no role bypass: a SUPERADMIN reading someone else's
 * chat gets "foreign" like anyone else.
 *
 *   owned       — this user's conversation; `context` is the stored bag
 *   missing     — no such conversation in this workspace (new / TTL-expired)
 *   foreign     — it exists but belongs to someone else (or has no owner);
 *                 the caller must start a FRESH conversation under a new id
 *   unavailable — no live store, DB error, missing tenant or malformed id
 */
export type OwnedConversationLoad =
  | { status: "owned"; context: any }
  | { status: "missing" }
  | { status: "foreign" }
  | { status: "unavailable" };

export async function loadConversationForUser(args: MemoryReadArgs): Promise<OwnedConversationLoad> {
  const { workspaceObjectId, userId, conversationId } = args || ({} as MemoryReadArgs);
  if (!workspaceObjectId || !isValidConversationId(conversationId)) return { status: "unavailable" };
  if (!connected()) return { status: "unavailable" };
  try {
    const doc: any = await PlutoConversation.findOne({
      workspaceId: workspaceObjectId,
      conversationId,
    }).lean();
    if (!doc) return { status: "missing" };
    const owner = doc.userId != null ? String(doc.userId) : "";
    if (!owner || !userId || owner !== String(userId)) return { status: "foreign" };
    return { status: "owned", context: doc.context ?? {} };
  } catch (e: any) {
    void emitMetric(memoryReadFailed({ workspaceId: String(workspaceObjectId), reason: e?.message }));
    return { status: "unavailable" };
  }
}

/**
 * Read THIS USER's conversation context bag, or null on a miss / another
 * user's (or an ownerless) conversation / wrong workspace / malformed id / no
 * store / DB blip — all indistinguishable. Callers treat null as "first turn /
 * expired" and fall back to the client-supplied context.
 */
export async function getConversationContext(args: MemoryReadArgs): Promise<any | null> {
  const r = await loadConversationForUser(args);
  return r.status === "owned" ? (r.context ?? null) : null;
}

/**
 * UPSERT this user's context on {workspaceId, conversationId, userId}
 * (Amendment P + ownership). Every save $sets the context bag + lastTurnAt;
 * an insert is stamped with this user (the owner, from the filter) and
 * createdAt. A save can NEVER create a second doc for the same
 * {workspaceId, conversationId} (unique index), and can never write another
 * user's doc: that insert collides and is dropped, never retried without the
 * owner. No userId → no write.
 */
export async function saveConversationContext(args: MemorySaveArgs): Promise<void> {
  const { workspaceObjectId, userId, conversationId, context, handoffDelivered } =
    args || ({} as MemorySaveArgs);
  if (!workspaceObjectId || !isValidConversationId(conversationId)) return;
  if (!connected()) return;
  const set: any = { context, lastTurnAt: new Date() };
  if (handoffDelivered !== undefined) set.handoffDelivered = handoffDelivered;
  {
    // userId is IN the filter, so the upsert either updates this user's own
    // doc or inserts a new one stamped with this user. Another user's doc with
    // the same id makes the insert collide on the unique index → dropped, never
    // a fallback update without the owner (which is exactly the leak).
    if (!userId) return;
    try {
      await PlutoConversation.updateOne(
        { workspaceId: workspaceObjectId, conversationId, userId },
        { $set: set, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      );
    } catch (e: any) {
      if (e?.code !== 11000) {
        void emitMetric(memoryWriteFailed({ workspaceId: String(workspaceObjectId), reason: e?.message }));
        return;
      }
      // E11000: either this user's own concurrent first write won the insert
      // (retry as an owner-scoped update), or the id is someone else's (the
      // owner-scoped update matches nothing — still never their doc).
      try {
        const r: any = await PlutoConversation.updateOne(
          { workspaceId: workspaceObjectId, conversationId, userId },
          { $set: set },
        );
        if (!r?.matchedCount) {
          void emitMetric(memoryWriteFailed({ workspaceId: String(workspaceObjectId), reason: "owner_mismatch" }));
        }
      } catch (e2: any) {
        void emitMetric(memoryWriteFailed({ workspaceId: String(workspaceObjectId), reason: e2?.message }));
      }
    }
  }
}

export interface HandoffGuardArgs {
  workspaceObjectId: any;
  userId?: any;
  conversationId: unknown;
}

/**
 * Server-side, cross-instance handoff dedup (Step 3). Atomically CLAIM the right
 * to deliver on the Mongo conversation store: flip handoffDelivered false→true.
 * Returns true iff THIS caller won the claim (should deliver); false means it was
 * already delivered (by an earlier turn or a concurrent instance) → skip.
 *
 * The upsert + unique {workspaceId, conversationId} index makes it race-safe: the
 * filter {handoffDelivered:false} matches only an undelivered doc; when a
 * delivered doc already exists the filter misses, the upsert insert collides on
 * the unique index (E11000), and we return false.
 */
export async function claimHandoffDelivery(args: HandoffGuardArgs): Promise<boolean> {
  const { workspaceObjectId, userId, conversationId } = args || ({} as HandoffGuardArgs);
  if (!workspaceObjectId || !isValidConversationId(conversationId)) return false;
  // No live store → cannot dedup; deliver (best-effort, matches pre-migration).
  if (!connected()) return true;
  try {
    // Owner-scoped like every other write: the claim can only flip (or
    // create) this user's own doc.
    await PlutoConversation.findOneAndUpdate(
      userId
        ? { workspaceId: workspaceObjectId, conversationId, userId, handoffDelivered: false }
        : { workspaceId: workspaceObjectId, conversationId, handoffDelivered: false },
      {
        $set: { handoffDelivered: true, lastTurnAt: new Date() },
        $setOnInsert: { ...(userId ? {} : { userId: null }), createdAt: new Date(), context: {} },
      },
      { upsert: true, new: true },
    );
    return true; // won the claim → deliver
  } catch (e: any) {
    if (e?.code === 11000) return false; // already delivered → skip (idempotent)
    void emitMetric(memoryWriteFailed({ workspaceId: String(workspaceObjectId), reason: e?.message }));
    return true; // unexpected error → prefer delivering over silently dropping a handoff
  }
}

/**
 * Release a claim when delivery FAILS after claiming, so a later turn can retry
 * (preserves the pre-migration "never lock on failure" behaviour). Best-effort.
 */
export async function releaseHandoffDelivery(args: { workspaceObjectId: any; conversationId: unknown }): Promise<void> {
  const { workspaceObjectId, conversationId } = args || ({} as any);
  if (!workspaceObjectId || !isValidConversationId(conversationId)) return;
  if (!connected()) return;
  try {
    await PlutoConversation.updateOne(
      { workspaceId: workspaceObjectId, conversationId },
      { $set: { handoffDelivered: false } },
    );
  } catch {
    /* best-effort — a failed release just means no retry */
  }
}
