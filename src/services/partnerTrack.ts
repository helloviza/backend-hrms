// apps/backend/src/services/partnerTrack.ts
//
// A student's "Track my case" on a partner link (routes/public.partnerTrack.ts):
//
//   1. request a code — email in, the same answer whatever happens; a 6-digit
//      code is emailed only when this partner has at least one partner lead
//      case for that email (meta.partnerLead.contact.email);
//   2. verify — the code in, a short-lived track token out (30 min), scoped
//      to {emailHash, partnerWorkspaceId};
//   3. cases — the token in, that student's cases with that partner only,
//      built by the partner tracker's own allowlist (partnerLeadTracker.ts).
//
// The track token is NOT a session: it is signed with its own key (derived,
// never JWT_SECRET itself, so requireAuth can never accept it), carries no
// user id, and reads nothing but this one list. Emails and codes are stored
// only as salted hashes (models/PartnerTrackOtp.ts).
import crypto from "crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import ApprovalRequest from "../models/ApprovalRequest.js";
import PartnerTrackOtp from "../models/PartnerTrackOtp.js";
import { bookingsOfCases } from "./partnerLeadBooking.js";
import { PARTNER_LINK_SOURCE } from "./partnerLeadCase.js";
import { TRACKER_CASE_FIELDS, trackerRow } from "./partnerLeadTracker.js";
import { emailHash, normEmail, trackHmac, trackSalt } from "./partnerTrackHash.js";

export { emailHash, normEmail };

type AnyObj = Record<string, any>;

export const CODE_TTL_MS = 10 * 60 * 1000;
export const TOKEN_TTL_S = 30 * 60;
export const MAX_ATTEMPTS = 5;
export const MAX_CODES_PER_HOUR = 3;
export const TRACK_TOKEN_HEADER = "x-partner-track-token";

const codeHash = (otpScope: string, code: string) => trackHmac("partner-track-code", `${otpScope}:${code}`);
const tokenKey = () => crypto.createHash("sha256").update(`partner-track-token:${trackSalt()}`).digest("hex");

export function newCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/* ───────────────────────── cases ───────────────────────── */

/**
 * The partner's lead cases for this email. Cases carry
 * meta.partnerLead.contactEmailHash from create (and from
 * scripts/backfill-partner-lead-email-hash.ts), looked up on the
 * partner_lead_contact_email_hash index. A case without it — created before
 * the field, not yet backfilled — is still found by hashing its stored email.
 */
async function casesFor(partnerWorkspaceId: any, customerId: string, eh: string): Promise<AnyObj[]> {
  const base = { workspaceId: partnerWorkspaceId, customerId, "meta.source": PARTNER_LINK_SOURCE };
  const [indexed, legacy] = await Promise.all([
    ApprovalRequest.find({ ...base, "meta.partnerLead.contactEmailHash": eh })
      .select(TRACKER_CASE_FIELDS)
      .lean(),
    ApprovalRequest.find({ ...base, "meta.partnerLead.contactEmailHash": { $exists: false }, "meta.partnerLead.contact.email": { $exists: true } })
      .select(`${TRACKER_CASE_FIELDS} meta.partnerLead.contact.email`)
      .limit(5000)
      .lean(),
  ]);
  const fallback = (legacy as AnyObj[]).filter((c) => emailHash(c.meta?.partnerLead?.contact?.email) === eh);
  return [...(indexed as AnyObj[]), ...fallback].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/* ───────────────────────── request a code ───────────────────────── */

export type RequestCodeOutcome = "sent" | "no_cases" | "rate_limited";

/**
 * Makes and returns a code when the partner has a case for this email and the
 * email is under its hourly allowance. The caller answers the same way in
 * every case and emails the code only on "sent".
 */
export async function requestTrackCode(opts: {
  email: string;
  partnerWorkspaceId: any;
  customerId: string;
}): Promise<{ outcome: RequestCodeOutcome; code?: string }> {
  const eh = emailHash(opts.email);
  const recent = await PartnerTrackOtp.countDocuments({ emailHash: eh, createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) } });
  if (recent >= MAX_CODES_PER_HOUR) return { outcome: "rate_limited" };
  const cases = await casesFor(opts.partnerWorkspaceId, opts.customerId, eh);
  if (!cases.length) return { outcome: "no_cases" };
  const code = newCode();
  const scope = `${eh}:${String(opts.partnerWorkspaceId)}`;
  // Earlier codes for this email + partner stop working once a new one is sent.
  await PartnerTrackOtp.updateMany({ emailHash: eh, partnerWorkspaceId: opts.partnerWorkspaceId, usedAt: null }, { $set: { usedAt: new Date() } });
  await PartnerTrackOtp.create({
    emailHash: eh,
    partnerWorkspaceId: opts.partnerWorkspaceId,
    codeHash: codeHash(scope, code),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return { outcome: "sent", code };
}

/* ───────────────────────── verify ───────────────────────── */

export class TrackCodeError extends Error {
  constructor(public code: "INVALID_CODE" | "LOCKED", message: string) {
    super(message);
  }
}

/** Checks the code against this email's live code for this partner; a token on success. */
export async function verifyTrackCode(opts: { email: string; code: string; partnerWorkspaceId: any }): Promise<string> {
  const eh = emailHash(opts.email);
  const code = String(opts.code ?? "").replace(/\s+/g, "");
  const otp: any = await PartnerTrackOtp.findOne({ emailHash: eh, partnerWorkspaceId: opts.partnerWorkspaceId }).sort({ createdAt: -1 });
  const invalid = () => new TrackCodeError("INVALID_CODE", "That code is not valid or has expired. Request a new one.");
  if (!otp || otp.usedAt || otp.lockedAt || otp.expiresAt.getTime() <= Date.now()) {
    if (otp?.lockedAt) throw new TrackCodeError("LOCKED", "Too many wrong tries. Request a new code.");
    throw invalid();
  }
  const scope = `${eh}:${String(opts.partnerWorkspaceId)}`;
  const ok = /^\d{6}$/.test(code) && crypto.timingSafeEqual(Buffer.from(codeHash(scope, code)), Buffer.from(otp.codeHash));
  if (!ok) {
    // Atomic, so parallel guesses can't exceed the allowance.
    const after: any = await PartnerTrackOtp.findOneAndUpdate(
      { _id: otp._id, usedAt: null, lockedAt: null },
      { $inc: { attempts: 1 } },
      { new: true },
    );
    if (after && after.attempts >= MAX_ATTEMPTS) {
      await PartnerTrackOtp.updateOne({ _id: otp._id }, { $set: { lockedAt: new Date() } });
      throw new TrackCodeError("LOCKED", "Too many wrong tries. Request a new code.");
    }
    throw invalid();
  }
  // Single use: only the request that flips usedAt gets the token.
  const claimed = await PartnerTrackOtp.updateOne({ _id: otp._id, usedAt: null, lockedAt: null }, { $set: { usedAt: new Date() } });
  if (claimed.modifiedCount !== 1) throw invalid();
  return jwt.sign({ eh, ws: String(opts.partnerWorkspaceId) }, tokenKey(), { expiresIn: TOKEN_TTL_S, audience: "partner-track" });
}

/** The scope a track token grants, or null if it is missing, forged or expired. */
export function readTrackToken(token: any): { emailHash: string; partnerWorkspaceId: string } | null {
  try {
    const p: any = jwt.verify(String(token ?? ""), tokenKey(), { audience: "partner-track" });
    if (typeof p?.eh !== "string" || !mongoose.isValidObjectId(String(p?.ws))) return null;
    return { emailHash: p.eh, partnerWorkspaceId: String(p.ws) };
  } catch {
    return null;
  }
}

/* ───────────────────────── the student's cases ───────────────────────── */

export async function studentCases(scope: { emailHash: string; partnerWorkspaceId: string }, customerId: string) {
  const cases = await casesFor(new mongoose.Types.ObjectId(scope.partnerWorkspaceId), customerId, scope.emailHash);
  const bookings = await bookingsOfCases(customerId, cases.map((c) => c._id));
  const byCase = new Map<string, AnyObj[]>();
  for (const b of bookings) byCase.set(String(b.sourceBookingId), [...(byCase.get(String(b.sourceBookingId)) || []), b]);
  return cases.map((c) => trackerRow(c, byCase.get(String(c._id)) || []));
}
