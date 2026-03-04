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
} as const;
