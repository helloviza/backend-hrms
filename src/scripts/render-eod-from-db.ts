// apps/backend/src/scripts/render-eod-from-db.ts
//
// Render today's EOD snapshot to PNG using REAL production MongoDB data.
// Read-only: no WhatsApp send, no DB writes.
//
// Usage:
//   pnpm -C apps/backend tsx src/scripts/render-eod-from-db.ts
//   (or via the package.json "render:eod-real" script)

import "dotenv/config";
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";
import { computeEodSnapshot } from "../services/eodSnapshot.js";
import { buildEodHtml } from "../services/eodReportTemplate.js";
import {
  renderEodImage,
  closeEodRendererBrowser,
} from "../services/eodImageRenderer.js";

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("❌ MONGO_URI not set in .env");
    process.exit(1);
  }

  console.log("Connecting to MongoDB...");
  await mongoose.connect(mongoUri);
  console.log("✅ Connected");

  // Default sections — everything on except the failedBookings alert (which
  // is off by default per product decision; alerts visual is dropped from the
  // image regardless, but the toggle is still honoured by the text fallback).
  const defaultSections = {
    todaySnapshot: true,
    wtdSummary: true,
    mtdSummary: true,
    typeBreakdown: true,
    topPerformers: true,
    topClients: true,
    pipelineFollowups: true,
    alerts: {
      failedBookings: false,
      holdsExpiring: true,
      overdueInvoices: true,
    },
  };

  console.log("Computing snapshot from production data...");
  const snapshot = await computeEodSnapshot(defaultSections);
  console.log("✅ Snapshot computed\n");

  console.log(
    JSON.stringify(
      {
        dateLabel: snapshot.dateLabel,
        timeLabel: snapshot.timeLabel,
        today: snapshot.today,
        wtd: snapshot.wtd,
        mtd: snapshot.mtd,
        trend7d: snapshot.trend7d,
        breakdown: snapshot.breakdown,
        performers: snapshot.performers,
        clients: snapshot.clients,
        pipeline: snapshot.pipeline,
        alerts: snapshot.alerts,
      },
      null,
      2,
    ),
  );

  console.log("\nBuilding HTML...");
  const html = buildEodHtml(snapshot);

  const htmlPath = path.join(process.cwd(), "eod-real.html");
  fs.writeFileSync(htmlPath, html);
  console.log(`HTML written to ${htmlPath}`);

  console.log("\nRendering PNG...");
  const buffer = await renderEodImage(html);

  const pngPath = path.join(process.cwd(), "eod-real.png");
  fs.writeFileSync(pngPath, buffer);
  console.log(`✅ PNG written to ${pngPath} (${buffer.length} bytes)`);

  await closeEodRendererBrowser();
  await mongoose.disconnect();
  console.log("\nDone. Open eod-real.png to inspect.");
}

main().catch((err) => {
  console.error("❌ Render failed:", err);
  process.exit(1);
});
