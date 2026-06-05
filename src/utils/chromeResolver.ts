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
import fs from "fs";
import path from "path";

/**
 * Remove ONLY the Chromium singleton-lock artifacts left behind when a previous
 * Chrome process died without cleanup (e.g. an ECS task killed mid-run, or an
 * EBUSY/ENOTEMPTY churn under the EFS-mounted session dir). These stale locks
 * make a fresh puppeteer launch hang or throw EBUSY/ENOTEMPTY when whatsapp-web.js
 * reuses the LocalAuth user-data-dir.
 *
 * SAFETY: this NEVER touches the auth credential files written by LocalAuth
 * (IndexedDB / Local Storage / Cookies), and NEVER wipes the session dir — so it
 * does not force a re-QR on boot. It only deletes the known Chromium lock files
 * (SingletonLock, SingletonSocket, SingletonCookie, DevToolsActivePort) and any
 * `.nfs*` siblings (orphaned NFS/EFS delete-on-close stubs), scanning both the
 * session root and its `Default/` profile dir.
 *
 * Returns the list of paths actually removed so the caller can log them.
 */
export function cleanStaleChromeLocks(sessionDir: string): string[] {
  const LOCK_NAMES = new Set([
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "DevToolsActivePort",
  ]);

  const removed: string[] = [];
  // Chromium writes singleton locks at the user-data-dir root; some land under
  // the Default profile. Scan both, skip whatever doesn't exist yet.
  const dirsToScan = [sessionDir, path.join(sessionDir, "Default")];

  for (const dir of dirsToScan) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // dir absent (first boot / not yet created) — nothing to clean
    }
    for (const entry of entries) {
      const isLock = LOCK_NAMES.has(entry) || entry.startsWith(".nfs");
      if (!isLock) continue;
      const target = path.join(dir, entry);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        removed.push(target);
      } catch {
        // best-effort: a still-held lock will surface as a launch error, which
        // the initialize() timeout + ECS restart path handles.
      }
    }
  }

  return removed;
}

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

  // System-Chromium path — ACTIVE on the dedicated WhatsApp host (ECS Fargate
  // `plumtrips-eod-wa`), which sets EOD_USE_SYSTEM_CHROME=true. whatsapp-web.js
  // hangs on @sparticuz/chromium's headless-shell (Runtime.callFunctionOn
  // timeouts during Store injection), so the WA-host image (apps/backend/
  // Dockerfile) installs a real Chromium at /usr/bin/chromium and we point
  // puppeteer-core straight at it — the same approach that worked on the old EC2
  // host. CHROME_PATH overrides the default for other environments.
  if (process.env.EOD_USE_SYSTEM_CHROME === "true") {
    return {
      headless: true,
      args: baseArgs,
      executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
      protocolTimeout: PROTOCOL_TIMEOUT,
    };
  }

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
