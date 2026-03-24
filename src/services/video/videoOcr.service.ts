// apps/backend/src/services/video/videoOcr.service.ts

import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { pipeline } from "stream/promises";

import {
  S3Client,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

import VideoAnalysis from "../../models/VideoAnalysis.js";

const execAsync = promisify(exec);

/**
 * AWS S3 client
 * Credentials are resolved automatically from env / IAM
 */
const s3 = new S3Client({
  region: process.env.AWS_REGION,
});

/**
 * PHASE 1(B): Frames → OCR → onScreenText
 * -------------------------------------
 * Runs ONLY when transcript is empty.
 * Best-effort, non-blocking, safe.
 * NEVER fails the video pipeline.
 */
export async function ingestVideoOcr(videoAnalysisId: string) {
  const record = await VideoAnalysis.findById(videoAnalysisId);
  if (!record) {
    throw new Error("VideoAnalysis not found");
  }

  // 🔒 OCR runs ONLY if transcript is empty
  if (record.transcript && record.transcript.trim() !== "") {
    return "";
  }

  /**
   * Temp directories
   */
  const tmpVideoDir = path.resolve(
    process.cwd(),
    "tmp",
    "video-input"
  );

  const framesDir = path.resolve(
    process.cwd(),
    "tmp",
    "video-ocr",
    record.id.toString()
  );

  const tmpVideoPath = path.join(
    tmpVideoDir,
    `${record.id}.mp4`
  );

  try {
    fs.mkdirSync(tmpVideoDir, { recursive: true });
    fs.mkdirSync(framesDir, { recursive: true });

    /**
     * STEP 1: Download video from S3 → temp local file
     */
    const s3Object = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: record.s3Key,
      })
    );

    if (!s3Object.Body) {
      throw new Error("Empty S3 video stream");
    }

    await pipeline(
      s3Object.Body as any,
      fs.createWriteStream(tmpVideoPath)
    );

    /**
     * STEP 2: Extract frames (1 fps, max 30 seconds)
     */
    await execAsync(
      `ffmpeg -y -i "${tmpVideoPath}" -vf fps=1 -t 30 "${framesDir}/frame_%03d.png"`
    );

    /**
     * STEP 3: OCR each frame using Tesseract
     */
    const files = fs
      .readdirSync(framesDir)
      .filter((f) => f.endsWith(".png"));

    let collectedText: string[] = [];

    for (const file of files) {
      try {
        const framePath = path.join(framesDir, file);
        const { stdout } = await execAsync(
          `tesseract "${framePath}" stdout -l eng`
        );

        if (stdout) {
          collectedText.push(stdout);
        }
      } catch {
        // OCR failure on a single frame is acceptable
        continue;
      }
    }

    /**
     * STEP 4: Normalize OCR text
     */
    const normalized = collectedText
      .join("\n")
      .toLowerCase()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => l.length > 2)
      .filter((l) => !l.startsWith("@")) // remove watermarks
      .filter((l) => !/^\d+$/.test(l))   // remove pure numbers
      .filter((l) => !/[^\w\s]/.test(l) || l.length > 4);

    const onScreenText = Array.from(new Set(normalized)).join(" ");

    /**
     * STEP 5: Persist OCR result
     */
    record.onScreenText = onScreenText;
    record.progress = Math.max(record.progress || 0, 40);
    await record.save();

    /**
     * STEP 6: Cleanup temp files
     */
    try {
      fs.rmSync(framesDir, { recursive: true, force: true });
      fs.rmSync(tmpVideoPath, { force: true });
    } catch {}

    return onScreenText;
  } catch (err) {
    console.error("Video OCR failed:", err);

    /**
     * ABSOLUTE FAILSAFE
     * Pipeline must continue
     */
    try {
      fs.rmSync(framesDir, { recursive: true, force: true });
      fs.rmSync(tmpVideoPath, { force: true });
    } catch {}

    record.onScreenText = "";
    record.progress = Math.max(record.progress || 0, 40);
    await record.save();

    return "";
  }
}