// apps/backend/src/services/video/videoInsightExtractor.ts

import OpenAI from "openai";
import VideoAnalysis from "../../models/VideoAnalysis.js";

/**
 * Extract structured travel insights from a video
 * ------------------------------------------------
 * HARD RULES:
 * - NO itinerary generation
 * - NO booking logic
 * - NO Copilot calls
 * - OBSERVATION ONLY
 *
 * DESIGN GUARANTEE:
 * - Video analysis must NEVER hard-fail user flow
 * - Silent / no-text videos must still succeed
 *
 * ARCHITECTURE (TWO-PROMPT APPROACH):
 * Prompt 1: Dedicated classification — is this travel content? (JSON guaranteed)
 * Prompt 2: Insight extraction — destinations, style, pace, activities
 *
 * WHY TWO PROMPTS:
 * Previously used invokePluto() which returns PlutoReplyV1 (a travel reply object,
 * NOT raw JSON) so isTravelContent could never be extracted from it.
 * Fell back to hardcoded keyword list → missed Vishakhapatnam, Hampi, etc.
 * Now uses direct OpenAI chat calls with response_format: json_object.
 */

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function extractVideoInsights(videoAnalysisId: string) {
  const record = await VideoAnalysis.findOne({ _id: videoAnalysisId });
  if (!record) {
    throw new Error("VideoAnalysis record not found");
  }

  try {
    /* ───────── STEP 0: Mark processing ───────── */
    record.status = "processing";
    record.progress = 5;
    await record.save();

    /* ───────── STEP 1: Collect perception inputs ───────── */
    const transcript = record.transcript || "";
    const onScreenText = record.onScreenText || "";
    const sceneDescriptions =
      record.scenes?.map((s) => s.description).join("\n") || "";
    const rawText = [transcript, onScreenText].join("\n").trim();

    record.progress = 20;
    await record.save();

    /* ───────── STEP 2: DEDICATED CLASSIFICATION CALL ───────── */
    // ✅ Uses gpt-4o-mini with response_format: json_object
    // Guarantees parseable JSON — no hardcoded city lists needed
    // Works for ANY destination worldwide
    let isTravelContent = false;
    let classificationConfidence = 0;

    if (rawText) {
      try {
        const classifyResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          temperature: 0,
          messages: [
            {
              role: "system",
              content: `You are a travel content classifier.
Analyze the transcript and determine if it is travel-related content.

Travel content includes ANY of:
- Destination or city guides
- Travel reels, vlogs, or shorts
- Hotel or accommodation reviews
- Tourist spots, beaches, temples, heritage sites
- Travel tips or itinerary suggestions
- Adventure activities at a location
- Food or cafe content tied to a destination

Respond ONLY with this exact JSON:
{
  "isTravelContent": true or false,
  "confidence": 0.0 to 1.0,
  "reason": "one sentence explanation"
}`,
            },
            {
              role: "user",
              content: `Classify this transcript:\n\n${rawText.slice(0, 3000)}`,
            },
          ],
        });

        const raw = classifyResponse.choices[0]?.message?.content || "{}";
        const parsed = JSON.parse(raw);
        isTravelContent = parsed.isTravelContent === true;
        classificationConfidence =
          typeof parsed.confidence === "number" ? parsed.confidence : 0;

        console.log(
          `[VideoClassifier] isTravelContent=${isTravelContent} confidence=${classificationConfidence} reason=${parsed.reason}`
        );
      } catch (err) {
        console.error("Classification call failed — defaulting to travel-safe:", err);
        // ✅ SAFE DEFAULT: If the AI call itself fails, assume travel
        // Better to let a non-travel video through than block a real travel video
        isTravelContent = true;
        classificationConfidence = 0.5;
      }
    }

    record.progress = 40;
    await record.save();

    /* ───────── STEP 3: Early exit for non-travel ───────── */
    if (!isTravelContent) {
      record.classification = "non-travel";
      record.summaryType = "non-travel";
      record.status = "analyzed";
      record.progress = 100;
      record.injectedContext = {
        source: "video",
        confidence: classificationConfidence,
        degraded: true,
        note: "AI classifier determined this is not travel content",
      };
      await record.save();

      return {
        ok: true,
        videoId: record._id,
        insights: {},
        degraded: true,
      };
    }

    /* ───────── STEP 4: INSIGHT EXTRACTION (travel confirmed) ───────── */
    let insights: any = {
      tripStyle: null,
      pace: null,
      idealDays: null,
      destinations: [],
      activities: [],
      accommodationStyle: null,
      bestFor: [],
    };

    let degraded = false;

    if (rawText) {
      try {
        const insightResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          temperature: 0,
          messages: [
            {
              role: "system",
              content: `You are a travel insight extractor.
Extract structured travel signals from the given transcript.

RULES:
- OBSERVE only — do NOT plan itineraries or suggest bookings
- Confidence must be 0.0 to 1.0
- Use null if uncertain
- Keep activities generic (e.g. "Beach", "Temple visit", "Cafe hopping", "Scuba diving")

Return ONLY this exact JSON:
{
  "tripStyle": "Leisure" | "Adventure" | "Luxury" | "Budget" | "Cultural" | null,
  "pace": "Relaxed" | "Balanced" | "Fast" | null,
  "idealDays": number | null,
  "destinations": [
    { "city": string | null, "country": string | null, "confidence": number }
  ],
  "activities": string[],
  "accommodationStyle": string | null,
  "bestFor": string[]
}`,
            },
            {
              role: "user",
              content: `Extract travel insights:\n\nTRANSCRIPT:\n${rawText.slice(0, 3000)}\n\nSCENES:\n${sceneDescriptions.slice(0, 500)}`,
            },
          ],
        });

        const raw = insightResponse.choices[0]?.message?.content || "{}";
        insights = JSON.parse(raw);
      } catch (err) {
        console.error("Insight extraction failed:", err);
        degraded = true;
      }
    } else {
      degraded = true;
    }

    /* ───────── STEP 5: Persist insights ───────── */
    record.insights = {
      tripStyle: insights.tripStyle ?? null,
      pace: insights.pace ?? null,
      idealDays: insights.idealDays ?? null,
      activities: Array.isArray(insights.activities) ? insights.activities : [],
      accommodationStyle: insights.accommodationStyle ?? null,
      bestFor: Array.isArray(insights.bestFor) ? insights.bestFor : [],
    } as any;

    if (Array.isArray(insights.destinations) && insights.destinations.length > 0) {
      (record.insights as any).destinations = insights.destinations;
    }

    /* ───────── STEP 6: Final classification + summaryType ───────── */
    const hasStrongDestination =
      Array.isArray(insights.destinations) &&
      insights.destinations.some(
        (d: any) => typeof d.confidence === "number" && d.confidence >= 0.7
      );

    record.classification = hasStrongDestination
      ? "confirmed-travel"
      : "ambiguous";

    // ✅ CRITICAL: Always set summaryType — this is what the backend gate checks
    // Old code never set this, leaving it as "unclear" → blocked all planning
    record.summaryType = "travel";

    /* ───────── STEP 7: Injected context ───────── */
    record.injectedContext = {
      source: "video",
      tripStyle: insights.tripStyle ?? null,
      pace: insights.pace ?? null,
      idealDays: insights.idealDays ?? null,
      activities: Array.isArray(insights.activities) ? insights.activities : [],
      accommodationStyle: insights.accommodationStyle ?? null,
      bestFor: Array.isArray(insights.bestFor) ? insights.bestFor : [],
      confidence: classificationConfidence,
      degraded,
    };

    if (Array.isArray(insights.destinations) && insights.destinations.length > 0) {
      (record.injectedContext as any).destinations = insights.destinations;
    }

    record.status = "analyzed";
    record.progress = 100;
    record.error = null;

    await record.save();

    return {
      ok: true,
      videoId: record._id,
      insights,
      degraded,
    };
  } catch (err: any) {
    /* ───────── ABSOLUTE FAILSAFE ───────── */
    console.error("extractVideoInsights failed:", err);

    record.status = "analyzed";
    record.progress = 100;
    record.error = null;

    record.insights = {
      tripStyle: null,
      pace: null,
      idealDays: null,
      activities: [],
      accommodationStyle: null,
      bestFor: [],
    } as any;

    record.classification = "ambiguous";
    record.summaryType = "unclear";
    record.injectedContext = {
      source: "video",
      confidence: 0,
      degraded: true,
      note: "Video processed without usable text signals",
    };

    await record.save();

    return {
      ok: true,
      videoId: record._id,
      insights: record.insights,
      degraded: true,
    };
  }
}

/* ─────────────────────────────────────────────────────────────
 * EMERGENCY FALLBACK ONLY — no longer used in primary flow
 * Kept in case AI calls are unavailable
 * ──────────────────────────────────────────────────────────── */
function classifyFromText(text: string): {
  classification: "confirmed-travel" | "ambiguous" | "non-travel";
  confidence: number;
} {
  if (!text || !text.trim()) {
    return { classification: "non-travel", confidence: 0 };
  }

  const lower = text.toLowerCase();
  const travelVerbs =
    lower.match(
      /\b(travel|trip|vacation|holiday|flight|hotel|resort|tour|explore|itinerary|beach|temple|destination|visit|city|coast|mountain|trek|cruise|camp|waterfall)\b/g
    ) || [];
  const durationHits =
    lower.match(/\b(\d+\s?(day|days|night|nights))\b/g) || [];

  let score = 0;
  if (travelVerbs.length >= 3) score += 0.5;
  else if (travelVerbs.length >= 1) score += 0.3;
  if (durationHits.length > 0) score += 0.2;

  if (score >= 0.5) return { classification: "confirmed-travel", confidence: score };
  if (score >= 0.2) return { classification: "ambiguous", confidence: score };
  return { classification: "non-travel", confidence: score };
}