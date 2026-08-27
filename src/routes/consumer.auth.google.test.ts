// apps/backend/src/routes/consumer.auth.google.test.ts
//
// POST /api/consumer/auth/google — the ID-token flow, end to end over real
// HTTP against a real mongodb-memory-server, with ONE thing faked: Google.
//
// ══════════════════════════════════════════════════════════════════════
// WHAT IS MOCKED, AND WHY EXACTLY THAT
// ══════════════════════════════════════════════════════════════════════
// Only `OAuth2Client.prototype.verifyIdToken`. Everything downstream of it
// — find-or-create, the B2B fork, the session cookies, the DB writes — is
// the real code path against a real database.
//
// It has to be mocked, and the reason is worth stating plainly rather than
// treated as convenience: a genuine Google ID token is signed by Google's
// private key and expires in an hour. There is no way to mint one in a
// test, and no way to keep a captured one valid. So the seam is drawn at
// the exact point where the outside world ends — "Google says this payload
// is authentic" — and every decision we make ON that payload is tested for
// real.
//
// The consequence, stated so nobody over-reads these greens: THIS FILE
// PROVES OUR LOGIC, NOT GOOGLE'S VERIFICATION. That the audience check
// actually rejects a foreign token is Google's library's job, exercised
// only by a real browser round trip.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

const CLIENT_ID = "test-google-client-id.apps.googleusercontent.com";

process.env.JWT_SECRET = "b2b-jwt-secret-for-tests";
process.env.CONSUMER_JWT_SECRET = "consumer-jwt-secret-for-tests";
process.env.CONSUMER_COOKIE_DOMAIN = ".helloviza.ai";
process.env.COOKIE_DOMAIN = ".plumtrips.com";
// config/env.ts hard-requires these at import time; nothing under test reads them.
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-google-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

/* The seam. Hoisted by vitest above the dynamic imports below, so the
 * router picks up the mocked class rather than the real one. */
const verifyIdToken = vi.fn();
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    constructor(public clientId?: string) {}
    verifyIdToken(...args: any[]) {
      return verifyIdToken(...args);
    }
  },
}));

const { default: Consumer } = await import("../models/Consumer.js");
const { default: consumerAuthRouter } = await import("./consumer.auth.js");
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

/** What Google hands back for a good token. */
function payload(over: Record<string, any> = {}) {
  return {
    sub: "google-sub-1234567890",
    email: "Gmail.Person@Example.com",
    email_verified: true,
    name: "Gmail Person",
    picture: "https://lh3.googleusercontent.com/x",
    ...over,
  };
}

function googleAccepts(over: Record<string, any> = {}) {
  verifyIdToken.mockResolvedValue({ getPayload: () => payload(over) });
}

function post(body: any = { credential: "a.b.c" }) {
  return request(app()).post("/api/consumer/auth/google").send(body);
}

function setCookies(res: any): string[] {
  return (res.headers["set-cookie"] as string[] | undefined) ?? [];
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
  await mongoose.connection.db!.collection("users").deleteMany({});
  verifyIdToken.mockReset();
  process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
});

/* ── Configuration ─────────────────────────────────────────────────── */

describe("configuration", () => {
  it("answers 503 (not 500, not a crash) when GOOGLE_OAUTH_CLIENT_ID is unset", async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    googleAccepts();

    const res = await post();

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("GOOGLE_SIGNIN_UNCONFIGURED");
    // The token is never even looked at — there is nothing to check it against.
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("passes the client id as the AUDIENCE, not merely as the client", async () => {
    googleAccepts();

    await post();

    // The single line that stops a Google token minted for another site
    // from working here. If this assertion ever fails, the endpoint is a
    // login-as-anyone hole.
    expect(verifyIdToken).toHaveBeenCalledWith(
      expect.objectContaining({ idToken: "a.b.c", audience: CLIENT_ID }),
    );
  });

  it("accepts idToken as an alias for credential", async () => {
    googleAccepts();

    const res = await post({ idToken: "x.y.z" });

    expect(res.status).toBe(201);
    expect(verifyIdToken).toHaveBeenCalledWith(expect.objectContaining({ idToken: "x.y.z" }));
  });

  it("rejects a request with no token at all", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });
});

/* ── Token rejection ───────────────────────────────────────────────── */

describe("token rejection", () => {
  it("answers 401 when Google rejects the token, and writes nothing", async () => {
    verifyIdToken.mockRejectedValue(new Error("Token used too late"));

    const res = await post();

    expect(res.status).toBe(401);
    expect(await Consumer.countDocuments()).toBe(0);
    // The reason never reaches the caller.
    expect(JSON.stringify(res.body)).not.toContain("too late");
  });

  it("refuses an UNVERIFIED Google email — the address is unproven", async () => {
    googleAccepts({ email_verified: false });

    const res = await post();

    expect(res.status).toBe(401);
    // The important half: no account was created for an address the
    // caller has not been shown to control.
    expect(await Consumer.countDocuments()).toBe(0);
  });
});

/* ── Find-or-create ────────────────────────────────────────────────── */

describe("find-or-create", () => {
  it("CREATES a password-less consumer on first sign-in and issues a session", async () => {
    googleAccepts();

    const res = await post();

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.consumer.email).toBe("gmail.person@example.com"); // normalised
    expect(res.body.consumer.name).toBe("Gmail Person");

    const stored: any = await Consumer.findOne({ email: "gmail.person@example.com" }).select(
      "+passwordHash",
    );
    expect(stored).toBeTruthy();
    // THE POINT OF THE MODEL CHANGE: absent, not a placeholder.
    expect(stored.passwordHash).toBeUndefined();
    expect(stored.authProvider).toBe("google");
    expect(stored.googleSub).toBe("google-sub-1234567890");
    expect(stored.status).toBe("ACTIVE");

    // Same session step email login uses — both cookies, HttpOnly.
    const cookies = setCookies(res);
    expect(cookies.some((c) => c.startsWith(`${CONSUMER_ACCESS_COOKIE}=`))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${CONSUMER_REFRESH_COOKIE}=`))).toBe(true);
    expect(cookies.every((c) => /HttpOnly/i.test(c))).toBe(true);
  });

  it("FINDS an existing consumer on the second sign-in — no duplicate row", async () => {
    googleAccepts();
    await post();
    await post();

    expect(await Consumer.countDocuments()).toBe(1);
  });

  it("returns created:false and does not re-create when the consumer exists", async () => {
    googleAccepts();
    await post();

    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
  });

  it("matches on googleSub even after the Google account's EMAIL changed", async () => {
    googleAccepts();
    await post();

    // Same person, same sub, new address on their Google account.
    googleAccepts({ email: "moved@example.com", name: "Gmail Person" });
    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    // One row, not two — the whole reason googleSub is stored.
    expect(await Consumer.countDocuments()).toBe(1);
  });

  it("LINKS Google to an existing email-signup account without touching its password", async () => {
    await request(app())
      .post("/api/consumer/auth/signup")
      .send({ email: "gmail.person@example.com", name: "Password Person", password: "hunter2hunter2" });

    googleAccepts();
    const res = await post();

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);

    const stored: any = await Consumer.findOne({ email: "gmail.person@example.com" }).select(
      "+passwordHash",
    );
    expect(stored.googleSub).toBe("google-sub-1234567890"); // newly linked
    // Their password still works and their history is not rewritten.
    expect(stored.passwordHash).toBeTruthy();
    expect(stored.authProvider).toBe("password");
    expect(stored.name).toBe("Password Person"); // Google does not overwrite it
    expect(await Consumer.countDocuments()).toBe(1);
  });

  it("refuses a DISABLED account rather than signing it in", async () => {
    googleAccepts();
    await post();
    await Consumer.updateOne({}, { $set: { status: "DISABLED" } });

    const res = await post();

    expect(res.status).toBe(403);
  });

  it("falls back to the email local-part when Google sends no name", async () => {
    googleAccepts({ name: undefined });

    const res = await post();

    expect(res.status).toBe(201);
    expect(res.body.consumer.name).toBe("gmail.person");
  });
});

/* ── The B2B fork ──────────────────────────────────────────────────── */

/**
 * A minimal `users` row, inserted through the RAW collection rather than
 * the model — the same thing consumer.auth.test.ts:437 does, and for the
 * same reason: User carries workspaceScopePlugin, which adds a required
 * `workspaceId`, and b2bAccountExists() reads nothing but `email`. Going
 * through the model would make this fixture assert facts about the B2B
 * schema that have no bearing on the lookup being tested.
 */
async function seedB2BUser(email: string) {
  await mongoose.connection.db!.collection("users").insertOne({
    email,
    name: "Corporate Person",
    workspaceId: new mongoose.Types.ObjectId(),
    roles: ["ADMIN"],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("B2B collision", () => {
  it("returns the SAME 409 + marker the email paths return, and creates nothing", async () => {
    await seedB2BUser("gmail.person@example.com");
    googleAccepts();

    const res = await post();

    expect(res.status).toBe(409);
    // Identical marker to signup/login, so the frontend's existing fork
    // screen handles Google with no Google-specific branch.
    expect(res.body.code).toBe("B2B_ACCOUNT_EXISTS");
    expect(await Consumer.countDocuments()).toBe(0);
    expect(setCookies(res)).toHaveLength(0);
  });

  it("never reaches the B2B question for an address that is already a consumer", async () => {
    googleAccepts();
    await post(); // creates the consumer
    await seedB2BUser("gmail.person@example.com");

    const res = await post();

    // Consumers are answered as consumers. The B2B row is invisible here.
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
  });
});

/* ── The model change, from the password side ──────────────────────── */

describe("password login with the now-optional passwordHash", () => {
  it("still works normally for a password account", async () => {
    await request(app())
      .post("/api/consumer/auth/signup")
      .send({ email: "pw@example.com", name: "PW", password: "hunter2hunter2" });

    const res = await request(app())
      .post("/api/consumer/auth/login")
      .send({ email: "pw@example.com", password: "hunter2hunter2" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("fails CLEANLY (400, not 500) when a Google account tries password login", async () => {
    googleAccepts();
    await post(); // password-less consumer now exists

    const res = await request(app())
      .post("/api/consumer/auth/login")
      .send({ email: "gmail.person@example.com", password: "anything-at-all" });

    // Without the guard in consumer.auth.ts this is a 500: bcryptjs throws
    // "Illegal arguments: string, undefined" on an absent hash rather than
    // returning false. A 500 here would read as an outage.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CONSUMER_NO_PASSWORD");
    expect(setCookies(res)).toHaveLength(0);
  });

  it("a consumer document is valid with no passwordHash at all", async () => {
    // The schema-level half of the change, asserted directly rather than
    // only through the endpoint.
    const c = await Consumer.create({ email: "nopw@example.com", name: "No Password" });
    expect(c.authProvider).toBe("password"); // the default, for old rows
    const stored: any = await Consumer.findById(c._id).select("+passwordHash");
    expect(stored.passwordHash).toBeUndefined();
  });
});
