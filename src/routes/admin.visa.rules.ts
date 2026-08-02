// apps/backend/src/routes/admin.visa.rules.ts
//
// Phase 7a — fee and rule management API. STAFF routes, cross-workspace by
// design: VisaRule and VisaDestinationContent are global reference data
// (see models/VisaRule.ts, models/VisaDestinationContent.ts), not scoped to
// any one customer workspace, so — same posture as admin.visa.ts — nothing
// here calls requireWorkspace or filters on req.workspaceObjectId.
//
// Mounted alongside admin.visa.ts at the same /api/admin/visa prefix
// (server.ts), as its own file rather than appended to admin.visa.ts:
// admin.visa.ts is the application-queue/outcome surface (who's working
// which case); this is the fee-and-rule-master surface (what a case is
// even quoted against). Different concern, same URL namespace.
//
// Gating: every single route here — including the GET list/detail reads —
// requires the visaApplication permission key at FULL, not the READ/WRITE/
// FULL ladder admin.visa.ts uses for its application routes. Editing (or
// even previewing DRAFT) prices is a different authority from working a
// case day-to-day; FULL is the only level that grants it. requirePermission
// already gives SUPERADMIN a bypass — no separate role check on top.
//
// Audit trail: every POST/PATCH that changes a VisaRule's identity, terms,
// or lifecycle status writes exactly one VisaRuleAudit row in the same
// request (models/VisaRuleAudit.ts) — see writeRuleAudit() below. Nothing
// here ever mutates a VisaApplication's ruleSnapshot; applications embed a
// point-in-time copy at quote time and never re-read VisaRule afterward
// (models/VisaApplication.ts's file header), so editing/retiring a rule is
// safe by construction — it changes what FUTURE applications are quoted
// against, never what an in-flight one already captured.

import { Router } from "express";
import mongoose from "mongoose";
import { isDeepStrictEqual } from "node:util";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import VisaRule, {
  VISA_PURPOSES,
  VISA_ENTRY_TYPES,
  VISA_SERVICE_TIERS,
  VISA_PRODUCT_CLASSES,
  VISA_CATEGORIES,
  VISA_ETA_BASES,
  VISA_DOC_REQUIREMENT_LEVELS,
  type VisaPurpose,
  type VisaEntryType,
  type VisaServiceTier,
  type VisaProductClass,
  type VisaCategory,
  type VisaEtaBasis,
  type VisaDocumentRequirement,
} from "../models/VisaRule.js";
import VisaDestinationContent from "../models/VisaDestinationContent.js";
import VisaRuleAudit, { type VisaRuleFieldChange, type VisaRuleAuditAction } from "../models/VisaRuleAudit.js";
import User from "../models/User.js";
import { VISA_DOCUMENT_CODE_SET } from "../config/visaDocumentCodes.js";
import logger from "../utils/logger.js";

const router = Router();
const rulesLogger = logger.child({ module: "admin.visa.rules" });

router.use(requireAuth);

function actorId(req: any): any {
  return req.user?._id ?? req.user?.id ?? req.user?.sub;
}

function resolveUserName(u: any): string {
  if (!u) return "Unknown";
  return u.name || [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || "Unknown";
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isIso2(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z]{2}$/.test(v.trim());
}

// Returns the parsed Date, or null if `v` is missing/unparseable — callers
// decide whether missing is an error (PATCH/bulk require it; POST/clone
// default it to now).
function parseOptionalDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ─────────────────────────────────────────────────────────────────────
 * Field model shared by create/update/clone/bulk.
 *
 * IDENTITY_FIELDS form the unique lookup key (VisaRule.ts's compound
 * index) — settable only at creation (or via clone, which is itself a
 * creation) and immutable afterward. Changing a destination/purpose/tier
 * on an EXISTING rule via PATCH would either collide with another rule's
 * key or silently repoint what an admin thought was "Germany tourist" at
 * a different lookup slot — clone-to-a-new-key is the only sanctioned way
 * to get a new key, and it always makes a new document.
 *
 * EDITABLE_FIELDS are the terms PATCH/bulk may change. displayMode is
 * deliberately absent — it's server-derived (VisaRule.ts's pre-validate
 * hook) from whichever itemised fee fields are set, never client-supplied.
 * status is also absent — publish/retire are the only ways to move it.
 * ───────────────────────────────────────────────────────────────────── */
const IDENTITY_FIELDS = ["nationality", "destinationIso2", "purpose", "entryType", "serviceTier"] as const;
const EDITABLE_FIELDS = [
  "destinationName",
  "isSchengen",
  "productClass",
  "visaCategory",
  "validityDays",
  "maxStayDays",
  "isExtension",
  "etaMinDays",
  "etaMaxDays",
  "etaBasis",
  "appointmentRequired",
  "biometricsRequired",
  "documentRequirements",
  "embassyFeeInr",
  "vfsFeeInr",
  "plumtripsServiceFeeInr",
  "indicativeVisaCostInr",
  "priceNote",
] as const;
// The full set diffFields() ever compares over — identity + editable +
// the two fields that move outside EDITABLE_FIELDS (effectiveFrom is
// caller-supplied but handled separately per route; status and
// displayMode are server-derived/transition-only).
// Exported for routes/admin.visa.rules.importExport.ts's own diff/audit —
// that route edits a DIFFERENT field set (documentGroups, opsNotes; see its
// own file header for why), but reuses diffFields/writeRuleAudit/
// mapRuleSummary verbatim rather than re-implementing the same comparison
// and audit-write logic a second time.
export const AUDITABLE_FIELDS = [...IDENTITY_FIELDS, ...EDITABLE_FIELDS, "effectiveFrom", "status", "displayMode"] as const;

interface ValidationResult {
  ok: boolean;
  error?: string;
  fields?: Record<string, any>;
}

function validateDocumentRequirements(value: unknown): string | null {
  if (!Array.isArray(value)) return "documentRequirements must be an array";
  for (const [i, item] of value.entries()) {
    if (!item || typeof item !== "object") return `documentRequirements[${i}] must be an object`;
    const docCode = (item as any).docCode;
    const requirement = (item as any).requirement;
    if (typeof docCode !== "string" || !VISA_DOCUMENT_CODE_SET.has(docCode)) {
      return `documentRequirements[${i}].docCode must be a known document code (config/visaDocumentCodes.ts)`;
    }
    if (!VISA_DOC_REQUIREMENT_LEVELS.includes(requirement)) {
      return `documentRequirements[${i}].requirement must be one of ${VISA_DOC_REQUIREMENT_LEVELS.join(", ")}`;
    }
  }
  return null;
}

// Whitelists + validates the editable-term fields present in `body`
// (partial — only keys actually present are returned). requireIdentity
// additionally requires + validates IDENTITY_FIELDS (create/clone);
// PATCH/bulk pass requireIdentity=false and REJECT identity fields or
// `status` being present at all, rather than silently ignoring them —
// a caller who tries to rekey or force-publish through this path should
// get a clear error, not a silent no-op.
function validateRuleFields(body: any, opts: { requireIdentity: boolean }): ValidationResult {
  const b = body || {};
  const fields: Record<string, any> = {};

  if (!opts.requireIdentity) {
    for (const key of IDENTITY_FIELDS) {
      if (b[key] !== undefined) {
        return { ok: false, error: `${key} is part of this rule's identity and cannot be changed here — clone to a new destination/purpose/tier instead` };
      }
    }
    if (b.status !== undefined) {
      return { ok: false, error: "status cannot be set directly — use POST /rules/:id/publish or /rules/:id/retire" };
    }
  } else {
    if (!isIso2(b.nationality)) return { ok: false, error: "nationality must be a 2-letter ISO country code" };
    if (!isIso2(b.destinationIso2)) return { ok: false, error: "destinationIso2 must be a 2-letter ISO country code" };
    if (!VISA_PURPOSES.includes(b.purpose)) return { ok: false, error: `purpose must be one of ${VISA_PURPOSES.join(", ")}` };
    if (!VISA_ENTRY_TYPES.includes(b.entryType)) return { ok: false, error: `entryType must be one of ${VISA_ENTRY_TYPES.join(", ")}` };
    if (!VISA_SERVICE_TIERS.includes(b.serviceTier)) return { ok: false, error: `serviceTier must be one of ${VISA_SERVICE_TIERS.join(", ")}` };
    fields.nationality = String(b.nationality).trim().toUpperCase();
    fields.destinationIso2 = String(b.destinationIso2).trim().toUpperCase();
    fields.purpose = b.purpose as VisaPurpose;
    fields.entryType = b.entryType as VisaEntryType;
    fields.serviceTier = b.serviceTier as VisaServiceTier;

    if (!b.destinationName || !String(b.destinationName).trim()) {
      return { ok: false, error: "destinationName is required" };
    }
    if (!VISA_PRODUCT_CLASSES.includes(b.productClass)) {
      return { ok: false, error: `productClass must be one of ${VISA_PRODUCT_CLASSES.join(", ")}` };
    }
    if (!VISA_CATEGORIES.includes(b.visaCategory)) {
      return { ok: false, error: `visaCategory must be one of ${VISA_CATEGORIES.join(", ")}` };
    }
  }

  if (b.destinationName !== undefined) {
    if (!String(b.destinationName).trim()) return { ok: false, error: "destinationName cannot be empty" };
    fields.destinationName = String(b.destinationName).trim();
  }
  if (b.isSchengen !== undefined) {
    if (typeof b.isSchengen !== "boolean") return { ok: false, error: "isSchengen must be a boolean" };
    fields.isSchengen = b.isSchengen;
  }
  if (b.productClass !== undefined) {
    if (!VISA_PRODUCT_CLASSES.includes(b.productClass)) return { ok: false, error: `productClass must be one of ${VISA_PRODUCT_CLASSES.join(", ")}` };
    fields.productClass = b.productClass as VisaProductClass;
  }
  if (b.visaCategory !== undefined) {
    if (!VISA_CATEGORIES.includes(b.visaCategory)) return { ok: false, error: `visaCategory must be one of ${VISA_CATEGORIES.join(", ")}` };
    fields.visaCategory = b.visaCategory as VisaCategory;
  }
  for (const key of ["validityDays", "maxStayDays", "etaMinDays", "etaMaxDays"] as const) {
    if (b[key] !== undefined) {
      if (!isNonNegativeNumber(b[key])) return { ok: false, error: `${key} must be a non-negative number` };
      fields[key] = b[key];
    }
  }
  if (b.etaBasis !== undefined) {
    if (!VISA_ETA_BASES.includes(b.etaBasis)) return { ok: false, error: `etaBasis must be one of ${VISA_ETA_BASES.join(", ")}` };
    fields.etaBasis = b.etaBasis as VisaEtaBasis;
  }
  if (b.isExtension !== undefined) {
    if (typeof b.isExtension !== "boolean") return { ok: false, error: "isExtension must be a boolean" };
    fields.isExtension = b.isExtension;
  }
  if (b.appointmentRequired !== undefined) {
    if (typeof b.appointmentRequired !== "boolean") return { ok: false, error: "appointmentRequired must be a boolean" };
    fields.appointmentRequired = b.appointmentRequired;
  }
  if (b.biometricsRequired !== undefined) {
    if (typeof b.biometricsRequired !== "boolean") return { ok: false, error: "biometricsRequired must be a boolean" };
    fields.biometricsRequired = b.biometricsRequired;
  }
  if (b.documentRequirements !== undefined) {
    const docErr = validateDocumentRequirements(b.documentRequirements);
    if (docErr) return { ok: false, error: docErr };
    fields.documentRequirements = b.documentRequirements as VisaDocumentRequirement[];
  }
  for (const key of ["embassyFeeInr", "vfsFeeInr", "plumtripsServiceFeeInr", "indicativeVisaCostInr"] as const) {
    if (b[key] !== undefined) {
      if (!isNonNegativeNumber(b[key])) return { ok: false, error: `${key} must be a non-negative number` };
      fields[key] = b[key];
    }
  }
  if (b.priceNote !== undefined) {
    fields.priceNote = String(b.priceNote ?? "").trim();
  }

  return { ok: true, fields };
}

/* ─────────────────────────────────────────────────────────────────────
 * Shaping + diff helpers.
 * ───────────────────────────────────────────────────────────────────── */
export function mapRuleSummary(r: any) {
  return {
    id: String(r._id),
    nationality: r.nationality,
    destinationIso2: r.destinationIso2,
    destinationName: r.destinationName,
    purpose: r.purpose,
    entryType: r.entryType,
    serviceTier: r.serviceTier,
    isSchengen: r.isSchengen,
    productClass: r.productClass,
    visaCategory: r.visaCategory,
    validityDays: r.validityDays ?? null,
    maxStayDays: r.maxStayDays ?? null,
    isExtension: r.isExtension,
    etaMinDays: r.etaMinDays ?? null,
    etaMaxDays: r.etaMaxDays ?? null,
    etaBasis: r.etaBasis ?? null,
    appointmentRequired: r.appointmentRequired,
    biometricsRequired: r.biometricsRequired,
    documentRequirements: r.documentRequirements || [],
    embassyFeeInr: r.embassyFeeInr ?? null,
    vfsFeeInr: r.vfsFeeInr ?? null,
    plumtripsServiceFeeInr: r.plumtripsServiceFeeInr ?? null,
    indicativeVisaCostInr: r.indicativeVisaCostInr ?? null,
    displayMode: r.displayMode ?? null,
    priceNote: r.priceNote ?? null,
    // Display-only annotation (models/VisaRule.ts) — not in EDITABLE_FIELDS,
    // same provenance-not-editable treatment mapContentSummary gives
    // seedSource; visible here so ops actually sees it when reviewing a rule.
    opsNotes: r.opsNotes ?? null,
    status: r.status,
    effectiveFrom: r.effectiveFrom,
    lastReviewedAt: r.lastReviewedAt ?? null,
    reviewedBy: r.reviewedBy ? String(r.reviewedBy) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function mapContentSummary(c: any) {
  return {
    destinationIso2: c.destinationIso2,
    status: c.status,
    businessBlock: c.businessBlock,
    tourismBlock: c.tourismBlock,
    entrySnapshot: c.entrySnapshot,
    heroImageUrl: c.heroImageUrl ?? null,
    lastReviewedAt: c.lastReviewedAt ?? null,
    // Provenance marker (models/VisaDestinationContent.ts) — set only on
    // rows scripts/seed-visa-rules.ts wrote. The UI uses this to flag
    // unreviewed, LLM-authored placeholder copy before anyone publishes it.
    seedSource: c.seedSource ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// `before`/`after` are plain field maps (not full Mongoose docs — callers
// pass whatever subset of AUDITABLE_FIELDS they have on each side).
// Order-independent structural equality (isDeepStrictEqual) so a
// documentRequirements array rebuilt with the same items in the same
// order — but constructed via a different code path — never registers as
// a false-positive change; only a REAL value difference is recorded.
export function diffFields(before: Record<string, any>, after: Record<string, any>, fields: readonly string[]): VisaRuleFieldChange[] {
  const changes: VisaRuleFieldChange[] = [];
  for (const field of fields) {
    const fromVal = before[field] ?? null;
    const toVal = after[field] ?? null;
    if (!isDeepStrictEqual(fromVal, toVal)) {
      changes.push({ field, from: fromVal, to: toVal });
    }
  }
  return changes;
}

export async function writeRuleAudit(
  ruleId: any,
  action: VisaRuleAuditAction,
  changes: VisaRuleFieldChange[],
  userId: any,
  opts: { clonedFromRuleId?: any; session?: any } = {},
): Promise<void> {
  const doc: any = {
    ruleId,
    action,
    changes,
    performedByUserId: userId,
    performedAt: new Date(),
  };
  if (opts.clonedFromRuleId) doc.clonedFromRuleId = opts.clonedFromRuleId;
  await VisaRuleAudit.create([doc], opts.session ? { session: opts.session } : undefined);
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /rules — filter by destination, purpose, status. No pagination —
 * this is back-office reference-data browsing (dozens of rows, not
 * thousands); add it if that stops being true.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/rules", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const filter: any = {};
    if (req.query.destination != null) {
      const destination = String(req.query.destination).trim().toUpperCase();
      if (!isIso2(destination)) return res.status(400).json({ error: "destination must be a 2-letter ISO country code" });
      filter.destinationIso2 = destination;
    }
    if (req.query.purpose != null) {
      const purpose = String(req.query.purpose).trim().toUpperCase();
      if (!VISA_PURPOSES.includes(purpose as VisaPurpose)) {
        return res.status(400).json({ error: `purpose must be one of ${VISA_PURPOSES.join(", ")}` });
      }
      filter.purpose = purpose;
    }
    if (req.query.status != null) {
      const status = String(req.query.status).trim().toUpperCase();
      if (!["DRAFT", "PUBLISHED", "RETIRED"].includes(status)) {
        return res.status(400).json({ error: "status must be one of DRAFT, PUBLISHED, RETIRED" });
      }
      filter.status = status;
    }

    const rules = await VisaRule.find(filter).sort({ destinationIso2: 1, purpose: 1, entryType: 1, serviceTier: 1 }).lean();
    res.json({ ok: true, rules: rules.map(mapRuleSummary) });
  } catch (err: any) {
    console.error("[admin visa rules GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load visa rules" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /rules/:id — detail.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/rules/:id", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: "Visa rule not found" });

    const rule = await VisaRule.findById(id).lean();
    if (!rule) return res.status(404).json({ error: "Visa rule not found" });

    res.json({ ok: true, rule: mapRuleSummary(rule) });
  } catch (err: any) {
    console.error("[admin visa rule detail GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load visa rule" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /rules/:id/audit — this rule's change history, newest first. The
 * one thing Phase 7a's route list was missing (no way to read back what
 * writeRuleAudit() has been recording since then) — a revenue audit trail
 * nobody can read via API is not much of an audit trail. Resolves each
 * entry's performedByUserId to a display name so the UI never has to.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/rules/:id/audit", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: "Visa rule not found" });

    const rule = await VisaRule.findById(id).select("_id").lean();
    if (!rule) return res.status(404).json({ error: "Visa rule not found" });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const total = await VisaRuleAudit.countDocuments({ ruleId: id });
    const entries = await VisaRuleAudit.find({ ruleId: id })
      .sort({ performedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const userIds = [...new Set(entries.map((e: any) => String(e.performedByUserId)).filter(Boolean))];
    const users = await User.find({ _id: { $in: userIds } }).select("firstName lastName name email").lean();
    const userById = new Map(users.map((u: any) => [String(u._id), u]));

    const shaped = entries.map((e: any) => ({
      id: String(e._id),
      action: e.action,
      changes: e.changes || [],
      clonedFromRuleId: e.clonedFromRuleId ? String(e.clonedFromRuleId) : null,
      performedAt: e.performedAt,
      performedBy: {
        id: e.performedByUserId ? String(e.performedByUserId) : null,
        name: resolveUserName(userById.get(String(e.performedByUserId))),
      },
    }));

    res.json({
      ok: true,
      entries: shaped,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err: any) {
    console.error("[admin visa rule audit GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load audit history" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /rules — create. ALWAYS DRAFT, regardless of anything the caller
 * sends — a new rule is never live on arrival; POST /rules/:id/publish is
 * the only door into PUBLISHED. effectiveFrom is optional here (defaults
 * to now) — unlike PATCH, a brand-new rule has no prior term to date
 * against.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/rules", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const validated = validateRuleFields(req.body, { requireIdentity: true });
    if (!validated.ok) return res.status(400).json({ error: validated.error });

    const effectiveFrom = parseOptionalDate(req.body?.effectiveFrom) ?? new Date();

    let rule;
    try {
      rule = await VisaRule.create({ ...validated.fields, status: "DRAFT", effectiveFrom });
    } catch (err: any) {
      if (err?.code === 11000) {
        return res.status(409).json({ error: "A rule already exists for this nationality/destination/purpose/entryType/serviceTier combination" });
      }
      throw err;
    }

    const after = rule.toObject();
    const changes = diffFields({}, after, AUDITABLE_FIELDS);
    await writeRuleAudit(rule._id, "CREATE", changes, actorId(req));

    res.status(201).json({ ok: true, rule: mapRuleSummary(after) });
  } catch (err: any) {
    console.error("[admin visa rule create POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to create visa rule" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /rules/:id — update terms. effectiveFrom is REQUIRED — this is
 * the route that controls revenue, and every edit must carry a deliberate
 * business date for when the new terms take effect, not a silently-
 * stamped "now". Identity fields and status are rejected outright (see
 * validateRuleFields). Never touches VisaApplication — existing
 * ruleSnapshots are untouched by construction (this route only writes to
 * the VisaRule collection).
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/rules/:id", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: "Visa rule not found" });

    const validated = validateRuleFields(req.body, { requireIdentity: false });
    if (!validated.ok) return res.status(400).json({ error: validated.error });

    const effectiveFrom = parseOptionalDate(req.body?.effectiveFrom);
    if (!effectiveFrom) {
      return res.status(400).json({ error: "effectiveFrom is required and must be a valid date — every rule edit must record when the new terms take effect" });
    }

    const rule = await VisaRule.findById(id);
    if (!rule) return res.status(404).json({ error: "Visa rule not found" });

    const before = rule.toObject();
    Object.assign(rule, validated.fields);
    rule.effectiveFrom = effectiveFrom;

    let saved;
    try {
      saved = await rule.save();
    } catch (err: any) {
      if (err?.code === 11000) {
        return res.status(409).json({ error: "This update would collide with another rule's nationality/destination/purpose/entryType/serviceTier" });
      }
      throw err;
    }

    const after = saved.toObject();
    const changes = diffFields(before, after, AUDITABLE_FIELDS);
    if (changes.length > 0) {
      await writeRuleAudit(rule._id, "UPDATE", changes, actorId(req));
    }

    res.json({ ok: true, rule: mapRuleSummary(after) });
  } catch (err: any) {
    console.error("[admin visa rule update PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update visa rule" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /rules/:id/clone — clone to a new destination (or purpose/entry
 * type/service tier). Adding Austria should start from Germany, not an
 * empty form: this copies every editable term from the source rule, then
 * overrides the identity fields the caller supplied. Always produces an
 * independent DRAFT — never a reference back to the source (no field on
 * the new document points at it except the audit trail's
 * clonedFromRuleId, which is provenance only, exactly like VisaRule
 * itself is never live-referenced by a VisaApplication).
 *
 * Deliberately NOT copied: status (forced DRAFT), effectiveFrom (a new
 * rule starts its own clock — defaults to now, or an explicit override),
 * seedSource/reviewedBy/lastReviewedAt (this rule has never been
 * seeded or reviewed — those describe the SOURCE rule's provenance, not
 * this one's).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/rules/:id/clone", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: "Visa rule not found" });

    const source = await VisaRule.findById(id).lean();
    if (!source) return res.status(404).json({ error: "Visa rule not found" });

    const overrides = req.body || {};
    if (overrides.destinationIso2 === undefined && overrides.destinationName === undefined) {
      return res.status(400).json({ error: "Provide at least destinationIso2 and destinationName for the clone" });
    }

    // requireIdentity:true also demands productClass/visaCategory (not
    // just the 5 IDENTITY_FIELDS + destinationName) — carried over from
    // the source here since they're not part of this clone's identity
    // question, just fields validateRuleFields insists on for any create.
    const candidate: any = {
      nationality: source.nationality,
      destinationIso2: source.destinationIso2,
      destinationName: source.destinationName,
      purpose: source.purpose,
      entryType: source.entryType,
      serviceTier: source.serviceTier,
      productClass: source.productClass,
      visaCategory: source.visaCategory,
    };
    for (const key of ["nationality", "destinationIso2", "destinationName", "purpose", "entryType", "serviceTier", "productClass", "visaCategory"]) {
      if (overrides[key] !== undefined) candidate[key] = overrides[key];
    }

    const validated = validateRuleFields(candidate, { requireIdentity: true });
    if (!validated.ok) return res.status(400).json({ error: validated.error });

    // Every other editable term copies verbatim from the source unless the
    // caller explicitly overrides it too. validateRuleFields(requireIdentity:
    // false) rejects identity fields outright (PATCH's rule) — strip them
    // here first since `candidate` above already resolved them; only the
    // EDITABLE_FIELDS subset of `overrides` should reach that validation.
    const copiedTerms: Record<string, any> = {};
    for (const key of EDITABLE_FIELDS) {
      copiedTerms[key] = (source as any)[key];
    }
    const termOverrideCandidates: Record<string, any> = {};
    for (const key of EDITABLE_FIELDS) {
      if (overrides[key] !== undefined) termOverrideCandidates[key] = overrides[key];
    }
    const termOverrides = validateRuleFields(termOverrideCandidates, { requireIdentity: false });
    if (!termOverrides.ok) return res.status(400).json({ error: termOverrides.error });

    const effectiveFrom = parseOptionalDate(overrides.effectiveFrom) ?? new Date();

    let rule;
    try {
      rule = await VisaRule.create({
        ...validated.fields,
        ...copiedTerms,
        ...termOverrides.fields,
        status: "DRAFT",
        effectiveFrom,
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        return res.status(409).json({ error: "A rule already exists for this nationality/destination/purpose/entryType/serviceTier combination" });
      }
      throw err;
    }

    const after = rule.toObject();
    const changes = diffFields({}, after, AUDITABLE_FIELDS);
    await writeRuleAudit(rule._id, "CLONE", changes, actorId(req), { clonedFromRuleId: source._id });

    rulesLogger.info("visa rule cloned", {
      sourceRuleId: String(source._id),
      newRuleId: String(rule._id),
      destinationIso2: after.destinationIso2,
      userId: actorId(req) ? String(actorId(req)) : null,
    });

    res.status(201).json({ ok: true, rule: mapRuleSummary(after), clonedFromRuleId: String(source._id) });
  } catch (err: any) {
    console.error("[admin visa rule clone POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to clone visa rule" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /rules/:id/publish — DRAFT -> PUBLISHED only. Rejects a rule
 * missing visaCategory, ETA (both min and max), or any cost information
 * at all (itemised or indicative) — an incomplete rule going live would
 * quote an applicant against a gap, not a real term.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/rules/:id/publish", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: "Visa rule not found" });

    const rule = await VisaRule.findById(id);
    if (!rule) return res.status(404).json({ error: "Visa rule not found" });

    if (rule.status !== "DRAFT") {
      return res.status(400).json({ error: `Only a DRAFT rule can be published (currently '${rule.status}')` });
    }

    const missing: string[] = [];
    if (!rule.visaCategory) missing.push("visaCategory");
    if (rule.etaMinDays == null || rule.etaMaxDays == null) missing.push("ETA (etaMinDays and etaMaxDays)");
    const hasCost =
      rule.indicativeVisaCostInr != null || rule.embassyFeeInr != null || rule.vfsFeeInr != null || rule.plumtripsServiceFeeInr != null;
    if (!hasCost) missing.push("at least an indicative cost (indicativeVisaCostInr, or an itemised fee)");

    if (missing.length > 0) {
      return res.status(400).json({ error: `Cannot publish — missing: ${missing.join(", ")}`, missing });
    }

    const before = { status: rule.status };
    rule.status = "PUBLISHED";
    await rule.save();

    await writeRuleAudit(rule._id, "PUBLISH", [{ field: "status", from: before.status, to: "PUBLISHED" }], actorId(req));

    rulesLogger.info("visa rule published", { ruleId: String(rule._id), userId: actorId(req) ? String(actorId(req)) : null });

    res.json({ ok: true, rule: mapRuleSummary(rule.toObject()) });
  } catch (err: any) {
    console.error("[admin visa rule publish POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to publish visa rule" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /rules/:id/retire — PUBLISHED -> RETIRED only. Never deletes —
 * routes/visa.ts's customer-facing GET /rules already filters to
 * status:"PUBLISHED" only, so a retired rule simply stops matching new
 * quotes; it still resolves by _id (this router's own GET /rules/:id is
 * not status-filtered) for any historical application whose ruleSnapshot
 * carries its ruleId for audit-trail purposes.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/rules/:id/retire", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: "Visa rule not found" });

    const rule = await VisaRule.findById(id);
    if (!rule) return res.status(404).json({ error: "Visa rule not found" });

    if (rule.status !== "PUBLISHED") {
      return res.status(400).json({ error: `Only a PUBLISHED rule can be retired (currently '${rule.status}')` });
    }

    rule.status = "RETIRED";
    await rule.save();

    await writeRuleAudit(rule._id, "RETIRE", [{ field: "status", from: "PUBLISHED", to: "RETIRED" }], actorId(req));

    rulesLogger.info("visa rule retired", { ruleId: String(rule._id), userId: actorId(req) ? String(actorId(req)) : null });

    res.json({ ok: true, rule: mapRuleSummary(rule.toObject()) });
  } catch (err: any) {
    console.error("[admin visa rule retire POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to retire visa rule" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /rules/bulk — multi-select changes. The 18 Schengen states move
 * together; editing them one at a time guarantees drift. Atomic: every
 * ruleId is validated to exist BEFORE any write happens, and every write
 * (rule update + audit entry) runs inside one Mongo transaction — a
 * failure partway through (a duplicate-key collision, a concurrent
 * delete) aborts the whole batch, so a partial failure changes nothing.
 *
 * Same field rules as PATCH /rules/:id: identity fields and status are
 * rejected, effectiveFrom is required, `changes` must be non-empty.
 * ───────────────────────────────────────────────────────────────────── */
const MAX_BULK_RULE_IDS = 50;

router.post("/rules/bulk", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  const ruleIds = req.body?.ruleIds;
  if (!Array.isArray(ruleIds) || ruleIds.length === 0) {
    return res.status(400).json({ error: "ruleIds must be a non-empty array" });
  }
  if (ruleIds.length > MAX_BULK_RULE_IDS) {
    return res.status(400).json({ error: `ruleIds cannot exceed ${MAX_BULK_RULE_IDS} at once` });
  }
  for (const id of ruleIds) {
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: `${id} is not a valid rule id` });
    }
  }

  const validated = validateRuleFields(req.body?.changes, { requireIdentity: false });
  if (!validated.ok) return res.status(400).json({ error: validated.error });
  if (!validated.fields || Object.keys(validated.fields).length === 0) {
    return res.status(400).json({ error: "changes must include at least one field to update" });
  }

  const effectiveFrom = parseOptionalDate(req.body?.effectiveFrom);
  if (!effectiveFrom) {
    return res.status(400).json({ error: "effectiveFrom is required and must be a valid date — every rule edit must record when the new terms take effect" });
  }

  const session = await mongoose.startSession();
  try {
    const updatedSummaries: any[] = [];

    await session.withTransaction(async () => {
      const existing = await VisaRule.find({ _id: { $in: ruleIds } }).session(session);
      if (existing.length !== ruleIds.length) {
        const foundIds = new Set(existing.map((r: any) => String(r._id)));
        const missing = ruleIds.filter((id: string) => !foundIds.has(String(id)));
        throw Object.assign(new Error(`One or more rules were not found: ${missing.join(", ")}`), { status: 404 });
      }

      for (const rule of existing) {
        const before = rule.toObject();
        Object.assign(rule, validated.fields);
        rule.effectiveFrom = effectiveFrom;
        const saved = await rule.save({ session });
        const after = saved.toObject();

        const changes = diffFields(before, after, AUDITABLE_FIELDS);
        if (changes.length > 0) {
          await writeRuleAudit(rule._id, "UPDATE", changes, actorId(req), { session });
        }
        updatedSummaries.push(mapRuleSummary(after));
      }
    });

    rulesLogger.info("visa rules bulk edited", {
      ruleIds: ruleIds.map(String),
      changedFields: Object.keys(validated.fields),
      userId: actorId(req) ? String(actorId(req)) : null,
    });

    res.json({ ok: true, updated: updatedSummaries });
  } catch (err: any) {
    if (err?.status === 404) {
      return res.status(404).json({ error: err.message });
    }
    if (err?.code === 11000) {
      return res.status(409).json({ error: "Bulk edit would collide with another rule's identity — nothing was changed" });
    }
    console.error("[admin visa rules bulk POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to bulk-edit visa rules" });
  } finally {
    session.endSession();
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * VisaDestinationContent — GET / PATCH / publish. Nothing can write this
 * today (only scripts/seed-visa-rules.ts, via a raw script, can), which
 * is why all five seeded rows are DRAFT and the business/tourism blocks
 * render on zero customer-facing pages. PATCH upserts (findOneAndUpdate
 * with upsert:true) — a destination can get its first content row this
 * way, same as VisaRule's clone-from-nothing story for a brand-new
 * destination.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/destination-content", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const filter: any = {};
    if (req.query.status != null) {
      const status = String(req.query.status).trim().toUpperCase();
      if (!["DRAFT", "PUBLISHED"].includes(status)) {
        return res.status(400).json({ error: "status must be one of DRAFT, PUBLISHED" });
      }
      filter.status = status;
    }
    const rows = await VisaDestinationContent.find(filter).sort({ destinationIso2: 1 }).lean();
    res.json({ ok: true, content: rows.map(mapContentSummary) });
  } catch (err: any) {
    console.error("[admin visa destination-content GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load destination content" });
  }
});

router.get("/destination-content/:iso2", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const iso2 = String(req.params.iso2 || "").trim().toUpperCase();
    if (!isIso2(iso2)) return res.status(404).json({ error: "Destination content not found" });

    const content = await VisaDestinationContent.findOne({ destinationIso2: iso2 }).lean();
    if (!content) return res.status(404).json({ error: "Destination content not found" });

    res.json({ ok: true, content: mapContentSummary(content) });
  } catch (err: any) {
    console.error("[admin visa destination-content detail GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load destination content" });
  }
});

function validateContentBlock(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== "object") return `${label} must be an object`;
  const highlights = (value as any).highlights;
  if (highlights !== undefined && (!Array.isArray(highlights) || highlights.some((h: any) => typeof h !== "string"))) {
    return `${label}.highlights must be an array of strings`;
  }
  const body = (value as any).body;
  if (body !== undefined && typeof body !== "string") return `${label}.body must be a string`;
  return null;
}

router.patch("/destination-content/:iso2", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const iso2 = String(req.params.iso2 || "").trim().toUpperCase();
    if (!isIso2(iso2)) return res.status(400).json({ error: "iso2 must be a 2-letter ISO country code" });

    const b = req.body || {};
    if (b.status !== undefined) {
      return res.status(400).json({ error: "status cannot be set directly — use POST /destination-content/:iso2/publish" });
    }

    const update: any = {};
    const businessErr = validateContentBlock(b.businessBlock, "businessBlock");
    if (businessErr) return res.status(400).json({ error: businessErr });
    if (b.businessBlock !== undefined) update.businessBlock = b.businessBlock;

    const tourismErr = validateContentBlock(b.tourismBlock, "tourismBlock");
    if (tourismErr) return res.status(400).json({ error: tourismErr });
    if (b.tourismBlock !== undefined) update.tourismBlock = b.tourismBlock;

    if (b.entrySnapshot !== undefined) {
      const es = b.entrySnapshot;
      if (!es || typeof es !== "object" || typeof es.visaRequired !== "boolean") {
        return res.status(400).json({ error: "entrySnapshot.visaRequired must be a boolean" });
      }
      update.entrySnapshot = {
        visaRequired: es.visaRequired,
        headline: typeof es.headline === "string" ? es.headline : "",
        summary: typeof es.summary === "string" ? es.summary : "",
      };
    }
    if (b.heroImageUrl !== undefined) {
      update.heroImageUrl = String(b.heroImageUrl ?? "").trim();
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "Provide at least one of businessBlock, tourismBlock, entrySnapshot, heroImageUrl" });
    }

    const content = await VisaDestinationContent.findOneAndUpdate(
      { destinationIso2: iso2 },
      { $set: update, $setOnInsert: { destinationIso2: iso2, status: "DRAFT" } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    res.json({ ok: true, content: mapContentSummary(content.toObject ? content.toObject() : content) });
  } catch (err: any) {
    console.error("[admin visa destination-content PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update destination content" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /destination-content/:iso2/publish — DRAFT -> PUBLISHED. Requires
 * a real headline/summary and at least one highlight in either block —
 * publishing empty copy would reproduce the exact bug this phase fixes
 * (business/tourism blocks rendering on zero pages), just moved from
 * "content never written" to "content written but empty."
 * ───────────────────────────────────────────────────────────────────── */
router.post("/destination-content/:iso2/publish", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const iso2 = String(req.params.iso2 || "").trim().toUpperCase();
    if (!isIso2(iso2)) return res.status(404).json({ error: "Destination content not found" });

    const content = await VisaDestinationContent.findOne({ destinationIso2: iso2 });
    if (!content) return res.status(404).json({ error: "Destination content not found" });

    if (content.status !== "DRAFT") {
      return res.status(400).json({ error: `Only DRAFT content can be published (currently '${content.status}')` });
    }

    const missing: string[] = [];
    if (!content.entrySnapshot?.headline?.trim()) missing.push("entrySnapshot.headline");
    if (!content.entrySnapshot?.summary?.trim()) missing.push("entrySnapshot.summary");
    const hasHighlight =
      (content.businessBlock?.highlights?.length ?? 0) > 0 || (content.tourismBlock?.highlights?.length ?? 0) > 0;
    if (!hasHighlight) missing.push("at least one highlight (businessBlock or tourismBlock)");

    if (missing.length > 0) {
      return res.status(400).json({ error: `Cannot publish — missing: ${missing.join(", ")}`, missing });
    }

    content.status = "PUBLISHED";
    await content.save();

    rulesLogger.info("visa destination content published", {
      destinationIso2: iso2,
      userId: actorId(req) ? String(actorId(req)) : null,
    });

    res.json({ ok: true, content: mapContentSummary(content.toObject()) });
  } catch (err: any) {
    console.error("[admin visa destination-content publish POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to publish destination content" });
  }
});

export default router;
