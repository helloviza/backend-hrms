// apps/backend/src/scripts/fixSummaryType.ts
// ─────────────────────────────────────────────
// ONE-TIME migration: fix videos stuck with summaryType="unclear"
// that are actually travel content.
//
// Run with:
//   npx ts-node -e "import('./src/scripts/fixSummaryType.js').then(m => m.runFix())"
// OR add a temporary admin route to trigger this.
// ─────────────────────────────────────────────

import mongoose from "mongoose";
import VideoAnalysis from "../models/VideoAnalysis.js";

export async function runFix() {
  await mongoose.connect(process.env.MONGODB_URI!);
  console.log("Connected to MongoDB");

  // Find all videos that are analyzed but have summaryType = "unclear"
  // AND classification = "confirmed-travel" or "ambiguous"
  // These are the ones broken by the old code
  const broken = await VideoAnalysis.find({
    status: "analyzed",
    summaryType: "unclear",
    classification: { $in: ["confirmed-travel", "ambiguous"] },
  });

  console.log(`Found ${broken.length} broken records to fix`);

  for (const video of broken) {
    const oldSummaryType = video.summaryType;

    // If classification says travel → set summaryType to travel
    if (video.classification === "confirmed-travel" || video.classification === "ambiguous") {
      video.summaryType = "travel";
      await video.save();
      console.log(`Fixed video ${video._id}: summaryType ${oldSummaryType} → travel`);
    }
  }

  // Also fix videos with no classification set but have travel insights
  const unclassified = await VideoAnalysis.find({
    status: "analyzed",
    summaryType: "unclear",
    classification: { $exists: false },
    "insights.destinations.0": { $exists: true }, // has at least one destination
  });

  console.log(`Found ${unclassified.length} unclassified records with destinations`);

  for (const video of unclassified) {
    video.summaryType = "travel";
    video.classification = "confirmed-travel";
    await video.save();
    console.log(`Fixed unclassified video ${video._id} → confirmed-travel`);
  }

  console.log("✅ Migration complete");
  await mongoose.disconnect();
}