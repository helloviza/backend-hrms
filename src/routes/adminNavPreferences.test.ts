// apps/backend/src/routes/adminNavPreferences.test.ts
//
// Per-user visible Header groups (docs/audits/nav-visible-groups-audit.md).
// Real Mongo, real routers. Proves:
//   - only a real session SUPERADMIN can read / set / clear it (ADMIN, HR,
//     TENANT_ADMIN, and a SUPERADMIN impersonating a demo user all get 403
//     and write nothing);
//   - values are validated against config/navGroups.ts; duplicates collapse,
//     order is kept; null and [] clear by UNSETTING the field;
//   - every real change writes one NavPreferenceAudit row (who, before →
//     after, via "api"); a no-op writes none;
//   - PUT /api/employees/:id cannot set it (it is stripped before the
//     Object.assign onto the User doc), for an admin or a superadmin;
//   - the session user (/auth/login, /refresh, /me) carries it, and a user
//     who never had it carries nothing new.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "test-secret";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const ids = vi.hoisted(() => ({
  sa: "66d000000000000000000001",
  admin: "66d000000000000000000002",
  hr: "66d000000000000000000003",
  tenantAdmin: "66d000000000000000000004",
  target: "66d000000000000000000005",
  plain: "66d000000000000000000006",
}));
type Caller = "sa" | "admin" | "hr" | "tenantAdmin" | "saImpersonating";
const caller = vi.hoisted(() => ({ current: "sa" as Caller }));

vi.mock("../middleware/auth.js", () => {
  const inject = (req: any, _res: any, next: any) => {
    const c = caller.current;
    const base = c === "saImpersonating" ? "sa" : c;
    const roles =
      base === "sa" ? ["SUPERADMIN"] : base === "admin" ? ["ADMIN"] : base === "hr" ? ["HR"] : ["TENANT_ADMIN"];
    const id = (ids as any)[base];
    req.user = { id, _id: id, sub: id, roles, email: `${base}@plumtrips.com` };
    if (c === "saImpersonating") req.user._demoImpersonation = { realUserId: id };
    next();
  };
  return { requireAuth: inject, default: inject };
});
vi.mock("../middleware/requireWorkspace.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    requireWorkspace: (req: any, _res: any, next: any) => {
      req.workspaceObjectId = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
      next();
    },
  };
});

const WS = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const oid = (s: string) => new mongoose.Types.ObjectId(s);

const { default: User } = await import("../models/User.js");
const { default: Employee } = await import("../models/Employee.js");
const { default: NavPreferenceAudit } = await import("../models/NavPreferenceAudit.js");
const { default: navRouter } = await import("./adminNavPreferences.js");
const { default: employeesRouter } = await import("./employees.js");
const { buildAuthSafeUserCore } = await import("./auth.js");

let mongod: MongoMemoryServer;
function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/admin/nav-preferences", navRouter);
  a.use("/api/employees", employeesRouter);
  return a;
}
const put = (id: string, body: any) => request(app()).put(`/api/admin/nav-preferences/${id}`).send(body);
const raw = async (id: string) => (await User.collection.findOne({ _id: oid(id) })) as any;
const PLUMBOX = ["travelAnalytics", "travelbox", "spendbox", "helloviza"];
const targetEmp = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await User.collection.insertMany([
    { _id: oid(ids.sa), email: "sa@plumtrips.com", roles: ["SUPERADMIN"], workspaceId: WS, passwordHash: "x", status: "ACTIVE" },
    { _id: oid(ids.admin), email: "admin@plumtrips.com", roles: ["ADMIN"], workspaceId: WS, passwordHash: "x", status: "ACTIVE" },
    { _id: oid(ids.hr), email: "hr@plumtrips.com", roles: ["HR"], workspaceId: WS, passwordHash: "x", status: "ACTIVE" },
    { _id: oid(ids.tenantAdmin), email: "tenantadmin@plumtrips.com", roles: ["TENANT_ADMIN"], workspaceId: WS, passwordHash: "x", status: "ACTIVE" },
    { _id: oid(ids.target), email: "plumbox@plumtrips.com", firstName: "Plum", lastName: "Box", roles: ["SUPERADMIN"], workspaceId: WS, passwordHash: "x", status: "ACTIVE" },
    { _id: oid(ids.plain), email: "plain@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: WS, passwordHash: "x", status: "ACTIVE" },
  ] as any[]);
  await Employee.collection.insertOne({
    _id: targetEmp, fullName: "Plum Box", email: "plumbox@plumtrips.com", ownerId: oid(ids.target), workspaceId: WS, status: "ACTIVE", isActive: true,
  } as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  caller.current = "sa";
  await User.collection.updateOne({ _id: oid(ids.target) }, { $unset: { visibleNavGroups: 1 } });
  await NavPreferenceAudit.deleteMany({});
});

describe("who may set / read it", () => {
  for (const c of ["admin", "hr", "tenantAdmin", "saImpersonating"] as Caller[]) {
    it(`${c}: 403 on PUT and GET, nothing written`, async () => {
      caller.current = c;
      const p = await put(ids.target, { visibleNavGroups: PLUMBOX });
      expect(p.status).toBe(403);
      const g = await request(app()).get(`/api/admin/nav-preferences/${ids.target}`);
      expect(g.status).toBe(403);
      expect((await raw(ids.target)).visibleNavGroups).toBeUndefined();
      expect(await NavPreferenceAudit.countDocuments({})).toBe(0);
    });
  }
});

describe("SUPERADMIN set / clear", () => {
  it("sets the list, in order, and writes one audit row", async () => {
    const r = await put(ids.target, { visibleNavGroups: PLUMBOX });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: true, before: null, visibleNavGroups: PLUMBOX, email: "plumbox@plumtrips.com" });
    expect((await raw(ids.target)).visibleNavGroups).toEqual(PLUMBOX);
    const rows: any[] = await NavPreferenceAudit.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "plumbox@plumtrips.com", after: PLUMBOX, actorEmail: "sa@plumtrips.com", via: "api" });
    expect(rows[0].before).toBeUndefined();
    expect(String(rows[0].actorId)).toBe(ids.sa);
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it("duplicates collapse (first wins); a repeat is a no-op with no audit row", async () => {
    const r = await put(ids.target, { visibleNavGroups: ["travelbox", "travelAnalytics", "travelbox"] });
    expect(r.body.visibleNavGroups).toEqual(["travelbox", "travelAnalytics"]);
    const again = await put(ids.target, { visibleNavGroups: ["travelbox", "travelAnalytics"] });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(await NavPreferenceAudit.countDocuments({})).toBe(1);
  });

  for (const clear of [null, []] as any[]) {
    it(`clearing with ${JSON.stringify(clear)} UNSETS the field and audits before → null`, async () => {
      await put(ids.target, { visibleNavGroups: PLUMBOX });
      const r = await put(ids.target, { visibleNavGroups: clear });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ changed: true, before: PLUMBOX, visibleNavGroups: null });
      expect("visibleNavGroups" in (await raw(ids.target))).toBe(false);
      const last: any = await NavPreferenceAudit.findOne({}).sort({ createdAt: -1, _id: -1 }).lean();
      expect(last.before).toEqual(PLUMBOX);
      expect(last.after).toBeUndefined();
    });
  }

  it("rejects unknown keys, non-arrays, non-strings and a missing field — writes nothing", async () => {
    for (const body of [
      { visibleNavGroups: ["travelbox", "notAGroup"] },
      { visibleNavGroups: "travelbox" },
      { visibleNavGroups: [1, 2] },
      {},
    ]) {
      const r = await put(ids.target, body);
      expect(r.status).toBe(400);
    }
    expect((await raw(ids.target)).visibleNavGroups).toBeUndefined();
    expect(await NavPreferenceAudit.countDocuments({})).toBe(0);
  });

  it("404 for an unknown or malformed user id", async () => {
    expect((await put("66d0000000000000000000ff", { visibleNavGroups: PLUMBOX })).status).toBe(404);
    expect((await put("not-an-id", { visibleNavGroups: PLUMBOX })).status).toBe(404);
  });

  it("GET returns the value and its history", async () => {
    await put(ids.target, { visibleNavGroups: PLUMBOX });
    const g = await request(app()).get(`/api/admin/nav-preferences/${ids.target}`);
    expect(g.status).toBe(200);
    expect(g.body.visibleNavGroups).toEqual(PLUMBOX);
    expect(g.body.history).toHaveLength(1);
    expect(g.body.history[0].actorEmail).toBe("sa@plumtrips.com");
  });
});

describe("PUT /api/employees/:id cannot set it", () => {
  for (const c of ["admin", "sa"] as Caller[]) {
    it(`${c}: the field is dropped, the rest of the save still lands`, async () => {
      caller.current = c;
      const r = await request(app()).put(`/api/employees/${targetEmp}`).send({
        designation: `Demo account (${c})`,
        visibleNavGroups: ["admin"],
      });
      expect(r.status).toBe(200);
      const doc = await raw(ids.target);
      expect(doc.visibleNavGroups).toBeUndefined();
      expect(doc.designation).toBe(`Demo account (${c})`);
      expect(await NavPreferenceAudit.countDocuments({})).toBe(0);
    });
  }
});

describe("session user delivery", () => {
  it("the session user carries the list once set", async () => {
    await put(ids.target, { visibleNavGroups: PLUMBOX });
    const doc = await User.findById(ids.target);
    const { safe } = await buildAuthSafeUserCore(doc);
    expect(safe.visibleNavGroups).toEqual(PLUMBOX);
    expect(safe.roles).toContain("SUPERADMIN");
  });

  it("a user who never had it carries no visibleNavGroups key (no [] default)", async () => {
    const doc = await User.findById(ids.plain);
    const { safe } = await buildAuthSafeUserCore(doc);
    expect("visibleNavGroups" in safe).toBe(false);
    expect("visibleNavGroups" in new User({ email: "fresh@example.test" }).toObject()).toBe(false);
  });
});
