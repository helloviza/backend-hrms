// apps/backend/src/services/video/videoIngest.service.ts

import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import OpenAI from "openai";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import VideoAnalysis from "../../models/VideoAnalysis.js";

const execAsync = promisify(exec);

/**
 * OpenAI client (Whisper STT)
 * Uses existing OPENAI_API_KEY
 */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * AWS S3 client
 */
const s3 = new S3Client({
  region: process.env.AWS_REGION,
});

/**
 * PHASE 1(A): Audio → Speech-to-Text (Whisper)
 * --------------------------------------------
 * Authoritative, production-safe STT pipeline
 *
 * Guarantees:
 * - Downloads video from S3
 * - Extracts audio locally
 * - Whisper handles internet-style audio (Hindi, English, Hinglish, etc.)
 * - Always outputs English — regardless of source language
 * - Silent videos return empty transcript
 * - Pipeline NEVER hard-fails
 */
export async function ingestVideoTranscript(videoAnalysisId: string) {
  const record = await VideoAnalysis.findById(videoAnalysisId);
  if (!record) {
    throw new Error("VideoAnalysis not found");
  }

  const tmpDir = path.resolve(process.cwd(), "tmp", "video-stt", record.id);
  const videoPath = path.join(tmpDir, "input.mp4");
  const audioPath = path.join(tmpDir, "audio.wav");

  try {
    record.progress = Math.max(record.progress || 0, 10);
    await record.save();

    fs.mkdirSync(tmpDir, { recursive: true });

    /* ───────── STEP 1: Download video from S3 ───────── */
    try {
      const s3Response = await s3.send(
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET!,
          Key: record.s3Key,
        })
      );

      await new Promise<void>((resolve, reject) => {
        const writeStream = fs.createWriteStream(videoPath);
        (s3Response.Body as any)
          .pipe(writeStream)
          .on("finish", resolve)
          .on("error", reject);
      });
    } catch (err) {
      console.error("STT: Failed to download video from S3", err);
      record.transcript = "";
      record.progress = Math.max(record.progress || 0, 30);
      await record.save();
      return "";
    }

    /* ───────── STEP 2: Extract audio via ffmpeg ───────── */
    try {
      await execAsync(
        `ffmpeg -y -i "${videoPath}" -ac 1 -ar 16000 "${audioPath}"`
      );
    } catch {
      // No audio track or unreadable audio
      record.transcript = "";
      record.progress = Math.max(record.progress || 0, 30);
      await record.save();
      return "";
    }

    /* ───────── STEP 3: Whisper transcription ───────── */
    // ✅ FIX: Use `translate` task instead of default `transcribe`
    //
    // WHY: Whisper auto-detects language from audio. For Indian-accented
    // English or Hindi/Hinglish content, it was incorrectly detecting Hindi
    // and outputting a Hindi transcript. This caused the English keyword-based
    // classifier (classifyFromText) to score 0 → "non-travel" → blocked planning.
    //
    // `task: "translate"` ALWAYS outputs English regardless of source language:
    // - Hindi reel about Vietnam → English transcript
    // - Hindi reel about Goa    → English transcript
    // - English video about Switzerland → English transcript (no change)
    //
    // This is the correct universal fix for a multilingual travel platform.
    let transcript = "";

    try {
      // ✅ FIX: Use openai.audio.translations.create() — this is the CORRECT
      // SDK method for "always output English regardless of source language".
      //
      // transcriptions.create() = transcribe in source language (Hindi → Hindi)
      // translations.create()   = always translate to English (Hindi → English)
      //
      // The previous fix used task: "translate" on transcriptions.create() which
      // is silently ignored by the SDK — task param only works on the raw API,
      // not through the typed SDK wrapper.
      const response = await openai.audio.translations.create({
        file: fs.createReadStream(audioPath),
        model: "whisper-1",
      });

      transcript = response.text?.trim() || "";
    } catch (err) {
      console.error("Whisper STT failed:", err);
      transcript = "";
    }

    /* ───────── STEP 4: Persist transcript ───────── */
    record.transcript = transcript;
    record.progress = 30;
    await record.save();

    return transcript;
  } catch (err) {
    console.error("Video ingest (Whisper STT) failed:", err);

    record.transcript = "";
    record.progress = Math.max(record.progress || 0, 30);
    await record.save();

    return "";
  } finally {
    /* ───────── CLEANUP ───────── */
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}