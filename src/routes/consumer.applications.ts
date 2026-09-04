// apps/backend/src/routes/consumer.applications.ts
//
// THE D2C APPLICATION ENDPOINTS. Mounted at /api/consumer/applications
// behind requireConsumer.
//
// ══════════════════════════════════════════════════════════════════════
// A-PRIME: A D2C SUBMIT MINTS **BOTH** A VisaRequest AND A VisaApplication.
// ══════════════════════════════════════════════════════════════════════
// The alternative — a request-less application — would have made the case
// invisible to routes/admin.visa.roster.ts (which walks requests → their
// applications) and would have silently dropped it from every
// destination-filtered report (admin.visa.reports.ts resolves a
// destination into a set of requestIds). Minting a lightweight parent
// costs one insert and lets a D2C ticket slot into the ops pipeline with
// no ops-side branching at all.
//
// The parent is LIGHTWEIGHT, not a fake B2B request: raisedByUserId is
// null (a Consumer is not a User, and inventing a system User would name
// an actor who did not act), consumerId is set, and `source` is "D2C" on
// both rows.
//
// ── WHAT THIS ENDPOINT REFUSES TO TRUST ──────────────────────────────
// The client sends an ISO2, a purpose and a list of its own document ids.
// It does NOT send a rule id, a price, a fee breakup or a total, and this
// route would ignore them if it did. The rule is RE-RESOLVED server-side
// by the same tourist-preferred/cheapest-by-D2C-total rule the public
// country endpoint uses (routes/public.visa.ts), and the price is computed
// from that rule. A consumer-supplied price is a consumer-supplied
// invoice.
//
// ── OWN-SCOPE, STATED LITERALLY ──────────────────────────────────────
// Every read here filters on { consumerId, workspaceId } as explicit
// clauses. The workspaceScope plugin cannot be relied on: it injects only
// when a query carries `_workspaceId` in its options and otherwise FAILS
// OPEN. And workspaceId alone is not an isolation boundary anyway — every
// consumer shares the one synthetic D2C workspace, so consumerId is the
// real fence (services/consumerWorkspace.ts says so in its own header).
//
// ── MILESTONE 2 (RAZORPAY) PLUGS IN HERE ─────────────────────────────
// Nothing in this file takes money. An application is created at
// paymentStatus "PENDING" and stage "DOC_SUBMITTED"; the payment stages
// (PAYMENT_FAILED / PAYMENT_DROPPED / PAYMENT_DONE) and the order-creation
// call belong to Milestone 2. Every place that will need to change is
// marked `TODO(milestone-2)`.
import { Router } from "express";
import mongoose from "mongoose";

import { requireConsumer } from "../middleware/requireConsumer.js";
import VisaRule from "../models/VisaRule.js";
import VisaRequest, { recomputeRequestStatus } from "../models/VisaRequest.js";
import VisaApplication from "../models/VisaApplication.js";
import ConsumerDocument from "../models/ConsumerDocument.js";
import VisaDocument, { subjectFromApplication } from "../models/VisaDocument.js";
// The ops-side row minted from a locker attachment — the bytes are shared,
// so this is the "already stored elsewhere" half of the B2B upload helper,
// never the uploading half. See the mint block in POST /.
import { createVisaDocumentRow } from "./visa.js";
import ConsumerProfile from "../models/ConsumerProfile.js";
import VisaD2CLead from "../models/VisaD2CLead.js";
import VisaActivityLog from "../models/VisaActivityLog.js";
import { isUtmEmpty, normaliseUtm } from "../models/visaUtm.js";
import { d2cWorkspaceObjectId } from "../services/consumerWorkspace.js";
import {
  D2C_PAYMENT_STATUS_LABELS,
  D2C_STAGE_LABELS,
  D2C_TRACKING_STATUS_LABELS,
} from "../models/visaD2CLifecycle.js";
import { buildIndicativeCostSnapshot, buildRuleSnapshot } from "../utils/visaSnapshots.js";
import { computeProcessingDeadline } from "../utils/visaEta.js";
import { findSeedCountry } from "../config/visaCountrySeed.js";
import { normaliseToIso2 } from "../utils/countryCodes.js";
import logger from "../utils/logger.js";

const router = Router();
router.use(requireConsumer);

const consumerAppLogger = logger.child({ module: "consumerApplications" });

/** Same constant the public endpoints declare — every published rule is IN. */
const PUBLIC_NATIONALITY = "IN";

/** The purposes a consumer may actually pick. TOURIST_OR_BUSINESS is a RULE
 *  shape, never a choice — the public endpoint already widened it into the
 *  two real ones before the client ever saw it. */
const SELECTABLE_PURPOSES = ["TOURIST", "BUSINESS", "TRANSIT"] as const;

function me(req: any): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(String(req.consumer.id));
}

/**
 * Resolve the corridor's representative rule for a purpose.
 *
 * ── THIS MIRRORS routes/public.visa.ts DELIBERATELY ───────────────────
 * That endpoint picks tourist-ish first, then the cheapest by D2C total,
 * and returns the terms the consumer was SHOWN. If this route resolved
 * differently, a consumer could be quoted ₹1,770 on the panel and have an
 * application created against a different rule at a different price — the
 * exact mismatch re-resolving server-side is meant to prevent.
 *
 * The one difference is the purpose filter: the public endpoint resolves
 * the corridor as a whole, this one resolves it for the purpose the
 * consumer actually chose. purposeMatchValues widens TOURIST to also match
 * a TOURIST_OR_BUSINESS rule, which is the same widening GET /rules
 * applies (utils/visaPurposes.ts) — so a corridor whose only rule is
 * TOURIST_OR_BUSINESS is bookable as either, exactly as the cards offered.
 */
/* MOVED to utils/visaRuleResolution.ts, and re-exported here unchanged.
 *
 * It moved because GET /visa/corridor/:iso2/:purpose — the endpoint the
 * Apply flow now reads its documents and price from — must resolve the
 * SAME rule this route stores, and a resolver living inside a consumer
 * route file cannot be called from the public one without dragging a
 * whole authenticated router into the public module graph.
 *
 * Re-exported rather than relocated at the call sites so
 * routes/visaHeadlineSelection.test.ts keeps importing it from here —
 * that test asserts this path and the public headline path agree, which
 * is exactly the property the move protects. */
import { resolveRuleFor } from "../utils/visaRuleResolution.js";
export { resolveRuleFor };

/**
 * The fields VisaRuleSnapshot marks `required` that a VisaRule can be
 * PUBLISHED without actually carrying.
 *
 * ── WHY THIS CHECK EXISTS, AND WHY IT IS NOT A WORKAROUND ────────────
 * Found while building this endpoint: the live VN rule has no
 * `isSchengen` at all. VisaRule declares it `{type: Boolean, default:
 * false}`, but a default only applies to a document written THROUGH
 * Mongoose — VN was seeded/imported directly, so the key is simply
 * absent. VisaRuleSnapshot.isSchengen is `required: true`, so building a
 * snapshot from that rule throws a ValidationError.
 *
 * ⚠ THIS IS PRE-EXISTING AND NOT D2C-SPECIFIC. routes/visa.ts's B2B POST
 * /requests calls the SAME buildRuleSnapshot and fails the same way on
 * the same rule — the extraction into utils/visaSnapshots.ts is verbatim
 * (diffed against HEAD). D2C simply reached the defect first, because VN
 * is one of only two published corridors in this environment.
 *
 * So this does NOT patch the snapshot (that would change B2B behaviour
 * and silently invent an isSchengen value for a corridor nobody has
 * checked). It fails EARLY, with a message a consumer can act on and a
 * warning an ops reader can fix the rule from. The real repair is a data
 * one: set isSchengen on the offending rules.
 */
const SNAPSHOT_REQUIRED_RULE_FIELDS = [
  "destinationName",
  "isSchengen",
  "productClass",
  "visaCategory",
  "purpose",
  "entryType",
  "serviceTier",
] as const;

function missingSnapshotFields(rule: any): string[] {
  return SNAPSHOT_REQUIRED_RULE_FIELDS.filter((f) => rule?.[f] === undefined || rule?.[f] === null);
}

/* ─────────────────────────────────────────────────────────────────────
 * POST /start — the Master Sheet row.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHAT COUNTS AS "STARTED", AND WHY NOT LANDING
 * ══════════════════════════════════════════════════════════════════════
 * The trigger is DELIBERATE ENGAGEMENT, not arrival:
 *   · advancing past step 1 (a visa type has been chosen), OR
 *   · attaching/uploading the first document,
 * whichever fires first.
 *
 * Landing on helloviza.ai is explicitly NOT a start. A landing is
 * traffic — most of it bounces, much of it is a crawler — and a sheet
 * that counted it would be a sheet of strangers with a conversion rate
 * near zero, useless for the question it exists to answer ("who is
 * genuinely in flight, and where did they stall?"). Both signals above
 * require a signed-in consumer to have made a choice.
 *
 * Also note what this does NOT create: a VisaApplication. A ticket at
 * this point would flood the concierge queue with cases nobody has
 * committed to. See models/VisaD2CLead.ts.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ───────────────────────────────────────
 * An upsert on {consumerId, destinationIso2}. Both triggers can fire in
 * the same session, the reader can leave and come back, and the client
 * can retry — all of it lands on ONE row. That is also why the client is
 * free to call this on every step-1 advance without debouncing.
 * ───────────────────────────────────────────────────────────────────── */

router.post("/start", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const workspaceId = d2cWorkspaceObjectId();

    const rawIso2 = String(req.body?.iso2 ?? "").trim().toUpperCase();
    const iso2 = findSeedCountry(rawIso2) ? rawIso2 : normaliseToIso2(String(req.body?.iso2 ?? ""));
    if (!iso2) return res.status(400).json({ error: "A valid destination is required" });

    const seed = findSeedCountry(iso2);
    const purposeRaw = String(req.body?.purpose ?? "").trim().toUpperCase();
    const purpose = SELECTABLE_PURPOSES.includes(purposeRaw as any) ? purposeRaw : null;
    const utm = normaliseUtm(req.body?.utm);

    /* FIRST-TOUCH ATTRIBUTION. utm goes in $setOnInsert, never $set, so a
     * later untagged visit cannot erase the campaign that actually
     * introduced this person. If the row already exists with empty utm and
     * a TAGGED visit arrives, the conditional below fills it in — the one
     * direction that adds information rather than destroying it. */
    const lead = await VisaD2CLead.findOneAndUpdate(
      { consumerId, destinationIso2: iso2 },
      {
        $setOnInsert: {
          consumerId,
          workspaceId,
          destinationIso2: iso2,
          destinationName: seed?.countryName ?? iso2,
          startedAt: new Date(),
          utm,
        },
        // Purpose can legitimately change (they went back and re-chose), so
        // it is a $set. Status/stage are NOT touched here: a row that has
        // already converted must not be dragged back to
        // DOC_SUBMISSION_IN_PROGRESS by a stray start call.
        ...(purpose ? { $set: { purpose } } : {}),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (!isUtmEmpty(utm) && isUtmEmpty(lead.utm)) {
      lead.utm = utm as any;
      await lead.save();
    }

    return res.status(200).json({ ok: true, lead: publicLead(lead) });
  } catch (err: any) {
    // A duplicate-key here means two triggers raced on the same new row.
    // That is the idempotency working, not a failure — re-read and return.
    if (err?.code === 11000) {
      const existing = await VisaD2CLead.findOne({
        consumerId: me(req),
        destinationIso2: String(req.body?.iso2 ?? "").trim().toUpperCase(),
      });
      if (existing) return res.status(200).json({ ok: true, lead: publicLead(existing) });
    }
    consumerAppLogger.error("D2C lead start failed", { error: err?.message });
    return res.status(500).json({ error: "We couldn't save your progress just now." });
  }
});

function publicLead(l: any) {
  return {
    id: String(l._id),
    destinationIso2: l.destinationIso2,
    destinationName: l.destinationName,
    status: l.status,
    stage: l.stage,
    applicationId: l.applicationId ? String(l.applicationId) : null,
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * POST / — create a D2C application (the "Submit" on the Apply page).
 * ───────────────────────────────────────────────────────────────────── */

router.post("/", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const workspaceId = d2cWorkspaceObjectId();

    /* ── input ─────────────────────────────────────────────────────── */
    const rawIso2 = String(req.body?.iso2 ?? "").trim().toUpperCase();
    // Seed first, normaliseToIso2 second — the same ordering and the same
    // reason as routes/public.visa.ts's resolvePublicIso2: countryCodes.ts
    // covers ~120 codes and the seed covers 196, so resolving through the
    // narrower table alone would 404 corridors the map actually draws.
    const iso2 = findSeedCountry(rawIso2) ? rawIso2 : normaliseToIso2(String(req.body?.iso2 ?? ""));
    if (!iso2) {
      return res.status(400).json({ error: "A valid destination is required" });
    }

    const purpose = String(req.body?.purpose ?? "").trim().toUpperCase();
    if (!SELECTABLE_PURPOSES.includes(purpose as any)) {
      return res.status(400).json({
        error: `purpose must be one of: ${SELECTABLE_PURPOSES.join(", ")}`,
      });
    }

    /* ── THE VERIFIED-MOBILE GATE ──────────────────────────────────────
     * A visa case is worked by a human who will phone the applicant, and a
     * case whose number nobody has proven reachable is a case that stalls
     * at the first callback. The gate sits HERE — after the cheap input
     * validation, before resolveRuleFor — so an unverified consumer is
     * turned away without us paying for a rule lookup, and before any of
     * the writes further down have started.
     *
     * Read from the consumer's OWN profile, never from the request. The
     * flag has exactly two writers, both server-side
     * (routes/consumer.mobileOtp.ts sets it true after MSG91 confirms; the
     * contact save in routes/consumer.profile.ts sets it false when the
     * number changes) and it is absent from that file's PATCH allowlist, so
     * a client cannot grant itself passage.
     *
     * .lean() and a one-field projection: this is an authorisation read on
     * the hot path of every submit, and it must not drag the most sensitive
     * document in the database — passports, addresses, dates of birth —
     * through the decryption plugin to answer a boolean. mobileVerified is
     * NOT an encrypted field, so a lean read returns it plainly; a lean read
     * of contact.mobile would return an envelope, which is exactly why this
     * projects the flag and never the number.
     *
     * The code is machine-readable because the frontend routes on it — a
     * blocked submit sends the consumer to the verify flow rather than
     * showing them a dead end. See account/api.ts's ApiError.code. */
    const verification = await ConsumerProfile.findOne({ consumerId })
      .select("contact.mobileVerified")
      .lean();

    if ((verification as any)?.contact?.mobileVerified !== true) {
      return res.status(403).json({
        error: "Please verify your mobile number before submitting an application.",
        code: "MOBILE_NOT_VERIFIED",
      });
    }

    const utm = normaliseUtm(req.body?.utm);

    const documentIdsRaw = Array.isArray(req.body?.documentIds) ? req.body.documentIds : [];
    const documentIds = documentIdsRaw
      .map((v: unknown) => String(v ?? "").trim())
      .filter((v: string) => mongoose.isValidObjectId(v))
      .map((v: string) => new mongoose.Types.ObjectId(v));

    /* ── the rule, re-resolved. Never the client's word for it. ────── */
    const rule = await resolveRuleFor(iso2, purpose);
    if (!rule) {
      return res.status(404).json({
        error: "We don't publish this destination for that visa type yet",
      });
    }

    // Fail before anything is written, rather than 500-ing halfway through
    // with a request already minted. See the constant's own note.
    const incomplete = missingSnapshotFields(rule);
    if (incomplete.length) {
      consumerAppLogger.error(
        "published visa rule cannot produce a valid ruleSnapshot — application refused",
        {
          ruleId: String(rule._id),
          destinationIso2: rule.destinationIso2,
          purpose: rule.purpose,
          missingFields: incomplete,
        },
      );
      return res.status(409).json({
        error:
          "This destination isn't fully set up for online applications yet. Send us an enquiry and our team will take it from here.",
        code: "RULE_INCOMPLETE",
      });
    }

    /* ── the documents, ownership-checked BEFORE anything is written ─
     * A document id belonging to somebody else must never end up linked
     * to this application, and the check is a filter on consumerId rather
     * than a trust of the id. Ids that do not resolve are dropped and
     * REPORTED back, not silently ignored — a consumer who thinks they
     * attached a passport and did not is the worst outcome here. */
    const ownedDocuments = documentIds.length
      ? await ConsumerDocument.find({
          // THE FILTER IS UNCHANGED. Only the projection below grew — the
          // ops-side VisaDocument mint needs the storage reference and the
          // file metadata off these same rows, and re-reading them in a
          // second query would be a second chance to get the ownership
          // clause wrong.
          _id: { $in: documentIds },
          consumerId,
          deletedAt: null,
        })
          .select("_id docCode driver storageKey bucket originalFilename mimeType sizeBytes")
          .lean()
      : [];
    const ownedIds = (ownedDocuments as any[]).map((d) => d._id);
    const rejectedDocumentCount = documentIds.length - ownedIds.length;

    /* ── the lightweight parent request ────────────────────────────── */
    const travelDateFrom = parseDate(req.body?.travelDateFrom);

    const visaRequest = await VisaRequest.create({
      workspaceId,
      // NULL, and legitimately so — see the schema path's own note. The
      // conditional `required` allows it only because source is "D2C".
      raisedByUserId: null,
      consumerId,
      source: "D2C",
      // customerId is the B2B billing linkage and has no D2C meaning yet.
      // Left null rather than pointed at the synthetic D2C customer, so
      // services/visaBillingSync.ts cannot mistake this for a billable
      // B2B case. TODO(milestone-2): revisit when D2C invoicing lands.
      customerId: null,
      destinationIso2: rule.destinationIso2,
      purpose: rule.purpose,
      travelDateFrom,
      applicationIds: [],
    });

    /* ── the snapshots ─────────────────────────────────────────────── */
    const ruleSnapshot = buildRuleSnapshot(rule);
    // "D2C" — the channel the consumer was quoted in. Passing nothing here
    // would freeze the B2B total (₹354 on TH) onto a consumer's case that
    // the panel quoted at ₹1,770. See utils/visaSnapshots.ts.
    const indicativeCostSnapshot = buildIndicativeCostSnapshot(rule, "D2C");

    /* ── the application ───────────────────────────────────────────── */
    const application = await VisaApplication.create({
      workspaceId,
      requestId: visaRequest._id,
      consumerId,
      source: "D2C",
      customerId: null,
      // No TravellerProfile: that is a B2B corporate-roster entity. The
      // applicant's identity lives on the ConsumerProfile, and the field is
      // already nullable (models/VisaApplication.ts).
      travellerProfileId: null,
      nationality: PUBLIC_NATIONALITY,
      nationalityUnresolved: false,
      travelDateFrom,
      destinationIso2: rule.destinationIso2,
      processingDeadlineAt: computeProcessingDeadline(
        travelDateFrom,
        ruleSnapshot.etaMaxDays,
        ruleSnapshot.etaBasis,
      ),
      ruleSnapshot,
      indicativeCostSnapshot,
      // Attribution carried onto the ticket itself — see the field's note
      // in models/VisaApplication.ts on why it is stored in both places.
      utm,
      /* ── "submitted", NOT "draft", AND THIS IS LOAD-BEARING ────────
       * Stage-2 finding: `draft` is excluded from the ops queue by
       * VISA_OPS_HIDDEN_STATUSES *and* has no ops-side transitions at all
       * (PATCH /applications/:id/status answers `allowed: []` for it).
       * The only thing that can move a draft is the B2B customer's own
       * POST /requests/:id/submit, which a consumer cannot reach.
       *
       * A D2C ticket created at "draft" would therefore be a row nobody
       * can see and nobody can work — worse than no ticket, because it
       * looks like the flow succeeded. Submitting IS the act here: the
       * consumer has chosen, attached and confirmed, so the case enters
       * the pipeline at its first genuinely workable state.
       *
       * The funnel triple (d2cStatus / d2cStage / d2cPaymentStatus) is
       * NOT set here — models/VisaApplication.ts defaults each of them
       * from `source`, so a D2C row cannot be created half-populated by
       * a route that forgets one. See visaD2CLifecycle.ts. */
      status: "submitted",
      submittedAt: new Date(),
    });

    await VisaRequest.findByIdAndUpdate(visaRequest._id, {
      $set: { applicationIds: [application._id] },
    });

    /* DERIVED, never assigned — the rule models/VisaRequest.ts states for
     * itself. With one submitted child this rolls the parent up to
     * "active", which is what puts the case on the roster. */
    await recomputeRequestStatus(visaRequest._id);

    /* ── link the documents ────────────────────────────────────────
     * $addToSet, not $push: re-submitting must not add the same
     * application id twice to a locker row that was already attached. */
    if (ownedIds.length) {
      await ConsumerDocument.updateMany(
        { _id: { $in: ownedIds }, consumerId },
        { $addToSet: { linkedApplicationIds: application._id } },
      );
    }

    /* ── MINT THE OPS-SIDE DOCUMENT ROWS ───────────────────────────
     *
     * The linkage above is how the CONSUMER side reads its own
     * attachments, and it stays exactly as it was. It is invisible to
     * ops: the concierge console lists VisaDocument.find({applicationId}),
     * so before this block a D2C case arrived with "No documents
     * uploaded" no matter what the applicant had attached. This mints the
     * rows that panel reads. Both linkages are true after a submit;
     * neither replaces the other.
     *
     * ── THE BYTES ARE SHARED, NOT COPIED ──────────────────────────
     * driver / storageKey / bucket are carried across UNCHANGED, so the
     * VisaDocument points at the object the locker already holds. No
     * re-upload, no second copy, no S3 write on this path at all — which
     * is what models/ConsumerDocument.ts means by "no surface ever copies
     * a file. It links." `driver` is taken from the ROW rather than
     * re-derived from NODE_ENV, so a dev-disk document stays a dev-disk
     * document and the ops download route streams it instead of
     * presigning a key that was never in S3.
     *
     * ── FROZEN AT SUBMIT ──────────────────────────────────────────
     * Minted once, here. Nothing re-syncs them when the consumer edits
     * their locker afterwards — an in-flight case's evidence is fixed at
     * the moment it was submitted, the same reasoning that freezes
     * ruleSnapshot and indicativeCostSnapshot two blocks up. A consumer
     * who wants ops to see a newer file is making a new statement about
     * their case, which is a conversation, not a silent overwrite.
     *
     * ── NO EXTRACTION ─────────────────────────────────────────────
     * Deliberately no runVisaPassportExtraction call. The applicant's
     * passport data already lives (encrypted) on their ConsumerProfile
     * and the ops applicant panel reads it from there; re-deriving it
     * from an image would add a second, weaker source of the same facts.
     * createVisaDocumentRow does not extract on its own — this comment
     * exists so nobody "restores parity" with the B2B upload by adding a
     * trigger here.
     *
     * ── A CODE-LESS ATTACHMENT IS SKIPPED, AND SAID SO ────────────
     * VisaDocument.docCode is required; ConsumerDocument.docCode is
     * optional (models/ConsumerDocument.ts calls it "the optional bridge"
     * to the ops taxonomy). A locker row with no code cannot become a
     * checklist item without someone inventing which requirement it
     * satisfies — so it is not minted, and the count comes back in the
     * response rather than the file quietly not existing for ops. */
    let documentsLinked = 0;
    let documentsSkippedNoCode = 0;
    if (ownedDocuments.length) {
      /* IDEMPOTENCY — CHECK-EXISTING, NOT THE UNIQUE INDEX.
       *
       * The index on {applicationId, docCode, version} does NOT protect
       * this: createVisaDocumentRow computes version = highest + 1, so a
       * second mint for the same docCode would land on version 2 and
       * insert cleanly rather than collide. Relying on a duplicate-key
       * error to stop a re-run would therefore not stop it at all.
       *
       * So the guard is an explicit read of the codes this application
       * already carries. On the normal path the application was created
       * milliseconds ago and this returns nothing — one cheap indexed
       * query for the guarantee that re-running the block is a no-op
       * instead of a second set of rows.
       *
       * Note it is read ONCE, before the loop: two locker rows that share
       * a docCode still mint as version 1 and version 2 of that code,
       * which is correct — they are two real files the applicant
       * attached, and the ops detail lists every version rather than only
       * the newest. */
      const existing = await VisaDocument.find({ applicationId: application._id })
        .select("docCode")
        .lean();
      const alreadyMinted = new Set(existing.map((d: any) => String(d.docCode)));

      const subject = subjectFromApplication(application as any);

      for (const attached of ownedDocuments as any[]) {
        const docCode = String(attached.docCode || "").trim();
        if (!docCode) {
          documentsSkippedNoCode += 1;
          continue;
        }
        if (alreadyMinted.has(docCode)) continue;

        await createVisaDocumentRow({
          workspaceId,
          applicationId: application._id,
          requestId: visaRequest._id,
          docCode,
          // SHARED, all three — see the block header.
          driver: attached.driver,
          bucket: attached.bucket,
          s3Key: attached.storageKey,
          originalFilename: attached.originalFilename,
          mimeType: attached.mimeType,
          sizeBytes: attached.sizeBytes,
          // A consumer is not a User and has no id in that collection.
          uploadedByUserId: null,
          uploadedByConsumerId: consumerId,
          // CONSUMER/consumerId for a D2C application, because
          // travellerProfileId is null on one — resolved by the single
          // helper that owns that two-branch rule (models/VisaDocument.ts),
          // never rebuilt inline. Stamped at mint because nothing on this
          // path will ever stamp it later: D2C runs no extraction.
          subjectType: subject?.subjectType ?? null,
          subjectId: subject?.subjectId ?? null,
          /* "CUSTOMER", not "CONSUMER" — VISA_ACTIVITY_ACTOR_TYPES is
           * ["STAFF","CUSTOMER","SYSTEM"] (models/VisaActivityLog.ts) and
           * has no consumer member. CUSTOMER is the honest one of the
           * three: the act was the applicant's, not staff's and not the
           * system's. Adding a fourth enum value would rewrite the
           * meaning of every activity row already stored and is not this
           * change's business — flagged rather than done. */
          actorType: "CUSTOMER",
        });
        documentsLinked += 1;
      }
    }

    /* ── CONVERT THE MASTER SHEET ROW ──────────────────────────────
     * Upsert on the SAME {consumerId, destinationIso2} key the start
     * endpoint uses, so a started row BECOMES a submitted row. The upsert
     * (rather than a plain update) covers the reader who never tripped a
     * start trigger — someone who attached nothing and walked straight
     * through — so the sheet never misses a submitted case.
     *
     * utm here is $setOnInsert only: if a lead row already exists, its
     * first-touch attribution is the truth and this later payload must
     * not overwrite it. */
    await VisaD2CLead.findOneAndUpdate(
      { consumerId, destinationIso2: rule.destinationIso2 },
      {
        $set: {
          stage: "DOC_SUBMITTED",
          status: "IN_PROGRESS",
          paymentStatus: "PENDING",
          purpose: rule.purpose,
          applicationId: application._id,
          referenceNumber: visaRequest.referenceNumber ?? null,
          submittedAt: new Date(),
        },
        $setOnInsert: {
          consumerId,
          workspaceId,
          destinationIso2: rule.destinationIso2,
          destinationName: seedCountryName(rule),
          startedAt: new Date(),
          utm,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    consumerAppLogger.info("D2C application created", {
      applicationId: String(application._id),
      requestId: String(visaRequest._id),
      iso2: rule.destinationIso2,
      purpose: rule.purpose,
      totalInr: indicativeCostSnapshot.totalInr,
      linkedDocuments: ownedIds.length,
      rejectedDocumentCount,
      documentsLinked,
      documentsSkippedNoCode,
    });

    return res.status(201).json({
      ok: true,
      application: publicApplication(application, visaRequest),
      // Surfaced, not swallowed — see the ownership check above.
      rejectedDocumentCount,
      // How many attachments reached the ops review panel, and how many
      // could not because they carry no docCode. Reported rather than
      // silently dropped, for the same reason rejectedDocumentCount is:
      // an applicant who believes they attached a passport and did not is
      // the worst outcome on this route.
      documentsLinked,
      documentsSkippedNoCode,
    });
  } catch (err: any) {
    consumerAppLogger.error("D2C application create failed", { error: err?.message });
    return res.status(500).json({ error: "We couldn't start your application just now." });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /:id/payment/order — mint a Razorpay order for a D2C case.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE AMOUNT COMES FROM THE DATABASE. THE CLIENT CANNOT NAME A PRICE.
 * ══════════════════════════════════════════════════════════════════════
 * This endpoint reads NOTHING from the request body. Not the amount, not
 * the currency, not a discount — the only input is the application id in
 * the PATH, and the charge is `indicativeCostSnapshot.totalInr` off the
 * stored application, frozen at submit.
 *
 * That is a deliberate departure from the three existing SBT order
 * endpoints (sbt.flights.ts's /payment/create-order and /reissue-order,
 * sbt.hotels.ts's /payment/create-order), every one of which does
 * `const { amount } = req.body` and charges whatever an authenticated
 * caller asks to be charged. Those are not changed here — they are B2B
 * paths outside this milestone's blast radius — but they are NOT the
 * pattern to copy, and this comment exists so nobody "makes it
 * consistent" later by reintroducing a client amount.
 *
 * The test that guards this sends a bogus `amount` in the body and
 * asserts the order still prices from the stored total.
 *
 * ── OWN-SCOPE ────────────────────────────────────────────────────────
 * The application is loaded by { _id, consumerId, workspaceId } — all
 * three clauses LITERAL. A consumer minting an order against somebody
 * else's case would be paying for a stranger's visa, or worse, learning
 * its price. The workspaceScope plugin cannot help here: it injects only
 * when a query carries `_workspaceId` in its options, so it fails OPEN.
 *
 * ── IDEMPOTENT BY REUSE ──────────────────────────────────────────────
 * If an unpaid order already exists on the application it is RETURNED
 * rather than a second one minted. Razorpay bills per captured payment,
 * not per created order, so a duplicate order is not a double charge —
 * but it does leave a second live order id that a stale browser tab could
 * still pay, and reconciling two orders against one case is exactly the
 * ambiguity PaymentOrphan exists to mop up. One case, one live order.
 * ───────────────────────────────────────────────────────────────────── */

/** Statuses at which a consumer may pay. */
const PAYABLE_STATUSES = ["submitted", "docs_under_review", "cost_confirmed"];

router.post("/:id/payment/order", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const workspaceId = d2cWorkspaceObjectId();

    const id = String(req.params.id ?? "");
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Application not found" });
    }

    /* All three clauses, literally. See the header. */
    const application: any = await VisaApplication.findOne({
      _id: new mongoose.Types.ObjectId(id),
      consumerId,
      workspaceId,
    });

    // 404, never 403 — a consumer must not be able to learn that somebody
    // else's application id exists by the shape of the refusal.
    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    if (application.d2cPaymentStatus === "PAID") {
      return res.status(409).json({
        error: "This application is already paid.",
        code: "ALREADY_PAID",
      });
    }

    if (!PAYABLE_STATUSES.includes(String(application.status))) {
      return res.status(409).json({
        error: "This application isn't ready for payment yet.",
        code: "NOT_PAYABLE",
      });
    }

    /* ── THE AMOUNT ───────────────────────────────────────────────
     * Read from the stored snapshot. Never from `req.body`, which this
     * handler does not touch at all. */
    const totalInr = Number(application.indicativeCostSnapshot?.totalInr);
    if (!Number.isFinite(totalInr) || totalInr <= 0) {
      // A corridor with no quotable price must not reach a payment screen.
      // Refusing beats charging zero or charging NaN.
      consumerAppLogger.error("payment order refused — application has no usable total", {
        applicationId: id,
        totalInr: application.indicativeCostSnapshot?.totalInr,
      });
      return res.status(409).json({
        error: "This application has no price to charge yet.",
        code: "NO_PRICE",
      });
    }
    const amountPaise = Math.round(totalInr * 100);

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      // Same posture as the SBT endpoints: a clean 503 rather than a
      // crash, so this ships before the test keys are in .env and starts
      // working the moment they are.
      consumerAppLogger.warn("payment order refused — Razorpay not configured", { applicationId: id });
      return res.status(503).json({
        error: "Online payment isn't switched on yet.",
        code: "GATEWAY_NOT_CONFIGURED",
      });
    }

    /* ── REUSE AN EXISTING UNPAID ORDER ──────────────────────────── */
    if (application.razorpayOrderId) {
      consumerAppLogger.info("payment order reused", {
        applicationId: id,
        razorpayOrderId: application.razorpayOrderId,
      });
      return res.json({
        ok: true,
        orderId: application.razorpayOrderId,
        amount: amountPaise,
        currency: "INR",
        keyId,
        reused: true,
      });
    }

    /* ── MINT THE ORDER ──────────────────────────────────────────
     * Same call shape as the SBT callers (raw fetch, Basic auth, paise) —
     * mirrored rather than refactored, so no existing B2B payment path is
     * touched by this milestone.
     *
     * `notes` is the ONE addition, and Stage 2 depends on it: no existing
     * order sets notes, so the webhook has nothing to branch on. A D2C
     * payment must be self-describing, because the webhook's fallback for
     * an unrecognised order is PaymentOrphan — i.e. a real consumer
     * payment silently filed as an anomaly. */
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const orderRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        receipt: `hvd2c_${id}_${Date.now()}`,
        notes: {
          channel: "D2C",
          applicationId: id,
        },
      }),
    });

    const order: any = await orderRes.json().catch(() => ({}));
    if (!orderRes.ok || !order?.id) {
      consumerAppLogger.error("razorpay order creation failed", {
        applicationId: id,
        status: orderRes.status,
        error: order?.error?.description,
      });
      return res.status(502).json({
        error: order?.error?.description || "We couldn't reach the payment gateway.",
      });
    }

    application.razorpayOrderId = order.id;
    await application.save();

    consumerAppLogger.info("payment order created", {
      applicationId: id,
      razorpayOrderId: order.id,
      amountPaise,
    });

    return res.json({
      ok: true,
      orderId: order.id,
      // Echo OUR computed figure, not the gateway's, so a mismatch would
      // surface here rather than being laundered through the response.
      amount: amountPaise,
      currency: "INR",
      // The PUBLISHABLE key id. The secret never leaves the server.
      keyId,
      reused: false,
    });
  } catch (err: any) {
    consumerAppLogger.error("payment order failed", { error: err?.message });
    return res.status(500).json({ error: "We couldn't start the payment just now." });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET / — the consumer's own applications.
 * ───────────────────────────────────────────────────────────────────── */

router.get("/", async (req: any, res: any) => {
  try {
    // BOTH clauses, literally. See the file header on why neither alone is
    // an isolation boundary and why the plugin cannot supply either.
    const applications = await VisaApplication.find({
      consumerId: me(req),
      workspaceId: d2cWorkspaceObjectId(),
    })
      .sort({ createdAt: -1 })
      .lean();

    const requestIds = applications
      .map((a: any) => a.requestId)
      .filter((id: any) => mongoose.isValidObjectId(id));
    const requests = requestIds.length
      ? await VisaRequest.find({ _id: { $in: requestIds } })
          .select("referenceNumber status")
          .lean()
      : [];
    const requestById = new Map((requests as any[]).map((r) => [String(r._id), r]));

    /* ── THE "STILL NEEDS N DOCUMENTS" HINT ───────────────────────────
     * One query for every application on the page rather than one per
     * card. The list is small (a consumer's own cases) but the N+1 shape
     * is the one that stops being small quietly, and the group-by below
     * costs nothing next to a second round trip.
     *
     * Counted from the SNAPSHOT's checklist, same as the detail view, so
     * a card and the page it opens can never disagree about what is
     * outstanding. */
    const attachedDocs = applications.length
      ? await ConsumerDocument.find({
          consumerId: me(req),
          linkedApplicationIds: { $in: applications.map((a: any) => a._id) },
        })
          // storageKey joins to the ops mirror's s3Key below. Same read,
          // one more projected field — no extra round trip for it.
          .select("docCode linkedApplicationIds storageKey")
          .lean()
      : [];

    /* ── AND THE REJECTIONS, WHICH THIS COUNT USED TO IGNORE ──────────
     *
     * The detail route learned to join the ops mirror (checklistRows,
     * below: a REJECTED document is not an attached one, because the
     * requirement is outstanding again). This route did not, so the two
     * screens disagreed about the same case in the one way the header
     * above promises they cannot: the card said "still needs 1 document"
     * while the page it opened said 2.
     *
     * ── ONE QUERY, NOT ONE PER ROW ───────────────────────────────────
     * Batched with a single $in over every application on the page —
     * same shape as the ConsumerDocument read it sits beside. A per-card
     * mirror lookup is the N+1 that this block's original comment was
     * written to avoid, and adding one back to fix a count would be
     * trading a wrong number for a slow one.
     *
     * Scoped by applicationId alone, which is sound because every id in
     * the list came out of a find() already clamped to
     * {consumerId, workspaceId} — the ownership proof is upstream.
     *
     * ── KEYED ON THE STORED OBJECT, NOT ON docCode ───────────────────
     * Same reasoning as the detail route's join, and it matters more
     * here because this side counts: 103 of 259 published corridors
     * repeat a docTypeCode across groups, so a code-keyed join would
     * smear one rejection over every requirement sharing the code and
     * inflate the outstanding figure. `s3Key` on the mirror IS
     * `storageKey` on the locker row — one file, one row each side. */
    const rejectedRows = applications.length
      ? await VisaDocument.find({
          applicationId: { $in: applications.map((a: any) => a._id) },
          reviewStatus: "REJECTED",
          deletedAt: null,
        })
          .select("applicationId s3Key")
          .lean()
      : [];

    /* `${applicationId}|${s3Key}` — the rejection is per CASE as well as
     * per file. A locker document can be linked to two applications and
     * refused on only one of them; keying on the file alone would fail
     * the second case for the first case's rejection. */
    const rejectedByApplicationAndKey = new Set<string>();
    for (const r of rejectedRows as any[]) {
      const key = String(r.s3Key ?? "");
      if (!key) continue;
      rejectedByApplicationAndKey.add(`${String(r.applicationId)}|${key}`);
    }

    /* code -> the FIRST locker row carrying it, per application. First
     * rather than "any un-rejected one" on purpose: checklistRows()
     * resolves a requirement to the first document under its code and
     * judges THAT row, so picking a different one here would reintroduce
     * the disagreement this whole block exists to remove. */
    const docsByApplication = new Map<string, Map<string, any>>();
    for (const doc of attachedDocs as any[]) {
      const code = String(doc.docCode ?? "").toUpperCase();
      if (!code) continue;
      for (const appId of doc.linkedApplicationIds ?? []) {
        const key = String(appId);
        let byCode = docsByApplication.get(key);
        if (!byCode) {
          byCode = new Map<string, any>();
          docsByApplication.set(key, byCode);
        }
        if (!byCode.has(code)) byCode.set(code, doc);
      }
    }

    return res.json({
      ok: true,
      applications: applications.map((a: any) => {
        const applicationId = String(a._id);
        const byCode = docsByApplication.get(applicationId) ?? new Map<string, any>();
        const required = requiredDocCodes(a);
        return {
          ...publicApplication(a, requestById.get(String(a.requestId)) ?? null),
          documentsTotal: required.length,
          documentsOutstanding: required.filter(
            (c) => !satisfiedDocCode(applicationId, byCode.get(c), rejectedByApplicationAndKey),
          ).length,
        };
      }),
    });
  } catch (err: any) {
    consumerAppLogger.error("D2C application list failed", { error: err?.message });
    return res.status(500).json({ error: "We couldn't load your applications." });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /:id — ONE application, and the endpoint the payment UI polls.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THIS EXISTS SO THE CLIENT NEVER HAS TO TAKE ITS OWN WORD FOR A PAYMENT.
 * ══════════════════════════════════════════════════════════════════════
 * Razorpay's checkout handler fires in the browser the moment the card is
 * authorised. It is NOT the authority on whether we have been paid — the
 * webhook is (routes/razorpay.webhook.ts), and it may land a beat later.
 * So the Apply flow's success path does not flip itself to "paid" on the
 * strength of the callback; it polls THIS route until d2cPaymentStatus
 * reads PAID, which only the webhook writes.
 *
 * That makes this a read of a value the client cannot influence, which is
 * the entire point. A client that could set its own payment status would
 * make the webhook decorative.
 *
 * ── SAME FENCE AS EVERY OTHER READ HERE ──────────────────────────────
 * { _id, consumerId, workspaceId }, all three LITERAL, and a 404 rather
 * than a 403 on a miss — identical to the order endpoint above, for the
 * identical reason: a consumer must not learn that a stranger's
 * application id exists by the shape of the refusal. Polling makes that
 * sharper, not softer — this route is called repeatedly and fast, so it
 * is the cheapest id oracle in the surface if the scope clauses are ever
 * dropped.
 *
 * The projection is the SAME publicApplication() whitelist the list uses.
 * A detail route with its own hand-rolled projection is how the B2B-only
 * fields (plumtripsServiceFeeInr, assignedConciergeUserId,
 * discrepancyReason) would eventually reach a consumer screen.
 * ───────────────────────────────────────────────────────────────────── */

router.get("/:id", async (req: any, res: any) => {
  try {
    const id = String(req.params.id ?? "");
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: "Application not found" });
    }

    const application: any = await VisaApplication.findOne({
      _id: new mongoose.Types.ObjectId(id),
      consumerId: me(req),
      workspaceId: d2cWorkspaceObjectId(),
    }).lean();

    if (!application) {
      return res.status(404).json({ error: "Application not found" });
    }

    const request = mongoose.isValidObjectId(application.requestId)
      ? await VisaRequest.find({ _id: application.requestId })
          .select("referenceNumber status")
          .lean()
          .then((rows) => rows[0] ?? null)
      : null;

    /* The documents this consumer actually attached to THIS case. Scoped by
     * consumerId as well as the link — a document id is not a capability,
     * and linkedApplicationIds is written by the create route, not by the
     * reader. */
    const attached = await ConsumerDocument.find({
      consumerId: me(req),
      linkedApplicationIds: application._id,
    })
      .select("docCode label originalFilename createdAt storageKey")
      .lean();

    /* ── THE OPS REVIEW STATE — the half the customer could not see ──
     *
     * When ops rejects a document they write reviewStatus/rejectionReason
     * on the VisaDocument MIRROR (admin.visa.ts PATCH /documents/:id/review),
     * not on the consumer's locker row. This read path only ever loaded
     * the locker row, and ConsumerDocument has no review fields at all —
     * so a rejected document went on rendering as a satisfied green tick
     * and the applicant was never told to re-upload anything.
     *
     * ── JOINED ON THE FILE, NOT ON THE CODE ──────────────────────────
     * The obvious join is docCode, and it would be wrong: 103 of 259
     * published corridors list the same docTypeCode in more than one
     * group, so a code-keyed join would paint one rejection across every
     * row sharing that code. The mirror carries `s3Key`, which IS the
     * consumer's `storageKey` — the same stored object, one row each
     * side. That is a per-FILE identity and it is unaffected by however
     * bad the corridor's codes are. The VisaDocument _id then travels to
     * the client as the row's stable handle.
     *
     * Scoped by applicationId, which is already proven to be this
     * consumer's application by the ownership check above. */
    const reviewRows = await VisaDocument.find({
      applicationId: application._id,
      deletedAt: null,
    })
      .select("_id docCode reviewStatus rejectionReason s3Key")
      .lean();

    /* WHEN the payment was applied. There is no `d2cPaidAt` on the
     * application — the webhook sets the funnel triple and the payment id
     * and nothing else — so the timestamp comes from the activity log row
     * that same handler writes. That row IS the record of when we became
     * paid; inventing a second field would give us two answers to one
     * question, and the older paid cases would have a null in the new one. */
    const paidLog: any = application.d2cPaymentStatus === "PAID"
      ? await VisaActivityLog.find({ applicationId: application._id, eventType: "PAYMENT_DONE" })
          .select("at")
          .sort({ at: 1 })
          .lean()
          .then((rows) => rows[0] ?? null)
      : null;

    return res.json({
      ok: true,
      application: publicApplication(application, request),
      documents: checklistRows(application, attached, reviewRows),
      price: consumerPrice(application),
      payment: {
        razorpayPaymentId: application.razorpayPaymentId ?? null,
        paidAt: paidLog?.at ?? null,
      },
      /* The OPS axis, which drives the back half of the consumer tracker.
       * Sent as raw values because the tracker maps them to steps — and
       * because there is no consumer-facing label set for ops statuses,
       * which is deliberate: they are Plumtrips' vocabulary, not copy. */
      /* The OPS axis. The extra three fields exist so the consumer tracker
       * can drive the back half of its rail through the SAME builder the
       * B2B tracking page uses (frontend pages/visa/track/timelineStages),
       * rather than a second mapping that would drift from it:
       *
       *   submittedAt / lodgedAt              — the only two stage dates
       *                                         that builder will ever show
       *   statusBeforeActionRequired          — where an interrupted case
       *                                         was actually paused
       *
       * All three are ops-written and none of them is a consumer secret:
       * they describe the reader's own case. `actionRequiredSetByUserId`
       * and the concierge assignment are NOT sent — who inside Plumtrips
       * touched a case is our business, not the customer's. */
      ops: {
        status: application.status,
        outcome: application.outcome ?? null,
        actionRequiredReason: application.actionRequiredReason ?? null,
        statusBeforeActionRequired: application.statusBeforeActionRequired ?? null,
        submittedAt: application.submittedAt ?? null,
        lodgedAt: application.lodgedAt ?? null,
      },
    });
  } catch (err: any) {
    consumerAppLogger.error("D2C application read failed", { error: err?.message });
    return res.status(500).json({ error: "We couldn't load that application." });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * Projection — a WHITELIST, never a spread.
 *
 * Same posture as routes/public.visa.ts: the application document carries
 * B2B pricing fields (plumtripsServiceFeeInr on the snapshot), ops-only
 * fields (discrepancyReason, assignedConciergeUserId, servicePartnerName)
 * and internal ids. A delete-list is one schema addition away from
 * leaking; a whitelist is not.
 * ───────────────────────────────────────────────────────────────────── */

function publicApplication(a: any, request: any) {
  return {
    id: String(a._id),
    status: a.status,
    /* The funnel triple, sent as STORED ENUMS plus their display copy.
     * The consumer surface renders the labels; sending both means the
     * client never owns a second copy of the vocabulary (the mistake the
     * public map's own api.ts calls out about country lists). */
    trackingStatus: a.d2cStatus ?? null,
    trackingStatusLabel: a.d2cStatus ? D2C_TRACKING_STATUS_LABELS[a.d2cStatus] : null,
    stage: a.d2cStage ?? null,
    stageLabel: a.d2cStage ? D2C_STAGE_LABELS[a.d2cStage] : null,
    paymentStatus: a.d2cPaymentStatus ?? null,
    paymentStatusLabel: a.d2cPaymentStatus ? D2C_PAYMENT_STATUS_LABELS[a.d2cPaymentStatus] : null,
    referenceNumber: request?.referenceNumber ?? null,
    destinationIso2: a.destinationIso2 ?? null,
    destinationName: a.ruleSnapshot?.destinationName ?? null,
    purpose: a.ruleSnapshot?.purpose ?? null,
    entryType: a.ruleSnapshot?.entryType ?? null,
    /* THE QUOTED PROCESSING WINDOW, frozen at submit — "Typically 3-5
     * working days". Off the SNAPSHOT, like destinationName and purpose
     * above, so a later edit to the live rule cannot retroactively change
     * what this consumer was told.
     *
     * ── THESE ARE NOT processingDeadlineAt, AND THE DIFFERENCE MATTERS ─
     * That field (below) is computeProcessingDeadline(travelDateFrom,
     * etaMaxDays, etaBasis) — travel date MINUS the ETA, i.e. the LAST
     * SAFE DATE TO LODGE. It is an ops deadline and it runs backwards
     * from the trip. Rendering it as "your visa should arrive by" would
     * be the exact opposite of what it means, and it is null for every
     * case submitted without a travel date besides.
     *
     * Nullable for the same honest reason: a rule that publishes no ETA
     * gives us nothing to quote, and a screen that says "Typically —"
     * is right where "Typically 0 days" would be a fabrication. */
    etaMinDays: a.ruleSnapshot?.etaMinDays ?? null,
    etaMaxDays: a.ruleSnapshot?.etaMaxDays ?? null,
    processingDeadlineAt: a.processingDeadlineAt ?? null,
    travelDateFrom: a.travelDateFrom ?? null,
    /* ── THE TWO OPS FIELDS THE LIST NEEDS ────────────────────────────
     * Both were already sent on the DETAIL route's `ops` block, and are
     * now on the projection itself so a dashboard can render "action
     * required" badges and Approved/Rejected filters over the whole list
     * without a detail fetch per row. That overlap on the detail response
     * is deliberate and harmless — the same two document fields, read
     * once, serialised twice — and is strictly better than a second
     * list-only projection, which is the drift this file's own header
     * argues against.
     *
     * `actionRequiredReason` is ops-written prose about the READER'S OWN
     * case ("passport copy unclear"), which is why it may cross the wall.
     * What still does not: actionRequiredSetByUserId, discrepancyReason
     * and the concierge assignment — who inside Plumtrips touched a case
     * is our business. The `ops` block already draws that line; this
     * copies the line, not just the fields.
     *
     * `outcome` is undefined (no schema default) until a decision is
     * recorded, so it is coalesced to null rather than dropped from the
     * response — an absent key and a pending decision must not look the
     * same to a client. */
    actionRequiredReason: a.actionRequiredReason ?? null,
    outcome: a.outcome ?? null,
    // The consumer's own total, in the channel they were quoted in. The
    // per-line breakup is deliberately NOT sent: the fee block's own
    // SERVICE_FEE label still reads "Plumtrips Service Fee" for B2B, and
    // the consumer surface must never render that brand.
    totalInr: a.indicativeCostSnapshot?.totalInr ?? null,
    createdAt: a.createdAt,
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * THE CHECKLIST, READ FROM THE SNAPSHOT — NOT FROM THE LIVE RULE.
 *
 * `ruleSnapshot.documentGroups` is what the corridor asked for AT SUBMIT,
 * frozen. Re-resolving the live VisaRule here would be the bug the
 * snapshot exists to prevent: ops edits a checklist, and every already-
 * submitted case silently grows a requirement its owner was never shown.
 *
 * A group's docTypeCodes are matched against the consumer's own locker
 * codes, which is sound because the D2C corridors are seeded with the
 * locker's short vocabulary (PASSPORT / PHOTO / BANK_STATEMENT) rather
 * than the ops catalogue's canonical codes (PASSPORT_ORIGINAL /
 * PHOTOGRAPH / APPLICANT_BANK_STATEMENT). Those two taxonomies are NOT
 * the same list — ConsumerDocument's own header says so — so this does
 * not reach for getVisaDocumentTypeSeed(): that lookup would miss on all
 * three of the codes actually in use and produce a checklist of blanks.
 *
 * The display name therefore comes from the attached document's real
 * label where there is one, and from the code itself where there is not.
 * Title-casing a code is a presentation transform of a real value; it is
 * not invented reference data.
 * ───────────────────────────────────────────────────────────────────── */

/**
 * Exported for consumer.applicationChecklist.test.ts.
 *
 * The join this performs is the whole of the rejection-visibility fix and
 * it has two properties worth pinning independently of the route: it keys
 * on the stored object rather than on docCode, and a rejected file is not
 * counted as attached. Both are cheap to get wrong in a later edit and
 * neither is visible from the endpoint's happy path.
 */
/**
 * IS THIS REQUIREMENT MET — the list's half of the rejection rule.
 *
 * Exported for consumer.applicationChecklist.test.ts, and for the same
 * reason checklistRows() is: the rule ("a rejected file does not satisfy
 * the requirement it was uploaded for") now lives on two read paths, and
 * a fix applied to one of them and not the other is exactly the bug this
 * function was added to close.
 *
 * `rejected` is keyed `${applicationId}|${s3Key}` — see the list route.
 */
export function satisfiedDocCode(
  applicationId: string,
  doc: any | undefined,
  rejected: Set<string>,
): boolean {
  if (!doc) return false;
  const storageKey = String(doc.storageKey ?? "");
  // No storage key means nothing to join on. The document is present, so
  // it counts — the rejection mirror is what could be missing here, and
  // an unjoinable row must not be assumed refused.
  if (!storageKey) return true;
  return !rejected.has(`${applicationId}|${storageKey}`);
}

export function checklistRows(application: any, attached: any[], reviewRows: any[] = []) {
  const byCode = new Map<string, any>();
  for (const doc of attached) {
    const code = String(doc.docCode ?? "").toUpperCase();
    if (code && !byCode.has(code)) byCode.set(code, doc);
  }

  /* The ops mirror, keyed by the STORED OBJECT the two rows share — see
   * the block at the read above for why this is not keyed on docCode. */
  const reviewByStorageKey = new Map<string, any>();
  for (const r of reviewRows) {
    const key = String(r.s3Key ?? "");
    if (key && !reviewByStorageKey.has(key)) reviewByStorageKey.set(key, r);
  }

  const groups = Array.isArray(application.ruleSnapshot?.documentGroups)
    ? application.ruleSnapshot.documentGroups
    : [];

  return groups.map((g: any) => ({
    key: g.key,
    label: g.label,
    requirement: g.requirement,
    specification: g.specification ?? null,
    docs: (Array.isArray(g.docTypeCodes) ? g.docTypeCodes : []).map((raw: any) => {
      const code = String(raw ?? "").toUpperCase();
      const doc = byCode.get(code) ?? null;
      const review = doc ? reviewByStorageKey.get(String(doc.storageKey ?? "")) ?? null : null;
      const rejected = review?.reviewStatus === "REJECTED";

      return {
        docCode: code,
        label: doc?.label || titleCaseCode(code),
        /* REJECTED IS NOT ATTACHED.
         *
         * This used to be `Boolean(doc)` — a file present meant a
         * requirement met, which stayed true after ops refused the file.
         * The applicant saw a tick against the very document they had
         * been asked to replace. A rejected row now reads as outstanding,
         * because it is. */
        attached: Boolean(doc) && !rejected,
        // Only ever the consumer's OWN filename, and only for a row they
        // themselves attached. No id, so this cannot become a fetch handle.
        filename: doc?.originalFilename ?? null,
        /* PENDING | VERIFIED | REJECTED, or null when nothing has been
         * mirrored for review yet (pre-submit, or a file ops has not
         * reached). Null is not "fine" — it is "not looked at". */
        reviewStatus: review?.reviewStatus ?? null,
        /* The concierge's own sentence, written FOR the applicant — the
         * admin route makes it mandatory on rejection precisely so there
         * is something to show here. Ops-authored copy, not extracted
         * applicant data, so it carries no PII of its own. */
        rejectionReason: rejected ? review?.rejectionReason ?? null : null,
        /* The mirror's id — a stable handle for the re-upload control, so
         * the client never has to re-derive which row was refused from a
         * docCode that may not be unique. */
        reviewDocumentId: review ? String(review._id) : null,
      };
    }),
  }));
}

/** Every doc code the frozen checklist asks for, de-duplicated across groups. */
function requiredDocCodes(application: any): string[] {
  const groups = Array.isArray(application.ruleSnapshot?.documentGroups)
    ? application.ruleSnapshot.documentGroups
    : [];
  const codes = new Set<string>();
  for (const g of groups) {
    for (const raw of Array.isArray(g.docTypeCodes) ? g.docTypeCodes : []) {
      const code = String(raw ?? "").toUpperCase();
      if (code) codes.add(code);
    }
  }
  return [...codes];
}

function titleCaseCode(code: string): string {
  const words = code.toLowerCase().split(/[_\s]+/).filter(Boolean);
  if (!words.length) return code;
  return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? " " + words.slice(1).join(" ") : "");
}

/* ─────────────────────────────────────────────────────────────────────
 * THE PRICE — FROZEN, AND WITHOUT THE B2B MARGIN FIELD.
 *
 * The snapshot carries `plumtripsServiceFeeInr`, and on a D2C case that
 * number is NOT what the consumer was charged. buildIndicativeCostSnapshot
 * stores the rule's B2B field verbatim (300 on the Thailand corridor)
 * while pricing the case from d2cServiceFeeInr (1500 + GST = the 1770
 * `totalInr`). Sending it would put a figure on a consumer's receipt that
 * is neither what they paid nor any line of it — and it would leak our
 * B2B margin besides. It is omitted, not relabelled.
 *
 * What CAN be told truthfully from frozen fields:
 *   pass-through  = embassyFeeInr + vfsFeeInr   (both stored, both real)
 *   ours          = totalInr - pass-through     (derived, includes GST)
 *
 * That is exactly the two-way split the Apply flow's review step already
 * shows ("Paid to the embassy & visa centre" / "Our service fee & GST"),
 * so the receipt and the quote use one vocabulary. A finer breakup would
 * need the D2C fee and its GST stored separately on the snapshot, which
 * they are not — and guessing the split out of a total would be fiction.
 * ───────────────────────────────────────────────────────────────────── */

function consumerPrice(application: any) {
  const snap = application.indicativeCostSnapshot ?? {};
  const embassy = Number(snap.embassyFeeInr);
  const vfs = Number(snap.vfsFeeInr);
  const total = Number(snap.totalInr);

  const passThroughInr =
    (Number.isFinite(embassy) ? embassy : 0) + (Number.isFinite(vfs) ? vfs : 0);

  return {
    embassyFeeInr: Number.isFinite(embassy) ? embassy : null,
    vfsFeeInr: Number.isFinite(vfs) ? vfs : null,
    passThroughInr,
    // Never negative, even if a snapshot were ever malformed — a receipt
    // showing a minus sign is worse than one showing zero.
    ourFeesInr: Number.isFinite(total) ? Math.max(0, total - passThroughInr) : null,
    totalInr: Number.isFinite(total) ? total : null,
    priceNote: snap.priceNote ?? null,
  };
}

/** The seed's country name where we have one, the rule's otherwise. */
function seedCountryName(rule: any): string {
  return findSeedCountry(rule.destinationIso2)?.countryName ?? rule.destinationName ?? rule.destinationIso2;
}

function parseDate(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export default router;
