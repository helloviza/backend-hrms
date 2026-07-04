// Capstone Step 2 — tenant-scoped memory: THE cross-tenant test + roundtrip,
// miss fallback, DB-failure resilience, id hygiene, concurrent-upsert.
import { describe, it, expect, vi, beforeEach } from "vitest";

const M = vi.hoisted(() => ({
  ready: { value: 1 },
  findOne: vi.fn(),
  updateOne: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("mongoose", () => ({
  default: { connection: { get readyState() { return M.ready.value; } } },
}));
vi.mock("../models/PlutoConversation.js", () => ({
  default: { findOne: M.findOne, updateOne: M.updateOne },
}));
vi.mock("./plutoMetricsSink.js", () => ({ emitMetric: M.emit }));

import { getConversationContext, saveConversationContext, isValidConversationId } from "./plutoMemory.js";

const WS_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const WS_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

// A stateful store enforcing uniqueness on {workspaceId, conversationId}.
const store = new Map<string, any>();
const key = (ws: any, c: any) => `${ws}|${c}`;

beforeEach(() => {
  store.clear();
  M.ready.value = 1;
  M.findOne.mockReset();
  M.updateOne.mockReset();
  M.emit.mockReset();
  M.findOne.mockImplementation((q: any) => ({ lean: async () => store.get(key(q.workspaceId, q.conversationId)) || null }));
  M.updateOne.mockImplementation(async (filter: any, update: any, opts: any) => {
    const k = key(filter.workspaceId, filter.conversationId);
    let doc = store.get(k);
    if (!doc && opts?.upsert) { doc = { workspaceId: filter.workspaceId, conversationId: filter.conversationId, ...(update.$setOnInsert || {}) }; store.set(k, doc); }
    if (doc) Object.assign(doc, update.$set || {});
    return { upsertedCount: doc ? 1 : 0 };
  });
});

describe("isValidConversationId (Amendment Q hygiene)", () => {
  it("accepts a sane string; rejects objects/arrays/empty/over-long", () => {
    expect(isValidConversationId("conv-1")).toBe(true);
    expect(isValidConversationId({ $gt: "" })).toBe(false); // operator injection
    expect(isValidConversationId(["c"])).toBe(false);
    expect(isValidConversationId("")).toBe(false);
    expect(isValidConversationId("x".repeat(65))).toBe(false);
    expect(isValidConversationId(undefined)).toBe(false);
  });
});

describe("getConversationContext — tenant scoping", () => {
  it("THE cross-tenant test: workspace B cannot read workspace A's conversation", async () => {
    await saveConversationContext({ workspaceObjectId: WS_A, userId: "uA", conversationId: "conv-1", context: { summary: "A secret" } });
    // Same workspace → reads it.
    expect(await getConversationContext({ workspaceObjectId: WS_A, conversationId: "conv-1" })).toEqual({ summary: "A secret" });
    // Different workspace, SAME conversationId → null, indistinguishable from a miss.
    expect(await getConversationContext({ workspaceObjectId: WS_B, conversationId: "conv-1" })).toBeNull();
  });

  it("same-workspace roundtrip", async () => {
    await saveConversationContext({ workspaceObjectId: WS_A, userId: "uA", conversationId: "c9", context: { state: "EXECUTION" } });
    expect(await getConversationContext({ workspaceObjectId: WS_A, conversationId: "c9" })).toEqual({ state: "EXECUTION" });
  });

  it("genuine miss → null (fall back to client context)", async () => {
    expect(await getConversationContext({ workspaceObjectId: WS_A, conversationId: "nope" })).toBeNull();
  });

  it("malformed id / missing tenant → null, NEVER a query", async () => {
    expect(await getConversationContext({ workspaceObjectId: WS_A, conversationId: { $ne: null } as any })).toBeNull();
    expect(await getConversationContext({ workspaceObjectId: "", conversationId: "c" })).toBeNull();
    expect(M.findOne).not.toHaveBeenCalled();
  });

  it("read failure → read_failed metric + null (turn survives)", async () => {
    M.findOne.mockImplementation(() => ({ lean: async () => { throw new Error("mongo blip"); } }));
    const r = await getConversationContext({ workspaceObjectId: WS_A, conversationId: "c" });
    expect(r).toBeNull();
    expect(M.emit.mock.calls.map((c) => c[0].type)).toContain("pluto.memory.read_failed");
  });

  it("no live connection → null (graceful), no query", async () => {
    M.ready.value = 0;
    expect(await getConversationContext({ workspaceObjectId: WS_A, conversationId: "c" })).toBeNull();
    expect(M.findOne).not.toHaveBeenCalled();
  });
});

describe("saveConversationContext — upsert (Amendment P)", () => {
  it("write failure → write_failed metric, no throw", async () => {
    M.updateOne.mockImplementation(async () => { throw new Error("mongo down"); });
    await expect(saveConversationContext({ workspaceObjectId: WS_A, conversationId: "c", context: {} })).resolves.toBeUndefined();
    expect(M.emit.mock.calls.map((c) => c[0].type)).toContain("pluto.memory.write_failed");
  });

  it("concurrent double-save → exactly ONE doc for {workspaceId, conversationId}", async () => {
    await Promise.all([
      saveConversationContext({ workspaceObjectId: WS_A, userId: "uA", conversationId: "dup", context: { t: 1 } }),
      saveConversationContext({ workspaceObjectId: WS_A, userId: "uA", conversationId: "dup", context: { t: 2 } }),
    ]);
    expect(store.size).toBe(1);
  });

  it("$setOnInsert userId + createdAt (originator not overwritten by later turns)", async () => {
    await saveConversationContext({ workspaceObjectId: WS_A, userId: "originator", conversationId: "c", context: { a: 1 } });
    await saveConversationContext({ workspaceObjectId: WS_A, userId: "someone-else", conversationId: "c", context: { a: 2 } });
    const doc = store.get(key(WS_A, "c"));
    expect(doc.userId).toBe("originator"); // $setOnInsert — not clobbered
    expect(doc.context).toEqual({ a: 2 }); // context is $set every turn
  });
});
