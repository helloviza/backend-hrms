// apps/backend/src/routes/consumer.devAuth.ts
//
// ══════════════════════════════════════════════════════════════════════
// DEV ONLY. This router issues a REAL consumer session WITHOUT a password.
// It must never exist in a production process.
// ══════════════════════════════════════════════════════════════════════
//
// WHY IT EXISTS
// -------------
// Real Google/Microsoft OAuth for helloviza.ai is being built separately.
// Everything downstream of "who is the current consumer" — the profile, its
// documents, its co-travellers — can be built and verified now, provided the
// identity it reads is the real one. This is that stand-in: a shortcut past
// the CREDENTIAL, not a shortcut past the WALL.
//
// WHAT IS REAL HERE (all of it, except the password check)
//   - the token is signed by utils/consumerJwt.ts with CONSUMER_JWT_SECRET
//   - the cookies are set by routes/consumer.auth.ts's issueConsumerSession,
//     the same function /login and /refresh call — same names, same paths,
//     same flags, same 30m/7d lifetimes
//   - the session it produces is verified by the real requireConsumer, which
//     does the real tokenVersion revocation check
//
// So when OAuth lands, deleting this file and this mount is the entire
// change. Nothing in the profile knows how the consumer got here.
//
// ── THE THREE GATES ───────────────────────────────────────────────────
// 1. This module THROWS at import time when NODE_ENV === "production".
// 2. server.ts imports it dynamically and only when NODE_ENV !== "production",
//    so in prod the module is never even loaded and the route does not exist
//    (a 404, not a 403 — an endpoint that isn't there cannot be probed).
// 3. Every handler re-checks at request time, so the router is still safe if
//    someone later mounts it unconditionally.
//
// Gate 3 is not redundant with gate 2. Gate 2 is a property of one call site
// and one edit away from being wrong; gate 3 travels with the router.
import { Router } from "express";
import Consumer from "../models/Consumer.js";
import { requireConsumer } from "../middleware/requireConsumer.js";
import { issueConsumerSession } from "./consumer.auth.js";
import { HELLOVIZA_D2C_WORKSPACE_ID } from "../services/consumerWorkspace.js";

/** The consumer seeded by seed/seed-consumer-dev.ts. */
const DEFAULT_DEV_CONSUMER_EMAIL = "test@helloviza.dev";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

// GATE 1 — import-time. A production build that somehow reaches this import
// crashes at boot rather than quietly exposing a passwordless login.
if (isProduction()) {
  throw new Error(
    "routes/consumer.devAuth.ts was imported with NODE_ENV=production — " +
      "this router issues sessions without a password and must never load in production",
  );
}

const router = Router();

// GATE 3 — request-time, on every handler in this router.
router.use((_req, res, next) => {
  if (isProduction()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});

/* ── POST /login — DEV ONLY ────────────────────────────────────────────
 * Issues a real consumer session for a seeded consumer, by email.
 *
 * Body: { email? } — defaults to the primary seeded test consumer.
 *
 * It will NOT create a consumer that does not exist. Signup already has a
 * real endpoint (/api/consumer/auth/signup); making this one create rows too
 * would mean a typo silently produced a brand-new empty profile and looked
 * like data loss.
 * ──────────────────────────────────────────────────────────────────── */
router.post("/login", async (req: any, res: any) => {
  try {
    const email = String(req.body?.email ?? DEFAULT_DEV_CONSUMER_EMAIL)
      .trim()
      .toLowerCase();

    const consumer: any = await Consumer.findOne({ email }).select(
      "_id email name phone tokenVersion status",
    );

    if (!consumer) {
      return res.status(404).json({
        error: `No consumer ${email} in this database. Run: pnpm -C apps/backend seed:consumer`,
      });
    }
    // The status check is kept even here — "log in as a disabled consumer" is
    // a state worth being able to reproduce, not one to paper over.
    if (consumer.status !== "ACTIVE") {
      return res.status(403).json({ error: "Account is not active" });
    }

    const { accessToken } = issueConsumerSession(res, consumer);

    return res.json({
      ok: true,
      dev: true,
      consumer: {
        id: String(consumer._id),
        email: consumer.email,
        name: consumer.name,
        phone: consumer.phone ?? null,
      },
      workspaceId: HELLOVIZA_D2C_WORKSPACE_ID,
      accessToken,
    });
  } catch (err: any) {
    console.error("[consumer dev-login]", err?.message);
    return res.status(500).json({ error: "Dev login failed" });
  }
});

/* ── GET /whoami — DEV ONLY ────────────────────────────────────────────
 * Behind the REAL requireConsumer. This is the proof that the stub session
 * is a genuine one: if requireConsumer rejects it, the stub is broken.
 * ──────────────────────────────────────────────────────────────────── */
router.get("/whoami", requireConsumer, async (req: any, res: any) => {
  return res.json({
    ok: true,
    dev: true,
    consumer: req.consumer,
    // Stamped by requireConsumer with no DB read — echoed here so the
    // OWN-scope tenant stamping is observable from a browser.
    consumerWorkspaceId: req.consumerWorkspaceId,
  });
});

export default router;
