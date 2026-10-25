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
//      built by the partner tracker's own allowlist (partnerLeadTracker.ts),
//      plus — for the student only, never the partner — each case's customer
//      documents (ticket / voucher / document): id, name, type, service;
//   4. a document — the token + a case number + a file id in, a signed link
//      out (5 minutes, its own key, bound to the student, the partner, the
//      case and the file); the link streams the file through the API (never a
//      bucket URL) and writes a staff-only audit row on the case.
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
import ManualBooking, { CUSTOMER_DOCUMENT_TYPES } from "../models/ManualBooking.js";
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
// The document link's own key: a track token is never a document link, nor the other way round.
const fileLinkKey = () => crypto.createHash("sha256").update(`partner-track-file:${trackSalt()}`).digest("hex");
export const FILE_LINK_TTL_S = 5 * 60;
export const STUDENT_DOWNLOAD_ACTION = "student_document_downloaded";

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

export type StudentFile = { id: string; name: string; type: "Ticket" | "Voucher" | "Document"; service: string };

const FILE_TYPE_LABEL: Record<string, StudentFile["type"]> = { ticket: "Ticket", voucher: "Voucher", document: "Document" };
const SERVICE_OF_TYPE: Record<string, string> = { FLIGHT: "Flight", HOTEL: "Hotel", VISA: "Visa" };

/**
 * The live bookings of these cases WITH their customer documents' names (the
 * partner tracker's bookingsOfCases reads types only — the partner never gets
 * a name). Same scope: the case's own customer, Book Now bookings, not deleted.
 */
async function caseBookingsWithFiles(customerId: string, caseIds: any[]): Promise<AnyObj[]> {
  if (!mongoose.isValidObjectId(customerId) || !caseIds.length) return [];
  return ManualBooking.find({
    workspaceId: new mongoose.Types.ObjectId(customerId),
    source: "ADMIN_QUEUE",
    sourceBookingId: { $in: caseIds.map((id) => new mongoose.Types.ObjectId(String(id))) },
    isActive: { $ne: false },
  })
    .select("_id sourceBookingId type status subStatus isActive updatedAt bookingRef attachments._id attachments.type attachments.originalFilename attachments.s3Key attachments.mimeType")
    .lean();
}

/** A booking's customer documents as the student sees them (never internal / other, never a key). */
function studentFilesOf(bookings: AnyObj[]): StudentFile[] {
  const out: StudentFile[] = [];
  for (const b of bookings) {
    for (const a of Array.isArray(b.attachments) ? b.attachments : []) {
      const t = String(a?.type ?? "").toLowerCase();
      if (!CUSTOMER_DOCUMENT_TYPES.has(t) || !a?._id) continue;
      out.push({
        id: String(a._id),
        name: String(a.originalFilename || "document.pdf").slice(0, 120),
        type: FILE_TYPE_LABEL[t],
        service: SERVICE_OF_TYPE[String(b.type ?? "").toUpperCase().replace(/^DUMMY_/, "").replace(/_.*/, "")] || "Other",
      });
    }
  }
  return out;
}

export async function studentCases(scope: { emailHash: string; partnerWorkspaceId: string }, customerId: string) {
  const cases = await casesFor(new mongoose.Types.ObjectId(scope.partnerWorkspaceId), customerId, scope.emailHash);
  const bookings = await caseBookingsWithFiles(customerId, cases.map((c) => c._id));
  const byCase = new Map<string, AnyObj[]>();
  for (const b of bookings) byCase.set(String(b.sourceBookingId), [...(byCase.get(String(b.sourceBookingId)) || []), b]);
  // The tracker row is the partner's allowlist, unchanged; the student also gets the files.
  return cases.map((c) => {
    const own = byCase.get(String(c._id)) || [];
    return { ...trackerRow(c, own), files: studentFilesOf(own) };
  });
}

/* ───────────────────────── a document ───────────────────────── */

export class TrackFileError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** The student's own case and one of its customer documents, re-checked from the database. */
async function findStudentFile(scope: { emailHash: string; partnerWorkspaceId: string }, customerId: string, match: { caseNumber?: string; caseId?: string }, fileId: string) {
  const cases = await casesFor(new mongoose.Types.ObjectId(scope.partnerWorkspaceId), customerId, scope.emailHash);
  const kase = cases.find((c) =>
    match.caseId ? String(c._id) === match.caseId : String(c.meta?.partnerLead?.caseNumber || c.ticketId || "").toUpperCase() === String(match.caseNumber || "").toUpperCase(),
  );
  if (!kase || !mongoose.isValidObjectId(fileId)) return null;
  for (const b of await caseBookingsWithFiles(customerId, [kase._id])) {
    const a = (b.attachments || []).find((x: AnyObj) => String(x?._id) === fileId);
    if (a && CUSTOMER_DOCUMENT_TYPES.has(String(a.type ?? "").toLowerCase()) && a.s3Key) {
      return { kase, booking: b, file: a };
    }
  }
  return null;
}

/** A signed, 5-minute link to one of the student's own documents (404 for anything else). */
export async function createStudentFileLink(scope: { emailHash: string; partnerWorkspaceId: string }, customerId: string, caseNumber: string, fileId: string): Promise<string> {
  const found = await findStudentFile(scope, customerId, { caseNumber }, String(fileId || ""));
  if (!found) throw new TrackFileError(404, "FILE_NOT_FOUND", "That document isn't available.");
  return jwt.sign(
    { eh: scope.emailHash, ws: scope.partnerWorkspaceId, c: String(found.kase._id), a: String(found.file._id) },
    fileLinkKey(),
    { expiresIn: FILE_LINK_TTL_S, audience: "partner-track-file" },
  );
}

/**
 * The file a signed link names — re-checked now (the case still the student's,
 * the booking still live, the file still a customer document) — with a
 * staff-only audit row on the case. Null when the link is expired, tampered,
 * for another partner, or the file is gone.
 */
export async function openStudentFileLink(link: any, partnerWorkspaceId: string, customerId: string): Promise<{ s3Key: string; filename: string; mime: string } | null> {
  let p: any;
  try {
    p = jwt.verify(String(link ?? ""), fileLinkKey(), { audience: "partner-track-file" });
  } catch {
    return null;
  }
  if (typeof p?.eh !== "string" || String(p?.ws) !== String(partnerWorkspaceId) || !mongoose.isValidObjectId(String(p?.c))) return null;
  const found = await findStudentFile({ emailHash: p.eh, partnerWorkspaceId: String(p.ws) }, customerId, { caseId: String(p.c) }, String(p.a || ""));
  if (!found) return null;
  const filename = String(found.file.originalFilename || "document.pdf");
  await ApprovalRequest.updateOne(
    { _id: found.kase._id },
    {
      $push: {
        history: {
          action: STUDENT_DOWNLOAD_ACTION,
          at: new Date(),
          by: "student",
          actorKind: "system",
          comment: `The student downloaded ${filename} (${String(found.booking.bookingRef || "booking")})`,
        },
      },
    } as any,
  ).exec();
  return { s3Key: String(found.file.s3Key), filename, mime: String(found.file.mimeType || "application/pdf") };
}
