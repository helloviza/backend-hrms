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
import { Router } from "express";
import mongoose from "mongoose";

import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import VisaD2CLead from "../models/VisaD2CLead.js";
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
    const consumers = consumerIds.length
      ? await Consumer.find({ _id: { $in: consumerIds } }).select("name email").lean()
      : [];
    const consumerById = new Map((consumers as any[]).map((c) => [String(c._id), c]));

    const shaped = rows.map((r: any) => {
      const consumer = consumerById.get(String(r.consumerId)) ?? null;
      return {
        id: String(r._id),
        consumer: consumer
          ? { id: String(consumer._id), name: consumer.name ?? null, email: consumer.email ?? null }
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
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err: any) {
    masterSheetLogger.error("master sheet read failed", { error: err?.message });
    return res.status(500).json({ error: "Failed to load the master sheet" });
  }
});

export default router;
