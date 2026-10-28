// The access log must never carry a credential from the query string.
// GET /api/chat/stream?token=<JWT> used to land in CloudWatch verbatim.
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { requestLogger } from "./requestLogger.js";
import { redactUrlSecrets, isSecretParamName } from "./redactUrl.js";

function appWithCapturedLog() {
  const lines: string[] = [];
  const app = express();
  app.use((req: any, _res, next) => {
    req.requestId = "rid-1";
    next();
  });
  app.use(requestLogger({ stream: { write: (l: string) => void lines.push(l.trim()) } }));
  app.get("/api/chat/stream", (_req, res) => res.status(200).end());
  return { app, lines };
}

describe("request log line", () => {
  it("shows token=[REDACTED], never the token", async () => {
    const { app, lines } = appWithCapturedLog();
    const jwtish = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig";
    await request(app).get(`/api/chat/stream?token=${jwtish}&channel=general`);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^rid-1 GET \/api\/chat\/stream\?token=\[REDACTED\]&channel=general 200 /);
    expect(lines[0]).not.toContain(jwtish);
  });

  it("redacts key / secret / code / sig and their variants, keeps everything else", async () => {
    const { app, lines } = appWithCapturedLog();
    await request(app).get(
      "/api/chat/stream?key=k1&api_key=k2&secret=s1&code=c1&sig=g1&X-Amz-Signature=g2&access_token=t2&page=2&countryCode=IN",
    );
    const line = lines[0];
    for (const v of ["k1", "k2", "s1", "c1", "g1", "g2", "t2"]) expect(line).not.toContain(`=${v}`);
    expect(line).toContain("key=[REDACTED]");
    expect(line).toContain("code=[REDACTED]");
    expect(line).toContain("sig=[REDACTED]");
    expect(line).toContain("page=2");
    expect(line).toContain("countryCode=IN");
  });
});

describe("redactUrlSecrets", () => {
  it("leaves URLs without a query alone", () => {
    expect(redactUrlSecrets("/api/health")).toBe("/api/health");
    expect(redactUrlSecrets(undefined)).toBe("");
  });

  it("matches an encoded param name, and a valueless param is left alone", () => {
    expect(redactUrlSecrets("/x?%74oken=abc&flag")).toBe("/x?%74oken=[REDACTED]&flag");
  });

  it("name rules", () => {
    for (const n of ["token", "TOKEN", "refreshToken", "secret", "client_secret", "key", "api-key", "code", "auth_code", "sig", "signature", "password"]) {
      expect(isSecretParamName(n), n).toBe(true);
    }
    for (const n of ["page", "status", "countryCode", "customerCode", "monkey", "q"]) {
      expect(isSecretParamName(n), n).toBe(false);
    }
  });
});
