// apps/backend/src/config/cors.ts
import cors from "cors";
import { env } from "./env.js";

const ALLOWED_ORIGINS = [
  "https://plumbox.plumtrips.com",
  "https://hrms.plumtrips.com",
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
    // Allow requests with no origin (mobile apps, Postman in dev, server-to-server)
    if (!origin) {
      if (process.env.NODE_ENV === "production") {
        return callback(new Error("Direct API access not allowed"), false);
      }
      return callback(null, true);
    }
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
