// Phase 4 Step 2 — webhook routing precedence + expense regression.
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  dispatch: vi.fn(),
  hasSession: vi.fn(),
  replyUpdateOne: vi.fn(),
  captureUpdateOne: vi.fn(),
  verifySig: vi.fn(),
}));

vi.mock("../services/arrivalInbound.js", () => ({
  dispatchArrivalInbound: H.dispatch,
  hasActiveArrivalSession: H.hasSession,
}));
vi.mock("../models/ExpenseReply.js", () => ({ default: { updateOne: H.replyUpdateOne } }));
vi.mock("../models/ExpenseCapture.js", () => ({ default: { updateOne: H.captureUpdateOne } }));
vi.mock("../services/whatsappCloud.service.js", () => ({ verifyMetaSignature: H.verifySig }));
vi.mock("../config/env.js", () => ({
  env: { WA_APP_SECRET: "secret", NODE_ENV: "test", WA_VERIFY_TOKEN: "vt" },
}));
vi.mock("../utils/logger.js", () => ({
  whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import express from "express";
import request from "supertest";
import router from "./whatsapp.webhook.js";

const app = express();
app.use("/", express.raw({ type: "application/json" }), router);

function post(message: any) {
  const body = JSON.stringify({
    entry: [{ changes: [{ value: { metadata: { phone_number_id: "PNID" }, messages: [message] } }] }],
  });
  return request(app)
    .post("/webhook")
    .set("Content-Type", "application/json")
    .set("x-hub-signature-256", "sha256=deadbeef")
    .send(body);
}

beforeEach(() => {
  Object.values(H).forEach((m: any) => m.mockReset());
  H.verifySig.mockReturnValue(true);
  H.hasSession.mockResolvedValue(false);
  H.replyUpdateOne.mockResolvedValue({ upsertedCount: 1 });
  H.captureUpdateOne.mockResolvedValue({ upsertedCount: 1 });
});

describe("webhook arrival routing", () => {
  it("arr_ button → arrival dispatch, NOT expense", async () => {
    const res = await post({ type: "interactive", id: "m1", from: "919876543210", interactive: { button_reply: { id: "arr_hotel", title: "Hotel info" } } });
    expect(res.status).toBe(200);
    expect(H.dispatch).toHaveBeenCalledTimes(1);
    expect(H.dispatch.mock.calls[0][0]).toMatchObject({ waId: "919876543210", messageId: "m1", buttonId: "arr_hotel" });
    expect(H.replyUpdateOne).not.toHaveBeenCalled();
  });

  it("text from a number WITH an active session → arrival dispatch, NOT expense", async () => {
    H.hasSession.mockResolvedValue(true);
    const res = await post({ type: "text", id: "m2", from: "919999999999", text: { body: "hotel" } });
    expect(res.status).toBe(200);
    expect(H.dispatch).toHaveBeenCalledTimes(1);
    expect(H.replyUpdateOne).not.toHaveBeenCalled();
  });

  it("REGRESSION: text from an unknown number → ExpenseReply exactly as before", async () => {
    H.hasSession.mockResolvedValue(false);
    const res = await post({ type: "text", id: "m3", from: "918888888888", text: { body: "submit" } });
    expect(res.status).toBe(200);
    expect(H.dispatch).not.toHaveBeenCalled();
    expect(H.replyUpdateOne).toHaveBeenCalledTimes(1);
  });

  it("media receipt → ExpenseCapture, arrival never consulted", async () => {
    const res = await post({ type: "image", id: "m4", from: "917777777777", image: { id: "med1", mime_type: "image/jpeg" } });
    expect(res.status).toBe(200);
    expect(H.captureUpdateOne).toHaveBeenCalledTimes(1);
    expect(H.dispatch).not.toHaveBeenCalled();
    expect(H.hasSession).not.toHaveBeenCalled(); // media skips arrival routing entirely
  });

  it("invalid signature → 401, nothing processed", async () => {
    H.verifySig.mockReturnValue(false);
    const res = await post({ type: "interactive", id: "m5", from: "919876543210", interactive: { button_reply: { id: "arr_help" } } });
    expect(res.status).toBe(401);
    expect(H.dispatch).not.toHaveBeenCalled();
    expect(H.replyUpdateOne).not.toHaveBeenCalled();
  });
});
