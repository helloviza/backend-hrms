// PlumConnect Track A — GET/POST /api/plumconnect/presence through the real
// router + the real line-aware gate over real UserPermission rows (auth
// stubbed via x-test-user like plumconnect.test.ts).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-presence-route-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.PLUMCONNECT_ENABLED = "true";

const IDS = {
  admin: new mongoose.Types.ObjectId(),
  viza: new mongoose.Types.ObjectId(), // helloviza WRITE/OWN only
  reader: new mongoose.Types.ObjectId(), // support READ/ALL only
  nobody: new mongoose.Types.ObjectId(),
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
const { default: AgentPresence } = await import("../models/plumconnect/AgentPresence.js");
const { activeAgentsForLine, DEFAULT_PRESENCE_TTL_MS } = await import("../services/plumconnect/presence.js");

const app = express();
app.use(express.json());
app.use("/api/plumconnect", requireAuth as any, router);
const as = (id: mongoose.Types.ObjectId) => ({ "x-test-user": String(id) });
const getP = (who: mongoose.Types.ObjectId) => request(app).get("/api/plumconnect/presence").set(as(who));
const postP = (who: mongoose.Types.ObjectId, body: any) => request(app).post("/api/plumconnect/presence").set(as(who)).send(body);

let mongod: MongoMemoryServer;
const AWAY = { active: false, stored: false, stale: false, activeSince: null, updatedAt: null };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await AgentPresence.syncIndexes();
  const ws = new mongoose.Types.ObjectId();
  for (const [k, id] of Object.entries(IDS)) {
    await User.collection.insertOne({ _id: id, name: `User ${k}`, email: `${k}@x.test`, roles: ROLES[String(id)] || ["EMPLOYEE"], passwordHash: "x", workspaceId: ws, status: "ACTIVE" } as any);
  }
  const grant = (userId: mongoose.Types.ObjectId, modules: any) =>
    UserPermission.create({ userId: String(userId), email: `${userId}@x.test`, workspaceId: String(ws), universe: "STAFF", source: "manual", level: { code: "L3", name: "Exec", designation: "x" }, status: "active", tier: 1, grantedModules: [], roleType: "EMPLOYEE", grantedBy: "test", grantedAt: new Date(), modules } as any);
  await grant(IDS.viza, { plumconnectHelloviza: { access: "WRITE", scope: "OWN" } });
  await grant(IDS.reader, { plumconnectSupport: { access: "READ", scope: "ALL" } });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  process.env.PLUMCONNECT_ENABLED = "true";
  await AgentPresence.deleteMany({});
});
afterEach(() => {
  process.env.PLUMCONNECT_ENABLED = "true";
});

describe("presence routes", () => {
  it("GET: a user who never set presence is away on every line; `lines` lists what they hold; ttlMs is the window", async () => {
    const r = await getP(IDS.viza);
    expect(r.status).toBe(200);
    expect(r.body.presence).toEqual({ plumtrips: AWAY, helloviza: AWAY, concierge: AWAY, support: AWAY });
    expect(r.body.lines).toEqual(["helloviza"]);
    expect(r.body.ttlMs).toBe(DEFAULT_PRESENCE_TTL_MS);
    expect((await getP(IDS.admin)).body.lines).toEqual(["plumtrips", "helloviza", "concierge", "support"]);
  });

  it("POST on a held line → active; on an unheld line → 403 and NO row; bad bodies → 400; the map reflects only the held line", async () => {
    const ok = await postP(IDS.viza, { line: "helloviza", active: true });
    expect(ok.status).toBe(200);
    expect(ok.body.line).toBe("helloviza");
    expect(ok.body.presence).toMatchObject({ active: true, stored: true, stale: false });
    expect(ok.body.all.helloviza.active).toBe(true);
    expect(ok.body.all.plumtrips).toEqual(AWAY);

    const no = await postP(IDS.viza, { line: "plumtrips", active: true });
    expect(no.status).toBe(403);
    expect(await AgentPresence.countDocuments({ line: "plumtrips" })).toBe(0);
    expect((await postP(IDS.viza, { line: "concierge", active: true })).status).toBe(403);
    expect((await postP(IDS.viza, { line: "support", active: true })).status).toBe(403);
    expect((await postP(IDS.viza, { line: "campaign", active: true })).status).toBe(400);
    expect((await postP(IDS.viza, { line: "helloviza", active: "yes" })).status).toBe(400);
    expect((await postP(IDS.viza, {})).status).toBe(400);
    expect(await AgentPresence.countDocuments({})).toBe(1);

    const g = await getP(IDS.viza);
    expect(g.body.presence.helloviza).toMatchObject({ active: true });
    expect(await activeAgentsForLine("helloviza")).toEqual([IDS.viza]);

    const off = await postP(IDS.viza, { line: "helloviza", active: false });
    expect(off.body.presence).toMatchObject({ active: false, stored: false, activeSince: null });
    expect(await activeAgentsForLine("helloviza")).toEqual([]);
  });

  it("per-department: ADMIN goes active on helloviza and away on plumtrips; each line independent; a READ-only holder may still set presence", async () => {
    await postP(IDS.admin, { line: "helloviza", active: true });
    await postP(IDS.admin, { line: "plumtrips", active: false });
    const r = await getP(IDS.admin);
    expect(r.body.presence.helloviza.active).toBe(true);
    expect(r.body.presence.plumtrips).toMatchObject({ active: false, stored: false });
    expect(r.body.presence.concierge).toEqual(AWAY);
    expect((await postP(IDS.reader, { line: "support", active: true })).status).toBe(200);
    expect((await postP(IDS.reader, { line: "helloviza", active: true })).status).toBe(403);
  });

  it("no PlumConnect line at all → 403 at the gate (no presence surface); unauthenticated → 401; FLAG OFF → 404 on both, nothing written", async () => {
    expect((await getP(IDS.nobody)).status).toBe(403);
    expect((await postP(IDS.nobody, { line: "support", active: true })).status).toBe(403);
    expect((await request(app).get("/api/plumconnect/presence")).status).toBe(401);
    delete process.env.PLUMCONNECT_ENABLED;
    expect((await getP(IDS.admin)).status).toBe(404);
    expect((await postP(IDS.admin, { line: "helloviza", active: true })).status).toBe(404);
    expect(await AgentPresence.countDocuments({})).toBe(0);
  });
});
