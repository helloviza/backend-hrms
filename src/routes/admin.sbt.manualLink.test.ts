// apps/backend/src/routes/admin.sbt.manualLink.test.ts
//
// The SBT → Manual Booking link switch (docs/specs/sbt-to-manual-booking-spec.md
// P1): SUPERADMIN only, default OFF, the first switch-on stamps
// manualLinkEnabledAt and later toggles never move it.
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
const { manualLinkSettings } = await import("../services/sbtManualLink.js");
const app = express();
app.use(express.json());
app.use("/api/admin/sbt", adminSbtRouter);

let mongod: MongoMemoryServer;
const ID = new mongoose.Types.ObjectId();
const user = (roles: string[]) => JSON.stringify({ _id: String(ID), id: String(ID), sub: String(ID), email: "x@test", roles });
const SA = user(["SUPERADMIN"]);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("admin-sbt-manual-link-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.collection("sbtconfigs").deleteMany({});
});

describe("manual-link switch", () => {
  it("is OFF by default", async () => {
    const res = await request(app).get("/api/admin/sbt/manual-link").set("x-test-user", SA);
    expect(res.body).toMatchObject({ ok: true, enabled: false, enabledAt: null });
  });

  it("platform ADMIN cannot read or flip it", async () => {
    const u = user(["ADMIN"]);
    expect((await request(app).get("/api/admin/sbt/manual-link").set("x-test-user", u)).status).toBe(403);
    expect((await request(app).put("/api/admin/sbt/manual-link").set("x-test-user", u).send({ enabled: true })).status).toBe(403);
  });

  it("first ON stamps enabledAt once; OFF / ON again keep it; the service sees it at once", async () => {
    const on = await request(app).put("/api/admin/sbt/manual-link").set("x-test-user", SA).send({ enabled: true });
    expect(on.body.enabled).toBe(true);
    const stamped = on.body.enabledAt;
    expect(stamped).toBeTruthy();
    expect(await manualLinkSettings()).toMatchObject({ enabled: true });

    await request(app).put("/api/admin/sbt/manual-link").set("x-test-user", SA).send({ enabled: false });
    expect(await manualLinkSettings()).toMatchObject({ enabled: false });
    const again = await request(app).put("/api/admin/sbt/manual-link").set("x-test-user", SA).send({ enabled: true });
    expect(again.body.enabledAt).toBe(stamped);
  });

  it("refuses a non-boolean", async () => {
    expect((await request(app).put("/api/admin/sbt/manual-link").set("x-test-user", SA).send({ enabled: "yes" })).status).toBe(400);
  });
});
