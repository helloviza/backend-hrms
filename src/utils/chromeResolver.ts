// apps/backend/src/utils/chromeResolver.ts
//
// Resolves the Chromium executable path based on environment.
//
// Production (App Runner / Linux slim): uses @sparticuz/chromium — a self-contained
//   Chromium build with all required runtime libraries baked in. App Runner's managed
//   runtime separates build and run containers, so apt/yum-installed system libs from
//   the build phase do not survive to runtime; sparticuz sidesteps that entirely.
//
// Local dev (Windows / macOS / Linux desktop): uses native puppeteer's downloaded
//   Chrome — installed by the postinstall hook on dev installs.
//
// Switch is keyed off NODE_ENV. App Runner production deploys MUST set
// NODE_ENV=production for sparticuz to be used.

import type { LaunchOptions } from "puppeteer-core";

export async function getChromeLaunchOptions(): Promise<LaunchOptions> {
  const isProduction = process.env.NODE_ENV === "production";

  const baseArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ];

  // Generous protocol timeout for Fargate cold starts — Sparticuz Chromium
  // unpack + whatsapp-web.js Client.inject can exceed puppeteer's 30s default.
  const PROTOCOL_TIMEOUT = 180_000;

  if (isProduction) {
    const chromium = (await import("@sparticuz/chromium")).default;
    return {
      headless: true,
      args: [...chromium.args, ...baseArgs],
      executablePath: await chromium.executablePath(),
      protocolTimeout: PROTOCOL_TIMEOUT,
    };
  }

  // Local dev — native puppeteer is a devDependency, dynamic-imported so that
  // production builds (which don't install devDeps) never try to resolve it.
  const puppeteer = (await import("puppeteer")).default;
  return {
    headless: true,
    args: baseArgs,
    executablePath: puppeteer.executablePath(),
    protocolTimeout: PROTOCOL_TIMEOUT,
  };
}
