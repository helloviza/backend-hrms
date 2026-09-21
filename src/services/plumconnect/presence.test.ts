// PlumConnect Track A — agent presence over real collections
// (mongodb-memory-server): held-line enforcement, per-department
// independence, default away, grant-revocation safety, staleness, and the
// no-routing-change guarantee (a lead assigns exactly as Slice 3b/5 do,
// whatever presence says; no capture-path module imports this service).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-presence-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { setPresence, getPresence, activeAgentsForLine, isPresenceFresh, presenceTtlMs, PRESENCE_TTL_ENV, DEFAULT_PRESENCE_TTL_MS } = await import("./presence.js");
const { lineGrantsFromModules, adminLineGrants, noLineGrants } = await import("./access.js");
const { captureLead } = await import("./holidayLead.js");
const { default: AgentPresence } = await import("../../models/plumconnect/AgentPresence.js");
const { default: User } = await import("../../models/User.js");
const { UserPermission } = await import("../../models/UserPermission.js");
const { default: Lead } = await import("../../models/Lead.js");
const { default: Counter } = await import("../../models/Counter.js");
const { default: Contact } = await import("../../models/plumconnect/Contact.js");
const { default: Conversation } = await import("../../models/plumconnect/Conversation.js");

let mongod: MongoMemoryServer;
const NOW = new Date("2026-09-22T09:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const H = 3600_000;
const WS = new mongoose.Types.ObjectId();

const IDS = {
  admin: new mongoose.Types.ObjectId(),
  viza: new mongoose.Types.ObjectId(), // helloviza WRITE/OWN only
  both: new mongoose.Types.ObjectId(), // helloviza + plumtrips
  ghost: new mongoose.Types.ObjectId(), // no permission row
  inactive: new mongoose.Types.ObjectId(), // helloviza grant but User.status INACTIVE
};
const grantOf = (modules: any) => lineGrantsFromModules(modules);
const VIZA_MODULES = { plumconnectHelloviza: { access: "WRITE", scope: "OWN" } };
const BOTH_MODULES = { plumconnectHelloviza: { access: "READ", scope: "ALL" }, plumconnectPlumtrips: { access: "FULL", scope: "ALL" } };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([AgentPresence.syncIndexes(), Lead.syncIndexes()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

async function seedUsers() {
  await User.collection.insertMany([
    { _id: IDS.admin, name: "Ops Admin", email: "admin@x.test", roles: ["ADMIN"], passwordHash: "x", workspaceId: WS, status: "ACTIVE" },
    { _id: IDS.viza, name: "Viza Rep", email: "viza@x.test", roles: ["EMPLOYEE"], passwordHash: "x", workspaceId: WS, status: "ACTIVE" },
    { _id: IDS.both, name: "Both Rep", email: "both@x.test", roles: ["EMPLOYEE"], passwordHash: "x", workspaceId: WS, status: "ACTIVE" },
    { _id: IDS.ghost, name: "Ghost", email: "ghost@x.test", roles: ["EMPLOYEE"], passwordHash: "x", workspaceId: WS, status: "ACTIVE" },
    { _id: IDS.inactive, name: "Gone", email: "gone@x.test", roles: ["EMPLOYEE"], passwordHash: "x", workspaceId: WS, status: "INACTIVE" },
  ] as any[]);
  const perm = (userId: mongoose.Types.ObjectId, modules: any) =>
    UserPermission.create({ userId: String(userId), email: `${userId}@x.test`, workspaceId: String(WS), universe: "STAFF", source: "manual", level: { code: "L3", name: "Exec", designation: "x" }, status: "active", tier: 1, grantedModules: [], roleType: "EMPLOYEE", grantedBy: "test", grantedAt: new Date(), modules } as any);
  await perm(IDS.viza, VIZA_MODULES);
  await perm(IDS.both, BOTH_MODULES);
  await perm(IDS.inactive, VIZA_MODULES);
}

beforeEach(async () => {
  delete process.env[PRESENCE_TTL_ENV];
  await Promise.all([AgentPresence.deleteMany({}), User.deleteMany({}), UserPermission.deleteMany({}), Lead.deleteMany({}), Counter.deleteMany({}), Contact.deleteMany({}), Conversation.deleteMany({})]);
  await seedUsers();
});
afterEach(() => {
  delete process.env[PRESENCE_TTL_ENV];
});

describe("setPresence — only on a held line", () => {
  it("helloviza holder goes active on helloviza; plumtrips (not held) → line_not_held and NO row; an unknown line is invalid", async () => {
    const ok = await setPresence({ userId: IDS.viza, grants: grantOf(VIZA_MODULES), line: "helloviza", active: true, now: NOW });
    expect(ok).toMatchObject({ ok: true, line: "helloviza", presence: { active: true, stored: true, stale: false, activeSince: NOW, updatedAt: NOW } });
    const no = await setPresence({ userId: IDS.viza, grants: grantOf(VIZA_MODULES), line: "plumtrips", active: true, now: NOW });
    expect(no).toEqual({ ok: false, reason: "line_not_held" });
    expect(await setPresence({ userId: IDS.viza, grants: grantOf(VIZA_MODULES), line: "campaign", active: true, now: NOW })).toEqual({ ok: false, reason: "invalid_line" });
    expect(await setPresence({ userId: IDS.viza, grants: noLineGrants(), line: "helloviza", active: true, now: NOW })).toEqual({ ok: false, reason: "line_not_held" });
    const rows = await AgentPresence.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: IDS.viza, line: "helloviza", active: true });
  });

  it("ADMIN by role holds every line and may go active anywhere; one row per (user, line) even after repeated sets", async () => {
    for (const line of ["plumtrips", "helloviza", "concierge", "support"] as const) {
      expect((await setPresence({ userId: IDS.admin, grants: adminLineGrants(), line, active: true, now: NOW })).ok).toBe(true);
    }
    await setPresence({ userId: IDS.admin, grants: adminLineGrants(), line: "support", active: true, now: at(60_000) });
    await setPresence({ userId: IDS.admin, grants: adminLineGrants(), line: "support", active: false, now: at(120_000) });
    expect(await AgentPresence.countDocuments({ userId: IDS.admin })).toBe(4);
  });

  it("per-department independence: active on helloviza + away on plumtrips coexist; toggling one never touches the other", async () => {
    const g = grantOf(BOTH_MODULES);
    await setPresence({ userId: IDS.both, grants: g, line: "helloviza", active: true, now: NOW });
    await setPresence({ userId: IDS.both, grants: g, line: "plumtrips", active: false, now: NOW });
    let p = await getPresence(IDS.both, at(1000));
    expect(p.helloviza).toMatchObject({ active: true, activeSince: NOW });
    expect(p.plumtrips).toMatchObject({ active: false, stored: false, activeSince: null, updatedAt: NOW });
    expect(p.concierge).toMatchObject({ active: false, updatedAt: null });
    expect(p.support).toMatchObject({ active: false, updatedAt: null });

    await setPresence({ userId: IDS.both, grants: g, line: "plumtrips", active: true, now: at(2000) });
    p = await getPresence(IDS.both, at(3000));
    expect(p.plumtrips).toMatchObject({ active: true, activeSince: at(2000) });
    expect(p.helloviza).toMatchObject({ active: true, activeSince: NOW, updatedAt: NOW }); // untouched

    await setPresence({ userId: IDS.both, grants: g, line: "helloviza", active: false, now: at(4000) });
    p = await getPresence(IDS.both, at(5000));
    expect(p.helloviza).toMatchObject({ active: false, activeSince: null });
    expect(p.plumtrips).toMatchObject({ active: true, activeSince: at(2000) });
    expect(await activeAgentsForLine("plumtrips", at(5000))).toEqual([IDS.both]);
    expect(await activeAgentsForLine("helloviza", at(5000))).toEqual([]);
  });

  it("a repeated 'active' heartbeat keeps activeSince and refreshes updatedAt; away → active starts a new stretch", async () => {
    const g = grantOf(VIZA_MODULES);
    await setPresence({ userId: IDS.viza, grants: g, line: "helloviza", active: true, now: NOW });
    await setPresence({ userId: IDS.viza, grants: g, line: "helloviza", active: true, now: at(H) });
    expect((await getPresence(IDS.viza, at(H))).helloviza).toMatchObject({ activeSince: NOW, updatedAt: at(H) });
    await setPresence({ userId: IDS.viza, grants: g, line: "helloviza", active: false, now: at(2 * H) });
    await setPresence({ userId: IDS.viza, grants: g, line: "helloviza", active: true, now: at(3 * H) });
    expect((await getPresence(IDS.viza, at(3 * H))).helloviza).toMatchObject({ activeSince: at(3 * H) });
  });
});

describe("default away, revocation safety, staleness", () => {
  it("a user who never set presence is away everywhere and never in activeAgentsForLine", async () => {
    const p = await getPresence(IDS.ghost, NOW);
    for (const line of ["plumtrips", "helloviza", "concierge", "support"] as const) expect(p[line]).toEqual({ active: false, stored: false, stale: false, activeSince: null, updatedAt: null });
    expect(await activeAgentsForLine("helloviza", NOW)).toEqual([]);
    expect(await getPresence("not-an-id", NOW).then((m) => m.helloviza.active)).toBe(false);
  });

  it("grant revoked after going active: the row still says active, activeAgentsForLine does NOT list them; re-granting restores eligibility without a new row", async () => {
    await setPresence({ userId: IDS.viza, grants: grantOf(VIZA_MODULES), line: "helloviza", active: true, now: NOW });
    expect(await activeAgentsForLine("helloviza", at(1000))).toEqual([IDS.viza]);
    await UserPermission.updateOne({ userId: String(IDS.viza) }, { $set: { "modules.plumconnectHelloviza": { access: "NONE", scope: "NONE" } } });
    expect((await AgentPresence.findOne({ userId: IDS.viza, line: "helloviza" }).lean())!.active).toBe(true); // the row is not rewritten…
    expect(await activeAgentsForLine("helloviza", at(2000))).toEqual([]); // …but it does not count
    await UserPermission.deleteOne({ userId: String(IDS.viza) }); // row gone entirely
    expect(await activeAgentsForLine("helloviza", at(3000))).toEqual([]);
    await UserPermission.create({ userId: String(IDS.viza), email: "viza@x.test", workspaceId: String(WS), universe: "STAFF", source: "manual", level: { code: "L3", name: "Exec", designation: "x" }, status: "active", tier: 1, grantedModules: [], roleType: "EMPLOYEE", grantedBy: "test", grantedAt: new Date(), modules: VIZA_MODULES } as any);
    expect(await activeAgentsForLine("helloviza", at(4000))).toEqual([IDS.viza]);
    expect(await AgentPresence.countDocuments({})).toBe(1);
  });

  it("an INACTIVE user with an active row and a valid grant is not eligible", async () => {
    await setPresence({ userId: IDS.inactive, grants: grantOf(VIZA_MODULES), line: "helloviza", active: true, now: NOW });
    expect(await activeAgentsForLine("helloviza", at(1000))).toEqual([]);
  });

  it("staleness: an active row older than the TTL reads away (stale:true) and drops out of activeAgentsForLine; the window is env-configurable; a fresh heartbeat revives it", async () => {
    expect(presenceTtlMs()).toBe(DEFAULT_PRESENCE_TTL_MS);
    await setPresence({ userId: IDS.viza, grants: grantOf(VIZA_MODULES), line: "helloviza", active: true, now: NOW });
    expect((await getPresence(IDS.viza, at(DEFAULT_PRESENCE_TTL_MS - 1000))).helloviza).toMatchObject({ active: true, stale: false });
    expect(await activeAgentsForLine("helloviza", at(DEFAULT_PRESENCE_TTL_MS - 1000))).toEqual([IDS.viza]);
    expect((await getPresence(IDS.viza, at(DEFAULT_PRESENCE_TTL_MS))).helloviza).toMatchObject({ active: false, stored: true, stale: true, activeSince: NOW });
    expect(await activeAgentsForLine("helloviza", at(DEFAULT_PRESENCE_TTL_MS))).toEqual([]);
    expect((await AgentPresence.findOne({ userId: IDS.viza }).lean())!.active).toBe(true); // computed on read; nothing rewritten

    process.env[PRESENCE_TTL_ENV] = String(30 * 60_000);
    expect(presenceTtlMs()).toBe(30 * 60_000);
    expect((await getPresence(IDS.viza, at(31 * 60_000))).helloviza.active).toBe(false);
    expect(isPresenceFresh(NOW, at(29 * 60_000))).toBe(true);
    expect(isPresenceFresh(null, NOW)).toBe(false);
    process.env[PRESENCE_TTL_ENV] = "not-a-number";
    expect(presenceTtlMs()).toBe(DEFAULT_PRESENCE_TTL_MS);

    // a fresh heartbeat after the stale window starts a NEW stretch
    await setPresence({ userId: IDS.viza, grants: grantOf(VIZA_MODULES), line: "helloviza", active: true, now: at(DEFAULT_PRESENCE_TTL_MS + H) });
    expect((await getPresence(IDS.viza, at(DEFAULT_PRESENCE_TTL_MS + H))).helloviza).toMatchObject({ active: true, activeSince: at(DEFAULT_PRESENCE_TTL_MS + H) });
  });

  it("activeAgentsForLine returns each eligible user once, per line", async () => {
    await setPresence({ userId: IDS.viza, grants: grantOf(VIZA_MODULES), line: "helloviza", active: true, now: NOW });
    await setPresence({ userId: IDS.both, grants: grantOf(BOTH_MODULES), line: "helloviza", active: true, now: NOW });
    await setPresence({ userId: IDS.both, grants: grantOf(BOTH_MODULES), line: "plumtrips", active: true, now: NOW });
    await setPresence({ userId: IDS.admin, grants: adminLineGrants(), line: "concierge", active: true, now: NOW });
    const ids = (a: mongoose.Types.ObjectId[]) => a.map(String).sort();
    expect(ids(await activeAgentsForLine("helloviza", at(1000)))).toEqual(ids([IDS.viza, IDS.both]));
    expect(ids(await activeAgentsForLine("plumtrips", at(1000)))).toEqual(ids([IDS.both]));
    expect(ids(await activeAgentsForLine("concierge", at(1000)))).toEqual(ids([IDS.admin]));
    expect(await activeAgentsForLine("support", at(1000))).toEqual([]);
  });
});

describe("no routing change", () => {
  it("a lead assigns exactly as before — the first ADMIN (the Slice 3b rule) — whatever presence says; the presence rows are untouched by capture", async () => {
    // a non-admin is loudly active on concierge…
    await UserPermission.create({ userId: String(IDS.ghost), email: "ghost@x.test", workspaceId: String(WS), universe: "STAFF", source: "manual", level: { code: "L3", name: "Exec", designation: "x" }, status: "active", tier: 1, grantedModules: [], roleType: "EMPLOYEE", grantedBy: "test", grantedAt: new Date(), modules: { plumconnectConcierge: { access: "FULL", scope: "ALL" } } } as any);
    await setPresence({ userId: IDS.ghost, grants: grantOf({ plumconnectConcierge: { access: "FULL", scope: "ALL" } }), line: "concierge", active: true, now: NOW });
    expect(await activeAgentsForLine("concierge", at(1000))).toEqual([IDS.ghost]);
    // …and the admin is explicitly away
    await setPresence({ userId: IDS.admin, grants: adminLineGrants(), line: "concierge", active: false, now: NOW });

    const contact = await Contact.create({ phone: "919111111111" });
    const conversation = await Conversation.create({ contactId: contact._id, kind: "lead", businessLine: "concierge" });
    const r = await captureLead({ businessLine: "concierge", canonical: "919111111111", profileName: "Priya", referralRaw: { source_type: "ad", source_id: "120200000000000001", headline: "Bali" }, contactId: contact._id as any, conversation, messageId: "wamid.1", now: at(2000) });
    expect(r.touch).toBe("first");
    expect(String((r as any).assignedTo)).toBe(String(IDS.admin)); // not the active agent
    const lead: any = await Lead.findById(r.leadId).lean();
    expect(String(lead.assignedTo)).toBe(String(IDS.admin));
    expect(lead.assignedToName).toBe("Ops Admin");
    expect(await AgentPresence.countDocuments({})).toBe(2);
    expect((await AgentPresence.findOne({ userId: IDS.ghost }).lean())!.updatedAt).toEqual(NOW);
  });

  it("no capture-path, worker, sender or webhook module imports presence (static)", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && /plumconnect[\\/]presence\.js/.test(readFileSync(p, "utf8"))) offenders.push(p.slice(root.length + 1).replace(/\\/g, "/"));
      }
    };
    walk(root);
    expect(offenders.sort()).toEqual(["routes/plumconnect.ts"]);
  });
});
