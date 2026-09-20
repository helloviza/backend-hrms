// PlumConnect Slice 2 — E2E-B: a bound employee's receipt, flag ON, all the
// way THROUGH the untouched expense worker chain.
//
//   webhook (HMAC) → dispatcher → enqueueExpenseCapture → ExpenseCapture{queued}
//     → worker tick 1: User.waId gate (:87) → S3 → captured, workspaceId (:113)
//     → worker tick 2: Gemini → ReceiptExtraction row (:280-289) → awaiting_confirmation
//     → "confirm" reply via the webhook → ExpenseReply{queued}
//     → worker tick 3: confirmCapture → Expense under the employee's workspace
//
// The worker is not imported through any test double — it is the real
// module, started with its own setInterval (only setInterval is faked so
// the Mongo driver's timers stay real). Meta media, S3 and Gemini are
// mocked at their module seams because they are network calls; every DB
// write in the chain is real.
//
// EXPENSE_SEAM_RECHECK.md seam 4: exactly ONE ReceiptExtraction row under
// the employee's workspaceId is part of the baseline — asserted, not
// "expect empty".
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import request from "supertest";
import crypto from "node:crypto";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-e2eb-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.NODE_ENV = "test";
process.env.WA_APP_SECRET = "test-app-secret";
process.env.PLUMCONNECT_ENABLED = "true";

const H = vi.hoisted(() => ({
  sendTextMessage: vi.fn(async () => {}),
  sendButtonMessage: vi.fn(async () => {}),
  getMediaUrl: vi.fn(async () => ({ url: "https://lookaside.fbsbx.com/x", mime: "image/jpeg" })),
  downloadMedia: vi.fn(async () => Buffer.from("fake-jpeg-bytes")),
  upload: vi.fn(async (o: any) => ({ bucket: "test-bucket", key: `expenses/${o.workspaceId}/${o.employeeId}/${o.messageId}.jpg` })),
  extract: vi.fn(async () => ({
    fields: { merchant: "Cafe Coffee Day", date: "2026-09-19", amount: 450, currency: "INR", taxAmount: 21.43, gstin: null, suggestedCategory: "Meals", perFieldConfidence: { amount: 0.98 } },
    raw: { raw_candidate: {}, raw_text: "{}", model: "gemini-test" },
  })),
}));

vi.mock("../whatsappCloud.service.js", async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real, // keep verifyMetaSignature real — the webhook's HMAC is exercised
    isWhatsAppCloudConfigured: () => true,
    sendTextMessage: H.sendTextMessage,
    sendTextMessageResult: vi.fn(async () => true),
    sendButtonMessage: H.sendButtonMessage,
    getMediaUrl: H.getMediaUrl,
    downloadMedia: H.downloadMedia,
  };
});
// Slice 4a: the worker takes sendTextMessage/sendButtonMessage from the outbound wrapper.
vi.mock("./outbound.js", () => ({ outboundFor: () => ({ sendTextMessage: H.sendTextMessage, sendButtonMessage: H.sendButtonMessage }) }));
vi.mock("../../utils/s3Upload.js", () => ({ uploadExpenseReceiptToS3: H.upload }));
vi.mock("../receiptExtractorGemini.js", () => ({ extractReceipt: H.extract }));

const { default: router } = await import("../../routes/whatsapp.webhook.js");
const { startExpenseCaptureWorker } = await import("../../workers/expenseCaptureWorker.js");
const { default: User } = await import("../../models/User.js");
const { default: ExpenseCapture } = await import("../../models/ExpenseCapture.js");
const { default: ExpenseReply } = await import("../../models/ExpenseReply.js");
const { default: ExpenseWaSession } = await import("../../models/ExpenseWaSession.js");
const { default: Expense } = await import("../../models/Expense.js");
const { default: ReceiptExtraction } = await import("../../models/ReceiptExtraction.js");
const { default: Conversation } = await import("../../models/plumconnect/Conversation.js");
const { default: Message } = await import("../../models/plumconnect/Message.js");

const app = express();
app.use("/api/whatsapp", express.raw({ type: "application/json" }), router);

let mongod: MongoMemoryServer;
const PN = "1265026903369191";
const EMPLOYEE = "919876543210";
const WS = new mongoose.Types.ObjectId();
let employeeId: mongoose.Types.ObjectId;

function sign(body: string) {
  return "sha256=" + crypto.createHmac("sha256", "test-app-secret").update(body).digest("hex");
}
function post(message: any) {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PN }, contacts: [{ wa_id: EMPLOYEE, profile: { name: "Bound" } }], messages: [message] } }] }] });
  return request(app).post("/api/whatsapp/webhook").set("Content-Type", "application/json").set("x-hub-signature-256", sign(body)).send(body);
}

/** Fire one worker tick and wait (real time) until `until()` holds. */
async function tick(until: () => Promise<boolean>, label: string) {
  await vi.advanceTimersByTimeAsync(10_000);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await until()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`worker tick did not reach: ${label}`);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const u = await User.create({ email: "emp@x.test", passwordHash: "x", workspaceId: WS, name: "Bound Employee", status: "ACTIVE", waId: EMPLOYEE });
  employeeId = u._id as mongoose.Types.ObjectId;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  startExpenseCaptureWorker();
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  await mongoose.disconnect();
  await mongod.stop();
});

describe("E2E-B — bound employee receipt through the untouched chain", { timeout: 30_000 }, () => {
  const receipt = { id: "wamid.E2EB.receipt", from: EMPLOYEE, timestamp: "1758369600", type: "image", image: { id: "MEDIA-E2EB", mime_type: "image/jpeg", caption: "client lunch" } };
  const confirm = { id: "wamid.E2EB.confirm", from: EMPLOYEE, timestamp: "1758369700", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "confirm", title: "Confirm" } } };

  it("webhook → dispatcher → ExpenseCapture{queued}, tenant-less, plus an expense conversation", async () => {
    expect((await post(receipt)).status).toBe(200);
    const row: any = await ExpenseCapture.collection.findOne({ messageId: receipt.id });
    expect(row).toMatchObject({ waId: EMPLOYEE, mediaId: "MEDIA-E2EB", status: "queued", sourceChannel: "whatsapp" });
    expect(row).not.toHaveProperty("workspaceId");
    expect((await Conversation.findOne({}).lean())!.kind).toBe("expense");
    expect(await Message.countDocuments({ externalId: receipt.id })).toBe(1);
  });

  // One worker tick drains capture THEN extraction (:775-777), so a receipt
  // goes queued → captured → awaiting_confirmation inside a single tick; the
  // stage-1 facts are asserted on whichever of the two the poll observes.
  it("tick 1: the chain resolves identity by User.waId itself and assigns workspaceId (:87 → :113)", async () => {
    await tick(async () => ["captured", "awaiting_confirmation"].includes((await ExpenseCapture.findOne({ messageId: receipt.id }).lean())?.status as string), "captured");
    const row: any = await ExpenseCapture.findOne({ messageId: receipt.id }).lean();
    expect(String(row.workspaceId)).toBe(String(WS));
    expect(String(row.employeeId)).toBe(String(employeeId));
    expect(row.imageKey).toBe(`expenses/${WS}/${employeeId}/${receipt.id}.jpg`);
    expect(H.getMediaUrl).toHaveBeenCalledWith("MEDIA-E2EB");
    expect(H.upload).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: String(WS), employeeId: String(employeeId) }));
  });

  it("tick 2: extraction → awaiting_confirmation, confirm buttons sent by the CHAIN, and exactly ONE ReceiptExtraction under the workspace", async () => {
    // (may already hold from tick 1 — see above; an extra tick is a no-op on an empty queue)
    await tick(async () => (await ExpenseCapture.findOne({ messageId: receipt.id }).lean())?.status === "awaiting_confirmation", "awaiting_confirmation");
    const row: any = await ExpenseCapture.findOne({ messageId: receipt.id }).lean();
    expect(row.extraction).toMatchObject({ merchant: "Cafe Coffee Day", amount: 450, currency: "INR" });

    // seam 4 baseline: the chain's new tenant-scoped side effect
    const extractions = await ReceiptExtraction.find({ workspaceId: WS }).lean();
    expect(extractions).toHaveLength(1);
    expect(String(extractions[0].employeeId)).toBe(String(employeeId));
    expect(extractions[0].imageKey).toBe(row.imageKey);
    expect(await ReceiptExtraction.countDocuments({})).toBe(1); // and none anywhere else

    // the chain's own voice, untouched: [Confirm][Fix amount][Cancel]
    expect(H.sendButtonMessage).toHaveBeenCalledWith(EMPLOYEE, expect.stringContaining("Receipt read"), expect.arrayContaining([expect.objectContaining({ id: "confirm" })]));
  });

  it("the sender is now IN-FLOW for the router: the confirm tap is routed expense_inflow → ExpenseReply{queued}", async () => {
    expect((await post(confirm)).status).toBe(200);
    const reply: any = await ExpenseReply.collection.findOne({ messageId: confirm.id });
    expect(reply).toMatchObject({ waId: EMPLOYEE, phoneNumberId: PN, text: "confirm", status: "queued" });
    expect(await Message.countDocuments({ externalId: confirm.id })).toBe(1);
  });

  it("tick 3: confirmCapture → Expense under the employee's workspace, capture confirmed, post-confirm session opened by the chain", async () => {
    // Wait for the reply's terminal state — the worker marks it done only
    // AFTER confirmCapture has created the Expense, opened the session and
    // sent the post-confirm buttons, so this is the last write of the tick.
    await tick(async () => (await ExpenseReply.findOne({ messageId: confirm.id }).lean())?.status === "done", "reply done");
    expect(await Expense.countDocuments({ workspaceId: WS })).toBe(1);
    const expense: any = await Expense.findOne({ workspaceId: WS }).lean();
    expect(String(expense.employeeId)).toBe(String(employeeId));
    expect(expense).toMatchObject({ sourceChannel: "whatsapp", merchant: "Cafe Coffee Day", amount: 450, currency: "INR" });

    const capture: any = await ExpenseCapture.findOne({ messageId: receipt.id }).lean();
    expect(capture.status).toBe("confirmed");
    expect(String(capture.expenseId)).toBe(String(expense._id));

    const session: any = await ExpenseWaSession.findOne({ waId: EMPLOYEE }).lean();
    expect(session).toMatchObject({ state: "post_confirm" });
    expect(String(session.workspaceId)).toBe(String(WS));

    expect((await ExpenseReply.findOne({ messageId: confirm.id }).lean())!.status).toBe("done");
  });

  it("nothing in the run wrote a tenant row for anyone but the bound employee", async () => {
    expect(await Expense.countDocuments({ workspaceId: { $ne: WS } })).toBe(0);
    expect(await ReceiptExtraction.countDocuments({ workspaceId: { $ne: WS } })).toBe(0);
    expect(await ExpenseCapture.countDocuments({ workspaceId: { $exists: true, $ne: WS } })).toBe(0);
  });
});
