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
//   • Assignee: PLUMCONNECT_HOLIDAY_LEAD_ASSIGNEE, else the first
//     ADMIN/SUPERADMIN — the website-capture rule (routes/leads.ts:260-264).

import mongoose from "mongoose";
import User from "../../models/User.js";
import LeadActivity, { type ActivityType } from "../../models/LeadActivity.js";
import PlumConnectContact from "../../models/plumconnect/Contact.js";
import PlumConnectConversation, { type IPlumConnectConversation } from "../../models/plumconnect/Conversation.js";
import PlumConnectMessage from "../../models/plumconnect/Message.js";
import { LEAD_SOURCES, type LeadAttribution } from "../../models/Lead.js";
import { createLead } from "../leads.service.js";
import { holidayLeadAssigneeId } from "../../config/plumconnect.js";
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

/* ───────────────────────────── assignee ───────────────────────────── */

function displayName(u: any): string {
  return (
    (u?.name && String(u.name).trim()) ||
    `${u?.firstName || ""} ${u?.lastName || ""}`.trim() ||
    (u?.email ? String(u.email).trim() : "")
  );
}

/** Configured owner if it names a real user, else the first admin (website-capture rule). */
export async function resolveHolidayLeadAssignee(): Promise<{ id: mongoose.Types.ObjectId; name: string } | null> {
  const configured = holidayLeadAssigneeId();
  if (configured) {
    const u: any = await User.findById(configured).select("_id name firstName lastName email").lean();
    if (u) return { id: u._id, name: displayName(u) };
    whatsappLogger.warn("PlumConnect: PLUMCONNECT_HOLIDAY_LEAD_ASSIGNEE names no user — falling back", { configured });
  }
  const defaultRep: any = await (User as any)
    .findOne({ roles: { $in: ["ADMIN", "SUPERADMIN"] } })
    .select("_id name firstName lastName email")
    .lean();
  return defaultRep ? { id: defaultRep._id, name: displayName(defaultRep) } : null;
}

/* ───────────────────────────── capture ───────────────────────────── */

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
  | { touch: "first"; created: true; leadId: mongoose.Types.ObjectId; assignedTo: mongoose.Types.ObjectId | null }
  | { touch: "repeat"; created: false; leadId: mongoose.Types.ObjectId };

export async function captureHolidayLead(input: CaptureHolidayLeadInput): Promise<CaptureHolidayLeadResult> {
  const now = input.now ?? new Date();
  const parsed = parseReferral(input.referralRaw);
  const conversationId = input.conversation._id as mongoose.Types.ObjectId;

  // ── Dedup: the open lead thread already has its Lead ──────────────────
  if (input.conversation.leadId) {
    const leadId = input.conversation.leadId as mongoose.Types.ObjectId;
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
  const assignee = await resolveHolidayLeadAssignee();

  const body = {
    type: "individual",
    // Lead.contactName is `required` and Mongoose rejects "" — a sender with
    // no WhatsApp profile name gets the plan's placeholder (§5), not a
    // validation error.
    contactName: String(input.profileName || "").trim() || CONTACT_NAME_FALLBACK,
    contactPhone: input.canonical,
    contactEmail: "",
    companyName: "",
    source: leadSourceForReferral(parsed),
    stage: "new",
    notes: parsed.headline || parsed.body ? `WhatsApp ad referral: ${referralSummary(parsed)}` : "",
    enquiryType: "holiday_package",
    sourceChannel: "whatsapp",
    attribution: attributionFor(parsed, conversationId, now),
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

  whatsappLogger.info("PlumConnect: holiday lead created from CTWA referral", {
    leadId: String(leadId),
    leadCode: lead.leadCode,
    conversationId: String(conversationId),
    assignedTo: assignee ? String(assignee.id) : null,
  });
  return { touch: "first", created: true, leadId, assignedTo: assignee?.id ?? null };
}
