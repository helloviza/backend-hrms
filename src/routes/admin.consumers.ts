// apps/backend/src/routes/admin.consumers.ts
//
// THE CONSUMER REGISTRY — every helloviza.ai account, and what they have
// done since.
//
// ══════════════════════════════════════════════════════════════════════
// WHAT THIS IS, AND WHAT admin.visa.masterSheet.ts IS
// ══════════════════════════════════════════════════════════════════════
// The master sheet is a sheet of CORRIDORS: one row per person per
// destination, and its subject is the funnel — who started, who stalled,
// which campaign sent them. A person appears on it three times if they
// looked at three countries, and not at all if they registered and did
// nothing.
//
// This is a sheet of PEOPLE: one row per Consumer, always, including the
// person who signed up and has never opened a corridor — who is invisible
// on the master sheet by construction and is exactly who a marketing read
// is looking for. The two answer different questions and neither is a
// filter of the other.
//
// ── SCOPE AND GATE ───────────────────────────────────────────────────
// Cross-consumer by design (it is a registry of everyone), gated on the
// SAME `visaApplication` READ permission the master sheet and the
// concierge queue use. No new permission key is minted: this is the same
// commercially-sensitive D2C population, viewed a third way, and a
// separate key would be a second thing to grant, revoke, and forget to
// revoke. Consumer-side row scoping (consumerId) does not apply and would
// make the surface pointless; the permission IS the boundary.
//
// ══════════════════════════════════════════════════════════════════════
// THE TWO RULES THIS FILE EXISTS TO HOLD
// ══════════════════════════════════════════════════════════════════════
//
// RULE 1 — THE LIST NEVER TOUCHES ConsumerProfile.
// -----------------------------------------------
// ConsumerProfile carries field encryption on 14 paths, and the plugin
// decrypts ONLY in post('find')/post('findOne') — aggregate, $lookup,
// $group and distinct all bypass it and return raw `penc.1.…` envelopes
// (models/ConsumerProfile.ts, plugins/fieldEncryption.plugin.ts). The list
// is a paginated, filtered, counted, aggregated read; those are exactly
// the operations that cannot decrypt. So the list is built from PLAINTEXT
// COLLECTIONS ONLY — Consumer, SavedCountry, VisaD2CLead, VisaApplication,
// none of which carry the plugin (SavedCountry's header says so in as
// many words, and says why). ConsumerProfile appears exactly once in this
// file, in the single-consumer read, via findOne.
//
// RULE 2 — MASKING IS SERVER-SIDE, IN BOTH READS.
// -----------------------------------------------
// A non-Super-Admin holding visaApplication:READ can see the registry but
// not the contact details in it. That masking happens HERE, after any
// decryption and before the value is serialised — the frontend is never
// sent the real value and therefore cannot leak it, cache it, or be
// patched to reveal it.
//
// ⚠ THE LIST IS MASKED TOO, AND THAT IS THE WHOLE POINT. Masking only the
// detail would be theatre: `GET /admin/consumers?limit=100` would hand
// back every email in plaintext and the tier would mean nothing. Rule 1
// (no encrypted reads in the list) and Rule 2 (masking in the list) are
// independent requirements and both hold. The same posture already exists
// in routes/manualBookings.ts, which masks passenger PII in its list and
// hands SUPERADMIN the full values.
//
// There is no `?unmask=` escape, no debug flag, and no sibling field
// carrying the raw value beside the masked one. The masked string is the
// only representation that leaves this process.
//
// ── WHAT MASKING IS NOT ──────────────────────────────────────────────
// It is a RESPONSE transform. Nothing here writes, and the stored values
// are untouched — a later campaign sender reading Consumer.email
// server-side gets the real address, because it never goes through this
// file. Masking governs what reaches a SCREEN, not what the system knows.
import { Router } from "express";
import mongoose from "mongoose";

import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import Consumer, { CONSUMER_AUTH_PROVIDERS, CONSUMER_STATUSES } from "../models/Consumer.js";
import ConsumerProfile from "../models/ConsumerProfile.js";
import SavedCountry from "../models/SavedCountry.js";
import VisaD2CLead from "../models/VisaD2CLead.js";
import VisaApplication from "../models/VisaApplication.js";
import {
  D2C_PAYMENT_STATUS_LABELS,
  D2C_STAGE_LABELS,
  D2C_TRACKING_STATUS_LABELS,
} from "../models/visaD2CLifecycle.js";
import { shapeD2CApplicant } from "./admin.visa.js";
import { maskDateOfBirth, maskEmailAddress, maskPhoneNumber, maskTailId } from "../utils/piiMask.js";
import { objectIdKeys } from "../utils/objectIdKeys.js";
import logger from "../utils/logger.js";

const router = Router();
router.use(requireAuth);

const registryLogger = logger.child({ module: "adminConsumers" });

/* ─────────────────────────────────────────────────────────────────────
 * Consent, as the registry reads it.
 *
 * THE ONE PLACE absent AND false COLLAPSE. models/Consumer.ts writes no
 * default and no `optedIn: false` record — an unticked box leaves the
 * whole block off the document. Every reader therefore has to treat
 * "absent" as "not opted in", and doing that in one function is what
 * stops a filter and a badge disagreeing about the same consumer.
 *
 * The evidence fields (at/source/version) ride along so the detail view
 * can show WHEN and on WHAT WORDING somebody agreed, which is the only
 * thing that makes a consent record worth storing.
 * ───────────────────────────────────────────────────────────────────── */
function consentChannelView(entry: any) {
  return {
    optedIn: entry?.optedIn === true,
    at: entry?.at ?? null,
    source: entry?.source ?? null,
    version: entry?.version ?? null,
  };
}

function consentView(consumer: any) {
  return {
    email: consentChannelView(consumer?.marketingConsent?.email),
    whatsapp: consentChannelView(consumer?.marketingConsent?.whatsapp),
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * Registration location, as the registry reads it.
 *
 * ABSENT AND BLANK COLLAPSE TO ONE SHAPE, exactly as consent does — but
 * `located` is kept as its own boolean so the client can say "Unknown"
 * rather than rendering an em-dash that reads like a data bug. A consumer
 * who registered before this field existed, or through a private IP, or
 * during a cold-start timeout, is genuinely unlocated; that is a fact
 * about our lookup, not about them.
 *
 * NOT masked by the PII tier. City/region/country are coarse and shared by
 * millions — see models/Consumer.ts on why they are plaintext. The IP that
 * produced them is never stored here at all.
 * ───────────────────────────────────────────────────────────────────── */
function locationView(consumer: any) {
  const l = consumer?.registrationLocation;
  const city = l?.city ?? l?.rawCity ?? null;
  return {
    located: Boolean(l && (l.city || l.rawCity || l.country)),
    city,
    region: l?.region ?? null,
    country: l?.country ?? null,
    source: l?.source ?? null,
    confidence: l?.confidence ?? null,
    reason: l?.reason ?? null,
    capturedAt: l?.capturedAt ?? null,
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * THE TIER. Decided once per request.
 *
 * `isSuperAdmin(req)` is the canonical check — middleware/isSuperAdmin.ts,
 * the same function requirePermission() itself uses for its bypass, so a
 * caller who is Super Admin ENOUGH to skip the permission gate is Super
 * Admin enough to see the values, and there is no third state where those
 * two disagree. It reads roles[] / role / isSuperAdmin, and refuses the
 * bypass while a demo impersonation is active — a nuance a hand-rolled
 * `roles.includes("SUPERADMIN")` here would have lost, and the reason this
 * file does not write one.
 *
 * Tier 3 (no visaApplication:READ at all) never reaches these lines; it is
 * answered by requirePermission() with a 403.
 * ───────────────────────────────────────────────────────────────────── */
function canSeeFullPii(req: any): boolean {
  return isSuperAdmin(req);
}

/** Full value, or the masked one. The ternary that IS the access tier. */
function piiEmail(value: unknown, full: boolean): string | null {
  return full ? ((value as string) ?? null) : maskEmailAddress(value);
}
function piiPhone(value: unknown, full: boolean): string | null {
  return full ? ((value as string) ?? null) : maskPhoneNumber(value);
}

/* ─────────────────────────────────────────────────────────────────────
 * THE DERIVED COUNTS — three $in aggregations over PLAINTEXT collections.
 *
 * Every one of these is safe to aggregate, and each was checked rather
 * than assumed (Rule 1 above):
 *
 *   SavedCountry    — plaintext. Its own header states it carries no
 *                     encryption marker and no plugin, and gives this
 *                     exact reason: so the saved list can be counted with
 *                     ordinary Mongo.
 *   VisaD2CLead     — plaintext. No plugin; every field is a corridor, a
 *                     stage enum, or a UTM tag.
 *   VisaApplication — plaintext. No plugin. Its PII lives by REFERENCE
 *                     (travellerProfileId / consumerId), never inline.
 *
 * ── WHY THREE ROUND TRIPS AND NOT ONE $lookup ─────────────────────────
 * A $lookup would be one query, and would also be the exact shape Rule 1
 * forbids — the moment somebody adds a fourth join and that one happens to
 * be ConsumerProfile, ciphertext is on the screen and nothing failed
 * loudly. Three explicit aggregations over three named plaintext
 * collections cannot drift into that; the encrypted collection is not
 * reachable from here.
 *
 * ── SCOPED TO THE PAGE, NOT THE COLLECTION ────────────────────────────
 * Each one is $in'd against the ~50 ids on the current page, so the cost
 * is bounded by page size rather than by how many consumers exist.
 * ───────────────────────────────────────────────────────────────────── */
async function deriveCounts(consumerIds: mongoose.Types.ObjectId[]) {
  if (!consumerIds.length) {
    return {
      saved: new Map<string, any>(),
      leads: new Map<string, any>(),
      applications: new Map<string, any>(),
    };
  }

  const [savedRows, leadRows, applicationRows] = await Promise.all([
    SavedCountry.aggregate([
      { $match: { consumerId: { $in: consumerIds } } },
      { $group: { _id: "$consumerId", count: { $sum: 1 } } },
    ]),

    /* Count AND the latest row's stage/payment in one pass. $sort BEFORE
     * $group, with $first — the documented way to take "the newest per
     * group" in Mongo. Sorting after the group would sort the groups, not
     * pick within them, which is the classic wrong answer here.
     *
     * startedAt DESC matches the master sheet's own default ordering, so
     * "latest lead" means the same thing on both screens. */
    VisaD2CLead.aggregate([
      { $match: { consumerId: { $in: consumerIds } } },
      { $sort: { startedAt: -1 } },
      {
        $group: {
          _id: "$consumerId",
          count: { $sum: 1 },
          latestStage: { $first: "$stage" },
          latestPaymentStatus: { $first: "$paymentStatus" },
          latestStatus: { $first: "$status" },
          latestDestinationIso2: { $first: "$destinationIso2" },
          latestStartedAt: { $first: "$startedAt" },
        },
      },
    ]),

    VisaApplication.aggregate([
      { $match: { consumerId: { $in: consumerIds } } },
      { $group: { _id: "$consumerId", count: { $sum: 1 } } },
    ]),
  ]);

  const toMap = (rows: any[]) => new Map<string, any>(rows.map((r) => [String(r._id), r]));
  return { saved: toMap(savedRows), leads: toMap(leadRows), applications: toMap(applicationRows) };
}

/* ─────────────────────────────────────────────────────────────────────
 * GET / — the registry list.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const full = canSeeFullPii(req);
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));

    const filter: Record<string, any> = {};

    /* ⚠ EVERY MULTI-CLAUSE FILTER GOES THROUGH THIS ARRAY, NEVER through
     * `filter.$or` directly.
     *
     * Two filters below each need an OR, and a document has exactly one
     * `$or` key: `consent=any&authProvider=password` would have had the
     * second assignment silently overwrite the first, returning rows that
     * match only one of the two filters the caller asked for. Wrong
     * results, no error, and a filter combination nobody tests by hand.
     * Collecting them into $and makes every clause additive by
     * construction. */
    const and: Array<Record<string, any>> = [];

    /* ?consent=email|whatsapp|any|none
     *
     * Expressed against `optedIn: true` rather than against the PRESENCE
     * of the block, because presence is not consent — a block could later
     * be written by a preference centre recording a WITHDRAWAL, and a
     * presence test would then count somebody who opted out. `none` is the
     * exact negation of `any`, written with $ne so it also catches every
     * row where the field is absent entirely (which is most of them, and
     * is the whole point). */
    if (req.query.consent != null && String(req.query.consent).trim() !== "") {
      const v = String(req.query.consent).trim().toLowerCase();
      if (v === "email") filter["marketingConsent.email.optedIn"] = true;
      else if (v === "whatsapp") filter["marketingConsent.whatsapp.optedIn"] = true;
      else if (v === "any") {
        and.push({
          $or: [
            { "marketingConsent.email.optedIn": true },
            { "marketingConsent.whatsapp.optedIn": true },
          ],
        });
      } else if (v === "none") {
        filter["marketingConsent.email.optedIn"] = { $ne: true };
        filter["marketingConsent.whatsapp.optedIn"] = { $ne: true };
      } else {
        return res.status(400).json({ error: "consent must be one of email, whatsapp, any, none" });
      }
    }

    if (req.query.authProvider != null && String(req.query.authProvider).trim() !== "") {
      const v = String(req.query.authProvider).trim().toLowerCase();
      if (!(CONSUMER_AUTH_PROVIDERS as readonly string[]).includes(v)) {
        return res
          .status(400)
          .json({ error: `authProvider must be one of ${CONSUMER_AUTH_PROVIDERS.join(", ")}` });
      }
      /* ── ABSENT MEANS "password", IN THE FILTER AS WELL AS THE BADGE ──
       * models/Consumer.ts defaults authProvider to "password" precisely
       * so rows written before Google sign-in existed read correctly with
       * no backfill — but a DEFAULT only applies to documents Mongoose
       * writes. Rows inserted before the field existed have no
       * authProvider at all, and three of the consumers on this system do.
       *
       * The row shaping below already collapses that to "password"
       * (`c.authProvider ?? "password"`), so without this the list would
       * SHOW those consumers as "Email" while `?authProvider=password`
       * refused to return them — the filter and the badge disagreeing
       * about the same row, which reads as a broken filter. The exact
       * shape of the consent filter's absent-means-not-opted-in rule, for
       * the same reason. */
      filter.authProvider =
        v === "password" ? ({ $in: ["password", null] } as any) : v;
    }

    if (req.query.status != null && String(req.query.status).trim() !== "") {
      const v = String(req.query.status).trim().toUpperCase();
      if (!(CONSUMER_STATUSES as readonly string[]).includes(v)) {
        return res
          .status(400)
          .json({ error: `status must be one of ${CONSUMER_STATUSES.join(", ")}` });
      }
      filter.status = v;
    }

    /* ?country=IN — the marketing segment.
     *
     * Uppercased to match the model's own `uppercase: true` on write, so a
     * lowercase query string still finds its rows. Consumers with NO
     * location never match any country value, which is correct: "unlocated"
     * is not a country and must not be swept into one. */
    if (req.query.country != null && String(req.query.country).trim() !== "") {
      const v = String(req.query.country).trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(v)) {
        return res.status(400).json({ error: "country must be an ISO-3166-1 alpha-2 code" });
      }
      filter["registrationLocation.country"] = v;
    }

    /* ?located=true|false — "who could we place at all", the coverage
     * question this data's own reliability depends on.
     *
     * Expressed on the BLOCK's existence, not on a field inside it: the
     * signup path writes the whole block or none of it (see
     * resolveRegistrationLocation), so presence is exactly the predicate.
     * Deliberately its own key rather than folded into the country filter
     * above — combining ?country=IN&located=true then simply ANDs two
     * compatible clauses instead of one overwriting the other. */
    if (req.query.located === "true") and.push({ registrationLocation: { $exists: true } });
    else if (req.query.located === "false") and.push({ registrationLocation: { $exists: false } });

    /* ?hasApplied=true|false
     *
     * A pre-pass, not a join. "Has this person ever filed an application"
     * is a fact about ANOTHER collection, and the registry's own sort and
     * pagination have to run against Consumer — so the set of applicant
     * ids is resolved first and $in'd (or $nin'd) into the Consumer
     * filter. distinct() on VisaApplication is safe: that collection is
     * plaintext, and the field is an ObjectId reference (Rule 1 above).
     *
     * Cost is honest and worth naming: the set grows with the number of
     * consumers who HAVE applied. That is a small set for as long as
     * applying is the rare event; the day it is not, this becomes a stored
     * counter on Consumer. */
    if (req.query.hasApplied === "true" || req.query.hasApplied === "false") {
      const appliedIds = await VisaApplication.distinct("consumerId", { consumerId: { $ne: null } });
      const ids = objectIdKeys(appliedIds);
      filter._id = req.query.hasApplied === "true" ? { $in: ids } : { $nin: ids };
    }

    if (and.length) filter.$and = and;

    const total = await Consumer.countDocuments(filter);

    /* Newest first, on the index added to models/Consumer.ts for exactly
     * this sort. `.lean()` — Consumer is plaintext, so there is no
     * decryption hook needing a hydrated document, and nothing below calls
     * a document method. */
    const rows = await Consumer.find(filter)
      .select("email name phone authProvider status marketingConsent registrationLocation createdAt")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    /* ⚠ REAL ObjectIds, NOT the strings objectIdKeys() returns.
     *
     * find() casts an $in against the path's schema type; AGGREGATE DOES
     * NOT. A pipeline handed `{ $in: ["68b1…", …] }` against an ObjectId
     * field matches nothing at all and returns an empty result — so every
     * derived count would read 0, on every row, with no error anywhere.
     * A silent zero is the worst possible failure for a count column:
     * "this consumer has saved nothing" is a plausible answer, so nobody
     * would ever question it.
     *
     * objectIdKeys() still runs first — it is what drops nulls and
     * uncastable values, so the constructor below cannot throw. */
    const consumerIds = objectIdKeys(rows.map((r: any) => r._id)).map(
      (key) => new mongoose.Types.ObjectId(key),
    );
    const derived = await deriveCounts(consumerIds);

    const shaped = rows.map((c: any) => {
      const key = String(c._id);
      const lead = derived.leads.get(key);
      return {
        id: key,
        name: c.name ?? null,
        // Rule 2. Masked for every reader who is not Super Admin, in the
        // LIST as well as the detail — see this file's header.
        email: piiEmail(c.email, full),
        phone: piiPhone(c.phone, full),
        // So the client can render a "hidden" affordance honestly instead
        // of guessing from the bullets. It never changes what was sent.
        piiMasked: !full,

        authProvider: c.authProvider ?? "password",
        status: c.status ?? "ACTIVE",
        registeredAt: c.createdAt ?? null,

        marketingConsent: consentView(c),
        // Plaintext, and NOT masked — see locationView's own note.
        location: locationView(c),

        // The derived block — three plaintext aggregations, above.
        savedCountryCount: derived.saved.get(key)?.count ?? 0,
        leadCount: lead?.count ?? 0,
        applicationCount: derived.applications.get(key)?.count ?? 0,

        /* Stored enum PLUS its label, the convention the master sheet set:
         * the console renders labels and holds no copy of the vocabulary,
         * so a wording change lands in one file. */
        latestLead: lead
          ? {
              stage: lead.latestStage ?? null,
              stageLabel:
                D2C_STAGE_LABELS[lead.latestStage as keyof typeof D2C_STAGE_LABELS] ??
                lead.latestStage ??
                null,
              paymentStatus: lead.latestPaymentStatus ?? null,
              paymentStatusLabel:
                D2C_PAYMENT_STATUS_LABELS[
                  lead.latestPaymentStatus as keyof typeof D2C_PAYMENT_STATUS_LABELS
                ] ??
                lead.latestPaymentStatus ??
                null,
              status: lead.latestStatus ?? null,
              statusLabel:
                D2C_TRACKING_STATUS_LABELS[
                  lead.latestStatus as keyof typeof D2C_TRACKING_STATUS_LABELS
                ] ??
                lead.latestStatus ??
                null,
              destinationIso2: lead.latestDestinationIso2 ?? null,
              startedAt: lead.latestStartedAt ?? null,
            }
          : null,
      };
    });

    /* Counts over the WHOLE filtered set, not the page — the master
     * sheet's rule, for the same reason: totals that changed as you paged
     * would be worse than no totals. */
    /* ⚠ $and, NOT a spread. `{ ...filter, "marketingConsent.email.optedIn":
     * true }` looks equivalent and is not: under ?consent=none the base
     * filter already holds that exact key as `{ $ne: true }`, and the
     * spread would OVERWRITE it — reporting "3 opted in" above a table of
     * people who have not opted in. Wrapping instead of merging means the
     * base filter can never be contradicted by the count sitting on top
     * of it, whatever keys the two happen to share. */
    const [optedInEmail, optedInWhatsapp] = await Promise.all([
      Consumer.countDocuments({ $and: [filter, { "marketingConsent.email.optedIn": true }] }),
      Consumer.countDocuments({ $and: [filter, { "marketingConsent.whatsapp.optedIn": true }] }),
    ]);

    return res.json({
      ok: true,
      rows: shaped,
      summary: { total, optedInEmail, optedInWhatsapp },
      // Stated on the response, not inferred by the client from a bulleted
      // string. A client that wants to say "hidden — Super Admin only"
      // should be told, not left to pattern-match on •.
      viewer: { canSeeFullPii: full },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err: any) {
    registryLogger.error("consumer registry list failed", { error: err?.message });
    return res.status(500).json({ error: "Failed to load the consumer registry" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /:id — one consumer, in full.
 *
 * ⚠ THE ONLY PLACE IN THIS FILE THAT READS ConsumerProfile, and it does so
 * with findOne and nothing else. Decryption happens in the plugin's
 * post('findOne') hook; an aggregate or a $lookup here would return
 * `penc.1.…` envelopes and put ciphertext on an agent's screen. The same
 * rule, at the same kind of call site, as routes/admin.visa.ts's D2C
 * branch — and the projection below keeps `consumerId` for the same reason
 * that one does: it is the DECRYPTION SUBJECT, and a projection that drops
 * it while keeping an encrypted path makes the plugin throw.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/:id", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const full = canSeeFullPii(req);
    const id = String(req.params.id || "");
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid consumer id" });
    }

    const consumer: any = await Consumer.findById(id)
      .select("email name phone authProvider googleSub status marketingConsent registrationLocation createdAt updatedAt")
      .lean();
    if (!consumer) return res.status(404).json({ error: "Consumer not found" });

    const consumerObjectId = new mongoose.Types.ObjectId(id);

    const [profile, savedCountries, leads, applications] = await Promise.all([
      // findOne, NOT aggregate. See the block comment above.
      ConsumerProfile.findOne({ consumerId: consumerObjectId })
        .select("consumerId personal passports contact")
        .lean(),
      SavedCountry.find({ consumerId: consumerObjectId })
        .select("iso2 source createdAt")
        .sort({ createdAt: -1 })
        .lean(),
      VisaD2CLead.find({ consumerId: consumerObjectId }).sort({ startedAt: -1 }).lean(),
      VisaApplication.find({ consumerId: consumerObjectId })
        .select("referenceNumber status destinationIso2 nationality source createdAt submittedAt")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    /* THE SHARED SHAPE. shapeD2CApplicant() is routes/admin.visa.ts's own
     * function, exported rather than reimplemented, so this page renders a
     * consumer's identity byte-for-byte the way the concierge console
     * renders the same person on a case.
     *
     * It is handed the LATEST application because `nationality` is read off
     * the application on purpose — it is the value the visa rule was
     * resolved against, not the free text a consumer typed into their
     * profile. A consumer with no application passes null and gets a null
     * nationality, which is the true answer. */
    const applicant = shapeD2CApplicant((applications as any[])[0] ?? null, consumer, profile);

    /* ── THE MASK, APPLIED ONCE, HERE ─────────────────────────────────
     * After the decryption above, before the response below. A
     * non-Super-Admin's response body never contains a real address, a
     * real number, a real passport number, or a real date of birth — not
     * in this object and not in a sibling.
     *
     * ── WHY THE PASSPORT'S *OTHER* FIELDS SURVIVE ────────────────────
     * The NUMBER is the identifier and is masked to last-4 (maskTailId,
     * the same convention manualBookings and the TravellerProfile export
     * already use). Issuing country, issue date and expiry are not
     * identifiers — they are document facts an agent needs to answer "is
     * this person's book still valid?", and the concierge console already
     * shows them to every visaApplication:READ holder. Hiding them here
     * would restrict below the existing posture while protecting nothing
     * the number does not already protect. */
    const identity = applicant
      ? {
          ...applicant,
          email: piiEmail(applicant.email, full),
          dob: full ? applicant.dob : maskDateOfBirth(applicant.dob),
          passportNo: full ? applicant.passportNo : (maskTailId(applicant.passportNo) ?? null),
        }
      : null;

    return res.json({
      ok: true,
      consumer: {
        id: String(consumer._id),
        name: consumer.name ?? null,
        email: piiEmail(consumer.email, full),
        phone: piiPhone(consumer.phone, full),
        authProvider: consumer.authProvider ?? "password",
        // Presence only, NEVER the value. A Google `sub` is a stable
        // account identifier; the useful fact is "this account is linked",
        // and that fact is a boolean.
        googleLinked: Boolean(consumer.googleSub),
        status: consumer.status ?? "ACTIVE",
        registeredAt: consumer.createdAt ?? null,
        updatedAt: consumer.updatedAt ?? null,
        piiMasked: !full,
        marketingConsent: consentView(consumer),
        // The fuller block on the detail: source/confidence/reason are how an
        // agent tells "we placed them in Delhi" from "we timed out and know
        // nothing", which a bare city string cannot express.
        location: locationView(consumer),
      },

      identity,

      contact: {
        // The profile's own mobile — the ENCRYPTED one
        // (ConsumerProfile.contact.mobile), decrypted by the findOne above
        // and masked on the way out for anyone but a Super Admin.
        mobile: piiPhone((profile as any)?.contact?.mobile, full),
        mobileVerified: Boolean((profile as any)?.contact?.mobileVerified),
        alternateEmail: piiEmail((profile as any)?.contact?.alternateEmail, full),
        hasProfile: Boolean(profile),
      },

      savedCountries: (savedCountries as any[]).map((s) => ({
        iso2: s.iso2,
        source: s.source ?? null,
        savedAt: s.createdAt ?? null,
      })),

      leads: (leads as any[]).map((l) => ({
        id: String(l._id),
        destinationIso2: l.destinationIso2,
        destinationName: l.destinationName,
        purpose: l.purpose ?? null,
        status: l.status,
        statusLabel:
          D2C_TRACKING_STATUS_LABELS[l.status as keyof typeof D2C_TRACKING_STATUS_LABELS] ??
          l.status,
        stage: l.stage,
        stageLabel: D2C_STAGE_LABELS[l.stage as keyof typeof D2C_STAGE_LABELS] ?? l.stage,
        paymentStatus: l.paymentStatus,
        paymentStatusLabel:
          D2C_PAYMENT_STATUS_LABELS[l.paymentStatus as keyof typeof D2C_PAYMENT_STATUS_LABELS] ??
          l.paymentStatus,
        hasTicket: Boolean(l.applicationId),
        referenceNumber: l.referenceNumber ?? null,
        utm: {
          source: l.utm?.source ?? "",
          medium: l.utm?.medium ?? "",
          campaign: l.utm?.campaign ?? "",
        },
        startedAt: l.startedAt ?? null,
        submittedAt: l.submittedAt ?? null,
      })),

      applications: (applications as any[]).map((a) => ({
        id: String(a._id),
        referenceNumber: a.referenceNumber ?? null,
        status: a.status ?? null,
        destinationIso2: a.destinationIso2 ?? null,
        source: a.source ?? null,
        createdAt: a.createdAt ?? null,
        submittedAt: a.submittedAt ?? null,
      })),

      viewer: { canSeeFullPii: full },
    });
  } catch (err: any) {
    registryLogger.error("consumer registry detail failed", { error: err?.message });
    return res.status(500).json({ error: "Failed to load the consumer" });
  }
});

export default router;
