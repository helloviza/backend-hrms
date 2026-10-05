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

/* ═════════════════ company overrides + change log ═════════════════ */

describe("company overrides and the change log", () => {
  const ACME = new mongoose.Types.ObjectId();
  const SA = user(["SUPERADMIN"]);
  const putOv = (body: unknown, u = SA, ws = String(ACME)) =>
    request(app).put(`/api/admin/sbt/margins/overrides/${ws}`).set("x-test-user", u).send(body as any);
  const OVERRIDE = { flight: { domestic: 2, international: null }, hotel: { domestic: -5, international: null }, reason: "Q4 retention deal" };

  beforeEach(async () => {
    for (const c of ["sbtmarginoverrides", "sbtmarginchanges", "customerworkspaces", "users"]) await col(c).deleteMany({});
    await col("customerworkspaces").insertMany([
      { _id: ACME, customerId: "CUST-ACME", companyName: "Acme Corp", status: "ACTIVE" },
      { _id: new mongoose.Types.ObjectId(), customerId: "CUST-BETA", companyName: "Beta Ltd", status: "ACTIVE" },
    ] as any[]);
    await col("users").insertOne({ _id: SUPER, email: "x@test", firstName: "Imran", lastName: "Ali" } as any);
  });

  it("only a SUPERADMIN can read or change overrides and history", async () => {
    for (const u of [user(["ADMIN"]), user(["TENANT_ADMIN"]), user(["HR"]), user(["OPS"]), user(["SUPERADMIN"], { _demoImpersonation: true })]) {
      expect((await putOv(OVERRIDE, u)).status).toBe(403);
      expect((await request(app).delete(`/api/admin/sbt/margins/overrides/${ACME}`).set("x-test-user", u).send({ reason: "x" })).status).toBe(403);
      const h = await request(app).get("/api/admin/sbt/margins/history").set("x-test-user", u);
      expect(h.status).toBe(403);
      expect(h.body.changes).toBeUndefined();
      expect((await request(app).get("/api/admin/sbt/margins/companies").set("x-test-user", u)).status).toBe(403);
    }
    expect(await col("sbtmarginoverrides").countDocuments()).toBe(0);
    expect(await col("sbtmarginchanges").countDocuments()).toBe(0);
  });

  it("add → edit → remove: each change is logged with who, when, old → new and the reason", async () => {
    const add = await putOv(OVERRIDE);
    expect(add.status).toBe(200);
    const row: any = await col("sbtmarginoverrides").findOne({ workspaceId: ACME });
    expect(row).toMatchObject({
      flight: { domestic: 2, international: null }, hotel: { domestic: -5, international: null },
      reason: "Q4 retention deal", validUntil: null,
    });

    const edit = await putOv({ ...OVERRIDE, flight: { domestic: 3, international: 4 }, reason: "Renewed", validUntil: "2099-12-31" });
    expect(edit.status).toBe(200);
    const edited: any = await col("sbtmarginoverrides").findOne({ workspaceId: ACME });
    expect(edited.flight).toEqual({ domestic: 3, international: 4 });
    // A date = the end of that day in India.
    expect(new Date(edited.validUntil).toISOString()).toBe("2099-12-31T18:29:59.999Z");

    const del = await request(app).delete(`/api/admin/sbt/margins/overrides/${ACME}`).set("x-test-user", SA).send({ reason: "Contract ended" });
    expect(del.status).toBe(200);
    expect(await col("sbtmarginoverrides").countDocuments()).toBe(0);

    const h = await request(app).get(`/api/admin/sbt/margins/history?workspaceId=${ACME}`).set("x-test-user", SA);
    expect(h.status).toBe(200);
    expect(h.body.changes.map((c: any) => c.action)).toEqual(["REMOVE", "UPDATE", "CREATE"]);
    const [removed, updated, created] = h.body.changes;
    expect(created).toMatchObject({ scope: "WORKSPACE", workspaceName: "Acme Corp", before: null, reason: "Q4 retention deal", actorName: "Imran Ali" });
    expect(created.after.flight).toEqual({ domestic: 2, international: null });
    expect(updated.before.flight).toEqual({ domestic: 2, international: null });
    expect(updated.after.flight).toEqual({ domestic: 3, international: 4 });
    expect(updated.reason).toBe("Renewed");
    expect(removed).toMatchObject({ after: null, reason: "Contract ended" });
    expect(Number.isNaN(Date.parse(removed.at))).toBe(false);
  });

  it("the defaults: version goes up on every save, and the change is logged", async () => {
    await request(app).put("/api/admin/sbt/margins").set("x-test-user", SA).send({ ...VALID, reason: "Annual review" });
    await request(app).put("/api/admin/sbt/margins").set("x-test-user", SA).send({ ...VALID, enabled: false });
    expect((await stored()).version).toBe(2);
    const h = await request(app).get("/api/admin/sbt/margins/history").set("x-test-user", SA);
    expect(h.body.changes).toHaveLength(2);
    expect(h.body.changes[1]).toMatchObject({ scope: "DEFAULTS", reason: "Annual review" });
    expect(h.body.changes[1].before.flight).toEqual({ domestic: 1, international: 1 });
    expect(h.body.changes[1].after).toMatchObject({ enabled: true, version: 1, flight: { domestic: 3, international: 5 } });
    expect(h.body.changes[0].after).toMatchObject({ enabled: false, version: 2 });
  });

  it("GET lists each override with its company, 'use default' cells as null, and expiry", async () => {
    await putOv(OVERRIDE);
    await col("sbtmarginoverrides").updateOne({ workspaceId: ACME }, { $set: { validUntil: new Date(Date.now() - 1000) } });
    const g = await request(app).get("/api/admin/sbt/margins").set("x-test-user", SA);
    expect(g.status).toBe(200);
    expect(g.body.limits).toEqual({ min: -10, max: 50 });
    expect(g.body.overrides).toHaveLength(1);
    expect(g.body.overrides[0]).toMatchObject({
      workspaceId: String(ACME), companyName: "Acme Corp", flight: { domestic: 2, international: null },
      reason: "Q4 retention deal", expired: true, updatedByName: "Imran Ali",
    });
  });

  it("company search marks companies that already have an override", async () => {
    await putOv(OVERRIDE);
    const r = await request(app).get("/api/admin/sbt/margins/companies?q=acme").set("x-test-user", SA);
    expect(r.body.companies).toEqual([{ workspaceId: String(ACME), companyName: "Acme Corp", isHouse: false, hasOverride: true }]);
  });

  const badOverrides: Array<[string, unknown]> = [
    ["no reason", { ...OVERRIDE, reason: "  " }],
    ["below −10", { ...OVERRIDE, hotel: { domestic: -11, international: null } }],
    ["above 50", { ...OVERRIDE, flight: { domestic: 51, international: null } }],
    ["a numeric string", { ...OVERRIDE, flight: { domestic: "2", international: null } }],
    ["nothing set", { flight: { domestic: null, international: null }, hotel: { domestic: null, international: null }, reason: "x" }],
    ["an end date in the past", { ...OVERRIDE, validUntil: "2020-01-01" }],
    ["a bad end date", { ...OVERRIDE, validUntil: "soon" }],
  ];
  for (const [what, body] of badOverrides) {
    it(`override refused: ${what} — nothing saved, nothing logged`, async () => {
      const r = await putOv(body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBeTruthy();
      expect(await col("sbtmarginoverrides").countDocuments()).toBe(0);
      expect(await col("sbtmarginchanges").countDocuments()).toBe(0);
    });
  }

  it("unknown company → 404; removing needs a reason", async () => {
    expect((await putOv(OVERRIDE, SA, String(new mongoose.Types.ObjectId()))).status).toBe(404);
    await putOv(OVERRIDE);
    const r = await request(app).delete(`/api/admin/sbt/margins/overrides/${ACME}`).set("x-test-user", SA).send({});
    expect(r.status).toBe(400);
    expect(await col("sbtmarginoverrides").countDocuments()).toBe(1);
  });

  it("the change log cannot be edited or deleted through the model", async () => {
    await putOv(OVERRIDE);
    const SBTMarginChange = mongoose.model("SBTMarginChange");
    await expect(SBTMarginChange.updateOne({}, { $set: { reason: "rewritten" } })).rejects.toThrow(/append-only/);
    await expect(SBTMarginChange.deleteMany({})).rejects.toThrow(/append-only/);
    expect(await col("sbtmarginchanges").countDocuments()).toBe(1);
  });
});
