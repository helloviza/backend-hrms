// PlumConnect Track C — GET/PATCH/DELETE /api/plumconnect/messages through
// the real router + real line-aware gate (auth stubbed via x-test-user).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-messages-route-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.PLUMCONNECT_ENABLED = "true";

const IDS = {
  admin: new mongoose.Types.ObjectId(),
  vizaLead: new mongoose.Types.ObjectId(), // helloviza FULL/ALL
  rep: new mongoose.Types.ObjectId(), // helloviza WRITE/OWN
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
const { default: CannedMessage } = await import("../models/plumconnect/CannedMessage.js");
const { MESSAGE_KEYS, MESSAGE_DEFAULTS, getMessage } = await import("../services/plumconnect/messages.js");

const app = express();
app.use(express.json());
app.use("/api/plumconnect", requireAuth as any, router);
const as = (id: mongoose.Types.ObjectId) => ({ "x-test-user": String(id) });
const list = (who: mongoose.Types.ObjectId) => request(app).get("/api/plumconnect/messages").set(as(who));
const edit = (who: mongoose.Types.ObjectId, body: any) => request(app).patch("/api/plumconnect/messages").set(as(who)).send(body);
const del = (who: mongoose.Types.ObjectId, key: string, line: string) => request(app).delete(`/api/plumconnect/messages/${key}/${line}`).set(as(who));

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await CannedMessage.syncIndexes();
  const ws = new mongoose.Types.ObjectId();
  for (const [k, id] of Object.entries(IDS)) {
    await User.collection.insertOne({ _id: id, name: `User ${k}`, email: `${k}@x.test`, roles: ROLES[String(id)] || ["EMPLOYEE"], passwordHash: "x", workspaceId: ws, status: "ACTIVE" } as any);
  }
  const grant = (userId: mongoose.Types.ObjectId, modules: any) =>
    UserPermission.create({ userId: String(userId), email: `${userId}@x.test`, workspaceId: String(ws), universe: "STAFF", source: "manual", level: { code: "L3", name: "Exec", designation: "x" }, status: "active", tier: 1, grantedModules: [], roleType: "EMPLOYEE", grantedBy: "test", grantedAt: new Date(), modules } as any);
  await grant(IDS.vizaLead, { plumconnectHelloviza: { access: "FULL", scope: "ALL" } });
  await grant(IDS.rep, { plumconnectHelloviza: { access: "WRITE", scope: "OWN" } });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  process.env.PLUMCONNECT_ENABLED = "true";
  await CannedMessage.deleteMany({});
});
afterEach(() => {
  process.env.PLUMCONNECT_ENABLED = "true";
});

describe("/messages", () => {
  it("GET lists every key with the current text and whether it is overridden; FULL on a line (or ADMIN) may read; WRITE/OWN → 403; nobody → 403", async () => {
    const r = await list(IDS.vizaLead);
    expect(r.status).toBe(200);
    expect(r.body.messages).toHaveLength(MESSAGE_KEYS.length);
    const busy = r.body.messages.find((m: any) => m.key === "busy.support");
    expect(busy).toMatchObject({ line: null, text: MESSAGE_DEFAULTS["busy.support"].text, defaultText: MESSAGE_DEFAULTS["busy.support"].text, overridden: false, enabled: true, variables: [] });
    expect(r.body.messages.find((m: any) => m.key === "concierge.handover").variables).toEqual(["name"]);
    expect((await list(IDS.admin)).status).toBe(200);
    expect((await list(IDS.rep)).status).toBe(403);
    expect((await list(IDS.nobody)).status).toBe(403);
    expect((await request(app).get("/api/plumconnect/messages")).status).toBe(401);
  });

  it("PATCH: the global text needs FULL on any line; a line override needs FULL on THAT line; edits are live; blank / unknown key / bad placeholder → 400", async () => {
    const g = await edit(IDS.vizaLead, { key: "busy.support", text: "Support is swamped — one moment." });
    expect(g.status).toBe(200);
    expect(g.body.message).toMatchObject({ key: "busy.support", line: null, text: "Support is swamped — one moment.", overridden: true, updatedBy: String(IDS.vizaLead) });
    expect(await getMessage("busy.support", "plumtrips")).toBe("Support is swamped — one moment.");

    expect((await edit(IDS.vizaLead, { key: "busy.support", line: "helloviza", text: "Visa desk busy." })).status).toBe(200);
    expect((await edit(IDS.vizaLead, { key: "busy.support", line: "plumtrips", text: "Corp busy." })).status).toBe(403); // not their line
    expect((await edit(IDS.admin, { key: "busy.support", line: "plumtrips", text: "Corp busy." })).status).toBe(200);
    expect(await getMessage("busy.support", "helloviza")).toBe("Visa desk busy.");
    expect(await getMessage("busy.support", "plumtrips")).toBe("Corp busy.");
    expect(await getMessage("busy.support", "concierge")).toBe("Support is swamped — one moment.");

    expect((await edit(IDS.rep, { key: "busy.support", text: "x" })).status).toBe(403);
    expect((await edit(IDS.vizaLead, { key: "busy.support", text: "   " })).status).toBe(400);
    expect((await edit(IDS.vizaLead, { key: "no.such.key", text: "x" })).status).toBe(400);
    expect((await edit(IDS.vizaLead, { key: "busy.support", text: "Hi {name}" })).body.error).toMatch(/Unknown placeholder/);
    expect((await edit(IDS.vizaLead, { key: "busy.support", line: "bogus", text: "x" })).status).toBe(400);
    expect((await edit(IDS.vizaLead, { key: "busy.support" })).status).toBe(400);

    const all = (await list(IDS.admin)).body.messages.filter((m: any) => m.key === "busy.support");
    expect(all.map((m: any) => m.line)).toEqual([null, "plumtrips", "helloviza"]);
    expect(all.every((m: any) => m.overridden)).toBe(true);

    // disabling the global falls back to the seed default on lines without an override
    expect((await edit(IDS.admin, { key: "busy.support", enabled: false })).status).toBe(200);
    expect(await getMessage("busy.support", "concierge")).toBe(MESSAGE_DEFAULTS["busy.support"].text);
    expect(await getMessage("busy.support", "helloviza")).toBe("Visa desk busy.");
  });

  it("DELETE removes a line override (the line falls back to the global); needs FULL on that line; 404 when none", async () => {
    await edit(IDS.admin, { key: "busy.support", text: "Global." });
    await edit(IDS.admin, { key: "busy.support", line: "helloviza", text: "Visa." });
    expect((await del(IDS.rep, "busy.support", "helloviza")).status).toBe(403);
    expect((await del(IDS.vizaLead, "busy.support", "plumtrips")).status).toBe(403);
    expect((await del(IDS.vizaLead, "busy.support", "helloviza")).body).toEqual({ deleted: true });
    expect(await getMessage("busy.support", "helloviza")).toBe("Global.");
    expect((await del(IDS.vizaLead, "busy.support", "helloviza")).status).toBe(404);
    expect((await del(IDS.admin, "busy.support", "bogus")).status).toBe(400);
  });

  it("FLAG OFF: 404 on every message endpoint; nothing written", async () => {
    delete process.env.PLUMCONNECT_ENABLED;
    expect((await list(IDS.admin)).status).toBe(404);
    expect((await edit(IDS.admin, { key: "busy.support", text: "x" })).status).toBe(404);
    expect((await del(IDS.admin, "busy.support", "helloviza")).status).toBe(404);
    expect(await CannedMessage.countDocuments({})).toBe(0);
  });
});
