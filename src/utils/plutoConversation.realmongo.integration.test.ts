// Capstone smoke — tenant-scoped memory against a REAL mongod (mongodb-memory-
// server): real indexes, real unique-index upsert race, real claim race,
// cross-tenant isolation, and restart durability (the property the Map lacked).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import PlutoConversation from "../models/PlutoConversation.js";
import {
  saveConversationContext,
  getConversationContext,
  claimHandoffDelivery,
  releaseHandoffDelivery,
} from "./plutoMemory.js";

let mongod: MongoMemoryServer;
let uri = "";
const WS_A = new mongoose.Types.ObjectId();
const WS_B = new mongoose.Types.ObjectId();
const USER = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  uri = mongod.getUri();
  await mongoose.connect(uri);
  await PlutoConversation.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => { await PlutoConversation.deleteMany({}); });

describe("PlutoConversation — real indexes", () => {
  it("has the unique {workspaceId, conversationId} + TTL(lastTurnAt) indexes with correct options", async () => {
    const idx = await PlutoConversation.collection.indexes();
    const unique = idx.find((i: any) => i.key?.workspaceId === 1 && i.key?.conversationId === 1);
    expect(unique?.unique).toBe(true);
    const ttl = idx.find((i: any) => i.key?.lastTurnAt === 1);
    expect(ttl?.expireAfterSeconds).toBe(30 * 24 * 60 * 60); // default PLUTO_CONVERSATION_TTL_DAYS
  });
});

describe("upsert race on the real unique index", () => {
  it("10 concurrent saves for a cold {ws, conversationId} → exactly ONE doc, no E11000 escapes", async () => {
    await expect(
      Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          saveConversationContext({ workspaceObjectId: WS_A, userId: USER, conversationId: "race-1", context: { n: i } }),
        ),
      ),
    ).resolves.toBeDefined(); // none of the 10 rejected the caller

    expect(await PlutoConversation.countDocuments({ workspaceId: WS_A, conversationId: "race-1" })).toBe(1);
    // The losing racers retried-as-update, so context reflects a real write.
    const ctx = await getConversationContext({ workspaceObjectId: WS_A, conversationId: "race-1" });
    expect(ctx).toHaveProperty("n");
  });
});

describe("claim race on the real store", () => {
  it("10 concurrent claims for one conversation → exactly ONE true; release re-arms", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimHandoffDelivery({ workspaceObjectId: WS_A, userId: USER, conversationId: "claim-1" })),
    );
    expect(results.filter(Boolean)).toHaveLength(1); // exactly one winner

    // After release, the next claim succeeds again (retry path live).
    await releaseHandoffDelivery({ workspaceObjectId: WS_A, conversationId: "claim-1" });
    expect(await claimHandoffDelivery({ workspaceObjectId: WS_A, conversationId: "claim-1" })).toBe(true);
  });
});

describe("cross-tenant isolation on real mongo", () => {
  it("workspace B cannot read workspace A's conversationId (→ null, like a miss)", async () => {
    await saveConversationContext({ workspaceObjectId: WS_A, userId: USER, conversationId: "shared-id", context: { summary: "A only" } });
    expect(await getConversationContext({ workspaceObjectId: WS_A, conversationId: "shared-id" })).toEqual({ summary: "A only" });
    expect(await getConversationContext({ workspaceObjectId: WS_B, conversationId: "shared-id" })).toBeNull();
  });
});

describe("restart durability", () => {
  it("save → disconnect → reconnect → read returns the context intact", async () => {
    await saveConversationContext({ workspaceObjectId: WS_A, userId: USER, conversationId: "persist-1", context: { summary: "survives a restart" } });
    await mongoose.disconnect();
    await mongoose.connect(uri); // same mongod — data persists
    const ctx = await getConversationContext({ workspaceObjectId: WS_A, conversationId: "persist-1" });
    expect(ctx).toEqual({ summary: "survives a restart" });
  });
});
