// PlumConnect Slice 0 — Message against a real collection (mongodb-memory-server):
// persist-and-read in both directions, the wamid unique+SPARSE index (one
// row per channel message, but system rows and notes carry no wamid and must
// never collide), and the thread index.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-message-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: Message, MESSAGE_TYPES } = await import("./Message.js");
const { default: Conversation } = await import("./Conversation.js");
const { default: Contact } = await import("./Contact.js");

let mongod: MongoMemoryServer;
let conversationId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Message.syncIndexes();
  await Conversation.syncIndexes();
  await Contact.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Message.deleteMany({});
  await Conversation.deleteMany({});
  await Contact.deleteMany({});
  const contact = await Contact.create({ phone: "919876543210" });
  const conv = await Conversation.create({ contactId: contact._id, kind: "support" });
  conversationId = conv._id as mongoose.Types.ObjectId;
});

describe("PlumConnectMessage", () => {
  it("mounts on its own collection, apart from the internal-chat Message model", () => {
    expect(Message.collection.name).toBe("plumconnectmessages");
    expect(mongoose.modelNames()).toContain("PlumConnectMessage");
  });

  it("persists an INBOUND text with its wamid and reads it back", async () => {
    const created = await Message.create({
      conversationId,
      direction: "INBOUND",
      externalId: "wamid.HBgLOTE5ODc2NTQzMjEwFQIAEhggQUJD",
      type: "text",
      text: "hi, saw your Bali ad",
      payload: { referral: { source_type: "ad" } },
    });
    const row = await Message.findById(created._id).lean();

    expect(row!.direction).toBe("INBOUND");
    expect(row!.channel).toBe("whatsapp");
    expect(row!.externalId).toBe("wamid.HBgLOTE5ODc2NTQzMjEwFQIAEhggQUJD");
    expect(row!.type).toBe("text");
    expect(row!.text).toBe("hi, saw your Bali ad");
    expect(row!.payload).toEqual({ referral: { source_type: "ad" } });
    expect(row!.authorUserId).toBeNull();
    expect(row!.visibleToContact).toBe(true);
    expect(row!.deliveryStatus).toBeNull();
    expect(row!.sentAt).toBeNull();
  });

  it("persists an OUTBOUND human reply with author and delivery status", async () => {
    const agent = new mongoose.Types.ObjectId();
    const sentAt = new Date();
    const created = await Message.create({
      conversationId,
      direction: "OUTBOUND",
      externalId: "wamid.OUT1",
      type: "text",
      text: "Happy to help — which dates?",
      authorUserId: agent,
      deliveryStatus: "sent",
      sentAt,
    });
    await Message.updateOne({ _id: created._id }, { $set: { deliveryStatus: "read" } });

    const row = await Message.findById(created._id).lean();
    expect(String(row!.authorUserId)).toBe(String(agent));
    expect(row!.deliveryStatus).toBe("read");
    expect(row!.sentAt!.getTime()).toBe(sentAt.getTime());
  });

  it("externalId is unique — the same wamid cannot be inserted twice", async () => {
    await Message.create({ conversationId, direction: "INBOUND", externalId: "wamid.DUP", type: "text", text: "a" });
    await expect(
      Message.create({ conversationId, direction: "INBOUND", externalId: "wamid.DUP", type: "text", text: "b" }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await Message.countDocuments({ externalId: "wamid.DUP" })).toBe(1);
  });

  it("externalId is sparse — many system rows and notes with no wamid coexist", async () => {
    await Message.create({ conversationId, direction: "OUTBOUND", type: "system", text: "Linked to employee" });
    await Message.create({ conversationId, direction: "OUTBOUND", type: "system", text: "Bot started" });
    await Message.create({
      conversationId,
      direction: "OUTBOUND",
      type: "note",
      text: "customer sounded keen",
      visibleToContact: false,
    });
    const rows = await Message.find({ conversationId }).sort({ createdAt: 1 }).lean();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).not.toHaveProperty("externalId");
    expect(rows[2].visibleToContact).toBe(false);
  });

  it("requires conversationId, direction and type, and rejects values outside the enums", async () => {
    await expect(Message.create({ direction: "INBOUND", type: "text" })).rejects.toThrow(/conversationId/);
    await expect(Message.create({ conversationId, type: "text" })).rejects.toThrow(/direction/);
    await expect(Message.create({ conversationId, direction: "INBOUND" })).rejects.toThrow(/type/);
    await expect(
      Message.create({ conversationId, direction: "SIDEWAYS" as any, type: "text" }),
    ).rejects.toThrow(/direction/);
    await expect(
      Message.create({ conversationId, direction: "INBOUND", type: "hologram" as any }),
    ).rejects.toThrow(/type/);
    await expect(
      Message.create({ conversationId, direction: "OUTBOUND", type: "text", deliveryStatus: "bounced" as any }),
    ).rejects.toThrow(/deliveryStatus/);
    expect(MESSAGE_TYPES).toEqual([
      "text", "interactive", "image", "document", "template", "button", "system", "note",
      "audio", "video", "sticker", "location", "contacts", "reaction", "unsupported",
    ]);
  });

  it("declares the unique+sparse externalId index and the thread index", async () => {
    const indexes = await Message.collection.indexes();
    const byKey = (k: Record<string, number>) =>
      indexes.find((i) => JSON.stringify(i.key) === JSON.stringify(k));
    const ext = byKey({ externalId: 1 });
    expect(ext?.unique).toBe(true);
    expect(ext?.sparse).toBe(true);
    expect(byKey({ conversationId: 1, createdAt: 1 })).toBeTruthy();
  });
});
