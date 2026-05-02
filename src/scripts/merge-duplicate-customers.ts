// apps/backend/src/scripts/merge-duplicate-customers.ts
//
// PARTS 1 & 2: Merge case-duplicate Customer records and backfill legalNameNormalized.
//
// Run with:
//   pnpm -C apps/backend exec tsx src/scripts/merge-duplicate-customers.ts
//
// Safe to run multiple times (idempotent — duplicate groups shrink each run).
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import Customer from "../models/Customer.js";
import ManualBooking from "../models/ManualBooking.js";
import Ticket from "../models/Ticket.js";
import TicketLead from "../models/TicketLead.js";
import CustomerMember from "../models/CustomerMember.js";

function normalizeName(s: string): string {
  return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function main() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(env.MONGO_URI);
  console.log("Connected.\n");

  // ── STEP 1: Find all case-duplicate groups ──────────────────────────
  const all = await Customer.find({})
    .select("_id legalName companyName name createdAt")
    .lean() as any[];

  const groups = new Map<string, any[]>();
  for (const c of all) {
    const raw = c.legalName || c.companyName || c.name || "";
    const key = normalizeName(raw);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  const dupGroups = [...groups.entries()].filter(([, docs]) => docs.length > 1);

  if (dupGroups.length === 0) {
    console.log("✅ No case-duplicate customers found.\n");
  } else {
    console.log(`Found ${dupGroups.length} duplicate group(s) to merge:\n`);

    for (const [normalized, docs] of dupGroups) {
      console.log(`--- Normalized: "${normalized}" (${docs.length} records) ---`);
      for (const d of docs) {
        const display = d.legalName || d.companyName || d.name;
        console.log(`  _id: ${d._id} | name: "${display}" | createdAt: ${d.createdAt}`);
      }

      // Booking counts to pick canonical
      const counts = await Promise.all(
        docs.map((d: any) => ManualBooking.countDocuments({ workspaceId: d._id })),
      );

      // Canonical = most bookings; ties broken by oldest createdAt
      let canonicalIdx = 0;
      for (let i = 1; i < docs.length; i++) {
        if (
          counts[i] > counts[canonicalIdx] ||
          (counts[i] === counts[canonicalIdx] &&
            new Date(docs[i].createdAt) < new Date(docs[canonicalIdx].createdAt))
        ) {
          canonicalIdx = i;
        }
      }

      const canonical = docs[canonicalIdx];
      const canonicalName = canonical.legalName || canonical.companyName || canonical.name;
      console.log(`  CANONICAL → ${canonical._id} ("${canonicalName}") with ${counts[canonicalIdx]} bookings`);

      for (let i = 0; i < docs.length; i++) {
        if (i === canonicalIdx) continue;
        const dup = docs[i];
        const dupName = dup.legalName || dup.companyName || dup.name;
        console.log(`  MERGING   → ${dup._id} ("${dupName}") into canonical`);

        const mbRes = await ManualBooking.updateMany(
          { workspaceId: dup._id },
          { $set: { workspaceId: canonical._id } },
        );
        console.log(`    manualbookings.workspaceId reassigned: ${mbRes.modifiedCount}`);

        const tkRes = await Ticket.updateMany(
          { workspaceId: dup._id },
          { $set: { workspaceId: canonical._id } },
        );
        console.log(`    tickets.workspaceId reassigned:        ${tkRes.modifiedCount}`);

        const tlRes = await TicketLead.updateMany(
          { linkedCustomerId: dup._id },
          { $set: { linkedCustomerId: canonical._id } },
        );
        console.log(`    ticketleads.linkedCustomerId reassigned: ${tlRes.modifiedCount}`);

        // customermembers.customerId is stored as a plain String
        const cmRes = await CustomerMember.updateMany(
          { customerId: String(dup._id) },
          { $set: { customerId: String(canonical._id) } },
        );
        console.log(`    customermembers.customerId reassigned:  ${cmRes.modifiedCount}`);

        await Customer.deleteOne({ _id: dup._id });
        console.log(`    Deleted duplicate Customer ${dup._id}`);
      }

      const finalBookings = await ManualBooking.countDocuments({ workspaceId: canonical._id });
      console.log(`  ✅ Canonical ${canonical._id} now has ${finalBookings} bookings\n`);
    }
  }

  // ── STEP 2: Backfill legalNameNormalized on ALL remaining customers ──
  console.log("Backfilling legalNameNormalized on all Customer records...");
  const remaining = await Customer.find({}).select("_id legalName companyName name").lean() as any[];
  let backfilled = 0;
  for (const c of remaining) {
    const raw = (c as any).legalName || (c as any).companyName || (c as any).name || "";
    const normalized = normalizeName(raw);
    await Customer.updateOne(
      { _id: (c as any)._id },
      { $set: { legalNameNormalized: normalized } },
    );
    backfilled++;
  }
  console.log(`✅ Backfilled ${backfilled} records.\n`);

  // ── STEP 3: Create unique sparse index ──────────────────────────────
  console.log("Creating unique sparse index on legalNameNormalized...");
  try {
    await mongoose.connection.db!
      .collection("customers")
      .createIndex(
        { legalNameNormalized: 1 },
        { unique: true, sparse: true, name: "legalNameNormalized_unique" },
      );
    console.log("✅ Index created (or already exists).\n");
  } catch (e: any) {
    if (e.code === 85 || e.code === 86) {
      console.log("ℹ️  Index already exists with a different definition — skipped.\n");
    } else if (e.code === 11000) {
      console.error(
        "❌ Index creation FAILED — duplicate legalNameNormalized values still exist!\n" +
        "   Run the script again to investigate remaining duplicates.\n",
        e.message,
      );
    } else {
      throw e;
    }
  }

  // ── STEP 4: Audit re-run to confirm no duplicates remain ───────────
  const postCheck = await Customer.find({}).select("_id legalNameNormalized").lean() as any[];
  const seen = new Map<string, string>();
  let conflict = false;
  for (const c of postCheck) {
    const n = (c as any).legalNameNormalized || "";
    if (!n) continue;
    if (seen.has(n)) {
      console.error(`❌ Remaining duplicate: "${n}" → ${seen.get(n)} AND ${(c as any)._id}`);
      conflict = true;
    } else {
      seen.set(n, String((c as any)._id));
    }
  }
  if (!conflict) {
    console.log("✅ Post-merge audit passed — no duplicate normalized names.\n");
  }

  await mongoose.connection.close();
  console.log("Connection closed. Done.");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
