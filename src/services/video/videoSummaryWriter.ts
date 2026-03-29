// apps/backend/src/services/video/videoSummaryWriter.ts

import VideoAnalysis from "../../models/VideoAnalysis.js";
import { invokePluto } from "../../utils/plutoInvoke.js";

/**
 * VIDEO → TEXT → SUMMARY (WRITER ONLY)
 * -----------------------------------
 * HARD RULES:
 * - NO planning
 * - NO itinerary
 * - NO assumptions
 * - Summary must be grounded ONLY in extracted text
 */

export async function writeVideoSummary(videoAnalysisId: string) {
  const record = await VideoAnalysis.findOne({ _id: videoAnalysisId });
  if (!record) {
    throw new Error("VideoAnalysis record not found");
  }

  const extractedText = record.extractedText?.trim() || "";

  // 🛡️ If there is literally nothing to summarize
  if (!extractedText) {
    record.summary = "This video does not contain any spoken or readable text.";
    record.summaryType = "unclear";
    await record.save();

    return {
      ok: true,
      summaryType: "unclear",
    };
  }

  const summaryPrompt = `
You are an assistant that ONLY summarizes videos.

Rules:
- Use ONLY the provided text
- Do NOT infer destinations
- Do NOT plan trips
- Do NOT add information
- If this text is about travel, say so clearly
- If it is NOT about travel, explicitly say: "This is not a travel video"

Return STRICT JSON only:

{
  "summary": string,
  "summaryType": "travel" | "non-travel" | "unclear"
}

VIDEO TEXT:
${extractedText}
`;

  try {
const aiResult: any = await invokePluto(summaryPrompt);

const summary =
  typeof aiResult?.summary === "string"
    ? aiResult.summary
    : "Summary unavailable";

const summaryType =
  aiResult?.summaryType === "travel" ||
  aiResult?.summaryType === "non-travel"
    ? aiResult.summaryType
    : "unclear";

       record.summary = summary;
    record.summaryType = summaryType;

    await record.save();

    return {
      ok: true,
      summaryType,
    };
  } catch (err) {
    console.error("Video summary generation failed:", err);

    // 🛡️ Degrade safely
    record.summary =
      "The video was processed, but a reliable summary could not be generated.";
    record.summaryType = "unclear";

    await record.save();

    return {
      ok: true,
      degraded: true,
    };
  }
}