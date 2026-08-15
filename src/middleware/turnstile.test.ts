// Coverage for the extracted Turnstile gate.
//
// This middleware had NO tests before Phase 2a — it was a module-private
// function inside routes/public.travelRequest.ts. Extracting it so
// /api/public/visa/lead could share one fail-closed gate is exactly the kind
// of change that deserves a safety net, so the net is added here.
//
// The fail-closed posture is the whole point: an unconfigured environment
// must REJECT, never silently accept unverified submissions.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createTurnstileGate } from "./turnstile.js";

function app() {
  const a = express();
  a.use(express.json());
  a.post("/probe", createTurnstileGate("test-surface"), (_req, res) =>
    res.status(200).json({ passed: true }),
  );
  return a;
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["TURNSTILE_SECRET", "TURNSTILE_DEV_BYPASS", "NODE_ENV"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe("fail-closed when unconfigured", () => {
  it("REJECTS when TURNSTILE_SECRET is unset and no bypass is active", async () => {
    const res = await request(app()).post("/probe").send({ turnstileToken: "anything" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Verification unavailable/);
  });

  it("does NOT fall through to the handler when unconfigured", async () => {
    const res = await request(app()).post("/probe").send({});
    expect(res.body.passed).toBeUndefined();
  });
});

describe("the dev bypass", () => {
  it("allows the request when TURNSTILE_DEV_BYPASS=true outside production", async () => {
    process.env.TURNSTILE_DEV_BYPASS = "true";
    process.env.NODE_ENV = "development";
    const res = await request(app()).post("/probe").send({});
    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(true);
  });

  it("is REFUSED in production even when the flag is set", async () => {
    // The one thing that must never be possible.
    process.env.TURNSTILE_DEV_BYPASS = "true";
    process.env.NODE_ENV = "production";
    const res = await request(app()).post("/probe").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Verification unavailable/);
  });

  it("is not triggered by any value other than the exact string 'true'", async () => {
    process.env.NODE_ENV = "development";
    for (const v of ["1", "yes", "TRUE", ""]) {
      process.env.TURNSTILE_DEV_BYPASS = v;
      const res = await request(app()).post("/probe").send({});
      expect(res.status).toBe(400);
    }
  });
});

describe("token verification against siteverify", () => {
  beforeEach(() => {
    process.env.TURNSTILE_SECRET = "test-secret";
    process.env.NODE_ENV = "test";
  });

  it("rejects a missing token before making any network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await request(app()).post("/probe").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Verification required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes when siteverify reports success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) })),
    );

    const res = await request(app()).post("/probe").send({ turnstileToken: "good-token" });
    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(true);
  });

  it("rejects when siteverify reports failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
      })),
    );

    const res = await request(app()).post("/probe").send({ turnstileToken: "bad-token" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Verification failed/);
  });

  it("rejects when siteverify itself errors — never fails open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const res = await request(app()).post("/probe").send({ turnstileToken: "any" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Verification unavailable/);
  });

  it("sends the secret and the response token to siteverify", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    await request(app()).post("/probe").send({ turnstileToken: "the-token" });

    const [url, init] = fetchSpy.mock.calls[0] as any[];
    expect(String(url)).toContain("challenges.cloudflare.com");
    const body = (init.body as URLSearchParams).toString();
    expect(body).toContain("secret=test-secret");
    expect(body).toContain("response=the-token");
  });

  it("never echoes the failure reason to the caller", async () => {
    // A bot must not learn which check rejected it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: false, "error-codes": ["timeout-or-duplicate"] }),
      })),
    );

    const res = await request(app()).post("/probe").send({ turnstileToken: "x" });
    expect(JSON.stringify(res.body)).not.toContain("timeout-or-duplicate");
  });
});
