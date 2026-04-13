// apps/backend/src/services/whatsappService.ts
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
import { EodReportConfig } from "../models/EodReportConfig.js";
import logger from "../utils/logger.js";

type WaStatus = "disconnected" | "qr_ready" | "connecting" | "connected" | "failed";

class WhatsAppService {
  private client: InstanceType<typeof Client> | null = null;
  private qrCode: string | null = null;
  private status: WaStatus = "disconnected";
  private qrCallbacks: Set<(qr: string) => void> = new Set();
  private statusCallbacks: Set<(s: string) => void> = new Set();

  async initialize(): Promise<void> {
    if (this.client) {
      logger.info("[WA] Client already initialized, skipping");
      return;
    }

    this.status = "connecting";
    this.notifyStatus("connecting");

    // Load persisted session from DB so QR re-scan is not needed after restarts
    const config = await EodReportConfig.findOne().lean();
    const savedSession = config?.waSession
      ? JSON.parse(config.waSession)
      : undefined;

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: "plumtrips-eod" }),
      session: savedSession,
      puppeteer: {
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
        ],
      },
    });

    this.client.on("qr", async (qr: string) => {
      try {
        const png = await QRCode.toDataURL(qr);
        this.qrCode = png;
        this.status = "qr_ready";
        logger.info("[WA] QR code generated — scan to connect");
        this.qrCallbacks.forEach((cb) => cb(png));
      } catch (err) {
        logger.error("[WA] QR generation error", { err });
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
      } catch (err) {
        logger.error("[WA] Failed to save session to DB", { err });
      }
    });

    this.client.on("ready", async () => {
      this.status = "connected";
      this.qrCode = null;
      logger.info("[WA] Client ready");
      try {
        await EodReportConfig.findOneAndUpdate(
          {},
          { waConnected: true },
          { upsert: true },
        );
      } catch (err) {
        logger.error("[WA] Failed to update DB on ready", { err });
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
      } catch (err) {
        logger.error("[WA] Failed to clear session in DB", { err });
      }
      this.notifyStatus("disconnected");
      this.client = null;
    });

    this.client.on("auth_failure", (msg: string) => {
      this.status = "failed";
      logger.error("[WA] Auth failure", { msg });
      this.notifyStatus("failed");
      this.client = null;
    });

    try {
      await this.client.initialize();
    } catch (err) {
      this.status = "failed";
      this.client = null;
      logger.error("[WA] Client initialize error", { err });
      throw err;
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

  async sendToAllRecipients(
    message: string,
  ): Promise<{ sent: number; failed: number; errors: string[] }> {
    const config = await EodReportConfig.findOne().lean();
    const recipients = (config?.recipients ?? []).filter((r) => r.active !== false);

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
        let to: string;
        if (r.type === "group") {
          to = r.groupId;
        } else {
          // Normalise to E.164 digits + @c.us
          let num = r.number.replace(/\D/g, "");
          if (num.startsWith("0")) num = "91" + num.slice(1);
          if (!num.startsWith("91") && num.length === 10) num = "91" + num;
          to = num + "@c.us";
        }
        await this.client!.sendMessage(to, message);
        sent++;
      } catch (err: any) {
        failed++;
        errors.push(`[${r.name}] ${err?.message ?? "Send failed"}`);
        logger.error("[WA] Failed to send to recipient", { name: r.name, err });
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
      try {
        await this.client.destroy();
      } catch {
        // ignore destroy errors
      }
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
    } catch (err) {
      logger.error("[WA] Failed to clear session on disconnect", { err });
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
