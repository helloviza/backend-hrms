// apps/backend/src/routes/public.visa.ts
//
// THE PUBLIC HELLOVIZA CONTRACT. Three endpoints, no auth of any kind — no
// Authorization header, no cookie, no token. Mounted under /api/public
// (server.ts), which is already in WORKSPACE_EXEMPT, so the global
// requireWorkspace shim never runs on them either.
//
// Its own file and its own router, deliberately — the same reasoning
// routes/places.photo.public.ts states for itself: "which endpoints are
// unauthenticated" must be answerable by reading one short file, not by
// tracing middleware order through a router that also serves authed routes.
// NOTHING that requires a session may ever be added here.
//
// ── WHAT MAKES THIS SAFE ──────────────────────────────────────────────
// The two GETs read global reference data only — no PII whatsoever:
//   · VisaRule                — the corridor catalogue. No traveller, no
//                               workspace, no user. Filtered to PUBLISHED.
//   · VisaDestinationContent  — editorial copy/imagery. Filtered to PUBLISHED.
//   · visa-country-seed.json  — a STATIC file (config/visaCountrySeed.ts).
//                               196 countries, no database, no caller input.
// Neither handler touches VisaRequest, VisaApplication, TravellerProfile,
// User, Consumer, ManualBooking or CustomerWorkspace. There is no id a caller
// can supply that reaches a case.
//
// ── WHAT MUST NEVER LEAK ──────────────────────────────────────────────
// Every response here is built by CONSTRUCTING a new object from named
// fields, never by spreading a document and deleting keys. A delete-list is
// one schema addition away from leaking; a whitelist is not. Specifically
// absent, and asserted absent by publicVisaContract.test.ts:
//   · plumtripsServiceFeeInr (the B2B fee) and indicativeVisaCostInr
//   · opsNotes, seedSource, status, effectiveFrom, lastReviewedAt, reviewedBy
//   · needsCatalogueMapping, unmatchedDocumentNames, unmatchedTemplateReference
//   · applicability / appliesWhen predicates
//   · anything from a case or identity collection
import { Router } from "express";
import VisaRule, { type VisaCategory } from "../models/VisaRule.js";
import VisaDestinationContent from "../models/VisaDestinationContent.js";
import { hydrateVisaChecklist } from "../utils/visaChecklistHydration.js";
import { computeVisaFeeBlock, VISA_FEE_DISCLAIMER } from "../utils/visaFee.js";
import { selectHeadlineRule } from "../utils/visaHeadlineRule.js";
import { isCuratedCorridor } from "../config/visaFeaturedRanking.js";
import {
  SEED_VISA_CATEGORIES,
  findSeedCountry,
  getSeedMeta,
  getSeedRegions,
  isSeedReady,
  listSeedCountries,
  seedFailureReason,
  type SeedVisaCategory,
} from "../config/visaCountrySeed.js";
import {
  approvalChancesFor,
  approvalFiguresFor,
  difficultyFor,
} from "../utils/visaDifficulty.js";
import { normaliseToIso2 } from "../utils/countryCodes.js";
import { customerPurposesForRules } from "../utils/visaPurposes.js";
import { createTurnstileGate } from "../middleware/turnstile.js";
import { travelRequestLimiter } from "../middleware/rateLimit.js";
import { createIntakeBookings } from "../services/travelIntake.create.js";
import logger from "../utils/logger.js";

const router = Router();
const publicVisaLogger = logger.child({ module: "publicVisa" });

// Every published rule in production is nationality "IN" (confirmed against
// the live catalogue: 258/258). Declared as a constant rather than accepted
// as a query parameter — a public endpoint that lets a caller pivot the whole
// catalogue on an unvalidated field is a bigger surface than this phase needs.
const PUBLIC_NATIONALITY = "IN";

/* ─────────────────────────────────────────────────────────────────────
 * Category precedence for a destination whose PUBLISHED rules disagree.
 *
 * A map pin is ONE colour. 84 destinations collapse from 258 rules, and a
 * destination can legitimately publish (say) an E_VISA tourist rule beside a
 * STICKER business rule. Taking the first rule's value would make the pin
 * colour depend on document order, which is arbitrary and unstable.
 *
 * So the MOST PERMISSIVE category wins — the one representing least friction
 * for a traveller — and `categoryIsMixed` marks the disagreement so the
 * frontend can caption it honestly instead of implying the whole corridor is
 * visa-free. Never silently collapsed.
 * ───────────────────────────────────────────────────────────────────── */
const CATEGORY_PRECEDENCE: readonly VisaCategory[] = [
  "VISA_FREE",
  "VOA",
  "E_VISA",
  "STAMP",
  "STICKER",
];

function mostPermissiveCategory(categories: Set<VisaCategory>): VisaCategory | null {
  for (const c of CATEGORY_PRECEDENCE) {
    if (categories.has(c)) return c;
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────
 * THE SEED IS THE DISPLAY AUTHORITY; VisaRule ONLY BRANCHES THE CTA.
 *
 * The map answers "where can an Indian passport go?", which is a fact about
 * the world, not about our catalogue. So all 196 countries are drawn from
 * visa-country-seed.json, and a PUBLISHED VisaRule for IN -> iso2 sets nothing
 * but `serviced`, which decides Apply vs Request. Nothing about a country's
 * appearance depends on whether we sell it.
 *
 * That means `visaCategory` on THIS endpoint is now the seed's category, not
 * the rule-derived one it was in Phase 2a. Where the two disagree for one of
 * the 84 served corridors, the seed wins here. (The country endpoint keeps
 * rule-derived semantics — see its own note.)
 * ───────────────────────────────────────────────────────────────────── */

/**
 * The rubric only knows the seed's four categories; VisaRule has five.
 * STAMP collapses into STICKER — the same thing to a traveller (you go to a
 * consulate and they put something in your passport), which is exactly how the
 * frontend legend already buckets it (map/categories.ts LEGEND_MEMBERS).
 * Only reachable via the fallback below, since no seed entry is STAMP.
 */
function rubricCategory(category: VisaCategory): SeedVisaCategory {
  return category === "STAMP" ? "STICKER" : (category as SeedVisaCategory);
}

/* ─────────────────────────────────────────────────────────────────────
 * THE DIVERGENCE GUARD.
 *
 * A SERVICED corridor has two categories: the seed's (which colours the
 * map pin and the tooltip) and the rule's (which the country panel
 * shows). They agree almost everywhere. Where they DON'T, a consumer
 * sees one answer on the map and a different one after they click —
 * which looks like a bug and, worse, is one of the two being wrong.
 *
 * This is the only place in the process where both values are in hand,
 * so it is where the check belongs. It REPORTS AND DOES NOT RESOLVE: the
 * seed still wins the display, exactly as frozen in 2c. Someone has to
 * decide which source is wrong for that corridor, and that someone is
 * not this function.
 *
 * Logged once per ISO2 per process — the map endpoint is public and
 * uncached, so warning on every request would bury the signal in its own
 * volume within a day.
 * ───────────────────────────────────────────────────────────────────── */
const divergenceWarned = new Set<string>();

export function findCategoryDivergence(
  entries: Array<{ iso2: string; seedCategory: SeedVisaCategory; ruleCategory: VisaCategory | null }>,
): Array<{ iso2: string; seedCategory: string; ruleCategory: string }> {
  const out: Array<{ iso2: string; seedCategory: string; ruleCategory: string }> = [];
  for (const e of entries) {
    if (!e.ruleCategory) continue; // nothing published to disagree with
    if (rubricCategory(e.ruleCategory) === e.seedCategory) continue;
    out.push({ iso2: e.iso2, seedCategory: e.seedCategory, ruleCategory: e.ruleCategory });
  }
  return out;
}

function reportCategoryDivergence(
  found: Array<{ iso2: string; seedCategory: string; ruleCategory: string }>,
): void {
  for (const d of found) {
    if (divergenceWarned.has(d.iso2)) continue;
    divergenceWarned.add(d.iso2);
    publicVisaLogger.warn(
      "visa map — seed/rule category divergence: the map pin and the country panel will disagree",
      d,
    );
  }
}

router.get("/visa/map", async (_req: any, res: any) => {
  try {
    if (!isSeedReady()) {
      publicVisaLogger.error("map read refused — country seed unavailable", {
        reason: seedFailureReason(),
      });
      return res.status(503).json({ error: "Country data is unavailable" });
    }

    const rules = await VisaRule.find({
      status: "PUBLISHED",
      nationality: PUBLIC_NATIONALITY,
    })
      .select("destinationIso2 destinationName visaCategory")
      .lean();

    const byIso2 = new Map<string, { destinationName: string; categories: Set<VisaCategory> }>();
    for (const r of rules as any[]) {
      const iso2 = r.destinationIso2;
      let entry = byIso2.get(iso2);
      if (!entry) {
        entry = { destinationName: r.destinationName, categories: new Set() };
        byIso2.set(iso2, entry);
      }
      if (r.visaCategory) entry.categories.add(r.visaCategory);
    }

    const meta = getSeedMeta();

    const destinations = listSeedCountries().map((c) => {
      const served = byIso2.get(c.iso2);
      return {
        iso2: c.iso2,
        countryName: c.countryName,
        // 2a alias, kept ONLY so Phase 2b's WorldMap/HoverCard/Legend keep
        // working without a frontend change. Same value as countryName.
        destinationName: c.countryName,
        visaType: c.visaCategory,
        visaCategory: c.visaCategory, // 2a alias, same value as visaType
        // Rule-derived and still meaningful: this corridor publishes more than
        // one visa type. Necessarily false where we publish nothing.
        categoryIsMixed: served ? served.categories.size > 1 : false,
        difficulty: difficultyFor(c.iso2, c.visaCategory),
        approvalChances: approvalChancesFor(c.iso2, c.visaCategory),
        // The three readings. Null where the corridor shows a fixed string
        // instead of a number — see approvalFiguresFor.
        approvalFigures: approvalFiguresFor(c.iso2, c.visaCategory),
        serviced: Boolean(served),
        // Phase 3 (region rail). Both are the SEED's own values, passed
        // through — the frontend fits and filters by them and holds no
        // country list of its own. A country's continent never depends on
        // whether we sell it, which is why these sit beside visaType rather
        // than anywhere near `serviced`.
        continent: c.continent,
        groups: c.groups,
      };
    });

    /* A corridor we PUBLISH but the seed does not list would otherwise vanish
     * from the map — silently dropping a country we actually sell. The seed
     * covers all 196 today so this is empty, but "empty today" is not a
     * guarantee, and losing a live corridor must never be the quiet outcome.
     * Such a corridor is appended from its own rule and logged. */
    for (const [iso2, entry] of byIso2) {
      if (findSeedCountry(iso2)) continue;
      const category = rubricCategory(mostPermissiveCategory(entry.categories) ?? "STICKER");
      publicVisaLogger.warn("published corridor missing from the country seed", { iso2 });
      destinations.push({
        iso2,
        countryName: entry.destinationName,
        destinationName: entry.destinationName,
        visaType: category,
        visaCategory: category,
        categoryIsMixed: entry.categories.size > 1,
        difficulty: difficultyFor(iso2, category),
        approvalChances: approvalChancesFor(iso2, category),
        // The three readings. Null where the corridor shows a fixed string
        // instead of a number — see approvalFiguresFor.
        approvalFigures: approvalFiguresFor(iso2, category),
        serviced: true,
        // A corridor the seed does not carry has no continent and no group
        // membership to state. Empty rather than guessed: the region rail
        // will not place it, which is visibly odd and therefore correct —
        // the warning above is the fix, not a fabricated continent.
        continent: "",
        groups: [],
      });
    }

    // Both categories are in hand exactly here — see the guard's header.
    reportCategoryDivergence(
      findCategoryDivergence(
        listSeedCountries()
          .filter((c) => byIso2.has(c.iso2))
          .map((c) => ({
            iso2: c.iso2,
            seedCategory: c.visaCategory,
            ruleCategory: mostPermissiveCategory(byIso2.get(c.iso2)!.categories),
          })),
      ),
    );

    destinations.sort((a, b) => a.countryName.localeCompare(b.countryName));

    // Legend counts, computed from the SAME resolved per-destination category
    // the pins use — so the legend can never disagree with the map it labels.
    // STAMP is still emitted (as 0) so the frontend Legend's shape is unchanged.
    const byCategory: Record<string, number> = {};
    // Seeded from BOTH vocabularies. CATEGORY_PRECEDENCE is the catalogue's
    // five (it keeps STAMP: 0 in the shape); SEED_VISA_CATEGORIES is the
    // seed's six, and without it TRAVEL_AUTH and RESTRICTED would increment
    // an undefined key and ship NaN as a count.
    for (const c of CATEGORY_PRECEDENCE) byCategory[c] = 0;
    for (const c of SEED_VISA_CATEGORIES) byCategory[c] = byCategory[c] ?? 0;
    for (const d of destinations) {
      if (d.visaCategory) byCategory[d.visaCategory] += 1;
    }
    const servicedCount = destinations.filter((d) => d.serviced).length;

    res.json({
      ok: true,
      nationality: PUBLIC_NATIONALITY,
      generatedAt: new Date().toISOString(),
      source: meta.source,
      sourceUrl: meta.sourceUrl,
      lastVerified: meta.lastVerified,
      disclaimer: meta.disclaimer,
      destinations,
      // The region vocabulary, verbatim from the seed. Continents and the
      // curated groupings (Schengen/GCC/ASEAN) with their real membership,
      // so the rail's buttons, its counts and the countries it lights all
      // resolve from one list. The loader has already asserted that this
      // membership and the per-country `groups` agree.
      regions: getSeedRegions(),
      stats: {
        total: destinations.length,
        byCategory,
        serviced: servicedCount,
        unserviced: destinations.length - servicedCount,
      },
    });
  } catch (err: any) {
    publicVisaLogger.error("map read failed", { error: err?.message });
    res.status(500).json({ error: "Failed to load the visa map" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /visa/country/:iso2 — the requirements-slider payload.
 *
 * Picks ONE representative rule for the corridor: the cheapest published
 * TOURIST-ish rule, falling back to whatever is published. A corridor with
 * several variants (Türkiye's e-visa beside its sticker visa) shows the one a
 * consumer is most likely to want; the slider is not a variant comparison
 * table, and pretending otherwise would need pricing for every variant.
 * ───────────────────────────────────────────────────────────────────── */

// The customer checklist, narrowed for a PUBLIC reader. hydrateVisaChecklist
// is reused verbatim (it is already the whitelist that withholds
// needsCatalogueMapping, unmatched* and the raw predicates) and then narrowed
// again here: satisfiedByBooking and conciergeArrangeable describe a
// signed-in customer's linked bookings and concierge entitlements, and
// isPassport drives a form this surface does not render.
function publicDocumentRows(rule: any) {
  const checklist = hydrateVisaChecklist(rule);
  return {
    documents: checklist.documents.map((d) => ({
      docCode: d.docCode,
      name: d.name,
      notes: d.notes,
      requirement: d.requirement,
    })),
    documentGroups: checklist.documentGroups.map((g) => ({
      key: g.key,
      label: g.label,
      requirement: g.requirement,
      // docCodes is index-aligned with docNames (visaChecklistHydration.ts:154).
      // Added for the consumer Apply flow: a group has to be matched against the
      // consumer's document locker, and the locker is keyed by CODE, not by
      // display name. Without this the client would have to reverse a name back
      // into a code — a join it cannot do correctly, since names are localised
      // catalogue copy and codes are not. Catalogue reference data, no PII.
      docCodes: g.docCodes,
      docNames: g.docNames,
    })),
  };
}

/**
 * THE PRICE GATE — one condition: the selected rule carries a POPULATED
 * d2cServiceFeeInr.
 *
 * ── WHY THE CURATED-SET CLAUSE IS GONE (2026-08-27) ──────────────────
 * This used to be an AND of two things: the corridor had to be in the
 * eleven-entry curated set (config/visaFeaturedRanking.ts) AND carry a fee.
 * Measured against production, those two conditions had never once been
 * satisfied together — the single corridor with an authored fee (AU) was
 * not curated, and all eleven curated corridors were unpriced. The gate
 * was not gating a decision; it was holding the door shut.
 *
 * The rule now is the one ops actually acts on: authoring a D2C service fee
 * IS the act of making a corridor sellable. A second, hardcoded list that
 * has to be edited in a deploy before that fee can surface just means a
 * priced corridor stays invisible for reasons no one at the keyboard can
 * see.
 *
 * The curated list KEEPS its other job. isCuratedCorridor still feeds the
 * `isCurated` payload flag below, which the country panel renders as the
 * "We do this one often" badge, and the ranked landing grid still orders by
 * it. Those are editorial signals; this was a commercial gate, and only the
 * gate is removed.
 *
 * Returns null when the fee is absent — and the caller OMITS the key
 * entirely rather than sending null/0. A ₹0 price is a claim that the visa
 * is free; an absent price is the truth, which is "we do not quote this
 * corridor online yet, talk to us". The B2B fee is never a fallback, under
 * any condition.
 *
 * `d2cServiceFeeInr != null` (not truthiness): a deliberate ₹0 D2C service
 * fee is a real, quotable price — free service on top of real embassy costs —
 * and `!fee` would silently drop it.
 */
function buildPublicPrice(rule: any) {
  if (rule?.d2cServiceFeeInr == null) return null;

  const block = computeVisaFeeBlock(rule, "D2C");

  return {
    currency: "INR",
    // Relabelled for the consumer surface. Phase 1b deliberately left
    // computeVisaFeeBlock's own label as "Plumtrips Service Fee" because
    // changing it would have altered what every B2B customer already sees —
    // so the consumer copy is applied HERE, in the public projection, rather
    // than by mutating the shared function.
    lineItems: block.lineItems.map((li) => ({
      code: li.code,
      label: li.code === "SERVICE_FEE" ? "Service fee" : li.label,
      amountInr: li.amountInr,
    })),
    totalInr: block.totalInr,
    disclaimer: block.disclaimer ?? VISA_FEE_DISCLAIMER,
  };
}

/**
 * THE SEED RESOLVES FIRST, `normaliseToIso2` SECOND.
 *
 * ⚠ This ordering is load-bearing. `utils/countryCodes.ts` carries 120 iso2
 * entries; the seed carries 196. Resolving through `normaliseToIso2` alone
 * would 404 SEVENTY-SEVEN of the countries the map now draws — turning the
 * five-pin defect Phase 2b diagnosed (BY BJ DO GA MG, see
 * helloviza-public-map-2026-08-16.md §0(b)) into a 77-pin one.
 *
 * `countryCodes.ts` is deliberately NOT widened here: it also drives MRZ
 * parsing and the authenticated B2B visa module, so adding 77 rows to it is
 * the backend owner's call, not a consumer phase's — Phase 2b's reasoning,
 * still correct. The fallback is kept so name and alpha-3 input ("Thailand",
 * "THA") still resolve.
 *
 * EVERY public entry point resolves through here — the two GETs (where a miss
 * is a 404) and POST /visa/lead's validator and handler (where a miss is a
 * 400). A caller that resolves its own way can accept a pin the panel rejects,
 * or reject a pin the map drew. Add callers here; do not add resolvers.
 */
function resolvePublicIso2(input: unknown): string | null {
  const raw = String(input ?? "").trim().toUpperCase();
  if (findSeedCountry(raw)) return raw;
  return normaliseToIso2(String(input ?? ""));
}

router.get("/visa/country/:iso2", async (req: any, res: any) => {
  try {
    if (!isSeedReady()) {
      publicVisaLogger.error("country read refused — country seed unavailable", {
        reason: seedFailureReason(),
      });
      return res.status(503).json({ error: "Country data is unavailable" });
    }

    const iso2 = resolvePublicIso2(req.params.iso2);
    if (!iso2) {
      return res.status(404).json({ error: "Destination not found" });
    }

    const seedCountry = findSeedCountry(iso2);
    const meta = getSeedMeta();

    const rules = await VisaRule.find({
      status: "PUBLISHED",
      nationality: PUBLIC_NATIONALITY,
      destinationIso2: iso2,
    }).lean();

    if (rules.length === 0) {
      // A country we do not serve is still a real country. It gets the same
      // four tooltip fields the map gave it and `serviced: false`, so the
      // frontend renders the Request-form branch instead of a dead end.
      //
      // No documents, no documentGroups, no price, no isCurated — there is no
      // rule behind this payload, and an empty documents array would read as
      // "this visa needs no paperwork", which is a lie about the visa rather
      // than an admission about us.
      if (!seedCountry) {
        // Not in the seed and not in the catalogue: genuinely unknown.
        return res.status(404).json({ error: "Destination not found" });
      }
      return res.json({
        ok: true,
        iso2,
        countryName: seedCountry.countryName,
        destinationName: seedCountry.countryName, // 2a alias — CountryPanel reads this
        visaType: seedCountry.visaCategory,
        visaCategory: seedCountry.visaCategory,
        difficulty: difficultyFor(iso2, seedCountry.visaCategory),
        approvalChances: approvalChancesFor(iso2, seedCountry.visaCategory),
        // The three readings. Null where the corridor shows a fixed string
        // instead of a number — see approvalFiguresFor.
        approvalFigures: approvalFiguresFor(iso2, seedCountry.visaCategory),
        serviced: false,
        // ── PROVENANCE, READ-ONLY ────────────────────────────────────
        // The seed's own attribution, passed through unchanged. It was
        // already on the /map response and the country response carried
        // only two thirds of it, so the panel could print a date and a
        // disclaimer but could not say WHERE the category came from.
        // Nothing is computed here.
        source: meta.source,
        sourceUrl: meta.sourceUrl,
        lastVerified: meta.lastVerified,
        disclaimer: meta.disclaimer,
        // null for every country whose approval string is a fixed
        // phrase rather than a sourced figure — which is most of them.
      });
    }

    // Prefer a tourist-facing rule, then hand the narrowed pool to the
    // shared selector so the headline figure is the one a consumer would
    // actually be quoted.
    //
    // ⚠ The pick itself lives in utils/visaHeadlineRule.ts and is SHARED
    // with routes/consumer.applications.ts's resolveRuleFor. Both must
    // resolve identically or a consumer is quoted one price and booked at
    // another; a shared function is what makes that impossible rather than
    // merely intended. Read that file's header for the ladder and for why
    // the fallback is a preference rather than a filter.
    const touristish = (rules as any[]).filter(
      (r) => r.purpose === "TOURIST" || r.purpose === "TOURIST_OR_BUSINESS",
    );
    const candidates = touristish.length ? touristish : (rules as any[]);
    const rule = selectHeadlineRule(candidates);

    // The key field is `destinationIso2`, NOT `iso2` — VisaDestinationContent
    // does not follow VisaRule's naming here.
    const content: any = await VisaDestinationContent.findOne({
      destinationIso2: iso2,
      status: "PUBLISHED",
    })
      .select("heroImageUrl")
      .lean();

    const { documents, documentGroups } = publicDocumentRows(rule);
    const price = buildPublicPrice(rule);

    /* The tooltip fields, on the serviced branch too, so all four resolve for
     * every country on both endpoints.
     *
     * ⚠ `visaType` and `visaCategory` are NOT the same thing here, and that is
     * deliberate. `visaCategory` stays rule-derived — the frozen 2a semantics,
     * "what we will actually process for you". `visaType` is seed-derived —
     * "what an Indian passport faces", the same value the map pin used. They
     * agree almost everywhere. Where they disagree, both statements are true
     * and each is answering a different question. Reported for review in
     * helloviza-country-datalayer-2026-08-16.md §8.
     */
    const tooltipCategory: SeedVisaCategory =
      seedCountry?.visaCategory ?? rubricCategory(rule.visaCategory ?? "STICKER");

    const payload: Record<string, any> = {
      ok: true,
      iso2,
      destinationName: rule.destinationName,
      countryName: seedCountry?.countryName ?? rule.destinationName,
      visaCategory: rule.visaCategory ?? null,
      visaType: tooltipCategory,
      difficulty: difficultyFor(iso2, tooltipCategory),
      approvalChances: approvalChancesFor(iso2, tooltipCategory),
      // The three readings. Null where the corridor shows a fixed string
      // instead of a number — see approvalFiguresFor.
      approvalFigures: approvalFiguresFor(iso2, tooltipCategory),
      serviced: true,
      // Same three provenance fields as the unserviced branch above, and
      // deliberately the same values: the attribution is a property of
      // the CATALOGUE, not of whether we happen to sell this corridor.
      source: meta.source,
      sourceUrl: meta.sourceUrl,
      lastVerified: meta.lastVerified,
      disclaimer: meta.disclaimer,
      // `tooltipCategory`, not `rule.visaCategory` — the credit has to be
      // derived from the same category the DISPLAYED approval string was,
      // or the two can disagree on exactly the countries where those two
      // categories do (see the note above tooltipCategory).
      purpose: rule.purpose,
      /* THE CORRIDOR'S PURPOSES, not the chosen rule's.
       *
       * `purpose` above is scalar and belongs to the ONE rule this payload
       * resolved to (tourist-preferred, then cheapest). `purposes` is the whole
       * corridor: every customer-facing purpose its PUBLISHED rules cover, in
       * the canonical card order, deduped. Step 1 of the Apply flow renders one
       * card per entry — so a corridor is never offered a visa type no rule
       * behind it exists for.
       *
       * Derived through the same customerPurposesForRule() the authenticated
       * GET /destinations uses, from utils/visaPurposes.ts, so the consumer and
       * B2B answers cannot drift: TOURIST_OR_BUSINESS surfaces as Tourist AND
       * Business (never as its own option), and an all-TRANSIT corridor reports
       * ["TRANSIT"] alone.
       *
       * `rules` is already in hand — it was loaded above and, until now,
       * discarded after picking `rule`. No extra query.
       */
      purposes: customerPurposesForRules(rules as any[]),
      entryType: rule.entryType,
      processingTime:
        rule.etaMinDays != null || rule.etaMaxDays != null
          ? {
              minDays: rule.etaMinDays ?? null,
              maxDays: rule.etaMaxDays ?? null,
              basis: rule.etaBasis ?? null,
            }
          : null,
      maxStayDays: rule.maxStayDays ?? null,
      validityDays: rule.validityDays ?? null,
      appointmentRequired: Boolean(rule.appointmentRequired),
      biometricsRequired: Boolean(rule.biometricsRequired),
      // PUBLISHED editorial content only — a DRAFT row's image is not live.
      heroImageUrl: content?.heroImageUrl ?? null,
      isCurated: isCuratedCorridor(iso2),
      documents,
      documentGroups,
    };

    // OMITTED, not nulled — see buildPublicPrice.
    if (price) payload.price = price;

    res.json(payload);
  } catch (err: any) {
    publicVisaLogger.error("country read failed", { error: err?.message });
    res.status(500).json({ error: "Failed to load destination requirements" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /visa/lead — Milestone A's monetization hook.
 *
 * A HUMAN-CLOSED SALE, not a self-serve application: this creates NO
 * VisaRequest, NO VisaApplication and NO consumer identity. It produces the
 * same ₹0 HOUSE-tenant ManualBooking row the public travel-request form
 * produces, in the same register ops already watches — reusing
 * services/travelIntake.create.ts rather than inventing a second notification
 * path.
 *
 * Guards, in the same order routes/public.travelRequest.ts established:
 *   1. honeypot   — fake-success, so a bot learns nothing
 *   2. rate limit — travelRequestLimiter, REUSED (15 min / 8 per IP)
 *   3. Turnstile  — the shared fail-closed gate (middleware/turnstile.ts)
 *   4. validation
 * ───────────────────────────────────────────────────────────────────── */

const LEAD_INTAKE_REF_PREFIX = "hvlead";
const LEAD_CHANNEL = "HELLOVIZA_VISA_LEAD";

function isUuidV4(v: unknown): boolean {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
  );
}

function honeypotGate(req: any, res: any, next: any) {
  const trap = req.body?.hpField;
  if (typeof trap === "string" && trap.trim().length > 0) {
    const submissionId = String(req.body?.submissionId ?? "").trim();
    publicVisaLogger.warn("visa-lead — honeypot triggered, discarding silently", {
      ip: req.ip,
      hasSubmissionId: Boolean(submissionId),
    });
    // Fake success, byte-identical to the real 201 — a hard reject would
    // teach a scripted bot which field to leave blank.
    return res.status(201).json({ ok: true, reference: submissionId || undefined });
  }
  next();
}

function validateLead(p: any): string[] {
  const errors: string[] = [];

  if (!String(p?.name ?? "").trim()) errors.push("Name is required");

  const email = String(p?.email ?? "").trim();
  const phone = String(p?.phone ?? "").trim();
  // At least one reachable channel — a lead nobody can contact cannot be
  // qualified, the same rule public.travelRequest.ts applies.
  if (!email && !phone) errors.push("An email address or phone number is required");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Email address is not valid");

  // resolvePublicIso2, NOT normaliseToIso2 — the map draws all 196 seed
  // countries, so the enquiry form must accept every pin it draws. Bare
  // normaliseToIso2 rejected the 77 seed countries countryCodes.ts has no row
  // for, which is a dead Request button on 39% of the map.
  if (!resolvePublicIso2(p?.iso2)) errors.push("A valid destination is required");

  if (!isUuidV4(p?.submissionId)) errors.push("Invalid submission");

  return errors;
}

router.post(
  "/visa/lead",
  honeypotGate,
  travelRequestLimiter,
  createTurnstileGate("visa-lead"),
  async (req: any, res: any) => {
    try {
      const body = req.body ?? {};
      const errors = validateLead(body);
      if (errors.length) {
        return res.status(400).json({ error: errors.join("; "), details: errors });
      }

      // Same resolver as validateLead above — re-resolving through a
      // different function is how the two answers start to disagree.
      const iso2 = resolvePublicIso2(body.iso2)!;
      const submissionId = String(body.submissionId).trim();
      // Its own namespace — a visa lead can never false-dedupe against the
      // travel form's "public:" or the dormant HMAC endpoint's "gform:".
      const intakeRef = `${LEAD_INTAKE_REF_PREFIX}:${submissionId}`;

      const message = String(body.message ?? "").trim();
      const travelDate = body.travelDate ?? null;

      const noteParts = [`Helloviza visa lead — destination ${iso2}`];
      if (!travelDate) {
        // So ops never reads the placeholder travelDate (today) as a stated
        // intention. See travelIntake.create.ts's own fallback comment.
        noteParts.push("No travel date supplied");
      }
      if (message) noteParts.push(message);

      const result = await createIntakeBookings({
        intakeRef,
        fullName: String(body.name).trim(),
        email: String(body.email ?? "").trim() || undefined,
        mobile: String(body.phone ?? "").trim() || undefined,
        destination: iso2,
        travelDate,
        notes: noteParts.join(" | "),
        services: ["Visa"], // -> ManualBooking.type "VISA", at zero price
        channel: LEAD_CHANNEL,
        submittedAt: new Date().toISOString(),
      });

      publicVisaLogger.info("visa-lead — submission processed", {
        iso2,
        deduped: result.deduped,
        count: result.count,
      });

      // Never returns a Mongo id — only the caller's own reference.
      return res.status(201).json({ ok: true, reference: submissionId });
    } catch (err: any) {
      publicVisaLogger.error("visa-lead — processing failed", { error: err?.message });
      return res
        .status(500)
        .json({ error: "We couldn't submit your enquiry. Please try again shortly." });
    }
  },
);

export default router;
