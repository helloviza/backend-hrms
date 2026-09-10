// apps/backend/src/services/whatsappService.ts
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const QRCode = require("qrcode");
import path from "path";
import { getChromeLaunchOptions, cleanStaleChromeLocks } from "../utils/chromeResolver.js";
import { EodReportConfig, type IEodRecipient } from "../models/EodReportConfig.js";
import {
  uploadMedia,
  sendTemplateWithImageHeader,
} from "./whatsappCloud.service.js";
import logger from "../utils/logger.js";

// LocalAuth({ clientId: "plumtrips-eod" }) with the default dataPath persists the
// Chromium user-data-dir here. In Fargate this is the EFS-mounted /app/.wwebjs_auth.
const WA_SESSION_DIR = path.join(process.cwd(), ".wwebjs_auth", "session-plumtrips-eod");

// Hard ceiling for the whatsapp-web.js launch handshake. A hung Chrome (stale
// SingletonLock, detached frame, Store-injection timeout) must not become a
// silent forever-hang — on timeout we exit so ECS restarts with a clean lock.
const WA_INIT_TIMEOUT_MS = 90_000;

/* ─────────────────── Hybrid report delivery (Cloud API + web.js) ───────────
 * When enabled, sendImageToRecipients() splits the roster:
 *   • type "individual" → Meta Cloud API, as an approved image-header template
 *   • type "group"      → whatsapp-web.js (Meta exposes NO group send at all)
 *
 * DEFAULT OFF. With the flag unset the method behaves exactly as before —
 * everything over whatsapp-web.js — so deploying this code changes nothing
 * until an operator opts in. That matters because the Cloud API leg depends on
 * WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN pointing at the intended WABA and on the
 * template being approved there; flipping this on before both are true would
 * fail every individual recipient.
 * ───────────────────────────────────────────────────────────────────────── */
const HYBRID_REPORTS_ENABLED = /^(1|true|yes)$/i.test(
  (process.env.WA_REPORTS_HYBRID_ENABLED || "").trim(),
);

/** Approved template used for report delivery. Env-named, mirroring the
 *  WA_DISRUPTION_TEMPLATE / WA_ARRIVAL_TEMPLATE pattern. */
const REPORT_TEMPLATE_NAME = (
  process.env.WA_REPORT_TEMPLATE || "plumtrips_report_ready"
).trim();
const REPORT_TEMPLATE_LANG = (process.env.WA_REPORT_TEMPLATE_LANG || "en").trim();

/** Minimum digits for a usable international WhatsApp number (matches the
 *  admin UI's own add-recipient rule). Deliberately NOT waNumber.ts's
 *  isValidWhatsAppNumber(), which requires a leading "+" that these stored
 *  digits-only recipients never have. */
const MIN_MSISDN_DIGITS = 8;

/** Template body variables: {{1}} report name, {{2}} date/slot label. */
export interface ReportSendMeta {
  reportName?: string;
  dateLabel?: string;
}

/**
 * Derive the two template body vars from the caption when the caller does not
 * supply them, so eodSnapshot.ts / crmSalesPulseDelivery.ts stay untouched.
 *
 * Both captions open with "<emoji> Plumtrips <Report> · <date>[ (slot)]":
 *   "📊 Plumtrips EOD · 05 Sep 2026"                    → ["EOD", "05 Sep 2026"]
 *   "📊 Plumtrips Sales Pulse · 05 Sep 2026 (4 PM)"     → ["Sales Pulse", "05 Sep 2026 (4 PM)"]
 * Anything unparseable falls back to safe generic values rather than throwing —
 * a template send must never fail because a caption was reworded.
 */
export function deriveReportVars(
  caption: string,
  meta?: ReportSendMeta,
): { reportName: string; dateLabel: string } {
  const firstLine = String(caption ?? "").split("\n")[0] ?? "";
  const [rawName, ...rest] = firstLine.split("·");

  const derivedName = rawName
    .replace(/[^\p{L}\p{N} .&/-]/gu, "") // drop leading emoji/pictographs
    .replace(/\bPlumtrips\b/i, "")
    .trim();
  const derivedDate = rest.join("·").trim();

  return {
    reportName: meta?.reportName?.trim() || derivedName || "Report",
    dateLabel: meta?.dateLabel?.trim() || derivedDate || "",
  };
}

type WaStatus = "disconnected" | "qr_ready" | "connecting" | "connected" | "failed";

class WhatsAppService {
  private client: InstanceType<typeof Client> | null = null;
  private qrCode: string | null = null;
  private status: WaStatus = "disconnected";
  private qrCallbacks: Set<(qr: string) => void> = new Set();
  private statusCallbacks: Set<(s: string) => void> = new Set();

  async initialize(): Promise<void> {
    // Only the dedicated WA host (WA_HOST=true) may own the single
    // whatsapp-web.js client. Anywhere else (e.g. App Runner) this is a no-op,
    // so no competing client can register against clientId "plumtrips-eod".
    if (process.env.WA_HOST !== "true") {
      logger.warn("[WA] initialize() skipped — not the WA host (WA_HOST !== 'true')");
      return;
    }

    if (this.client) {
      logger.info("[WA] Client already initialized, skipping");
      return;
    }

    this.status = "connecting";
    this.notifyStatus("connecting");

    // Note: LocalAuth persists the session to disk under
    // apps/backend/.wwebjs_auth/session-plumtrips-eod/ — no DB session injection needed.
    // The legacy `session:` constructor field was deprecated in whatsapp-web.js 1.16+
    // and is no longer passed. EodReportConfig.waSession is now unused at read time
    // (still written by the 'authenticated' handler — harmless no-op).

    // Stale-lock pre-clean: a previous Chrome that died without cleanup leaves
    // SingletonLock/DevToolsActivePort/.nfs* behind, which make this launch hang
    // or throw EBUSY/ENOTEMPTY. Remove ONLY those lock artifacts — never the auth
    // credentials, never the session dir itself (that would force a re-QR).
    try {
      const removedLocks = cleanStaleChromeLocks(WA_SESSION_DIR);
      if (removedLocks.length) {
        logger.warn("[WA] Cleared stale Chromium lock artifacts before launch", {
          sessionDir: WA_SESSION_DIR,
          removedLocks,
        });
      }
    } catch (err: any) {
      logger.warn("[WA] Stale-lock pre-clean failed (continuing to launch)", {
        message: err?.message,
      });
    }

    const chromeOpts = await getChromeLaunchOptions();
    logger.info("[WA] Launching whatsapp-web.js puppeteer", {
      executablePath: chromeOpts.executablePath,
      env: process.env.NODE_ENV || "development",
    });

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: "plumtrips-eod" }),
      takeoverOnConflict: true,
      takeoverTimeoutMs: 10000,
      puppeteer: {
        executablePath: chromeOpts.executablePath,
        headless: true,
        args: chromeOpts.args,
        protocolTimeout: chromeOpts.protocolTimeout,
        // Removed: --single-process (causes "Navigating frame was detached")
        // Removed: --no-zygote (paired with --single-process)
        // Removed: --disable-accelerated-2d-canvas, --no-first-run (unnecessary)
      },
    });

    this.client.on("loading_screen", (percent: number, message: string) => {
      logger.info("[WA] Loading screen", { percent, message });
    });

    this.client.on("change_state", (state: string) => {
      logger.info("[WA] Connection state changed", { state });
    });

    this.client.on("qr", async (qr: string) => {
      try {
        const png = await QRCode.toDataURL(qr);
        this.qrCode = png;
        this.status = "qr_ready";
        logger.info("[WA] QR code generated — scan to connect");
        this.qrCallbacks.forEach((cb) => cb(png));
      } catch (err: any) {
        logger.error("[WA] QR generation error", {
          message: err?.message,
          stack: err?.stack,
          name: err?.name,
          cause: err?.cause,
        });
      }
    });

    this.client.on("authenticated", async (session: unknown) => {
      logger.info("[WA] Authenticated");
      try {
        await EodReportConfig.findOneAndUpdate(
          {},
          { waSession: JSON.stringify(session), waConnected: true },
          { upsert: true },
        );
      } catch (err: any) {
        logger.error("[WA] Failed to save session to DB", {
          message: err?.message,
          stack: err?.stack,
          name: err?.name,
          cause: err?.cause,
        });
      }
    });

    this.client.on("ready", async () => {
      // whatsapp-web.js fires 'ready' before its internal Store finishes hydrating.
      // A 2s settle delay avoids "Cannot read properties of undefined (reading 'getChat')"
      // race conditions on the very first sendMessage / getNumberId call.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      this.status = "connected";
      this.qrCode = null;
      logger.info("[WA] Client ready");
      try {
        await EodReportConfig.findOneAndUpdate(
          {},
          { waConnected: true },
          { upsert: true },
        );
      } catch (err: any) {
        logger.error("[WA] Failed to update DB on ready", {
          message: err?.message,
          stack: err?.stack,
          name: err?.name,
          cause: err?.cause,
        });
      }
      this.notifyStatus("connected");
    });

    this.client.on("disconnected", async (reason: string) => {
      this.status = "disconnected";
      this.qrCode = null;
      logger.warn("[WA] Disconnected", { reason });
      try {
        await EodReportConfig.findOneAndUpdate(
          {},
          { waConnected: false, waSession: "" },
          { upsert: true },
        );
      } catch (err: any) {
        logger.error("[WA] Failed to clear session in DB", {
          message: err?.message,
          stack: err?.stack,
          name: err?.name,
          cause: err?.cause,
        });
      }
      // Tear down the dead client BEFORE nulling so a hung destroy() can't leave
      // an orphaned Chrome holding the SingletonLock. Bounded so destroy() itself
      // can't become a new silent hang.
      await this.destroyClientWithTimeout();
      this.client = null;
      this.notifyStatus("disconnected");
    });

    this.client.on("auth_failure", async (msg: string) => {
      this.status = "failed";
      logger.error("[WA] Auth failure", { msg });
      await this.destroyClientWithTimeout();
      this.client = null;
      this.notifyStatus("failed");
    });

    // Race the launch handshake against a hard timeout. The timer is captured so
    // it can be cleared on success — otherwise the losing promise would reject
    // after the race settled and surface as an unhandledRejection.
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(
          new Error(
            `whatsapp-web.js initialize() timed out after ${WA_INIT_TIMEOUT_MS}ms`,
          ),
        );
      }, WA_INIT_TIMEOUT_MS);
    });

    try {
      await Promise.race([this.client.initialize(), timeoutPromise]);
      logger.info("[WA] whatsapp-web.js launch succeeded", {
        executablePath: chromeOpts.executablePath,
        outcome: "initialized",
      });
    } catch (err: any) {
      logger.error("[WA] Client initialize error", {
        message: err?.message,
        stack: err?.stack,
        name: err?.name,
        cause: err?.cause,
        executablePath: chromeOpts.executablePath,
        timedOut,
      });
      if (timedOut) {
        // A hung launch never recovers on its own. Exit so ECS restarts the task;
        // the boot/initialize() stale-lock pre-clean clears the lock on next start.
        logger.error(
          "[WA] launch hung — exiting(1) for a clean ECS restart (boot pre-clean will clear the lock)",
        );
        process.exit(1);
      }
      // Non-timeout launch failure: keep prior behavior — mark failed, tear down,
      // and rethrow so the caller (e.g. sendToRecipients) can report it.
      this.status = "failed";
      await this.destroyClientWithTimeout();
      this.client = null;
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Destroy the current client with a bounded timeout so a hung destroy() (which
   * itself shells out to Chrome) can never become a new silent hang. Best-effort:
   * swallows + logs any error/timeout. Does NOT null this.client — the caller
   * owns that so the null assignment stays adjacent to its own state changes.
   */
  private async destroyClientWithTimeout(timeoutMs = 8_000): Promise<void> {
    const client = this.client;
    if (!client) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.destroy(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`client.destroy() timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (err: any) {
      logger.warn("[WA] client.destroy() failed or timed out (continuing)", {
        message: err?.message,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async sendMessage(to: string, message: string): Promise<void> {
    if (!this.client) {
      throw new Error("WhatsApp client not initialized");
    }

    // Verify actual client state via .info rather than trusting this.status
    try {
      const info = this.client.info;
      if (!info) {
        throw new Error("WhatsApp not connected");
      }
    } catch {
      // If .info access throws, client may still be usable — let sendMessage decide
    }

    await this.client.sendMessage(to, message);
  }

  /**
   * Resolve a recipient to the proper whatsapp-web.js chat ID:
   *   - group: returns r.groupId verbatim (already in `<id>@g.us` form)
   *   - individual: validates the number with getNumberId() and returns the
   *     canonical `<wid>@c.us`. Returns null if the number is not registered
   *     on WhatsApp (caller should record failure and skip).
   */
  private async resolveChatId(r: IEodRecipient): Promise<string | null> {
    if (r.type === "group") return r.groupId;

    const cleanNumber = String(r.number).replace(/[^0-9]/g, "");
    if (!cleanNumber) {
      logger.warn("[WA] Recipient has no digits in number", { name: r.name });
      return null;
    }

    const numberId = await this.client!.getNumberId(cleanNumber);
    if (!numberId) {
      logger.warn("[WA] Number not registered on WhatsApp", {
        name: r.name,
        number: cleanNumber,
      });
      return null;
    }

    // Force @c.us — getNumberId can return @lid (Linked ID), which has
    // delivery reliability issues. numberId.user is the validated digits.
    const chatId = `${cleanNumber}@c.us`;

    logger.info("[WA] Resolved chat ID", {
      name: r.name,
      inputNumber: cleanNumber,
      forcedChatId: chatId,
      numberIdUser: numberId.user,
      numberIdServer: numberId.server,
      originalSerialized: numberId._serialized,
    });

    return chatId;
  }

  async sendToRecipients(
    message: string,
    recipientsOverride?: IEodRecipient[],
  ): Promise<{ sent: number; failed: number; errors: string[] }> {
    let recipients: IEodRecipient[];
    if (recipientsOverride) {
      recipients = recipientsOverride.filter((r) => r.active !== false);
    } else {
      const config = await EodReportConfig.findOne().lean();
      recipients = (config?.recipients ?? []).filter((r) => r.active !== false);
    }

    // Auto-reconnect if client was destroyed (e.g. hot-reload, disconnected event)
    if (!this.client) {
      logger.warn("[WA] Client is null, reinitializing...");
      await this.initialize();
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Bail out cleanly if still not ready after reinit attempt
    if (!this.client) {
      return {
        sent: 0,
        failed: recipients.length,
        errors: recipients.map((r: any) => `[${r.name}] WhatsApp client not initialized`),
      };
    }

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const r of recipients) {
      try {
        const to = await this.resolveChatId(r);
        if (!to) {
          failed++;
          errors.push(`[${r.name}] not on WhatsApp`);
          continue;
        }
        await this.client!.sendMessage(to, message);
        sent++;
        logger.info("[WA] Text sent", { name: r.name, to });
      } catch (err: any) {
        failed++;
        errors.push(`[${r.name}] ${err?.message ?? "Send failed"}`);
        logger.error("[WA] Failed to send to recipient", {
          name: r.name,
          number: r.number,
          message: err?.message,
          stack: err?.stack,
          errName: err?.name,
          cause: err?.cause,
        });
      }
    }

    return { sent, failed, errors };
  }

  /** @deprecated use sendToRecipients() instead */
  async sendToAllRecipients(
    message: string,
  ): Promise<{ sent: number; failed: number; errors: string[] }> {
    return this.sendToRecipients(message);
  }

  /**
   * Deliver the report image to every active recipient.
   *
   * With WA_REPORTS_HYBRID_ENABLED unset this is the original whatsapp-web.js
   * broadcast, unchanged. With it set the roster is split: individuals go over
   * the Cloud API as an image-header template, groups stay on web.js. Both
   * legs' tallies are merged so lastSentStatus stays truthful either way.
   *
   * `meta` is optional — when omitted the template body vars are derived from
   * the caption, which keeps eodSnapshot.ts / crmSalesPulseDelivery.ts callers
   * untouched.
   */
  async sendImageToRecipients(
    imageBuffer: Buffer,
    caption: string,
    recipientsOverride?: IEodRecipient[],
    meta?: ReportSendMeta,
  ): Promise<{ sent: number; failed: number; errors: string[] }> {
    const recipients = await this.resolveActiveRecipients(recipientsOverride);

    if (!HYBRID_REPORTS_ENABLED) {
      return this.sendImageViaWebClient(imageBuffer, caption, recipients);
    }

    // Partition on the schema-enforced discriminator. Rows are still validated
    // per-leg below — a `type` value is never assumed to agree with its payload.
    const groupRows = recipients.filter((r) => r.type === "group");
    const individualRows = recipients.filter((r) => r.type !== "group");

    // Reject malformed group ids here rather than inside the web.js leg, so the
    // legacy path stays a faithful copy of the original loop.
    const validGroups = groupRows.filter((r) =>
      String(r.groupId ?? "").trim().endsWith("@g.us"),
    );
    const badGroups = groupRows.filter(
      (r) => !String(r.groupId ?? "").trim().endsWith("@g.us"),
    );

    logger.info("[WA] Hybrid report split", {
      individuals: individualRows.length,
      groups: validGroups.length,
      malformedGroups: badGroups.length,
      template: REPORT_TEMPLATE_NAME,
    });

    const cloud = await this.sendImageViaCloudApi(
      imageBuffer,
      caption,
      individualRows,
      meta,
    );

    // The web.js leg runs only for groups. Its null-client guard lives inside
    // sendImageViaWebClient, so a dead session fails groups ALONE — the Cloud
    // API individuals above have already dispatched regardless.
    const web = validGroups.length
      ? await this.sendImageViaWebClient(imageBuffer, caption, validGroups)
      : { sent: 0, failed: 0, errors: [] as string[] };

    return {
      sent: cloud.sent + web.sent,
      failed: cloud.failed + web.failed + badGroups.length,
      errors: [
        ...cloud.errors,
        ...web.errors,
        ...badGroups.map((r) => `[${r.name}] group id must end in @g.us`),
      ],
    };
  }

  /** Shared roster resolution: explicit override, else the EOD config, always
   *  filtered to active rows. */
  private async resolveActiveRecipients(
    recipientsOverride?: IEodRecipient[],
  ): Promise<IEodRecipient[]> {
    if (recipientsOverride) {
      return recipientsOverride.filter((r) => r.active !== false);
    }
    const config = await EodReportConfig.findOne().lean();
    return (config?.recipients ?? []).filter((r) => r.active !== false);
  }

  /**
   * INDIVIDUAL leg — Meta Cloud API, image-header template.
   *
   * The PNG is uploaded ONCE per run and the resulting media id reused for
   * every recipient (mirroring the build-media-once pattern in the web.js leg).
   * An upload failure fails this leg only; the group leg is unaffected.
   */
  private async sendImageViaCloudApi(
    imageBuffer: Buffer,
    caption: string,
    individuals: IEodRecipient[],
    meta?: ReportSendMeta,
  ): Promise<{ sent: number; failed: number; errors: string[] }> {
    if (!individuals.length) return { sent: 0, failed: 0, errors: [] };

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    // Validate before uploading — no point paying for an upload if nobody is
    // addressable.
    const addressable: { row: IEodRecipient; to: string }[] = [];
    for (const r of individuals) {
      const digits = String(r.number ?? "").replace(/[^0-9]/g, "");
      if (digits.length < MIN_MSISDN_DIGITS) {
        failed++;
        errors.push(`[${r.name}] invalid WhatsApp number`);
        continue;
      }
      // Stored numbers are already digits-only with no "+", which is exactly
      // the shape Meta's `to` field wants.
      addressable.push({ row: r, to: digits });
    }

    if (!addressable.length) return { sent, failed, errors };

    let mediaId: string;
    try {
      mediaId = await uploadMedia(imageBuffer, "image/png", "plumtrips-report.png");
    } catch (err: any) {
      const msg = err?.message ?? "media upload failed";
      logger.error("[WA] Cloud API media upload failed — all individuals failed", {
        message: msg,
        individuals: addressable.length,
      });
      return {
        sent,
        failed: failed + addressable.length,
        errors: [...errors, ...addressable.map((a) => `[${a.row.name}] ${msg}`)],
      };
    }

    const { reportName, dateLabel } = deriveReportVars(caption, meta);

    for (const { row, to } of addressable) {
      const result = await sendTemplateWithImageHeader(
        to,
        REPORT_TEMPLATE_NAME,
        REPORT_TEMPLATE_LANG,
        mediaId,
        [reportName, dateLabel],
      );
      if (result.sent) {
        sent++;
        logger.info("[WA] Cloud API template sent", { name: row.name, to });
      } else {
        failed++;
        errors.push(`[${row.name}] ${result.error ?? "Send failed"}`);
        logger.error("[WA] Cloud API template send failed", {
          name: row.name,
          to,
          error: result.error,
        });
      }
    }

    return { sent, failed, errors };
  }

  /**
   * GROUP / legacy leg — whatsapp-web.js. Extracted verbatim from the original
   * sendImageToRecipients loop, including its null-client guard, which now
   * scopes to this leg alone.
   */
  private async sendImageViaWebClient(
    imageBuffer: Buffer,
    caption: string,
    recipients: IEodRecipient[],
  ): Promise<{ sent: number; failed: number; errors: string[] }> {
    if (!this.client) {
      logger.warn("[WA] Client is null, reinitializing for image send...");
      await this.initialize();
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (!this.client) {
      return {
        sent: 0,
        failed: recipients.length,
        errors: recipients.map((r: any) => `[${r.name}] WhatsApp client not initialized`),
      };
    }

    const media = new MessageMedia(
      "image/png",
      imageBuffer.toString("base64"),
      "plumtrips-eod.png",
    );

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const r of recipients) {
      try {
        const to = await this.resolveChatId(r);
        if (!to) {
          failed++;
          errors.push(`[${r.name}] not on WhatsApp`);
          continue;
        }
        await this.client!.sendMessage(to, media, { caption });
        sent++;
        logger.info("[WA] Image sent", { name: r.name, to });
      } catch (err: any) {
        failed++;
        errors.push(`[${r.name}] ${err?.message ?? "Send failed"}`);
        logger.error("[WA] Failed to send image to recipient", {
          name: r.name,
          number: r.number,
          message: err?.message,
          stack: err?.stack,
          errName: err?.name,
          cause: err?.cause,
        });
      }
    }

    return { sent, failed, errors };
  }

  getStatus(): string {
    return this.status;
  }

  getQrCode(): string | null {
    return this.qrCode;
  }

  onQr(cb: (qr: string) => void): void {
    this.qrCallbacks.add(cb);
  }

  onStatus(cb: (s: string) => void): void {
    this.statusCallbacks.add(cb);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.destroyClientWithTimeout();
      this.client = null;
    }
    this.status = "disconnected";
    this.qrCode = null;
    try {
      await EodReportConfig.findOneAndUpdate(
        {},
        { waConnected: false, waSession: "" },
        { upsert: true },
      );
    } catch (err: any) {
      logger.error("[WA] Failed to clear session on disconnect", {
        message: err?.message,
        stack: err?.stack,
        name: err?.name,
        cause: err?.cause,
      });
    }
    this.notifyStatus("disconnected");
  }

  async getGroups(): Promise<{ id: string; name: string; participants: number }[]> {
    if (!this.client || this.status !== "connected") {
      throw new Error("WhatsApp not connected");
    }
    const chats = await this.client.getChats();
    return chats
      .filter((c: any) => c.isGroup)
      .map((c: any) => ({
        id: c.id._serialized,
        name: c.name,
        participants: c.participants?.length ?? 0,
      }));
  }

  private notifyStatus(s: string): void {
    this.statusCallbacks.forEach((cb) => cb(s));
  }
}

export const whatsappService = new WhatsAppService();
