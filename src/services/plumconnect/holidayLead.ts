// apps/backend/src/services/plumconnect/holidayLead.ts
//
// PlumConnect Slice 3b — CTWA referral → holiday Lead, through the 3a
// createLead() seam. Capture only: this file sends nothing (the bot and the
// consent prompt are Slice 3c).
// docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md §5 (capture parts);
// INTEGRATION_AUDIT.md §1b (Lead fields), §1c (the seam); dispatch audit §D.
//
// Rules
//   • Only for a NON-employee (the dispatcher passes a resolution whose
//     `hard` is null). An employee who taps an ad gets a lead-kind thread with
//     the referral on it, but no Lead row.
//   • The referral arrives ONLY on the first inbound of a CTWA thread. It is
//     stored verbatim on the Conversation by the dispatcher and typed onto
//     Lead.attribution here, once, at first touch.
//   • Phone dedup lives at the Contact layer (Contact.phone is unique): if
//     this contact's OPEN lead conversation already has a Lead, no second
//     Lead is created — the new referral is logged as a touch (a system
//     Message on the thread + a note activity on the Lead) and the FIRST
//     attribution is left exactly as it was. A returning customer never
//     spawns a duplicate or loses history.
//   • Field set is EXPLICIT (no body spread): the adapter chooses what a
//     WhatsApp-born lead may carry. enquiryType = "holiday_package" is the
//     motion discriminator (D1''); sourceChannel = "whatsapp" is the
//     transport — the ad fact lives in attribution, never in sourceChannel.
//   • Assignee (Track B): the assignment matrix — services/plumconnect/
//     assignment.ts resolveAssignee(): a mapped agent who is present on the
//     line and can act on it, else the thread is HELD unassigned. The 3b
//     static rule (configured user, else first ADMIN) is gone: a lead is
//     never handed to someone who is not available.
//
// Slice 5: captureLead({ businessLine, ... }) generalises the capture to the
// three business lines (LEAD_SHAPE_FOR_LINE picks enquiryType / type) and to
// ORGANIC contacts (no referral → no attribution, no ad note). The
// businessLine comes from the Intent Engine (dispatch.ts / intent.ts) and is
// never derived from attribution here. captureHolidayLead() is the 3b
// signature, fixed to "concierge".

import mongoose from "mongoose";
import LeadActivity, { type ActivityType } from "../../models/LeadActivity.js";
import PlumConnectContact from "../../models/plumconnect/Contact.js";
import PlumConnectConversation, { type IPlumConnectConversation } from "../../models/plumconnect/Conversation.js";
import PlumConnectMessage from "../../models/plumconnect/Message.js";
import { LEAD_SOURCES, type LeadAttribution } from "../../models/Lead.js";
import type { BusinessLine } from "../../models/plumconnect/Conversation.js";
import { createLead } from "../leads.service.js";
import { resolveAssignee, applyRouting } from "./assignment.js";
import { whatsappLogger } from "../../utils/logger.js";

/* ───────────────────────────── referral parsing ───────────────────────────── */

const REFERRAL_BODY_CAP = 500;
export const CONTACT_NAME_FALLBACK = "WhatsApp contact";

export interface ParsedReferral {
  sourceType: string;
  sourceId: string;
  sourceUrl: string;
  ctwaClid: string;
  headline: string;
  body: string;
  mediaType: string;
}

/** Meta's `message.referral` → the typed fields Lead.attribution carries. Pure. */
export function parseReferral(raw: unknown): ParsedReferral {
  const r: any = raw && typeof raw === "object" ? raw : {};
  const s = (v: unknown, cap?: number) => {
    const str = String(v ?? "").trim();
    return cap ? str.slice(0, cap) : str;
  };
  return {
    sourceType: s(r.source_type),
    sourceId: s(r.source_id),
    sourceUrl: s(r.source_url),
    ctwaClid: s(r.ctwa_clid),
    headline: s(r.headline),
    body: s(r.body, REFERRAL_BODY_CAP),
    mediaType: s(r.media_type),
  };
}

/** Lead.source (legacy enum) from the referral's origin — the platform the ad ran on. */
export function leadSourceForReferral(p: ParsedReferral): (typeof LEAD_SOURCES)[number] {
  const url = p.sourceUrl.toLowerCase();
  if (url.includes("instagram.com") || url.includes("ig.me")) return "instagram";
  if (url.includes("facebook.com") || url.includes("fb.me") || url.includes("fb.com")) return "facebook";
  return "other";
}

function attributionFor(p: ParsedReferral, conversationId: mongoose.Types.ObjectId, now: Date): LeadAttribution {
  return {
    channel: "whatsapp",
    sourceType: p.sourceType,
    sourceId: p.sourceId,
    sourceUrl: p.sourceUrl,
    ctwaClid: p.ctwaClid,
    headline: p.headline,
    body: p.body,
    mediaType: p.mediaType,
    capturedAt: now,
    conversationId,
  };
}

function referralSummary(p: ParsedReferral): string {
  const bits = [
    p.headline && `"${p.headline}"`,
    p.sourceType && `${p.sourceType}`,
    p.sourceId && `id ${p.sourceId}`,
    p.sourceUrl && p.sourceUrl,
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : "(no referral details)";
}

/* ───────────────────────────── capture ───────────────────────────── */

/** Slice 5 — which department a lead belongs to decides its enquiryType / type. */
export const LEAD_SHAPE_FOR_LINE: Record<BusinessLine, { enquiryType: string; type: "individual" | "company"; label: string }> = {
  concierge: { enquiryType: "holiday_package", type: "individual", label: "holiday" },
  helloviza: { enquiryType: "visa", type: "individual", label: "visa" },
  plumtrips: { enquiryType: "corporate_account", type: "company", label: "corporate travel" },
};

export interface CaptureLeadInput {
  /** Slice 5 — the Intent Engine's answer. captureHolidayLead() fixes it to "concierge". */
  businessLine: BusinessLine;
  canonical: string;
  profileName: string;
  /** Present on a CTWA first message; null/undefined for an organic contact. */
  referralRaw?: unknown;
  contactId: mongoose.Types.ObjectId;
  conversation: IPlumConnectConversation;
  /** The wamid of the inbound that triggered this (for the touch record). */
  messageId: string;
  now?: Date;
}

/** The 3b signature — a concierge (holiday) capture. Kept as-is for callers and tests. */
export interface CaptureHolidayLeadInput {
  canonical: string;
  profileName: string;
  referralRaw: unknown;
  contactId: mongoose.Types.ObjectId;
  conversation: IPlumConnectConversation;
  /** The wamid of the inbound that carried this referral (for the touch record). */
  messageId: string;
  now?: Date;
}

export type CaptureHolidayLeadResult =
  | { touch: "first"; created: true; leadId: mongoose.Types.ObjectId; assignedTo: mongoose.Types.ObjectId | null; routing: "assigned" | "tie" | "held" }
  | { touch: "repeat"; created: false; leadId: mongoose.Types.ObjectId };

export async function captureHolidayLead(input: CaptureHolidayLeadInput): Promise<CaptureHolidayLeadResult> {
  return captureLead({ ...input, businessLine: "concierge" });
}

/**
 * Create (or, on a repeat touch, record against) the Lead for a routed
 * conversation. For businessLine "concierge" this is byte-for-byte the 3b
 * holiday capture; helloviza / plumtrips differ only in enquiryType / type
 * and the wording of the notes (LEAD_SHAPE_FOR_LINE).
 */
export async function captureLead(input: CaptureLeadInput): Promise<CaptureHolidayLeadResult> {
  const now = input.now ?? new Date();
  const hasReferral = Boolean(input.referralRaw);
  const parsed = parseReferral(input.referralRaw);
  const conversationId = input.conversation._id as mongoose.Types.ObjectId;
  const shape = LEAD_SHAPE_FOR_LINE[input.businessLine];

  // ── Dedup: the open lead thread already has its Lead ──────────────────
  if (input.conversation.leadId) {
    const leadId = input.conversation.leadId as mongoose.Types.ObjectId;
    if (!hasReferral) {
      // An organic repeat message on a routed thread is just conversation —
      // the department's human queue sees it; nothing to record on the Lead.
      return { touch: "repeat", created: false, leadId };
    }
    await PlumConnectMessage.create({
      conversationId,
      direction: "INBOUND",
      channel: "whatsapp",
      type: "system",
      text: `Referral touch: ${referralSummary(parsed)}`,
      payload: { kind: "referral_touch", referral: input.referralRaw, inboundExternalId: input.messageId },
      visibleToContact: false,
      sentAt: now,
    });
    await LeadActivity.create({
      leadId,
      type: "note" as ActivityType,
      note: `WhatsApp ad referral (repeat touch): ${referralSummary(parsed)}`,
      createdByName: "PlumConnect",
    });
    whatsappLogger.info("PlumConnect: repeat referral on an open lead — no second Lead", {
      leadId: String(leadId),
      conversationId: String(conversationId),
    });
    return { touch: "repeat", created: false, leadId };
  }

  // ── First touch: create the Lead through the 3a seam ──────────────────
  // Track B: the matrix decides the owner BEFORE the Lead exists, so
  // Lead.assignedTo is right at creation (the lead.created automation's
  // OWNER rule reads it). Held / tied → no owner; the thread waits.
  const decision = await resolveAssignee({ conversation: input.conversation, line: input.businessLine, sourceId: parsed.sourceId, now });
  const assignee = decision.assignee;

  const body = {
    type: shape.type,
    // Lead.contactName is `required` and Mongoose rejects "" — a sender with
    // no WhatsApp profile name gets the plan's placeholder (§5), not a
    // validation error.
    contactName: String(input.profileName || "").trim() || CONTACT_NAME_FALLBACK,
    contactPhone: input.canonical,
    contactEmail: "",
    companyName: "",
    source: leadSourceForReferral(parsed),
    stage: "new",
    notes: hasReferral && (parsed.headline || parsed.body) ? `WhatsApp ad referral: ${referralSummary(parsed)}` : "",
    enquiryType: shape.enquiryType,
    sourceChannel: "whatsapp",
    // Attribution is typed only when a referral exists (Slice 3b); an organic
    // contact leaves the sub-doc at its defaults.
    ...(hasReferral ? { attribution: attributionFor(parsed, conversationId, now) } : {}),
  };

  const { lead } = await createLead({
    body,
    assignedTo: assignee?.id,
    assignedToName: assignee?.name ?? "",
    createdBy: assignee?.id,
    noteAuthorName: "PlumConnect",
  });
  // The lead.created handle is deliberately not awaited (decision iii).

  const leadId = lead._id as mongoose.Types.ObjectId;
  await PlumConnectConversation.updateOne({ _id: conversationId }, { $set: { leadId } });
  await PlumConnectContact.updateOne({ _id: input.contactId }, { $addToSet: { "refs.leadIds": leadId } });
  input.conversation.leadId = leadId;
  // The thread follows the decision (assignedTo + routing state); the Lead
  // already carries the owner from createLead.
  await applyRouting(input.conversation, decision, now);

  whatsappLogger.info(`PlumConnect: ${shape.label} lead created (${hasReferral ? "CTWA referral" : "organic"})`, {
    leadId: String(leadId),
    businessLine: input.businessLine,
    leadCode: lead.leadCode,
    conversationId: String(conversationId),
    routing: decision.state,
    assignedTo: assignee ? String(assignee.id) : null,
  });
  return { touch: "first", created: true, leadId, assignedTo: assignee?.id ?? null, routing: decision.state };
}
