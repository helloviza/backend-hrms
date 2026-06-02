/**
 * Dry-run the Sales Pulse report WITHOUT sending anything.
 *
 * Connects to Mongo, computes the snapshot, writes the snapshot JSON + the
 * rendered HTML to apps/backend/tmp/, and ATTEMPTS a PNG render via the render
 * Lambda (writing the PNG if it succeeds). Never sends to WhatsApp, never
 * enables the cron, never touches config status.
 *
 * Run: pnpm -C apps/backend tsx src/scripts/dryRunSalesPulse.ts
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import { computeSalesPulseSnapshot } from "../services/crmSalesPulseSnapshot.js";
import { buildSalesPulseHtml } from "../services/crmSalesPulseTemplate.js";
import { renderSalesPulseImage } from "../services/crmSalesPulseRenderer.js";

async function main() {
  const outDir = resolve(process.cwd(), "tmp");
  mkdirSync(outDir, { recursive: true });

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    logger.error("[dryRunSalesPulse] MONGO_URI not set");
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  logger.info("[dryRunSalesPulse] Mongo connected");

  // Compute snapshot (config defaults are DISABLED; compute ignores enabled).
  const snapshot = await computeSalesPulseSnapshot();
  const jsonPath = resolve(outDir, "sales-pulse-snapshot.json");
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), "utf8");
  logger.info(`[dryRunSalesPulse] Snapshot JSON → ${jsonPath}`);

  const html = buildSalesPulseHtml(snapshot);
  const htmlPath = resolve(outDir, "sales-pulse-report.html");
  writeFileSync(htmlPath, html, "utf8");
  logger.info(`[dryRunSalesPulse] HTML → ${htmlPath}`);

  // Console summary so numbers are visible without opening the JSON.
  console.log("\n══════════ SALES PULSE DRY-RUN SUMMARY ══════════");
  console.log(`Date:    ${snapshot.dateLabel}`);
  console.log(`Window:  ${snapshot.windowLabel}  (fire slot: ${snapshot.fireSlotLabel})`);
  console.log("\nKPIs:");
  for (const k of snapshot.kpis) {
    const d = k.delta == null ? "" : ` (Δ ${k.delta >= 0 ? "+" : ""}${k.delta} vs prior)`;
    console.log(`  • ${k.label.padEnd(20)} ${String(k.value).padStart(5)}${d}`);
  }
  console.log("\nPipeline movement today:");
  for (const m of snapshot.movement) console.log(`  • ${m.label.padEnd(16)} ${m.count}`);
  console.log("\nLeaderboard (top reps):");
  for (const r of snapshot.leaderboard.reps.slice(0, 5)) {
    console.log(`  • ${r.ownerName.padEnd(22)} score ${r.score}  (${r.activities} act, ${r.status})`);
  }
  console.log(`\nTeam avg score: ${snapshot.leaderboard.teamAverage}`);
  console.log(`Conversion: ${snapshot.conversion.steps.map((s) => `${s.label} ${s.count}`).join(" → ")}`);
  console.log(`Estimated closure value: ${snapshot.insights.closureValueKnown ? snapshot.insights.estimatedClosureValue : "not captured (₹0 honest state)"}`);
  console.log("\nInsights:");
  for (const l of snapshot.insights.lines) console.log(`  • ${l}`);
  console.log("══════════════════════════════════════════════════\n");

  // Attempt PNG render (best-effort — needs Lambda + AWS access).
  try {
    const png = await renderSalesPulseImage(html);
    const pngPath = resolve(outDir, "sales-pulse-report.png");
    writeFileSync(pngPath, png);
    logger.info(`[dryRunSalesPulse] PNG (${png.length} bytes) → ${pngPath}`);
    console.log(`✅ PNG rendered: ${pngPath}`);
  } catch (err: any) {
    logger.warn("[dryRunSalesPulse] PNG render failed (Lambda/AWS unavailable locally?)", {
      message: err?.message,
    });
    console.log(`⚠️  PNG render unavailable locally: ${err?.message}`);
    console.log(`    HTML is still available for visual review: ${htmlPath}`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error("[dryRunSalesPulse] Fatal", { message: err?.message, stack: err?.stack });
  process.exit(1);
});
