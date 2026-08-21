// apps/backend/src/config/razorpayMode.test.ts
//
// The guard is a boot-time throw, so what these prove is the decision
// table itself rather than a running server: config/env.ts does nothing
// but hand it process.env.RAZORPAY_KEY_ID and env.NODE_ENV.
//
// Every key below is a fake with a real prefix. No live key, no test key,
// nothing that reaches Razorpay — the prefix is the entire input.
import { describe, it, expect, vi, afterEach } from "vitest";
import { assertRazorpayKeyMatchesEnv } from "./razorpayMode.js";

const TEST_KEY = "rzp_test_FAKEKEYID";
const LIVE_KEY = "rzp_live_FAKEKEYID";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assertRazorpayKeyMatchesEnv — the modes that agree", () => {
  it("test key + development boots", () => {
    expect(() => assertRazorpayKeyMatchesEnv(TEST_KEY, "development")).not.toThrow();
  });

  it("test key + test boots — this is what the suites run under", () => {
    expect(() => assertRazorpayKeyMatchesEnv(TEST_KEY, "test")).not.toThrow();
  });

  it("live key + production boots", () => {
    expect(() => assertRazorpayKeyMatchesEnv(LIVE_KEY, "production")).not.toThrow();
  });
});

describe("assertRazorpayKeyMatchesEnv — the modes that must not", () => {
  it("test key + production throws, naming both sides", () => {
    expect(() => assertRazorpayKeyMatchesEnv(TEST_KEY, "production")).toThrow(
      /rzp_test_ but NODE_ENV=production — refusing to start/,
    );
  });

  it("live key + development throws, naming both sides", () => {
    expect(() => assertRazorpayKeyMatchesEnv(LIVE_KEY, "development")).toThrow(
      /rzp_live_ but NODE_ENV=development — refusing to start/,
    );
  });

  it("live key + test throws too — a suite is not production either", () => {
    expect(() => assertRazorpayKeyMatchesEnv(LIVE_KEY, "test")).toThrow(
      /rzp_live_ but NODE_ENV=test — refusing to start/,
    );
  });
});

describe("assertRazorpayKeyMatchesEnv — fail closed in production", () => {
  it("absent key + production throws", () => {
    expect(() => assertRazorpayKeyMatchesEnv(undefined, "production")).toThrow(
      /not configured but NODE_ENV=production — refusing to start/,
    );
  });

  it("empty/whitespace key + production throws — blank is absent", () => {
    expect(() => assertRazorpayKeyMatchesEnv("   ", "production")).toThrow(
      /not configured but NODE_ENV=production — refusing to start/,
    );
  });

  it("garbage prefix + production throws", () => {
    expect(() => assertRazorpayKeyMatchesEnv("REPLACE_ME", "production")).toThrow(
      /an unrecognised prefix but NODE_ENV=production — refusing to start/,
    );
  });
});

describe("assertRazorpayKeyMatchesEnv — the states dev is allowed to be in", () => {
  it("absent key outside production is legal — the gateway is simply off", () => {
    // Every call site already answers 503 GATEWAY_NOT_CONFIGURED for this.
    // Throwing here would break CI and a fresh clone to prevent a charge
    // that has no key to make it with.
    expect(() => assertRazorpayKeyMatchesEnv(undefined, "development")).not.toThrow();
    expect(() => assertRazorpayKeyMatchesEnv("", "test")).not.toThrow();
  });

  it("garbage prefix outside production warns but does not block boot", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertRazorpayKeyMatchesEnv("REPLACE_ME", "development")).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/mode cannot be verified/);
  });

  it("a valid test key does NOT warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    assertRazorpayKeyMatchesEnv(TEST_KEY, "development");
    expect(warn).not.toHaveBeenCalled();
  });
});
