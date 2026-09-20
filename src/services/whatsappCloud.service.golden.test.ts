// PlumConnect Slice 4a, Part A — the senders are byte-identical on the wire
// after gaining their return values. The golden is not hand-typed: every
// legacy* function below is the pre-4a sender copied VERBATIM from
// whatsappCloud.service.ts at 8c229115 (the last commit before this change),
// run against the same fake Graph adapter and the same logger spies. For
// each sender × {success, Graph 400, not configured} the request payload,
// the logger calls and the value the legacy caller sees are compared.
import { describe, it, expect, beforeEach, vi } from "vitest";
import axios from "axios";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/x";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.WA_ACCESS_TOKEN = "test-token";
process.env.WA_PHONE_NUMBER_ID = "1265026903369191";

const L = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ whatsappLogger: L, default: L }));

const cloud = await import("./whatsappCloud.service.js");
const { env } = await import("../config/env.js");
const whatsappLogger = L;
const GRAPH_BASE = "https://graph.facebook.com";

/* ── fake Graph ─────────────────────────────────────────────────────── */
type Call = { url: string; body: any; headers: any; timeout: number | undefined };
const calls: Call[] = [];
let mode: "ok" | "fail" = "ok";
let configured = true;
axios.defaults.adapter = async (config) => {
  calls.push({ url: String(config.url), body: JSON.parse(config.data), headers: { Authorization: config.headers?.Authorization, "Content-Type": config.headers?.["Content-Type"] }, timeout: config.timeout });
  if (mode === "fail") {
    const err: any = new Error("Request failed with status code 400");
    err.isAxiosError = true;
    err.config = config;
    err.response = { status: 400, data: { error: { message: "(#131030) Recipient not in allowed list", code: 131030 } }, headers: {}, config };
    throw err;
  }
  return { data: { messaging_product: "whatsapp", messages: [{ id: "wamid.GOLD" }] }, status: 200, statusText: "OK", headers: {}, config };
};
// isWhatsAppCloudConfigured reads env at call time; flip through the env object.
function setConfigured(on: boolean) {
  configured = on;
  (env as any).WA_ACCESS_TOKEN = on ? "test-token" : "";
}
function isWhatsAppCloudConfigured() {
  return cloud.isWhatsAppCloudConfigured();
}

/* ── the pre-4a senders, verbatim (8c229115) ───────────────────────── */

async function legacySendTextMessage(to: string, body: string): Promise<void> {
  if (!isWhatsAppCloudConfigured()) {
    whatsappLogger.warn("sendTextMessage skipped — Cloud API not configured", { to });
    return;
  }
  try {
    await axios.post(
      `${GRAPH_BASE}/${env.WA_GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body },
      },
      {
        headers: {
          Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      },
    );
  } catch (err) {
    whatsappLogger.error("sendTextMessage failed", {
      to,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function legacySendTextMessageResult(to: string, body: string): Promise<boolean> {
  if (!isWhatsAppCloudConfigured()) return false;
  try {
    await axios.post(
      `${GRAPH_BASE}/${env.WA_GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } },
      { headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" }, timeout: 30_000 },
    );
    return true;
  } catch (err) {
    whatsappLogger.error("sendTextMessageResult failed", { to, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

async function legacySendTemplateMessage(to: string, templateName: string, bodyParams: string[], languageCode = "en"): Promise<boolean> {
  if (!isWhatsAppCloudConfigured()) return false;
  try {
    await axios.post(
      `${GRAPH_BASE}/${env.WA_GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
          components: [
            { type: "body", parameters: (bodyParams || []).map((t) => ({ type: "text", text: String(t) })) },
          ],
        },
      },
      { headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`, "Content-Type": "application/json" }, timeout: 30_000 },
    );
    return true;
  } catch (err) {
    whatsappLogger.error("sendTemplateMessage failed", { to, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

type ReplyButton = { id: string; title: string };
async function legacySendButtonMessage(to: string, body: string, buttons: ReplyButton[]): Promise<void> {
  if (!isWhatsAppCloudConfigured()) {
    whatsappLogger.warn("sendButtonMessage skipped — Cloud API not configured", { to });
    return;
  }
  const replyButtons = (buttons || []).slice(0, 3).map((b) => ({
    type: "reply",
    reply: { id: b.id, title: String(b.title).slice(0, 20) },
  }));
  if (replyButtons.length === 0) {
    await legacySendTextMessage(to, body);
    return;
  }
  try {
    await axios.post(
      `${GRAPH_BASE}/${env.WA_GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: String(body).slice(0, 1024) },
          action: { buttons: replyButtons },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      },
    );
  } catch (err) {
    whatsappLogger.error("sendButtonMessage failed — falling back to text", {
      to,
      error: err instanceof Error ? err.message : String(err),
    });
    // Text fallback keeps the flow working (the typed keywords still apply).
    await legacySendTextMessage(to, body);
  }
}

async function legacySendTemplateWithImageHeader(to: string, templateName: string, langCode: string, headerMediaId: string, bodyParams: string[]) {
  if (!isWhatsAppCloudConfigured()) {
    return { sent: false, error: "WhatsApp Cloud API not configured" };
  }
  if (!templateName) {
    return { sent: false, error: "No template name configured" };
  }
  if (!headerMediaId) {
    return { sent: false, error: "No header media id" };
  }
  try {
    await axios.post(
      `${GRAPH_BASE}/${env.WA_GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: langCode || "en" },
          components: [
            {
              type: "header",
              parameters: [{ type: "image", image: { id: headerMediaId } }],
            },
            {
              type: "body",
              parameters: (bodyParams || []).map((t) => ({
                type: "text",
                text: String(t),
              })),
            },
          ],
        },
      },
      {
        headers: {
          Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      },
    );
    return { sent: true };
  } catch (err) {
    const detail = describeGraphError(err);
    whatsappLogger.error("sendTemplateWithImageHeader failed", {
      to,
      templateName,
      error: detail,
    });
    return { sent: false, error: detail };
  }
}
function describeGraphError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const g = (err.response?.data as any)?.error;
    if (g?.message) {
      return g.code ? `${g.message} (code ${g.code})` : String(g.message);
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/* ── harness ────────────────────────────────────────────────────────── */

type Snapshot = { calls: Call[]; logs: Array<[string, string, unknown]> };
async function run<T>(fn: () => Promise<T>): Promise<{ value: T; snap: Snapshot }> {
  calls.length = 0;
  L.info.mockClear();
  L.warn.mockClear();
  L.error.mockClear();
  const value = await fn();
  const logs: Snapshot["logs"] = [];
  for (const lvl of ["info", "warn", "error"] as const) for (const c of (L as any)[lvl].mock.calls) logs.push([lvl, c[0], c[1]]);
  return { value, snap: { calls: [...calls], logs } };
}

const TO = "919876543210";
const MODES: Array<["ok" | "fail", boolean]> = [
  ["ok", true],
  ["fail", true],
  ["ok", false],
];
const label = (m: "ok" | "fail", c: boolean) => (c ? (m === "ok" ? "success" : "Graph 400") : "not configured");

beforeEach(() => {
  mode = "ok";
  setConfigured(true);
});

describe.each(MODES)("mode %s / configured %s", (m, c) => {
  beforeEach(() => {
    mode = m;
    setConfigured(c);
  });

  it(`sendTextMessage — ${label(m, c)}: same wire, same logs; legacy void → outcome`, async () => {
    const legacy = await run(() => legacySendTextMessage(TO, "hello"));
    const now = await run(() => cloud.sendTextMessage(TO, "hello"));
    expect(now.snap).toEqual(legacy.snap);
    expect(legacy.value).toBeUndefined();
    if (c && m === "ok") expect(now.value).toEqual({ ok: true, wamid: "wamid.GOLD", raw: { messaging_product: "whatsapp", messages: [{ id: "wamid.GOLD" }] } });
    else expect(now.value.ok).toBe(false);
  });

  it(`sendTextMessageResult — ${label(m, c)}: same wire, same logs, same boolean`, async () => {
    const legacy = await run(() => legacySendTextMessageResult(TO, "hello"));
    const now = await run(() => cloud.sendTextMessageResult(TO, "hello"));
    expect(now.snap).toEqual(legacy.snap);
    expect(now.value).toBe(legacy.value);
    const outcome = await run(() => cloud.sendTextMessageResultOutcome(TO, "hello"));
    expect(outcome.snap).toEqual(legacy.snap);
    expect(outcome.value.ok).toBe(legacy.value);
  });

  it(`sendTemplateMessage — ${label(m, c)}: same wire, same logs, same boolean; parameter signature frozen`, async () => {
    const legacy = await run(() => legacySendTemplateMessage(TO, "arrival_greeting", ["Bali", "Grand Hyatt"]));
    const now = await run(() => cloud.sendTemplateMessage(TO, "arrival_greeting", ["Bali", "Grand Hyatt"]));
    expect(now.snap).toEqual(legacy.snap);
    expect(now.value).toBe(legacy.value);
    expect(cloud.sendTemplateMessage.length).toBe(3); // (to, templateName, bodyParams, languageCode = "en")
    const outcome = await run(() => cloud.sendTemplateMessageOutcome(TO, "arrival_greeting", ["Bali", "Grand Hyatt"]));
    expect(outcome.snap).toEqual(legacy.snap);
    expect(outcome.value.ok).toBe(legacy.value);
  });

  it(`sendButtonMessage — ${label(m, c)}: same wire (incl. the text fallback on failure), same logs`, async () => {
    const buttons = [{ id: "confirm", title: "Confirm" }, { id: "fix_amount", title: "Fix amount — a very long title" }, { id: "cancel", title: "Cancel" }, { id: "extra", title: "dropped" }];
    const legacy = await run(() => legacySendButtonMessage(TO, "Receipt read", buttons));
    const now = await run(() => cloud.sendButtonMessage(TO, "Receipt read", buttons));
    expect(now.snap).toEqual(legacy.snap);
    expect(legacy.value).toBeUndefined();
    if (m === "fail" && c) {
      // legacy: interactive fails → text fallback also fails (mode is fail for both) → 2 calls, 2 error logs
      expect(now.snap.calls).toHaveLength(2);
      expect(now.value.ok).toBe(false);
    }
    // no-buttons path → plain text
    const legacyEmpty = await run(() => legacySendButtonMessage(TO, "plain", []));
    const nowEmpty = await run(() => cloud.sendButtonMessage(TO, "plain", []));
    expect(nowEmpty.snap).toEqual(legacyEmpty.snap);
  });

  it(`sendTemplateWithImageHeader — ${label(m, c)}: same wire, same logs, same { sent, error } (+ wamid/raw when sent)`, async () => {
    const legacy = await run(() => legacySendTemplateWithImageHeader(TO, "plumtrips_report_ready", "en", "MEDIA9", ["EOD", "20 Sep"]));
    const now = await run(() => cloud.sendTemplateWithImageHeader(TO, "plumtrips_report_ready", "en", "MEDIA9", ["EOD", "20 Sep"]));
    expect(now.snap).toEqual(legacy.snap);
    const { wamid, raw, ...rest } = now.value as any;
    expect(rest).toEqual(legacy.value);
    if (c && m === "ok") expect(wamid).toBe("wamid.GOLD");
    // guard branches unchanged
    expect(await cloud.sendTemplateWithImageHeader(TO, "", "en", "M", [])).toEqual(await legacySendTemplateWithImageHeader(TO, "", "en", "M", []));
    expect(await cloud.sendTemplateWithImageHeader(TO, "t", "en", "", [])).toEqual(await legacySendTemplateWithImageHeader(TO, "t", "en", "", []));
  });
});

describe("wire details worth pinning", () => {
  it("URL, bearer header, content-type and 30s timeout are unchanged on every message sender", async () => {
    await run(() => cloud.sendTextMessage(TO, "x"));
    await run(() => cloud.sendTextMessageResult(TO, "x"));
    await run(() => cloud.sendTemplateMessage(TO, "t", ["a"]));
    await run(() => cloud.sendButtonMessage(TO, "x", [{ id: "a", title: "A" }]));
    await run(() => cloud.sendTemplateWithImageHeader(TO, "t", "en", "M", ["a"]));
    // `calls` only holds the last run; re-run all five in one go instead
    calls.length = 0;
    await cloud.sendTextMessage(TO, "x");
    await cloud.sendTextMessageResult(TO, "x");
    await cloud.sendTemplateMessage(TO, "t", ["a"]);
    await cloud.sendButtonMessage(TO, "x", [{ id: "a", title: "A" }]);
    await cloud.sendTemplateWithImageHeader(TO, "t", "en", "M", ["a"]);
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.url).toBe("https://graph.facebook.com/v21.0/1265026903369191/messages");
      expect(call.headers).toEqual({ Authorization: "Bearer test-token", "Content-Type": "application/json" });
      expect(call.timeout).toBe(30_000);
      expect(call.body).toMatchObject({ messaging_product: "whatsapp", recipient_type: "individual", to: TO });
    }
  });

  it("the boolean facades are exactly `.ok` of their outcome siblings", async () => {
    for (const m of ["ok", "fail"] as const) {
      mode = m;
      expect(await cloud.sendTextMessageResult(TO, "x")).toBe((await cloud.sendTextMessageResultOutcome(TO, "x")).ok);
      expect(await cloud.sendTemplateMessage(TO, "t", ["a"])).toBe((await cloud.sendTemplateMessageOutcome(TO, "t", ["a"])).ok);
    }
  });
});
