// apps/backend/src/config/cors.test.ts
//
// Browser preflights against the real corsMiddleware, mounted the way
// server.ts mounts it (app.options("*") + app.use). Plumbox
// (plumbox.plumtrips.com) calls the API (api.hrms.plumtrips.com) cross-origin,
// so every custom request header has to be in allowedHeaders or the browser
// drops the request before it is sent:
//   - partner-track verify (POST, Content-Type) and cases (GET,
//     X-Partner-Track-Token) → 204 with the header allowed;
//   - an origin not on the list gets no Access-Control-Allow-Origin.
import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";

process.env.NODE_ENV = "test";
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  JWT_SECRET: "jwt-secret-for-tests",
  JWT_REFRESH_SECRET: "refresh-secret-for-tests",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
})) process.env[k] ||= v;

const PLUMBOX = "https://plumbox.plumtrips.com";
let app: express.Express;

beforeAll(async () => {
  const { corsMiddleware } = await import("./cors.js");
  app = express();
  app.options("*", corsMiddleware);
  app.use(corsMiddleware);
});

const preflight = (path: string, origin: string, method: string, headers: string) =>
  request(app).options(path).set("Origin", origin).set("Access-Control-Request-Method", method).set("Access-Control-Request-Headers", headers);

const allowed = (res: request.Response) => String(res.headers["access-control-allow-headers"] || "").toLowerCase().split(",").map((h) => h.trim());

describe("CORS preflight", () => {
  it("partner-track cases: allows the track token header from Plumbox", async () => {
    const res = await preflight("/api/public/partner-track/cases", PLUMBOX, "GET", "x-partner-track-token");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(PLUMBOX);
    expect(allowed(res)).toContain("x-partner-track-token");
  });

  it("partner-track verify: allows Content-Type from Plumbox", async () => {
    const res = await preflight("/api/public/partner-track/verify", PLUMBOX, "POST", "content-type");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(PLUMBOX);
    expect(allowed(res)).toContain("content-type");
  });

  it("an origin not on the list is refused", async () => {
    const res = await preflight("/api/public/partner-track/cases", "https://evil.example.com", "GET", "x-partner-track-token");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-headers"]).toBeUndefined();
  });
});
