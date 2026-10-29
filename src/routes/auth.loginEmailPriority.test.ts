// apps/backend/src/routes/auth.loginEmailPriority.test.ts
//
// An address can be one user's `email` and another user's officialEmail /
// personalEmail. Login and forgot-password must pick the same account every
// time: email → officialEmail → personalEmail, and an ambiguous fallback is
// refused exactly like an unknown address. Runs the real auth router on
// in-memory Mongo; only the mailer is replaced.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

process.env.NODE_ENV = "test";
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  JWT_SECRET: "jwt-secret-for-tests",
  JWT_REFRESH_SECRET: "refresh-secret-for-tests",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
})) process.env[k] ||= v;

const mails: Array<{ to: string }> = [];
vi.mock("../utils/mailer.js", () => ({
  sendMail: async (m: any) => {
    mails.push({ to: String(m?.to || "") });
    return { messageId: "test" };
  },
}));

const { default: authRouter } = await import("./auth.js");
const { findUserByLoginEmail } = await import("../utils/loginEmailLookup.js");
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const WS_1 = oid();
const WS_2 = oid();

const U = {
  owner: oid(), //      email shared@        — owns the address
  shadow: oid(), //     personalEmail shared@ — must never win it
  official: oid(), //   officialEmail off@
  personal: oid(), //   personalEmail off@    — loses to officialEmail
  amb1: oid(), //       personalEmail amb@
  amb2: oid(), //       personalEmail amb@    — two fallbacks → refuse
  plain: oid(), //      ordinary single account
};

// VENDOR: an external role, so login skips the staff UserPermission gate and
// the customer auto-link — the lookup is the only thing under test.
const base = (pw: string) => ({ roles: ["VENDOR"], status: "ACTIVE", passwordHash: bcrypt.hashSync(pw, 4) });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("auth-login-email-priority-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  mails.length = 0;
  await mongoose.connection.db!.dropDatabase();
  await col("users").insertMany([
    // the shadow is OLDER, so natural order alone would have returned it first
    { _id: U.shadow, email: "shadow@x.test", personalEmail: "shared@x.test", workspaceId: WS_1, ...base("pw-shadow") },
    { _id: U.owner, email: "shared@x.test", workspaceId: WS_2, ...base("pw-owner") },
    { _id: U.personal, email: "p@x.test", personalEmail: "off@x.test", workspaceId: WS_1, ...base("pw-personal") },
    { _id: U.official, email: "o@x.test", officialEmail: "off@x.test", workspaceId: WS_1, ...base("pw-official") },
    { _id: U.amb1, email: "a1@x.test", personalEmail: "amb@x.test", workspaceId: WS_1, ...base("pw-amb") },
    { _id: U.amb2, email: "a2@x.test", personalEmail: "amb@x.test", workspaceId: WS_2, ...base("pw-amb") },
    { _id: U.plain, email: "plain@x.test", workspaceId: WS_1, ...base("pw-plain") },
  ] as any[]);
});

const login = (email: string, password: string) => request(app).post("/api/auth/login").send({ email, password });
const loggedInAs = (res: any) => String((jwt.decode(res.body.accessToken) as any)?.sub ?? (jwt.decode(res.body.accessToken) as any)?.userId);

describe("login: which account an address signs in to", () => {
  it("an exact email match wins over another user's personalEmail", async () => {
    const ok = await login("Shared@X.test", "pw-owner");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(loggedInAs(ok)).toBe(String(U.owner));

    // the shadow's password does not open the owner's address
    const shadow = await login("shared@x.test", "pw-shadow");
    expect(shadow.status).toBe(400);
    expect(shadow.body).toEqual({ error: "Invalid credentials" });
  });

  it("falls back to officialEmail before personalEmail", async () => {
    const res = await login("off@x.test", "pw-official");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(loggedInAs(res)).toBe(String(U.official));
    expect((await login("off@x.test", "pw-personal")).status).toBe(400);
  });

  it("a fallback matching two users is refused exactly like an unknown address", async () => {
    const unknown = await login("nobody@x.test", "pw-amb");
    const amb = await login("amb@x.test", "pw-amb");
    expect(amb.status).toBe(unknown.status);
    expect(amb.body).toEqual(unknown.body);
    expect(amb.body.accessToken).toBeUndefined();
    // SessionLog is written fire-and-forget — wait for it rather than race it
    await vi.waitFor(async () => {
      const failed = await col("sessionlogs").findOne({ email: "amb@x.test", event: "LOGIN_FAILED" });
      expect(failed?.failureReason).toBe("ambiguous_email");
    }, { timeout: 5000 });
    // each account still signs in by its own email
    expect(loggedInAs(await login("a1@x.test", "pw-amb"))).toBe(String(U.amb1));
  });

  it("an ordinary single-account login is unchanged", async () => {
    const res = await login("plain@x.test", "pw-plain");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(loggedInAs(res)).toBe(String(U.plain));
    expect((await login("plain@x.test", "wrong")).body).toEqual({ error: "Invalid credentials" });
  });
});

describe("forgot-password picks the account login would", () => {
  const tokenOn = async (id: mongoose.Types.ObjectId) => !!(await col("users").findOne({ _id: id }))?.resetTokenHash;

  it("sends the reset for the email owner, not the personalEmail shadow", async () => {
    const res = await request(app).post("/api/auth/forgot-password").send({ email: "shared@x.test" });
    expect(res.body).toEqual({ ok: true });
    expect(await tokenOn(U.owner)).toBe(true);
    expect(await tokenOn(U.shadow)).toBe(false);
    expect(mails.map((m) => m.to)).toEqual(["shared@x.test"]);
  });

  it("uses the officialEmail fallback like login", async () => {
    await request(app).post("/api/auth/forgot-password").send({ email: "off@x.test" });
    expect(await tokenOn(U.official)).toBe(true);
    expect(await tokenOn(U.personal)).toBe(false);
  });

  it("an ambiguous address answers ok but resets nobody", async () => {
    const res = await request(app).post("/api/auth/forgot-password").send({ email: "amb@x.test" });
    expect(res.body).toEqual({ ok: true });
    expect(await tokenOn(U.amb1)).toBe(false);
    expect(await tokenOn(U.amb2)).toBe(false);
    expect(mails).toHaveLength(0);
  });
});

describe("findUserByLoginEmail scope (admin password set)", () => {
  it("applies the order inside the given workspace only", async () => {
    // in WS_1 alone, amb@ is a single personalEmail match
    const inWs1 = await findUserByLoginEmail("amb@x.test", { scope: { workspaceId: WS_1 } });
    expect(String(inWs1.user?._id)).toBe(String(U.amb1));
    expect(inWs1.field).toBe("personalEmail");
    // shared@ is not anyone's email in WS_1, so the shadow is found there
    const shared = await findUserByLoginEmail("shared@x.test", { scope: { workspaceId: WS_1 } });
    expect(String(shared.user?._id)).toBe(String(U.shadow));
    const everywhere = await findUserByLoginEmail("amb@x.test");
    expect(everywhere).toMatchObject({ user: null, ambiguous: true });
    expect(everywhere.candidateIds.sort()).toEqual([String(U.amb1), String(U.amb2)].sort());
  });
});
