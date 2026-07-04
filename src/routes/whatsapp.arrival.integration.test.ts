// Phase 4 (Arrive) — SMOKE / END-TO-END integration test.
//
// Drives the REAL POST /api/whatsapp/webhook route (real express.raw + real
// HMAC signature verify) and the REAL tripWatchWorker cycle through the REAL
// arrival services. Only the true external edges are mocked: Meta Graph sends,
// FlightAware, the mailer, and the metrics sink. Persistence is a faithful
// in-memory Mongoose stand-in (enforces the unique tripWatchId index and the
// $ne/$push/$in/$lt operators the real code uses), so the continuous scenario
// exercises genuine cross-step state + idempotency.
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

const H = vi.hoisted(() => {
  // ── tiny in-memory Mongoose stand-in ─────────────────────────────────────
  const toC = (v: any) => (v instanceof Date ? v.getTime() : v);
  function opMatch(docVal: any, cond: any): boolean {
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, v]: any) => {
        switch (op) {
          case "$ne":
            return Array.isArray(docVal) ? !docVal.map(String).includes(String(v)) : String(docVal) !== String(v);
          case "$in":
            return (v || []).map(String).includes(String(docVal));
          case "$nin":
            return !(v || []).map(String).includes(String(docVal));
          case "$lt": return docVal != null && toC(docVal) < toC(v);
          case "$lte": return docVal != null && toC(docVal) <= toC(v);
          case "$gt": return docVal != null && toC(docVal) > toC(v);
          case "$gte": return docVal != null && toC(docVal) >= toC(v);
          default: return false;
        }
      });
    }
    if (cond === null) return docVal == null;
    if (cond instanceof Date) return docVal instanceof Date && docVal.getTime() === cond.getTime();
    if (typeof cond === "object") return false;
    return docVal === cond || String(docVal) === String(cond);
  }
  function matchQuery(doc: any, query: any): boolean {
    return Object.entries(query || {}).every(([k, cond]: any) => {
      if (k === "$and") return (cond as any[]).every((s) => matchQuery(doc, s));
      if (k === "$or") return (cond as any[]).some((s) => matchQuery(doc, s));
      return opMatch(doc[k], cond);
    });
  }
  function applyUpdate(doc: any, update: any) {
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$push) for (const [k, v] of Object.entries(update.$push)) { if (!Array.isArray(doc[k])) doc[k] = []; doc[k].push(v); }
    if (update.$inc) for (const [k, v] of Object.entries<any>(update.$inc)) doc[k] = (doc[k] || 0) + v;
  }
  let seq = 0;
  function sortRows(rows: any[], sort: any) {
    if (!sort) return rows;
    const [k, dir] = Object.entries<any>(sort)[0];
    return [...rows].sort((a, b) => {
      const av = toC(a[k]), bv = toC(b[k]);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av > bv ? 1 : av < bv ? -1 : 0) * (dir < 0 ? -1 : 1);
    });
  }
  function makeQuery(resolver: (q: any) => any) {
    const q: any = {
      __sort: null, __limit: null,
      select() { return q; }, lean() { return q; },
      sort(s: any) { q.__sort = s; return q; }, limit(n: number) { q.__limit = n; return q; },
      then(res: any, rej: any) { return Promise.resolve().then(() => resolver(q)).then(res, rej); },
      catch(f: any) { return Promise.resolve().then(() => resolver(q)).catch(f); },
    };
    return q;
  }
  function fakeModel(unique: string[] = []) {
    const rows: any[] = [];
    const model: any = {
      __rows: rows,
      async create(data: any) {
        for (const k of unique) {
          if (data[k] != null && rows.some((r) => String(r[k]) === String(data[k]))) {
            const e: any = new Error("E11000 duplicate key"); e.code = 11000; throw e;
          }
        }
        const doc: any = { _id: data._id ?? `oid${++seq}`, ...data, save: async function () { return this; } };
        rows.push(doc);
        return doc;
      },
      findOne(query: any) { return makeQuery((q) => sortRows(rows.filter((r) => matchQuery(r, query)), q.__sort)[0] ?? null); },
      find(query: any) {
        return makeQuery((q) => {
          let c = sortRows(rows.filter((r) => matchQuery(r, query)), q.__sort);
          if (q.__limit != null) c = c.slice(0, q.__limit);
          return c;
        });
      },
      findById(id: any) { return model.findOne({ _id: id }); },
      async findOneAndUpdate(query: any, update: any, options: any = {}) {
        const doc = sortRows(rows.filter((r) => matchQuery(r, query)), options.sort)[0];
        if (!doc) return null;
        applyUpdate(doc, update);
        return doc;
      },
      async updateOne(query: any, update: any, options: any = {}) {
        const doc = rows.find((r) => matchQuery(r, query));
        if (doc) { applyUpdate(doc, update); return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }; }
        if (options.upsert) {
          const seed = { ...(update.$setOnInsert || {}), ...(update.$set || {}) };
          rows.push({ _id: seed._id ?? `oid${++seq}`, ...seed, save: async function () { return this; } });
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      },
      async updateMany(query: any, update: any) {
        let n = 0; for (const r of rows) if (matchQuery(r, query)) { applyUpdate(r, update); n++; }
        return { modifiedCount: n };
      },
    };
    return model;
  }

  const models: Record<string, any> = {
    ArrivalSession: fakeModel(["tripWatchId"]),
    TripWatch: fakeModel(),
    TripAlert: fakeModel(),
    SBTBooking: fakeModel(),
    SBTRequest: fakeModel(),
    SBTHotelBooking: fakeModel(),
    User: fakeModel(),
    ExpenseReply: fakeModel(),
    ExpenseCapture: fakeModel(),
  };
  const spies = {
    sendTemplate: vi.fn(), sendText: vi.fn(), sendButtons: vi.fn(),
    sendMail: vi.fn(), emitMetric: vi.fn(), flightStatus: vi.fn(), getWeather: vi.fn(),
  };
  return { models, spies, resetAll: () => Object.values(models).forEach((m) => { m.__rows.length = 0; }) };
});

// ── Model mocks (shared in-memory stores) ──
vi.mock("../models/ArrivalSession.js", () => ({ default: H.models.ArrivalSession }));
vi.mock("../models/TripWatch.js", () => ({ default: H.models.TripWatch }));
vi.mock("../models/TripAlert.js", () => ({ default: H.models.TripAlert }));
vi.mock("../models/SBTBooking.js", () => ({ default: H.models.SBTBooking }));
vi.mock("../models/SBTRequest.js", () => ({ default: H.models.SBTRequest }));
vi.mock("../models/SBTHotelBooking.js", () => ({ default: H.models.SBTHotelBooking }));
vi.mock("../models/User.js", () => ({ default: H.models.User }));
vi.mock("../models/ExpenseReply.js", () => ({ default: H.models.ExpenseReply }));
vi.mock("../models/ExpenseCapture.js", () => ({ default: H.models.ExpenseCapture }));

// ── External edges mocked; verifyMetaSignature kept REAL via importActual ──
vi.mock("../services/whatsappCloud.service.js", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    sendTemplateMessage: H.spies.sendTemplate,
    sendTextMessageResult: H.spies.sendText,
    sendButtonMessage: H.spies.sendButtons,
    isWhatsAppCloudConfigured: () => true,
  };
});
vi.mock("../services/flightService.js", () => ({ getDelightfulFlightStatus: H.spies.flightStatus }));
vi.mock("../utils/mailer.js", () => ({ sendMail: H.spies.sendMail }));
vi.mock("../services/weatherService.js", () => ({ getDestinationWeather: H.spies.getWeather }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: H.spies.emitMetric }));
vi.mock("../config/env.js", () => ({
  env: { WA_APP_SECRET: "test-secret", NODE_ENV: "test", WA_VERIFY_TOKEN: "vt", WA_GRAPH_VERSION: "v20.0", WA_ACCESS_TOKEN: "tok", WA_PHONE_NUMBER_ID: "PNID" },
}));

import express from "express";
import request from "supertest";
import webhookRouter from "./whatsapp.webhook.js";
import { runRealCycle } from "../workers/tripWatchWorker.js";

const app = express();
app.use("/", express.raw({ type: "application/json" }), webhookRouter);

const PHONE = "+919876543210";
const WA = "919876543210";
const T0 = new Date("2026-07-04T09:00:00Z");

const landedInfo = {
  flight_status: "Landed",
  departure: { scheduled: "2026-07-04T06:30:00Z", actual: "2026-07-04T06:45:00Z", gate: "A1", terminal: "2" },
  arrival: { iata: "BOM", city: "Mumbai", scheduled: "2026-07-04T08:45:00Z", estimated: "2026-07-04T08:50:00Z" },
  progress_percent: 100,
};

// ── realistic Meta webhook payload shapes ──
function metaPayload(message: any) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "15551230000", phone_number_id: "PNID" },
          contacts: [{ profile: { name: "Traveler" }, wa_id: message.from }],
          messages: [message],
        },
      }],
    }],
  };
}
const buttonMsg = (id: string, btnId: string, title: string, from = WA) => ({
  from, id, timestamp: "1720083600", type: "interactive",
  interactive: { type: "button_reply", button_reply: { id: btnId, title } },
});
const textMsg = (id: string, body: string, from = WA) => ({ from, id, timestamp: "1720083600", type: "text", text: { body } });
const imageMsg = (id: string, from = WA) => ({ from, id, timestamp: "1720083600", type: "image", image: { id: `media_${id}`, mime_type: "image/jpeg", sha256: "abc" } });

const sign = (raw: string) => "sha256=" + crypto.createHmac("sha256", "test-secret").update(Buffer.from(raw)).digest("hex");
function postSigned(message: any, opts: { badSig?: boolean } = {}) {
  const raw = JSON.stringify(metaPayload(message));
  return request(app)
    .post("/webhook")
    .set("Content-Type", "application/json")
    .set("x-hub-signature-256", opts.badSig ? "sha256=deadbeef" : sign(raw))
    .send(raw);
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 5)); };
const metricTypes = () => H.spies.emitMetric.mock.calls.map((c: any) => c[0]?.type);
const resetSends = () => { H.spies.sendText.mockClear(); H.spies.sendTemplate.mockClear(); H.spies.sendButtons.mockClear(); H.spies.sendMail.mockClear(); };
const sessionRow = () => H.models.ArrivalSession.__rows[0];

async function seedActiveWatch() {
  await H.models.User.create({ _id: "book1", name: "Asha Rao", email: "asha@plumtrips.com", phone: "+919812345678" });
  await H.models.SBTRequest.create({
    _id: "req1", workspaceId: "wsp1", assignedBookerId: "book1", requesterId: "trav1", type: "flight", status: "PENDING",
    searchParams: {}, selectedOption: {},
    tripBundle: { hotel: { name: "The Taj Mahal Palace", address: "Apollo Bunder, Colaba, Mumbai 400001", phone: "+912266653366", checkInDate: "2026-07-05" } },
  });
  await H.models.TripWatch.create({
    _id: "w1", workspaceId: "wsp1", sbtRequestId: "req1", bookingId: "bk1", travelerUserId: "trav1",
    flightNo: "AI-101", carrier: "AI", origin: "DEL", destination: "BOM",
    departDate: new Date(T0.getTime() - 2 * 3600_000), notifyChannel: "WHATSAPP", notifyTarget: PHONE, fallbackEmail: "trav@x.com",
    status: "ACTIVE", lastKnownState: null, lastCheckedAt: null, claimedAt: null,
  });
}

// Seed an already-ACTIVE session directly (for edge tests that don't need landing).
async function seedActiveSession(over: any = {}) {
  return H.models.ArrivalSession.create({
    workspaceId: "wsp1", tripWatchId: over.tripWatchId ?? `tw_${Math.random()}`,
    phone: over.phone ?? PHONE, status: "ACTIVE", openedAt: T0, expiresAt: new Date(T0.getTime() + 24 * 3600_000),
    destinationIata: "BOM", destinationCity: "Mumbai",
    hotel: { name: "The Taj Mahal Palace", address: "Apollo Bunder, Colaba, Mumbai 400001", phone: "+912266653366", checkInDate: "2026-07-05" },
    bookerUserId: "book1", bookerName: "Asha Rao", bookerEmail: "asha@plumtrips.com", bookerPhone: "+919812345678",
    greetingAttempts: 0, messageCount: 0, rateWindowCount: 0, menuCount: 0, processedMessageIds: [],
    ...over,
  });
}

beforeEach(() => {
  H.resetAll();
  Object.values(H.spies).forEach((s: any) => s.mockReset());
  H.spies.sendTemplate.mockResolvedValue(true);
  H.spies.sendText.mockResolvedValue(true);
  H.spies.sendButtons.mockResolvedValue(undefined);
  H.spies.sendMail.mockResolvedValue(undefined);
  H.spies.getWeather.mockResolvedValue(null);
  process.env.WA_ARRIVAL_TEMPLATE = "arrival_welcome";
  delete process.env.WA_DISRUPTION_TEMPLATE;
});

describe("Phase 4 smoke — full arrival lifecycle (one continuous scenario)", () => {
  it("land → greet → hotel → help → stop, end to end", async () => {
    await seedActiveWatch();
    H.spies.flightStatus.mockResolvedValue(landedInfo);

    // (a) cycle 1 → session opens + greeting template + 3-button menu
    await runRealCycle(T0);
    const s = sessionRow();
    expect(s.status).toBe("ACTIVE");
    expect(s.openedAt).toBeTruthy();
    expect(H.spies.sendTemplate).toHaveBeenCalledWith("919876543210", "arrival_welcome", ["Mumbai", "The Taj Mahal Palace"]);
    const buttons = H.spies.sendButtons.mock.calls[0][2];
    expect(buttons.map((b: any) => b.id)).toEqual(["arr_hotel", "arr_booker", "arr_help"]);
    buttons.forEach((b: any) => expect(b.title.length).toBeLessThanOrEqual(20));
    expect(metricTypes()).toContain("pluto.arrive.session_opened");

    // second cycle, still "Landed" → unique-index idempotency: no 2nd session/greeting
    resetSends();
    await runRealCycle(new Date(T0.getTime() + 16 * 60 * 1000));
    expect(H.models.ArrivalSession.__rows.length).toBe(1);
    expect(H.spies.sendTemplate).not.toHaveBeenCalled();
    expect(H.spies.sendButtons).not.toHaveBeenCalled();

    // (b) inbound arr_hotel → hotel reply with maps link (address URL-encoded)
    resetSends();
    await postSigned(buttonMsg("wamid.hotel1", "arr_hotel", "Hotel info"));
    await flush();
    const hotelText = H.spies.sendText.mock.calls.map((c: any) => c[1]).join("\n");
    expect(hotelText).toContain("The Taj Mahal Palace");
    expect(hotelText).toContain("Apollo Bunder, Colaba, Mumbai 400001");
    expect(hotelText).toContain("+912266653366");
    expect(hotelText).toContain("2026-07-05");
    expect(hotelText).toContain(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("Apollo Bunder, Colaba, Mumbai 400001")}`);

    // (c) inbound "help" → CONCIERGE_ARRIVAL SBTRequest (P0/15m) + booker email
    resetSends();
    await postSigned(textMsg("wamid.help1", "help"));
    await flush();
    const arrivalReqs = () => H.models.SBTRequest.__rows.filter((r: any) => r.source === "CONCIERGE_ARRIVAL");
    expect(arrivalReqs().length).toBe(1);
    expect(arrivalReqs()[0]).toMatchObject({ status: "PENDING", assignedBookerId: "book1", conversationId: String(s._id) });
    expect(arrivalReqs()[0].tripBundle.lockedDecisions.slaPriority).toBe("P0");
    expect(H.spies.sendMail).toHaveBeenCalledTimes(1);
    expect(H.spies.sendMail.mock.calls[0][0].subject).toContain("ARRIVAL HELP");
    expect(H.spies.sendMail.mock.calls[0][0].subject).toContain("15 minutes");
    expect(H.spies.sendText.mock.calls.map((c: any) => c[1]).join()).toContain("Asha Rao");

    // second "help" → already alerted, still exactly ONE request
    resetSends();
    await postSigned(textMsg("wamid.help2", "help"));
    await flush();
    expect(arrivalReqs().length).toBe(1);
    expect(H.spies.sendText.mock.calls.map((c: any) => c[1]).join().toLowerCase()).toContain("already been alerted");

    // (d) "stop" → OPTED_OUT + one confirmation; then total silence
    resetSends();
    await postSigned(textMsg("wamid.stop1", "stop"));
    await flush();
    expect(sessionRow().status).toBe("OPTED_OUT");
    expect(H.spies.sendText.mock.calls.map((c: any) => c[1]).join().toLowerCase()).toContain("unsubscribed");

    resetSends();
    await postSigned(textMsg("wamid.after_stop", "are you there?"));
    await flush();
    expect(H.spies.sendText).not.toHaveBeenCalled();
    expect(H.spies.sendTemplate).not.toHaveBeenCalled();
    expect(H.spies.sendButtons).not.toHaveBeenCalled();
  });
});

describe("Phase 4 smoke — security edges (real route)", () => {
  it("arr_ button from an UNKNOWN number → 200, zero sends, unknown_sender metric", async () => {
    const res = await postSigned(buttonMsg("wamid.unk1", "arr_help", "Help", "917777777777"));
    await flush();
    expect(res.status).toBe(200);
    expect(H.spies.sendText).not.toHaveBeenCalled();
    expect(H.spies.sendButtons).not.toHaveBeenCalled();
    expect(metricTypes()).toContain("pluto.arrive.unknown_sender");
  });

  it("WRONG signature → 401, nothing processed, session state untouched", async () => {
    const s = await seedActiveSession({ tripWatchId: "tw_sig", messageCount: 0, processedMessageIds: [] });
    const res = await postSigned(buttonMsg("wamid.badsig", "arr_hotel", "Hotel info"), { badSig: true });
    await flush();
    expect(res.status).toBe(401);
    expect(H.spies.sendText).not.toHaveBeenCalled();
    expect(s.messageCount).toBe(0);
    expect(s.processedMessageIds.length).toBe(0);
  });

  it("21st message in the hour → 'agent will follow up', 22nd → silence", async () => {
    // Anchor the window to the REAL clock — dispatch uses new Date() for the
    // rolling 1h window, so a fresh window keeps the 20 count in-window.
    await seedActiveSession({ tripWatchId: "tw_rl", rateWindowStart: new Date(), rateWindowCount: 20, rateLimitNotifiedAt: null });
    resetSends();
    await postSigned(textMsg("wamid.msg21", "hotel"));
    await flush();
    expect(H.spies.sendText).toHaveBeenCalledTimes(1);
    expect(H.spies.sendText.mock.calls[0][1]).toContain("agent will follow up");
    expect(metricTypes()).toContain("pluto.arrive.rate_limited");

    resetSends();
    await postSigned(textMsg("wamid.msg22", "hotel"));
    await flush();
    expect(H.spies.sendText).not.toHaveBeenCalled();
  });
});

describe("Phase 4 smoke — expense coexistence", () => {
  it("text from a number with NO session → ExpenseReply, field-level, as on main", async () => {
    await postSigned(textMsg("wamid.exp1", "submit", "918888888888"));
    await flush();
    const row = H.models.ExpenseReply.__rows.find((r: any) => r.messageId === "wamid.exp1");
    expect(row).toMatchObject({ messageId: "wamid.exp1", waId: "918888888888", phoneNumberId: "PNID", text: "submit", status: "queued" });
    expect(H.spies.sendText).not.toHaveBeenCalled();
  });

  it("media from a phone WITH an active session → ExpenseCapture (media skips arrival)", async () => {
    const s = await seedActiveSession({ tripWatchId: "tw_media", phone: "+919999999999" });
    await postSigned(imageMsg("wamid.img1", "919999999999"));
    await flush();
    const cap = H.models.ExpenseCapture.__rows.find((r: any) => r.messageId === "wamid.img1");
    expect(cap).toMatchObject({ messageId: "wamid.img1", mediaType: "image", waId: "919999999999" });
    expect(H.spies.sendText).not.toHaveBeenCalled();
    expect(H.spies.sendButtons).not.toHaveBeenCalled();
    expect(s.processedMessageIds.length).toBe(0); // arrival never touched
  });

  it("duplicate messageId (Meta retry) → no double-processing", async () => {
    // arrival path
    await seedActiveSession({ tripWatchId: "tw_dup" });
    await postSigned(buttonMsg("wamid.dup", "arr_hotel", "Hotel info"));
    await flush();
    await postSigned(buttonMsg("wamid.dup", "arr_hotel", "Hotel info"));
    await flush();
    expect(H.spies.sendText).toHaveBeenCalledTimes(1); // second is a no-op

    // expense path
    await postSigned(textMsg("wamid.dupexp", "submit", "918888888888"));
    await flush();
    await postSigned(textMsg("wamid.dupexp", "submit", "918888888888"));
    await flush();
    expect(H.models.ExpenseReply.__rows.filter((r: any) => r.messageId === "wamid.dupexp").length).toBe(1);
  });
});

describe("Phase 4 smoke — lifecycle sweep (real worker cycle)", () => {
  it("expired-with-inbound → EXPIRED + goodbye; expired-silent → EXPIRED, no send", async () => {
    const engaged = await seedActiveSession({ tripWatchId: "tw_e", phone: "+919111111111", expiresAt: new Date(T0.getTime() - 3600_000), lastInboundAt: T0 });
    const silent = await seedActiveSession({ tripWatchId: "tw_s", phone: "+919222222222", expiresAt: new Date(T0.getTime() - 3600_000), lastInboundAt: null });

    await runRealCycle(T0); // no watches; exercises expireArrivalSessions inside the real cycle

    expect(engaged.status).toBe("EXPIRED");
    expect(silent.status).toBe("EXPIRED");
    expect(H.spies.sendText).toHaveBeenCalledTimes(1);
    expect(H.spies.sendText.mock.calls[0][0]).toBe("919111111111");
    expect(H.spies.sendText.mock.calls[0][1]).toContain("closing");
    expect(metricTypes().filter((t: string) => t === "pluto.arrive.expired").length).toBe(2);
  });
});
