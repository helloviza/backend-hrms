// apps/backend/src/services/voucherLambdaRenderer.ts
//
// L2 of the voucher-render Lambda migration — a thin backend client that
// invokes the deployed "plumtrips-voucher-pdf" Lambda to render a full HTML
// document to a PDF Buffer.
//
// The Lambda is a GENERIC html→pdf renderer. We invoke it RequestResponse with
// payload { html } and it returns the BARE object { pdfBase64 } on success or
// { error } on failure — there is no API Gateway envelope to unwrap.
//
// This file is intentionally inert this phase: L3 will gate the extract flow on
// VOUCHER_RENDER_VIA_LAMBDA to choose this path vs the in-process pdfkit path.
// generateAndStoreRenderedPdf is NOT changed here.
//
// AWS SDK v3 (@aws-sdk/client-lambda) — matches the backend's existing
// @aws-sdk/client-s3 usage in utils/s3Upload.ts (region + optional explicit
// credentials, IAM instance role in prod).

import {
  LambdaClient,
  InvokeCommand,
  type InvokeCommandOutput,
} from "@aws-sdk/client-lambda";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";

/** Lambda function name — override with VOUCHER_PDF_LAMBDA_NAME without a code change. */
export const VOUCHER_PDF_LAMBDA_NAME =
  process.env.VOUCHER_PDF_LAMBDA_NAME || "plumtrips-voucher-pdf";

/**
 * Feature flag for L3: choose the Lambda renderer over the in-process pdfkit
 * path. Default OFF — the extract flow stays exactly on pdfkit this phase and
 * L3 will be the only consumer of this constant. Truthy values: "1"/"true"/"yes".
 */
export const VOUCHER_RENDER_VIA_LAMBDA = /^(1|true|yes)$/i.test(
  (process.env.VOUCHER_RENDER_VIA_LAMBDA || "").trim(),
);

/**
 * Client-side ceiling on the round trip. The Lambda itself has its own timeout;
 * this guards against a wedged socket holding the request open. Generous to
 * survive a cold Lambda start (Chromium layer unpack).
 */
const INVOKE_TIMEOUT_MS = Number(
  process.env.VOUCHER_PDF_LAMBDA_TIMEOUT_MS || 120_000,
);

// One client for the process — region + optional explicit credentials mirror
// utils/s3Upload.ts. In production the App Runner instance role
// (PlumtripsAppRunnerAccess) carries lambda:InvokeFunction on the function ARN,
// so credentials resolve from the role and we pass `undefined` here.
const lambda = new LambdaClient({
  region: env.AWS_REGION,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

/** Shape the Lambda returns (bare object, no API Gateway envelope). */
type RendererResponse = { pdfBase64?: string; pngBase64?: string; error?: string };

/** Options for invokeRendererLambda. */
export interface RendererLambdaOptions {
  /** Output format. "pdf" (default) → vouchers; "png" → EOD WhatsApp image. */
  format?: "pdf" | "png";
  /** Render canvas. Omit to use the Lambda's per-format default (A4 for pdf,
   *  720×1500@2× for png). Only sent when format === "png". */
  viewport?: { width: number; height: number; dsf: number };
}

/**
 * Render a full HTML document to a Buffer by invoking the deployed
 * "plumtrips-voucher-pdf" Lambda.
 *
 * The Lambda is a generic html→{pdf|png} renderer. Pass:
 *   - format "pdf" (default): the output of generateTicketHTML /
 *     generateHotelVoucherHTML — a PDF Buffer comes back. Voucher callers send
 *     only `html`, so the payload + result are unchanged from before.
 *   - format "png": a full-page PNG Buffer (the EOD report image).
 *
 * Throws a clear Error if the Lambda reports a function error, returns an
 * { error } body, or returns no base64 for the requested format.
 *
 * Future option (not implemented yet): a small retry on throttling /
 * transient 5xx invoke errors. Single attempt for now.
 */
export async function invokeRendererLambda(
  html: string,
  opts: RendererLambdaOptions = {},
): Promise<Buffer> {
  if (!html || typeof html !== "string") {
    throw new Error("invokeRendererLambda: `html` must be a non-empty string");
  }

  const format = opts.format === "png" ? "png" : "pdf";
  const resultKey = format === "png" ? "pngBase64" : "pdfBase64";

  // For pdf keep the payload byte-identical to the original ({ html }) so the
  // proven voucher path is untouched; only png adds the extra fields.
  const payload =
    format === "png"
      ? { html, format: "png", ...(opts.viewport ? { viewport: opts.viewport } : {}) }
      : { html };

  const startedAt = Date.now();
  const command = new InvokeCommand({
    FunctionName: VOUCHER_PDF_LAMBDA_NAME,
    InvocationType: "RequestResponse",
    Payload: Buffer.from(JSON.stringify(payload)),
  });

  let out: InvokeCommandOutput;
  try {
    // Per-request abort acts as the client-side ceiling on the round trip
    // (the SDK's default socket timeouts are looser than we want here).
    out = await lambda.send(command, {
      abortSignal: AbortSignal.timeout(INVOKE_TIMEOUT_MS),
    });
  } catch (err: any) {
    logger.error("[voucher-lambda] Invoke transport error", {
      function: VOUCHER_PDF_LAMBDA_NAME,
      region: env.AWS_REGION,
      message: err?.message,
      name: err?.name,
    });
    throw new Error(
      `Lambda invoke failed for ${VOUCHER_PDF_LAMBDA_NAME}: ${err?.message || err}`,
    );
  }

  // FunctionError is set when the Lambda handler threw (Payload then holds the
  // error JSON, not our response). Surface it explicitly.
  const rawPayload = out.Payload
    ? Buffer.from(out.Payload).toString("utf8")
    : "";

  if (out.FunctionError) {
    logger.error("[voucher-lambda] Lambda reported FunctionError", {
      function: VOUCHER_PDF_LAMBDA_NAME,
      functionError: out.FunctionError,
      payload: rawPayload.slice(0, 1000),
    });
    throw new Error(
      `Lambda ${VOUCHER_PDF_LAMBDA_NAME} FunctionError (${out.FunctionError}): ${rawPayload.slice(0, 500)}`,
    );
  }

  let parsed: RendererResponse;
  try {
    parsed = JSON.parse(rawPayload) as RendererResponse;
  } catch {
    throw new Error(
      `Lambda ${VOUCHER_PDF_LAMBDA_NAME} returned non-JSON payload: ${rawPayload.slice(0, 500)}`,
    );
  }

  if (parsed?.error) {
    throw new Error(
      `Lambda ${VOUCHER_PDF_LAMBDA_NAME} render error: ${parsed.error}`,
    );
  }

  const b64 = parsed?.[resultKey];
  if (!b64) {
    throw new Error(
      `Lambda ${VOUCHER_PDF_LAMBDA_NAME} returned no ${resultKey} (keys: ${Object.keys(parsed || {}).join(",") || "none"})`,
    );
  }

  const buffer = Buffer.from(b64, "base64");
  logger.info("[voucher-lambda] Rendered via Lambda", {
    function: VOUCHER_PDF_LAMBDA_NAME,
    format,
    bytes: buffer.length,
    ms: Date.now() - startedAt,
  });
  return buffer;
}
