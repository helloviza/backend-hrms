// apps/backend/src/routes/copilot.videoConsent.ts

import { Router } from "express";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import VideoAnalysis from "../models/VideoAnalysis.js";

const router = Router();

/* ─────────────────────────────────────────────
 * Destination extraction (Option A – type safe)
 * ───────────────────────────────────────────── */

const AUTO_LOCK_THRESHOLD = 0.78;

/**
 * NOTE:
 * video.transcript is a STRING (not { text })
 * video has NO `ocr` field
 */
function extractDestinationFromTranscript(transcript?: string) {
  if (!transcript || transcript.length < 30) {
    return null;
  }

  const text = transcript.toLowerCase();

  // small, conservative list (can be expanded later via NER)
  const PLACES = [
    "goa",
    "kerala",
    "rajasthan",
    "vietnam",
    "thailand",
    "japan",
    "paris",
    "france",
    "italy",
    "bali",
    "singapore",
    "dubai",
  ];

  const hits: Record<string, number> = {};

  for (const place of PLACES) {
    const regex = new RegExp(`\\b${place}\\b`, "g");
    const count = (text.match(regex) || []).length;
    if (count > 0) {
      hits[place] = count;
    }
  }

  const ranked = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;

  const [top, second] = ranked;

  const mentionScore = Math.min(top[1] / 4, 0.6);
  const uniquenessScore =
    !second || top[1] >= second[1] * 2 ? 0.3 : 0;

  const confidence = Math.min(mentionScore + uniquenessScore, 1);

  if (confidence < AUTO_LOCK_THRESHOLD) {
    return null;
  }

  return {
    name: top[0][0].toUpperCase() + top[0].slice(1),
    confidence,
  };
}

/**
 * POST /api/v1/copilot/video/:id/consent
 * -------------------------------------
 * Phase 4: User consent gate
 */
router.post("/:id/consent", requireAuth, requireWorkspace, async (req, res) => {
  try {
    const { id } = req.params;
    const { consent } = req.body;

    if (!["yes", "no"].includes(consent)) {
      return res.status(400).json({
        ok: false,
        message: "Consent must be 'yes' or 'no'",
      });
    }

    const video = await scopedFindById(VideoAnalysis, id, req.workspaceId);
    if (!video) {
      return res.status(404).json({
        ok: false,
        message: "Video not found",
      });
    }

    // 🔒 Persist consent
    video.userConsent = consent;
    await video.save();

    /* ─────────────────────────────────────────────
     * CONSENT = YES → LOCK VIDEO INSIGHTS
     * ───────────────────────────────────────────── */
    if (consent === "yes") {
      const insights: any = video.injectedContext || video.insights || {};
      const locked: any = {};

      /* ───────── DESTINATION (Option A) ───────── */

      let destinationLocked = false;

      // 1️⃣ Prefer pre-extracted destinations
      if (
        Array.isArray(insights.destinations) &&
        insights.destinations.length > 0
      ) {
        const top = [...insights.destinations].sort(
          (a, b) => (b.confidence || 0) - (a.confidence || 0)
        )[0];

        if (
          (top?.city || top?.country) &&
          (top.confidence ?? 0) >= AUTO_LOCK_THRESHOLD
        ) {
          locked.destination = {
            name: [top.city, top.country].filter(Boolean).join(", "),
            source: "video",
            confidence: top.confidence ?? 0.9,
          };
          destinationLocked = true;
        }
      }

      // 2️⃣ Fallback: extract from transcript STRING
      if (!destinationLocked) {
        const extracted = extractDestinationFromTranscript(
          video.transcript
        );

        if (extracted) {
          locked.destination = {
            name: extracted.name,
            source: "video",
            confidence: extracted.confidence,
          };
        }
      }

      /* ───────── OTHER LOCKS (unchanged) ───────── */

      if (insights.tripStyle) {
        locked.tripStyle = {
          value: insights.tripStyle,
          source: "video",
        };
      }

      if (insights.pace) {
        locked.pace = {
          value: insights.pace,
          source: "video",
        };
      }

      if (typeof insights.idealDays === "number" && insights.idealDays > 0) {
        locked.duration = {
          days: insights.idealDays,
          source: "video",
        };
      }

      return res.json({
        ok: true,
        reply: {
          title: "Great — I’ll plan this trip for you",
          context: locked.destination
            ? `I’ll plan a trip to ${locked.destination.name} based on this video. You can now refine budget, dates, or preferences.`
            : "I’ll plan a trip inspired by this video. You can now refine budget, dates, or preferences.",
          nextSteps: [
            "Create a detailed itinerary",
            "Adjust budget or dates",
          ],
        },

        // 🔥 Merge into conversation memory
        contextPatch: {
          locked,
        },
      });
    }

    /* ─────────────────────────────────────────────
     * CONSENT = NO
     * ───────────────────────────────────────────── */
    return res.json({
      ok: true,
      reply: {
        title: "No problem",
        context:
          "I’ll keep this video as inspiration only. If you want to plan later, just tell me.",
        nextSteps: [],
      },
    });
  } catch (err: any) {
    console.error("Video consent failed:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to save consent",
    });
  }
});

export default router;