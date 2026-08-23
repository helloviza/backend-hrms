// apps/backend/src/routes/admin.visa.rules.documentGroups.ts
//
// PER-GROUP write path for VisaRule.documentGroups — the field the CUSTOMER
// checklist actually renders.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────
//
// documentGroups was, until now, writable ONLY through the XLSX
// REQUIREMENTS sheet (routes/admin.visa.rules.importExport.ts). The rule
// editor's "DOCUMENT REQUIREMENTS" section edits `documentRequirements`, a
// DIFFERENT and superseded field — utils/visaChecklistResolver.ts resolves
// groups when the field is present and legacy only otherwise, and
// documentRequirements is empty on all 259 production rules. So the one
// document editor ops had was writing to a field no customer reads.
//
// ── WHY PER-GROUP AND NOT A WHOLE-ARRAY PATCH ────────────────────────────
//
// The import full-replaces a rule's groups from the sheet. That is right
// for a spreadsheet (the file IS the desired state) and wrong for a
// console: two people editing different requirements on one rule would
// last-write-wins each other's whole checklist. These routes address ONE
// group at a time, by its stable groupId, so concurrent edits to different
// requirements do not collide.
//
// That is why VisaRule.documentGroups[].groupId had to exist first.
// `key` is derived from the label (slugifyChecklistLabel), so it changes
// when a requirement is renamed and cannot identify a row across an edit.
// A group with NO groupId is refused rather than matched by key or index —
// see requireGroupId below.
//
// ── WHAT THE SERVER OWNS, NOT THE CLIENT ────────────────────────────────
//
// needsCatalogueMapping is RECOMPUTED here on every write and never read
// from the request body. It was previously written once at import (in the
// XLSX path it is literally a human-typed boolean column) and never
// recalculated, so the console's amber "needs a catalogue decision" banner
// reported the state at import time forever. Deriving it server-side is
// what keeps that banner true as ops edits.
import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import VisaRule, { VISA_DOC_REQUIREMENT_LEVELS, type VisaDocumentRequirementGroup } from "../models/VisaRule.js";
// Reused rather than rebuilt: the import path already validates codes
// against exactly this set, and two independently-derived "valid codes"
// sets would be free to disagree.
import { DOC_TYPE_CODE_SET } from "./admin.visa.rules.importExportShared.js";
import { slugifyChecklistLabel } from "../utils/visaChecklistCatalogueMatcher.js";
import { writeRuleAudit } from "./admin.visa.rules.js";
import type { VisaRuleFieldChange } from "../models/VisaRuleAudit.js";
import logger from "../utils/logger.js";

const router = Router();
router.use(requireAuth);

const groupsLogger = logger.child({ module: "admin.visa.rules.documentGroups" });

function actorId(req: any): any {
  return req.user?._id ?? req.user?.id ?? null;
}

/**
 * THE derivation. needsCatalogueMapping means "a human still has to decide
 * what this requirement maps to", which is true in exactly two cases: no
 * document type is mapped at all, or at least one source document name was
 * explicitly kept as unmatched. Both are computed from the group's own
 * contents, so the flag cannot drift away from what the group actually
 * holds — which is precisely what went wrong when it was stored once and
 * never revisited.
 */
export function computeNeedsCatalogueMapping(group: {
  docTypeCodes?: string[];
  unmatchedDocumentNames?: string[];
  unmatchedTemplateReference?: string;
}): boolean {
  const noneMapped = (group.docTypeCodes ?? []).length === 0;
  const hasUnmatchedNames = (group.unmatchedDocumentNames ?? []).length > 0;
  const hasUnmatchedTemplate = !!(group.unmatchedTemplateReference ?? "").trim();
  return noneMapped || hasUnmatchedNames || hasUnmatchedTemplate;
}

/** A one-line, human-readable rendering of a group, for the audit trail. */
function describeGroup(g: VisaDocumentRequirementGroup): string {
  const codes = (g.docTypeCodes || []).length ? g.docTypeCodes.join(", ") : "no mapped document types";
  const unmatched = (g.unmatchedDocumentNames || []).length
    ? `; unmatched: ${(g.unmatchedDocumentNames || []).join(", ")}`
    : "";
  return `${g.label} [${g.requirement}] (${codes}${unmatched})`;
}

/**
 * The audit diff for a nested group.
 *
 * routes/admin.visa.rules.ts's diffFields() compares whole field values and
 * stores them raw. Pointed at documentGroups it would log one change whose
 * `from`/`to` are entire arrays of objects — technically complete, useless
 * to read, and rendered as "[object Object]" by anything that stringifies.
 * This emits one entry PER CHANGED PROPERTY of the one group that changed,
 * named `documentGroups.<label>.<prop>`, so the history tab reads as
 * "documentGroups.Bank Statement.requirement: REQUIRED -> CONDITIONAL"
 * rather than a wall of JSON.
 */
function diffGroup(
  before: VisaDocumentRequirementGroup | null,
  after: VisaDocumentRequirementGroup | null,
): VisaRuleFieldChange[] {
  if (!before && after) {
    return [{ field: `documentGroups.${after.label}`, from: null, to: describeGroup(after) }];
  }
  if (before && !after) {
    return [{ field: `documentGroups.${before.label}`, from: describeGroup(before), to: null }];
  }
  if (!before || !after) return [];

  const changes: VisaRuleFieldChange[] = [];
  const scalar: (keyof VisaDocumentRequirementGroup)[] = [
    "label",
    "requirement",
    "specification",
    "templateCode",
    "legacyConditionNote",
    "unmatchedTemplateReference",
    "needsCatalogueMapping",
  ];
  for (const prop of scalar) {
    const from = (before as any)[prop] ?? null;
    const to = (after as any)[prop] ?? null;
    if (from !== to) changes.push({ field: `documentGroups.${before.label}.${String(prop)}`, from, to });
  }

  // Arrays compared as sorted, comma-joined text — the audit trail is read
  // by a human deciding whether a change was right, and "A, B -> A, B, C"
  // answers that where two JSON arrays do not.
  const arrays: (keyof VisaDocumentRequirementGroup)[] = ["docTypeCodes", "unmatchedDocumentNames"];
  for (const prop of arrays) {
    const from = [...((before as any)[prop] ?? [])].sort().join(", ");
    const to = [...((after as any)[prop] ?? [])].sort().join(", ");
    if (from !== to) {
      changes.push({ field: `documentGroups.${before.label}.${String(prop)}`, from: from || null, to: to || null });
    }
  }

  const fromWhen = JSON.stringify((before as any).appliesWhen ?? null);
  const toWhen = JSON.stringify((after as any).appliesWhen ?? null);
  if (fromWhen !== toWhen) {
    changes.push({ field: `documentGroups.${before.label}.appliesWhen`, from: fromWhen, to: toWhen });
  }

  return changes;
}

// Flat, with optional members, rather than a discriminated union — this is
// the shape routes/admin.visa.rules.ts's own ValidationResult uses, and it
// has to be: the backend compiles with strictNullChecks:false, under which
// TypeScript will not narrow a `{ok:true}|{ok:false}` union on `!res.ok`,
// so a union here fails to compile at every call site.
interface GroupValidationResult {
  ok: boolean;
  error?: string;
  fields?: Partial<VisaDocumentRequirementGroup>;
}

/** Shared body validation for create and edit. */
function validateGroupBody(body: any, opts: { partial: boolean }): GroupValidationResult {
  const b = body || {};
  const fields: Partial<VisaDocumentRequirementGroup> = {};

  if (b.needsCatalogueMapping !== undefined) {
    return {
      ok: false,
      error: "needsCatalogueMapping is derived from the group's contents and cannot be set directly",
    };
  }
  if (b.groupId !== undefined) {
    return { ok: false, error: "groupId is assigned by the server and cannot be set or changed" };
  }

  if (b.label !== undefined || !opts.partial) {
    const label = String(b.label ?? "").trim();
    if (!label) return { ok: false, error: "label is required" };
    fields.label = label;
  }

  if (b.requirement !== undefined || !opts.partial) {
    const requirement = String(b.requirement ?? "").trim().toUpperCase();
    if (!(VISA_DOC_REQUIREMENT_LEVELS as readonly string[]).includes(requirement)) {
      return { ok: false, error: `requirement must be one of ${VISA_DOC_REQUIREMENT_LEVELS.join(", ")}` };
    }
    fields.requirement = requirement as VisaDocumentRequirementGroup["requirement"];
  }

  if (b.docTypeCodes !== undefined || !opts.partial) {
    const raw = b.docTypeCodes ?? [];
    if (!Array.isArray(raw)) return { ok: false, error: "docTypeCodes must be an array of catalogue codes" };
    const codes = raw.map((c: any) => String(c).trim()).filter(Boolean);
    for (const c of codes) {
      if (!DOC_TYPE_CODE_SET.has(c)) return { ok: false, error: `"${c}" is not a known document type code` };
    }
    fields.docTypeCodes = codes;
  }

  // The explicit save-as-unmatched channel. Free text ops chose to keep
  // rather than map — kept verbatim, and the reason the derived
  // needsCatalogueMapping flag stays true for this group.
  if (b.unmatchedDocumentNames !== undefined) {
    const raw = b.unmatchedDocumentNames;
    if (!Array.isArray(raw)) return { ok: false, error: "unmatchedDocumentNames must be an array of strings" };
    const names = raw.map((n: any) => String(n).trim()).filter(Boolean);
    fields.unmatchedDocumentNames = names.length ? names : undefined;
  }

  for (const prop of ["specification", "templateCode", "legacyConditionNote", "unmatchedTemplateReference"] as const) {
    if (b[prop] !== undefined) {
      const v = String(b[prop] ?? "").trim();
      (fields as any)[prop] = v || undefined;
    }
  }
  if (fields.templateCode) fields.templateCode = fields.templateCode.toUpperCase();

  if (b.appliesWhen !== undefined) {
    if (b.appliesWhen !== null && !Array.isArray(b.appliesWhen)) {
      return { ok: false, error: "appliesWhen must be an array of applicant conditions, or null" };
    }
    (fields as any).appliesWhen = b.appliesWhen === null || b.appliesWhen.length === 0 ? undefined : b.appliesWhen;
  }

  return { ok: true, fields };
}

async function loadRule(id: string, res: any) {
  if (!mongoose.isValidObjectId(id)) {
    res.status(404).json({ error: "Visa rule not found" });
    return null;
  }
  const rule = await VisaRule.findById(id);
  if (!rule) {
    res.status(404).json({ error: "Visa rule not found" });
    return null;
  }
  return rule;
}

/**
 * Find a group by its stable id, refusing anything without one.
 *
 * A group stored before groupId existed has none until the backfill
 * migration runs. The tempting fallback — match on `key`, or on array
 * index — is exactly the bug this id was added to prevent: `key` follows
 * the label, and index follows array order, so either can silently address
 * a DIFFERENT requirement than the one ops clicked. Failing loudly with an
 * actionable message is the correct behaviour for an un-backfilled rule.
 */
function findGroup(rule: any, groupId: string): { index: number; error?: string } {
  const groups: VisaDocumentRequirementGroup[] = rule.documentGroups || [];
  const missingIds = groups.filter((g) => !g.groupId).length;
  const index = groups.findIndex((g) => g.groupId === groupId);

  if (index === -1) {
    if (missingIds > 0) {
      return {
        index: -1,
        error:
          `No document group with id "${groupId}" on this rule, and ${missingIds} of its ${groups.length} groups ` +
          `have no stable id yet — run migrations/2026-08-14-backfill-document-group-ids.ts against this database ` +
          `before editing groups here.`,
      };
    }
    return { index: -1, error: `No document group with id "${groupId}" on this rule` };
  }
  return { index };
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /rules/:id/document-groups — the rule's groups, WITH their stable
 * ids and the derived flag. The console needs this because the rule
 * editor has never rendered documentGroups at all: the amber panel shows
 * only those flagged needsCatalogueMapping, so a fully-mapped requirement
 * was invisible in the UI even though it is what customers are asked for.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/rules/:id/document-groups", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const rule = await loadRule(req.params.id, res);
    if (!rule) return;

    const groups: VisaDocumentRequirementGroup[] = rule.documentGroups || [];
    res.json({
      ok: true,
      ruleId: String(rule._id),
      // Surfaced so the console can tell ops "this rule needs the backfill"
      // instead of only discovering it when an edit is refused.
      groupsMissingStableId: groups.filter((g) => !g.groupId).length,
      documentGroups: groups,
    });
  } catch (err: any) {
    console.error("[admin visa rule document-groups GET]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load document groups" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /rules/:id/document-groups — add one group.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/rules/:id/document-groups", requirePermission("visaApplication", "FULL"), async (req: any, res: any) => {
  try {
    const rule = await loadRule(req.params.id, res);
    if (!rule) return;

    const validated = validateGroupBody(req.body, { partial: false });
    if (!validated.ok) return res.status(400).json({ error: validated.error });

    const group: VisaDocumentRequirementGroup = {
      ...(validated.fields as VisaDocumentRequirementGroup),
      groupId: new mongoose.Types.ObjectId().toString(),
      // Still derived from the label, exactly as the import derives it —
      // key remains the display/spreadsheet slug. It is no longer load
      // bearing for identity, which is why it is free to follow the label.
      key: slugifyChecklistLabel(validated.fields.label as string),
      needsCatalogueMapping: computeNeedsCatalogueMapping(validated.fields),
    };

    rule.documentGroups = [...(rule.documentGroups || []), group];
    await rule.save();

    await writeRuleAudit(rule._id, "UPDATE", diffGroup(null, group), actorId(req));
    groupsLogger.info("visa rule document group added", {
      ruleId: String(rule._id),
      groupId: group.groupId,
      userId: actorId(req) ? String(actorId(req)) : null,
    });

    res.status(201).json({ ok: true, group });
  } catch (err: any) {
    console.error("[admin visa rule document-groups POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to add the document group" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /rules/:id/document-groups/:groupId — edit one group in place.
 * ───────────────────────────────────────────────────────────────────── */
router.patch(
  "/rules/:id/document-groups/:groupId",
  requirePermission("visaApplication", "FULL"),
  async (req: any, res: any) => {
    try {
      const rule = await loadRule(req.params.id, res);
      if (!rule) return;

      const found = findGroup(rule, String(req.params.groupId));
      if (found.index === -1) return res.status(404).json({ error: found.error });

      const validated = validateGroupBody(req.body, { partial: true });
      if (!validated.ok) return res.status(400).json({ error: validated.error });

      const before: VisaDocumentRequirementGroup = JSON.parse(JSON.stringify(rule.documentGroups[found.index]));
      const merged: VisaDocumentRequirementGroup = { ...before, ...validated.fields };
      merged.groupId = before.groupId;
      merged.key = slugifyChecklistLabel(merged.label);
      merged.needsCatalogueMapping = computeNeedsCatalogueMapping(merged);

      rule.documentGroups[found.index] = merged as any;
      rule.markModified("documentGroups");
      await rule.save();

      const changes = diffGroup(before, merged);
      if (changes.length > 0) {
        await writeRuleAudit(rule._id, "UPDATE", changes, actorId(req));
        groupsLogger.info("visa rule document group edited", {
          ruleId: String(rule._id),
          groupId: merged.groupId,
          changedFields: changes.map((c) => c.field),
          userId: actorId(req) ? String(actorId(req)) : null,
        });
      }

      res.json({ ok: true, group: merged, changed: changes.length > 0 });
    } catch (err: any) {
      console.error("[admin visa rule document-groups PATCH]", err?.message);
      res.status(500).json({ error: err?.message || "Failed to update the document group" });
    }
  },
);

/* ─────────────────────────────────────────────────────────────────────
 * DELETE /rules/:id/document-groups/:groupId — remove one group.
 *
 * Removing the LAST group is allowed and is not a trap: since 2026-08-14
 * utils/visaChecklistResolver.ts treats the groups array's PRESENCE (not
 * its length) as the signal, so an emptied rule resolves to "no
 * requirements" and the customer page renders its explicit "no checklist
 * published for this variant yet" state — rather than silently falling
 * through to the superseded documentRequirements list.
 * ───────────────────────────────────────────────────────────────────── */
router.delete(
  "/rules/:id/document-groups/:groupId",
  requirePermission("visaApplication", "FULL"),
  async (req: any, res: any) => {
    try {
      const rule = await loadRule(req.params.id, res);
      if (!rule) return;

      const found = findGroup(rule, String(req.params.groupId));
      if (found.index === -1) return res.status(404).json({ error: found.error });

      const before: VisaDocumentRequirementGroup = JSON.parse(JSON.stringify(rule.documentGroups[found.index]));
      rule.documentGroups.splice(found.index, 1);
      rule.markModified("documentGroups");
      await rule.save();

      await writeRuleAudit(rule._id, "UPDATE", diffGroup(before, null), actorId(req));
      groupsLogger.info("visa rule document group removed", {
        ruleId: String(rule._id),
        groupId: before.groupId,
        remainingGroups: rule.documentGroups.length,
        userId: actorId(req) ? String(actorId(req)) : null,
      });

      res.json({ ok: true, removedGroupId: before.groupId, remainingGroups: rule.documentGroups.length });
    } catch (err: any) {
      console.error("[admin visa rule document-groups DELETE]", err?.message);
      res.status(500).json({ error: err?.message || "Failed to remove the document group" });
    }
  },
);

export default router;
