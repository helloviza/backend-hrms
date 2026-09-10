// apps/backend/src/config/razorpayMode.test.ts
//
// The guard is a boot-time throw, so what these prove is the decision
// table itself rather than a running server: config/env.ts does nothing
// but hand it process.env.RAZORPAY_KEY_ID and env.NODE_ENV.
//
// Every key below is a fake with a real prefix. No live key, no test key,
// nothing that reaches Razorpay — the prefix is the entire input.
import { describe, it, expect, vi, afterEach } from "vitest";
import { assertRazorpayKeyMatchesEnv, assertRazorpayKeyModeMatchesEnv } from "./razorpayMode.js";

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

/* ═══════════════════════════════════════════════════════════════════════
 * TWO KEYS: THE D2C MID SPLIT
 *
 * D2C settles to its own Razorpay account, so config/env.ts now guards two
 * key ids. The decision under test is the ONE asymmetry between them:
 *
 *   WRONG MODE  → fatal for both. It is the wrong-money check, and wrong
 *                 money is wrong money whichever MID it belongs to.
 *   ABSENT      → fatal for B2B (unchanged), REPORTED for D2C. An absent
 *                 key cannot move money — the call site answers 503 — so
 *                 refusing to boot would take flights and hotels down over
 *                 an unset visa-fee variable.
 *
 * Expressed as two functions rather than a flag, so the call site in
 * config/env.ts says which rule it wants by name.
 * ═══════════════════════════════════════════════════════════════════════ */

const D2C_LABEL = "RAZORPAY_D2C_KEY_ID";

describe("assertRazorpayKeyModeMatchesEnv — wrong mode is still fatal for the D2C key", () => {
  it("test key + production throws, and names the D2C variable", () => {
    expect(() => assertRazorpayKeyModeMatchesEnv(TEST_KEY, "production", D2C_LABEL)).toThrow(
      /RAZORPAY_D2C_KEY_ID is rzp_test_ but NODE_ENV=production — refusing to start/,
    );
  });

  it("live key + development throws, and names the D2C variable", () => {
    expect(() => assertRazorpayKeyModeMatchesEnv(LIVE_KEY, "development", D2C_LABEL)).toThrow(
      /RAZORPAY_D2C_KEY_ID is rzp_live_ but NODE_ENV=development — refusing to start/,
    );
  });

  it("live key + test throws too — a suite is not production either", () => {
    expect(() => assertRazorpayKeyModeMatchesEnv(LIVE_KEY, "test", D2C_LABEL)).toThrow(
      /RAZORPAY_D2C_KEY_ID is rzp_live_ but NODE_ENV=test — refusing to start/,
    );
  });

  it("garbage prefix + production throws — unverifiable is not 'probably fine'", () => {
    expect(() => assertRazorpayKeyModeMatchesEnv("REPLACE_ME", "production", D2C_LABEL)).toThrow(
      /an unrecognised prefix but NODE_ENV=production — refusing to start/,
    );
  });

  it("the modes that agree return CONFIGURED and do not throw", () => {
    expect(assertRazorpayKeyModeMatchesEnv(TEST_KEY, "development", D2C_LABEL)).toBe("CONFIGURED");
    expect(assertRazorpayKeyModeMatchesEnv(TEST_KEY, "test", D2C_LABEL)).toBe("CONFIGURED");
    expect(assertRazorpayKeyModeMatchesEnv(LIVE_KEY, "production", D2C_LABEL)).toBe("CONFIGURED");
  });
});

describe("assertRazorpayKeyModeMatchesEnv — an absent key is REPORTED, never thrown", () => {
  it("absent + production does NOT throw — this is the whole D2C decision", () => {
    // The B2B function throws for exactly this input (asserted above). The
    // difference is deliberate: with no key, routes/consumer.applications.ts
    // answers 503 GATEWAY_NOT_CONFIGURED and no consumer is charged
    // anything, so the correct blast radius is one feature, not the process.
    expect(() => assertRazorpayKeyModeMatchesEnv(undefined, "production", D2C_LABEL)).not.toThrow();
    expect(assertRazorpayKeyModeMatchesEnv(undefined, "production", D2C_LABEL)).toBe("NOT_CONFIGURED");
  });

  it("blank and whitespace count as absent, in production and out", () => {
    // A variable set to "" in App Runner is not a key.
    expect(assertRazorpayKeyModeMatchesEnv("", "production", D2C_LABEL)).toBe("NOT_CONFIGURED");
    expect(assertRazorpayKeyModeMatchesEnv("   ", "production", D2C_LABEL)).toBe("NOT_CONFIGURED");
    expect(assertRazorpayKeyModeMatchesEnv(undefined, "development", D2C_LABEL)).toBe("NOT_CONFIGURED");
  });

  it("an absent key does not warn either — there is nothing to be unsure about", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    assertRazorpayKeyModeMatchesEnv(undefined, "production", D2C_LABEL);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the B2B rule is unchanged by the split", () => {
  it("still fails closed on an absent key in production", () => {
    expect(() => assertRazorpayKeyMatchesEnv(undefined, "production")).toThrow(
      /not configured but NODE_ENV=production — refusing to start/,
    );
  });

  it("still names RAZORPAY_KEY_ID when called with no label — the default is the B2B var", () => {
    expect(() => assertRazorpayKeyMatchesEnv(undefined, "production")).toThrow(/RAZORPAY_KEY_ID/);
    expect(() => assertRazorpayKeyMatchesEnv(TEST_KEY, "production")).toThrow(/RAZORPAY_KEY_ID/);
  });

  it("the warn for an unverifiable key still names the variable it is about", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    assertRazorpayKeyMatchesEnv("REPLACE_ME", "development");
    assertRazorpayKeyModeMatchesEnv("REPLACE_ME", "development", D2C_LABEL);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toMatch(/RAZORPAY_KEY_ID does not begin with/);
    expect(String(warn.mock.calls[1][0])).toMatch(/RAZORPAY_D2C_KEY_ID does not begin with/);
  });

  it("a labelled call to the B2B rule still fails closed — the label is cosmetic, the rule is not", () => {
    // Guards against a future refactor quietly making `label` mean "and be
    // lenient about absence too".
    expect(() => assertRazorpayKeyMatchesEnv(undefined, "production", D2C_LABEL)).toThrow(
      /RAZORPAY_D2C_KEY_ID is not configured but NODE_ENV=production/,
    );
  });
});
