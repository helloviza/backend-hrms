// apps/backend/src/config/cors.ts
import cors from "cors";
import { env } from "./env.js";

const fromEnv = (env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const devOrigins =
  process.env.NODE_ENV !== "production"
    ? [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
      ]
    : [];

const ALLOW_LIST = new Set<string>([...fromEnv, ...devOrigins]);
const LOCAL_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

// Allow only hrms.plumtrips.com subdomains (not whole plumtrips.com)
const PROD_SUBDOMAIN_REGEX = /^https:\/\/([a-z0-9-]+\.)?hrms\.plumtrips\.com$/i;

export const corsMiddleware = cors({
  origin(origin, callback) {
    // Server-to-server / curl often has no Origin
    if (!origin) return callback(null, true);

    // Sandboxed "null" origin — dev only
    if (origin === "null" && process.env.NODE_ENV !== "production") {
      return callback(null, true);
    }

    if (ALLOW_LIST.has(origin)) {
      return callback(null, true);
    }

    // Allow localhost pattern in dev only
    if (process.env.NODE_ENV !== "production" && LOCAL_REGEX.test(origin)) {
      return callback(null, true);
    }

    if (PROD_SUBDOMAIN_REGEX.test(origin)) {
      return callback(null, true);
    }

    console.warn(`⚠️  CORS blocked origin: ${origin}`);
    return callback(new Error(`CORS: Origin not allowed -> ${origin}`));
  },

  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    // optional future-proofing
    "X-CSRF-Token",
    "X-Admin-Price-Key",
    "X-Admin-Key",
  ],
  exposedHeaders: ["Content-Disposition"],
  optionsSuccessStatus: 200,
  preflightContinue: false,
  maxAge: 86400,
});
