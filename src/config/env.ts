// apps/backend/src/config/env.ts
//
// ⚠️ MUST be the first import: back-fills process.env from the APP_SECRETS
// bundle (and loads .env) BEFORE anything below reads process.env — see
// bootstrap/loadSecrets.ts's header. This is what makes standalone scripts
// under src/scripts/* (run via `tsx path/to/script.ts`, never through
// server.ts) see bundle-only secrets (PIXABAY_API_KEY, GOOGLE_PLACES_API_KEY,
// SMTP_*, EXCHANGERATE_API_KEY, ...): every script that reads a secret via
// `env.X` from this module gets the unpack for free just by importing here,
// with no per-script wiring. server.ts ALSO imports loadSecrets.ts directly,
// as its own literal first line — that's not a leftover to clean up, it's
// intentional belt-and-suspenders for the couple of places that still read a
// secret straight off `process.env` instead of through `env` (routes/
// places.ts's GOOGLE_PLACES_API_KEY, utils/mailer.ts's SMTP_USER/SMTP_PASS,
// a few Gemini/Razorpay/TBO reads — a separate, deliberately-untouched
// inconsistency, not fixed here). ES modules cache by resolved path, so
// importing the same side-effecting module twice (once here, once from
// server.ts) runs its body exactly once, not twice — this is not a
// duplicate unpack.
import "../bootstrap/loadSecrets.js";

import { assertRazorpayKeyMatchesEnv } from "./razorpayMode.js";

import dotenv from "dotenv";
// Harmless no-op here — loadSecrets.ts above already called dotenv.config()
// (and dotenv never overrides an already-set key), kept only so this file
// still works standalone if that import is ever removed.
dotenv.config();

/**
 * Centralized environment variable loader
 * - Ensures all required vars exist
 * - Provides proper types for TypeScript
 */
function requireEnv(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (!val) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return val;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT) || 8080,
  // Screening authority enforcement (2026-08-12) — a TIER, not a boolean:
  // "off" (default) | "capability" | "assignment". Declared here for
  // discoverability; the runtime check lives in config/visaScreening.ts and
  // reads process.env live rather than this captured value, so the switch can
  // be flipped without a rebuild and each test can pin the state it needs.
  // VISA_SCREENING_ENFORCED is step 1's boolean, still honoured as a legacy
  // alias for "assignment" when the tier is unset. See
  // infra/audit/visa-screening-authority-model-2026-08-12.md.
  VISA_SCREENING_ENFORCEMENT: String(process.env.VISA_SCREENING_ENFORCEMENT || "").trim().toLowerCase() || "off",
  VISA_SCREENING_ENFORCED: String(process.env.VISA_SCREENING_ENFORCED || "").trim().toLowerCase() === "true",
  DEPLOYMENT_MODE: (process.env.DEPLOYMENT_MODE === "saas" ? "saas" : "plumbox") as "saas" | "plumbox",

  MONGO_URI: requireEnv("MONGO_URI"),
  JWT_SECRET: requireEnv("JWT_SECRET"),
  JWT_REFRESH_SECRET: requireEnv("JWT_REFRESH_SECRET", process.env.JWT_SECRET),

  FRONTEND_ORIGIN: requireEnv("FRONTEND_ORIGIN"),

  // --- AWS + S3 configuration ---
  AWS_REGION: requireEnv("AWS_REGION", "ap-south-1"),
  S3_BUCKET: requireEnv("S3_BUCKET"),
  PRESIGN_TTL: Number(process.env.PRESIGN_TTL || 300),

  // Optional credentials (used in local dev; IAM takes over in production)
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,

  // --- Voucher Extractor / Gemini ---
  GEMINI_API_KEY: requireEnv("GEMINI_API_KEY"),

  // --- Pixabay (SBT landing city images) — optional; absent disables auto-resolution ---
  PIXABAY_API_KEY: process.env.PIXABAY_API_KEY || "",

  // --- ExchangeRate-API (CSTEP arrangement live FX pre-fill) — optional;
  // absent disables live-rate pre-fill and the UI just falls back to manual
  // entry (utils/exchangeRate.ts). Same secrets-bundle pattern as
  // GEMINI_API_KEY/PIXABAY_API_KEY above — never hardcoded, back-filled into
  // process.env by bootstrap/loadSecrets.ts from the single AWS Secrets
  // Manager secret (plumtrips/backend/secrets) bundled into APP_SECRETS.
  EXCHANGERATE_API_KEY: process.env.EXCHANGERATE_API_KEY || "",

  // --- WhatsApp Cloud API (Expense Management inbound receipt capture) ---------
  // All optional: when WA_APP_SECRET / WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID are
  // unset the webhook still boots but the capture worker stays idle. This is the
  // Meta Graph / Cloud API path and is independent of the whatsapp-web.js EOD flow.
  WA_VERIFY_TOKEN: process.env.WA_VERIFY_TOKEN || "",       // GET handshake token
  WA_APP_SECRET: process.env.WA_APP_SECRET || "",          // X-Hub-Signature-256 key
  WA_ACCESS_TOKEN: process.env.WA_ACCESS_TOKEN || "",       // Graph API bearer token
  WA_PHONE_NUMBER_ID: process.env.WA_PHONE_NUMBER_ID || "", // business number id (send replies)
  WA_GRAPH_VERSION: process.env.WA_GRAPH_VERSION || "v21.0",
} as const;

/**
 * Guardrail: local dev, Claude Code sessions, and diagnostic scripts must
 * never be able to silently run against the production Atlas cluster
 * without the reader noticing. A non-production boot with MONGO_URI pointed
 * at the prod hostname gets a loud, impossible-to-miss warning — this does
 * not block boot (Atlas production is the intentional dev setup on this
 * branch, and some one-off scripts, e.g. grant-access-console.ts,
 * legitimately connect to prod on purpose), but nobody should be able to do
 * it UNKNOWINGLY without seeing this first. Set ALLOW_PROD_DB=true once
 * you've acknowledged the choice to silence it.
 */
const PROD_MONGO_HOST_FRAGMENT = "main-prod-cluster";
if (
  env.NODE_ENV !== "production" &&
  env.MONGO_URI.includes(PROD_MONGO_HOST_FRAGMENT) &&
  process.env.ALLOW_PROD_DB !== "true"
) {
  const line = "!".repeat(78);
  console.warn(
    [
      "",
      line,
      line,
      "!!",
      "!!   WARNING: NODE_ENV IS NOT PRODUCTION, BUT MONGO_URI POINTS AT",
      "!!   THE PRODUCTION ATLAS CLUSTER (main-prod-cluster).",
      "!!",
      "!!   Every read AND write from this process is hitting LIVE",
      "!!   PRODUCTION DATA — including any seed/test/diagnostic script",
      "!!   you run against it.",
      "!!",
      "!!   If this is intentional, set ALLOW_PROD_DB=true to silence this",
      "!!   warning.",
      "!!",
      line,
      line,
      "",
    ].join("\n"),
  );
}

/**
 * Guardrail: the Razorpay key's declared mode must agree with the
 * environment. Unlike the MONGO_URI warning above this one THROWS, because
 * the failure it prevents is not "you read the wrong data" but "you moved,
 * or failed to move, somebody's money" — and neither direction announces
 * itself at the time.
 *
 * Deliberately here rather than at the payment call sites: this is the one
 * module every boot goes through (server.ts imports it directly), so the
 * check runs exactly once per process instead of once per checkout. A
 * per-request version would also be a per-request chance to refuse a
 * customer's payment, which is the wrong place to discover a
 * misconfiguration.
 *
 * The key is shared by D2C and B2B/SBT alike — see config/razorpayMode.ts
 * for the full rule and why an absent key stays legal outside production.
 */
assertRazorpayKeyMatchesEnv(process.env.RAZORPAY_KEY_ID, env.NODE_ENV);
