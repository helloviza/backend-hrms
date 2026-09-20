// apps/backend/src/services/plumconnect/inboxScope.ts
//
// PlumConnect Slice 4b — scope semantics for the inbox, mirroring the CRM
// v2 model in services/crmScope.ts exactly: the caller's grant is
// { access, scope } from requirePlumConnectAccess; OWN = conversations
// assigned to me, ALL = everyone's; TEAM is the same reserved hook CRM has
// (narrows to OWN until a reports-to set exists — never widens). The owner
// field of a Conversation is `assignedTo`.

import mongoose from "mongoose";
import type express from "express";
import { normalizeScope, rowsFor, isAll, canManageOthers, type ScopeCtx } from "../crmScope.js";

type AnyObj = Record<string, any>;

function callerId(req: express.Request): mongoose.Types.ObjectId | null {
  const user = (req as any).user as AnyObj | undefined;
  const raw = String(user?.id || user?.sub || "");
  return mongoose.isValidObjectId(raw) ? new mongoose.Types.ObjectId(raw) : null;
}

/** Scope for routes behind requirePlumConnectAccess. */
export function inboxScope(req: express.Request): ScopeCtx {
  return {
    userId: callerId(req),
    access: String((req as any).plumconnectAccess || "NONE"),
    scope: normalizeScope((req as any).plumconnectScope),
  };
}

/** The Mongo filter for the conversations this caller may see. */
export function conversationMatch(ctx: ScopeCtx): AnyObj {
  return rowsFor(ctx, "assignedTo");
}

/** May the caller see THIS conversation? (OWN: it is assigned to them.) */
export function canSee(ctx: ScopeCtx, conversation: { assignedTo?: mongoose.Types.ObjectId | null }): boolean {
  if (isAll(ctx)) return true;
  if (!ctx.userId || !conversation.assignedTo) return false;
  return String(conversation.assignedTo) === String(ctx.userId);
}

export function canWrite(ctx: ScopeCtx): boolean {
  return ctx.access === "WRITE" || ctx.access === "FULL";
}

/** Reassigning to someone else: FULL + ALL, the CRM rule for acting on other people's rows. */
export function canReassign(ctx: ScopeCtx): boolean {
  return canManageOthers(ctx);
}
