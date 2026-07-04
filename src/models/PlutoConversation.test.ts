// Capstone Step 1 — PlutoConversation model shape + unique + TTL indexes.
import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import PlutoConversation from "./PlutoConversation.js";

describe("PlutoConversation model", () => {
  it("has the PRD-key shape with sane defaults", () => {
    const doc: any = new PlutoConversation({ workspaceId: new mongoose.Types.ObjectId(), conversationId: "conv-1", userId: new mongoose.Types.ObjectId() });
    expect(doc.conversationId).toBe("conv-1");
    expect(doc.handoffDelivered).toBe(false); // dedup starts un-delivered
    expect(doc.context).toEqual({});
    expect(doc.lastTurnAt).toBeInstanceOf(Date);
    expect(doc.createdAt).toBeInstanceOf(Date);
  });

  it("requires workspaceId + conversationId", () => {
    const err = new PlutoConversation({}).validateSync();
    expect(err?.errors?.workspaceId).toBeTruthy();
    expect(err?.errors?.conversationId).toBeTruthy();
  });

  it("has a UNIQUE compound index on {workspaceId, conversationId}", () => {
    const idx = PlutoConversation.schema.indexes().find(
      ([keys]: any) => keys.workspaceId === 1 && keys.conversationId === 1,
    );
    expect(idx).toBeDefined();
    expect((idx as any)[1].unique).toBe(true);
  });

  it("has a TTL index on lastTurnAt (env-overridable, default 30d)", () => {
    const idx = PlutoConversation.schema.indexes().find(
      ([keys]: any) => keys.lastTurnAt === 1,
    );
    expect(idx).toBeDefined();
    expect((idx as any)[1].expireAfterSeconds).toBe(30 * 24 * 60 * 60);
  });
});
