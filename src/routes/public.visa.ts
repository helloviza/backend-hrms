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
// The two GETs read exactly ONE collection each, both of them global
// reference data with no PII whatsoever:
//   · VisaRule                — the corridor catalogue. No traveller, no
//                               workspace, no user. Filtered to PUBLISHED.
//   · VisaDestinationContent  — editorial copy/imagery. Filtered to PUBLISHED.
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
import { isCuratedCorridor } from "../config/visaFeaturedRanking.js";
import { normaliseToIso2 } from "../utils/countryCodes.js";
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
 * GET /visa/map — every PUBLISHED corridor, for map colouring.
 *
 * No fees. No checklist. No ops fields. The .select() below is the whole
 * projection — three fields — so there is nothing else in memory to leak.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/visa/map", async (_req: any, res: any) => {
  try {
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

    const destinations = [...byIso2.entries()]
      .map(([iso2, entry]) => ({
        iso2,
        destinationName: entry.destinationName,
        visaCategory: mostPermissiveCategory(entry.categories),
        categoryIsMixed: entry.categories.size > 1,
      }))
      .sort((a, b) => a.destinationName.localeCompare(b.destinationName));

    // Legend counts, computed from the SAME resolved per-destination category
    // the pins use — so the legend can never disagree with the map it labels.
    const byCategory: Record<string, number> = {};
    for (const c of CATEGORY_PRECEDENCE) byCategory[c] = 0;
    for (const d of destinations) {
      if (d.visaCategory) byCategory[d.visaCategory] += 1;
    }

    res.json({
      ok: true,
      nationality: PUBLIC_NATIONALITY,
      generatedAt: new Date().toISOString(),
      destinations,
      stats: { total: destinations.length, byCategory },
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
      docNames: g.docNames,
    })),
  };
}

/**
 * THE PRICE GATE. Both conditions, in one place, so neither can be satisfied
 * without the other:
 *   (i)  the corridor is in the curated set (config/visaFeaturedRanking.ts)
 *   (ii) the rule carries a POPULATED d2cServiceFeeInr
 *
 * Returns null when either fails — and the caller OMITS the key entirely
 * rather than sending null/0. A ₹0 price is a claim that the visa is free;
 * an absent price is the truth, which is "we do not quote this corridor
 * online yet, talk to us". The B2B fee is never a fallback, under any
 * condition.
 *
 * `d2cServiceFeeInr != null` (not truthiness): a deliberate ₹0 D2C service
 * fee is a real, quotable price — free service on top of real embassy costs —
 * and `!fee` would silently drop it.
 */
function buildPublicPrice(rule: any, iso2: string) {
  if (!isCuratedCorridor(iso2)) return null;
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

router.get("/visa/country/:iso2", async (req: any, res: any) => {
  try {
    const iso2 = normaliseToIso2(String(req.params.iso2 || ""));
    if (!iso2) {
      return res.status(404).json({ error: "Destination not found" });
    }

    const rules = await VisaRule.find({
      status: "PUBLISHED",
      nationality: PUBLIC_NATIONALITY,
      destinationIso2: iso2,
    }).lean();

    if (rules.length === 0) {
      // Same response for "no such country" and "published nothing" — a
      // public caller learns nothing about the shape of the unpublished
      // catalogue.
      return res.status(404).json({ error: "Destination not found" });
    }

    // Prefer a tourist-facing rule, then the cheapest by D2C total so the
    // headline figure is the one a consumer would actually be quoted.
    const touristish = (rules as any[]).filter(
      (r) => r.purpose === "TOURIST" || r.purpose === "TOURIST_OR_BUSINESS",
    );
    const candidates = touristish.length ? touristish : (rules as any[]);
    const rule = candidates
      .slice()
      .sort(
        (a, b) => computeVisaFeeBlock(a, "D2C").totalInr - computeVisaFeeBlock(b, "D2C").totalInr,
      )[0];

    // The key field is `destinationIso2`, NOT `iso2` — VisaDestinationContent
    // does not follow VisaRule's naming here.
    const content: any = await VisaDestinationContent.findOne({
      destinationIso2: iso2,
      status: "PUBLISHED",
    })
      .select("heroImageUrl")
      .lean();

    const { documents, documentGroups } = publicDocumentRows(rule);
    const price = buildPublicPrice(rule, iso2);

    const payload: Record<string, any> = {
      ok: true,
      iso2,
      destinationName: rule.destinationName,
      visaCategory: rule.visaCategory ?? null,
      purpose: rule.purpose,
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

  if (!normaliseToIso2(String(p?.iso2 ?? ""))) errors.push("A valid destination is required");

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

      const iso2 = normaliseToIso2(String(body.iso2))!;
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
