// apps/backend/src/routes/consumer.auth.ts
//
// D2C consumer auth. Mounted at /api/consumer/auth (server.ts).
//
// SEPARATE FROM /api/auth ON PURPOSE — every endpoint here reads a consumer
// cookie and signs with CONSUMER_JWT_SECRET. Reusing routes/auth.ts's
// /refresh would have been wrong twice over: it reads the B2B `refreshToken`
// cookie and verifies with JWT_REFRESH_SECRET.
//
// ── THE DUAL-IDENTITY B2B GATE (was Phase 1b, now built) ─────────────
// This module now performs ONE read against the `users` collection: does
// the email in front of us already belong to a CORPORATE Plumtrips
// account? See b2bAccountExists() below for the full rules. It is a
// lookup and nothing else — no write, no join, no B2B session, and no
// field of that account is ever returned or logged.
//
// The header used to say "nothing here reads or writes the `users`
// collection at all". The second half of that is still true and is the
// part that matters; the first half is not, and this is the note that
// says so rather than leaving a stale absolute in place.
import { Router } from "express";
import bcrypt from "bcryptjs";
import Consumer from "../models/Consumer.js";
import User from "../models/User.js";
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

/**
 * Mints both tokens and sets both cookies. EXPORTED so the dev-only stub
 * login (routes/consumer.devAuth.ts) issues a session through this exact
 * function rather than reimplementing it.
 *
 * That matters: a stub that signed its own token would be a second, parallel
 * notion of "a consumer session" that could drift from this one — different
 * cookie flags, a missing `typ` claim, a stale tokenVersion. Sharing the
 * signer means the dev shortcut is only a shortcut past the PASSWORD, and the
 * wall itself (secret, claims, cookie scoping, revocation) is the real one.
 */
export function issueConsumerSession(res: any, consumer: { _id: any; tokenVersion: number }) {
  return issueSession(res, consumer);
}

function issueSession(res: any, consumer: { _id: any; tokenVersion: number }) {
  const input = { consumerId: String(consumer._id), tokenVersion: consumer.tokenVersion };
  const accessToken = signConsumerAccessToken(input);
  const refreshToken = signConsumerRefreshToken(input);
  setConsumerCookies(res, accessToken, refreshToken);
  return { accessToken };
}

/* ══ THE B2B COLLISION LOOKUP ══════════════════════════════════════════
 *
 * "Does this email already belong to a corporate Plumtrips account?"
 *
 * ── WHY IT EXISTS ─────────────────────────────────────────────────────
 * `users.email` carries a GLOBAL unique index and `consumers` is a
 * separate collection, so the same human can hold both — a corporate
 * traveller by day who buys a family holiday visa at night. That is a
 * legitimate, expected state, not an error. What is NOT acceptable is
 * the silent version of it: someone types their work address into the
 * consumer login, gets "Invalid credentials" because no consumer row
 * exists, and concludes the product is broken. This lookup turns that
 * dead end into a question with two real answers.
 *
 * ── WHAT IT MAY DO, AND WHAT IT MAY NOT ───────────────────────────────
 * MAY:  one findOne on `users`, projected to `_id`, converted to a
 *       boolean before it leaves this function.
 * MAY NOT: create, update, touch, or authenticate a B2B account; read
 *       any field of it; return, log or imply anything about it beyond
 *       the boolean. The return type is `Promise<boolean>` precisely so
 *       there is no shape here for a detail to leak through — a caller
 *       cannot accidentally spread an object it was never given.
 *
 * Nothing in routes/auth.ts is imported, called or modified. The B2B
 * login path is untouched by this file; all it ever does is name it in a
 * message so the reader knows which door to knock on.
 *
 * ── THE WORKSPACE SCOPE IS DELIBERATELY ABSENT ────────────────────────
 * User carries workspaceScopePlugin, which injects a `workspaceId`
 * filter — but ONLY when a caller passes `_workspaceId` in the query
 * options. This query passes none, so it is global, and that is correct
 * rather than a scope bypass: the question is "does this address exist
 * anywhere in B2B", and a tenant-scoped answer would be meaningless
 * here. A consumer has no employer to scope to (see the header of
 * models/Consumer.ts), and `/api/consumer` is in server.ts's
 * WORKSPACE_EXEMPT list for exactly that reason.
 *
 * ── ON ENUMERATION ────────────────────────────────────────────────────
 * This DOES make the endpoint an oracle for B2B account existence, and
 * that is an accepted, deliberate cost — the fork cannot be offered
 * without it. It is kept as narrow as the feature allows:
 *
 *   - only reachable when NO consumer row exists for the address, so an
 *     address that is a consumer never reveals whether it is also a B2B
 *     user, and a wrong password still returns the same generic
 *     "Invalid credentials" it always did;
 *   - the response carries a fixed marker and a fixed sentence, so two
 *     different B2B accounts are indistinguishable from each other;
 *   - nothing about the account — not its name, workspace, role or
 *     status — reaches the wire.
 *
 * It is not a NEW oracle in the strict sense either: routes/signup.ts's
 * /check-email is already one for B2B addresses. That is not a licence,
 * which is why the constraints above are enforced here rather than
 * waved through.
 */
async function b2bAccountExists(email: string): Promise<boolean> {
  const hit = await User.findOne({ email }).select("_id").lean();
  // Coerced at the boundary. The document never escapes this function.
  return Boolean(hit);
}

/** The one marker the frontend switches on. Fixed string, no variants. */
const B2B_MARKER = "B2B_ACCOUNT_EXISTS";
const B2B_MESSAGE =
  "That address is already registered as a Plumtrips business account.";

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

    // CONSUMERS FIRST. An address that is already a consumer is answered
    // as one, and the B2B lookup below is never reached for it — so this
    // endpoint reveals nothing about B2B for any address it already
    // knows.
    const exists = await Consumer.exists({ email });
    if (exists) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    /* ── THE FORK, ON SIGNUP ──────────────────────────────────────────
     * This is the more important of the two placements. Login is a
     * confused reader; signup is a reader about to create a SECOND
     * identity on an address that already has one, and doing that
     * silently is how a person ends up with two accounts, one set of
     * documents, and no idea which is which.
     *
     * 409, matching the consumer-collision answer directly above it: the
     * request conflicts with existing state. The marker is what the
     * slider switches on; the sentence is what the reader sees. */
    if (await b2bAccountExists(email)) {
      return res.status(409).json({ error: B2B_MESSAGE, code: B2B_MARKER });
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
    if (!consumer) {
      /* ── THE FORK, ON LOGIN ────────────────────────────────────────
       * Reached ONLY when there is no consumer row at all — which is
       * what keeps the change narrow. An address that IS a consumer
       * falls straight through to the bcrypt compare below and, on a
       * wrong password, still gets the same generic "Invalid
       * credentials" it always did. So this branch cannot be used to
       * ask "is this consumer also a B2B user?", only "this address is
       * not a consumer at all — is it perhaps the other thing?".
       *
       * 409 rather than 400, and the distinction is the point: this is
       * not a failed credential, it is a request that conflicts with an
       * identity that already exists elsewhere. A 400 here would put
       * the fork in the same bucket as a typo'd password. */
      if (await b2bAccountExists(email)) {
        return res.status(409).json({ error: B2B_MESSAGE, code: B2B_MARKER });
      }
      // Otherwise the original answer, unchanged: the SAME generic
      // message for "no such consumer" and "wrong password", so this
      // endpoint remains no oracle for consumer accounts.
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
