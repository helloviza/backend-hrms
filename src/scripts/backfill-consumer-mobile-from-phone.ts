// apps/backend/src/scripts/backfill-consumer-mobile-from-phone.ts
//
// ONE-TIME: copy the signup number (Consumer.phone) onto the profile
// (ConsumerProfile.contact.mobile) for rows that predate the seed-on-creation
// hook in routes/consumer.profile.ts.
//
//   pnpm -C apps/backend tsx src/scripts/backfill-consumer-mobile-from-phone.ts
//   pnpm -C apps/backend tsx src/scripts/backfill-consumer-mobile-from-phone.ts --apply
//
// DRY RUN BY DEFAULT. Nothing is written without `--apply`.
//
// ── IS THIS WORTH RUNNING? ──────────────────────────────────────────────
// Probably not, and that is fine. Every environment that exists today holds
// test data only, and the live path (seedMobileFromSignup, called the moment
// a profile row is minted) makes every FUTURE signup correct without help.
// This exists for the case where that assumption turns out to be wrong —
// a real consumer who signed up before the fix and already has a profile row
// with an empty mobile. Such a row is invisible to the live hook, because the
// hook fires on INSERT and their insert already happened.
//
// ── WHY IT REUSES THE ROUTE'S FUNCTION ──────────────────────────────────
// seedMobileFromSignup is imported rather than reimplemented here. The rules
// it encodes — never overwrite, seed unverified, store normalised, skip a
// number that will not normalise, write through a hydrated .save() so the
// encryption plugin runs — are exactly the rules this pass needs, and a
// second copy of them is a second thing to keep in step.

import "../bootstrap/loadSecrets.js";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import Consumer from "../models/Consumer.js";
import ConsumerProfile from "../models/ConsumerProfile.js";
import { seedMobileFromSignup } from "../routes/consumer.profile.js";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  await mongoose.connect(env.MONGO_URI);
  console.log(
    `[backfill-mobile] ${APPLY ? "APPLY" : "DRY RUN"} — ${env.MONGO_URI} (db: ${mongoose.connection.name})`,
  );

  // Hydrated, NOT lean: seedMobileFromSignup saves the document it is given,
  // and a lean object has no .save(). It is also what decrypts contact.mobile
  // so the "already has one" check reads a number rather than an envelope.
  const profiles = await ConsumerProfile.find({});
  console.log(`[backfill-mobile] ${profiles.length} profile row(s) to consider`);

  let seeded = 0;
  let hadMobile = 0;
  let noUsablePhone = 0;

  for (const profile of profiles) {
    const consumerId = (profile as any).consumerId;
    const existing = String((profile as any).contact?.mobile ?? "").trim();

    if (existing) {
      hadMobile++;
      continue;
    }

    if (!APPLY) {
      // Mirror the function's own decision without writing, so the dry run
      // reports the same count the apply would produce.
      const consumer: any = await Consumer.findById(consumerId).select("phone email").lean();
      const digits = String(consumer?.phone ?? "").replace(/[^\d]/g, "");
      const usable = digits.length === 10 || (digits.length === 12 && digits.startsWith("91"));
      if (usable) {
        seeded++;
        console.log(`[backfill-mobile]   WOULD SEED ${consumer?.email} from ${consumer?.phone}`);
      } else {
        noUsablePhone++;
      }
      continue;
    }

    const didSeed = await seedMobileFromSignup(profile, consumerId);
    if (didSeed) {
      seeded++;
      console.log(`[backfill-mobile]   seeded ${String(consumerId)}`);
    } else {
      noUsablePhone++;
    }
  }

  console.log("");
  console.log(`[backfill-mobile] ${APPLY ? "seeded" : "would seed"}: ${seeded}`);
  console.log(`[backfill-mobile] skipped, already had a mobile: ${hadMobile}`);
  console.log(`[backfill-mobile] skipped, no usable Indian phone: ${noUsablePhone}`);
  if (!APPLY) console.log(`[backfill-mobile] DRY RUN — re-run with --apply to write.`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[backfill-mobile] FAILED:", err?.message ?? err);
  process.exit(1);
});
