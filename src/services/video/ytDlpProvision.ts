// apps/backend/src/services/video/ytDlpProvision.ts
//
// Provisions the yt-dlp static binary without apt-get / python — the same
// "download a prebuilt platform binary at install/build time" pattern that
// already gets ffmpeg onto the App Runner managed nodejs20 runtime.
//
// Deliberately NOT the `yt-dlp-exec` npm package: its `preinstall` script
// hard-requires a `python` binary on the INSTALL machine
// (`npx bin-version-check-cli python ">=2"`, no opt-out), which yt-dlp's
// actual standalone binary does not need at runtime. On a build host without
// python that preinstall step fails and `pnpm install --frozen-lockfile`
// (App Runner's build command) would break entirely. This module fetches the
// same GitHub release asset directly with Node built-ins only.

import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dist/services/video/ytDlpProvision.js -> apps/backend/bin
export const YT_DLP_BIN_DIR = path.resolve(__dirname, "../../../bin");

const BIN_NAME = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
export const YT_DLP_BIN_PATH = path.join(YT_DLP_BIN_DIR, BIN_NAME);

const RELEASE_ASSET_NAME =
  process.platform === "win32"
    ? "yt-dlp.exe"
    : process.platform === "darwin"
      ? "yt-dlp_macos"
      : "yt-dlp_linux";

function httpGet(url: string, redirectsLeft = 5): Promise<import("http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "plumtrips-hrms-yt-dlp-provision" } }, (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          resolve(httpGet(res.headers.location, redirectsLeft - 1));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`yt-dlp provisioning: HTTP ${status} for ${url}`));
          return;
        }
        resolve(res);
      })
      .on("error", reject);
  });
}

async function fetchJson(url: string): Promise<any> {
  const res = await httpGet(url);
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function downloadTo(url: string, destPath: string): Promise<void> {
  const res = await httpGet(url);
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.pipe(out);
    out.on("finish", () => out.close(() => resolve()));
    out.on("error", reject);
    res.on("error", reject);
  });
}

let ensurePromise: Promise<string> | null = null;

/**
 * Idempotent, memoized. Safe to call from a build script (provisions once)
 * and lazily at request time (self-heals if the build step didn't run / the
 * binary went missing) without ever re-downloading once present.
 */
export function ensureYtDlpBinary(): Promise<string> {
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    if (fs.existsSync(YT_DLP_BIN_PATH)) {
      return YT_DLP_BIN_PATH;
    }

    fs.mkdirSync(YT_DLP_BIN_DIR, { recursive: true });

    const release = await fetchJson("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest");
    const asset = (release?.assets || []).find((a: any) => a.name === RELEASE_ASSET_NAME);
    if (!asset) {
      throw new Error(`yt-dlp release asset not found for this platform: ${RELEASE_ASSET_NAME}`);
    }

    const tmpPath = `${YT_DLP_BIN_PATH}.download`;
    await downloadTo(asset.browser_download_url, tmpPath);
    fs.renameSync(tmpPath, YT_DLP_BIN_PATH);

    if (process.platform !== "win32") {
      fs.chmodSync(YT_DLP_BIN_PATH, 0o755);
    }

    return YT_DLP_BIN_PATH;
  })().catch((err) => {
    // Don't poison future calls with a rejected memo — let the next caller retry.
    ensurePromise = null;
    throw err;
  });

  return ensurePromise;
}

// `node dist/services/video/ytDlpProvision.js` — invoked as a build step
// (apps/backend/package.json `build` script). Non-fatal: a failed
// provisioning attempt here must not break the rest of the deploy. The
// route degrades to an explicit "temporarily unavailable" error at request
// time (via the same ensureYtDlpBinary(), retried lazily) rather than the
// whole app failing to ship because YouTube intake couldn't provision.
const isMainModule = process.argv[1] && process.argv[1].endsWith("ytDlpProvision.js");
if (isMainModule) {
  ensureYtDlpBinary()
    .then((p) => console.log("[ytDlpProvision] yt-dlp ready at", p))
    .catch((err) => {
      console.warn(
        "[ytDlpProvision] provisioning failed at build time (non-fatal — YouTube URL intake will error until this resolves):",
        err?.message || err,
      );
    });
}
