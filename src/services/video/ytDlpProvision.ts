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
// same GitHub release asset directly with Node built-ins only — from a PINNED
// release tag, and only after the download's SHA256 matches the digest pinned
// below.

import fs from "fs";
import path from "path";
import https from "https";
import crypto from "crypto";
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

// Pinned release, NOT `releases/latest`. Two reasons: builds are reproducible
// (the same commit provisions the same binary next month), and the expected
// digests below are only meaningful against a fixed version. Bumping the
// version means bumping BOTH constants — take the new values from the release's
// own SHA2-256SUMS file:
//   https://github.com/yt-dlp/yt-dlp/releases/download/<TAG>/SHA2-256SUMS
export const YT_DLP_VERSION = "2026.07.04";

// From SHA2-256SUMS of the pinned release above.
const EXPECTED_SHA256: Record<string, string> = {
  "yt-dlp.exe": "52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8",
  "yt-dlp_linux": "6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae",
  "yt-dlp_macos": "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b",
};

const RELEASE_ASSET_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/${RELEASE_ASSET_NAME}`;

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

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
 *
 * The on-disk binary is verified against the pinned digest on every cold call,
 * not just freshly downloaded ones — so a truncated download from a previous
 * run, or a binary left over from an older pin, is re-fetched rather than
 * trusted. A download whose digest doesn't match is deleted and never moved
 * into place: unverified code does not reach the image.
 */
export function ensureYtDlpBinary(): Promise<string> {
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const expected = EXPECTED_SHA256[RELEASE_ASSET_NAME];
    if (!expected) {
      throw new Error(`yt-dlp provisioning: no pinned SHA256 for asset ${RELEASE_ASSET_NAME}`);
    }

    if (fs.existsSync(YT_DLP_BIN_PATH)) {
      const actual = await sha256File(YT_DLP_BIN_PATH);
      if (actual === expected) {
        return YT_DLP_BIN_PATH;
      }
      // Wrong version or a partial file from an earlier run — replace it.
      console.warn(
        `[ytDlpProvision] existing binary digest ${actual} != pinned ${expected} (${YT_DLP_VERSION}); re-downloading`,
      );
      fs.rmSync(YT_DLP_BIN_PATH, { force: true });
    }

    fs.mkdirSync(YT_DLP_BIN_DIR, { recursive: true });

    const tmpPath = `${YT_DLP_BIN_PATH}.download`;
    await downloadTo(RELEASE_ASSET_URL, tmpPath);

    const actual = await sha256File(tmpPath);
    if (actual !== expected) {
      fs.rmSync(tmpPath, { force: true });
      throw new Error(
        `yt-dlp provisioning: SHA256 mismatch for ${RELEASE_ASSET_NAME} @ ${YT_DLP_VERSION} — ` +
          `expected ${expected}, got ${actual}. Binary discarded.`,
      );
    }

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
