import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import Invoice from "../models/Invoice.js";
import Counter from "../models/Counter.js";

async function main() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(env.MONGO_URI);
  console.log("Connected.");

  const invoices = await Invoice.find({}, { invoiceNo: 1 }).lean();
  console.log(`Found ${invoices.length} existing invoices.`);

  // Parse each invoiceNo to find the max seq per FY
  // Format: INV-20260040 → fy=2026, seq=40
  const fyMax: Record<number, number> = {};
  for (const inv of invoices) {
    if (!inv.invoiceNo) continue;
    const m = inv.invoiceNo.match(/^INV-(\d{4})(\d{4})$/);
    if (!m) continue;
    const fy = parseInt(m[1]);
    const seq = parseInt(m[2]);
    if (fyMax[fy] == null || seq > fyMax[fy]) fyMax[fy] = seq;
  }

  if (!Object.keys(fyMax).length) {
    console.log("No parseable invoice numbers found — nothing to seed.");
    process.exit(0);
  }

  for (const [fy, maxSeq] of Object.entries(fyMax)) {
    const fyKey = `invoice:FY${fy}`;
    const result = await Counter.findByIdAndUpdate(
      fyKey,
      { $max: { seq: maxSeq } },
      { new: true, upsert: true },
    );
    console.log(`  ${fyKey} → seq set to ${result!.seq} (max invoice seq was ${maxSeq})`);
  }

  console.log("Done. Counter collection is ready.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
