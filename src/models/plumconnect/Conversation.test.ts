// PlumConnect Slice 0 — Conversation against a real collection
// (mongodb-memory-server): persist-and-read, the v1 support lifecycle enum,
// the verbatim referral payload, and the four declared indexes.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-conversation-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: Conversation, CONVERSATION_STATUSES, CONVERSATION_KINDS, BUSINESS_LINES, INTENT_SOURCES } = await import("./Conversation.js");
const { default: Contact } = await import("./Contact.js");

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Conversation.syncIndexes();
  await Contact.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Conversation.deleteMany({});
  await Contact.deleteMany({});
});

// A Meta CTWA referral, as delivered on the first inbound message.
const REFERRAL = {
  source_url: "https://fb.me/abc123",
  source_type: "ad",
  source_id: "120212345678901234",
  headline: "Bali from ₹49,999",
  body: "7 nights, flights included",
  media_type: "image",
  ctwa_clid: "AfeXYZ...",
};

describe("PlumConnectConversation", () => {
  it("mounts on its own collection, apart from the internal-chat Conversation model", () => {
    expect(Conversation.collection.name).toBe("plumconnectconversations");
    expect(mongoose.modelNames()).toContain("PlumConnectConversation");
  });

  it("persists with defaults and reads back as an OPEN, unknown-kind thread", async () => {
    const contact = await Contact.create({ phone: "919876543210" });
    const created = await Conversation.create({ contactId: contact._id, channelAccountId: "1265026903369191" });
    const row = await Conversation.findById(created._id).lean();

    expect(String(row!.contactId)).toBe(String(contact._id));
    expect(row!.channel).toBe("whatsapp");
    expect(row!.channelAccountId).toBe("1265026903369191");
    expect(row!.kind).toBe("unknown");
    expect(row!.status).toBe("OPEN");
    expect(row!.assignedTo).toBeNull();
    expect(row!.leadId).toBeNull();
    expect(row!.referralRaw).toBeNull();
    expect(row!.bot).toEqual({ active: false, step: "", retries: 0, stoppedBy: null, stoppedAt: null });
    expect(row!.lastInboundAt).toBeNull();
    expect(row!.lastOutboundAt).toBeNull();
    expect(row!.lastMessageAt).toBeNull();
    expect(row!.resolvedAt).toBeNull();
    expect(row!.resolvedBy).toBeNull();
    // HOUSE surface — no tenant column
    expect(row).not.toHaveProperty("workspaceId");
  });

  it("keeps the CTWA referral payload verbatim", async () => {
    const contact = await Contact.create({ phone: "919876543211" });
    const created = await Conversation.create({
      contactId: contact._id,
      kind: "lead",
      referralRaw: REFERRAL,
    });
    const row = await Conversation.findById(created._id).lean();
    expect(row!.referralRaw).toEqual(REFERRAL);
    expect(row!.kind).toBe("lead");
  });

  it("walks the v1 support lifecycle OPEN → PENDING → RESOLVED and rejects anything else", async () => {
    const contact = await Contact.create({ phone: "919876543212" });
    const agent = new mongoose.Types.ObjectId();
    const created = await Conversation.create({ contactId: contact._id, kind: "support" });

    await Conversation.updateOne({ _id: created._id }, { $set: { status: "PENDING", assignedTo: agent } });
    expect((await Conversation.findById(created._id).lean())!.status).toBe("PENDING");

    const resolvedAt = new Date();
    await Conversation.updateOne(
      { _id: created._id },
      { $set: { status: "RESOLVED", resolvedAt, resolvedBy: agent } },
    );
    const row = await Conversation.findById(created._id).lean();
    expect(row!.status).toBe("RESOLVED");
    expect(row!.resolvedAt!.getTime()).toBe(resolvedAt.getTime());
    expect(String(row!.resolvedBy)).toBe(String(agent));

    await expect(
      Conversation.create({ contactId: contact._id, status: "CLOSED" as any }),
    ).rejects.toThrow(/status/);
    expect(CONVERSATION_STATUSES).toEqual(["OPEN", "PENDING", "RESOLVED"]);
    expect(CONVERSATION_KINDS).toEqual(["support", "lead", "expense", "arrival", "trip", "unknown"]);
  });

  it("records bot state including the human-takeover stop reason", async () => {
    const contact = await Contact.create({ phone: "919876543213" });
    const created = await Conversation.create({
      contactId: contact._id,
      kind: "lead",
      bot: { active: true, step: "ask_destination" },
    });
    const stoppedAt = new Date();
    await Conversation.updateOne(
      { _id: created._id },
      { $set: { "bot.active": false, "bot.stoppedBy": "human", "bot.stoppedAt": stoppedAt } },
    );
    const row = await Conversation.findById(created._id).lean();
    expect(row!.bot).toEqual({ active: false, step: "ask_destination", retries: 0, stoppedBy: "human", stoppedAt });

    await expect(
      Conversation.create({ contactId: contact._id, bot: { active: false, step: "", stoppedBy: "agent" as any } }),
    ).rejects.toThrow(/stoppedBy/);
  });

  it("contactId is required", async () => {
    await expect(Conversation.create({ kind: "support" })).rejects.toThrow(/contactId/);
  });

  it("declares the four indexes the dispatcher and inbox will read by", async () => {
    const indexes = await Conversation.collection.indexes();
    const has = (k: Record<string, number>) => indexes.some((i) => JSON.stringify(i.key) === JSON.stringify(k));
    expect(has({ contactId: 1, status: 1 })).toBe(true);
    expect(has({ status: 1, lastMessageAt: -1 })).toBe(true);
    expect(has({ assignedTo: 1, status: 1 })).toBe(true);
    const leadIdx = indexes.find((i) => JSON.stringify(i.key) === JSON.stringify({ leadId: 1 }));
    expect(leadIdx?.sparse).toBe(true);
  });

  // Slice 5 — business line + intent are additive and default to "unset".
  describe("Slice 5 fields", () => {
    it("default to null / '' so every pre-Slice-5 row reads as unrouted", async () => {
      const contact = await Contact.create({ phone: "919876543210" });
      const created = await Conversation.create({ contactId: contact._id, channelAccountId: "1265026903369191" });
      const row = await Conversation.findById(created._id).lean();
      expect(row).toMatchObject({ businessLine: null, intent: "", intentSource: null, intentConfidence: null, intentMenuSentAt: null });
    });

    it("accept the three lines and three sources, reject anything else", async () => {
      const contact = await Contact.create({ phone: "919876543211" });
      const row = await Conversation.create({ contactId: contact._id, businessLine: "helloviza", intentSource: "menu", intentConfidence: 1, intent: "menu:helloviza" });
      expect((await Conversation.findById(row._id).lean())).toMatchObject({ businessLine: "helloviza", intentSource: "menu", intentConfidence: 1 });
      expect(BUSINESS_LINES).toEqual(["plumtrips", "helloviza", "concierge"]);
      expect(INTENT_SOURCES).toEqual(["keyword", "menu", "campaign_map"]);
      await expect(Conversation.create({ contactId: contact._id, businessLine: "sales" })).rejects.toThrow(/businessLine/);
      await expect(Conversation.create({ contactId: contact._id, intentSource: "llm" })).rejects.toThrow(/intentSource/);
    });

    it("adds ONE index, {businessLine:1} sparse — nothing on intent/source/confidence", async () => {
      const indexes = await Conversation.collection.indexes();
      const bl = indexes.find((i) => JSON.stringify(i.key) === JSON.stringify({ businessLine: 1 }));
      expect(bl?.sparse).toBe(true);
      const keys = indexes.map((i) => Object.keys(i.key).join(","));
      expect(keys.some((k) => /intent/.test(k))).toBe(false);
    });
  });
});
