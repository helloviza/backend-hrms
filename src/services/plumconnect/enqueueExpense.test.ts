// PlumConnect Slice 2, Part A — the extracted enqueuers write the SAME rows
// the inline webhook upserts wrote. The "golden" here is not a hand-typed
// object: each legacyInline*() below is the pre-refactor code from
// routes/whatsapp.webhook.ts (:114-126, :155-159, :183-200 on origin/main
// fd2aebdd) copied verbatim, run against the same collection, and the raw
// on-disk documents are compared field for field.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/plumconnect-enqueue-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { enqueueExpenseReply, enqueueExpenseButton, enqueueExpenseCapture } = await import("./enqueueExpense.js");
const { default: ExpenseReply } = await import("../../models/ExpenseReply.js");
const { default: ExpenseCapture } = await import("../../models/ExpenseCapture.js");

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await ExpenseReply.syncIndexes();
  await ExpenseCapture.syncIndexes();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await ExpenseReply.deleteMany({});
  await ExpenseCapture.deleteMany({});
});

/* ── the pre-refactor code, verbatim ─────────────────────────────────── */

async function legacyInlineText(messageId: string, waId: string, phoneNumberId: string, text: string) {
  const replyResult = await ExpenseReply.updateOne(
    { messageId },
    {
      $setOnInsert: {
        messageId,
        waId,
        phoneNumberId,
        text,
        status: "queued",
      },
    },
    { upsert: true },
  );
  return replyResult.upsertedCount > 0;
}

async function legacyInlineInteractive(messageId: string, waId: string, phoneNumberId: string, btnId: string) {
  const interResult = await ExpenseReply.updateOne(
    { messageId },
    { $setOnInsert: { messageId, waId, phoneNumberId, text: btnId, status: "queued" } },
    { upsert: true },
  );
  return interResult.upsertedCount > 0;
}

async function legacyInlineMedia(message: any, phoneNumberId: string) {
  const type: string = message?.type ?? "";
  const media = message[type] ?? {};
  const mediaId: string = media?.id ?? "";
  const mime: string = media?.mime_type ?? "";
  const messageId: string = message?.id ?? "";
  const waId: string = message?.from ?? "";
  const result = await ExpenseCapture.updateOne(
    { messageId },
    {
      $setOnInsert: {
        messageId,
        mediaId,
        mime,
        mediaType: type,
        filename: media?.filename,
        caption: media?.caption,
        waId,
        phoneNumberId,
        sourceChannel: "whatsapp",
        status: "queued",
      },
    },
    { upsert: true },
  );
  return result.upsertedCount > 0;
}

/** Raw on-disk doc minus the fields that differ per insert. */
async function rawDoc(model: any, messageId: string) {
  const d = await model.collection.findOne({ messageId });
  if (!d) return null;
  const { _id, __v, createdAt, updatedAt, ...rest } = d;
  return rest;
}

const PN = "1265026903369191";
const WA = "919876543210";

describe("enqueueExpenseReply ≡ inline text upsert", () => {
  it("writes the identical document", async () => {
    const legacyOk = await legacyInlineText("wamid.legacy.text", WA, PN, "confirm");
    const r = await enqueueExpenseReply({ messageId: "wamid.new.text", waId: WA, phoneNumberId: PN, text: "confirm" });

    expect(legacyOk).toBe(true);
    expect(r).toEqual({ enqueued: true });
    const legacy = await rawDoc(ExpenseReply, "wamid.legacy.text");
    const extracted = await rawDoc(ExpenseReply, "wamid.new.text");
    expect(extracted).toEqual({ ...legacy, messageId: "wamid.new.text" });
    // and the shape itself, so a schema drift is visible here too
    expect(extracted).toEqual({
      messageId: "wamid.new.text",
      waId: WA,
      phoneNumberId: PN,
      text: "confirm",
      status: "queued",
      attempts: 0,
    });
  });

  it("empty text is stored as an empty string, as before", async () => {
    await legacyInlineText("wamid.l", WA, PN, "");
    await enqueueExpenseReply({ messageId: "wamid.n", waId: WA, phoneNumberId: PN, text: "" });
    expect((await rawDoc(ExpenseReply, "wamid.n")).text).toBe((await rawDoc(ExpenseReply, "wamid.l")).text);
  });

  it("is idempotent on messageId: second call reports not-enqueued and leaves the row untouched", async () => {
    await enqueueExpenseReply({ messageId: "wamid.dup", waId: WA, phoneNumberId: PN, text: "first" });
    const again = await enqueueExpenseReply({ messageId: "wamid.dup", waId: "000", phoneNumberId: "x", text: "second" });
    expect(again).toEqual({ enqueued: false });
    expect(await ExpenseReply.countDocuments({ messageId: "wamid.dup" })).toBe(1);
    expect((await rawDoc(ExpenseReply, "wamid.dup")).text).toBe("first");
  });
});

describe("enqueueExpenseButton ≡ inline interactive upsert", () => {
  it("writes the identical document (button id as text)", async () => {
    await legacyInlineInteractive("wamid.legacy.btn", WA, PN, "add_to_claim");
    const r = await enqueueExpenseButton({ messageId: "wamid.new.btn", waId: WA, phoneNumberId: PN, buttonId: "add_to_claim" });
    expect(r).toEqual({ enqueued: true });
    const legacy = await rawDoc(ExpenseReply, "wamid.legacy.btn");
    const extracted = await rawDoc(ExpenseReply, "wamid.new.btn");
    expect(extracted).toEqual({ ...legacy, messageId: "wamid.new.btn" });
    expect(extracted.text).toBe("add_to_claim");
  });
});

describe("enqueueExpenseCapture ≡ inline media upsert", () => {
  const imageMsg = {
    id: "wamid.legacy.img",
    from: WA,
    type: "image",
    image: { id: "MEDIA123", mime_type: "image/jpeg", caption: "lunch" },
  };
  const docMsg = {
    id: "wamid.legacy.doc",
    from: WA,
    type: "document",
    document: { id: "MEDIA456", mime_type: "application/pdf", filename: "bill.pdf" },
  };

  it("image: identical document (filename absent, caption present)", async () => {
    await legacyInlineMedia(imageMsg, PN);
    const r = await enqueueExpenseCapture({
      messageId: "wamid.new.img",
      mediaId: "MEDIA123",
      mime: "image/jpeg",
      mediaType: "image",
      filename: undefined,
      caption: "lunch",
      waId: WA,
      phoneNumberId: PN,
    });
    expect(r).toEqual({ enqueued: true });
    const legacy = await rawDoc(ExpenseCapture, "wamid.legacy.img");
    const extracted = await rawDoc(ExpenseCapture, "wamid.new.img");
    expect(extracted).toEqual({ ...legacy, messageId: "wamid.new.img" });
    expect(extracted).toEqual({
      messageId: "wamid.new.img",
      mediaId: "MEDIA123",
      mime: "image/jpeg",
      mediaType: "image",
      caption: "lunch",
      waId: WA,
      phoneNumberId: PN,
      sourceChannel: "whatsapp",
      status: "queued",
      attempts: 0,
      extractionAttempts: 0,
      extraction: { merchant: null, date: null, amount: null, currency: "INR", taxAmount: null, gstin: null, suggestedCategory: null },
    });
    expect(extracted).not.toHaveProperty("filename");
    expect(extracted).not.toHaveProperty("workspaceId"); // tenant-less until the worker resolves the sender
    expect(extracted).not.toHaveProperty("employeeId");
  });

  it("document: identical document (filename present, caption absent)", async () => {
    await legacyInlineMedia(docMsg, PN);
    await enqueueExpenseCapture({
      messageId: "wamid.new.doc",
      mediaId: "MEDIA456",
      mime: "application/pdf",
      mediaType: "document",
      filename: "bill.pdf",
      caption: undefined,
      waId: WA,
      phoneNumberId: PN,
    });
    const legacy = await rawDoc(ExpenseCapture, "wamid.legacy.doc");
    const extracted = await rawDoc(ExpenseCapture, "wamid.new.doc");
    expect(extracted).toEqual({ ...legacy, messageId: "wamid.new.doc" });
    expect(extracted.filename).toBe("bill.pdf");
    expect(extracted).not.toHaveProperty("caption");
  });

  it("is idempotent on messageId", async () => {
    const first = await enqueueExpenseCapture({ messageId: "wamid.cdup", mediaId: "A", mime: "image/png", mediaType: "image", waId: WA, phoneNumberId: PN });
    const second = await enqueueExpenseCapture({ messageId: "wamid.cdup", mediaId: "B", mime: "image/png", mediaType: "image", waId: WA, phoneNumberId: PN });
    expect(first).toEqual({ enqueued: true });
    expect(second).toEqual({ enqueued: false });
    expect((await rawDoc(ExpenseCapture, "wamid.cdup")).mediaId).toBe("A");
  });
});
