// apps/backend/src/routes/auth.loginDisabled.test.ts
//
// User.loginDisabled (utils/loginDisabled.ts) closes one login without
// touching status: login, refresh, forgot-password, reset-password (incl. a
// link issued BEFORE the flag), issueSetPasswordLink() and admin-set all
// refuse it, each with the same reply as an unknown account / bad token.
// Runs the real routers on in-memory Mongo; only the mailer is replaced.
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
vi.mock("../utils/mailer.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  sendMail: vi.fn(async (m: any) => {
    mails.push({ to: String(m?.to || "") });
    return { messageId: "test" };
  }),
}));

const { default: authRouter } = await import("./auth.js");
const { default: passwordRouter } = await import("./password.js");
const { issueSetPasswordLink, RESET_LINK_TTL_MS } = await import("../utils/setPasswordLink.js");
const { LoginDisabledError } = await import("../utils/loginDisabled.js");
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);
app.use("/api/password", passwordRouter);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message || err) }));

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const WS = oid();
const U = { front: oid(), real: oid() };
const PW = "Front-pass-123";

// VENDOR: external role, so login skips the staff UserPermission gate.
const base = { roles: ["VENDOR"], status: "ACTIVE", workspaceId: WS, passwordHash: bcrypt.hashSync(PW, 4) };
const FLAG = { loginDisabled: true, loginDisabledAt: new Date(), loginDisabledBy: "test", loginDisabledReason: "front" };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("auth-login-disabled-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  mails.length = 0;
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertOne({ _id: WS, companyName: "Plumtrips", status: "ACTIVE" } as any);
  // The front holds the gmail as email; the real account has it as personalEmail.
  await col("users").insertMany([
    { _id: U.front, email: "front@gmail.test", officialEmail: "front@gmail.test", ...base, ...FLAG },
    { _id: U.real, email: "real@plumtrips.test", personalEmail: "front@gmail.test", ...base },
  ] as any[]);
});

const login = (email: string, password: string) => request(app).post("/api/auth/login").send({ email, password });
const refreshAs = (id: any) =>
  request(app).post("/api/auth/refresh")
    .set("Cookie", [`refreshToken=${jwt.sign({ sub: String(id) }, process.env.JWT_REFRESH_SECRET!, { expiresIn: "1h" })}`]);
const user = async (id: any) => (await col("users").findOne({ _id: id })) as any;

describe("login", () => {
  it("refuses a disabled login with the unknown-address reply, even with the right password", async () => {
    const unknown = await login("nobody@gmail.test", PW);
    const res = await login("front@gmail.test", PW);
    expect(res.status).toBe(unknown.status);
    expect(res.body).toEqual(unknown.body);
    expect(res.body.accessToken).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/disabl/i);
    expect(res.headers["set-cookie"] ?? []).not.toEqual(expect.arrayContaining([expect.stringMatching(/^refreshToken=[^;]/)]));
    // SessionLog is written fire-and-forget — wait for it rather than race it
    await vi.waitFor(async () => {
      const failed = await col("sessionlogs").findOne({ email: "front@gmail.test", event: "LOGIN_FAILED" });
      expect(failed?.failureReason).toBe("login_disabled");
    }, { timeout: 5000 });
  });

  it("does not fall through to the real account that holds the gmail as personalEmail", async () => {
    const res = await login("front@gmail.test", PW);
    expect(res.status).toBe(400);
    // the real account still signs in by its own address
    const ok = await login("real@plumtrips.test", PW);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((jwt.decode(ok.body.accessToken) as any).sub ?? (jwt.decode(ok.body.accessToken) as any).userId).toBe(String(U.real));
  });

  it("an INACTIVE disabled login still gets the generic reply, not the deactivated one", async () => {
    await col("users").updateOne({ _id: U.front }, { $set: { status: "INACTIVE" } });
    const res = await login("front@gmail.test", PW);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/deactivat|disabl/i);
  });

  it("a cleared flag signs in again", async () => {
    await col("users").updateOne({ _id: U.front }, { $unset: { loginDisabled: "" } });
    expect((await login("front@gmail.test", PW)).status).toBe(200);
  });
});

describe("refresh", () => {
  it("refuses a disabled login like a missing user and clears the cookie", async () => {
    const missing = await refreshAs(oid());
    const res = await refreshAs(U.front);
    expect(res.status).toBe(missing.status);
    expect(res.body).toEqual(missing.body);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.headers["set-cookie"]).toEqual(expect.arrayContaining([expect.stringMatching(/^refreshToken=;/)]));
    expect((await refreshAs(U.real)).status).toBe(200);
  });
});

describe("forgot-password", () => {
  it("says ok, sends nothing and issues no token", async () => {
    const res = await request(app).post("/api/auth/forgot-password").send({ email: "front@gmail.test" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mails).toHaveLength(0);
    expect((await user(U.front)).resetTokenHash).toBeUndefined();
    // and the real account (which holds the gmail as personalEmail) is not picked instead
    expect((await user(U.real)).resetTokenHash).toBeUndefined();
  });
});

describe("reset-password", () => {
  it("a link issued BEFORE the flag is dead, with the bad-token reply", async () => {
    await col("users").updateOne({ _id: U.front }, { $unset: { loginDisabled: "" } });
    const link = await issueSetPasswordLink(U.front, RESET_LINK_TTL_MS);
    const token = new URL(link).searchParams.get("token")!;
    await col("users").updateOne({ _id: U.front }, { $set: { loginDisabled: true } });

    const bad = await request(app).post("/api/auth/reset-password").send({ token: "nope", newPassword: "Brand-new-pass-1" });
    const res = await request(app).post("/api/auth/reset-password").send({ token, newPassword: "Brand-new-pass-1" });
    expect(res.status).toBe(bad.status);
    expect(res.body).toEqual(bad.body);
    expect(await bcrypt.compare(PW, (await user(U.front)).passwordHash)).toBe(true);
  });
});

describe("forgot → reset for an enabled login", () => {
  it("still mails a link that sets the password", async () => {
    const res = await request(app).post("/api/auth/forgot-password").send({ email: "real@plumtrips.test" });
    expect(res.body).toEqual({ ok: true });
    expect(mails).toHaveLength(1);
    expect((await user(U.real)).resetTokenHash).toBeTruthy();
    const link = await issueSetPasswordLink(U.real, RESET_LINK_TTL_MS);
    const token = new URL(link).searchParams.get("token")!;
    const reset = await request(app).post("/api/auth/reset-password").send({ token, newPassword: "Brand-new-pass-1" });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(await bcrypt.compare("Brand-new-pass-1", (await user(U.real)).passwordHash)).toBe(true);
  });
});

describe("issueSetPasswordLink()", () => {
  it("refuses a disabled login and writes no token", async () => {
    await expect(issueSetPasswordLink(U.front, RESET_LINK_TTL_MS)).rejects.toBeInstanceOf(LoginDisabledError);
    expect((await user(U.front)).resetTokenHash).toBeUndefined();
    // the message reaches clients (customerUsers inviteEmailError) — it must
    // read exactly like a missing user
    const missing = await issueSetPasswordLink(oid(), RESET_LINK_TTL_MS).catch((e) => e);
    const disabled = await issueSetPasswordLink(U.front, RESET_LINK_TTL_MS).catch((e) => e);
    expect(missing.message).toMatch(/user not found/);
    expect(disabled.message).toBe(missing.message);
    await expect(issueSetPasswordLink(U.real, RESET_LINK_TTL_MS)).resolves.toMatch(/reset-password\?token=/);
  });
});

describe("password/admin-set", () => {
  const sa = () => jwt.sign({ sub: String(oid()), email: "sa@plumtrips.com", roles: ["SUPERADMIN"] }, process.env.JWT_SECRET!, { expiresIn: "1h" });
  const adminSet = (body: Record<string, unknown>) =>
    request(app).post("/api/password/admin-set").set("Authorization", `Bearer ${sa()}`)
      .send({ newPassword: "Admin-chosen-1", targetWorkspaceId: String(WS), ...body });

  it("refuses by id and by email with the not-found reply; the hash is untouched", async () => {
    const missing = await adminSet({ userId: String(oid()) });
    expect(missing.status).toBe(404);
    for (const body of [{ userId: String(U.front) }, { email: "front@gmail.test" }]) {
      const res = await adminSet(body);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(missing.body);
    }
    expect(await bcrypt.compare(PW, (await user(U.front)).passwordHash)).toBe(true);
    // an enabled login still works
    expect((await adminSet({ userId: String(U.real) })).status).toBe(200);
  });
});

describe("the flag touches nothing else", () => {
  it("status stays ACTIVE", async () => {
    await login("front@gmail.test", PW);
    await refreshAs(U.front);
    expect((await user(U.front)).status).toBe("ACTIVE");
  });
});
