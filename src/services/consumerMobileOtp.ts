// apps/backend/src/services/consumerMobileOtp.ts
//
// MSG91 v5 OTP, wrapped. The FIRST transactional-SMS integration in this
// codebase — before this there was no SMS provider of any kind (the two
// WhatsApp layers, whatsapp-web.js and whatsappCloud.service.ts, are
// WhatsApp, not SMS).
//
// ══════════════════════════════════════════════════════════════════════
// WE DO NOT STORE THE CODE. MSG91 DOES.
// ══════════════════════════════════════════════════════════════════════
// There is no Otp collection, no hashed code, no expiry column and no
// attempt counter in our database, and that is the design rather than an
// omission. MSG91's v5 OTP product owns generation, expiry and
// attempt-limiting; mirroring any of it here would mean two clocks and two
// attempt counters that disagree the moment one call fails halfway. The
// ONLY thing we persist is the OUTCOME — contact.mobileVerified — and only
// after MSG91 answers `type: "success"` to a verify.
//
// The consequence, stated plainly: this module cannot tell you whether a
// code is outstanding, how many attempts remain, or when one expires. Every
// one of those questions is answered by asking MSG91, and the UI is built
// to not need them.
//
// ── PORTED FROM THE REFERENCE, AND WHAT CHANGED ───────────────────────
// The call shapes (paths, query params, the `type === "success"` contract,
// the HTML/invalid-JSON guards) come from a proven implementation on
// another site. Four things are deliberately different:
//
//   1. TRANSPORT. The reference used node:https with a manual chunk
//      collector. This uses fetch — Node 22 has it, middleware/turnstile.ts
//      already calls an external verifier that way, and one HTTP idiom in
//      the codebase beats two.
//   2. TEMPLATE. The reference carried a three-entry TEMPLATE_MAP with the
//      ids written inline. Only the verifyMobile flow exists here, and the
//      id is a DLT-registered artefact that differs per environment, so it
//      is an env var (config/env.ts) rather than a literal.
//   3. THE NUMBER IS NEVER AN ARGUMENT FROM THE WIRE. The reference took
//      `mobile` from the request body. Here the caller is a route that
//      reads it off the authenticated consumer's own profile — see
//      routes/consumer.mobileOtp.ts. This module still takes it as a
//      parameter (it has no business reading a session), but every caller
//      in the tree passes a profile-sourced value.
//   4. NO RAW PROVIDER TEXT REACHES THE CLIENT. The reference returned
//      MSG91's `raw` HTML fragment and full payload in its error bodies.
//      That leaks provider internals to the browser; here the raw text goes
//      to the log (key-redacted) and the client gets a typed reason.
import { env } from "../config/env.js";
import logger from "../utils/logger.js";

const MSG91_HOST = "https://control.msg91.com";

const otpLogger = logger.child({ module: "consumer-mobile-otp" });

/** Thrown when the provider credentials are absent in production. */
export class MobileOtpNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`MSG91 is not configured — missing: ${missing.join(", ")}`);
    this.name = "MobileOtpNotConfiguredError";
  }
}

/**
 * Why a send/verify failed, in terms the ROUTE can branch on and the UI can
 * render. Deliberately a small closed set: MSG91's own `message` strings are
 * provider copy that can change without notice, so they are classified here
 * once rather than pattern-matched at three call sites.
 */
export type MobileOtpFailure =
  | "not_configured" // no key/template — a 503, not the user's fault
  | "invalid_mobile" // not a 10-digit Indian number
  | "invalid_code" // wrong OTP
  | "expired" // OTP no longer valid
  | "too_many_attempts" // MSG91's own attempt cap tripped
  | "provider_error"; // anything else, including HTML/garbage responses

/*
 * The `reason?: undefined` / `message?: undefined` on the success arm is
 * not decoration — it is what makes this union usable in THIS project.
 * tsconfig.json runs in compatibility mode with strictNullChecks OFF, and
 * without it TypeScript does not narrow a boolean-literal discriminant on
 * `if (!result.ok)`, so every `result.reason` after such a check is an
 * error. Declaring the keys as always-present-but-optional makes the access
 * legal on both arms while keeping the two shapes documented. Delete these
 * two lines the day the backend turns strict on, not before.
 */
export type MobileOtpResult =
  | { ok: true; reason?: undefined; message?: undefined }
  | { ok: false; reason: MobileOtpFailure; message: string };

/**
 * 10-digit India only, matching the reference — we prefix 91 on every
 * outbound call, so anything else would be sent to the wrong country.
 * Accepts a leading 91 (12 digits) and strips it, because that is what a
 * consumer who types their number "as it appears on WhatsApp" produces.
 *
 * Returns "" for anything it cannot make a 10-digit number of. A +1 number
 * is REJECTED rather than silently truncated to its last ten digits: this
 * function is the only thing standing between a mistyped international
 * number and an SMS billed to the wrong destination.
 */
export function normaliseIndiaMobile(raw: unknown): string {
  const digits = String(raw ?? "").replace(/[^\d]/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return "";
}

/** What is missing, if anything. Empty array means fully configured. */
function missingConfig(): string[] {
  const missing: string[] = [];
  if (!String(env.MSG91_AUTH_KEY || "").trim()) missing.push("MSG91_AUTH_KEY");
  if (!String(env.MSG91_VERIFY_TEMPLATE_ID || "").trim()) missing.push("MSG91_VERIFY_TEMPLATE_ID");
  return missing;
}

export function isMobileOtpConfigured(): boolean {
  return missingConfig().length === 0;
}

/**
 * The production/dev split, mirroring security/piiMasterKey.ts.
 *
 * In PRODUCTION an absent key THROWS — a consumer-facing verify flow that
 * silently no-ops is worse than one that errors loudly, because the flag it
 * would fail to set is the flag the submit gate trusts.
 *
 * Outside production it returns a typed failure instead, so a developer
 * with no key gets a clear 503 on this one flow rather than a stack trace,
 * and the rest of the account page keeps working.
 *
 * WHAT THIS DELIBERATELY DOES **NOT** DO: there is no dev fallback that
 * accepts a fixed code like "123456". That would be an authentication
 * bypass sitting one mis-set NODE_ENV away from production, guarding the
 * exact flag the application-submit gate reads. A developer without a
 * provider key cannot verify a mobile, and that is the correct outcome.
 */
function guardConfigured(): MobileOtpResult | null {
  const missing = missingConfig();
  if (missing.length === 0) return null;

  if (env.NODE_ENV === "production") {
    throw new MobileOtpNotConfiguredError(missing);
  }

  otpLogger.warn("MSG91 not configured — mobile OTP unavailable in this environment", { missing });
  return {
    ok: false,
    reason: "not_configured",
    message: "Mobile verification is not available in this environment.",
  };
}

/** The authkey, out of anything about to be logged. */
function redact(text: string): string {
  const key = String(env.MSG91_AUTH_KEY || "").trim();
  const masked = key ? text.split(key).join("<redacted>") : text;
  // Belt and braces: catch an authkey param even if the value differs from
  // the one currently in env (rotation mid-process).
  return masked.replace(/(authkey=)[^&\s]+/gi, "$1<redacted>");
}

// Optional-on-the-success-arm for the same strictNullChecks reason as
// MobileOtpResult above.
type Msg91Response =
  | { ok: true; status: number; json: any; kind?: undefined; raw?: undefined }
  | { ok: false; status: number; kind: "html" | "invalid_json"; raw: string };

/**
 * One HTTP call to MSG91, with the reference's two guards preserved:
 * MSG91 answers with an HTML error page on a blocked or invalid auth key,
 * and can return non-JSON on some failures. Both would throw inside
 * res.json() and surface as a 500 from a request that actually completed.
 */
async function callMsg91(method: "GET" | "POST", path: string): Promise<Msg91Response> {
  const res = await fetch(`${MSG91_HOST}${path}`, {
    method,
    headers: { "content-type": "application/json" },
  });

  const text = (await res.text()).trim();

  if (text.startsWith("<")) {
    return { ok: false, status: res.status, kind: "html", raw: text.slice(0, 400) };
  }

  try {
    return { ok: true, status: res.status, json: JSON.parse(text || "{}") };
  } catch {
    return { ok: false, status: res.status, kind: "invalid_json", raw: text.slice(0, 400) };
  }
}

/**
 * MSG91's error prose → our closed reason set.
 *
 * Matching on message text is not something to be proud of, but the v5 OTP
 * API returns `{type:"error", message:"..."}` with no stable machine code,
 * so it is match-on-prose here or match-on-prose at every call site. The
 * fallback is always the safe generic, so new provider copy degrades to
 * "invalid code" rather than to a crash.
 */
function classifyVerifyFailure(payload: any): { reason: MobileOtpFailure; message: string } {
  const text = String(payload?.message ?? "").toLowerCase();

  if (text.includes("expire")) {
    return { reason: "expired", message: "That code has expired. Request a new one." };
  }
  if (text.includes("attempt") || text.includes("limit") || text.includes("exceed")) {
    return {
      reason: "too_many_attempts",
      message: "Too many incorrect attempts. Request a new code.",
    };
  }
  return { reason: "invalid_code", message: "That code isn't right. Check it and try again." };
}

/**
 * SEND — POST /api/v5/otp.
 *
 * `realTimeResponse=true` makes MSG91 answer with the real outcome rather
 * than an accepted-for-delivery ack, which is what lets a failed send show
 * as a failure in the UI instead of a code that never arrives.
 */
export async function sendMobileOtp(mobile10: string): Promise<MobileOtpResult> {
  const notConfigured = guardConfigured();
  if (notConfigured) return notConfigured;

  const m = normaliseIndiaMobile(mobile10);
  if (!m) {
    return {
      ok: false,
      reason: "invalid_mobile",
      message: "A valid 10-digit Indian mobile number is required.",
    };
  }

  const params = new URLSearchParams({
    otp_expiry: String(env.MSG91_OTP_EXPIRY_MIN),
    template_id: String(env.MSG91_VERIFY_TEMPLATE_ID).trim(),
    mobile: `91${m}`,
    authkey: String(env.MSG91_AUTH_KEY).trim(),
    realTimeResponse: "true",
  });

  return runProviderCall("send", "POST", `/api/v5/otp?${params.toString()}`, () => ({
    reason: "provider_error" as const,
    message: "We couldn't send the code just now. Please try again shortly.",
  }));
}

/** VERIFY — GET /api/v5/otp/verify. */
export async function verifyMobileOtp(mobile10: string, code: string): Promise<MobileOtpResult> {
  const notConfigured = guardConfigured();
  if (notConfigured) return notConfigured;

  const m = normaliseIndiaMobile(mobile10);
  const otp = String(code ?? "").replace(/[^\d]/g, "");
  if (!m) {
    return {
      ok: false,
      reason: "invalid_mobile",
      message: "A valid 10-digit Indian mobile number is required.",
    };
  }
  if (!otp) {
    return { ok: false, reason: "invalid_code", message: "Enter the code we sent you." };
  }

  const params = new URLSearchParams({
    otp,
    mobile: `91${m}`,
    authkey: String(env.MSG91_AUTH_KEY).trim(),
  });

  return runProviderCall("verify", "GET", `/api/v5/otp/verify?${params.toString()}`, (payload) =>
    classifyVerifyFailure(payload),
  );
}

/**
 * RESEND — GET /api/v5/otp/retry, `retrytype=text`.
 *
 * A retry is MSG91 re-sending the OUTSTANDING code, not minting a new one.
 * That matters for the UI copy: "we've sent it again" is true, "here's a
 * new code" is not.
 */
export async function resendMobileOtp(mobile10: string): Promise<MobileOtpResult> {
  const notConfigured = guardConfigured();
  if (notConfigured) return notConfigured;

  const m = normaliseIndiaMobile(mobile10);
  if (!m) {
    return {
      ok: false,
      reason: "invalid_mobile",
      message: "A valid 10-digit Indian mobile number is required.",
    };
  }

  const params = new URLSearchParams({
    authkey: String(env.MSG91_AUTH_KEY).trim(),
    retrytype: "text",
    mobile: `91${m}`,
  });

  return runProviderCall("resend", "GET", `/api/v5/otp/retry?${params.toString()}`, () => ({
    reason: "provider_error" as const,
    message: "We couldn't resend the code just now. Please try again shortly.",
  }));
}

/**
 * The shared tail of all three calls: issue it, survive a non-JSON answer,
 * apply the `type === "success"` contract, and log failures with the key
 * stripped. `onFailure` is what turns a provider payload into our reason —
 * the only part that differs between the three.
 */
async function runProviderCall(
  label: string,
  method: "GET" | "POST",
  path: string,
  onFailure: (payload: any) => { reason: MobileOtpFailure; message: string },
): Promise<MobileOtpResult> {
  let result: Msg91Response;
  try {
    result = await callMsg91(method, path);
  } catch (err) {
    otpLogger.error(`${label} — request to MSG91 failed`, {
      error: redact(err instanceof Error ? err.message : String(err)),
    });
    return {
      ok: false,
      reason: "provider_error",
      message: "We couldn't reach our SMS provider. Please try again shortly.",
    };
  }

  if (!result.ok) {
    otpLogger.error(`${label} — unexpected response from MSG91`, {
      status: result.status,
      kind: result.kind,
      raw: redact(result.raw),
    });
    return {
      ok: false,
      reason: "provider_error",
      message: "We couldn't reach our SMS provider. Please try again shortly.",
    };
  }

  if (result.json?.type === "success") return { ok: true };

  const failure = onFailure(result.json);
  // A verify failure is a NORMAL event (someone mistyped) — logged at info,
  // without the code and without the number, so a routine typo does not
  // read as an incident and a log reader never sees either secret.
  otpLogger.info(`${label} — MSG91 returned a non-success response`, {
    status: result.status,
    reason: failure.reason,
    providerMessage: redact(String(result.json?.message ?? "")),
  });
  return { ok: false, ...failure };
}
