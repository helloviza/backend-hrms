// PlumConnect sendAndPersist (3c, re-based on the Slice-4a outbound wrapper).
// The REAL whatsappCloud senders run (zero mocks on that module); axios gets
// a fake ADAPTER so the full request pipeline executes and every Graph call
// is recorded; the senders return Meta's wamid directly. Persistence is on
// mongodb-memory-server and flag-gated.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import axios from "axios";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-send-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.WA_ACCESS_TOKEN = "test-token";
process.env.WA_PHONE_NUMBER_ID = "1265026903369191";
process.env.PLUMCONNECT_ENABLED = "true"; // persistence is flag-gated since Slice 4a

const { sendAndPersist } = await import("./send.js");
const { default: Message } = await import("../../models/plumconnect/Message.js");
const { default: Conversation } = await import("../../models/plumconnect/Conversation.js");
const { default: Contact } = await import("../../models/plumconnect/Contact.js");

/* ── fake Graph ─────────────────────────────────────────────────────── */
type Graph = { url: string; body: any };
const graph: Graph[] = [];
let wamidSeq = 0;
let failNext = false;
axios.defaults.adapter = async (config) => {
  const body = config.data ? JSON.parse(config.data) : null;
  graph.push({ url: String(config.url), body });
  if (failNext) {
    failNext = false;
    const err: any = new Error("Request failed with status code 400");
    err.isAxiosError = true;
    err.config = config;
    err.response = { status: 400, data: { error: { message: "(#131030) Recipient not in allowed list", code: 131030 } }, headers: {}, config };
    throw err;
  }
  return { data: { messaging_product: "whatsapp", contacts: [{ wa_id: body?.to }], messages: [{ id: `wamid.OUT${++wamidSeq}` }] }, status: 200, statusText: "OK", headers: {}, config };
};

let mongod: MongoMemoryServer;
let conversationId: mongoose.Types.ObjectId;
const TO = "919876543210";

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Message.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  graph.length = 0;
  failNext = false;
  vi.restoreAllMocks();
  await Promise.all([Message.deleteMany({}), Conversation.deleteMany({}), Contact.deleteMany({})]);
  const contact = await Contact.create({ phone: TO });
  const conv = await Conversation.create({ contactId: contact._id, kind: "lead" });
  conversationId = conv._id as mongoose.Types.ObjectId;
});

describe("sendAndPersist", () => {
  it("text: calls the real sender once, captures the Graph wamid, writes exactly one OUTBOUND Message", async () => {
    const r = await sendAndPersist({ conversationId, to: TO, text: "hello there", payload: { bot: "ask_name" } });
    expect(r).toMatchObject({ sent: true, wamid: expect.stringMatching(/^wamid\.OUT\d+$/), persistFailed: false });
    expect(r.messageId).toBeTruthy();

    expect(graph).toHaveLength(1);
    expect(graph[0].url).toBe("https://graph.facebook.com/v21.0/1265026903369191/messages");
    expect(graph[0].body).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: TO, type: "text", text: { preview_url: false, body: "hello there" } });

    const rows = await Message.find({ conversationId }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: "OUTBOUND", channel: "whatsapp", externalId: r.wamid, type: "text", text: "hello there", authorUserId: null, visibleToContact: true, deliveryStatus: "sent" });
    expect((rows[0].payload as any).bot).toBe("ask_name");
    expect(rows[0].sentAt).toBeInstanceOf(Date);

    const conv = await Conversation.findById(conversationId).lean();
    expect(conv!.lastOutboundAt).toBeInstanceOf(Date);
    expect(conv!.lastMessageAt).toBeInstanceOf(Date);
  });

  it("buttons: the real sendButtonMessage payload, Message type interactive with the button ids", async () => {
    const r = await sendAndPersist({ conversationId, to: TO, text: "Link it?", buttons: [{ id: "pc_bind_yes", title: "Yes, link it" }, { id: "pc_bind_no", title: "No" }] });
    expect(r.sent).toBe(true);
    expect(graph[0].body.type).toBe("interactive");
    expect(graph[0].body.interactive.action.buttons.map((b: any) => b.reply.id)).toEqual(["pc_bind_yes", "pc_bind_no"]);
    const row = await Message.findOne({ conversationId }).lean();
    expect(row!.type).toBe("interactive");
    expect((row!.payload as any).buttons).toEqual(["pc_bind_yes", "pc_bind_no"]);
  });

  it("never changes what is sent: the Graph body carries exactly the text given", async () => {
    await sendAndPersist({ conversationId, to: TO, text: "  exact text  " });
    expect(graph[0].body.text.body).toBe("  exact text  ");
  });

  it("a forced Message-write failure: the send still happened ONCE, no throw, persistFailed reported", async () => {
    const createSpy = vi.spyOn(Message, "create").mockRejectedValueOnce(new Error("disk full"));
    const r = await sendAndPersist({ conversationId, to: TO, text: "still sent" });
    expect(r).toEqual({ sent: true, wamid: expect.stringMatching(/^wamid\.OUT\d+$/), messageId: null, persistFailed: true });
    expect(graph).toHaveLength(1); // exactly one Graph call — no retry, no double send
    expect(await Message.countDocuments({})).toBe(0);
    createSpy.mockRestore();
  });

  it("Meta rejects the send: the sender swallows, no wamid → sent:false, nothing persisted", async () => {
    failNext = true;
    const r = await sendAndPersist({ conversationId, to: TO, text: "will fail" });
    // sendTextMessage swallows the 400 (its own behaviour); the failed call is
    // the only Graph call and nothing is written.
    expect(r).toEqual({ sent: false, wamid: null, messageId: null, persistFailed: false });
    expect(graph).toHaveLength(1);
    expect(await Message.countDocuments({})).toBe(0);
  });

  it("FLAG OFF: the send still goes out exactly once and nothing is persisted (Slice 4a gating)", async () => {
    delete process.env.PLUMCONNECT_ENABLED;
    try {
      const r = await sendAndPersist({ conversationId, to: TO, text: "flag off" });
      expect(graph).toHaveLength(1);
      expect(graph[0].body.text.body).toBe("flag off");
      expect(r).toEqual({ sent: true, wamid: expect.stringMatching(/^wamid\.OUT\d+$/), messageId: null, persistFailed: false });
      expect(await Message.countDocuments({})).toBe(0);
    } finally {
      process.env.PLUMCONNECT_ENABLED = "true";
    }
  });

  it("two concurrent sends each get their own wamid (context isolation)", async () => {
    const [a, b] = await Promise.all([
      sendAndPersist({ conversationId, to: TO, text: "A" }),
      sendAndPersist({ conversationId, to: TO, text: "B" }),
    ]);
    expect(a.sent && b.sent).toBe(true);
    expect(a.wamid).not.toBe(b.wamid);
    const rows = await Message.find({ conversationId }).lean();
    expect(rows.map((r) => r.externalId).sort()).toEqual([a.wamid, b.wamid].sort());
    expect(rows.find((r) => r.text === "A")!.externalId).toBe(a.wamid);
  });
});
