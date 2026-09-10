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

/**
 * Outcome-returning variants for the trip notifier (Phase 3). Unlike the
 * expense-facing sendTextMessage above (which SWALLOWS failures), these RETURN
 * true/false so the notifier can record the real delivery outcome and fall back
 * to email. The existing swallow behaviour for expense callers is unchanged.
 *
 * PRODUCTION NOTE: unsolicited outbound WhatsApp requires an approved Meta
 * message TEMPLATE (set WA_DISRUPTION_TEMPLATE). Free-form text only works
 * inside an open 24-hour customer-service window (dev / replies). Template
 * registration is a business action outside this repo.
 */
export async function sendTextMessageResult(to: string, body: string): Promise<boolean> {
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

export async function sendTemplateMessage(
  to: string,
  templateName: string,
  bodyParams: string[],
  languageCode = "en",
): Promise<boolean> {
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

export type ReplyButton = { id: string; title: string };

/**
 * Send an interactive reply-button message via the Cloud API.
 * POST /<phoneNumberId>/messages with type "interactive" / "button".
 *
 * WhatsApp caps this at 3 reply buttons; titles are truncated to 20 chars and
 * the body to 1024. If the interactive send fails (or there are no buttons) we
 * fall back to a plain-text send of the same body, so the conversation never
 * stalls just because a button couldn't be rendered.
 */
export async function sendButtonMessage(
  to: string,
  body: string,
  buttons: ReplyButton[],
): Promise<void> {
  if (!isWhatsAppCloudConfigured()) {
    whatsappLogger.warn("sendButtonMessage skipped — Cloud API not configured", { to });
    return;
  }
  const replyButtons = (buttons || []).slice(0, 3).map((b) => ({
    type: "reply",
    reply: { id: b.id, title: String(b.title).slice(0, 20) },
  }));
  if (replyButtons.length === 0) {
    await sendTextMessage(to, body);
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
    await sendTextMessage(to, body);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Outbound MEDIA + image-header TEMPLATE sends.
 *
 * Added for the hybrid EOD / Sales-Pulse split: individual recipients move to
 * the Cloud API while group recipients stay on whatsapp-web.js (which has no
 * Cloud API equivalent — Meta exposes no group-messaging surface).
 *
 * Both helpers are ADDITIVE. The shared sendTemplateMessage() signature above
 * is deliberately left alone: arrivalSession.ts and tripNotifier.ts call it and
 * must not be disturbed.
 * ───────────────────────────────────────────────────────────────────────── */

/** Meta's documented ceiling for an image sent over the Cloud API. */
export const WA_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Upload media bytes and return the resulting media id.
 * POST /<phoneNumberId>/media as multipart/form-data with `messaging_product`,
 * `type` and `file`.
 *
 * The id is WABA-scoped and reusable across sends, so callers should upload
 * ONCE per batch and reuse the id for every recipient — never once per person.
 *
 * Multipart body uses Node's native FormData/Blob (Node 18+); axios derives the
 * boundary from the FormData instance, so Content-Type is deliberately NOT set
 * here — setting it by hand would omit the boundary and Meta would reject it.
 * No new dependency is required.
 *
 * THROWS on failure (unlike sendTextMessage, which swallows) so a caller can
 * record the real outcome instead of reporting a send that never happened.
 */
export async function uploadMedia(
  buffer: Buffer,
  mimeType: string,
  filename = "upload",
): Promise<string> {
  if (!isWhatsAppCloudConfigured()) {
    throw new Error(
      "WhatsApp Cloud API not configured (WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID)",
    );
  }
  if (!buffer?.length) {
    throw new Error("uploadMedia: empty buffer");
  }
  if (buffer.length > WA_IMAGE_MAX_BYTES) {
    throw new Error(
      `uploadMedia: ${buffer.length} bytes exceeds the ${WA_IMAGE_MAX_BYTES}-byte media limit`,
    );
  }

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

  try {
    const { data } = await axios.post(
      `${GRAPH_BASE}/${env.WA_GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
        timeout: 60_000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      },
    );
    const id = data?.id;
    if (!id) {
      throw new Error(
        `media upload returned no id (keys: ${Object.keys(data || {}).join(",") || "none"})`,
      );
    }
    whatsappLogger.info("uploadMedia ok", { bytes: buffer.length, mimeType, mediaId: id });
    return String(id);
  } catch (err) {
    const detail = describeGraphError(err);
    whatsappLogger.error("uploadMedia failed", { bytes: buffer.length, mimeType, error: detail });
    throw new Error(`WhatsApp media upload failed: ${detail}`);
  }
}

/** Outcome of an image-header template send. Never throws; never swallows. */
export interface TemplateSendResult {
  sent: boolean;
  error?: string;
}

/**
 * Send an approved template whose HEADER is an image, with text body variables.
 *
 * Sibling of sendTemplateMessage() — that one builds a body-only `components`
 * array and is shared by the arrival + trip-notifier callers, so it is left
 * untouched rather than gaining an optional header parameter.
 *
 * `headerMediaId` comes from uploadMedia(); pass the SAME id for every
 * recipient in a run.
 *
 * Returns { sent, error? } rather than throwing or swallowing, so the caller's
 * { sent, failed, errors } tally stays truthful.
 */
export async function sendTemplateWithImageHeader(
  to: string,
  templateName: string,
  langCode: string,
  headerMediaId: string,
  bodyParams: string[],
): Promise<TemplateSendResult> {
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

/**
 * Pull the useful message out of a Graph failure. Meta puts the actionable text
 * in response.data.error.message (e.g. an unapproved template name, a paused
 * template, a number outside the allow-list) — err.message alone is usually
 * just "Request failed with status code 400".
 */
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
