// Guard-level coverage for requireConsumer, against a REAL Consumer
// collection (mongodb-memory-server) — no mocks. The tokenVersion revocation
// check is a live DB comparison, so faking the model would test nothing.
//
// The secrets are set BEFORE any import that reads them, and the modules
// under test read process.env per call, so no dynamic-import gymnastics are
// needed.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";

const B2B_SECRET = "b2b-jwt-secret-for-tests";
const CONSUMER_SECRET = "consumer-jwt-secret-for-tests";
process.env.JWT_SECRET = B2B_SECRET;
process.env.CONSUMER_JWT_SECRET = CONSUMER_SECRET;

const { default: Consumer } = await import("../models/Consumer.js");
const { requireConsumer } = await import("./requireConsumer.js");
const { signConsumerAccessToken, signConsumerRefreshToken } = await import(
  "../utils/consumerJwt.js"
);
const { CONSUMER_ACCESS_COOKIE } = await import("../config/consumerAuth.js");
const { HELLOVIZA_D2C_WORKSPACE_ID } = await import("../services/consumerWorkspace.js");

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
  await Consumer.deleteMany({});
});

// A probe app that reports exactly what requireConsumer attached — including
// whether req.user was touched, which is the rule this guard must never break.
function probeApp() {
  const app = express();
  app.use(cookieParser());
  app.get("/probe", requireConsumer, (req: any, res) => {
    res.json({
      consumer: req.consumer ?? null,
      consumerWorkspaceId: req.consumerWorkspaceId ?? null,
      userWasSet: req.user !== undefined,
    });
  });
  return app;
}

async function makeConsumer(overrides: Record<string, any> = {}) {
  return Consumer.create({
    email: overrides.email ?? "a@example.com",
    name: overrides.name ?? "A Consumer",
    passwordHash: "not-used-here",
    ...overrides,
  });
}

describe("requireConsumer — rejection", () => {
  it("401s with no token at all", async () => {
    const res = await request(probeApp()).get("/probe");
    expect(res.status).toBe(401);
  });

  it("401s on a real B2B token — THE WALL, direction 1", async () => {
    const b2b = jwt.sign(
      { sub: "507f1f77bcf86cd799439011", roles: ["SUPERADMIN"], email: "staff@plumtrips.com" },
      B2B_SECRET,
      { expiresIn: "30m" },
    );
    const res = await request(probeApp()).get("/probe").set("Authorization", `Bearer ${b2b}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid token");
  });

  it("401s on a B2B token forged to carry aud CONSUMER — the SECRET is the wall", async () => {
    const forged = jwt.sign(
      { sub: "507f1f77bcf86cd799439011", tokenVersion: 0, aud: "CONSUMER", typ: "access" },
      B2B_SECRET,
      { expiresIn: "30m" },
    );
    const res = await request(probeApp()).get("/probe").set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it("401s on a consumer refresh token used as an access token", async () => {
    const c = await makeConsumer();
    const refresh = signConsumerRefreshToken({ consumerId: String(c._id), tokenVersion: 0 });
    const res = await request(probeApp()).get("/probe").set("Authorization", `Bearer ${refresh}`);
    expect(res.status).toBe(401);
  });

  it("401s when the consumer no longer exists", async () => {
    const orphan = signConsumerAccessToken({
      consumerId: String(new mongoose.Types.ObjectId()),
      tokenVersion: 0,
    });
    const res = await request(probeApp()).get("/probe").set("Authorization", `Bearer ${orphan}`);
    expect(res.status).toBe(401);
  });

  it("403s when the consumer is DISABLED", async () => {
    const c = await makeConsumer({ status: "DISABLED" });
    const token = signConsumerAccessToken({ consumerId: String(c._id), tokenVersion: 0 });
    const res = await request(probeApp()).get("/probe").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("401s when tokenVersion is stale — REVOCATION", async () => {
    const c = await makeConsumer();
    const token = signConsumerAccessToken({ consumerId: String(c._id), tokenVersion: 0 });

    // Token works before revocation…
    expect((await request(probeApp()).get("/probe").set("Authorization", `Bearer ${token}`)).status).toBe(200);

    await Consumer.updateOne({ _id: c._id }, { $inc: { tokenVersion: 1 } });

    // …and is dead immediately after, with no waiting for expiry.
    const res = await request(probeApp()).get("/probe").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Session has been revoked");
  });
});

describe("requireConsumer — acceptance", () => {
  it("accepts a valid Bearer token and attaches req.consumer", async () => {
    const c = await makeConsumer({ email: "ok@example.com", name: "Valid" });
    const token = signConsumerAccessToken({ consumerId: String(c._id), tokenVersion: 0 });
    const res = await request(probeApp()).get("/probe").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.consumer).toMatchObject({
      id: String(c._id),
      email: "ok@example.com",
      name: "Valid",
      tokenVersion: 0,
    });
  });

  it("accepts the token from the consumer cookie as well as the header", async () => {
    const c = await makeConsumer();
    const token = signConsumerAccessToken({ consumerId: String(c._id), tokenVersion: 0 });
    const res = await request(probeApp())
      .get("/probe")
      .set("Cookie", `${CONSUMER_ACCESS_COOKIE}=${token}`);
    expect(res.status).toBe(200);
  });

  it("ignores B2B cookie names — it reads ONE name only", async () => {
    const c = await makeConsumer();
    const token = signConsumerAccessToken({ consumerId: String(c._id), tokenVersion: 0 });
    // Every cookie name middleware/auth.ts scavenges, carrying a VALID
    // consumer token. requireConsumer must still refuse: a guard whose
    // accepted surface nobody can enumerate is the thing being avoided.
    const res = await request(probeApp())
      .get("/probe")
      .set("Cookie", [
        `hrms_accessToken=${token}`,
        `accessToken=${token}`,
        `token=${token}`,
        `jwt=${token}`,
        `auth=${token}`,
      ]);
    expect(res.status).toBe(401);
  });

  it("stamps the fixed D2C workspace id, deterministically", async () => {
    const c = await makeConsumer();
    const token = signConsumerAccessToken({ consumerId: String(c._id), tokenVersion: 0 });
    const res = await request(probeApp()).get("/probe").set("Authorization", `Bearer ${token}`);
    expect(res.body.consumerWorkspaceId).toBe(HELLOVIZA_D2C_WORKSPACE_ID);
    expect(res.body.consumerWorkspaceId).toBe("d2c00000000000000000d2c1");
  });

  it("NEVER sets req.user — the hard rule", async () => {
    // req.user is what requireWorkspace, requirePermission, requireFeature,
    // isSuperAdmin, requireRoles and requireAdmin all read, and none of them
    // verifies anything. Setting it here would hand a consumer identity to
    // every one of them at once.
    const c = await makeConsumer();
    const token = signConsumerAccessToken({ consumerId: String(c._id), tokenVersion: 0 });
    const res = await request(probeApp()).get("/probe").set("Authorization", `Bearer ${token}`);
    expect(res.body.userWasSet).toBe(false);
  });
});
