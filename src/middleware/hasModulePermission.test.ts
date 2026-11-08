// B4 — hasModulePermission must answer exactly what requirePermission enforces
// (audit H5: the UI edit gate must equal the server gate). Each case runs BOTH
// against the same real UserPermission collection and asserts they agree.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const { UserPermission } = await import("../models/UserPermission.js");
const { requirePermission, hasModulePermission } = await import("./requirePermission.js");

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await UserPermission.deleteMany({});
});

async function middlewarePasses(req: any, module: string, min: "READ" | "WRITE" | "FULL"): Promise<boolean> {
  let passed = false;
  const res: any = { status: () => res, json: () => res };
  await requirePermission(module, min)(req, res, () => {
    passed = true;
  });
  return passed;
}

const uid = () => String(new mongoose.Types.ObjectId());

async function grant(userId: string, access: string | null) {
  await UserPermission.collection.insertOne({
    userId,
    level: { code: "L3" },
    modules: access === null ? {} : { people: { access, scope: "WORKSPACE" } },
  } as any);
}

describe("hasModulePermission ⇔ requirePermission('people','WRITE')", () => {
  const cases: Array<[string, () => Promise<any>, boolean]> = [
    ["isSuperAdmin flag", async () => ({ user: { sub: uid(), isSuperAdmin: true } }), true],
    ["roles SUPERADMIN", async () => ({ user: { sub: uid(), roles: ["SUPERADMIN"] } }), true],
    ["no user id", async () => ({ user: {} }), false],
    ["no permission doc", async () => ({ user: { sub: uid(), roles: ["EMPLOYEE"] } }), false],
    ["people module absent", async () => { const id = uid(); await grant(id, null); return { user: { sub: id } }; }, false],
    ["people NONE", async () => { const id = uid(); await grant(id, "NONE"); return { user: { sub: id } }; }, false],
    ["people READ", async () => { const id = uid(); await grant(id, "READ"); return { user: { sub: id } }; }, false],
    ["people WRITE", async () => { const id = uid(); await grant(id, "WRITE"); return { user: { sub: id } }; }, true],
    ["people FULL", async () => { const id = uid(); await grant(id, "FULL"); return { user: { sub: id } }; }, true],
    [
      "demo impersonation + roles SUPERADMIN (isSuperAdmin refused, roles branch still passes)",
      async () => ({ user: { sub: uid(), roles: ["SUPERADMIN"], _demoImpersonation: true } }),
      true,
    ],
  ];

  for (const [name, mk, expected] of cases) {
    it(name, async () => {
      const req = await mk();
      const viaMiddleware = await middlewarePasses(req, "people", "WRITE");
      const viaHelper = await hasModulePermission(req, "people", "WRITE");
      expect(viaHelper).toBe(viaMiddleware);
      expect(viaHelper).toBe(expected);
    });
  }
});
