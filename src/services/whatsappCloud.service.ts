// apps/backend/src/services/whatsappCloud.service.ts
import crypto from "crypto";
import axios from "axios";
import { env } from "../config/env.js";
import { whatsappLogger } from "../utils/logger.js";

/**
 * WhatsApp Cloud API (Meta Graph) client — Expense Management inbound capture.
 *
 * This is the Meta Graph / Cloud API integration and is wholly separate from the
 * whatsapp-web.js EOD/Sales-Pulse outbound flow (services/whatsappService.ts).
 * It is used to (a) verify webhook signatures, (b) download inbound media, and
 * (c) send the "not registered" reply.
 */

const GRAPH_BASE = "https://graph.facebook.com";

/** True when enough Cloud-API config exists to download media + send replies. */
export function isWhatsAppCloudConfigured(): boolean {
  return Boolean(env.WA_ACCESS_TOKEN && env.WA_PHONE_NUMBER_ID);
}

/**
 * Verify Meta's `X-Hub-Signature-256` header against the RAW request body.
 * Header format: "sha256=<hex hmac>". Keyed with the Meta App Secret.
 * Returns false on any malformed input or length mismatch (never throws).
 */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined): boolean {
  const secret = env.WA_APP_SECRET;
  if (!secret || !header || !rawBody?.length) return false;

  const [scheme, theirHex] = header.split("=");
  if (scheme !== "sha256" || !theirHex) return false;

  const expectedHex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(theirHex, "hex");
  if (a.length !== b.length) return false; // timingSafeEqual requires equal lengths

  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Resolve a media id to its (short-lived, ~5 min) download URL.
 * GET graph.facebook.com/<version>/<mediaId> with the WA bearer token.
 */
export async function getMediaUrl(
  mediaId: string,
): Promise<{ url: string; mime?: string }> {
  const { data } = await axios.get(`${GRAPH_BASE}/${env.WA_GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
    timeout: 30_000,
  });
  return { url: data?.url, mime: data?.mime_type };
}

/**
 * Download media bytes from the lookaside.fbsbx.com URL returned by getMediaUrl.
 * The URL still requires the bearer token (it 401s without it) and expires after
 * ~5 minutes — call this promptly after getMediaUrl.
 */
export async function downloadMedia(url: string): Promise<Buffer> {
  const { data } = await axios.get<ArrayBuffer>(url, {
    headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
    responseType: "arraybuffer",
    timeout: 60_000,
  });
  return Buffer.from(data);
}

/**
 * Send a plain-text WhatsApp message via the Cloud API.
 * POST /<phoneNumberId>/messages. Best-effort: logs and swallows failures so a
 * failed reply never blocks capture processing.
 */
export async function sendTextMessage(to: string, body: string): Promise<void> {
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
