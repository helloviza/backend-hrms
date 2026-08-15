// apps/backend/src/routes/consumer.auth.ts
//
// D2C consumer auth. Mounted at /api/consumer/auth (server.ts).
//
// SEPARATE FROM /api/auth ON PURPOSE — every endpoint here reads a consumer
// cookie and signs with CONSUMER_JWT_SECRET. Reusing routes/auth.ts's
// /refresh would have been wrong twice over: it reads the B2B `refreshToken`
// cookie and verifies with JWT_REFRESH_SECRET.
//
// PHASE 1a SCOPE — signup just creates a consumer. The dual-identity
// B2B-collision gate ("this email/mobile already exists in `users`, is that
// you?") is Phase 1b; Consumer.phone is indexed already so that lookup lands
// on an index when it arrives. Nothing here reads or writes the `users`
// collection at all.
import { Router } from "express";
import bcrypt from "bcryptjs";
import Consumer from "../models/Consumer.js";
import { requireConsumer } from "../middleware/requireConsumer.js";
import {
  signConsumerAccessToken,
  signConsumerRefreshToken,
  verifyConsumerRefreshToken,
} from "../utils/consumerJwt.js";
import {
  CONSUMER_ACCESS_COOKIE,
  CONSUMER_ACCESS_COOKIE_PATH,
  CONSUMER_ACCESS_MAXAGE_MS,
  CONSUMER_COOKIE_SAMESITE,
  CONSUMER_REFRESH_COOKIE,
  CONSUMER_REFRESH_COOKIE_PATH,
  CONSUMER_REFRESH_MAXAGE_MS,
  cookieDomainForPath,
} from "../config/consumerAuth.js";
import { HELLOVIZA_D2C_WORKSPACE_ID } from "../services/consumerWorkspace.js";

const router = Router();

const isProd = process.env.NODE_ENV === "production";
const BCRYPT_COST = 12; // same as routes/signup.ts

function normalizeEmail(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

/**
 * Cookie options for a consumer cookie.
 *
 * The domain comes from cookieDomainForPath(path) — a function of the ISSUING
 * PATH — so a consumer cookie is scoped to the consumer registrable domain
 * while B2B keeps whatever routes/auth.ts's own untouched cookieDomainOption()
 * gives it. No B2B file is edited by this phase.
 *
 * sameSite is CONSUMER_COOKIE_SAMESITE ("lax") — correct because
 * helloviza.ai and api.helloviza.ai share an eTLD+1 and are therefore
 * same-site. See that constant for the one condition that flips it to "none".
 */
function consumerCookieOptions(path: string, maxAge: number) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: CONSUMER_COOKIE_SAMESITE,
    path,
    maxAge,
    ...cookieDomainForPath(path),
  };
}

function setConsumerCookies(res: any, accessToken: string, refreshToken: string): void {
  res.cookie(
    CONSUMER_ACCESS_COOKIE,
    accessToken,
    consumerCookieOptions(CONSUMER_ACCESS_COOKIE_PATH, CONSUMER_ACCESS_MAXAGE_MS),
  );
  res.cookie(
    CONSUMER_REFRESH_COOKIE,
    refreshToken,
    consumerCookieOptions(CONSUMER_REFRESH_COOKIE_PATH, CONSUMER_REFRESH_MAXAGE_MS),
  );
}

function clearConsumerCookies(res: any): void {
  // clearCookie must be given the SAME path/domain/flags the cookie was set
  // with, or the browser keeps the original.
  const { maxAge: _a, ...accessOpts } = consumerCookieOptions(CONSUMER_ACCESS_COOKIE_PATH, 0);
  const { maxAge: _r, ...refreshOpts } = consumerCookieOptions(CONSUMER_REFRESH_COOKIE_PATH, 0);
  res.clearCookie(CONSUMER_ACCESS_COOKIE, accessOpts);
  res.clearCookie(CONSUMER_REFRESH_COOKIE, refreshOpts);
}

function issueSession(res: any, consumer: { _id: any; tokenVersion: number }) {
  const input = { consumerId: String(consumer._id), tokenVersion: consumer.tokenVersion };
  const accessToken = signConsumerAccessToken(input);
  const refreshToken = signConsumerRefreshToken(input);
  setConsumerCookies(res, accessToken, refreshToken);
  return { accessToken };
}

// The shape a consumer is ever described by on the wire. passwordHash is
// select:false on the model, but this exists so no future field is exposed by
// accident — a whitelist, not a blocklist.
function publicConsumer(c: any) {
  return {
    id: String(c._id),
    email: c.email,
    name: c.name,
    phone: c.phone ?? null,
  };
}

/* ── POST /signup — PUBLIC ────────────────────────────────────────────
 * Phase 1a stub: creates a consumer and issues a session. No B2B-collision
 * gate (Phase 1b).
 * ──────────────────────────────────────────────────────────────────── */
router.post("/signup", async (req: any, res: any) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name ?? "").trim();
    const password = String(req.body?.password ?? "");
    const phone = String(req.body?.phone ?? "").trim() || undefined;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    // Checked against `consumers` ONLY. A collision with a B2B `users` row is
    // deliberately not consulted here — that is the Phase 1b gate, and
    // silently rejecting on it now would leak the existence of B2B accounts.
    const exists = await Consumer.exists({ email });
    if (exists) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const consumer = await Consumer.create({ email, name, phone, passwordHash });

    const { accessToken } = issueSession(res, consumer as any);

    return res.status(201).json({
      ok: true,
      consumer: publicConsumer(consumer),
      accessToken,
    });
  } catch (err: any) {
    console.error("[consumer signup]", err?.message);
    return res.status(500).json({ error: "Signup failed" });
  }
});

/* ── POST /login — PUBLIC ─────────────────────────────────────────── */
router.post("/login", async (req: any, res: any) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    // passwordHash is select:false on the model — re-selected explicitly.
    const consumer: any = await Consumer.findOne({ email }).select("+passwordHash");
    // Same generic message for "no such consumer" and "wrong password", so
    // this endpoint is not an account-existence oracle. (routes/signup.ts's
    // /check-email already is one for B2B; that is not a precedent to copy.)
    if (!consumer) {
      return res.status(400).json({ error: "Invalid credentials" });
    }
    if (consumer.status !== "ACTIVE") {
      return res.status(403).json({ error: "Account is not active" });
    }

    const ok = await bcrypt.compare(password, consumer.passwordHash);
    if (!ok) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const { accessToken } = issueSession(res, consumer);

    return res.json({ ok: true, consumer: publicConsumer(consumer), accessToken });
  } catch (err: any) {
    console.error("[consumer login]", err?.message);
    return res.status(500).json({ error: "Login failed" });
  }
});

/* ── POST /refresh — reads the CONSUMER refresh cookie ─────────────────
 * Its own endpoint, never /api/auth/refresh: that one reads the B2B
 * `refreshToken` cookie and verifies with JWT_REFRESH_SECRET.
 * ──────────────────────────────────────────────────────────────────── */
router.post("/refresh", async (req: any, res: any) => {
  try {
    const token = req.cookies?.[CONSUMER_REFRESH_COOKIE];
    if (!token) {
      return res.status(401).json({ error: "Missing refresh token" });
    }

    let payload;
    try {
      payload = verifyConsumerRefreshToken(String(token));
    } catch {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }

    const consumer: any = await Consumer.findById(payload.sub).select(
      "_id email name phone tokenVersion status",
    );
    if (!consumer) {
      return res.status(401).json({ error: "Invalid or expired refresh token" });
    }
    if (consumer.status !== "ACTIVE") {
      return res.status(403).json({ error: "Account is not active" });
    }
    // Revocation applies to refresh too — a logout invalidates the 7-day
    // cookie, not just the 30-minute access token.
    if (consumer.tokenVersion !== payload.tokenVersion) {
      return res.status(401).json({ error: "Session has been revoked" });
    }

    const { accessToken } = issueSession(res, consumer);

    return res.json({ ok: true, consumer: publicConsumer(consumer), accessToken });
  } catch (err: any) {
    console.error("[consumer refresh]", err?.message);
    return res.status(500).json({ error: "Refresh failed" });
  }
});

/* ── POST /logout — requireConsumer. REAL revocation. ──────────────── */
router.post("/logout", requireConsumer, async (req: any, res: any) => {
  try {
    // $inc, not "set to a known value" — two concurrent logouts must not
    // land on the same version and leave one of them ineffective.
    await Consumer.updateOne({ _id: req.consumer.id }, { $inc: { tokenVersion: 1 } });
    clearConsumerCookies(res);
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[consumer logout]", err?.message);
    return res.status(500).json({ error: "Logout failed" });
  }
});

/* ── GET /me — requireConsumer ─────────────────────────────────────────
 * Demonstrates the OWN-scope read pattern this module will use everywhere:
 * the actor's own id is a MANDATORY query clause taken from req.consumer,
 * never from anything the caller supplied. Mirrors routes/expenses.ts's
 * `{ employeeId: me, workspaceId }` idiom.
 * ──────────────────────────────────────────────────────────────────── */
router.get("/me", requireConsumer, async (req: any, res: any) => {
  try {
    const consumer: any = await Consumer.findOne({ _id: req.consumer.id })
      .select("_id email name phone")
      .lean();
    if (!consumer) {
      return res.status(404).json({ error: "Consumer not found" });
    }

    return res.json({
      ok: true,
      consumer: publicConsumer(consumer),
      // The stamped synthetic tenant — constant for every consumer, and NOT
      // an isolation boundary between them (see services/consumerWorkspace.ts).
      workspaceId: req.consumerWorkspaceId ?? HELLOVIZA_D2C_WORKSPACE_ID,
    });
  } catch (err: any) {
    console.error("[consumer me]", err?.message);
    return res.status(500).json({ error: "Failed to load account" });
  }
});

export default router;
