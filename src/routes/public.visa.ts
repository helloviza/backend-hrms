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
import VisaRule, { VISA_PURPOSES, type VisaCategory } from "../models/VisaRule.js";
import VisaDestinationContent from "../models/VisaDestinationContent.js";
import { hydrateVisaChecklist } from "../utils/visaChecklistHydration.js";
import { computeVisaFeeBlock, VISA_FEE_DISCLAIMER } from "../utils/visaFee.js";
import { selectHeadlineRule } from "../utils/visaHeadlineRule.js";
import { resolveRuleFor, variantIdFor } from "../utils/visaRuleResolution.js";
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
import logger from "../utils/logger.js";

/* ── THE ENQUIRY DOOR'S DEPENDENCIES ──────────────────────────────────
 * POST /visa/lead used to import one service (travelIntake.create) and
 * write a ManualBooking. It now composes the two paths that already exist
 * for this exact work — the consumer signup sequence and the consumer
 * support case — so what it imports is the seam list, not new machinery.
 *
 * The consumer.auth.js import is a ROUTE MODULE importing another route
 * module's exported helpers, which is unusual enough to justify. Those
 * helpers were extracted and exported for precisely this reason during the
 * mobile-OTP work (routes/consumer.mobileAuth.ts is the first consumer of
 * them, and issueConsumerSession's own comment says why the session wall is
 * shared rather than reimplemented). The alternative — a second copy of the
 * signup sequence living here — is how two doors into one identity start
 * writing two different shapes of account.
 *
 * No cycle: consumer.auth.ts imports models, middleware and services, and
 * nothing under routes/. */
import bcrypt from "bcryptjs";
import Consumer from "../models/Consumer.js";
import Ticket from "../models/Ticket.js";
import { normaliseIndiaMobile } from "../services/consumerMobileOtp.js";
import {
  B2B_MARKER,
  B2B_MESSAGE,
  CONSUMER_BCRYPT_COST,
  b2bAccountExists,
  buildSignupConsent,
  issueConsumerSession,
  normalizeEmail,
  publicConsumer,
  resolveRegistrationLocation,
  stampConsumerActorLocation,
} from "./consumer.auth.js";
import {
  createConsumerSupportCase,
  isAllowedSubject,
  type ConsumerSupportSubject,
} from "../services/consumerSupport.js";

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
 * THE SERVICED-CORRIDOR PAYLOAD, built in ONE place.
 *
 * Extracted verbatim from GET /visa/country/:iso2 so that the new
 * purpose-scoped GET /visa/corridor/:iso2/:purpose returns the SAME
 * shape. Two hand-written payloads would be two vocabularies, and the
 * Apply flow reads both endpoints — a field present on one and missing
 * on the other is a blank on the page rather than a type error.
 *
 * ── WHAT VARIES AND WHAT DOES NOT ────────────────────────────────────
 * `rule` is the SELECTED rule and everything scalar comes off it:
 * purpose, entryType, processingTime, maxStay, validity, documents,
 * documentGroups and the price. `rules` is the WHOLE corridor and only
 * two fields come off it — `purposes` (Step 1 renders one card per
 * entry) and `variants` (the product axis). Those two must stay
 * corridor-wide on both endpoints: narrowing them to the selected
 * purpose would delete the reader's ability to switch visa type.
 * ───────────────────────────────────────────────────────────────────── */
function buildServicedCountryPayload(args: {
  iso2: string;
  rule: any;
  rules: any[];
  seedCountry: any;
  meta: any;
  content: any;
}): Record<string, any> {
  const { iso2, rule, rules, seedCountry, meta, content } = args;

  const { documents, documentGroups } = publicDocumentRows(rule);
  const price = buildPublicPrice(rule);

  /* ⚠ `visaType` and `visaCategory` are NOT the same thing here, and that is
   * deliberate. `visaCategory` stays rule-derived — the frozen 2a semantics,
   * "what we will actually process for you". `visaType` is seed-derived —
   * "what an Indian passport faces", the same value the map pin used. They
   * agree almost everywhere. Where they disagree, both statements are true
   * and each is answering a different question. */
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
    /* EVERY genuine visa this corridor publishes — see
     * buildPublicVariants. Additive: `purpose`, `purposes`, `price`,
     * `documents` and `documentGroups` above all still describe the
     * single HEADLINE rule and are untouched by this. */
    variants: buildPublicVariants(rules as any[]),
    documents,
    documentGroups,
  };


  // OMITTED, not nulled — see buildPublicPrice.
  if (price) payload.price = price;

  return payload;
}

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

/* ─────────────────────────────────────────────────────────────────────
 * THE VISA TYPES A CORRIDOR OFFERS.
 *
 * Until now this endpoint answered with ONE rule — the headline pick — and
 * threw the rest away. That is fine for a price, and wrong for a reader:
 * GB publishes twelve distinct visas (Tourist 6mo/2y/5y/10y, Priority ×4,
 * Super Priority ×4) and the panel showed one, with nothing to suggest the
 * other eleven existed. AU publishes three, at ₹19,610 / ₹20,200 / ₹86,193
 * — a 66,583-rupee spread the reader could not see.
 *
 * `rules` is already in hand; this adds no query.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * The display name for a variant.
 *
 * `visaTypeName` is the field that holds it (models/VisaRule.ts). Read it
 * first, and in normal operation that is the whole function.
 *
 * ── WHY THE priceNote PARSE IS STILL HERE ────────────────────────────
 * It is a TRANSITION FALLBACK, not a second source of truth. Until
 * 2026-08-31 the product name had no field of its own: ops authored it
 * into priceNote as "<product> | validity <term>", and this function
 * recovered it by splitting the pipe back off. scripts/
 * backfill-visa-type-name.ts has since populated visaTypeName on every
 * published IN rule from exactly this parse (proving equality per row
 * first, so no name on screen moved), but a rule created or imported
 * before the admin console starts authoring the new field can still arrive
 * without one — and a corridor rendering "MEET_ASSIST" because a field is
 * absent is a worse failure than one more year of a two-line fallback.
 *
 * Remove the fallback once nothing can produce a nameless rule; the parse
 * is dead weight the moment that is true, not before.
 *
 *   "Visitor Visa (Easy Apply) | validity Decided by embassy"
 *                                          -> "Visitor Visa (Easy Apply)"
 *   "Tourist Visa - 6 Months. | validity 180 days post issue"
 *                                          -> "Tourist Visa - 6 Months"
 *   "Tourist Visa."                        -> "Tourist Visa"
 *
 * Everything before the first pipe, trimmed, with a trailing full stop
 * removed (ops types it inconsistently — roughly a third of the rows carry
 * one). variantKey is the LAST resort and NOT a default: it is the field
 * the catalogue audit found disagrees with priceNote across the board
 * (AT's MEET_ASSIST reads "Appointment & Document Assistance"), so it is
 * only reached when there is neither a visaTypeName nor a priceNote.
 *
 * NOT TOUCHED HERE: priceNote's own rendering under "Total payable"
 * (utils/visaFee.ts -> FeeCard.tsx). That string stays exactly where it is.
 * Clearing it is a separate task and a careful one — 60 published rows
 * state a numeric validity term ONLY inside it, with validityDays and
 * maxStayDays both null.
 */
function variantDisplayName(rule: any): string {
  const named = String(rule?.visaTypeName ?? "").trim();
  if (named) return named;
  const note = String(rule?.priceNote ?? "").split("|")[0].trim().replace(/\.+$/, "").trim();
  if (note) return note;
  return String(rule?.variantKey ?? "").trim() || "Visa";
}

/**
 * Every genuine visa the corridor publishes, priced where ops has authored
 * a D2C fee.
 *
 * `productClass === "VISA"` is the whole filter, and it is doing real work:
 * the 2026-08-27 retype moved arrival cards, appointment services, transit
 * visas, transfers, levies and letters off that class precisely so a list
 * like this one could be built without re-deriving "is this a visa" from
 * prose. AU's Visa Transfer (VISA_AMENDMENT) and Transit 771 (TRANSIT_VISA)
 * drop out here automatically.
 *
 * UNPRICED VARIANTS ARE INCLUDED, carrying `price: null`. A corridor where
 * ops has priced nothing still has a real, knowable product list, and
 * hiding it would tell the reader the corridor offers one visa when it
 * offers twelve. Whether to show a "price on request" affordance is the
 * panel's decision; the payload's job is to say what exists.
 */
function buildPublicVariants(rules: any[]) {
  const variants = (rules ?? [])
    .filter((r) => r?.productClass === "VISA")
    .map((r) => ({
      /* NO variantKey. It is on the public leak deny-list next to opsNotes,
       * applicability and reviewedBy (see public.visa.test.ts's "NEVER
       * exposes ops/internal fields"), and that classification is right:
       * it is an ops authoring key whose values the catalogue audit found
       * routinely disagree with the product they name — AT's MEET_ASSIST
       * row reads "Appointment & Document Assistance". Publishing it would
       * put an unreliable internal taxonomy on a consumer surface.
       *
       * `name` is the identity this payload offers. If a future per-variant
       * Apply step needs a stable handle, that wants a deliberate public id,
       * not this field promoted by default. */
      name: variantDisplayName(r),
      /* THE HANDLE the Apply step selects by, and the ONE field that
       * makes a variant addressable. An opaque digest — utils/
       * visaRuleResolution.ts's variantIdFor explains why it is not the
       * variantKey (deny-listed, unreliable values) and not an array
       * index (this list re-sorts whenever ops re-prices anything).
       *
       * Safe to publish precisely because it carries no authority: it
       * names a PUBLISHED rule the corridor endpoint would serve to
       * anyone, and the server re-resolves it inside the corridor's own
       * purpose pool rather than trusting it. */
      variantId: variantIdFor(r),
      purpose: r.purpose ?? null,
      entryType: r.entryType ?? null,
      processingTime:
        r.etaMinDays != null || r.etaMaxDays != null
          ? { minDays: r.etaMinDays ?? null, maxDays: r.etaMaxDays ?? null, basis: r.etaBasis ?? null }
          : null,
      /* Carried per variant so an option card can render the same fact
       * chips the single option already showed. Without these the picker
       * would print "Maximum stay —" against every variant while the
       * one-option path beside it printed a real number, purely because
       * the payload narrowed on the way through. Nullable, and rendered
       * only when present — a corridor that states no validity gets no
       * chip rather than a dash. */
      maxStayDays: r.maxStayDays ?? null,
      validityDays: r.validityDays ?? null,
      price: buildPublicPrice(r),
    }));

  // Priced first, cheapest first; then the unpriced, alphabetically so the
  // tail is stable rather than in whatever order Mongo returned.
  return variants.sort((a, b) => {
    if (a.price && b.price) return a.price.totalInr - b.price.totalInr;
    if (a.price) return -1;
    if (b.price) return 1;
    return a.name.localeCompare(b.name);
  });
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

    const payload = buildServicedCountryPayload({
      iso2,
      rule,
      rules: rules as any[],
      seedCountry,
      meta,
      content,
    });

    res.json(payload);
  } catch (err: any) {
    publicVisaLogger.error("country read failed", { error: err?.message });
    res.status(500).json({ error: "Failed to load destination requirements" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /visa/corridor/:iso2/:purpose — THE APPLY FLOW'S PAYLOAD.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE SAME RULE THE SUBMIT WILL STORE. THAT IS THE ENTIRE POINT.
 * ══════════════════════════════════════════════════════════════════════
 *
 * ── WHY THIS EXISTS AND /country/:iso2 WAS NOT ENOUGH ────────────────
 * /country/:iso2 resolves ONE REPRESENTATIVE rule for the corridor:
 * tourist-ish preferred, then cheapest. That is the right answer for the
 * requirements slider, which is a BROWSE surface — a reader who has not
 * said which visa they want is best shown the one most people want.
 *
 * The Apply flow is not that surface. By the time it needs a document
 * checklist and a price, the reader HAS said which visa they want, and
 * showing them a different rule's answer is simply wrong. On AU it was
 * wrong in the worst possible way: the browse pool filters to TOURIST
 * before selecting, so a TRANSIT applicant was never even a candidate to
 * be shown their own rule. They saw the Tourist rule's four document
 * slots (no PHOTOGRAPH) and ₹19,610, then had an application created
 * against the Transit rule at ₹1,770 with fourteen checklist rows.
 *
 * ── HOW IT CANNOT DRIFT AGAIN ────────────────────────────────────────
 * This calls resolveRuleFor() — literally the function
 * routes/consumer.applications.ts's POST / calls to decide what to STORE.
 * Not a mirror of it, not a second implementation that shares a
 * tie-breaker: the same function, one module. Quote and charge are the
 * same computation, so they cannot disagree.
 *
 * (Sharing only selectHeadlineRule was the previous arrangement, and it
 * was believed sufficient. It was not: the tie-breaker was shared but the
 * candidate POOLS were built separately, and the pools were never equal.)
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────
 * No fallback. A corridor that publishes nothing for the requested
 * purpose 404s rather than quietly serving another purpose's rule —
 * quietly serving another purpose's rule is the bug.
 *
 * `purposes` and `variants` stay CORRIDOR-WIDE (see
 * buildServicedCountryPayload), so Step 1 can still offer every visa type
 * the corridor publishes and the reader can switch.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/visa/corridor/:iso2/:purpose", async (req: any, res: any) => {
  try {
    if (!isSeedReady()) {
      publicVisaLogger.error("corridor read refused — country seed unavailable", {
        reason: seedFailureReason(),
      });
      return res.status(503).json({ error: "Country data is unavailable" });
    }

    const iso2 = resolvePublicIso2(req.params.iso2);
    if (!iso2) {
      return res.status(404).json({ error: "Destination not found" });
    }

    /* The purpose is validated against the enum, not merely uppercased.
     * It reaches a Mongo query, and an unvalidated path segment that
     * reaches a query is how a caller gets to choose the shape of it. */
    const purpose = String(req.params.purpose ?? "").trim().toUpperCase();
    if (!VISA_PURPOSES.includes(purpose as any)) {
      return res.status(404).json({ error: "Unknown visa purpose" });
    }

    /* ── ?variant= — ONE SPECIFIC VISA, NOT THE HEADLINE ─────────────
     *
     * Absent, this behaves exactly as before: the purpose's headline
     * rule. Present, it resolves that variant — which is how the Apply
     * step gets Express's OWN documents and price rather than the
     * cheapest standard rule's.
     *
     * A re-fetch rather than shipping every variant's documentGroups in
     * variants[]: AU would carry three checklists on every corridor
     * read and CN sixteen, to render one. The list payload says what
     * EXISTS; this endpoint says what one of them ASKS FOR. */
    const variantId = String(req.query?.variant ?? "").trim() || null;

    const rule: any = await resolveRuleFor(iso2, purpose, variantId);
    if (!rule) {
      /* Two different misses, deliberately told apart. An unknown variant
       * is a stale or wrong handle — a client holding a link from before
       * ops unpublished that visa — and it must never quietly become the
       * headline, because that is a customer being shown one visa and
       * charged for another. */
      if (variantId) {
        return res.status(404).json({ error: "No published visa for that variant" });
      }
      // Serviced-or-not is not the question here: the corridor may well be
      // serviced for some OTHER purpose. This says only that it publishes
      // nothing for the one asked for.
      return res.status(404).json({ error: "No published visa for that purpose" });
    }

    /* The corridor's FULL rule set, for `purposes` and `variants` only.
     * Deliberately not purpose-filtered — see buildServicedCountryPayload. */
    const rules = await VisaRule.find({
      status: "PUBLISHED",
      nationality: PUBLIC_NATIONALITY,
      destinationIso2: iso2,
    }).lean();

    const seedCountry = findSeedCountry(iso2);
    const meta = getSeedMeta();

    const content: any = await VisaDestinationContent.findOne({
      destinationIso2: iso2,
      status: "PUBLISHED",
    })
      .select("heroImageUrl")
      .lean();

    const payload = buildServicedCountryPayload({
      iso2,
      rule,
      rules: rules as any[],
      seedCountry,
      meta,
      content,
    });

    /* ── THE FIELD THE CLIENT GATES ON ───────────────────────────────
     * The REQUESTED purpose, echoed back — not `rule.purpose`, which is
     * the rule's own stored value and legitimately differs: a TOURIST
     * request can resolve a TOURIST_OR_BUSINESS rule (purposeMatchValues
     * widens it). A client comparing rule.purpose to what it asked for
     * would read that correct answer as a mismatch and refuse to render.
     *
     * Present ONLY on this endpoint. /country/:iso2 was resolved for no
     * particular purpose and must not claim otherwise. */
    payload.resolvedForPurpose = purpose;
    /* WHICH variant this payload describes — always set, whether the
     * caller named one or took the headline. The client gates on it the
     * same way it gates on resolvedForPurpose: a payload is only allowed
     * to price and document the selection currently in hand. */
    payload.resolvedVariantId = variantIdFor(rule);

    res.json(payload);
  } catch (err: any) {
    publicVisaLogger.error("corridor read failed", { error: err?.message });
    res.status(500).json({ error: "Failed to load destination requirements" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /visa/lead — the PUBLIC ENQUIRY DOOR.
 *
 * ── WHAT THIS USED TO BE, AND WHY IT CHANGED ─────────────────────────
 * Until now this route created a ₹0 HOUSE-tenant ManualBooking and nothing
 * else: no account, no ticket, no way for the enquirer to ever see their own
 * enquiry again. The caption under the button promised "a specialist replies
 * within one business day" and the only thing backing that promise was
 * somebody remembering to watch the unassigned manual-bookings queue — there
 * was no notification, no SLA and no thread.
 *
 * It now creates a CONSUMER ACCOUNT and a SUPPORT TICKET instead. The ticket
 * lands in the same /admin/tickets queue an emailed B2B case does, with a
 * real PT ref and a 30-minute first-response SLA, and it lands on the
 * enquirer's own /account/support at the same time. The promise is the same
 * sentence; the difference is that something now carries it.
 *
 * NO ManualBooking is written any more. That is a REPLACEMENT, not an
 * addition, and deliberately so: two rows for one enquiry means two ops
 * queues, and the second one is the one nobody watches. (Verified before
 * cutover: zero HELLOVIZA_VISA_LEAD rows exist in production, so nothing is
 * orphaned by the switch.)
 *
 * ── WHAT IT COMPOSES, AND WHAT IS NEW ────────────────────────────────
 * Almost nothing here is new. It is the existing signup sequence from
 * routes/consumer.auth.ts's POST /signup followed by the existing
 * services/consumerSupport.ts case creation. The genuinely net-new part is
 * that both are reachable WITHOUT a session — every other door into either
 * sits behind requireConsumer.
 *
 * That is also why the guard chain matters more than it did: this is now an
 * ACCOUNT-CREATION endpoint on a public surface. The chain is unchanged and
 * runs in the same order routes/public.travelRequest.ts established:
 *
 *   1. honeypot   — fake-success, so a bot learns nothing
 *   2. rate limit — travelRequestLimiter, REUSED (15 min / 8 per IP)
 *   3. Turnstile  — the shared fail-closed gate (middleware/turnstile.ts)
 *   4. validation
 *
 * ── THE THREE-WAY FORK ───────────────────────────────────────────────
 * An email address is one of exactly three things, and the order is the
 * order routes/consumer.auth.ts already established — CONSUMERS FIRST, so an
 * address we already know as a consumer never reaches the B2B lookup and
 * this endpoint reveals nothing about B2B for it:
 *
 *   1. a KNOWN CONSUMER   file the case against that account, issue NO
 *                         session, answer "existing_account". We cannot log
 *                         someone in from an email address alone, and doing
 *                         it would be an account takeover with extra steps.
 *   2. a KNOWN B2B USER   the existing B2B_MARKER fork, 409. No account and
 *                         no ticket: createConsumerSupportCase needs a
 *                         consumerId and there is none to give it.
 *   3. NEW                create the consumer exactly as /signup does, file
 *                         the case, issue the session, answer "created".
 *
 * ── ORDERING, AND WHAT A FAILURE LEAVES BEHIND ───────────────────────
 * Account, THEN ticket, THEN session. There is no transaction and none is
 * wanted, because the two failure modes are not symmetrical:
 *
 *   account fails  -> nothing exists. Clean.
 *   ticket fails   -> the account exists and the caller gets a 500. That is
 *                     RECOVERABLE by design: they own an account they can
 *                     sign into and raise a case from /account/support with,
 *                     which is strictly better than rolling back an identity
 *                     they may already have a session cookie for.
 *
 * The session is issued LAST so a 500 never hands out a cookie for a
 * half-finished signup.
 * ───────────────────────────────────────────────────────────────────── */

const ENQUIRY_REF_PREFIX = "hvenq";
/**
 * MUST be a member of CONSUMER_SUPPORT_SUBJECTS — the server-side allowlist
 * in services/consumerSupport.ts is the authority on what a consumer case
 * may be about, and this door does not get to widen it. Verified against
 * that array at module load below rather than trusted from this comment.
 */
const ENQUIRY_SUBJECT: ConsumerSupportSubject = "Visa application help";

/* A typo here would be a runtime 500 on every enquiry, discovered by a
 * customer. isAllowedSubject is the same predicate the consumer router
 * applies to a submitted subject, so the two can never disagree. */
if (!isAllowedSubject(ENQUIRY_SUBJECT)) {
  throw new Error(
    `public.visa: enquiry subject "${ENQUIRY_SUBJECT}" is not in CONSUMER_SUPPORT_SUBJECTS`,
  );
}

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
    publicVisaLogger.warn("visa-enquiry — honeypot triggered, discarding silently", {
      ip: req.ip,
      hasSubmissionId: Boolean(submissionId),
    });
    /* Fake success. It answers with the EXISTING-ACCOUNT outcome rather than
     * the created one, because that is the branch with no side effects to
     * imitate: the frontend shows a "sign in to see it" note and navigates
     * nowhere, so a bot gets a plausible 201 and no session, no account and
     * no ticket. A hard reject would teach a scripted bot which field to
     * leave blank. */
    return res.status(201).json({
      ok: true,
      outcome: "existing_account",
      email: normalizeEmail(req.body?.email) || undefined,
      reference: submissionId || undefined,
    });
  }
  next();
}

function validateEnquiry(p: any): string[] {
  const errors: string[] = [];

  if (!String(p?.name ?? "").trim()) errors.push("Name is required");

  /* EMAIL IS NOW REQUIRED, where the lead form accepted email-OR-phone. It
   * is the account key: there is no way to create a consumer, or to file a
   * repliable ticket, without one. Phone survives as the optional hint the
   * signup form also collects. */
  const email = normalizeEmail(p?.email);
  if (!email) errors.push("An email address is required");
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Email address is not valid");

  // The SAME floor routes/consumer.auth.ts's /signup applies. A second,
  // looser rule on a second door is how a weak password gets in.
  const password = String(p?.password ?? "");
  if (!password) errors.push("A password is required");
  else if (password.length < 8) errors.push("Password must be at least 8 characters");

  // resolvePublicIso2, NOT normaliseToIso2 — the map draws all 196 seed
  // countries, so the enquiry form must accept every pin it draws. Bare
  // normaliseToIso2 rejected the 77 seed countries countryCodes.ts has no row
  // for, which is a dead Request button on 39% of the map.
  if (!resolvePublicIso2(p?.iso2)) errors.push("A valid destination is required");

  if (!isUuidV4(p?.submissionId)) errors.push("Invalid submission");

  return errors;
}

/**
 * The case body an agent opens.
 *
 * Built here rather than in the service because the service is channel-blind
 * — it takes a message and files it. The destination and the travel date are
 * this door's vocabulary, and an agent reading the thread needs them in the
 * first line rather than in a field they have to go looking for.
 */
function buildEnquiryMessage(args: {
  iso2: string;
  countryName: string;
  travelDate?: string | null;
  phone?: string;
  message?: string;
}): string {
  const lines = [`Country enquiry: ${args.countryName} (${args.iso2})`];
  lines.push(
    args.travelDate ? `Intended travel date: ${args.travelDate}` : "No travel date supplied",
  );
  // The number rides in the body for the same reason the callback subject's
  // does — see createConsumerSupportCase. It is also on the Consumer row as
  // the unverified signup hint, but an agent should not have to look there.
  if (args.phone) lines.push(`Phone: ${args.phone}`);
  if (args.message) {
    lines.push("");
    lines.push(args.message);
  }
  return lines.join("\n");
}

router.post(
  "/visa/lead",
  honeypotGate,
  travelRequestLimiter,
  createTurnstileGate("visa-enquiry"),
  async (req: any, res: any) => {
    try {
      const body = req.body ?? {};
      const errors = validateEnquiry(body);
      if (errors.length) {
        return res.status(400).json({ error: errors.join("; "), details: errors });
      }

      const iso2 = resolvePublicIso2(body.iso2)!;
      const countryName = findSeedCountry(iso2)?.countryName || iso2;
      const email = normalizeEmail(body.email);
      const name = String(body.name).trim();
      const password = String(body.password);
      const submissionId = String(body.submissionId).trim();
      /* Its own namespace, the same discipline the ManualBooking intakeRef
       * used: an enquiry can never false-dedupe against the travel form's
       * "public:" or the dormant HMAC endpoint's "gform:". */
      const enquiryRef = `${ENQUIRY_REF_PREFIX}:${submissionId}`;

      /* NORMALISED, NOT STORED AS TYPED — and `|| undefined` is load-bearing.
       * Verbatim from /signup, including the reason: normaliseIndiaMobile
       * returns "" for anything it cannot make an Indian ten-digit number of,
       * and "" is a PRESENT value that would sit in a sparse index rather
       * than being skipped by it. */
      const phone = normaliseIndiaMobile(body.phone) || undefined;
      const travelDate = String(body.travelDate ?? "").trim() || null;
      const message = String(body.message ?? "").trim();

      /* ── IDEMPOTENCY, BEFORE ANYTHING IS CREATED ───────────────────────
       * The submissionId is minted once per page load and re-sent on retry,
       * so a caller who resubmits after a transport failure must not file a
       * second case. Answered with the existing-account outcome, which is
       * both true by then (an account exists for this address) and the
       * branch with no side effects. */
      const priorCase = await Ticket.findOne({ "extractedFields.enquiryRef": enquiryRef })
        .select("_id ticketRef")
        .lean();
      if (priorCase) {
        publicVisaLogger.info("visa-enquiry — duplicate submission, returning prior case", {
          iso2,
          ticketRef: (priorCase as any).ticketRef,
        });
        return res.status(200).json({
          ok: true,
          outcome: "existing_account",
          email,
          ticketRef: (priorCase as any).ticketRef,
          reference: submissionId,
        });
      }

      /* ── FORK 1 — A CONSUMER WE ALREADY KNOW ───────────────────────────
       * File the case against the account they already have, and send them
       * to sign in. No session is issued and no password is checked, so the
       * `password` they typed is DISCARDED here — it is not a login
       * attempt, and treating it as one would turn this public endpoint
       * into an unrated password oracle.
       *
       * Consumers first, so this address never reaches the B2B lookup. */
      const existing = await Consumer.findOne({ email }).select("_id").lean();
      if (existing) {
        const { ticket } = await createConsumerSupportCase({
          consumerId: String((existing as any)._id),
          subject: ENQUIRY_SUBJECT,
          message: buildEnquiryMessage({ iso2, countryName, travelDate, phone, message }),
          enquiryRef,
        });

        publicVisaLogger.info("visa-enquiry — filed against existing consumer", {
          iso2,
          ticketRef: ticket.ticketRef,
        });

        return res.status(201).json({
          ok: true,
          outcome: "existing_account",
          email,
          ticketRef: ticket.ticketRef,
          reference: submissionId,
        });
      }

      /* ── FORK 2 — THE ADDRESS IS A B2B ACCOUNT ─────────────────────────
       * The same fork /signup and /login apply, with the same fixed marker
       * and the same fixed sentence. Nothing is created: there is no
       * consumerId to hang a ticket on, and silently minting a second
       * identity for someone who already has a corporate one is exactly the
       * outcome that fork exists to prevent. */
      if (await b2bAccountExists(email)) {
        return res.status(409).json({ error: B2B_MESSAGE, code: B2B_MARKER });
      }

      /* ── FORK 3 — A NEW ACCOUNT ────────────────────────────────────────
       * Byte-for-byte the /signup creation sequence. Deliberately NOT
       * factored into a shared helper in this pass: /signup is a live,
       * tested path and the right time to extract a common creator is when
       * a third door needs one, not while the second is still in review. */
      const passwordHash = await bcrypt.hash(password, CONSUMER_BCRYPT_COST);
      const marketingConsent = buildSignupConsent(body);
      /* Awaited, but BOUNDED and non-throwing — worst case it costs this
       * request 1500ms and returns undefined, which writes no field at all.
       * It cannot fail the enquiry. */
      const registrationLocation = await resolveRegistrationLocation(req);

      const consumer = await Consumer.create({
        email,
        name,
        ...(phone ? { phone } : {}),
        passwordHash,
        ...(marketingConsent ? { marketingConsent } : {}),
        ...(registrationLocation ? { registrationLocation } : {}),
      });

      // Side record, deliberately not awaited into the response path.
      void stampConsumerActorLocation(String((consumer as any)._id), req?.ip, registrationLocation);

      /* THEN the ticket. If this throws, the account survives and the caller
       * gets a 500 — see the ordering note in this route's header. */
      const { ticket } = await createConsumerSupportCase({
        consumerId: String((consumer as any)._id),
        subject: ENQUIRY_SUBJECT,
        message: buildEnquiryMessage({ iso2, countryName, travelDate, phone, message }),
        enquiryRef,
      });

      // LAST, so a failure above never hands out a cookie for a half-made
      // signup. Same signer, same cookie flags, same tokenVersion as every
      // other consumer door — see issueConsumerSession's own note on why the
      // wall is shared rather than reimplemented.
      const { accessToken } = issueConsumerSession(res, consumer as any);

      publicVisaLogger.info("visa-enquiry — account created and case filed", {
        iso2,
        ticketRef: ticket.ticketRef,
      });

      return res.status(201).json({
        ok: true,
        outcome: "created",
        consumer: publicConsumer(consumer),
        accessToken,
        ticketRef: ticket.ticketRef,
        reference: submissionId,
      });
    } catch (err: any) {
      publicVisaLogger.error("visa-enquiry — processing failed", { error: err?.message });
      return res
        .status(500)
        .json({ error: "We couldn't submit your enquiry. Please try again shortly." });
    }
  },
);

export default router;
