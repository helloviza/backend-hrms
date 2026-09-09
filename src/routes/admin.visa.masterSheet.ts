// apps/backend/src/routes/admin.visa.masterSheet.ts
//
// THE MASTER SHEET — every D2C person who started, converted or not.
//
// ══════════════════════════════════════════════════════════════════════
// THIS IS NOT THE CONCIERGE QUEUE, AND MUST NOT BECOME IT.
// ══════════════════════════════════════════════════════════════════════
// The queue answers "what should an agent work next" and therefore shows
// only real, submitted cases. This sheet answers a commercial question —
// "who started, where did they stall, and which campaign sent them" — so
// its most valuable rows are exactly the ones the queue correctly refuses
// to show: people with no ticket at all.
//
// Reading one collection (VisaD2CLead) rather than joining applications is
// what makes that possible. A started row has no application to join to.
//
// ── SCOPE ────────────────────────────────────────────────────────────
// Cross-consumer by design — it is a sheet of everyone — gated on the
// same `visaApplication` READ permission as the concierge queue, because
// it is the same commercially-sensitive population viewed a different
// way. Consumer-side scoping (consumerId) does not apply here and would
// make the surface pointless; the gate is the permission.
//
// ── CONTACT MASKING APPLIES TO EVERY ROUTE IN THIS FILE ──────────────
// The gate (visaApplication READ) says who may read the funnel. It does
// NOT say who may read the funnel's ADDRESSES — that is
// consumerContactPII, resolved per request as a soft boolean and never as
// a second gate (services/capabilityProbe.ts).
//
// The unified /people route shipped with that rule. These two per-funnel
// routes did not, and for one release the console rendered them side by
// side: a reader without the grant saw "i•••@gmail.com" on the unified
// view and the full address one tab across, on the same page, about the
// same person. That is not a masked surface with a gap in it — it is an
// unmasked surface with a decoration on it, and the banner telling the
// reader their contacts were hidden was simply untrue.
//
// So the rule is now the FILE's rule, not one route's: every handler here
// resolves canSeeContacts once, and no contact value is written into any
// response body except through utils/piiMask.ts. If a route is added to
// this router, it does the same. `contactsMasked` rides on every response
// so the console can say which it is rather than leaving the reader to
// infer it from bullets.
import { Router } from "express";
import mongoose from "mongoose";

import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import VisaD2CLead from "../models/VisaD2CLead.js";
import VisaScoreLead from "../models/VisaScoreLead.js";
import Consumer from "../models/Consumer.js";
import {
  D2C_PAYMENT_STATUS_LABELS,
  D2C_STAGE_LABELS,
  D2C_STAGES,
  D2C_TRACKING_STATUSES,
  D2C_TRACKING_STATUS_LABELS,
} from "../models/visaD2CLifecycle.js";
import { objectIdKeys } from "../utils/objectIdKeys.js";
import logger from "../utils/logger.js";
// Contact masking — the SAME functions the unified sheet's shapeRow uses.
// One mask, three views; see the CONTACT MASKING note in the file header.
import { maskEmailAddress } from "../utils/piiMask.js";
// ── The unified per-person sheet's dependencies ──────────────────────
// Moved here with the routes below; nothing above this line uses them.
import { holdsCapability } from "../services/capabilityProbe.js";
import { rungVocabulary } from "../models/visaMasterSheetRungs.js";
import {
  MASTER_SHEET_EXPORT_MAX_ROWS,
  runMasterSheet,
  toCsv,
  type FunnelFilter,
  type MasterSheetFilters,
} from "../services/visaMasterSheet.js";
import { d2cWorkspaceObjectId } from "../services/consumerWorkspace.js";

const router = Router();
router.use(requireAuth);

const masterSheetLogger = logger.child({ module: "visaMasterSheet" });

router.get("/", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));

    const filter: Record<string, any> = {};

    if (req.query.status != null) {
      const v = String(req.query.status).trim().toUpperCase();
      if (!D2C_TRACKING_STATUSES.includes(v as any)) {
        return res.status(400).json({ error: `status must be one of ${D2C_TRACKING_STATUSES.join(", ")}` });
      }
      filter.status = v;
    }

    if (req.query.stage != null) {
      const v = String(req.query.stage).trim().toUpperCase();
      if (!D2C_STAGES.includes(v as any)) {
        return res.status(400).json({ error: `stage must be one of ${D2C_STAGES.join(", ")}` });
      }
      filter.stage = v;
    }

    if (req.query.destination != null) {
      const v = String(req.query.destination).trim().toUpperCase();
      if (v) filter.destinationIso2 = v;
    }

    /* ?converted=true|false — the question the sheet exists for. Expressed
     * on applicationId rather than on stage, because "has a ticket" is a
     * structural fact while a stage is a label somebody could add to. */
    if (req.query.converted === "true") filter.applicationId = { $ne: null };
    else if (req.query.converted === "false") filter.applicationId = null;

    if (req.query.utmSource != null) {
      const v = String(req.query.utmSource).trim();
      if (v) filter["utm.source"] = v;
    }

    /* ── NO SEARCH ORACLE ON THIS ROUTE ────────────────────────────────
     * Every filter above is an enum, an ISO2 code, a structural boolean or
     * a campaign tag. None of them touches a contact field, so — unlike
     * /score-leads below — there is nothing here a masked reader could use
     * to confirm an address by trial. Any filter added to this handler must
     * keep that true, or it needs the same conditional /score-leads has. */

    // ONCE per request, never per row — see capabilityProbe's header.
    const canSeeContacts = await holdsCapability(req, "consumerContactPII");

    const total = await VisaD2CLead.countDocuments(filter);
    const rows = await VisaD2CLead.find(filter)
      .sort({ startedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    /* The consumer join. objectIdKeys, not String() — the same guard the
     * queue's joins now use (utils/objectIdKeys.ts): a null id must never
     * reach an $in as the string "null". consumerId is `required` here so
     * this cannot currently be null, and the helper is used anyway because
     * "currently cannot" is not a property worth relying on. */
    const consumerIds = objectIdKeys(rows.map((r: any) => r.consumerId));
    /* `.select("name email")` — and NOT phone, deliberately. This view has
     * never rendered a phone number and adding one to the projection would
     * put a contact channel into the response that nothing on screen asks
     * for. If a phone column is ever wanted here, it is selected AND passed
     * through maskPhoneNumber on the same commit, the way the unified
     * sheet's shapeRow does it. */
    const consumers = consumerIds.length
      ? await Consumer.find({ _id: { $in: consumerIds } }).select("name email").lean()
      : [];
    const consumerById = new Map((consumers as any[]).map((c) => [String(c._id), c]));

    const shaped = rows.map((r: any) => {
      const consumer = consumerById.get(String(r.consumerId)) ?? null;
      return {
        id: String(r._id),
        consumer: consumer
          ? {
              id: String(consumer._id),
              // Name is NOT masked, on the same reasoning shapeRow gives:
              // it is what makes the row readable and it is not a channel.
              // The grant is consumerContactPII; a name is not a contact.
              name: consumer.name ?? null,
              email: canSeeContacts
                ? (consumer.email ?? null)
                : maskEmailAddress(consumer.email),
            }
          : null,
        destinationIso2: r.destinationIso2,
        destinationName: r.destinationName,
        purpose: r.purpose ?? null,

        // Stored enums PLUS their labels — the console renders labels and
        // holds no copy of the vocabulary.
        status: r.status,
        statusLabel: D2C_TRACKING_STATUS_LABELS[r.status as keyof typeof D2C_TRACKING_STATUS_LABELS] ?? r.status,
        stage: r.stage,
        stageLabel: D2C_STAGE_LABELS[r.stage as keyof typeof D2C_STAGE_LABELS] ?? r.stage,
        paymentStatus: r.paymentStatus,
        paymentStatusLabel:
          D2C_PAYMENT_STATUS_LABELS[r.paymentStatus as keyof typeof D2C_PAYMENT_STATUS_LABELS] ??
          r.paymentStatus,

        // Every D2C row's channel is D2C by construction — this collection
        // has no other kind. Sent as the stored enum so the console's
        // display-label mapping is the SAME one the applications tab uses.
        source: "D2C",

        // THE SEAM: null here is Scenario 1 (started, no ticket).
        applicationId: r.applicationId ? String(r.applicationId) : null,
        referenceNumber: r.referenceNumber ?? null,
        hasTicket: Boolean(r.applicationId),

        utm: {
          source: r.utm?.source ?? "",
          medium: r.utm?.medium ?? "",
          campaign: r.utm?.campaign ?? "",
          content: r.utm?.content ?? "",
          term: r.utm?.term ?? "",
        },

        startedAt: r.startedAt ?? null,
        submittedAt: r.submittedAt ?? null,
        updatedAt: r.updatedAt ?? null,
      };
    });

    /* Funnel counts over the WHOLE filtered set, not the page — a sheet
     * whose totals changed as you paged would be worse than no totals. */
    const [started, converted] = await Promise.all([
      VisaD2CLead.countDocuments({ ...filter, applicationId: null }),
      VisaD2CLead.countDocuments({ ...filter, applicationId: { $ne: null } }),
    ]);

    return res.json({
      ok: true,
      rows: shaped,
      summary: { total, startedNoTicket: started, converted },
      // Same flag, same name, same meaning as the unified /people response —
      // so the console renders one masking affordance for all three views
      // instead of three that can drift apart.
      contactsMasked: !canSeeContacts,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err: any) {
    masterSheetLogger.error("master sheet read failed", { error: err?.message });
    return res.status(500).json({ error: "Failed to load the master sheet" });
  }
});

/* ══════════════════════════════════════════════════════════════════════
 * GET /score-leads — THE VISA SCORE CALC TAB
 * ══════════════════════════════════════════════════════════════════════
 * A second population on the same sheet, and deliberately a second
 * ENDPOINT rather than a mode flag on the one above: the two read
 * different collections with different keys and different meanings, and
 * a shared handler branching on a query parameter would be two functions
 * wearing one name.
 *
 * Same guard as the apply funnel — visaApplication READ — because it is
 * the same commercially-sensitive population viewed a different way, and
 * splitting the permission would mean an ops user who can see somebody's
 * application cannot see that they measured their odds first.
 *
 * ⚠ NO ANSWERS ARE READABLE HERE, because none are stored. See
 * models/VisaScoreLead.ts: the collection holds the OUTPUT (score, band,
 * range) and never the compliance or character answers behind it.
 */
router.get("/score-leads", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));

    const filter: Record<string, any> = {};

    if (req.query.destination != null) {
      const v = String(req.query.destination).trim().toUpperCase();
      if (v) filter.destinationIso2 = v;
    }

    /* "Did they have an account?" is the adoption question this tab is
     * for, so it is a first-class filter rather than something to eyeball
     * down a column. */
    if (req.query.hadAccount === "true") filter.hadAccount = true;
    if (req.query.hadAccount === "false") filter.hadAccount = false;

    // ONCE per request, never per row — see capabilityProbe's header.
    const canSeeContacts = await holdsCapability(req, "consumerContactPII");

    if (req.query.q != null) {
      const q = String(req.query.q).trim();
      if (q) {
        const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        /* ── THE SEARCH ORACLE, CLOSED ─────────────────────────────────
         * The email clause is added ONLY for a reader entitled to read
         * addresses — the same rule applyEmailSearch() enforces on the
         * unified sheet, and it has to be here too or the mask on THIS
         * endpoint is decorative.
         *
         * A masked reader is shown "i•••@gmail.com". If q also searched
         * email, that reader could type a full address and learn from a
         * single hit whether that exact person is in the funnel —
         * recovering the value the mask exists to withhold, one guess at a
         * time, with no rate limit and no audit trail. A mask that can be
         * interrogated is not a mask.
         *
         * Name and destination stay searchable for everyone: both are on
         * screen unmasked, so searching them reveals nothing the row does
         * not already show. */
        const or: any[] = [{ name: rx }, { destinationName: rx }];
        if (canSeeContacts) or.push({ email: rx });
        filter.$or = or;
      }
    }

    const total = await VisaScoreLead.countDocuments(filter);
    const rows = await VisaScoreLead.find(filter)
      .sort({ lastCheckedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const shaped = (rows as any[]).map((r) => ({
      id: String(r._id),
      /* The address is the KEY of this collection, not a joined field — a
       * score lead is an email and a result, and most of these people have
       * no account at all. That makes it the most marketable contact list
       * in the product and the one most in need of the grant, not the
       * least. VisaScoreLead stores no phone number, so there is nothing
       * else on this row to mask. */
      email: canSeeContacts ? r.email : maskEmailAddress(r.email),
      name: r.name ?? null,
      consumerId: r.consumerId ? String(r.consumerId) : null,
      hadAccount: Boolean(r.hadAccount),

      destinationIso2: r.destinationIso2,
      destinationName: r.destinationName,

      score: r.score ?? null,
      band: r.band ?? null,
      rangeLow: r.rangeLow ?? null,
      rangeHigh: r.rangeHigh ?? null,

      checkCount: r.checkCount ?? 1,
      firstCheckedAt: r.firstCheckedAt ?? null,
      lastCheckedAt: r.lastCheckedAt ?? null,

      utm: {
        source: r.utm?.source ?? "",
        medium: r.utm?.medium ?? "",
        campaign: r.utm?.campaign ?? "",
        content: r.utm?.content ?? "",
        term: r.utm?.term ?? "",
      },

      consentBasis: r.consentBasis ?? null,
      disclosureShownAt: r.disclosureShownAt ?? null,
    }));

    /* Adoption counts over the WHOLE filtered set, not the page — same
     * rule the apply funnel's totals follow. `repeatCheckers` is the one
     * number the row count cannot show, because the collection upserts.
     *
     * $and, NOT a spread. `{ ...filter, hadAccount: true }` silently
     * OVERWRITES an active hadAccount filter, so asking for "no account"
     * returned two rows under a header claiming one of them had one —
     * a summary contradicting the rows directly beneath it. Caught by
     * admin.visa.masterSheet.scoreLeads.test.ts before review. */
    const [withAccount, repeatCheckers] = await Promise.all([
      VisaScoreLead.countDocuments({ $and: [filter, { hadAccount: true }] }),
      VisaScoreLead.countDocuments({ $and: [filter, { checkCount: { $gt: 1 } }] }),
    ]);

    return res.json({
      ok: true,
      rows: shaped,
      summary: {
        total,
        withAccount,
        withoutAccount: Math.max(0, total - withAccount),
        repeatCheckers,
      },
      contactsMasked: !canSeeContacts,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err: any) {
    masterSheetLogger.error("score leads read failed", { error: err?.message });
    return res.status(500).json({ error: "Failed to load the Visa Score leads" });
  }
});

/* ══════════════════════════════════════════════════════════════════════
 * MOVED HERE FROM routes/admin.visa.ts (Deploy 3) — SAME URLS.
 * ══════════════════════════════════════════════════════════════════════
 * These two routes shipped on adminVisaRouter, which mounts at
 * /api/admin/visa, so they carried the "/master-sheet/" segment in their own
 * path strings. That gave the /api/admin/visa/master-sheet prefix TWO owning
 * routers, resolved only by which one server.ts mounts first.
 *
 * They now live on the router that already owns the prefix, and their paths
 * lost the segment the mount supplies:
 *
 *   before  adminVisaRouter            "/master-sheet/people"         -> /api/admin/visa/master-sheet/people
 *   after   adminVisaMasterSheetRouter "/people"                      -> /api/admin/visa/master-sheet/people
 *   before  adminVisaRouter            "/master-sheet/people/export"  -> /api/admin/visa/master-sheet/people/export
 *   after   adminVisaMasterSheetRouter "/people/export"               -> /api/admin/visa/master-sheet/people/export
 *
 * Byte-identical URLs, identical guards (requireAuth at the top of this file,
 * requirePermission per route), identical handlers. The ONE deliberate change
 * is the log module tag: these lines now carry module:"visaMasterSheet" like
 * everything else in this file, instead of module:"admin.visa".
 */

/* ═════════════════════════════════════════════════════════════════════
 * THE UNIFIED MASTER SHEET — one row per PERSON.
 * ═════════════════════════════════════════════════════════════════════
 *
 * The pipeline, the ladder and the masking all live in
 * services/visaMasterSheet.ts; these two routes are the HTTP edge and
 * nothing more. That split is what lets B6 exercise the aggregation against
 * real collections without standing up Express, and it is why the export
 * cannot drift from the list — both call the same shaping function, from
 * the same service, with the same resolved grant.
 *
 * ── TWO PERMISSIONS, TWO DIFFERENT QUESTIONS ──────────────────────────
 * The GATE is visaApplication:READ — the same one the concierge queue uses.
 * Everyone who may work visa cases may read this sheet.
 *
 * The CONTACT COLUMN is consumerContactPII, resolved as a soft boolean
 * (services/capabilityProbe.ts) rather than as a second gate. A reader
 * without it gets the whole sheet with addresses and phone numbers masked —
 * not a 403. See the capability's note in models/UserPermission.ts for why
 * it is a sibling of visaApplication and not a tier of it: this is a
 * marketing-list-shaped power, and a caseworker does not need it to work a
 * case.
 */

function parseMasterSheetFilters(req: any): MasterSheetFilters {
  const num = (v: unknown): number | null => {
    if (v === undefined || v === null || String(v).trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const funnel = String(req.query?.funnel ?? "").toUpperCase();
  const sort = String(req.query?.sort ?? "");
  return {
    q: req.query?.q ? String(req.query.q) : null,
    rungMin: num(req.query?.rungMin),
    rungMax: num(req.query?.rungMax),
    destination: req.query?.destination ? String(req.query.destination) : null,
    funnel: ["SCORE", "APPLY", "REGISTERED"].includes(funnel) ? (funnel as FunnelFilter) : null,
    // ?campaignSource= — "any touch", never the first-touch column. See the
    // field's note on MasterSheetFilters for why the two differ on purpose.
    campaignSource: req.query?.campaignSource ? String(req.query.campaignSource) : null,
    sort: ["lastActivity", "firstSeen", "rung"].includes(sort) ? (sort as any) : null,
    direction: String(req.query?.direction) === "asc" ? "asc" : "desc",
    page: Number(req.query?.page) || 1,
    pageSize: Number(req.query?.pageSize) || 50,
  };
}

router.get(
  "/people",
  requirePermission("visaApplication", "READ"),
  async (req: any, res: any) => {
    try {
      const filters = parseMasterSheetFilters(req);
      // ONCE per request, never per row — see capabilityProbe's header.
      const canSeeContacts = await holdsCapability(req, "consumerContactPII");

      const result = await runMasterSheet(filters, { canSeeContacts });

      /* Instrumented because this is the one read on this router that unions
       * three collections and groups without a bound. A slow sheet is the
       * first symptom of the funnel growing, and a duration in the log is
       * what turns that into a number somebody can act on before it becomes
       * a timeout.
       *
       * NO PII IN THE LINE. The free-text `q` is a search term a reader
       * typed and can perfectly well be somebody's email address, so only
       * its LENGTH is recorded — logging the term itself would put the
       * addresses back into a place the masking cannot reach. */
      masterSheetLogger.info("master sheet read", {
        durationMs: result.meta.durationMs,
        rows: result.rows.length,
        total: result.total,
        contactsMasked: result.contactsMasked,
        consumerArmIncluded: result.meta.consumerArmIncluded,
        sortArrayUsed: result.meta.sortArrayUsed,
        mongoVersion: result.meta.mongoVersion,
        legacyUnkeyedLeads: result.legacyUnkeyedLeads,
        qLength: filters.q ? String(filters.q).length : 0,
      });

      res.json({
        ok: true,
        ...result,
        // The console holds NO copy of the ladder — it renders these labels
        // and filters on the integers. See models/visaMasterSheetRungs.ts.
        vocabulary: rungVocabulary(),
      });
    } catch (err: any) {
      masterSheetLogger.error("master sheet read failed", { message: err?.message });
      res.status(500).json({ error: err?.message || "Failed to load the master sheet" });
    }
  },
);

/**
 * CSV export.
 *
 * ── IT HONOURS THE GRANT BY CONSTRUCTION ──────────────────────────────
 * It does not re-query and it does not re-shape: it runs the SAME service
 * with the same resolved `canSeeContacts`, and toCsv() only accepts rows
 * that shapeRow() produced. A masked reader exports a file of masked
 * addresses, and there is no code path here that could produce anything
 * else — which matters more on this route than on the list, because the
 * output leaves the building as a file.
 *
 * ── AND IT IS LOGGED EITHER WAY ───────────────────────────────────────
 * Who, with what filter, how many rows, and whether the contacts were
 * masked. An export of the entire consumer funnel is exactly the act that
 * has to be answerable months later, and "masked or not" is the fact that
 * makes the row meaningful — the same export by two readers is two very
 * different events.
 */
router.get(
  "/people/export",
  requirePermission("visaApplication", "READ"),
  async (req: any, res: any) => {
    try {
      const filters = parseMasterSheetFilters(req);
      const canSeeContacts = await holdsCapability(req, "consumerContactPII");

      const result = await runMasterSheet(
        { ...filters, page: 1, pageSize: MASTER_SHEET_EXPORT_MAX_ROWS },
        { canSeeContacts },
      );

      const actorId = String(req.user?._id || req.user?.id || req.user?.sub || "");
      try {
        await mongoose.connection.collection("workspaceauditlogs").insertOne({
          workspaceId: d2cWorkspaceObjectId(),
          event: "VISA_MASTER_SHEET_EXPORT",
          runAt: new Date(),
          triggeredBy: actorId,
          status: "SUCCESS",
          details:
            `rows=${result.rows.length} total=${result.total} ` +
            `contactsMasked=${result.contactsMasked} ` +
            `rungMin=${filters.rungMin ?? ""} rungMax=${filters.rungMax ?? ""} ` +
            `destination=${filters.destination ?? ""} funnel=${filters.funnel ?? ""} ` +
            // A campaign-scoped export is a different act from a whole-funnel
            // one, so the filter that scoped it belongs in the record.
            `campaignSource=${filters.campaignSource ?? ""} ` +
            `qLength=${filters.q ? String(filters.q).length : 0}`,
        });
      } catch {
        /* Non-fatal, deliberately: an audit write that fails must not hand
         * the reader a 500 for an export that already succeeded. The logger
         * line below is the second record, and it is not optional. */
      }
      masterSheetLogger.info("master sheet exported", {
        actorId,
        rows: result.rows.length,
        total: result.total,
        contactsMasked: result.contactsMasked,
        durationMs: result.meta.durationMs,
      });

      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      // The filename says which kind of export this is. A masked file that
      // looks like a full one is how a half-empty contact list ends up
      // pasted into a campaign tool.
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="visa-master-sheet-${stamp}${result.contactsMasked ? "-masked" : ""}.csv"`,
      );
      res.send(toCsv(result.rows));
    } catch (err: any) {
      masterSheetLogger.error("master sheet export failed", { message: err?.message });
      res.status(500).json({ error: err?.message || "Failed to export the master sheet" });
    }
  },
);

export default router;
