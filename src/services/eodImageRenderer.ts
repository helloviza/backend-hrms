// apps/backend/src/services/eodImageRenderer.ts
//
// Renders an EOD-snapshot HTML document to a PNG buffer.
//
// As of 2026-05-27 this no longer launches Chromium in-process. App Runner's
// managed runtime lacks the NSS/GTK libs @sparticuz/chromium needs, so every
// in-process launch failed with `libnss3.so: cannot open shared object file`
// and the EOD report silently fell back to text. Rendering now goes through the
// deployed, voucher-agnostic render Lambda in PNG mode (the SAME Lambda the
// voucher PDF path uses). This is the UNCONDITIONAL path — there is no env flag.
// See infra/audit/eod-render-lambda-plan-2026-05-27.md.
//
// Resilience is unchanged: sendEodReport (eodSnapshot.ts) still wraps this in a
// try/catch and falls back to a text WhatsApp message if the Lambda render fails.

import { invokeRendererLambda } from "./voucherLambdaRenderer.js";
import logger from "../utils/logger.js";

// Mobile-portrait canvas at 2× device scale for crisp WhatsApp delivery — parity
// with the previous in-process puppeteer viewport. fullPage:true on the Lambda
// side lets the capture extend past this height for a long snapshot.
const EOD_VIEWPORT = { width: 720, height: 1500, dsf: 2 };

export async function renderEodImage(html: string): Promise<Buffer> {
  logger.info("[EOD-render] Rendering snapshot via render Lambda (png)");
  const png = await invokeRendererLambda(html, {
    format: "png",
    viewport: EOD_VIEWPORT,
  });
  logger.info("[EOD-render] Snapshot rendered", { bytes: png.length });
  return png;
}

/**
 * Graceful-shutdown hook — retained as a no-op so existing callers
 * (jobs/runEodOnce.ts, scripts/render-eod-from-db.ts) keep compiling. There is
 * no longer an in-process browser to close; the Lambda owns its own Chromium.
 */
export async function closeEodRendererBrowser(): Promise<void> {
  /* no-op — rendering is offloaded to the render Lambda */
}
