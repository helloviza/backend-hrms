// Keying coverage for the global and per-route limiters, against the REAL
// limiter instances from rateLimit.ts mounted on a bare express app — no
// mocks. Client IPs are simulated with X-Forwarded-For under the same
// `trust proxy = 1` setting server.ts uses.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { Server } from "node:http";

const SECRET = "rate-limit-test-jwt-secret";
process.env.JWT_SECRET = SECRET;
process.env.JWT_REFRESH_SECRET ||= "rate-limit-test-refresh";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:1/unused";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";

const {
  apiLimiter,
  authLimiter,
  hotelImagesLimiter,
  hotelSearchLimiter,
  API_LIMIT_PER_USER,
  API_LIMIT_PER_IP_ANON,
} = await import("./rateLimit.js");

const tokenFor = (sub: string, secret = SECRET) =>
  jwt.sign({ sub, roles: ["EMPLOYEE"] }, secret, { expiresIn: "1h" });

let server: Server;

beforeAll(() => {
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api", apiLimiter);
  app.use("/api/auth", authLimiter);
  app.use("/api/sbt/hotels/images", hotelImagesLimiter);
  app.use("/api/sbt/hotels/search", hotelSearchLimiter);
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  app.get("/api/auth/me", (_req, res) => res.json({ ok: true }));
  app.get("/api/auth/other", (_req, res) => res.json({ ok: true }));
  app.get("/api/sbt/hotels/images", (_req, res) => res.json({ ok: true }));
  app.get("/api/sbt/hotels/search", (_req, res) => res.json({ ok: true }));
  server = app.listen(0);
});

afterAll(() => {
  server.close();
});

async function hit(path: string, ip: string, token: string | null, n: number) {
  let last = 0;
  for (let i = 0; i < n; i++) {
    const req = request(server).get(path).set("X-Forwarded-For", ip);
    if (token) req.set("Authorization", `Bearer ${token}`);
    last = (await req).status;
    if (last !== 200) return { status: last, at: i + 1 };
  }
  return { status: last, at: n };
}

describe("apiLimiter keying", () => {
  it("limits anonymous traffic per IP at the anonymous ceiling", async () => {
    const ip = "198.51.100.1";
    const ok = await hit("/api/ping", ip, null, API_LIMIT_PER_IP_ANON);
    expect(ok).toEqual({ status: 200, at: API_LIMIT_PER_IP_ANON });
    const blocked = await hit("/api/ping", ip, null, 1);
    expect(blocked.status).toBe(429);
  });

  it("gives two users on one IP independent per-user buckets", async () => {
    const ip = "198.51.100.2";
    const a = tokenFor("user-a");
    const b = tokenFor("user-b");

    // User A burns through the anonymous ceiling and keeps going to the user ceiling.
    const aRun = await hit("/api/ping", ip, a, API_LIMIT_PER_USER);
    expect(aRun).toEqual({ status: 200, at: API_LIMIT_PER_USER });
    expect((await hit("/api/ping", ip, a, 1)).status).toBe(429);

    // Same IP: user B and an anonymous caller are untouched by A's bucket.
    expect((await hit("/api/ping", ip, b, 1)).status).toBe(200);
    expect((await hit("/api/ping", ip, null, 1)).status).toBe(200);
  }, 60_000);

  it("treats a forged token as anonymous (IP bucket)", async () => {
    const ip = "198.51.100.3";
    await hit("/api/ping", ip, null, API_LIMIT_PER_IP_ANON);
    const forged = tokenFor("user-a", "not-the-real-secret");
    expect((await hit("/api/ping", ip, forged, 1)).status).toBe(429);
  });

  it("logs the first 429 of a bucket with user and IP", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ip = "198.51.100.4";
    const c = tokenFor("user-c");
    await hit("/api/sbt/hotels/images", ip, c, 200);
    expect((await hit("/api/sbt/hotels/images", ip, c, 1)).status).toBe(429);
    const line = warn.mock.calls.map((x) => String(x[0])).find((l) => l.includes("limiter=hotelImages"));
    expect(line).toContain("user=user-c");
    expect(line).toContain(`ip=${ip}`);
    warn.mockRestore();
  });
});

describe("per-route limiters", () => {
  it("caps /sbt/hotels/images per user, independent across users on one IP", async () => {
    const ip = "198.51.100.5";
    const d = tokenFor("user-d");
    const e = tokenFor("user-e");
    expect(await hit("/api/sbt/hotels/images", ip, d, 200)).toEqual({ status: 200, at: 200 });
    expect((await hit("/api/sbt/hotels/images", ip, d, 1)).status).toBe(429);
    expect((await hit("/api/sbt/hotels/images", ip, e, 1)).status).toBe(200);
  });

  it("caps hotel search per user, independent across users on one IP", async () => {
    const ip = "198.51.100.7";
    const f = tokenFor("user-f");
    const g = tokenFor("user-g");
    expect(await hit("/api/sbt/hotels/search", ip, f, 20)).toEqual({ status: 200, at: 20 });
    expect((await hit("/api/sbt/hotels/search", ip, f, 1)).status).toBe(429);
    expect((await hit("/api/sbt/hotels/search", ip, g, 1)).status).toBe(200);
  });

  it("hotel search falls back to the IP bucket with no token (or a forged one)", async () => {
    const ip = "198.51.100.8";
    expect(await hit("/api/sbt/hotels/search", ip, null, 20)).toEqual({ status: 200, at: 20 });
    expect((await hit("/api/sbt/hotels/search", ip, null, 1)).status).toBe(429);
    const forged = tokenFor("user-f", "not-the-real-secret");
    expect((await hit("/api/sbt/hotels/search", ip, forged, 1)).status).toBe(429);
    // A real user on that same exhausted IP is unaffected.
    expect((await hit("/api/sbt/hotels/search", ip, tokenFor("user-h"), 1)).status).toBe(200);
    // And anonymous traffic from another IP has its own bucket.
    expect((await hit("/api/sbt/hotels/search", "198.51.100.9", null, 1)).status).toBe(200);
  });

  it("authLimiter skips /me but still counts other auth routes", async () => {
    const ip = "198.51.100.6";
    // 250 > authLimiter's 200: /me never trips it (and stays under the anon 500).
    expect(await hit("/api/auth/me", ip, null, 250)).toEqual({ status: 200, at: 250 });
    const other = await hit("/api/auth/other", ip, null, 201);
    expect(other).toEqual({ status: 429, at: 201 });
  });
});
