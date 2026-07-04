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
 * Read the conversation context bag for {workspaceId, conversationId}, or null on
 * a miss / wrong-workspace / malformed id / no store / DB blip. Callers treat
 * null as "first turn / expired" and fall back to the client-supplied context.
 */
export async function getConversationContext(args: MemoryReadArgs): Promise<any | null> {
  const { workspaceObjectId, conversationId } = args || ({} as MemoryReadArgs);
  // Malformed id or missing tenant → a miss (never reaches a query).
  if (!workspaceObjectId || !isValidConversationId(conversationId)) return null;
  // No live store → graceful miss (fall back to client context).
  if (!connected()) return null;
  try {
    const doc: any = await PlutoConversation.findOne({
      workspaceId: workspaceObjectId,
      conversationId,
    }).lean();
    return doc ? (doc.context ?? null) : null;
  } catch (e: any) {
    void emitMetric(memoryReadFailed({ workspaceId: String(workspaceObjectId), reason: e?.message }));
    return null; // a DB blip must not kill the turn
  }
}

/**
 * UPSERT the context on {workspaceId, conversationId} (Amendment P). Every save
 * $sets the context bag + lastTurnAt; $setOnInsert stamps userId (the
 * originator — never overwritten by later turns) + createdAt. A save can NEVER
 * create a second doc for the same {workspaceId, conversationId}.
 */
export async function saveConversationContext(args: MemorySaveArgs): Promise<void> {
  const { workspaceObjectId, userId, conversationId, context, handoffDelivered } =
    args || ({} as MemorySaveArgs);
  if (!workspaceObjectId || !isValidConversationId(conversationId)) return;
  if (!connected()) return;
  try {
    const set: any = { context, lastTurnAt: new Date() };
    if (handoffDelivered !== undefined) set.handoffDelivered = handoffDelivered;
    await PlutoConversation.updateOne(
      { workspaceId: workspaceObjectId, conversationId },
      { $set: set, $setOnInsert: { userId: userId ?? null, createdAt: new Date() } },
      { upsert: true },
    );
  } catch (e: any) {
    void emitMetric(memoryWriteFailed({ workspaceId: String(workspaceObjectId), reason: e?.message }));
    // turn still succeeds
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
    await PlutoConversation.findOneAndUpdate(
      { workspaceId: workspaceObjectId, conversationId, handoffDelivered: false },
      {
        $set: { handoffDelivered: true, lastTurnAt: new Date() },
        $setOnInsert: { userId: userId ?? null, createdAt: new Date(), context: {} },
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
