import { Schema, model, Types } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

/**
 * VideoAnalysis
 * --------------
 * Represents one uploaded video (influencer / ad / reel)
 * and its AI-derived travel intelligence.
 *
 * IMPORTANT:
 * - This model does NOT store itinerary output
 * - It ONLY stores observations & signals
 * - Copilot remains the planner
 */

const VideoAnalysisSchema = new Schema(
  {
    /* ───────── Ownership & Scope ───────── */
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    tenantId: {
      type: String,
      index: true, // legacy — kept for migration
    },

    userId: {
      type: Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    conversationId: {
      type: String,
      index: true,
      comment: "Pluto conversation this video is attached to",
    },

    /* ───────── Source Video ───────── */
    s3Key: {
      type: String,
      required: true,
      unique: true,
    },

    originalFileName: {
      type: String,
    },

    contentType: {
      type: String,
      default: "video/mp4",
    },

    durationSec: {
      type: Number,
    },

    /* ───────── Processing State ───────── */
    status: {
      type: String,
      enum: ["uploaded", "processing", "text_ready", "analyzed", "failed"],
      default: "uploaded",
      index: true,
    },

    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    error: {
      type: String,
    },

    /* ───────── AI Outputs (RAW) ───────── */
    transcript: {
      type: String,
    },

    onScreenText: {
  type: String,
  default: "",
},

userConsent: {
  type: String,
  enum: ["yes", "no", null],
  default: null,
},

    extractedText: {
  type: String,
  default: null,
},

/* ───────── Video Summary (TEXT ONLY) ───────── */
summary: {
  type: String,
},

summaryType: {
  type: String,
  enum: ["travel", "non-travel", "unclear"],
  default: "unclear",
},
    scenes: [
      {
        timestampSec: Number,
        description: String,
        tags: [String], // beach, city, hotel, activity, etc.
      },
    ],

    /* ───────── Video Classification (AUTHORITATIVE) ───────── */
classification: {
  type: String,
  enum: ["confirmed-travel", "ambiguous", "non-travel"],
  index: true,
  comment:
    "Authoritative classification of video intent. Controls planner eligibility.",
},

    /* ───────── AI Outputs (NORMALIZED SIGNALS) ───────── */
    insights: {
      tripStyle: {
        type: String, // Luxury, Adventure, Leisure, Budget, Honeymoon
      },

      pace: {
        type: String, // Relaxed | Balanced | Fast
      },

      idealDays: {
        type: Number,
      },

      destinations: [
        {
          city: String,
          country: String,
          confidence: Number, // 0–1
        },
      ],

      activities: [
        {
          type: String,
        },
      ],

      accommodationStyle: {
        type: String, // Resort, Boutique, Hotel, Homestay
      },

      bestFor: [
        {
          type: String, // Couples, Family, Solo, Friends
        },
      ],
    },

    /* ───────── Copilot Injection Snapshot ───────── */
    injectedContext: {
      type: Schema.Types.Mixed,
      comment:
        "Exact object injected into conversationContext.videoInsights",
    },
  },
  {
    timestamps: true,
  }
);

VideoAnalysisSchema.plugin(workspaceScopePlugin);

/* ───────── Indexes ───────── */
VideoAnalysisSchema.index({ workspaceId: 1, status: 1 });
VideoAnalysisSchema.index({ userId: 1, createdAt: -1 });
VideoAnalysisSchema.index({ tenantId: 1, status: 1 });
VideoAnalysisSchema.index({ conversationId: 1 });

export default model("VideoAnalysis", VideoAnalysisSchema);