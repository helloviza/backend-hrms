// apps/backend/src/routes/whatsapp.webhook.ts
import { Router, type Request, type Response } from "express";
import ExpenseCapture from "../models/ExpenseCapture.js";
import ExpenseReply from "../models/ExpenseReply.js";
import { verifyMetaSignature } from "../services/whatsappCloud.service.js";
import { env } from "../config/env.js";
import { whatsappLogger } from "../utils/logger.js";

/**
 * WhatsApp Cloud API webhook (Expense Management — inbound receipt capture).
 *
 * Mounted at /api/whatsapp with express.raw() BEFORE express.json(), so on POST
 * `req.body` is the raw Buffer needed for X-Hub-Signature-256 verification.
 * The handler only ENQUEUES (persists a queued ExpenseCapture) and acks within
 * 5s — media download happens in the background worker.
 */

const router = Router();

const MEDIA_TYPES = new Set(["image", "document"]);

// GET /webhook — Meta verification handshake
router.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && env.WA_VERIFY_TOKEN && token === env.WA_VERIFY_TOKEN) {
    whatsappLogger.info("Webhook verified");
    return res.status(200).send(String(challenge ?? ""));
  }

  whatsappLogger.warn("Webhook verification failed", { mode, tokenMatch: token === env.WA_VERIFY_TOKEN });
  return res.sendStatus(403);
});

// POST /webhook — inbound message notifications
router.post("/webhook", async (req: Request, res: Response) => {
  // ── 1. Signature verification (HMAC-SHA256 of the RAW body) ──────────────
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? "");

  if (!env.WA_APP_SECRET) {
    if (env.NODE_ENV === "production") {
      whatsappLogger.error("WA_APP_SECRET not set in production — rejecting webhook");
      return res.sendStatus(500);
    }
    whatsappLogger.warn("WA_APP_SECRET not set — skipping signature verification (dev)");
  } else if (!verifyMetaSignature(rawBody, signature)) {
    whatsappLogger.warn("Invalid X-Hub-Signature-256 — rejecting");
    return res.sendStatus(401);
  }

  // ── 2. Parse + enqueue. Always ack 200 so Meta does not redeliver. ───────
  try {
    const payload = JSON.parse(rawBody.toString("utf8"));
    const entries = Array.isArray(payload?.entry) ? payload.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value ?? {};
        const phoneNumberId: string = value?.metadata?.phone_number_id ?? "";
        const messages = Array.isArray(value?.messages) ? value.messages : [];

        // Iterate ALL messages (never just [0]).
        for (const message of messages) {
          try {
            const type: string = message?.type ?? "";

            // ── TEXT replies (confirm / correct / cancel) ───────────────────
            // Enqueue idempotently; the worker matches them to the pending
            // capture by waId. We never handle replies synchronously here so
            // the webhook keeps acking within Meta's 5s window.
            if (type === "text") {
              const messageId: string = message?.id ?? "";
              const waId: string = message?.from ?? "";
              const text: string = message?.text?.body ?? "";
              if (!messageId || !waId) {
                whatsappLogger.warn("Skipping text message with missing fields", { hasId: Boolean(messageId), hasWaId: Boolean(waId) });
                continue;
              }

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

              if (replyResult.upsertedCount > 0) {
                whatsappLogger.info("Text reply queued", { messageId, waId });
              } else {
                whatsappLogger.info("Duplicate text webhook — already queued", { messageId });
              }
              continue;
            }

            // ── INTERACTIVE replies (tapped reply buttons) ──────────────────
            // A button tap arrives as type "interactive". We enqueue it as an
            // ExpenseReply whose `text` is the button id, so the worker handles a
            // tap and the equivalent typed keyword ("submit", "yes", …) the same
            // way — text fallbacks keep working everywhere.
            if (type === "interactive") {
              const messageId: string = message?.id ?? "";
              const waId: string = message?.from ?? "";
              const inter = message?.interactive ?? {};
              const btnId: string = inter?.button_reply?.id ?? inter?.list_reply?.id ?? "";
              if (!messageId || !waId || !btnId) {
                whatsappLogger.warn("Skipping interactive message with missing fields", {
                  hasId: Boolean(messageId),
                  hasWaId: Boolean(waId),
                  hasBtn: Boolean(btnId),
                });
                continue;
              }

              const interResult = await ExpenseReply.updateOne(
                { messageId },
                { $setOnInsert: { messageId, waId, phoneNumberId, text: btnId, status: "queued" } },
                { upsert: true },
              );

              if (interResult.upsertedCount > 0) {
                whatsappLogger.info("Button reply queued", { messageId, waId, btnId });
              } else {
                whatsappLogger.info("Duplicate interactive webhook — already queued", { messageId });
              }
              continue;
            }

            if (!MEDIA_TYPES.has(type)) continue;

            const media = message[type] ?? {};
            const mediaId: string = media?.id ?? "";
            const mime: string = media?.mime_type ?? "";
            const messageId: string = message?.id ?? "";
            const waId: string = message?.from ?? "";

            if (!messageId || !mediaId || !waId) {
              whatsappLogger.warn("Skipping media message with missing fields", { messageId, mediaId, hasWaId: Boolean(waId) });
              continue;
            }

            // Idempotent enqueue: insert once per WhatsApp messageId.
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

            if (result.upsertedCount > 0) {
              whatsappLogger.info("Receipt queued", { messageId, mediaType: type, waId });
            } else {
              whatsappLogger.info("Duplicate webhook — already processed", { messageId });
            }
          } catch (err: any) {
            // Duplicate key from a concurrent delivery is expected — ignore it.
            if (err?.code === 11000) {
              whatsappLogger.info("Duplicate webhook (race) — already processed", { messageId: message?.id });
              continue;
            }
            whatsappLogger.error("Failed to enqueue message", {
              messageId: message?.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }
  } catch (err) {
    // Even on parse failure we ack — a 200 prevents Meta retry storms; the error
    // is logged for investigation.
    whatsappLogger.error("Failed to process webhook payload", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return res.sendStatus(200);
});

export default router;
