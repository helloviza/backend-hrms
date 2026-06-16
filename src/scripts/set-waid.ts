// apps/backend/src/scripts/set-waid.ts
import { connectDb } from "../config/db.js";
import User from "../models/User.js";

/**
 * Map a WhatsApp sender id to an existing User so the Expense Capture worker can
 * resolve inbound receipts (ExpenseCapture.waId -> User). The waId is stored
 * digits-only (country code + number, no "+"), matching Meta's `from` / `wa_id`.
 *
 * Usage:  pnpm tsx src/scripts/set-waid.ts <userEmail> <whatsappNumber>
 * Example: pnpm tsx src/scripts/set-waid.ts "e1@plumtrips.com" "+91 98765 43210"
 */
async function main() {
  const email = process.argv[2];
  const rawWaId = process.argv[3];

  if (!email || !rawWaId) {
    console.log("Usage: pnpm tsx src/scripts/set-waid.ts <userEmail> <whatsappNumber>");
    console.log('Example: pnpm tsx src/scripts/set-waid.ts "e1@plumtrips.com" "+91 98765 43210"');
    process.exit(1);
  }

  const digits = String(rawWaId).replace(/[^0-9]/g, "");
  if (!digits) {
    console.error("❌ No digits found in the provided WhatsApp number.");
    process.exit(1);
  }

  await connectDb();
  console.log("✅ Connected to MongoDB");

  const user = await User.findOne({ email });
  if (!user) {
    console.error(`❌ User not found: ${email}`);
    process.exit(1);
  }

  // Guard against assigning the same waId to two different users (the index is
  // sparse, not unique, so we enforce uniqueness here for clear operator feedback).
  const clash = await User.findOne({ waId: digits, _id: { $ne: user._id } }).lean();
  if (clash) {
    console.error(`❌ waId ${digits} is already mapped to ${(clash as any).email}. Aborting.`);
    process.exit(1);
  }

  const doc: any = user;
  doc.waId = digits; // model setter also normalizes to digits-only
  await doc.save();

  console.log("✔ waId assigned:", {
    user: { email: doc.email, id: doc._id.toString() },
    waId: doc.waId,
  });

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
