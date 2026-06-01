// apps/backend/src/scripts/backfill-lead-companyId.ts
//
// Dedupe existing Lead.companyName strings into shared CRMCompany records and
// backfill Lead.companyId. Mirrors merge-duplicate-customers.ts conventions:
// dotenv/config, env.MONGO_URI, idempotent, re-runnable.
//
// DRY-RUN by default (reports only, writes nothing). Pass --apply to write:
//   pnpm -C apps/backend exec tsx src/scripts/backfill-lead-companyId.ts
//   pnpm -C apps/backend exec tsx src/scripts/backfill-lead-companyId.ts --apply
//
// --apply does, in order:
//   1. backfill nameNormalized on all existing CRMCompany (so resolve matches them)
//   2. reconcile already-converted leads (companyId ← convertedToCompanyId)
//   3. per (alias-collapsed) normalized-name group: resolve-or-create / reuse the
//      company, link every lead (incl. won/lost) directly via the driver
//   4. create the UNIQUE index on CRMCompany.nameNormalized over the clean data
//   5. post-audit for any remaining duplicate normalized names
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import Lead from "../models/Lead.js";
import CRMCompany from "../models/CRMCompany.js";
import { normalizeCompanyName, resolveOrCreateCompany } from "../utils/crmCompany.js";

const APPLY = process.argv.includes("--apply");

// Attributes that count toward "most-complete lead" when choosing which lead
// seeds a freshly-created company.
const SEED_ATTRS = ["industry", "companySize", "location", "website", "gstin"] as const;

// ── Human-approved alias map (variant normalized-name → canonical) ──
// Confirmed variants collapse into ONE company (canonical on the right). Keys and
// values are normalized forms (lowercase, collapsed whitespace; punctuation kept
// by normalizeCompanyName, so ".com"/"." appear here verbatim). NOT detector-
// derived — these are explicitly approved. strainx bioworks/biotech is left SPLIT.
const ALIAS_MAP: Record<string, string> = {
  zetwrerk: "zetwerk",
  takeme2sapce: "takeme2space",
  "eon space lab": "eon space labs",
  "revealhealthtech.com": "revealhealthtech",
  exponent: "exponent energy",
  sarvam: "sarvam ai",
  abyom: "abyom spacetech",
  "lkq private ltd": "lkq india pvt ltd",
  // Both punctuation variants → the EXISTING "Suprajit Engineering Ltd" company.
  "suprajit eng.": "suprajit engineering ltd",
  "suprajit eng": "suprajit engineering ltd",
};

const LEGAL = new Set([
  "pvt", "private", "ltd", "limited", "llp",
  "inc", "incorporated", "corp", "corporation", "co", "company",
]);

function completeness(l: any): number {
  return SEED_ATTRS.reduce((n, k) => n + (String(l[k] || "").trim() ? 1 : 0), 0);
}

function mostComplete(leads: any[]): any {
  let seed = leads[0];
  for (const l of leads) if (completeness(l) > completeness(seed)) seed = l;
  return seed;
}

// Strip ".com", punctuation, and legal suffixes → token list for near-dupe comparison.
function strippedTokens(normalized: string): string[] {
  return normalized
    .replace(/\.com\b/g, " ")
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !LEGAL.has(t));
}
function strippedStr(normalized: string): string {
  return strippedTokens(normalized).join(" ");
}

function isTokenSubset(a: string, b: string): boolean {
  const ta = new Set(strippedTokens(a));
  const tb = new Set(strippedTokens(b));
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

// Optimal String Alignment (Damerau–Levenshtein with adjacent transposition = 1).
function osaDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99; // cheap early-out for the ≤1 use-case
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// Broadened near-dupe rule: equal-after-strip OR token-subset OR OSA ≤ 1
// (on stripped or raw normalized forms).
function isNearDupe(a: string, b: string): string | null {
  const sa = strippedStr(a), sb = strippedStr(b);
  if (sa === sb) return "equal-after-strip";
  if (isTokenSubset(a, b)) return "token-subset";
  if (osaDistance(sa, sb) <= 1) return "edit≤1(stripped)";
  if (osaDistance(a, b) <= 1) return "edit≤1";
  return null;
}

function aliasResolve(key: string): string {
  return ALIAS_MAP[key] ?? key;
}

async function main() {
  console.log(`\n=== backfill-lead-companyId  [${APPLY ? "APPLY" : "DRY-RUN"}] ===\n`);
  console.log("Connecting to MongoDB...");
  await mongoose.connect(env.MONGO_URI);
  console.log("Connected.\n");

  const leads = (await Lead.find({})
    .select(
      "_id leadCode type companyName companyId convertedToCompanyId stage industry companySize location website gstin"
    )
    .lean()) as any[];

  const existing = (await CRMCompany.find({})
    .select("_id name nameNormalized")
    .lean()) as any[];

  // Existing companies keyed by normalized name (their nameNormalized may not be
  // backfilled yet, so normalize from `name`).
  const existingByNorm = new Map<string, any>();
  for (const c of existing) {
    const k = c.nameNormalized || normalizeCompanyName(c.name);
    if (k && !existingByNorm.has(k)) existingByNorm.set(k, c);
  }

  // ── Partition (convertedToCompanyId FIRST) ───────────────────────
  // A converted lead is anchored to its convertedToCompanyId regardless of type
  // or blank name — this catches LEAD-2026-0001 (Inteletek AI, individual). Only
  // then do the individual / blank skips apply.
  const convertedReconcile: any[] = [];
  const individualSkip: any[] = [];
  const blankSkip: any[] = [];
  const toGroup: any[] = [];

  for (const l of leads) {
    if (l.convertedToCompanyId) {
      convertedReconcile.push(l);
      continue;
    }
    if (l.type === "individual") {
      individualSkip.push(l);
      continue;
    }
    if (!normalizeCompanyName(l.companyName)) {
      blankSkip.push(l);
      continue;
    }
    toGroup.push(l);
  }

  // ── Group the rest by ALIAS-COLLAPSED normalized name ────────────
  const groups = new Map<string, any[]>();
  for (const l of toGroup) {
    const rawKey = normalizeCompanyName(l.companyName);
    const groupKey = aliasResolve(rawKey);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(l);
  }

  // ── Build per-group plan (reuse vs create, seed, display name) ───
  interface Plan {
    groupKey: string;
    members: any[];
    seed: any;
    displayName: string;
    reuseExisting: any | null;
  }
  const plan: Plan[] = [];
  for (const [groupKey, members] of groups.entries()) {
    const reuseExisting = existingByNorm.get(groupKey) || null;
    // "Canonical's most-complete lead" seeds attrs — prefer leads whose own name
    // already equals the canonical key; fall back to all members otherwise.
    const canonicalLeads = members.filter(
      (m) => normalizeCompanyName(m.companyName) === groupKey
    );
    const seed = mostComplete(canonicalLeads.length ? canonicalLeads : members);
    const displayName = reuseExisting
      ? reuseExisting.name
      : canonicalLeads.length
      ? seed.companyName
      : members[0].companyName;
    plan.push({ groupKey, members, seed, displayName, reuseExisting });
  }

  // ── Collapses actually applied (alias variant → canonical) ───────
  interface Collapse {
    variantKey: string;
    canonicalKey: string;
    leadCodes: string[];
    resulting: string;
  }
  const collapses: Collapse[] = [];
  for (const l of toGroup) {
    const rawKey = normalizeCompanyName(l.companyName);
    const canonicalKey = aliasResolve(rawKey);
    if (canonicalKey === rawKey) continue; // not aliased
    let entry = collapses.find((c) => c.variantKey === rawKey);
    if (!entry) {
      const p = plan.find((x) => x.groupKey === canonicalKey)!;
      entry = {
        variantKey: rawKey,
        canonicalKey,
        leadCodes: [],
        resulting: p.reuseExisting
          ? `REUSE existing ${p.reuseExisting._id}`
          : "CREATE (companyId assigned on --apply)",
      };
      collapses.push(entry);
    }
    entry.leadCodes.push(l.leadCode);
  }

  // ── Broadened near-dupe detector over the ORIGINAL (pre-collapse) keys ──
  const rawKeys = [...new Set(toGroup.map((l) => normalizeCompanyName(l.companyName)))];
  interface Cand { a: string; b: string; rule: string; handled: boolean }
  const detected: Cand[] = [];
  for (let i = 0; i < rawKeys.length; i++) {
    for (let j = i + 1; j < rawKeys.length; j++) {
      const rule = isNearDupe(rawKeys[i], rawKeys[j]);
      if (!rule) continue;
      // "handled" = the approved alias map already collapses both into one group.
      const handled = aliasResolve(rawKeys[i]) === aliasResolve(rawKeys[j]);
      detected.push({ a: rawKeys[i], b: rawKeys[j], rule, handled });
    }
  }
  const remaining = detected.filter((c) => !c.handled);

  // ── Verbose group listing ────────────────────────────────────────
  console.log("=== GROUPS (alias-collapsed normalized companyName → leads) ===");
  for (const p of [...plan].sort((a, b) => b.members.length - a.members.length)) {
    const action = p.reuseExisting ? `REUSE ${p.reuseExisting._id}` : "CREATE";
    console.log(
      `\n[${p.members.length}] "${p.groupKey}" → ${action}` +
        `  seed=${p.seed.leadCode} (completeness ${completeness(p.seed)})  display="${p.displayName}"`
    );
    for (const m of p.members) {
      const raw = normalizeCompanyName(m.companyName);
      const tag = raw !== p.groupKey ? `  [alias ⇐ "${raw}"]` : "";
      console.log(`    ${m.leadCode} | stage=${m.stage}${m.companyId ? " | already-linked" : ""}${tag}`);
    }
  }

  // ── Counts ───────────────────────────────────────────────────────
  const willReuse = plan.filter((p) => p.reuseExisting).length;
  const willCreate = plan.filter((p) => !p.reuseExisting).length;
  const multiLead = plan.filter((p) => p.members.length > 1);
  const beforeCompanyCount = existing.length;

  console.log("\n\n══════════════════ SUMMARY ══════════════════");
  console.log(`Total leads:                     ${leads.length}`);
  console.log(`  Already-converted reconciled:  ${convertedReconcile.length}` +
    (convertedReconcile.length ? `  (${convertedReconcile.map((l) => l.leadCode).join(", ")})` : ""));
  console.log(`  Skipped — type=individual:     ${individualSkip.length}`);
  console.log(`  Skipped — blank companyName:   ${blankSkip.length}`);
  console.log(`  Leads to link (grouped):       ${toGroup.length}`);
  console.log(`\nDistinct companies (grouped):    ${plan.length}`);
  console.log(`  → reuse existing CRMCompany:   ${willReuse}`);
  console.log(`  → create new CRMCompany:       ${willCreate}`);
  console.log(`Multi-lead companies:            ${multiLead.length}` +
    `  (${multiLead.map((p) => `${p.groupKey}×${p.members.length}`).join(", ")})`);
  console.log(`\nCRMCompany count BEFORE:         ${beforeCompanyCount}`);
  console.log(`CRMCompany count AFTER (est.):   ${beforeCompanyCount + willCreate}`);

  // ── Collapses applied ────────────────────────────────────────────
  console.log(`\n── Collapses applied (alias map): ${collapses.length} ──`);
  for (const c of collapses) {
    console.log(
      `  "${c.variantKey}" → "${c.canonicalKey}"  [${c.leadCodes.join(", ")}]  → ${c.resulting}`
    );
  }
  if (collapses.length === 0) console.log("  (none)");

  // ── Near-dupe detector results ───────────────────────────────────
  console.log(`\n── Near-dupe pairs detected (broadened detector): ${detected.length} ──`);
  for (const c of detected) {
    console.log(`  "${c.a}"  vs  "${c.b}"   [${c.rule}]${c.handled ? "  → collapsed by alias map" : ""}`);
  }
  if (detected.length === 0) console.log("  (none)");

  console.log(`\n── REMAINING review candidates (detected, NOT collapsed): ${remaining.length} ──`);
  for (const c of remaining) {
    console.log(`  "${c.a}"  vs  "${c.b}"   [${c.rule}]`);
  }
  if (remaining.length === 0) console.log("  (none)");
  console.log(
    "  NOTE: strainx bioworks / strainx biotech is intentionally left SPLIT (human\n" +
    "  decision) and is below the detector's thresholds, so it is not listed above."
  );

  if (!APPLY) {
    console.log("\nDRY-RUN — no writes performed. Re-run with --apply to execute.\n");
    await mongoose.connection.close();
    console.log("Connection closed. Done.");
    return;
  }

  // ══════════════════ APPLY ══════════════════
  console.log("\n══════════════════ APPLYING ══════════════════\n");

  // 1. Backfill nameNormalized on all existing companies so resolve/reuse matches.
  let normBackfilled = 0;
  for (const c of existing) {
    await CRMCompany.updateOne(
      { _id: c._id },
      { $set: { nameNormalized: normalizeCompanyName(c.name) } }
    );
    normBackfilled++;
  }
  console.log(`1. Backfilled nameNormalized on ${normBackfilled} existing companies.`);

  // 2. Reconcile already-converted leads → companyId = convertedToCompanyId.
  if (convertedReconcile.length) {
    const res = await Lead.bulkWrite(
      convertedReconcile.map((l) => ({
        updateOne: {
          filter: { _id: l._id },
          update: { $set: { companyId: l.convertedToCompanyId } },
        },
      }))
    );
    console.log(`2. Reconciled ${res.modifiedCount} already-converted leads.`);
  } else {
    console.log("2. No already-converted leads to reconcile.");
  }

  // 3. Per group: reuse existing or resolve-or-create, then link every lead
  //    directly via the driver — NOT the edit route (it blocks closed leads).
  let companiesResolved = 0;
  let leadsLinked = 0;
  for (const p of plan) {
    let company = p.reuseExisting;
    if (!company) {
      company = await resolveOrCreateCompany(
        {
          name: p.displayName,
          industry: p.seed.industry,
          companySize: p.seed.companySize,
          location: p.seed.location,
          website: p.seed.website,
          gstin: p.seed.gstin,
        },
        undefined
      );
    }
    if (!company) continue;
    companiesResolved++;
    const res = await Lead.bulkWrite(
      p.members.map((m) => ({
        updateOne: { filter: { _id: m._id }, update: { $set: { companyId: company._id } } },
      }))
    );
    leadsLinked += res.modifiedCount;
  }
  console.log(`3. Resolved ${companiesResolved} companies; linked ${leadsLinked} leads.`);

  // 4. Promote nameNormalized to a UNIQUE index over the now-clean data.
  console.log("4. Creating UNIQUE index on CRMCompany.nameNormalized...");
  try {
    await mongoose.connection.db!
      .collection("crmcompanies")
      .createIndex({ nameNormalized: 1 }, { unique: true, name: "nameNormalized_unique" });
    console.log("   ✅ Unique index created (or already present).");
  } catch (e: any) {
    if (e.code === 85 || e.code === 86) {
      console.log("   ℹ️  Index already exists with a different definition — skipped.");
    } else if (e.code === 11000) {
      console.error(
        "   ❌ Index FAILED — duplicate nameNormalized values still exist. Investigate.",
        e.message
      );
    } else {
      throw e;
    }
  }

  // 5. Post-audit — confirm no duplicate normalized names remain.
  const post = (await CRMCompany.find({}).select("_id nameNormalized").lean()) as any[];
  const seen = new Map<string, string>();
  let conflict = false;
  for (const c of post) {
    const n = c.nameNormalized || "";
    if (!n) continue;
    if (seen.has(n)) {
      console.error(`   ❌ Duplicate remains: "${n}" → ${seen.get(n)} AND ${c._id}`);
      conflict = true;
    } else {
      seen.set(n, String(c._id));
    }
  }
  console.log(conflict ? "5. ⚠️  Duplicates remain (see above)." : "5. ✅ Post-audit clean.");

  console.log(`\nCRMCompany count AFTER: ${post.length}\n`);
  await mongoose.connection.close();
  console.log("Connection closed. Done.");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
