// Step 2 — MISSING-CONFIG SAFETY PROOF. With all Pluto-optional vars (and the
// OpenAI primary key) unset, the Pluto pieces must DEGRADE, not crash: the boot
// check warns, the AI client no longer crashes at import (degrades to Gemini),
// WhatsApp sends fall back, and the worker/stream defaults hold.
//
// PlumConnect Slice 4a: the senders return a SendOutcome and the arrival
// greeting reaches them through outboundFor("arrival"), so the two WhatsApp
// proofs below observe the wire (a recording axios adapter) rather than a
// spy on one exported function — same safety intent, current contract.
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { checkAiProviderKeys, runPlutoBootCheck } from "./plutoBootCheck.js";

const PLUTO_OPTIONAL = [
  "OPENAI_API_KEY", "WA_APP_SECRET", "WA_ACCESS_TOKEN", "WA_PHONE_NUMBER_ID", "WA_VERIFY_TOKEN",
  "WA_DISRUPTION_TEMPLATE", "WA_ARRIVAL_TEMPLATE", "PLUTO_CONVERSATION_TTL_DAYS",
  "WATCH_MAX_CALLS_PER_CYCLE", "CONCIERGE_SSE_HEARTBEAT_MS", "PLUTO_METRICS", "PLUTO_DEBUG",
  "PLUTO_BOOT_PING", "FLIGHTAWARE_API_KEY",
];

beforeEach(() => {
  for (const k of PLUTO_OPTIONAL) delete process.env[k];
});

describe("missing-config safety proof — Pluto degrades, never crashes", () => {
  it("AI boot check WARNS (does not throw) when the primary key is missing", async () => {
    const chk = checkAiProviderKeys({ GEMINI_API_KEY: "g" }); // OpenAI missing, Gemini present
    expect(chk.openaiPresent).toBe(false);
    expect(chk.warnings.join(" ")).toMatch(/OPENAI_API_KEY missing.*Gemini fallback/i);
    const log = { warn: vi.fn(), log: vi.fn() };
    await expect(runPlutoBootCheck({ env: { GEMINI_API_KEY: "g" }, logger: log })).resolves.toBeDefined();
    expect(log.warn).toHaveBeenCalled(); // loud warning, no throw
  });

  it("plutoInvoke imports WITHOUT the key (no boot crash) and rejects only at call time", async () => {
    // The fix: lazy OpenAI client — importing must not construct it.
    const mod = await import("../utils/plutoInvoke.js");
    expect(typeof mod.invokePluto).toBe("function"); // import succeeded with OPENAI_API_KEY unset
    // Calling it degrades with a clear error (the concierge handler's catch → Gemini).
    await expect(mod.invokePluto("hi")).rejects.toThrow(/OPENAI_API_KEY is not configured/);
  });

  it("WhatsApp sends fall back safely when the Cloud API is unconfigured", async () => {
    const wa = await import("./whatsappCloud.service.js");
    expect(wa.isWhatsAppCloudConfigured()).toBe(false);
    const graph = captureGraph();
    try {
      // Boolean senders report false (→ notifier falls back to email). Since
      // PlumConnect Slice 4a the fire-and-forget senders return a SendOutcome
      // instead of undefined — the SAME guard runs first and the "not sent"
      // reason is on the outcome; nothing reaches Graph and nothing throws.
      await expect(wa.sendTemplateMessage("919", "t", [])).resolves.toBe(false);
      await expect(wa.sendTextMessageResult("919", "hi")).resolves.toBe(false);
      await expect(wa.sendTextMessage("919", "hi")).resolves.toEqual({ ok: false, wamid: null, raw: null, error: "not_configured" });
      await expect(wa.sendButtonMessage("919", "hi", [{ id: "x", title: "X" }])).resolves.toEqual({ ok: false, wamid: null, raw: null, error: "not_configured" });
      expect(graph.requests).toHaveLength(0);
    } finally {
      graph.restore();
    }
  });

  it("arrival greeting uses the FREE-FORM path when WA_ARRIVAL_TEMPLATE is unset — and is a safe no-op without Cloud config", async () => {
    // Since Slice 4a the greeting goes through outboundFor("arrival")
    // (services/plumconnect/outbound.ts) into the cloud senders, so the seam
    // to observe is the wire itself: a recording axios adapter.
    delete process.env.PLUMCONNECT_ENABLED; // keeps the 4a wrapper's persistence off (no DB in this test)
    const { sendArrivalGreeting } = await import("./arrivalSession.js");
    const { env } = await import("../config/env.js");
    const wa = await import("./whatsappCloud.service.js");
    const session = { phone: "+919876543210", destinationCity: "Mumbai", hotel: null };
    const graph = captureGraph();
    const saved = { token: env.WA_ACCESS_TOKEN, phoneId: env.WA_PHONE_NUMBER_ID };
    try {
      // (b) Cloud API unconfigured → resolves false, NOTHING sent, no throw.
      expect(wa.isWhatsAppCloudConfigured()).toBe(false);
      await expect(sendArrivalGreeting(session)).resolves.toBe(false);
      expect(graph.requests).toHaveLength(0);

      // (a) Cloud API configured → the free-form text goes out (not a
      // template), followed by the 3-button menu; both land on Graph.
      (env as any).WA_ACCESS_TOKEN = "test-token";
      (env as any).WA_PHONE_NUMBER_ID = "1265026903369191";
      expect(wa.isWhatsAppCloudConfigured()).toBe(true);
      await expect(sendArrivalGreeting(session)).resolves.toBe(true);
      expect(graph.requests.map((r) => r.type)).toEqual(["text", "interactive"]);
      expect(graph.requests[0].text?.body).toMatch(/^Welcome to Mumbai! This is your Plumtrips concierge/);
      expect(graph.requests.some((r) => r.type === "template")).toBe(false);

      // …and the template branch is still keyed on the env: set it, and the
      // first send becomes the template.
      graph.requests.length = 0;
      process.env.WA_ARRIVAL_TEMPLATE = "arrival_welcome";
      await expect(sendArrivalGreeting(session)).resolves.toBe(true);
      expect(graph.requests.map((r) => r.type)).toEqual(["template", "interactive"]);
      expect(graph.requests[0].template?.name).toBe("arrival_welcome");
    } finally {
      (env as any).WA_ACCESS_TOKEN = saved.token;
      (env as any).WA_PHONE_NUMBER_ID = saved.phoneId;
      delete process.env.WA_ARRIVAL_TEMPLATE;
      graph.restore();
    }
  });
});

/** A recording Graph: every axios request body is kept, a wamid is returned. */
function captureGraph() {
  const requests: any[] = [];
  const previous = axios.defaults.adapter;
  let seq = 0;
  axios.defaults.adapter = async (config) => {
    requests.push(JSON.parse(config.data));
    return { data: { messages: [{ id: `wamid.T${++seq}` }] }, status: 200, statusText: "OK", headers: {}, config };
  };
  return { requests, restore: () => { axios.defaults.adapter = previous; } };
}
