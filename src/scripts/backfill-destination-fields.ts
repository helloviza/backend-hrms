/**
 * backfill-destination-fields.ts
 *
 * Backfills TravelBooking.destinationCity / destinationCountry / isInternational
 * for the "cities only" Top Destinations panel, using a tiered resolver and the
 * hand-built lookup table (src/data/destinationLookup.ts).
 *
 *   DRY RUN (default):  pnpm -C apps/backend tsx src/scripts/backfill-destination-fields.ts
 *   COMMIT (writes):    ... backfill-destination-fields.ts --commit
 *
 * DRY RUN performs ZERO writes — only find / aggregate / countDocuments. It
 * computes what the new fields WOULD be and prints a report. Writing requires
 * the explicit --commit flag; without it the script refuses to mutate data.
 *
 * Read path uses readPreference=secondary. Queries use the raw driver
 * collection (db.collection(...)) — this BYPASSES the workspaceScope mongoose
 * plugin entirely (the plugin does not hook .aggregate() anyway), and the
 * backfill is intentionally collection-wide (admin migration, no tenant scope).
 *
 * Idempotent: re-running sets the same three fields by _id; the --commit path
 * only $sets these fields and never touches destination/amount/etc.
 *
 * Tiers (precedence):
 *   T1  SBTHotelBooking source → city = cityName (canonicalized), country =
 *       source.countryCode (authoritative) else lookup(city).
 *   T2  SBTBooking (flight) source → city = destination.city (canonicalized),
 *       country = lookup(destination.code IATA) else lookup(city).
 *   T3  Other rows → run TravelBooking.destination through the lookup table.
 *   T4  ManualBooking HOTEL rows whose destination is a hotel name → recover
 *       from itinerary.destination then sector (fuzzy); else null (A1).
 */
import "dotenv/config";
import mongoose from "mongoose";
import {
  lookupDestination,
  lookupDestinationFuzzy,
  DESTINATION_LOOKUP,
  LOW_CONFIDENCE,
  type DestinationEntry,
} from "../data/destinationLookup.js";

const COMMIT = process.argv.includes("--commit");

const INR = (n: number) => Math.round(n).toLocaleString("en-IN");
const intlOf = (country: string | null): boolean | null =>
  country == null ? null : country !== "IN";

/** Canonicalize a structured city field (Tier 1/2): trust the source value if
 *  the lookup doesn't know it (it's an authoritative city field, not free text). */
function canonicalCity(name: unknown): string | null {
  const s = String(name ?? "").trim();
  if (!s) return null;
  const hit = lookupDestination(s);
  if (hit?.city) return hit.city;
  return s; // authoritative structured field — keep as-is
}
function countryFor(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const hit = lookupDestination(c);
    if (hit?.country) return hit.country;
  }
  return null;
}

type Resolution = {
  tier: string;
  city: string | null;
  country: string | null;
  international: boolean | null;
};

function resolve(
  tb: any,
  src: any | null,
): Resolution & { integrity?: string } {
  const rm = tb.referenceModel;

  // When a Tier 1/2 source doc is gone, fall back to the lookup on the mirror's
  // OWN persisted destination string (not a guess — it's stored data). Still
  // surface the integrity flag because the source doc is genuinely missing.
  const destFallback = (integrityWhy: string, tier: string): Resolution & { integrity?: string } => {
    const hit = lookupDestination(tb.destination);
    if (hit && (hit.city || hit.country)) {
      return { tier: `${tier}-FALLBACK`, city: hit.city, country: hit.country, international: intlOf(hit.country), integrity: integrityWhy };
    }
    return { tier, city: null, country: null, international: null, integrity: integrityWhy };
  };

  // ── Tier 1: SBT hotel ──
  if (rm === "SBTHotelBooking") {
    if (!src) return destFallback("SBTHotelBooking source missing", "T1");
    const city = canonicalCity(src.cityName);
    const cc = String(src.countryCode || "").trim().toUpperCase();
    const country = cc || countryFor(src.cityName);
    return { tier: "T1", city, country, international: intlOf(country) };
  }

  // ── Tier 2: SBT flight ──
  if (rm === "SBTBooking") {
    if (!src) return destFallback("SBTBooking source missing", "T2");
    const city = canonicalCity(src?.destination?.city);
    const country = countryFor(src?.destination?.code, src?.destination?.city);
    return { tier: "T2", city, country, international: intlOf(country) };
  }

  // ── Tier 3: run TravelBooking.destination through the lookup ──
  const t3: DestinationEntry | null = lookupDestination(tb.destination);
  if (t3 && (t3.city || t3.country)) {
    return { tier: "T3", city: t3.city, country: t3.country, international: intlOf(t3.country) };
  }

  // ── Tier 4: ManualBooking HOTEL with a hotel-name destination ──
  if (rm === "ManualBooking" && src) {
    for (const cand of [src?.itinerary?.destination, src?.sector]) {
      const hit = lookupDestinationFuzzy(cand);
      if (hit?.city) {
        return { tier: "T4", city: hit.city, country: hit.country, international: intlOf(hit.country) };
      }
    }
    return { tier: "T4-UNRESOLVED", city: null, country: null, international: null };
  }

  return { tier: "T3-UNRESOLVED", city: null, country: null, international: null };
}

async function main() {
  const uri = process.env.MONGO_URI!;
  // Dry-run reads from a secondary; commit reads/writes the primary so the
  // post-write verification queries are not served stale by replication lag.
  await mongoose.connect(uri, { readPreference: COMMIT ? "primary" : "secondary" });
  const db = mongoose.connection.db!;
  const TB = db.collection("travelbookings");
  const SHB = db.collection("sbthotelbookings");
  const SBT = db.collection("sbtbookings");
  const MB = db.collection("manualbookings");

  const hostMatch = uri.match(/@([^/?]+)/);
  console.log("============================================================");
  console.log(`  BACKFILL destination fields   [${COMMIT ? "COMMIT (WRITES)" : "DRY RUN — NO WRITES"}]`);
  console.log("============================================================");
  console.log(`  DB     : ${db.databaseName}`);
  console.log(`  Host   : ${hostMatch ? hostMatch[1] : "(unknown)"} (credentials redacted)`);
  console.log(`  Read   : readPreference=secondary`);

  // Load all TravelBooking rows + the source docs we need.
  const rows = await TB.find({}).toArray();
  const refIds = (model: string) =>
    rows.filter((r: any) => r.referenceModel === model && r.reference).map((r: any) => r.reference);

  const [shbDocs, sbtDocs, mbDocs] = await Promise.all([
    SHB.find({ _id: { $in: refIds("SBTHotelBooking") } }).toArray(),
    SBT.find({ _id: { $in: refIds("SBTBooking") } }).toArray(),
    MB.find({ _id: { $in: refIds("ManualBooking") } }).toArray(),
  ]);
  const srcMap = new Map<string, any>();
  for (const d of [...shbDocs, ...sbtDocs, ...mbDocs]) srcMap.set(String(d._id), d);

  console.log(`\n  total travelbookings: ${rows.length}`);
  console.log(`  source docs loaded — SBTHotelBooking: ${shbDocs.length}, SBTBooking: ${sbtDocs.length}, ManualBooking: ${mbDocs.length}`);

  // Resolve every row.
  const tierCounts: Record<string, number> = {};
  let withCity = 0, withCountry = 0, intlTrue = 0;
  const unresolved: any[] = [];
  const integrity: any[] = [];
  const updates: Array<{ _id: any; set: Resolution }> = [];
  // canonical-city rollup for reconciliation (CONFIRMED only)
  const cityRoll = new Map<string, { spend: number; trips: number; country: string | null; intl: boolean | null }>();

  for (const tb of rows as any[]) {
    const src = tb.reference ? srcMap.get(String(tb.reference)) || null : null;
    const r = resolve(tb, src);
    tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;
    if (r.integrity) integrity.push({ _id: String(tb._id), ref: String(tb.reference), model: tb.referenceModel, why: r.integrity });
    if (r.city) withCity++;
    if (r.country) withCountry++;
    if (r.international === true) intlTrue++;
    if (!r.city) unresolved.push({ ref: String(tb.reference || ""), source: tb.source, service: tb.service, rm: tb.referenceModel, dest: tb.destination });

    updates.push({ _id: tb._id, set: { tier: r.tier, city: r.city, country: r.country, international: r.international } });

    if (r.city && tb.status === "CONFIRMED") {
      const rec = cityRoll.get(r.city) || { spend: 0, trips: 0, country: r.country, intl: r.international };
      rec.spend += Number(tb.amount) || 0;
      rec.trips += 1;
      cityRoll.set(r.city, rec);
    }
  }

  // ── REPORT ──
  console.log("\n── Resolution by tier ──");
  for (const [t, c] of Object.entries(tierCounts).sort()) console.log(`  ${t.padEnd(16)} ${c}`);
  const unresolvedCount = unresolved.length;
  console.log(`\n  rows that WOULD get non-null destinationCity   : ${withCity}`);
  console.log(`  rows that WOULD get non-null destinationCountry: ${withCountry}`);
  console.log(`  rows that WOULD get isInternational = true     : ${intlTrue}`);
  console.log(`  rows left UNRESOLVED (destinationCity = null)   : ${unresolvedCount}`);

  console.log("\n── Unresolved sample (up to 40): ref | source | service | referenceModel | raw destination ──");
  for (const u of unresolved.slice(0, 40)) {
    console.log(`  ${u.ref.padEnd(26)} ${String(u.source).padEnd(10)} ${String(u.service).padEnd(8)} ${String(u.rm).padEnd(16)} ${JSON.stringify(u.dest)}`);
  }
  if (unresolvedCount > 40) console.log(`  ... (${unresolvedCount - 40} more unresolved)`);

  console.log("\n── Data-integrity flags (Tier 1/2 source doc missing) ──");
  if (integrity.length === 0) console.log("  none");
  for (const i of integrity) console.log(`  [!] tb=${i._id} ref=${i.ref} (${i.model}) — ${i.why}`);

  // Reconciliation: distinct canonical cities + top 10 by CONFIRMED spend.
  const ranked = [...cityRoll.entries()].sort((a, b) => b[1].spend - a[1].spend);
  console.log(`\n── Reconciliation — "Top Destinations" would have ${ranked.length} distinct canonical cities (CONFIRMED rows) ──`);
  console.log("  rank  city                  CONFIRMED spend     trips  country  intl");
  ranked.slice(0, 10).forEach(([city, r], i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}.   ${city.padEnd(20)} ₹${INR(r.spend).padStart(14)}   ${String(r.trips).padStart(5)}   ${String(r.country ?? "?").padEnd(6)}  ${r.intl === null ? "?" : r.intl}`,
    );
  });

  // Full lookup table for review.
  console.log("\n── LOOKUP TABLE (for review) — key → city | country | intl ──");
  for (const [k, v] of Object.entries(DESTINATION_LOOKUP).sort()) {
    console.log(`  ${k.padEnd(28)} -> ${String(v.city ?? "(null)").padEnd(18)} ${String(v.country ?? "(null)").padEnd(4)} ${v.international === null ? "?" : v.international}`);
  }
  console.log(`  (total lookup keys: ${Object.keys(DESTINATION_LOOKUP).length})`);

  console.log("\n── LOW-CONFIDENCE / adjudicate by hand ──");
  for (const f of LOW_CONFIDENCE) console.log(`  • ${f.value}: ${f.note}`);

  if (!COMMIT) {
    console.log("\n[DRY RUN — no writes performed. Re-run with --commit to apply.]");
    await mongoose.disconnect();
    return;
  }

  // ── COMMIT PATH (only with --commit) ── idempotent $set of the three fields.
  const ops = updates.map((u) => ({
    updateOne: {
      filter: { _id: u._id },
      update: { $set: { destinationCity: u.set.city, destinationCountry: u.set.country, isInternational: u.set.international } },
    },
  }));
  const res: any = await TB.bulkWrite(ops, { ordered: false });
  console.log(`\n[COMMIT] ops attempted=${ops.length}  matched=${res.matchedCount}  modified=${res.modifiedCount}`);

  // ── POST-COMMIT VERIFICATION (read-only, from primary) ──
  console.log("\n============================================================");
  console.log("  POST-COMMIT VERIFICATION (reads persisted fields, primary)");
  console.log("============================================================");
  const nonNullCity = await TB.countDocuments({ destinationCity: { $ne: null } });
  const nullCity = await TB.countDocuments({ destinationCity: null });
  const nonNullCountry = await TB.countDocuments({ destinationCountry: { $ne: null } });
  const intlTrueP = await TB.countDocuments({ isInternational: true });
  console.log(`  destinationCity non-null: ${nonNullCity}   null: ${nullCity}`);
  console.log(`  destinationCountry non-null: ${nonNullCountry}   isInternational=true: ${intlTrueP}`);

  const topP = await TB.aggregate([
    { $match: { destinationCity: { $ne: null }, status: "CONFIRMED" } },
    { $group: { _id: "$destinationCity", spend: { $sum: { $ifNull: ["$amount", 0] } }, trips: { $sum: 1 }, country: { $first: "$destinationCountry" }, intl: { $first: "$isInternational" } } },
    { $sort: { spend: -1 } },
    { $limit: 10 },
  ]).toArray();
  console.log("\n  Top 10 canonical cities (from PERSISTED fields, CONFIRMED):");
  console.log("  rank  city                  CONFIRMED spend     trips  country  intl");
  topP.forEach((r: any, i: number) => {
    console.log(`  ${String(i + 1).padStart(2)}.   ${String(r._id).padEnd(20)} ₹${INR(r.spend).padStart(14)}   ${String(r.trips).padStart(5)}   ${String(r.country ?? "?").padEnd(6)}  ${r.intl === null ? "?" : r.intl}`);
  });

  // 3 spot-check rows per tier (re-resolved tier label + persisted fields).
  console.log("\n  Spot-check — 3 rows per tier (_id | source | raw destination | persisted city/country/intl):");
  const byTier = new Map<string, any[]>();
  for (const u of updates) {
    const list = byTier.get(u.set.tier) || [];
    if (list.length < 3) { list.push(u._id); byTier.set(u.set.tier, list); }
  }
  for (const [tier, ids] of [...byTier.entries()].sort()) {
    console.log(`  ── ${tier} ──`);
    const docs = await TB.find({ _id: { $in: ids } }).project({ source: 1, destination: 1, destinationCity: 1, destinationCountry: 1, isInternational: 1 }).toArray();
    for (const d of docs as any[]) {
      console.log(`    ${String(d._id)} | ${String(d.source).padEnd(9)} | ${JSON.stringify(d.destination).padEnd(34)} | ${JSON.stringify(d.destinationCity)} / ${JSON.stringify(d.destinationCountry)} / ${d.isInternational}`);
    }
  }

  await mongoose.disconnect();
  console.log("\n[COMMIT complete]");
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
