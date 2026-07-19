// apps/backend/src/config/env.ts
import dotenv from "dotenv";
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
 * never be able to silently run against the production Atlas cluster again
 * (see scripts/seed-dev.ts's header comment for the full incident this
 * closes). A non-production boot with MONGO_URI pointed at the prod
 * hostname gets a loud, impossible-to-miss warning — this does not block
 * boot (some legitimate one-off scripts, e.g. grant-access-console.ts,
 * intentionally connect to prod on purpose), but nobody should be able to
 * do it BY ACCIDENT without seeing this first.
 */
const PROD_MONGO_HOST_FRAGMENT = "main-prod-cluster";
if (env.NODE_ENV !== "production" && env.MONGO_URI.includes(PROD_MONGO_HOST_FRAGMENT)) {
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
      "!!   Point MONGO_URI at a local database instead, e.g.:",
      "!!     MONGO_URI=mongodb://localhost:27017/plumbox_dev",
      "!!   then seed it with:",
      "!!     pnpm -C apps/backend tsx src/scripts/seed-dev.ts",
      "!!",
      line,
      line,
      "",
    ].join("\n"),
  );
}
