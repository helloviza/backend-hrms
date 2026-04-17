// apps/backend/src/config/cors.ts
import cors from "cors";
import { env } from "./env.js";

const ALLOWED_ORIGINS = [
  "https://plumbox.plumtrips.com",
  "https://app.plumbox.in",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:8080",
  // Include any extra origins from FRONTEND_ORIGIN env var
  ...(env.FRONTEND_ORIGIN
    ? env.FRONTEND_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
    : []),
];

export const corsMiddleware = cors({
  origin(origin, callback) {
    // Allow no-origin requests (health checks, server-to-server, mobile apps)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    console.warn(`[CORS BLOCKED] Origin: ${origin}`);
    return callback(new Error(`Origin ${origin} not allowed`), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Request-ID",
    "X-Requested-With",
  ],
  exposedHeaders: ["X-Request-ID"],
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 204,
});
