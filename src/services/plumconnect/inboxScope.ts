// apps/backend/src/services/plumconnect/inboxScope.ts
//
// PlumConnect Slice 4b — scope semantics for the inbox, mirroring the CRM
// v2 model in services/crmScope.ts exactly: OWN = conversations assigned to
// me, ALL = everyone's; TEAM is the same reserved hook CRM has (narrows to
// OWN until a reports-to set exists — never widens). The owner field of a
// Conversation is `assignedTo`.
//
// Slice 7: the grant is PER LINE (services/plumconnect/access.ts). A route
// asks for the scope of ONE line — the line its conversation belongs to —
// and the list is the union of every held line, each narrowed by that
// line's own scope: an agent WRITE/OWN on helloviza and READ/ALL on support
// sees their own helloviza threads and every support thread, and nothing
// on plumtrips or concierge.

import mongoose from "mongoose";
import type express from "express";
import { normalizeScope, rowsFor, isAll, canManageOthers, type ScopeCtx } from "../crmScope.js";
import { type AccessLine, type LineGrants, canAccessLine, heldLines, holdsAtLeast, lineMatch, noLineGrants } from "./access.js";

type AnyObj = Record<string, any>;

function callerId(req: express.Request): mongoose.Types.ObjectId | null {
  const user = (req as any).user as AnyObj | undefined;
  const raw = String(user?.id || user?.sub || "");
  return mongoose.isValidObjectId(raw) ? new mongoose.Types.ObjectId(raw) : null;
}

/** The caller's per-line grants, as stamped by requirePlumConnectAccess. */
export function lineGrants(req: express.Request): LineGrants {
  return ((req as any).plumconnectLines as LineGrants | undefined) ?? noLineGrants();
}

/** Scope for ONE line, for routes behind requirePlumConnectAccess. access "NONE" = the line is not held. */
export function inboxScope(req: express.Request, line: AccessLine): ScopeCtx {
  const grant = canAccessLine(lineGrants(req), line);
  return {
    userId: callerId(req),
    access: String(grant.access || "NONE"),
    scope: normalizeScope(grant.scope),
  };
}

// A filter that matches nothing — no line held (the gate already 403s this).
const NOTHING: AnyObj = { _id: null };

/**
 * The Mongo filter for the conversations this caller may see: every line
 * held at READ+, each narrowed by its own OWN/ALL scope. `only` restricts
 * the union to one line (the inbox's line filter) — a line not held
 * matches nothing, never widens.
 */
export function conversationMatch(req: express.Request, only?: AccessLine): AnyObj {
  const lines = heldLines(lineGrants(req)).filter((line) => !only || line === only);
  if (lines.length === 0) return NOTHING;
  const clauses = lines.map((line) => {
    const ctx = inboxScope(req, line);
    const own = rowsFor(ctx, "assignedTo");
    // Track B: an unassigned thread the matrix surfaced to me (a tie I am
    // part of) is mine to see and take, even under OWN scope.
    const surfaced = !isAll(ctx) && ctx.userId ? { $or: [own, { assignedTo: null, "routing.candidates": ctx.userId }] } : own;
    return { $and: [lineMatch(line), surfaced] };
  });
  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

/** Track B: an unassigned thread whose routing candidates include this user. */
export function isSurfacedTo(userId: mongoose.Types.ObjectId | null, conversation: { assignedTo?: mongoose.Types.ObjectId | null; routing?: { candidates?: mongoose.Types.ObjectId[] } | null }): boolean {
  if (!userId || conversation.assignedTo) return false;
  return (conversation.routing?.candidates ?? []).some((c) => String(c) === String(userId));
}

/** May the caller see THIS conversation on its line? (held at READ+, and OWN: it is assigned to them, or surfaced to them by the matrix.) */
export function canSee(ctx: ScopeCtx, conversation: { assignedTo?: mongoose.Types.ObjectId | null; routing?: { candidates?: mongoose.Types.ObjectId[] } | null }): boolean {
  if (!holdsAtLeast({ access: ctx.access, scope: ctx.scope }, "READ")) return false;
  if (isAll(ctx)) return true;
  if (!ctx.userId) return false;
  if (isSurfacedTo(ctx.userId, conversation)) return true;
  if (!conversation.assignedTo) return false;
  return String(conversation.assignedTo) === String(ctx.userId);
}

export function canWrite(ctx: ScopeCtx): boolean {
  return ctx.access === "WRITE" || ctx.access === "FULL";
}

/** Reassigning to someone else: FULL + ALL, the CRM rule for acting on other people's rows. */
export function canReassign(ctx: ScopeCtx): boolean {
  return canManageOthers(ctx);
}
