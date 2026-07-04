// Capstone Step 3 — server-side handoff dedup: the atomic claim, incl. two
// concurrent guard calls resolving to exactly ONE delivery.
import { describe, it, expect, vi, beforeEach } from "vitest";

const M = vi.hoisted(() => ({ ready: { value: 1 }, foau: vi.fn(), updateOne: vi.fn(), emit: vi.fn() }));

vi.mock("mongoose", () => ({ default: { connection: { get readyState() { return M.ready.value; } } } }));
vi.mock("../models/PlutoConversation.js", () => ({ default: { findOneAndUpdate: M.foau, updateOne: M.updateOne } }));
vi.mock("./plutoMetricsSink.js", () => ({ emitMetric: M.emit }));

import { claimHandoffDelivery, releaseHandoffDelivery } from "./plutoMemory.js";

const WS = "aaaaaaaaaaaaaaaaaaaaaaaa";
const store = new Map<string, any>();
const key = (ws: any, c: any) => `${ws}|${c}`;

beforeEach(() => {
  store.clear();
  M.ready.value = 1;
  M.foau.mockReset();
  M.updateOne.mockReset();
  M.emit.mockReset();
  // Atomic claim + unique {workspaceId, conversationId} index simulation.
  M.foau.mockImplementation(async (filter: any, update: any) => {
    const k = key(filter.workspaceId, filter.conversationId);
    const doc = store.get(k);
    if (doc) {
      if (doc.handoffDelivered === false) { doc.handoffDelivered = true; return doc; }
      const e: any = new Error("E11000 duplicate key"); e.code = 11000; throw e; // filter miss → upsert collides
    }
    const created = { workspaceId: filter.workspaceId, conversationId: filter.conversationId, handoffDelivered: true, ...(update.$setOnInsert || {}) };
    store.set(k, created);
    return created;
  });
  M.updateOne.mockImplementation(async (filter: any, update: any) => {
    const d = store.get(key(filter.workspaceId, filter.conversationId));
    if (d) Object.assign(d, update.$set || {});
    return { modifiedCount: d ? 1 : 0 };
  });
});

describe("claimHandoffDelivery", () => {
  it("first claim wins (deliver), second on the same conversation loses (skip)", async () => {
    expect(await claimHandoffDelivery({ workspaceObjectId: WS, conversationId: "c1" })).toBe(true);
    expect(await claimHandoffDelivery({ workspaceObjectId: WS, conversationId: "c1" })).toBe(false);
  });

  it("TWO concurrent guard calls → exactly ONE delivery", async () => {
    const [a, b] = await Promise.all([
      claimHandoffDelivery({ workspaceObjectId: WS, conversationId: "c2" }),
      claimHandoffDelivery({ workspaceObjectId: WS, conversationId: "c2" }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1); // one winner, one loser
  });

  it("release re-arms a claim (retry after a failed delivery)", async () => {
    expect(await claimHandoffDelivery({ workspaceObjectId: WS, conversationId: "c3" })).toBe(true);
    await releaseHandoffDelivery({ workspaceObjectId: WS, conversationId: "c3" });
    expect(await claimHandoffDelivery({ workspaceObjectId: WS, conversationId: "c3" })).toBe(true); // deliverable again
  });

  it("malformed id → false (never claims); no store → deliver best-effort", async () => {
    expect(await claimHandoffDelivery({ workspaceObjectId: WS, conversationId: { $ne: null } as any })).toBe(false);
    M.ready.value = 0;
    expect(await claimHandoffDelivery({ workspaceObjectId: WS, conversationId: "c4" })).toBe(true);
  });
});
