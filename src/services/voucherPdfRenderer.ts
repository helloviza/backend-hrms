// apps/backend/src/services/voucherPdfRenderer.ts
//
// Phase 2b — renders a shared HTML voucher template (generateTicketHTML /
// generateHotelVoucherHTML from @plumtrips/shared) to an A4 PDF Buffer.
//
// This is the in-process Puppeteer renderer that Phase 2c will wire into the
// voucher-extract flow in place of the pdfkit `generateTravelPDF` path. It does
// NOT touch that flow yet — it only provides renderHtmlToPdf().
//
// Design notes:
//   - Reuses getChromeLaunchOptions() — the SINGLE Chromium launch-options
//     resolver shared with eodImageRenderer / whatsappService. We do NOT add a
//     second launch mechanism.
//   - Owns a DEDICATED browser singleton (mirrors eodImageRenderer's getBrowser
//     pattern). It must not share a browser instance with eodImageRenderer or
//     whatsapp-web.js — concurrent page/session use across features causes
//     protocol conflicts.
//   - Pages are SERIALIZED through a mutex: PDF rendering pulls Google Fonts +
//     the S3 logo per page, and a cold @sparticuz/chromium unpack is heavy, so
//     we render one voucher at a time to keep the singleton stable.

import puppeteer, { type Browser } from "puppeteer-core";
import { getChromeLaunchOptions } from "../utils/chromeResolver.js";
import logger from "../utils/logger.js";

let browserPromise: Promise<Browser> | null = null;

// Serialize page work — one render at a time against the shared browser.
let renderChain: Promise<unknown> = Promise.resolve();

/**
 * Hard ceiling on setContent + page.pdf so a stalled asset can't hang the
 * request forever. Generous to survive a cold sparticuz unpack on App Runner.
 */
const PAGE_TIMEOUT_MS = 60_000;
/** Cap on document.fonts.ready so a never-resolving font load can't wedge us. */
const FONTS_READY_TIMEOUT_MS = 8_000;
/** Cap on the logo/image-decoded wait so a missing S3 asset degrades, not hangs. */
const IMAGES_READY_TIMEOUT_MS = 8_000;

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const b = await browserPromise;
    if (b.connected) return b;
    // Browser disconnected — discard and relaunch.
    browserPromise = null;
  }

  try {
    const launchOpts = await getChromeLaunchOptions();
    logger.info("[voucher-pdf] Launching Puppeteer browser", {
      executablePath: launchOpts.executablePath,
      env: process.env.NODE_ENV || "development",
    });

    browserPromise = puppeteer.launch(launchOpts) as Promise<Browser>;
    const browser = await browserPromise;
    logger.info("[voucher-pdf] Puppeteer browser launched successfully");
    browser.on("disconnected", () => {
      logger.warn("[voucher-pdf] Puppeteer browser disconnected");
      browserPromise = null;
    });
    return browser;
  } catch (err: any) {
    browserPromise = null;
    logger.error("[voucher-pdf] Puppeteer launch failed", {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      cause: err?.cause,
      env: process.env.NODE_ENV,
    });
    throw err;
  }
}

async function renderOne(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // A4 portrait at 96dpi (794×1123) so layout settles to print dimensions
    // before paint; page.pdf() re-lays at the format below regardless.
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });

    // 'load' fires once every sub-resource — the S3 logo <img> and the linked
    // Google-Fonts stylesheet included — has finished loading. We use 'load'
    // (not 'networkidle0') because puppeteer-core types only admit
    // 'load' | 'domcontentloaded' for setContent's waitUntil. We restore the
    // anti-flash guarantee with the explicit asset waits below.
    await page.setContent(html, {
      waitUntil: "load",
      timeout: PAGE_TIMEOUT_MS,
    });

    // Explicitly confirm every <img> — notably the remote S3 logo — has decoded
    // before we capture, so the PDF can never show a blank logo. `complete` is
    // also true for a failed load, so we require naturalWidth > 0 to mean
    // success; a missing/slow asset just times out and we proceed (degrade, not
    // hang). polling on rAF keeps the check cheap.
    await page
      .waitForFunction(
        () =>
          Array.from((globalThis as any).document.images).every(
            (img: any) => img.complete && img.naturalWidth > 0,
          ),
        { timeout: IMAGES_READY_TIMEOUT_MS, polling: "raf" },
      )
      .catch(() => {
        /* an image asset failed/timed out — proceed; 'load' gave best effort */
      });

    // Belt-and-braces: even after load, font face application can lag a frame.
    // Wait for the font set to be ready, but don't let it hang us.
    await page
      .evaluate(
        (ms: number) =>
          Promise.race([
            (globalThis as any).document?.fonts?.ready ?? Promise.resolve(),
            new Promise((r) => setTimeout(r, ms)),
          ]),
        FONTS_READY_TIMEOUT_MS,
      )
      .catch(() => {
        /* fonts.ready unsupported / timed out — proceed with system fallback */
      });

    // CSS page breaks (the return-leg page uses `page-break-before:always`) are
    // honored by Chromium automatically. We deliberately do NOT set
    // preferCSSPageSize — the templates declare no @page size, so the A4 format
    // below must win.
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      timeout: PAGE_TIMEOUT_MS,
    });

    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {
      /* ignore close errors */
    });
  }
}

/**
 * Render a full HTML document to an A4 PDF Buffer.
 *
 * Pass the output of generateTicketHTML / generateHotelVoucherHTML from
 * @plumtrips/shared. Calls are serialized against a shared browser singleton.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  // Chain onto the previous render so only one page is live at a time. We swap
  // renderChain before awaiting so concurrent callers queue in arrival order;
  // a rejected prior render must not poison the queue, hence the `.catch`.
  const result = renderChain.catch(() => undefined).then(() => renderOne(html));
  renderChain = result;
  return result;
}

/** Graceful shutdown hook (call on SIGTERM alongside closeEodRendererBrowser). */
export async function closeVoucherPdfBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch (err: any) {
    logger.warn("[voucher-pdf] Browser close error", {
      message: err?.message,
      stack: err?.stack,
      name: err?.name,
      cause: err?.cause,
    });
  } finally {
    browserPromise = null;
  }
}
