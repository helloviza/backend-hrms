// apps/backend/src/utils/setPasswordLink.ts
import crypto from "crypto";
import User from "../models/User.js";
import { publicAppUrl } from "./publicAppUrl.js";
import { LoginDisabledError, loginEnabledFilter } from "./loginDisabled.js";

/** Forgot-password links. */
export const RESET_LINK_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Invite / welcome links for a brand-new login. */
export const ONBOARDING_LINK_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

/**
 * The ONE set-password token scheme: a random token whose SHA-256 is stored on
 * the user (resetTokenHash + resetTokenExpiry) and consumed by
 * POST /api/auth/reset-password via the /reset-password page. Used by
 * forgot-password and by every invite/welcome email, so no email ever carries
 * a password. Issuing a new link replaces any earlier unused one.
 */
export async function issueSetPasswordLink(userId: unknown, ttlMs: number): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(rawToken).digest("hex");

  // A disabled login (utils/loginDisabled.ts) never gets a link. Every caller
  // already treats a throw as "email not sent".
  const r = await User.updateOne(
    { _id: userId, ...loginEnabledFilter() },
    { $set: { resetTokenHash: hash, resetTokenExpiry: new Date(Date.now() + ttlMs) } },
  );
  if (r.matchedCount !== 1) {
    if (await User.exists({ _id: userId })) throw new LoginDisabledError();
    throw new Error("issueSetPasswordLink: user not found");
  }

  return `${publicAppUrl()}/reset-password?token=${rawToken}`;
}
