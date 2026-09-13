// apps/backend/src/services/crmScope.ts
//
// THE one place CRM data scope is decided. Every leads / opportunities /
// companies / contacts route — list, :id fetch, mutation, aggregate, export —
// derives "which rows may this caller see or touch" from here, so scope is
// applied uniformly and a future TEAM scope (the caller's reports-to set) is
// ONE new branch in `rowsFor()`, not twenty-five scattered checks.
//
// Inputs are what the two permission gates already stash on the request:
//   requireLeadsAccess  → req.leadsAccess / req.leadsScope   (leads module)
//   requireCRMAccess(m) → req.crmAccess   / req.crmScope     (crmContacts / crmCompanies)
//   both                → req.crmModules (the caller's whole modules map, so a
//                         route gated on one module can scope a rollup that
//                         belongs to another — a company page's opportunities
//                         follow the LEADS scope, not the companies one).
//
// Scope levels (UserPermission.modules.*.scope): ALL and WORKSPACE mean the
// whole HOUSE CRM (single workspace); TEAM is reserved and behaves as OWN
// until the reports-to set exists; OWN, NONE and anything unknown narrow to
// the caller's own rows. Deny-by-default: an unrecognised value never widens.
//
// ADMIN / SUPERADMIN are ALL by construction (the gates set that before this
// module is consulted). A permission row of access FULL + scope OWN is a real
// state (five prod reps carry it): FULL says what verbs they have, OWN says on
// whose rows — `canManageOthers` is the only thing that unlocks cross-user
// reassignment / delete, and it needs BOTH FULL and ALL.

import mongoose from "mongoose";
import Lead from "../models/Lead.js";
import type express from "express";

type AnyObj = Record<string, any>;

export type ScopeLevel = "OWN" | "TEAM" | "ALL";

export interface ScopeCtx {
  /** The caller's User._id, null when the token carries no valid id. */
  userId: mongoose.Types.ObjectId | null;
  /** NONE | READ | WRITE | FULL — the verb grant, unchanged from the gate. */
  access: string;
  scope: ScopeLevel;
}

export function normalizeScope(raw: unknown): ScopeLevel {
  switch (String(raw || "").toUpperCase()) {
    case "ALL":
    case "WORKSPACE":
      return "ALL";
    case "TEAM":
      return "TEAM";
    default:
      return "OWN";
  }
}

function callerId(req: express.Request): mongoose.Types.ObjectId | null {
  const user = (req as any).user as AnyObj | undefined;
  const raw = String(user?.id || user?.sub || "");
  return mongoose.isValidObjectId(raw) ? new mongoose.Types.ObjectId(raw) : null;
}

/** Scope for routes behind requireLeadsAccess (leads, opportunities, reports). */
export function leadScope(req: express.Request): ScopeCtx {
  return { userId: callerId(req), access: String((req as any).leadsAccess || "NONE"), scope: normalizeScope((req as any).leadsScope) };
}

/** Scope for routes behind requireCRMAccess(module) — the module the route is gated on. */
export function crmScope(req: express.Request): ScopeCtx {
  return { userId: callerId(req), access: String((req as any).crmAccess || "NONE"), scope: normalizeScope((req as any).crmScope) };
}

/** Scope of ANOTHER module for the same caller (from req.crmModules), for
 *  rollups that cross modules. NONE access → no rows at all (`null`). */
export function moduleScope(req: express.Request, module: string): ScopeCtx | null {
  const modules = (req as any).crmModules as AnyObj | undefined;
  if (modules === undefined) {
    // No modules map: the gate short-circuited for an admin — ALL.
    return { userId: callerId(req), access: "FULL", scope: "ALL" };
  }
  const mod = modules?.[module];
  if (!mod || !mod.access || mod.access === "NONE") return null;
  return { userId: callerId(req), access: String(mod.access), scope: normalizeScope(mod.scope) };
}

export function isAll(ctx: ScopeCtx): boolean {
  return ctx.scope === "ALL";
}

/** FULL verbs on OTHER people's rows (reassign, bulk-reassign, delete across
 *  owners). Needs both the FULL grant and the ALL scope. */
export function canManageOthers(ctx: ScopeCtx): boolean {
  return ctx.access === "FULL" && isAll(ctx);
}

// A filter that matches nothing — for OWN scope with no usable caller id.
const NOTHING: AnyObj = { _id: null };

/**
 * The Mongo filter for "rows this caller may see" on a collection whose
 * owner field is `ownerField`. This is the switch a TEAM scope extends.
 */
export function rowsFor(ctx: ScopeCtx, ownerField: string): AnyObj {
  switch (ctx.scope) {
    case "ALL":
      return {};
    case "TEAM":
      // Reserved: { [ownerField]: { $in: [ctx.userId, ...reportsTo(ctx.userId)] } }.
      // Until the reports-to set exists, TEAM narrows to OWN — never widens.
      return ctx.userId ? { [ownerField]: ctx.userId } : NOTHING;
    case "OWN":
    default:
      return ctx.userId ? { [ownerField]: ctx.userId } : NOTHING;
  }
}

/** Leads: owner = assignedTo. */
export function leadMatch(ctx: ScopeCtx): AnyObj {
  return rowsFor(ctx, "assignedTo");
}
/** Opportunities: owner = ownerUserId (cascaded from Lead.assignedTo). */
export function opportunityMatch(ctx: ScopeCtx): AnyObj {
  return rowsFor(ctx, "ownerUserId");
}
/** Contacts: the list's existing rule — assigned to me OR created by me. */
export function contactMatch(ctx: ScopeCtx): AnyObj {
  if (isAll(ctx)) return {};
  if (!ctx.userId) return NOTHING;
  return { $or: [{ assignedTo: ctx.userId }, { createdBy: ctx.userId }] };
}
/** Lead activities: rows on the leads the caller may see (a `$in` on lead ids). */
export async function activityMatch(ctx: ScopeCtx): Promise<AnyObj> {
  if (isAll(ctx)) return {};
  const ids = await Lead.distinct("_id", leadMatch(ctx));
  return { leadId: { $in: ids } };
}

/** Same rule as leadMatch, applied to one loaded row. */
export function ownsLead(ctx: ScopeCtx, lead: { assignedTo?: unknown } | null | undefined): boolean {
  if (!lead) return false;
  if (isAll(ctx)) return true;
  return !!ctx.userId && String(lead.assignedTo || "") === String(ctx.userId);
}
export function ownsOpportunity(ctx: ScopeCtx, opp: { ownerUserId?: unknown } | null | undefined): boolean {
  if (!opp) return false;
  if (isAll(ctx)) return true;
  return !!ctx.userId && String(opp.ownerUserId || "") === String(ctx.userId);
}
export function ownsContact(ctx: ScopeCtx, contact: { assignedTo?: unknown; createdBy?: unknown } | null | undefined): boolean {
  if (!contact) return false;
  if (isAll(ctx)) return true;
  if (!ctx.userId) return false;
  const me = String(ctx.userId);
  return String(contact.assignedTo || "") === me || String(contact.createdBy || "") === me;
}

/**
 * Load one lead the caller may READ. Returns null both when the lead does
 * not exist and when it is outside the caller's scope — routes answer 404
 * for both so an OWN rep cannot probe which ids exist.
 */
export async function findVisibleLead(ctx: ScopeCtx, id: string): Promise<any | null> {
  if (!mongoose.isValidObjectId(id)) return null;
  return Lead.findOne({ _id: id, ...leadMatch(ctx) });
}

/**
 * company-check for a caller who may not see other people's leads: keep the
 * dedupe signal (match, counts, owner names, open/closed) and drop every
 * per-lead detail — id, code, contact, disposition, follow-up — since those
 * are the id-discovery path into GET /leads/:id.
 */
export function redactCompanyCheck<T extends { leads: AnyObj[] }>(result: T): T & { redacted: true } {
  return {
    ...result,
    redacted: true,
    leads: result.leads.map((l) => ({
      _id: null,
      leadCode: "",
      contactName: "",
      contactDesignation: "",
      stage: "",
      status: "",
      dispositionStage: "",
      dispositionStatus: "",
      subDisposition: "",
      assignedTo: null,
      assignedToName: l.assignedToName || "",
      open: !!l.open,
      nextFollowUpDate: null,
      createdAt: null,
    })),
  };
}
