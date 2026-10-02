// apps/backend/src/utils/approvalLinkToken.ts
//
// Email decision links for approval requests and proposals (Flow 2 / Flow 3).
//
// - Signed with a secret of its OWN (APPROVAL_LINK_SECRET, or the older
//   EMAIL_ACTION_SECRET), never JWT_SECRET: a leaked session secret must not
//   be able to mint approval links, and the reverse. In production with
//   neither set, no link is issued (emails then say "open Plumbox to decide").
// - Bound to one recipient email and one request/proposal, with an expiry.
// - Single use: models/ApprovalLinkUse.ts records the jti when it acts.
// - Opening the link never acts (GET is read-only); the confirm page POSTs.

import crypto from "crypto";
import jwt from "jsonwebtoken";

export type ApprovalLinkKind = "request" | "proposal";

export type ApprovalLinkPayload = {
  jti: string;
  kind: ApprovalLinkKind;
  /** ApprovalRequest._id or Proposal._id */
  id: string;
  /** The recipient the link was sent to (lowercased). */
  email: string;
};

const DEFAULT_EXPIRY_HOURS = 72;

export function approvalLinkSecret(): string {
  const jwtSecret = process.env.JWT_SECRET || "";
  for (const s of [process.env.APPROVAL_LINK_SECRET, process.env.EMAIL_ACTION_SECRET]) {
    if (s && s !== jwtSecret) return s;
  }
  if (process.env.NODE_ENV === "production") return "";
  // Local/test only: a key derived for this purpose, so dev links still work.
  return crypto.createHash("sha256").update(`approval-links:${jwtSecret || "dev"}`).digest("hex");
}

/**
 * Which setting supplies the link secret — for the boot log. Never the value.
 * "none" in production means email decision links are disabled.
 */
export function approvalLinkSecretSource(): "APPROVAL_LINK_SECRET" | "EMAIL_ACTION_SECRET" | "dev-derived" | "none" {
  const jwtSecret = process.env.JWT_SECRET || "";
  if (process.env.APPROVAL_LINK_SECRET && process.env.APPROVAL_LINK_SECRET !== jwtSecret) return "APPROVAL_LINK_SECRET";
  if (process.env.EMAIL_ACTION_SECRET && process.env.EMAIL_ACTION_SECRET !== jwtSecret) return "EMAIL_ACTION_SECRET";
  return process.env.NODE_ENV === "production" ? "none" : "dev-derived";
}

/** Workspace config.tokenExpiryHours when it is a sane number, else 72h. */
export function approvalLinkExpiryHours(ws: any): number {
  const h = Number(ws?.config?.tokenExpiryHours);
  return Number.isFinite(h) && h >= 1 && h <= 24 * 30 ? h : DEFAULT_EXPIRY_HOURS;
}

/** Returns null when no link secret is configured (production without one). */
export function signApprovalLink(
  input: { kind: ApprovalLinkKind; id: string; email: string },
  expiryHours: number,
): string | null {
  const secret = approvalLinkSecret();
  if (!secret) return null;
  const payload: ApprovalLinkPayload = {
    jti: crypto.randomBytes(16).toString("hex"),
    kind: input.kind,
    id: String(input.id),
    email: String(input.email || "").trim().toLowerCase(),
  };
  return jwt.sign(payload, secret, { expiresIn: `${expiryHours}h`, audience: "approval-link" });
}

export class ApprovalLinkError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function verifyApprovalLink(token: string): ApprovalLinkPayload {
  const secret = approvalLinkSecret();
  if (!secret) throw new ApprovalLinkError(503, "LINKS_DISABLED", "Email decision links are not configured.");
  try {
    const p: any = jwt.verify(String(token || ""), secret, { audience: "approval-link" });
    if (!p?.jti || !p?.id || !p?.email || (p.kind !== "request" && p.kind !== "proposal")) {
      throw new Error("bad payload");
    }
    return { jti: p.jti, kind: p.kind, id: p.id, email: p.email };
  } catch (e: any) {
    if (e?.name === "TokenExpiredError") {
      throw new ApprovalLinkError(410, "LINK_EXPIRED", "This link has expired. Open Plumbox to review the request.");
    }
    throw new ApprovalLinkError(400, "LINK_INVALID", "This link is not valid. Open Plumbox to review the request.");
  }
}
