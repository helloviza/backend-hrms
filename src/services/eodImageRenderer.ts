// apps/backend/src/services/eodImageRenderer.ts
//
// Renders an EOD-snapshot HTML document to a PNG buffer.
//
// Uses a DEDICATED puppeteer browser instance — do NOT share with
// whatsappService.ts, which manages its own internal browser via
// whatsapp-web.js. Sharing causes session/page conflicts.

import puppeteer, { type Browser } from "puppeteer-core";
import { getChromeLaunchOptions } from "../utils/chromeResolver.js";
import logger from "../utils/logger.js";

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const b = await browserPromise;
    if (b.connected) return b;
    // Browser disconnected — discard and relaunch
    browserPromise = null;
  }

  try {
    const launchOpts = await getChromeLaunchOptions();
    logger.info("[EOD-render] Launching Puppeteer browser", {
      executablePath: launchOpts.executablePath,
      env: process.env.NODE_ENV || "development",
    });

    browserPromise = puppeteer.launch(launchOpts) as Promise<Browser>;
    const browser = await browserPromise;
    logger.info("[EOD-render] Puppeteer browser launched successfully");
    browser.on("disconnected", () => {
      logger.warn("[EOD-render] Puppeteer browser disconnected");
      browserPromise = null;
    });
    return browser;
  } catch (err: any) {
    browserPromise = null;
    logger.error("[EOD-render] Puppeteer launch failed", {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      cause: err?.cause,
      env: process.env.NODE_ENV,
    });
    throw err;
  }
}

export async function renderEodImage(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Mobile-portrait canvas at 2× device scale for crisp WhatsApp delivery.
    await page.setViewport({ width: 720, height: 1500, deviceScaleFactor: 2 });

    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });

    // Allow any CSS layout / SVG paint to settle
    await new Promise((r) => setTimeout(r, 250));

    const buffer = await page.screenshot({
      type: "png",
      fullPage: true,
      omitBackground: false,
    });

    return Buffer.from(buffer);
  } finally {
    await page.close().catch(() => {
      /* ignore close errors */
    });
  }
}

/** Graceful shutdown hook (call on SIGTERM). */
export async function closeEodRendererBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch (err: any) {
    logger.warn("[EOD-render] Browser close error", {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      cause: err?.cause,
    });
  } finally {
    browserPromise = null;
  }
}
