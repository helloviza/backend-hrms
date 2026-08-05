// apps/backend/src/services/video/videoUrlIngest.service.ts
//
// URL front door for the video pipeline. YouTube ONLY — Instagram/TikTok were
// proven infeasible without cookie-auth (Instagram: "API is not granting
// access" even on public posts; TikTok: "Unexpected response from webpage
// request" — both fail consistently, not flakily). This module's only job is
// turning a YouTube URL into a local mp4 file; everything after that (S3
// upload, startVideoAnalysis, Whisper, OCR, insight extraction, consent) is
// the existing, unmodified pipeline.

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { ensureYtDlpBinary } from "./ytDlpProvision.js";

const execFileAsync = promisify(execFile);

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

/** Also doubles as the SSRF allowlist for the /from-url route. */
export function isSupportedYoutubeUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return YOUTUBE_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const MAX_DURATION_SEC = 10 * 60; // 10 minutes
export const MAX_FILESIZE_BYTES = 250 * 1024 * 1024; // 250 MB
const PROBE_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 20 * 1024 * 1024;

export class VideoUrlFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoUrlFetchError";
  }
}

export type YoutubeProbeResult = {
  title: string | null;
  durationSec: number | null;
  filesizeBytes: number | null;
};

function friendlyYtDlpError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes("private video")) return "That video is private.";
  if (s.includes("video unavailable")) return "That video is unavailable.";
  if (s.includes("sign in") || s.includes("age-restricted") || s.includes("age restricted")) {
    return "That video is age-restricted and can't be fetched without sign-in.";
  }
  if (s.includes("this live event") || s.includes("live stream")) return "Live streams aren't supported yet.";
  if (s.includes("copyright")) return "That video was blocked for copyright reasons.";
  return "Couldn't fetch that link — try uploading the video file instead.";
}

/**
 * PHASE 0: Probe only — no download. Used to reject oversized/overlong
 * videos BEFORE spending any download time/bandwidth.
 */
export async function probeYoutubeVideo(url: string): Promise<YoutubeProbeResult> {
  const bin = await ensureYtDlpBinary();

  try {
    const { stdout } = await execFileAsync(
      bin,
      ["--dump-single-json", "--skip-download", "--no-playlist", "--no-check-certificates", url],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );

    const info = JSON.parse(stdout);
    return {
      title: typeof info?.title === "string" ? info.title : null,
      durationSec: typeof info?.duration === "number" ? info.duration : null,
      filesizeBytes:
        typeof info?.filesize === "number"
          ? info.filesize
          : typeof info?.filesize_approx === "number"
            ? info.filesize_approx
            : null,
    };
  } catch (err: any) {
    if (err?.killed || err?.signal) {
      throw new VideoUrlFetchError("Couldn't fetch that link in time — try uploading the video file instead.");
    }
    throw new VideoUrlFetchError(friendlyYtDlpError(String(err?.stderr || err?.message || "")));
  }
}

/**
 * PHASE 1: Actual download, gated by a hard child-process timeout so a slow
 * or stalled fetch can't hold the async job open indefinitely. Downloads
 * into a fresh temp dir and returns the local file path; caller owns cleanup.
 */
export async function downloadYoutubeVideo(url: string): Promise<{ filePath: string; cleanup: () => void }> {
  const bin = await ensureYtDlpBinary();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-video-"));
  const outputTemplate = path.join(tmpDir, `${crypto.randomUUID()}.%(ext)s`);

  try {
    await execFileAsync(
      bin,
      [
        "--no-playlist",
        "--no-check-certificates",
        "-f",
        "mp4/best",
        "--max-filesize",
        `${MAX_FILESIZE_BYTES}`,
        "-o",
        outputTemplate,
        url,
      ],
      { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: MAX_BUFFER, killSignal: "SIGKILL" },
    );
  } catch (err: any) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}

    if (err?.killed || err?.signal) {
      throw new VideoUrlFetchError("That download took too long — try uploading the video file instead.");
    }
    throw new VideoUrlFetchError(friendlyYtDlpError(String(err?.stderr || err?.message || "")));
  }

  const files = fs.readdirSync(tmpDir);
  if (files.length === 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new VideoUrlFetchError("Couldn't fetch that link — try uploading the video file instead.");
  }

  const filePath = path.join(tmpDir, files[0]);
  return {
    filePath,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}
