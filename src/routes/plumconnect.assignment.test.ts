// PlumConnect Track B — the matrix through the real routes: CRUD on
// /assignment-rules (admin gate, WRITE+ validation, known campaign/ad),
// a TIE surfaced to both candidates and claimed by the first "take" (the
// other can no longer take it), and hold → revive on the inbox list read.
// Real router + real line-aware gate over real UserPermission rows; auth
// stubbed via x-test-user like plumconnect.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-assignment-route-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.PLUMCONNECT_ENABLED = "true";

const IDS = {
  admin: new mongoose.Types.ObjectId(),
  lead: new mongoose.Types.ObjectId(), // helloviza FULL/ALL — the department lead who manages rules
  p1: new mongoose.Types.ObjectId(), // helloviza WRITE/OWN
  p2: new mongoose.Types.ObjectId(), // helloviza WRITE/OWN
  reader: new mongoose.Types.ObjectId(), // helloviza READ/ALL
  corp: new mongoose.Types.ObjectId(), // plumtrips WRITE/OWN
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
const { UserPermission } = await import("../models/UserPermission.js");
const { default: User } = await import("../models/User.js");
const { default: Lead } = await import("../models/Lead.js");
const { default: Contact } = await import("../models/plumconnect/Contact.js");
const { default: Conversation } = await import("../models/plumconnect/Conversation.js");
const { default: Message } = await import("../models/plumconnect/Message.js");
const { default: AssignmentRule } = await import("../models/plumconnect/AssignmentRule.js");
const { default: AgentPresence } = await import("../models/plumconnect/AgentPresence.js");
const { default: Campaign } = await import("../models/plumconnect/Campaign.js");
const { default: CampaignMap } = await import("../models/plumconnect/CampaignMap.js");

const app = express();
app.use(express.json());
app.use("/api/plumconnect", requireAuth as any, router);
const as = (id: mongoose.Types.ObjectId) => ({ "x-test-user": String(id) });
const rules = (who: mongoose.Types.ObjectId, q = "") => request(app).get(`/api/plumconnect/assignment-rules${q}`).set(as(who));
const createRule = (who: mongoose.Types.ObjectId, body: any) => request(app).post("/api/plumconnect/assignment-rules").set(as(who)).send(body);
const patchRule = (who: mongoose.Types.ObjectId, id: any, body: any) => request(app).patch(`/api/plumconnect/assignment-rules/${id}`).set(as(who)).send(body);
const delRule = (who: mongoose.Types.ObjectId, id: any) => request(app).delete(`/api/plumconnect/assignment-rules/${id}`).set(as(who));
const presence = (who: mongoose.Types.ObjectId, line: string, active: boolean) => request(app).post("/api/plumconnect/presence").set(as(who)).send({ line, active });
const list = (who: mongoose.Types.ObjectId, q = "") => request(app).get(`/api/plumconnect/conversations${q}`).set(as(who));
const open = (who: mongoose.Types.ObjectId, id: any) => request(app).get(`/api/plumconnect/conversations/${id}`).set(as(who));
const take = (who: mongoose.Types.ObjectId, id: any, body: any = {}) => request(app).post(`/api/plumconnect/conversations/${id}/assign`).set(as(who)).send(body);

let mongod: MongoMemoryServer;
const CAMPAIGN = "2384000000000001";
const AD = "120200000000000101";

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([AssignmentRule.syncIndexes(), AgentPresence.syncIndexes(), Conversation.syncIndexes(), Campaign.syncIndexes(), CampaignMap.syncIndexes()]);
  const ws = new mongoose.Types.ObjectId();
  for (const [k, id] of Object.entries(IDS)) {
    await User.collection.insertOne({ _id: id, name: `User ${k}`, email: `${k}@x.test`, roles: ROLES[String(id)] || ["EMPLOYEE"], passwordHash: "x", workspaceId: ws, status: "ACTIVE" } as any);
  }
  const grant = (userId: mongoose.Types.ObjectId, modules: any) =>
    UserPermission.create({ userId: String(userId), email: `${userId}@x.test`, workspaceId: String(ws), universe: "STAFF", source: "manual", level: { code: "L3", name: "Exec", designation: "x" }, status: "active", tier: 1, grantedModules: [], roleType: "EMPLOYEE", grantedBy: "test", grantedAt: new Date(), modules } as any);
  await grant(IDS.lead, { plumconnectHelloviza: { access: "FULL", scope: "ALL" } });
  await grant(IDS.p1, { plumconnectHelloviza: { access: "WRITE", scope: "OWN" } });
  await grant(IDS.p2, { plumconnectHelloviza: { access: "WRITE", scope: "OWN" } });
  await grant(IDS.reader, { plumconnectHelloviza: { access: "READ", scope: "ALL" } });
  await grant(IDS.corp, { plumconnectPlumtrips: { access: "WRITE", scope: "OWN" } });
  await Campaign.create({ metaId: CAMPAIGN, name: "Visa Q4" });
  await CampaignMap.create({ adId: AD, businessLine: "helloviza", label: "x" });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  process.env.PLUMCONNECT_ENABLED = "true";
  await Promise.all([AssignmentRule.deleteMany({}), AgentPresence.deleteMany({}), Contact.deleteMany({}), Conversation.deleteMany({}), Message.deleteMany({}), Lead.deleteMany({})]);
});
afterEach(() => {
  process.env.PLUMCONNECT_ENABLED = "true";
});

let n = 0;
async function heldThread(line = "helloviza", over: any = {}) {
  const contact = await Contact.create({ phone: `9198000000${String(++n).padStart(2, "0")}`, displayName: `C${n}` });
  const lead = await Lead.create({ contactName: `C${n}`, contactPhone: contact.phone, type: "individual" });
  const now = new Date();
  return Conversation.create({ contactId: contact._id, kind: "lead", businessLine: line, leadId: lead._id, status: "OPEN", assignedTo: null, routing: { state: "held", targetType: "department", targetKey: `department:${line}`, candidates: [], reason: "nobody mapped" }, lastInboundAt: now, lastMessageAt: now, ...over });
}

describe("CRUD /assignment-rules", () => {
  it("admin-gated: FULL on the line (or ADMIN) may create / list / update / delete; WRITE/OWN → 403; a FULL holder of another line → 403 on this one", async () => {
    const r = await createRule(IDS.lead, { target: { type: "department", line: "helloviza" }, userId: String(IDS.p1), priority: 1 });
    expect(r.status).toBe(201);
    expect(r.body.rule).toMatchObject({ targetKey: "department:helloviza", userId: String(IDS.p1), userName: "User p1", priority: 1, enabled: true });
    expect((await createRule(IDS.p1, { target: { type: "department", line: "helloviza" }, userId: String(IDS.p2) })).status).toBe(403);
    expect((await createRule(IDS.lead, { target: { type: "department", line: "plumtrips" }, userId: String(IDS.corp) })).status).toBe(403);
    expect((await createRule(IDS.admin, { target: { type: "department", line: "plumtrips" }, userId: String(IDS.corp), priority: 3 })).status).toBe(201);

    const l = await rules(IDS.lead);
    expect(l.status).toBe(200);
    expect(l.body.lines).toEqual(["helloviza"]);
    expect(l.body.rules.map((x: any) => x.targetKey)).toEqual(["department:helloviza"]); // not the plumtrips rule
    expect((await rules(IDS.admin)).body.rules).toHaveLength(2);
    expect((await rules(IDS.p1)).status).toBe(403);
    expect((await rules(IDS.admin, "?line=nope")).status).toBe(400);

    const id = r.body.rule._id;
    expect((await patchRule(IDS.p1, id, { priority: 9 })).status).toBe(403);
    const u = await patchRule(IDS.lead, id, { priority: 9, enabled: false });
    expect(u.body.rule).toMatchObject({ priority: 9, enabled: false });
    expect((await delRule(IDS.p1, id)).status).toBe(403);
    expect((await delRule(IDS.lead, id)).body).toEqual({ deleted: true });
    expect((await delRule(IDS.lead, id)).status).toBe(404);
  });

  it("validation: the mapped user must hold the target line at WRITE+ (READ-only → 400, other line → 400); campaign / ad must be known; bad bodies → 400; duplicate → 409", async () => {
    expect((await createRule(IDS.lead, { target: { type: "department", line: "helloviza" }, userId: String(IDS.reader) })).body.error).toMatch(/WRITE/);
    expect((await createRule(IDS.lead, { target: { type: "department", line: "helloviza" }, userId: String(IDS.corp) })).status).toBe(400);
    expect((await createRule(IDS.lead, { target: { type: "campaign", line: "helloviza", metaId: "9999" }, userId: String(IDS.p1) })).body.error).toMatch(/Unknown campaign/);
    expect((await createRule(IDS.lead, { target: { type: "campaign", line: "helloviza", metaId: CAMPAIGN }, userId: String(IDS.p1) })).status).toBe(201);
    expect((await createRule(IDS.lead, { target: { type: "ad", line: "helloviza", metaId: "8888" }, userId: String(IDS.p1) })).body.error).toMatch(/Unknown ad/);
    expect((await createRule(IDS.lead, { target: { type: "ad", line: "helloviza", metaId: AD }, userId: String(IDS.p1) })).status).toBe(201); // known via the campaign map
    expect((await createRule(IDS.lead, { target: { type: "bogus", line: "helloviza" }, userId: String(IDS.p1) })).status).toBe(400);
    expect((await createRule(IDS.lead, { target: { type: "department", line: "helloviza" }, userId: String(IDS.p1), priority: -1 })).status).toBe(400);
    expect((await createRule(IDS.lead, { target: { type: "department", line: "helloviza" }, userId: String(IDS.p1) })).status).toBe(201);
    expect((await createRule(IDS.lead, { target: { type: "department", line: "helloviza" }, userId: String(IDS.p1) })).status).toBe(409);
    // re-pointing a rule at someone who cannot act is refused too
    const id = (await rules(IDS.lead)).body.rules.find((x: any) => x.targetKey === "department:helloviza")._id;
    expect((await patchRule(IDS.lead, id, { userId: String(IDS.reader) })).status).toBe(400);
    expect(await AssignmentRule.countDocuments({})).toBe(3);
  });

  it("FLAG OFF: every matrix endpoint is 404; nothing written", async () => {
    delete process.env.PLUMCONNECT_ENABLED;
    expect((await rules(IDS.admin)).status).toBe(404);
    expect((await createRule(IDS.admin, { target: { type: "department", line: "helloviza" }, userId: String(IDS.p1) })).status).toBe(404);
    expect(await AssignmentRule.countDocuments({})).toBe(0);
  });
});

describe("ties: first to take wins", () => {
  it("two same-priority active agents → the thread is unassigned yet listed and openable by BOTH (OWN scope); p2 takes it → theirs (Lead owner synced, bot stopped); p1 can no longer take or see it", async () => {
    await createRule(IDS.lead, { target: { type: "department", line: "helloviza" }, userId: String(IDS.p1), priority: 1 });
    await createRule(IDS.lead, { target: { type: "department", line: "helloviza" }, userId: String(IDS.p2), priority: 1 });
    await presence(IDS.p1, "helloviza", true);
    await presence(IDS.p2, "helloviza", true);
    const t = await heldThread("helloviza", { bot: { active: true, step: "ask_name" } });

    // the list read re-resolves the held thread into a TIE surfaced to both
    const l1 = await list(IDS.p1);
    expect(l1.status).toBe(200);
    expect(l1.body.conversations.map((c: any) => String(c._id))).toEqual([String(t._id)]);
    expect(l1.body.conversations[0].routing).toMatchObject({ state: "tie", targetKey: "department:helloviza" });
    expect(l1.body.conversations[0].routing.candidates.sort()).toEqual([String(IDS.p1), String(IDS.p2)].sort());
    expect(l1.body.conversations[0].assignedTo).toBeNull();
    expect((await list(IDS.p2)).body.conversations).toHaveLength(1);
    expect((await open(IDS.p1, t._id)).status).toBe(200);
    expect((await open(IDS.p2, t._id)).status).toBe(200);
    expect((await open(IDS.corp, t._id)).status).toBe(403); // not a candidate, not their line

    // p2 claims it
    const claim = await take(IDS.p2, t._id);
    expect(claim.status).toBe(200);
    expect(claim.body.conversation.assignedTo).toBe(String(IDS.p2));
    expect(claim.body.conversation.routing).toMatchObject({ state: "assigned", candidates: [String(IDS.p2)], reason: "taken" });
    const c: any = await Conversation.findById(t._id).lean();
    expect(c.routing.autoAssigned).toBe(false); // a human take IS a takeover
    expect(c.bot).toMatchObject({ active: false, stoppedBy: "human" });
    const lead: any = await Lead.findById(t.leadId).lean();
    expect(String(lead.assignedTo)).toBe(String(IDS.p2));
    expect(lead.assignedToName).toBe("User p2");

    // p1 lost the race
    expect((await take(IDS.p1, t._id)).status).toBe(403);
    expect((await open(IDS.p1, t._id)).status).toBe(403);
    expect((await list(IDS.p1)).body.conversations).toHaveLength(0);
    expect(String((await Conversation.findById(t._id).lean())!.assignedTo)).toBe(String(IDS.p2));
  });
});

describe("hold + revive on the queue read", () => {
  it("nobody active → held and invisible to the OWN-scoped rep; the rep goes active → their next list read assigns it to them; the auto-assigned thread keeps its bot running", async () => {
    await createRule(IDS.lead, { target: { type: "department", line: "helloviza" }, userId: String(IDS.p1), priority: 1 });
    const t = await heldThread("helloviza", { bot: { active: true, step: "ask_name" } });
    expect((await list(IDS.p1)).body.conversations).toHaveLength(0); // away → held stays held, and OWN sees nothing
    expect((await open(IDS.p1, t._id)).status).toBe(403);
    expect((await Conversation.findById(t._id).lean())!.routing.state).toBe("held");
    // the department lead (ALL) sees it as awaiting an agent
    const seen = (await list(IDS.lead)).body.conversations[0];
    expect(seen.routing).toMatchObject({ state: "held" });

    await presence(IDS.p1, "helloviza", true);
    const l = await list(IDS.p1);
    expect(l.body.conversations.map((c: any) => String(c._id))).toEqual([String(t._id)]);
    expect(l.body.conversations[0]).toMatchObject({ assignedTo: String(IDS.p1), routing: { state: "assigned", reason: "priority 1" } });
    const c: any = await Conversation.findById(t._id).lean();
    expect(c.routing.autoAssigned).toBe(true);
    expect(c.bot).toMatchObject({ active: true, step: "ask_name" }); // auto-assignment is not a takeover
    expect(String((await Lead.findById(t.leadId).lean())!.assignedTo)).toBe(String(IDS.p1));
    expect((await open(IDS.p1, t._id)).status).toBe(200);
    // a reply by the agent is the takeover that stops the bot (4b contract, unchanged)
    await Conversation.updateOne({ _id: t._id }, { $set: { lastInboundAt: new Date() } });
    const note = await request(app).post(`/api/plumconnect/conversations/${t._id}/note`).set(as(IDS.p1)).send({ text: "on it" });
    expect(note.status).toBe(201);
  });

  it("?line= narrows the re-resolve to that line; a thread on another line is left held", async () => {
    await createRule(IDS.admin, { target: { type: "department", line: "plumtrips" }, userId: String(IDS.corp), priority: 1 });
    const tv = await heldThread("helloviza");
    const tp = await heldThread("plumtrips");
    await presence(IDS.corp, "plumtrips", true);
    await list(IDS.admin, "?line=helloviza");
    expect((await Conversation.findById(tp._id).lean())!.routing.state).toBe("held");
    expect((await Conversation.findById(tv._id).lean())!.routing.state).toBe("held");
    await list(IDS.admin);
    expect((await Conversation.findById(tp._id).lean())!.routing).toMatchObject({ state: "assigned" });
    expect(String((await Conversation.findById(tp._id).lean())!.assignedTo)).toBe(String(IDS.corp));
    expect((await Conversation.findById(tv._id).lean())!.routing.state).toBe("held"); // nobody mapped on helloviza
  });
});
