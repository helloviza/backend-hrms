// apps/backend/src/config/cors.ts
import cors from "cors";
import { env } from "./env.js";

const fromEnv = (env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const LOCAL_DEFAULTS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const ALLOW_LIST = new Set<string>([...fromEnv, ...LOCAL_DEFAULTS]);
const LOCAL_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

// Allow only hrms.plumtrips.com subdomains (not whole plumtrips.com)
const PROD_SUBDOMAIN_REGEX = /^https:\/\/([a-z0-9-]+\.)?hrms\.plumtrips\.com$/i;

export const corsMiddleware = cors({
  origin(origin, callback) {
    // Server-to-server / curl often has no Origin
    if (!origin) return callback(null, true);

    // Some sandboxed contexts can send "null" origin
    if (origin === "null") return callback(null, true); // remove if you want stricter security

    if (ALLOW_LIST.has(origin) || LOCAL_REGEX.test(origin)) {
      return callback(null, true);
    }

    if (PROD_SUBDOMAIN_REGEX.test(origin)) {
      return callback(null, true);
    }

    if (process.env.NODE_ENV !== "production") {
      console.warn(`⚠️  CORS blocked origin: ${origin}`);
    }

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
