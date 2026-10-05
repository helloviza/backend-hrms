// apps/backend/src/routes/admin.sbt.margins.test.ts
//
// The SBT margin settings are Plumtrips' markup on every customer's fares:
// only a SUPERADMIN may read or change them, and every value is validated on
// the server (a number between −10 and 50), never trusted from the page.
//
// Real: admin.sbt router incl. requireAdmin + requireSuperAdmin, SBTConfig, in-memory Mongo.
// Stubbed: requireAuth (user from a header).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});

const { default: adminSbtRouter } = await import("./admin.sbt.js");
const app = express();
app.use(express.json());
app.use("/api/admin/sbt", adminSbtRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);

const SUPER = new mongoose.Types.ObjectId();
const user = (roles: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ _id: String(SUPER), id: String(SUPER), sub: String(SUPER), email: "x@test", roles, ...extra });

const VALID = { enabled: true, flight: { domestic: 3, international: 5 }, hotel: { domestic: 8, international: 10 } };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("admin-sbt-margins-test"));
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await col("sbtconfigs").deleteMany({});
  await col("sbtconfigs").insertOne({ key: "margins", value: { enabled: false, flight: { domestic: 1, international: 1 }, hotel: { domestic: 1, international: 1 } } } as any);
});

const stored = async () => ((await col("sbtconfigs").findOne({ key: "margins" })) as any).value;

describe("margin settings — SUPERADMIN only", () => {
  const others: Array<[string, string]> = [
    ["tenant admin", user(["TENANT_ADMIN"])],
    ["workspace admin", user(["WORKSPACE_ADMIN"])],
    ["HR", user(["HR"])],
    ["OPS", user(["OPS"])],
    ["platform ADMIN", user(["ADMIN"])],
    ["HR access level", user(["EMPLOYEE"], { hrmsAccessLevel: "HR" })],
    ["SUPERADMIN while impersonating a demo user", user(["SUPERADMIN"], { _demoImpersonation: true })],
  ];

  for (const [who, u] of others) {
    it(`${who}: cannot read or change margins`, async () => {
      const get = await request(app).get("/api/admin/sbt/margins").set("x-test-user", u);
      expect(get.status).toBe(403);
      expect(get.body.margins).toBeUndefined();
      const put = await request(app).put("/api/admin/sbt/margins").set("x-test-user", u).send(VALID);
      expect(put.status).toBe(403);
      expect((await stored()).flight.domestic).toBe(1);
    });
  }

  it("SUPERADMIN reads and saves, and is recorded as the last editor", async () => {
    const get = await request(app).get("/api/admin/sbt/margins").set("x-test-user", user(["SUPERADMIN"]));
    expect(get.status).toBe(200);
    const put = await request(app).put("/api/admin/sbt/margins").set("x-test-user", user(["SUPERADMIN"])).send(VALID);
    expect(put.status).toBe(200);
    const v = await stored();
    expect(v).toMatchObject({ enabled: true, flight: { domestic: 3, international: 5 }, hotel: { domestic: 8, international: 10 } });
    expect(v.updatedBy).toBe(String(SUPER));
    expect(Number.isNaN(Date.parse(v.updatedAt))).toBe(false);
  });
});

describe("margin settings — server-side validation", () => {
  const put = (body: unknown) =>
    request(app).put("/api/admin/sbt/margins").set("x-test-user", user(["SUPERADMIN"])).send(body as any);

  it("accepts the edges −10 and 50", async () => {
    const res = await put({ ...VALID, flight: { domestic: -10, international: 50 } });
    expect(res.status).toBe(200);
    expect((await stored()).flight).toEqual({ domestic: -10, international: 50 });
  });

  const bad: Array<[string, unknown]> = [
    ["below −10", { ...VALID, hotel: { domestic: -10.5, international: 10 } }],
    ["above 50", { ...VALID, flight: { domestic: 51, international: 5 } }],
    ["a numeric string", { ...VALID, flight: { domestic: "5", international: 5 } }],
    ["text", { ...VALID, hotel: { domestic: "abc", international: 10 } }],
    ["null", { ...VALID, hotel: { domestic: null, international: 10 } }],
    ["a missing value", { ...VALID, hotel: { domestic: 8 } }],
    ["a missing product", { enabled: true, flight: VALID.flight }],
    ["enabled not a boolean", { ...VALID, enabled: "yes" }],
    ["an empty body", {}],
  ];
  for (const [what, body] of bad) {
    it(`refuses ${what} and leaves the settings unchanged`, async () => {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
      expect((await stored()).flight.domestic).toBe(1);
    });
  }
});
