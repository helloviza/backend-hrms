// apps/backend/src/services/crmSalesPulseRenderer.ts
//
// RENDER layer — turns the Sales Pulse HTML into a single continuous PNG Buffer
// by reusing the SAME render Lambda image path the EOD report uses
// (services/eodImageRenderer → voucherLambdaRenderer, format:"png"). PNG mode
// captures fullPage, so the report renders as ONE tall image — not A4 pages.
//
// Viewport is identical to EOD's (720×1500 @2×): mobile-portrait canvas at 2×
// device scale for crisp WhatsApp delivery; fullPage on the Lambda side lets the
// capture extend past 1500px for the long snapshot. The template's content
// width is matched to this 720px viewport (see crmSalesPulseTemplate .sheet).
//
// Callers wrap this in try/catch (a render failure means no WhatsApp image to
// send — there is no text fallback for this report).

import { invokeRendererLambda } from "./voucherLambdaRenderer.js";
import logger from "../utils/logger.js";

const SALES_PULSE_VIEWPORT = { width: 720, height: 1500, dsf: 2 };

export async function renderSalesPulseImage(html: string): Promise<Buffer> {
  logger.info("[SalesPulse-render] Rendering report via render Lambda (png)");
  const png = await invokeRendererLambda(html, {
    format: "png",
    viewport: SALES_PULSE_VIEWPORT,
  });
  logger.info("[SalesPulse-render] Report rendered", { bytes: png.length });
  return png;
}
