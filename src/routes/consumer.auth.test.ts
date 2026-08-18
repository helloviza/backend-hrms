// Full HTTP coverage for the consumer auth surface, against a real
// mongodb-memory-server. Never imports server.ts (that would boot the whole
// app and dial the production cluster the dev backend points at) — a minimal
// express app mounts the real router at the real prefix instead.
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
process.env.CONSUMER_COOKIE_DOMAIN = ".helloviza.ai";
process.env.COOKIE_DOMAIN = ".plumtrips.com";

// config/env.ts hard-requires these and throws at import time without them.
// The "consumer token vs the REAL requireAuth" test below imports
// middleware/auth.ts on purpose, which pulls config/env.ts in. The worktree
// has no .env (correctly gitignored). Nothing under test reads these.
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-wall-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { default: Consumer } = await import("../models/Consumer.js");
const { default: consumerAuthRouter } = await import("./consumer.auth.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const {
  ensureD2CWorkspace,
  HELLOVIZA_D2C_WORKSPACE_ID,
  HELLOVIZA_D2C_CUSTOMER_ID,
} = await import("../services/consumerWorkspace.js");
const { CONSUMER_ACCESS_COOKIE, CONSUMER_REFRESH_COOKIE } = await import(
  "../config/consumerAuth.js"
);

let mongod: MongoMemoryServer;

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use("/api/consumer/auth", consumerAuthRouter);
  return a;
}

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

const SIGNUP = {
  email: "First@Example.com",
  name: "First Consumer",
  password: "correct horse battery",
  phone: "+919876543210",
};

async function signup(overrides: Record<string, any> = {}) {
  return request(app()).post("/api/consumer/auth/signup").send({ ...SIGNUP, ...overrides });
}

/** Every Set-Cookie string on a response. supertest types this loosely. */
function setCookies(res: any): string[] {
  return (res.headers["set-cookie"] as string[] | undefined) ?? [];
}

/** The Set-Cookie string for one cookie name. */
function cookieHeader(res: any, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

/** "name=value" pairs suitable for a Cookie request header. */
function cookiePairs(res: any): string[] {
  return setCookies(res).map((c) => c.split(";")[0]);
}

describe("POST /signup", () => {
  it("creates a consumer, normalises the email and issues a session", async () => {
    const res = await signup();
    expect(res.status).toBe(201);
    expect(res.body.consumer.email).toBe("first@example.com");
    expect(res.body.consumer.name).toBe("First Consumer");
    expect(res.body.accessToken).toBeTruthy();
    // The id is exposed; the hash never is.
    expect(res.body.consumer.passwordHash).toBeUndefined();

    const stored: any = await Consumer.findOne({ email: "first@example.com" }).select("+passwordHash");
    expect(stored).toBeTruthy();
    expect(stored.tokenVersion).toBe(0);
    expect(stored.status).toBe("ACTIVE");
    // bcrypt, not plaintext.
    expect(stored.passwordHash).not.toBe(SIGNUP.password);
    expect(stored.passwordHash.startsWith("$2")).toBe(true);
  });

  it("does not return passwordHash by default (select:false)", async () => {
    await signup();
    const lean: any = await Consumer.findOne({ email: "first@example.com" }).lean();
    expect(lean.passwordHash).toBeUndefined();
  });

  it("409s on a duplicate consumer email", async () => {
    await signup();
    const res = await signup();
    expect(res.status).toBe(409);
  });

  it("validates email, name and password length", async () => {
    expect((await signup({ email: "not-an-email" })).status).toBe(400);
    expect((await signup({ name: "  " })).status).toBe(400);
    expect((await signup({ password: "short" })).status).toBe(400);
  });

  it("issues the token with the CONSUMER secret, not JWT_SECRET", async () => {
    const res = await signup();
    const token = res.body.accessToken;
    expect(() => jwt.verify(token, CONSUMER_SECRET)).not.toThrow();
    expect(() => jwt.verify(token, B2B_SECRET)).toThrow(/invalid signature/);
  });
});

describe("consumer cookies", () => {
  it("sets both cookies HttpOnly, SameSite=Lax, on the consumer domain and their own paths", async () => {
    const res = await signup();

    const access = cookieHeader(res, CONSUMER_ACCESS_COOKIE)!;
    expect(access).toBeTruthy();
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(access).toMatch(/Domain=\.helloviza\.ai/i);
    expect(access).toMatch(/Path=\/api\/consumer(;|$)/i);

    const refresh = cookieHeader(res, CONSUMER_REFRESH_COOKIE)!;
    expect(refresh).toBeTruthy();
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/SameSite=Lax/i);
    expect(refresh).toMatch(/Domain=\.helloviza\.ai/i);
    // Narrow path — the refresh cookie is not sent on ordinary API calls.
    expect(refresh).toMatch(/Path=\/api\/consumer\/auth\/refresh/i);
  });

  it("scopes consumer cookies to helloviza.ai, NEVER the B2B COOKIE_DOMAIN", async () => {
    const res = await signup();
    for (const name of [CONSUMER_ACCESS_COOKIE, CONSUMER_REFRESH_COOKIE]) {
      expect(cookieHeader(res, name)).not.toMatch(/plumtrips\.com/i);
    }
  });

  it("uses cookie names that collide with nothing a B2B verifier reads", async () => {
    const res = await signup();
    const names = setCookies(res).map((c) => c.split("=")[0]);
    const b2bNames = [
      "hrms_accessToken", "accessToken", "token", "jwt", "auth",     // middleware/auth.ts
      "session", "hrms_token", "refreshToken", "demoRefreshToken",   // workspace.ts + auth.ts
    ];
    for (const n of names) expect(b2bNames).not.toContain(n);
  });
});

describe("POST /login", () => {
  it("logs in with correct credentials", async () => {
    await signup();
    const res = await request(app())
      .post("/api/consumer/auth/login")
      .send({ email: "first@example.com", password: SIGNUP.password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it("is case-insensitive on email", async () => {
    await signup();
    const res = await request(app())
      .post("/api/consumer/auth/login")
      .send({ email: "FIRST@EXAMPLE.COM", password: SIGNUP.password });
    expect(res.status).toBe(200);
  });

  it("gives the SAME generic error for a wrong password and an unknown email", async () => {
    await signup();
    const wrongPassword = await request(app())
      .post("/api/consumer/auth/login")
      .send({ email: "first@example.com", password: "wrong-password" });
    const unknownEmail = await request(app())
      .post("/api/consumer/auth/login")
      .send({ email: "nobody@example.com", password: SIGNUP.password });

    expect(wrongPassword.status).toBe(400);
    expect(unknownEmail.status).toBe(400);
    // Not an account-existence oracle.
    expect(wrongPassword.body.error).toBe(unknownEmail.body.error);
  });

  it("403s a DISABLED consumer", async () => {
    await signup();
    await Consumer.updateOne({ email: "first@example.com" }, { $set: { status: "DISABLED" } });
    const res = await request(app())
      .post("/api/consumer/auth/login")
      .send({ email: "first@example.com", password: SIGNUP.password });
    expect(res.status).toBe(403);
  });
});

describe("GET /me + D2C workspace stamping", () => {
  it("returns the consumer and the fixed D2C workspace id", async () => {
    const s = await signup();
    const res = await request(app())
      .get("/api/consumer/auth/me")
      .set("Authorization", `Bearer ${s.body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.consumer.email).toBe("first@example.com");
    expect(res.body.workspaceId).toBe(HELLOVIZA_D2C_WORKSPACE_ID);
  });

  it("works with the cookie alone (no Authorization header)", async () => {
    const s = await signup();
    const res = await request(app())
      .get("/api/consumer/auth/me")
      .set("Cookie", cookiePairs(s));
    expect(res.status).toBe(200);
  });

  it("401s unauthenticated", async () => {
    expect((await request(app()).get("/api/consumer/auth/me")).status).toBe(401);
  });
});

describe("OWN-scope isolation between two consumers", () => {
  it("each consumer's token resolves ONLY to their own row", async () => {
    const a = await signup({ email: "a@example.com", name: "Consumer A" });
    const b = await signup({ email: "b@example.com", name: "Consumer B" });

    const meA = await request(app())
      .get("/api/consumer/auth/me")
      .set("Authorization", `Bearer ${a.body.accessToken}`);
    const meB = await request(app())
      .get("/api/consumer/auth/me")
      .set("Authorization", `Bearer ${b.body.accessToken}`);

    expect(meA.body.consumer.email).toBe("a@example.com");
    expect(meB.body.consumer.email).toBe("b@example.com");
    expect(meA.body.consumer.id).not.toBe(meB.body.consumer.id);

    // They share a workspace — so the workspace is NOT the isolation
    // boundary. The consumer id is.
    expect(meA.body.workspaceId).toBe(meB.body.workspaceId);
  });

  it("revoking A's session leaves B's working", async () => {
    const a = await signup({ email: "a@example.com" });
    const b = await signup({ email: "b@example.com" });

    await request(app())
      .post("/api/consumer/auth/logout")
      .set("Authorization", `Bearer ${a.body.accessToken}`);

    const meA = await request(app())
      .get("/api/consumer/auth/me")
      .set("Authorization", `Bearer ${a.body.accessToken}`);
    const meB = await request(app())
      .get("/api/consumer/auth/me")
      .set("Authorization", `Bearer ${b.body.accessToken}`);

    expect(meA.status).toBe(401);
    expect(meB.status).toBe(200);
  });
});

describe("POST /refresh", () => {
  it("re-mints from the consumer refresh cookie", async () => {
    const s = await signup();
    const res = await request(app())
      .post("/api/consumer/auth/refresh")
      .set("Cookie", cookiePairs(s));

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    // Signed with the consumer secret, same as the original.
    expect(() => jwt.verify(res.body.accessToken, CONSUMER_SECRET)).not.toThrow();
    // And it re-issues both cookies.
    expect(cookieHeader(res, CONSUMER_ACCESS_COOKIE)).toBeTruthy();
    expect(cookieHeader(res, CONSUMER_REFRESH_COOKIE)).toBeTruthy();
  });

  it("401s with no refresh cookie", async () => {
    expect((await request(app()).post("/api/consumer/auth/refresh")).status).toBe(401);
  });

  it("ignores the B2B refresh cookie entirely", async () => {
    const b2bRefresh = jwt.sign({ sub: "507f1f77bcf86cd799439011" }, B2B_SECRET, {
      expiresIn: "7d",
    });
    const res = await request(app())
      .post("/api/consumer/auth/refresh")
      .set("Cookie", `refreshToken=${b2bRefresh}`);
    expect(res.status).toBe(401);
  });

  it("401s once the session has been revoked — revocation reaches the 7-day cookie", async () => {
    const s = await signup();
    await request(app())
      .post("/api/consumer/auth/logout")
      .set("Authorization", `Bearer ${s.body.accessToken}`);

    const res = await request(app())
      .post("/api/consumer/auth/refresh")
      .set("Cookie", cookiePairs(s));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Session has been revoked");
  });
});

describe("POST /logout", () => {
  it("bumps tokenVersion and clears both cookies", async () => {
    const s = await signup();
    const res = await request(app())
      .post("/api/consumer/auth/logout")
      .set("Authorization", `Bearer ${s.body.accessToken}`);

    expect(res.status).toBe(200);

    const stored: any = await Consumer.findOne({ email: "first@example.com" }).lean();
    expect(stored.tokenVersion).toBe(1);

    // Both cookies cleared, on the same paths they were set with.
    const cleared = setCookies(res);
    expect(cleared.some((c) => c.startsWith(`${CONSUMER_ACCESS_COOKIE}=;`))).toBe(true);
    expect(cleared.some((c) => c.startsWith(`${CONSUMER_REFRESH_COOKIE}=;`))).toBe(true);
  });

  it("401s unauthenticated", async () => {
    expect((await request(app()).post("/api/consumer/auth/logout")).status).toBe(401);
  });
});

describe("THE WALL over HTTP", () => {
  it("a B2B token is rejected on every authed consumer route", async () => {
    const b2b = jwt.sign(
      { sub: "507f1f77bcf86cd799439011", roles: ["SUPERADMIN"], email: "staff@plumtrips.com" },
      B2B_SECRET,
      { expiresIn: "30m" },
    );
    expect(
      (await request(app()).get("/api/consumer/auth/me").set("Authorization", `Bearer ${b2b}`)).status,
    ).toBe(401);
    expect(
      (await request(app()).post("/api/consumer/auth/logout").set("Authorization", `Bearer ${b2b}`))
        .status,
    ).toBe(401);
  });

  it("a consumer token is rejected by the REAL, UNMODIFIED requireAuth", async () => {
    // This is direction 2 of the wall, exercised against the actual
    // production middleware — not a re-implementation, and with no change to
    // it anywhere in this branch.
    const { requireAuth } = await import("../middleware/auth.js");

    const b2bApp = express();
    b2bApp.use(cookieParser());
    b2bApp.get("/b2b", requireAuth, (_req, res) => res.json({ reached: true }));

    const s = await signup();
    const consumerToken = s.body.accessToken;

    const viaHeader = await request(b2bApp)
      .get("/b2b")
      .set("Authorization", `Bearer ${consumerToken}`);
    expect(viaHeader.status).toBe(401);
    expect(viaHeader.body.error).toBe("Invalid token");

    // And through every cookie name requireAuth scavenges.
    for (const name of ["hrms_accessToken", "accessToken", "token", "jwt", "auth"]) {
      const viaCookie = await request(b2bApp).get("/b2b").set("Cookie", `${name}=${consumerToken}`);
      expect(viaCookie.status).toBe(401);
    }
  });
});

describe("ensureD2CWorkspace", () => {
  it("creates the workspace at the fixed id, ACTIVE, and is idempotent", async () => {
    await CustomerWorkspace.deleteMany({ _id: new mongoose.Types.ObjectId(HELLOVIZA_D2C_WORKSPACE_ID) });

    const id1 = await ensureD2CWorkspace();
    const id2 = await ensureD2CWorkspace();
    expect(String(id1)).toBe(HELLOVIZA_D2C_WORKSPACE_ID);
    expect(String(id2)).toBe(HELLOVIZA_D2C_WORKSPACE_ID);

    const rows = await CustomerWorkspace.find({ _id: id1 }).lean();
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).status).toBe("ACTIVE");
    expect((rows[0] as any).customerId).toBe(HELLOVIZA_D2C_CUSTOMER_ID);
    expect((rows[0] as any).companyName).toBe("Helloviza D2C");
  });

  it("does not overwrite later administrative edits ($setOnInsert)", async () => {
    const id = await ensureD2CWorkspace();
    await CustomerWorkspace.updateOne({ _id: id }, { $set: { companyName: "Renamed By Ops" } });
    await ensureD2CWorkspace();
    const row: any = await CustomerWorkspace.findById(id).lean();
    expect(row.companyName).toBe("Renamed By Ops");
  });
});

/* ══ THE DUAL-IDENTITY B2B GATE ═══════════════════════════════════════
 *
 * The one place this module reads the `users` collection. These tests
 * exist because every interesting property of that read is a NEGATIVE
 * one — what it must not write, must not return, and must not reveal —
 * and negatives do not show up in manual testing.
 *
 * The B2B user rows here are written with the raw driver rather than
 * through models/User.ts. That is deliberate: User carries
 * workspaceScopePlugin, which declares workspaceId REQUIRED, so building
 * a valid document through the model would mean standing up a workspace
 * and a dozen unrelated required fields to test a lookup that reads one
 * indexed key. The collection name and the `email` key are the entire
 * contract under test.
 */
describe("the B2B collision fork", () => {
  const B2B_EMAIL = "admin@plumtrips.com";

  /** A minimal `users` row — only the field the lookup actually reads. */
  async function seedB2BUser(email = B2B_EMAIL) {
    await mongoose.connection.db!.collection("users").insertOne({
      email,
      name: "Corporate Person",
      workspaceId: new mongoose.Types.ObjectId(),
      roles: ["ADMIN"],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  beforeEach(async () => {
    await mongoose.connection.db!.collection("users").deleteMany({});
  });

  it("fires on LOGIN for an address that is only a B2B account", async () => {
    await seedB2BUser();
    const res = await request(app())
      .post("/api/consumer/auth/login")
      .send({ email: B2B_EMAIL, password: "anything at all" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("B2B_ACCOUNT_EXISTS");
  });

  it("fires on SIGNUP, which is the case that would otherwise create a second identity", async () => {
    await seedB2BUser();
    const res = await signup({ email: B2B_EMAIL });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("B2B_ACCOUNT_EXISTS");
    // And no consumer was created behind it.
    expect(await Consumer.countDocuments({ email: B2B_EMAIL })).toBe(0);
  });

  it("is case-insensitive, because the login path lowercases before it looks", async () => {
    await seedB2BUser();
    const res = await request(app())
      .post("/api/consumer/auth/login")
      .send({ email: "ADMIN@Plumtrips.COM", password: "x" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("B2B_ACCOUNT_EXISTS");
  });

  it("does NOT fire for an address that is in neither collection", async () => {
    await seedB2BUser();
    const res = await request(app())
      .post("/api/consumer/auth/login")
      .send({ email: "nobody@example.com", password: "x" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid credentials");
    expect(res.body.code).toBeUndefined();
  });

  it("does NOT fire for an existing CONSUMER with a wrong password — the oracle is not widened", async () => {
    /* THE IMPORTANT ONE. An address that is BOTH a consumer and a B2B
     * user must still get the plain generic failure, or the fork becomes
     * a way to ask "is this consumer also a corporate user?" — a
     * question nobody is entitled to an answer to. The gate is reachable
     * only where no consumer row exists at all. */
    await signup({ email: B2B_EMAIL });
    await seedB2BUser();

    const res = await request(app())
      .post("/api/consumer/auth/login")
      .send({ email: B2B_EMAIL, password: "the wrong password" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid credentials");
    expect(res.body.code).toBeUndefined();
  });

  it("leaks NOTHING about the B2B account beyond the marker itself", async () => {
    await seedB2BUser();
    const res = await request(app())
      .post("/api/consumer/auth/login")
      .send({ email: B2B_EMAIL, password: "x" });

    // Exactly two keys, and neither is a field of that account.
    expect(Object.keys(res.body).sort()).toEqual(["code", "error"]);
    const serialised = JSON.stringify(res.body);
    for (const leak of ["Corporate Person", "ADMIN", "workspaceId", "_id", "roles"]) {
      expect(serialised, `response must not carry "${leak}"`).not.toContain(leak);
    }
  });

  it("is READ-ONLY — the B2B row is byte-identical after repeated hits on both endpoints", async () => {
    await seedB2BUser();
    const users = mongoose.connection.db!.collection("users");
    const before = JSON.stringify(await users.find({}).toArray());

    for (let i = 0; i < 3; i++) {
      await request(app())
        .post("/api/consumer/auth/login")
        .send({ email: B2B_EMAIL, password: `guess-${i}` });
      await signup({ email: B2B_EMAIL });
    }

    expect(JSON.stringify(await users.find({}).toArray())).toBe(before);
    expect(await users.countDocuments({})).toBe(1);
  });
});
