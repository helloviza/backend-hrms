// apps/backend/src/utils/cstepHardCopy.ts
//
// P3 — the travel report's paper (hard) copy, tracked Traveller → Admin →
// Finance. Three prompts ride on actions that already exist, and the answer
// travels in that action's request body:
//
//   prompt                    rides on                          asked when (current status)
//   Traveller                 POST /requests/:id/report/submit  not captured, or PENDING
//   Admin (the Travel Desk)   POST /requests/:id/settlement/finalize  PENDING or SUBMITTED_TO_ADMIN
//   Finance                   POST /requests/:id/finance/settle anything but RECEIVED_AT_FINANCE
//
// plus PATCH /requests/:id/hard-copy — Admin / Finance set it directly (a
// correction, or the paper turning up after the case closed).
//
// Record-only: nothing here allows or refuses an action. An answer given
// where its prompt does not apply is ignored, and a failure to record one is
// logged and swallowed — the submit / finalize / reimburse always goes ahead.
// Only a "No" sends mail (L1 / L2 standalone, L3 on the closing mail); every
// "Yes" is silent. Claims (LOCAL_TRAVEL_CLAIM / EXPENSE_CLAIM) have no
// travel report and are never prompted.
//
// Every answer and every correction writes one HARD_COPY CstepApproval entry
// (who, when, from → to, the answer, the optional note) — the history — and
// stamps request.hardCopy {status, updatedBy, updatedAt}.
import mongoose from "mongoose";
import CstepApproval from "../models/cstep/CstepApproval.js";
import CstepTravelRequest, {
  CSTEP_HARD_COPY_STATUSES,
  isClaimFormType,
  type CstepHardCopyStatus,
} from "../models/cstep/CstepTravelRequest.js";
import logger from "./logger.js";

export { CSTEP_HARD_COPY_STATUSES, type CstepHardCopyStatus };

/** Plain-English display, the same words the page shows. */
export const HARD_COPY_LABEL: Record<CstepHardCopyStatus | "NOT_CAPTURED", string> = {
  PENDING: "pending submission",
  SUBMITTED_TO_ADMIN: "submitted to Admin",
  RECEIVED_AT_ADMIN: "received at Admin (pending to Finance)",
  SUBMITTED_TO_FINANCE: "submitted to Finance",
  RECEIVED_AT_FINANCE: "received at Finance",
  NOT_CAPTURED: "not captured",
};

export const HARD_COPY_TRAVELLER_ANSWERS = ["NO", "ADMIN", "FINANCE"] as const;
export const HARD_COPY_ADMIN_ANSWERS = ["NOT_RECEIVED", "RECEIVED", "FORWARDED"] as const;
export const HARD_COPY_FINANCE_ANSWERS = ["RECEIVED", "NOT_RECEIVED", "PENDING_WITH_ADMIN"] as const;
export type HardCopyTravellerAnswer = (typeof HARD_COPY_TRAVELLER_ANSWERS)[number];
export type HardCopyAdminAnswer = (typeof HARD_COPY_ADMIN_ANSWERS)[number];
export type HardCopyFinanceAnswer = (typeof HARD_COPY_FINANCE_ANSWERS)[number];

const ANSWER_TEXT: Record<string, string> = {
  "TRAVELLER:NO": "Traveller: hard copy not submitted yet",
  "TRAVELLER:ADMIN": "Traveller: hard copy submitted to Admin",
  "TRAVELLER:FINANCE": "Traveller: hard copy submitted to Finance",
  "ADMIN:NOT_RECEIVED": "Admin: hard copy not received",
  "ADMIN:RECEIVED": "Admin: hard copy received, not yet sent to Finance",
  "ADMIN:FORWARDED": "Admin: hard copy received and sent to Finance",
  "FINANCE:RECEIVED": "Finance: hard copy received",
  "FINANCE:NOT_RECEIVED": "Finance: hard copy not received",
  "FINANCE:PENDING_WITH_ADMIN": "Finance: hard copy pending with Admin",
};

export function hardCopyStatusOf(doc: any): CstepHardCopyStatus | null {
  const s = doc?.hardCopy?.status;
  return (CSTEP_HARD_COPY_STATUSES as readonly string[]).includes(s) ? s : null;
}

/** Does this case track a hard copy at all — a Tour / Event with a travel report. */
export function tracksHardCopy(doc: any): boolean {
  return !isClaimFormType(doc?.formType);
}

export const travellerPrompted = (current: CstepHardCopyStatus | null) => current === null || current === "PENDING";
export const adminPrompted = (current: CstepHardCopyStatus | null) => current === "PENDING" || current === "SUBMITTED_TO_ADMIN";
export const financePrompted = (current: CstepHardCopyStatus | null) => current !== "RECEIVED_AT_FINANCE";

/** The body's answer for a prompt: undefined when none was sent, or an error
 * for a value that is not one of the prompt's answers. */
export function parseHardCopyAnswer<T extends string>(raw: any, allowed: readonly T[]): { answer?: T } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return {};
  if (!(allowed as readonly string[]).includes(raw)) return { error: `hardCopy must be one of ${allowed.join(", ")}` };
  return { answer: raw as T };
}

/** What a traveller's answer sets, and whether it sends L1. */
export function planTraveller(answer: HardCopyTravellerAnswer): { to: CstepHardCopyStatus; mail: boolean } {
  if (answer === "ADMIN") return { to: "SUBMITTED_TO_ADMIN", mail: false };
  if (answer === "FINANCE") return { to: "SUBMITTED_TO_FINANCE", mail: false };
  return { to: "PENDING", mail: true };
}

/** What the Admin's answer sets, and whether it sends L2. */
export function planAdmin(answer: HardCopyAdminAnswer): { to: CstepHardCopyStatus; mail: boolean } {
  if (answer === "FORWARDED") return { to: "SUBMITTED_TO_FINANCE", mail: false };
  if (answer === "RECEIVED") return { to: "RECEIVED_AT_ADMIN", mail: false };
  return { to: "PENDING", mail: true };
}

/** What Finance's answer sets, and whether the closing mail carries L3. */
export function planFinance(
  current: CstepHardCopyStatus | null,
  answer: HardCopyFinanceAnswer,
): { to: CstepHardCopyStatus | null; pendingLine: boolean } {
  if (answer === "RECEIVED") return { to: "RECEIVED_AT_FINANCE", pendingLine: false };
  if (answer === "PENDING_WITH_ADMIN") return { to: "RECEIVED_AT_ADMIN", pendingLine: true };
  return { to: current, pendingLine: true };
}

export type HardCopySource = "TRAVELLER_SUBMIT" | "ADMIN_FINALIZE" | "FINANCE_SETTLE" | "CORRECTION";

/**
 * Stamps request.hardCopy (when `to` is a status) and writes the HARD_COPY
 * entry. `to` null = the answer left a not-captured case as it was (Finance
 * "No" on a legacy case): the entry still records the answer. Mirrors the
 * new value onto the in-memory doc so the route's response carries it.
 * Returns the entry, or null if recording failed (logged, never thrown).
 */
export async function recordHardCopy(
  doc: any,
  opts: {
    actor: string | mongoose.Types.ObjectId;
    stage: "TRAVELER" | "OFFICIAL" | "FINANCE";
    source: HardCopySource;
    to: CstepHardCopyStatus | null;
    answer?: string;
    note?: string;
  },
): Promise<any | null> {
  try {
    const from = hardCopyStatusOf(doc);
    const actor = new mongoose.Types.ObjectId(String(opts.actor));
    const now = new Date();
    if (opts.to) {
      const hardCopy = { status: opts.to, updatedBy: actor, updatedAt: now };
      await CstepTravelRequest.updateOne({ _id: doc._id, workspaceId: doc.workspaceId }, { $set: { hardCopy } });
      // For the route's response. A later save of the doc writes the same value.
      if (typeof doc.set === "function") doc.set("hardCopy", hardCopy);
      else doc.hardCopy = hardCopy;
    }
    const fromLabel = HARD_COPY_LABEL[from || "NOT_CAPTURED"];
    const toLabel = HARD_COPY_LABEL[opts.to || from || "NOT_CAPTURED"];
    const change = (opts.to || from) === from ? `${toLabel} (unchanged)` : `${fromLabel} → ${toLabel}`;
    const answerText = opts.answer ? ANSWER_TEXT[`${opts.stage === "TRAVELER" ? "TRAVELLER" : opts.stage === "OFFICIAL" ? "ADMIN" : "FINANCE"}:${opts.answer}`] : "";
    const note = String(opts.note || "").trim();
    return await CstepApproval.create({
      workspaceId: doc.workspaceId,
      entityType: "REQUEST",
      entityId: doc._id,
      stage: opts.stage,
      actor,
      action: "HARD_COPY",
      comment: [`Hard copy: ${change}`, answerText, opts.source === "CORRECTION" ? "Corrected" : "", note].filter(Boolean).join(" | "),
      hardCopyChange: { from: from || "NOT_CAPTURED", to: opts.to || from || "NOT_CAPTURED", source: opts.source },
      at: now.toISOString(),
    });
  } catch (err: any) {
    logger.error("[CSTEP hard copy] not recorded", { requestId: String(doc?._id || ""), source: opts.source, error: err?.message });
    return null;
  }
}
