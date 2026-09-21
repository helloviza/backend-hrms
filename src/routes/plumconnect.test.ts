// PlumConnect Slice 4b — the inbox API. Real router + real
// requirePlumConnectAccess over real UserPermission rows on
// mongodb-memory-server; the auth middleware is stubbed to pick the caller
// from an `x-test-user` header so several users can act in one test. The
// reply path runs the real senders over a fake Graph adapter.
//
// The security property is pinned the way CRM's cross-user tests pin it: a
// WRITE/OWN rep can list, open and act ONLY on conversations assigned to
// them; anyone else's → 403; a FULL/ALL manager sees and acts on all;
// NONE → 403 everywhere; flag OFF → 404 everywhere.
//
// Slice 7: the grant is PER LINE (plumtrips / helloviza / concierge /
// support). The 4b users below hold the same grant on all four lines so
// the 4b cases keep their meaning; the "per-line isolation" suite adds
// users who hold one line and not another.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import axios from "axios";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-inbox-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.WA_ACCESS_TOKEN = "test-token";
process.env.WA_PHONE_NUMBER_ID = "1265026903369191";
process.env.PLUMCONNECT_ENABLED = "true";

const IDS = {
  admin: new mongoose.Types.ObjectId(),
  manager: new mongoose.Types.ObjectId(), // FULL / ALL by grant
  repA: new mongoose.Types.ObjectId(), // WRITE / OWN
  repB: new mongoose.Types.ObjectId(), // WRITE / OWN
  reader: new mongoose.Types.ObjectId(), // READ / ALL
  nobody: new mongoose.Types.ObjectId(), // no row → NONE
  leadsOnly: new mongoose.Types.ObjectId(), // leads WRITE, plumconnect untouched → NONE
  // Slice 7 — per-line users
  vizaRep: new mongoose.Types.ObjectId(), // helloviza WRITE/OWN, everything else NONE
  corpLead: new mongoose.Types.ObjectId(), // plumtrips FULL/ALL, everything else NONE
  supportDesk: new mongoose.Types.ObjectId(), // support WRITE/ALL, everything else NONE
  noneAll: new mongoose.Types.ObjectId(), // an explicit NONE/NONE on all four lines
  vizaAdmin: new mongoose.Types.ObjectId(), // helloviza FULL/ALL + support READ/ALL; plumtrips / concierge NONE
};
const ROLES: Record<string, string[]> = { [String(IDS.admin)]: ["ADMIN"] };

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = String(req.headers["x-test-user"] || "");
    if (!id) return res.status(401).json({ error: "Unauthorized" });
    req.user = { id, sub: id, roles: ROLES[id] || ["EMPLOYEE"], email: `${id}@x.test`, name: "T" };
    next();
  },
  default: (_req: any, _res: any, next: any) => next(),
}));

const { default: router } = await import("./plumconnect.js");
const { requireAuth } = await import("../middleware/auth.js");
const { requireLeadsAccess } = await import("./leads.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { LEVEL_TEMPLATES } = await import("../config/levelTemplates.js");
const { default: User } = await import("../models/User.js");
const { default: Contact } = await import("../models/plumconnect/Contact.js");
const { default: Conversation } = await import("../models/plumconnect/Conversation.js");
const { default: Message } = await import("../models/plumconnect/Message.js");
const LINE_KEYS = ["plumconnectPlumtrips", "plumconnectHelloviza", "plumconnectConcierge", "plumconnectSupport"] as const;

const app = express();
app.use(express.json());
app.use("/api/plumconnect", requireAuth as any, router);
// A second mount to prove other modules' gates are untouched: leads' own gate.
app.get("/api/leads-probe", requireAuth as any, requireLeadsAccess as any, (req: any, res) => res.json({ access: req.leadsAccess, scope: req.leadsScope }));

/* ── fake Graph ─────────────────────────────────────────────────────── */
const graph: any[] = [];
let wamidSeq = 0;
axios.defaults.adapter = async (config) => {
  graph.push(JSON.parse(config.data));
  return { data: { messages: [{ id: `wamid.AGENT${++wamidSeq}` }] }, status: 200, statusText: "OK", headers: {}, config };
};

const as = (id: mongoose.Types.ObjectId) => ({ "x-test-user": String(id) });
const H = 3600_000;
let mongod: MongoMemoryServer;
let convA: any, convB: any, convFree: any, convOld: any;
let contactA: any;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Contact.syncIndexes(), Conversation.syncIndexes(), Message.syncIndexes()]);
  const ws = new mongoose.Types.ObjectId();
  for (const [k, id] of Object.entries(IDS)) {
    await User.collection.insertOne({ _id: id, name: `User ${k}`, email: `${k}@x.test`, roles: ROLES[String(id)] || ["EMPLOYEE"], passwordHash: "x", workspaceId: ws, status: "ACTIVE" } as any);
  }
  // `lines` = the same grant on all four PlumConnect keys (the 4b shape);
  // `extra` = explicit per-key values (Slice 7).
  const grant = (userId: mongoose.Types.ObjectId, lines: any, extra: any = {}) =>
    UserPermission.create({
      userId: String(userId), email: `${userId}@x.test`, workspaceId: String(ws), universe: "STAFF", source: "manual", level: { code: "L3", name: "Exec", designation: "x" }, status: "active", tier: 1, grantedModules: [], roleType: "EMPLOYEE", grantedBy: "test", grantedAt: new Date(),
      modules: { ...(lines ? { plumconnectPlumtrips: lines, plumconnectHelloviza: lines, plumconnectConcierge: lines, plumconnectSupport: lines } : {}), ...extra },
    } as any);
  await grant(IDS.manager, { access: "FULL", scope: "ALL" });
  await grant(IDS.repA, { access: "WRITE", scope: "OWN" });
  await grant(IDS.repB, { access: "WRITE", scope: "OWN" });
  await grant(IDS.reader, { access: "READ", scope: "ALL" });
  await grant(IDS.leadsOnly, undefined as any, { leads: { access: "WRITE", scope: "OWN" } });
  await grant(IDS.vizaRep, undefined as any, { plumconnectHelloviza: { access: "WRITE", scope: "OWN" }, leads: { access: "READ", scope: "OWN" } });
  await grant(IDS.corpLead, undefined as any, { plumconnectPlumtrips: { access: "FULL", scope: "ALL" } });
  await grant(IDS.supportDesk, undefined as any, { plumconnectSupport: { access: "WRITE", scope: "ALL" } });
  await grant(IDS.noneAll, { access: "NONE", scope: "NONE" });
  await grant(IDS.vizaAdmin, undefined as any, { plumconnectHelloviza: { access: "FULL", scope: "ALL" }, plumconnectSupport: { access: "READ", scope: "ALL" } });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  graph.length = 0;
  process.env.PLUMCONNECT_ENABLED = "true";
  await Promise.all([Contact.deleteMany({}), Conversation.deleteMany({}), Message.deleteMany({})]);
  const now = new Date();
  contactA = await Contact.create({ phone: "919111111111", displayName: "Alpha" });
  const contactB = await Contact.create({ phone: "919222222222", displayName: "Bravo" });
  const contactF = await Contact.create({ phone: "919333333333", displayName: "Free" });
  const contactO = await Contact.create({ phone: "919444444444", displayName: "Old" });
  convA = await Conversation.create({ contactId: contactA._id, kind: "lead", status: "OPEN", assignedTo: IDS.repA, leadId: new mongoose.Types.ObjectId(), bot: { active: true, step: "ask_destination" }, lastInboundAt: now, lastMessageAt: now });
  convB = await Conversation.create({ contactId: contactB._id, kind: "support", status: "OPEN", assignedTo: IDS.repB, lastInboundAt: now, lastMessageAt: new Date(now.getTime() - H) });
  convFree = await Conversation.create({ contactId: contactF._id, kind: "support", status: "OPEN", assignedTo: null, lastInboundAt: now, lastMessageAt: new Date(now.getTime() - 2 * H) });
  convOld = await Conversation.create({ contactId: contactO._id, kind: "support", status: "OPEN", assignedTo: IDS.repA, lastInboundAt: new Date(now.getTime() - 30 * H), lastMessageAt: new Date(now.getTime() - 30 * H) });
  await Message.create({ conversationId: convA._id, direction: "INBOUND", type: "text", text: "hi from alpha", externalId: `wamid.in.${Math.random()}` });
});

afterEach(() => {
  process.env.PLUMCONNECT_ENABLED = "true";
});

const list = (who: mongoose.Types.ObjectId, q = "") => request(app).get(`/api/plumconnect/conversations${q}`).set(as(who));
const open = (who: mongoose.Types.ObjectId, id: any) => request(app).get(`/api/plumconnect/conversations/${id}`).set(as(who));
const act = (who: mongoose.Types.ObjectId, id: any, verb: string, body: any = {}) => request(app).post(`/api/plumconnect/conversations/${id}/${verb}`).set(as(who)).send(body);

/* ───────────────────────────── list payload (Slice 5 follow-through) ───────────────────────────── */

describe("list payload carries businessLine", () => {
  it("surfaces plumtrips / helloviza / concierge on lead threads, and null on a thread with no line (support)", async () => {
    await Conversation.updateOne({ _id: convA._id }, { $set: { businessLine: "concierge", intentSource: "campaign_map" } });
    const now = new Date();
    const cH = await Contact.create({ phone: "919555555555", displayName: "Viza" });
    const cP = await Contact.create({ phone: "919666666666", displayName: "Corp" });
    await Conversation.create({ contactId: cH._id, kind: "lead", status: "OPEN", assignedTo: null, businessLine: "helloviza", intentSource: "keyword", lastInboundAt: now, lastMessageAt: now });
    await Conversation.create({ contactId: cP._id, kind: "lead", status: "OPEN", assignedTo: null, businessLine: "plumtrips", intentSource: "menu", lastInboundAt: now, lastMessageAt: now });

    const r = await list(IDS.manager);
    expect(r.status).toBe(200);
    const byName = Object.fromEntries(r.body.conversations.map((c: any) => [c.contact.displayName, c]));
    expect(byName.Alpha).toMatchObject({ kind: "lead", businessLine: "concierge" });
    expect(byName.Viza).toMatchObject({ kind: "lead", businessLine: "helloviza" });
    expect(byName.Corp).toMatchObject({ kind: "lead", businessLine: "plumtrips" });
    // a support thread (pre-Slice-5 row shape: field absent) serialises as an explicit null, not undefined
    expect(byName.Bravo.kind).toBe("support");
    expect(byName.Bravo).toHaveProperty("businessLine", null);
    expect(new Set(r.body.conversations.map((c: any) => c.businessLine))).toEqual(new Set(["concierge", "helloviza", "plumtrips", null]));
    // every pre-existing field is still there (additive)
    for (const k of ["_id", "kind", "status", "assignedTo", "leadId", "bot", "lastInboundAt", "lastOutboundAt", "lastMessageAt", "resolvedAt", "resolvedBy", "createdAt", "contact"]) {
      expect(byName.Alpha).toHaveProperty(k);
    }
    // the same summary shape comes back from open()
    const o = await open(IDS.manager, convA._id);
    expect(o.body.conversation).toMatchObject({ businessLine: "concierge" });
  });
});

/* ───────────────────────────── scope isolation ───────────────────────────── */

describe("scope isolation (the security property)", () => {
  it("WRITE/OWN rep lists only conversations assigned to them; FULL/ALL manager and ADMIN list all", async () => {
    const a = await list(IDS.repA);
    expect(a.status).toBe(200);
    expect(a.body.lines.concierge).toEqual({ access: "WRITE", scope: "OWN" });
    expect(a.body.conversations.map((c: any) => String(c._id)).sort()).toEqual([String(convA._id), String(convOld._id)].sort());
    expect(a.body.conversations[0].contact).toMatchObject({ phone: "919111111111", displayName: "Alpha" });

    const m = await list(IDS.manager);
    expect(m.body.lines.support).toEqual({ access: "FULL", scope: "ALL" });
    expect(m.body.conversations).toHaveLength(4);
    // newest activity first
    expect(m.body.conversations.map((c: any) => String(c._id))).toEqual([convA, convB, convFree, convOld].map((c) => String(c._id)));

    const ad = await list(IDS.admin);
    expect(ad.body.lines).toEqual({ plumtrips: { access: "FULL", scope: "ALL" }, helloviza: { access: "FULL", scope: "ALL" }, concierge: { access: "FULL", scope: "ALL" }, support: { access: "FULL", scope: "ALL" } });
    expect(ad.body.conversations).toHaveLength(4);
  });

  it("filters: status, kind, unassigned — and 'unassigned' never widens OWN", async () => {
    expect((await list(IDS.manager, "?unassigned=true")).body.conversations.map((c: any) => String(c._id))).toEqual([String(convFree._id)]);
    expect((await list(IDS.repA, "?unassigned=true")).body.conversations).toHaveLength(0);
    expect((await list(IDS.manager, "?kind=lead")).body.conversations.map((c: any) => String(c._id))).toEqual([String(convA._id)]);
    await Conversation.updateOne({ _id: convB._id }, { $set: { status: "RESOLVED" } });
    expect((await list(IDS.manager, "?status=resolved")).body.conversations.map((c: any) => String(c._id))).toEqual([String(convB._id)]);
    expect((await list(IDS.manager, "?status=weird")).status).toBe(400);
  });

  it("opening: own → 200 with the thread; another rep's → 403; unassigned → 403 for OWN; missing → 404", async () => {
    const own = await open(IDS.repA, convA._id);
    expect(own.status).toBe(200);
    expect(own.body.conversation._id).toBe(String(convA._id));
    expect(own.body.messages).toHaveLength(1);
    expect(own.body.messages[0].text).toBe("hi from alpha");

    expect((await open(IDS.repA, convB._id)).status).toBe(403);
    expect((await open(IDS.repA, convFree._id)).status).toBe(403);
    expect((await open(IDS.repB, convA._id)).status).toBe(403);
    expect((await open(IDS.manager, convB._id)).status).toBe(200);
    expect((await open(IDS.repA, new mongoose.Types.ObjectId())).status).toBe(404);
    expect((await open(IDS.repA, "not-an-id")).status).toBe(404);
  });

  it("acting on another rep's conversation → 403 for every verb; the row is untouched", async () => {
    for (const verb of ["note", "reply", "resolve", "reopen"]) {
      const r = await act(IDS.repA, convB._id, verb, { text: "x" });
      expect(r.status, verb).toBe(403);
    }
    expect((await act(IDS.repA, convB._id, "assign")).status).toBe(403); // taking someone else's
    const b = await Conversation.findById(convB._id).lean();
    expect(String(b!.assignedTo)).toBe(String(IDS.repB));
    expect(b!.status).toBe("OPEN");
    expect(await Message.countDocuments({ conversationId: convB._id })).toBe(0);
    expect(graph).toHaveLength(0);
  });

  it("READ/ALL sees everything but cannot act; NONE (no row, or leads-only row) gets 403 on every endpoint", async () => {
    expect((await list(IDS.reader)).body.conversations).toHaveLength(4);
    expect((await open(IDS.reader, convB._id)).status).toBe(200);
    for (const verb of ["assign", "note", "reply", "resolve"]) expect((await act(IDS.reader, convB._id, verb, { text: "x" })).status, verb).toBe(403);

    for (const who of [IDS.nobody, IDS.leadsOnly]) {
      expect((await list(who)).status).toBe(403);
      expect((await open(who, convA._id)).status).toBe(403);
      expect((await act(who, convA._id, "reply", { text: "x" })).status).toBe(403);
    }
    // …while the leads-only user's OWN module is exactly as it was
    const probe = await request(app).get("/api/leads-probe").set(as(IDS.leadsOnly));
    expect(probe.body).toEqual({ access: "WRITE", scope: "OWN" });
    expect((await request(app).get("/api/leads-probe").set(as(IDS.nobody))).status).toBe(403);
  });

  it("unauthenticated → 401", async () => {
    expect((await request(app).get("/api/plumconnect/conversations")).status).toBe(401);
  });
});

/* ───────────────────────────── assign ───────────────────────────── */

describe("assign", () => {
  it("a WRITE/OWN rep can take an unassigned conversation; it becomes theirs, bot stops (human), a system note is written", async () => {
    await Conversation.updateOne({ _id: convFree._id }, { $set: { bot: { active: true, step: "ask_name" } } });
    const r = await act(IDS.repA, convFree._id, "assign");
    expect(r.status).toBe(200);
    expect(r.body.conversation.assignedTo).toBe(String(IDS.repA));
    const c = await Conversation.findById(convFree._id).lean();
    expect(String(c!.assignedTo)).toBe(String(IDS.repA));
    expect(c!.bot).toMatchObject({ active: false, stoppedBy: "human" });
    const note = await Message.findOne({ conversationId: convFree._id, type: "system" }).lean();
    expect(note!.text).toBe("Assigned to User repA");
    expect(note!.visibleToContact).toBe(false);
    expect(String(note!.authorUserId)).toBe(String(IDS.repA));
    // and now it is in their list
    expect((await list(IDS.repA)).body.conversations.map((x: any) => String(x._id))).toContain(String(convFree._id));
  });

  it("reassigning to someone else needs FULL: rep → 403; manager → ok; admin → ok", async () => {
    expect((await act(IDS.repA, convA._id, "assign", { userId: String(IDS.repB) })).status).toBe(403);
    const m = await act(IDS.manager, convA._id, "assign", { userId: String(IDS.repB) });
    expect(m.status).toBe(200);
    expect(String((await Conversation.findById(convA._id).lean())!.assignedTo)).toBe(String(IDS.repB));
    expect((await Conversation.findById(convA._id).lean())!.bot).toMatchObject({ active: false, stoppedBy: "human" });
    expect((await act(IDS.admin, convA._id, "assign", { userId: String(IDS.repA) })).status).toBe(200);
    expect((await act(IDS.manager, convA._id, "assign", { userId: String(new mongoose.Types.ObjectId()) })).status).toBe(400);
  });

  it("assigning a RESOLVED conversation reopens it", async () => {
    await Conversation.updateOne({ _id: convFree._id }, { $set: { status: "RESOLVED" } });
    await act(IDS.manager, convFree._id, "assign", { userId: String(IDS.repB) });
    expect((await Conversation.findById(convFree._id).lean())!.status).toBe("OPEN");
  });
});

/* ───────────────────────────── note / reply ───────────────────────────── */

describe("note", () => {
  it("writes a contact-invisible Message with the author; nothing is sent", async () => {
    const r = await act(IDS.repA, convA._id, "note", { text: "customer sounded keen" });
    expect(r.status).toBe(201);
    const note = await Message.findOne({ conversationId: convA._id, type: "note" }).lean();
    expect(note).toMatchObject({ direction: "OUTBOUND", text: "customer sounded keen", visibleToContact: false });
    expect(String(note!.authorUserId)).toBe(String(IDS.repA));
    expect(note).not.toHaveProperty("externalId");
    expect(graph).toHaveLength(0);
    expect((await Conversation.findById(convA._id).lean())!.bot.active).toBe(true); // a note is not a takeover
    expect((await act(IDS.repA, convA._id, "note", { text: "   " })).status).toBe(400);
  });
});

describe("reply", () => {
  it("sends through the outbound wrapper, persists exactly one OUTBOUND Message with the wamid and the agent, stops the bot (human), status → PENDING", async () => {
    const r = await act(IDS.repA, convA._id, "reply", { text: "Hi Alpha, Priya here from Plumtrips." });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ sent: true, wamid: "wamid.AGENT1", persistFailed: false });

    expect(graph).toHaveLength(1);
    expect(graph[0]).toMatchObject({ to: "919111111111", type: "text", text: { body: "Hi Alpha, Priya here from Plumtrips." } });

    const out = await Message.find({ conversationId: convA._id, direction: "OUTBOUND" }).lean();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ externalId: "wamid.AGENT1", type: "text", text: "Hi Alpha, Priya here from Plumtrips.", visibleToContact: true, deliveryStatus: "sent" });
    expect(String(out[0].authorUserId)).toBe(String(IDS.repA));
    expect((out[0].payload as any)).toMatchObject({ origin: "agent", agentReply: true });
    expect(r.body.message._id).toBe(String(out[0]._id));

    const c = await Conversation.findById(convA._id).lean();
    expect(c!.status).toBe("PENDING");
    expect(c!.bot).toMatchObject({ active: false, stoppedBy: "human" });
    expect(c!.lastOutboundAt).toBeInstanceOf(Date);
    // one conversation, no stray thread resolved from the phone
    expect(await Conversation.countDocuments({ contactId: contactA._id })).toBe(1);
  });

  it("outside the 24h window → 409 OUTSIDE_24H_WINDOW, nothing sent, nothing persisted", async () => {
    const r = await act(IDS.repA, convOld._id, "reply", { text: "still there?" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("OUTSIDE_24H_WINDOW");
    expect(graph).toHaveLength(0);
    expect(await Message.countDocuments({ conversationId: convOld._id })).toBe(0);
    expect((await Conversation.findById(convOld._id).lean())!.status).toBe("OPEN");
  });

  it("empty text → 400; a manager may reply on any conversation", async () => {
    expect((await act(IDS.repA, convA._id, "reply", { text: "" })).status).toBe(400);
    expect((await act(IDS.manager, convB._id, "reply", { text: "Manager here" })).status).toBe(201);
    expect(graph).toHaveLength(1);
  });

  it("agent reply on a RESOLVED conversation reopens it as PENDING", async () => {
    await Conversation.updateOne({ _id: convA._id }, { $set: { status: "RESOLVED" } });
    expect((await act(IDS.repA, convA._id, "reply", { text: "one more thing" })).status).toBe(201);
    expect((await Conversation.findById(convA._id).lean())!.status).toBe("PENDING");
  });
});

/* ───────────────────────────── resolve / reopen ───────────────────────────── */

describe("resolve / reopen", () => {
  it("resolve stamps resolvedAt/resolvedBy and stops the bot; reopen clears them; transitions are guarded", async () => {
    const r = await act(IDS.repA, convA._id, "resolve");
    expect(r.status).toBe(200);
    let c = await Conversation.findById(convA._id).lean();
    expect(c!.status).toBe("RESOLVED");
    expect(c!.resolvedAt).toBeInstanceOf(Date);
    expect(String(c!.resolvedBy)).toBe(String(IDS.repA));
    expect(c!.bot).toMatchObject({ active: false, stoppedBy: "human" });
    expect((await act(IDS.repA, convA._id, "resolve")).status).toBe(409);

    expect((await act(IDS.repA, convA._id, "reopen")).status).toBe(200);
    c = await Conversation.findById(convA._id).lean();
    expect(c!.status).toBe("OPEN");
    expect(c!.resolvedAt).toBeNull();
    expect(c!.resolvedBy).toBeNull();
    expect((await act(IDS.repA, convA._id, "reopen")).status).toBe(409);

    const sys = await Message.find({ conversationId: convA._id, type: "system" }).sort({ createdAt: 1 }).lean();
    expect(sys.map((m) => m.text)).toEqual(["Resolved", "Reopened"]);
    expect(graph).toHaveLength(0);
  });
});

/* ───────────────────────────── flag / permission key ───────────────────────────── */

describe("GET /agents — the reassign picker mirrors the gate", () => {
  it("lists ADMIN by role + explicit plumconnect grants, ACTIVE HOUSE users only; NONE-only users are absent", async () => {
    // The fixtures' workspace is not HOUSE; move the relevant users under HOUSE for this check.
    const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
    await User.updateMany({ _id: { $in: [IDS.admin, IDS.manager, IDS.repA, IDS.reader, IDS.leadsOnly, IDS.nobody] } }, { $set: { workspaceId: HOUSE } });
    await UserPermission.updateMany({ userId: { $in: [String(IDS.manager), String(IDS.repA), String(IDS.reader), String(IDS.leadsOnly)] } }, { $set: { workspaceId: String(HOUSE) } });
    await User.updateOne({ _id: IDS.reader }, { $set: { status: "INACTIVE" } });
    const r = await request(app).get("/api/plumconnect/agents").set(as(IDS.repA));
    expect(r.status).toBe(200);
    const ids = r.body.agents.map((a: any) => a._id).sort();
    expect(ids).toEqual([String(IDS.admin), String(IDS.manager), String(IDS.repA)].sort()); // reader inactive, leadsOnly/nobody ungranted, repB not HOUSE
    expect(r.body.agents.find((a: any) => a._id === String(IDS.repA)).name).toBe("User repA");
    await User.updateOne({ _id: IDS.reader }, { $set: { status: "ACTIVE" } });
  });
});

describe("flag OFF and the permission key", () => {
  it("PLUMCONNECT_ENABLED off → 404 on every route, for everyone, before any permission check", async () => {
    delete process.env.PLUMCONNECT_ENABLED;
    for (const who of [IDS.admin, IDS.manager, IDS.repA, IDS.nobody]) {
      expect((await list(who)).status).toBe(404);
      expect((await open(who, convA._id)).status).toBe(404);
      expect((await act(who, convA._id, "reply", { text: "x" })).status).toBe(404);
    }
    expect(graph).toHaveLength(0);
  });

  it("every department key defaults to NONE on a new permission row and is NONE in every level template; the old single key is gone from the schema", async () => {
    const row: any = await UserPermission.findOne({ userId: String(IDS.leadsOnly) }).lean();
    for (const k of LINE_KEYS) expect(row.modules[k], k).toEqual({ access: "NONE", scope: "NONE" });
    expect(row.modules).not.toHaveProperty("plumconnect");
    expect(row.modules.leads).toEqual({ access: "WRITE", scope: "OWN" });
    const templates: any = LEVEL_TEMPLATES;
    const keys = Object.keys(templates);
    expect(keys.length).toBeGreaterThan(0);
    for (const t of keys) {
      const mods = templates[t].modules ?? templates[t];
      for (const k of LINE_KEYS) expect(mods[k], `${t}.${k}`).toEqual({ access: "NONE", scope: "NONE" });
      expect(mods, t).not.toHaveProperty("plumconnect");
    }
  });

  it("the four keys are present in all five hard-coded sites (backend ×4, AccessConsole) and the feature flag on both sides", () => {
    const root = join(process.cwd(), "..");
    const read = (p: string) => readFileSync(join(root, p), "utf8");
    for (const k of LINE_KEYS) {
      expect(read("backend/src/models/UserPermission.ts"), k).toMatch(new RegExp(`${k}:\\s+\\{ type: modulePermissionSchema`));
      expect(read("backend/src/config/levelTemplates.ts"), k).toMatch(new RegExp(`${k}:\\s+ModulePermission`));
      expect(read("backend/src/utils/featureToModules.ts"), k).toMatch(new RegExp(`${k}:\\s+\\["plumconnectEnabled"\\]`));
      expect(read("backend/src/utils/moduleGroups.ts"), k).toContain(`'${k}'`);
      expect(read("frontend/src/pages/admin/access/AccessConsole.tsx"), k).toMatch(new RegExp(`key: "${k}", label: "PlumConnect — `));
      expect(read("frontend/src/pages/admin/access/AccessConsole.tsx"), k).toMatch(new RegExp(`${k}:\\s+\\["plumconnectEnabled"\\]`));
    }
    expect(read("backend/src/models/CustomerWorkspace.ts")).toMatch(/plumconnectEnabled: \{ type: Boolean, default: false \}/);
    expect(read("frontend/src/context/AuthContext.tsx")).toMatch(/plumconnectEnabled\?: boolean/);
  });

  it("the pre-Slice-7 single key is read NOWHERE: no `modules.plumconnect`, no `plumconnect:` module entry, no can(\"plumconnect\") on either side", () => {
    const root = join(process.cwd(), "..");
    const files = [
      "backend/src/models/UserPermission.ts", "backend/src/config/levelTemplates.ts", "backend/src/utils/featureToModules.ts", "backend/src/utils/moduleGroups.ts",
      "backend/src/middleware/requirePlumConnectAccess.ts", "backend/src/routes/plumconnect.ts", "backend/src/services/plumconnect/inboxScope.ts", "backend/src/services/plumconnect/access.ts",
      "backend/src/scripts/plumconnect-seed-dev.ts", "backend/src/routes/permissions.ts", "backend/src/services/capabilityProbe.ts",
      "frontend/src/pages/admin/access/AccessConsole.tsx", "frontend/src/components/layout/Header.tsx", "frontend/src/router.tsx", "frontend/src/pages/crm/CRMLayout.tsx",
      "frontend/src/lib/plumconnectAccess.ts", "frontend/src/pages/plumconnect/Inbox.tsx", "frontend/src/pages/plumconnect/inbox.logic.ts", "frontend/src/services/plumconnect.ts",
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(root, f), "utf8");
      // Strip comments so an explanatory mention of the legacy key does not count.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (/modules\.plumconnect\b(?![A-Z])/.test(code)) offenders.push(`${f}: modules.plumconnect`);
      if (/^\s*plumconnect\s*:/m.test(code) && !/moduleGroups/.test(f)) offenders.push(`${f}: plumconnect: entry`);
      if (/can\(\s*["']plumconnect["']/.test(code)) offenders.push(`${f}: can("plumconnect")`);
      if (/module=["']plumconnect["']/.test(code)) offenders.push(`${f}: module="plumconnect"`);
      if (/\.plumconnect\b(?![A-Z])/.test(code) && !/moduleGroups/.test(f)) offenders.push(`${f}: .plumconnect`);
    }
    expect(offenders).toEqual([]);
  });
});

/* ───────────────────────────── Slice 7 — per-line isolation ───────────────────────────── */

describe("per-line isolation (the Slice 7 security property)", () => {
  let convHelloOwn: any, convHelloOther: any, convHelloFree: any, convPlum: any, convConc: any, convUnrouted: any;
  beforeEach(async () => {
    const now = new Date();
    const mk = async (phone: string, over: any) => {
      const c = await Contact.create({ phone, displayName: phone.slice(-4) });
      return Conversation.create({ contactId: c._id, kind: "lead", status: "OPEN", lastInboundAt: now, lastMessageAt: now, ...over });
    };
    convHelloOwn = await mk("919700000001", { businessLine: "helloviza", leadId: new mongoose.Types.ObjectId(), assignedTo: IDS.vizaRep });
    convHelloOther = await mk("919700000002", { businessLine: "helloviza", leadId: new mongoose.Types.ObjectId(), assignedTo: IDS.repA });
    convHelloFree = await mk("919700000003", { businessLine: "helloviza", leadId: new mongoose.Types.ObjectId(), assignedTo: null });
    convPlum = await mk("919700000004", { businessLine: "plumtrips", leadId: new mongoose.Types.ObjectId(), assignedTo: IDS.vizaRep }); // assigned to the viza rep, but NOT their line
    convConc = await mk("919700000005", { businessLine: "concierge", leadId: new mongoose.Types.ObjectId(), assignedTo: null });
    convUnrouted = await mk("919700000006", { businessLine: null, leadId: null, assignedTo: null, intentMenuSentAt: now }); // menu pending → no line → support
  });
  const ids = (r: any) => r.body.conversations.map((c: any) => String(c._id)).sort();

  it("helloviza WRITE/OWN + everything else NONE: lists ONLY their own helloviza threads; the plumtrips thread assigned to them is invisible", async () => {
    const r = await list(IDS.vizaRep);
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([String(convHelloOwn._id)]);
    expect(r.body.lines).toEqual({ plumtrips: { access: "NONE", scope: "NONE" }, helloviza: { access: "WRITE", scope: "OWN" }, concierge: { access: "NONE", scope: "NONE" }, support: { access: "NONE", scope: "NONE" } });
    expect((await list(IDS.vizaRep, "?line=helloviza")).body.conversations).toHaveLength(1);
    expect((await list(IDS.vizaRep, "?line=plumtrips")).body.conversations).toHaveLength(0); // an unheld line never widens
    expect((await list(IDS.vizaRep, "?line=support")).body.conversations).toHaveLength(0);
    expect((await list(IDS.vizaRep, "?line=bogus")).status).toBe(400);
    expect((await list(IDS.vizaRep, "?unassigned=true")).body.conversations).toHaveLength(0); // OWN never widens
  });

  it("every verb on a plumtrips / concierge / support thread → 403 for the helloviza-only rep, even when assigned to them; rows untouched", async () => {
    for (const conv of [convPlum, convConc, convUnrouted, convB, convFree]) {
      expect((await open(IDS.vizaRep, conv._id)).status, `open ${conv.businessLine}`).toBe(403);
      for (const verb of ["assign", "note", "reply", "resolve", "reopen"]) {
        expect((await act(IDS.vizaRep, conv._id, verb, { text: "x" })).status, `${verb} ${conv.businessLine}`).toBe(403);
      }
    }
    expect(await Message.countDocuments({ conversationId: { $in: [convPlum._id, convConc._id, convUnrouted._id] } })).toBe(0);
    expect(graph).toHaveLength(0);
    expect(String((await Conversation.findById(convPlum._id).lean())!.assignedTo)).toBe(String(IDS.vizaRep)); // still theirs; just not visible to them
  });

  it("a helloviza thread that is not theirs (OWN) → 403; a free one can be taken; their own can be worked", async () => {
    expect((await open(IDS.vizaRep, convHelloOther._id)).status).toBe(403);
    expect((await act(IDS.vizaRep, convHelloOther._id, "reply", { text: "x" })).status).toBe(403);
    expect((await open(IDS.vizaRep, convHelloFree._id)).status).toBe(403); // OWN cannot read a free thread
    expect((await act(IDS.vizaRep, convHelloFree._id, "assign")).status).toBe(200); // but may take it
    expect(String((await Conversation.findById(convHelloFree._id).lean())!.assignedTo)).toBe(String(IDS.vizaRep));
    expect((await act(IDS.vizaRep, convHelloOwn._id, "note", { text: "mine" })).status).toBe(201);
    const r = await act(IDS.vizaRep, convHelloOwn._id, "reply", { text: "hello" });
    expect(r.status).toBe(201);
    expect(graph).toHaveLength(1);
    expect((await act(IDS.vizaRep, convHelloOwn._id, "assign", { userId: String(IDS.manager) })).status).toBe(403); // reassign needs FULL+ALL
  });

  it("plumtrips FULL/ALL only: sees every plumtrips thread and nothing else; may reassign a plumtrips thread only to someone who holds plumtrips", async () => {
    expect(ids(await list(IDS.corpLead))).toEqual([String(convPlum._id)]);
    expect((await open(IDS.corpLead, convPlum._id)).status).toBe(200);
    expect((await open(IDS.corpLead, convHelloOwn._id)).status).toBe(403);
    expect((await open(IDS.corpLead, convA._id)).status).toBe(403); // pre-Slice-5 lead thread = concierge
    // reassign: to the manager (holds plumtrips) → ok; to the viza rep (plumtrips NONE) → 400, untouched
    expect((await act(IDS.corpLead, convPlum._id, "assign", { userId: String(IDS.vizaRep) })).status).toBe(400);
    expect(String((await Conversation.findById(convPlum._id).lean())!.assignedTo)).toBe(String(IDS.vizaRep)); // (it was already theirs by fixture — the point is no write happened through a rejected verb)
    expect((await act(IDS.corpLead, convPlum._id, "assign", { userId: String(IDS.manager) })).status).toBe(200);
    expect(String((await Conversation.findById(convPlum._id).lean())!.assignedTo)).toBe(String(IDS.manager));
    expect((await act(IDS.corpLead, convPlum._id, "assign", { userId: String(IDS.admin) })).status).toBe(200); // ADMIN holds every line by role
  });

  it("the no-line rule: support / unrouted / system threads need plumconnectSupport — the support desk sees exactly those; line-scoped agents never do", async () => {
    const cX = await Contact.create({ phone: "919700000009", displayName: "Exp" });
    const now = new Date();
    const convExpense = await Conversation.create({ contactId: cX._id, kind: "expense", status: "OPEN", assignedTo: null, lastInboundAt: now, lastMessageAt: now });
    const r = await list(IDS.supportDesk);
    expect(ids(r)).toEqual([convB, convFree, convOld, convUnrouted, convExpense].map((c) => String(c._id)).sort());
    expect((await open(IDS.supportDesk, convUnrouted._id)).status).toBe(200);
    expect((await act(IDS.supportDesk, convUnrouted._id, "note", { text: "triage" })).status).toBe(201);
    // no department thread, ever — not even the pre-Slice-5 lead thread (that one is concierge)
    for (const conv of [convA, convHelloFree, convPlum, convConc]) {
      expect((await open(IDS.supportDesk, conv._id)).status, String(conv.businessLine)).toBe(403);
      expect((await act(IDS.supportDesk, conv._id, "assign")).status).toBe(403);
    }
    // and the line-scoped users never see the support threads
    for (const who of [IDS.vizaRep, IDS.corpLead]) {
      expect(ids(await list(who))).not.toContain(String(convUnrouted._id));
      expect((await open(who, convFree._id)).status).toBe(403);
    }
    // a helloviza FULL/ALL + support READ/ALL user: acts on helloviza, only reads support
    const va = await list(IDS.vizaAdmin);
    expect(ids(va)).toEqual([convHelloOwn, convHelloOther, convHelloFree, convB, convFree, convOld, convUnrouted, convExpense].map((c) => String(c._id)).sort());
    expect((await act(IDS.vizaAdmin, convHelloOther._id, "assign", { userId: String(IDS.vizaRep) })).status).toBe(200);
    expect((await act(IDS.vizaAdmin, convFree._id, "note", { text: "x" })).status).toBe(403); // READ on support
    expect((await open(IDS.vizaAdmin, convPlum._id)).status).toBe(403);
  });

  it("FULL/ALL on all four (manager) and ADMIN by role see every thread on every line; explicit NONE on all four → no inbox at all", async () => {
    const all = [convA, convB, convFree, convOld, convHelloOwn, convHelloOther, convHelloFree, convPlum, convConc, convUnrouted].map((c) => String(c._id)).sort();
    expect(ids(await list(IDS.manager))).toEqual(all);
    expect(ids(await list(IDS.admin))).toEqual(all);
    expect((await list(IDS.manager, "?line=helloviza")).body.conversations).toHaveLength(3);
    expect((await list(IDS.admin, "?line=concierge")).body.conversations.map((c: any) => String(c._id)).sort()).toEqual([String(convA._id), String(convConc._id)].sort());
    expect((await list(IDS.admin, "?line=support")).body.conversations).toHaveLength(4);
    expect((await list(IDS.noneAll)).status).toBe(403);
    expect((await open(IDS.noneAll, convHelloFree._id)).status).toBe(403);
    expect((await act(IDS.noneAll, convHelloFree._id, "assign")).status).toBe(403);
    expect((await request(app).get("/api/plumconnect/agents").set(as(IDS.noneAll))).status).toBe(403);
  });

  it("GET /agents?line= lists only holders of that line (plus ADMIN by role); without ?line= anyone holding any line", async () => {
    const names = (r: any) => r.body.agents.map((a: any) => a.name).sort();
    // The picker resolves against HOUSE users: move every granted user under HOUSE for this check.
    const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
    const everyone = [IDS.admin, IDS.manager, IDS.repA, IDS.repB, IDS.reader, IDS.leadsOnly, IDS.nobody, IDS.vizaRep, IDS.corpLead, IDS.supportDesk, IDS.noneAll, IDS.vizaAdmin];
    await User.updateMany({ _id: { $in: everyone } }, { $set: { workspaceId: HOUSE, status: "ACTIVE" } });
    await UserPermission.updateMany({ userId: { $in: everyone.map(String) } }, { $set: { workspaceId: String(HOUSE) } });
    const helloviza = await request(app).get("/api/plumconnect/agents?line=helloviza").set(as(IDS.vizaRep));
    expect(helloviza.status).toBe(200);
    expect(names(helloviza)).toEqual(["User admin", "User manager", "User reader", "User repA", "User repB", "User vizaAdmin", "User vizaRep"]);
    const plumtrips = await request(app).get("/api/plumconnect/agents?line=plumtrips").set(as(IDS.corpLead));
    expect(names(plumtrips)).toEqual(["User admin", "User corpLead", "User manager", "User reader", "User repA", "User repB"]);
    const any = await request(app).get("/api/plumconnect/agents").set(as(IDS.supportDesk));
    expect(names(any)).toEqual(["User admin", "User corpLead", "User manager", "User reader", "User repA", "User repB", "User supportDesk", "User vizaAdmin", "User vizaRep"]);
    expect((await request(app).get("/api/plumconnect/agents?line=nope").set(as(IDS.manager))).status).toBe(400);
  });
});

/* ───────────────────────────── other modules unchanged ───────────────────────────── */

describe("the five-site edit did not leak into other modules", () => {
  // levelTemplates.pre-slice7.golden.json is origin/main's LEVEL_TEMPLATES
  // (which carry no PlumConnect key at all). When upstream adds a module
  // key, re-record it FROM origin/main — never from this branch — so the
  // property stays "identical to main minus the PlumConnect keys".
  it("every level template is byte-identical to origin/main's once the PlumConnect keys are set aside", () => {
    const golden = JSON.parse(readFileSync(join(process.cwd(), "src/config/levelTemplates.pre-slice7.golden.json"), "utf8"));
    const now: Record<string, unknown> = {};
    for (const [code, t] of Object.entries(LEVEL_TEMPLATES as Record<string, any>)) {
      const mods = t.modules ?? t;
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(mods)) if (!/^plumconnect/i.test(k)) rest[k] = v;
      now[code] = rest;
    }
    expect(now).toEqual(golden);
  });

  it("a user's leads grant resolves identically with and without PlumConnect line grants; the leads gate never reads them", async () => {
    // vizaRep: leads READ/OWN + helloviza WRITE/OWN → leads gate says READ/OWN, not WRITE
    expect((await request(app).get("/api/leads-probe").set(as(IDS.vizaRep))).body).toEqual({ access: "READ", scope: "OWN" });
    // manager: FULL/ALL on all four lines, NO leads key → leads gate 403
    expect((await request(app).get("/api/leads-probe").set(as(IDS.manager))).status).toBe(403);
    // leadsOnly: unchanged from 4b
    expect((await request(app).get("/api/leads-probe").set(as(IDS.leadsOnly))).body).toEqual({ access: "WRITE", scope: "OWN" });
    // and the row itself carries nothing it did not before
    const row: any = await UserPermission.findOne({ userId: String(IDS.vizaRep) }).lean();
    expect(row.modules.leads).toEqual({ access: "READ", scope: "OWN" });
    expect(row.modules.visaScreening).toEqual({ access: "NONE", scope: "NONE" });
    expect(row.modules.crmContacts).toEqual({ access: "NONE", scope: "NONE" });
  });
});
