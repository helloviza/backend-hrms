// apps/backend/src/utils/loginEmailLookup.ts
//
// Which login does a typed address belong to? An address can be one user's
// `email` and also another user's `officialEmail` / `personalEmail`, so a
// single $or over the three fields picked whichever document Mongo returned
// first. The order is now fixed:
//
//   1. exact `email`          — the login identifier; wins outright
//   2. `officialEmail`        — only if no user has it as `email`
//   3. `personalEmail`        — only if neither of the above matched
//
// A fallback step (2 or 3) that matches more than one user is AMBIGUOUS: the
// caller must refuse exactly as it would for an unknown address, so the reply
// gives no hint. Step 1 keeps today's behaviour (first match): the same
// `email` in two workspaces is a separate clean-up, and refusing there would
// lock those people out.
//
// Used by POST /auth/login, POST /auth/forgot-password and
// POST /password/admin-set, so a reset always targets the account login
// would sign in.
import User from "../models/User.js";
import { authLogger } from "./logger.js";

export type LoginEmailField = "email" | "officialEmail" | "personalEmail";

export type LoginEmailLookup = {
  /** The single account this address signs in to, or null. */
  user: any | null;
  /** Which field matched; null when nothing (or nothing unambiguous) matched. */
  field: LoginEmailField | null;
  /** True when a fallback field matched more than one user — refuse. */
  ambiguous: boolean;
  /** The matching user ids when ambiguous (for logs only). */
  candidateIds: string[];
};

const FALLBACKS: LoginEmailField[] = ["officialEmail", "personalEmail"];

/**
 * `normalizedEmail` must already be trimmed + lower-cased by the caller (each
 * route keeps its own normaliser). `scope` is ANDed into every step, e.g.
 * `{ workspaceId }` for the workspace-scoped admin reset.
 */
export async function findUserByLoginEmail(
  normalizedEmail: string,
  opts: { scope?: Record<string, unknown>; context?: string } = {},
): Promise<LoginEmailLookup> {
  const scope = opts.scope ?? {};
  const none: LoginEmailLookup = { user: null, field: null, ambiguous: false, candidateIds: [] };
  if (!normalizedEmail) return none;

  const primary = await User.find({ ...scope, email: normalizedEmail }).limit(2);
  if (primary.length) {
    if (primary.length > 1) {
      authLogger.warn("Login email matches more than one user's email; using the first (unchanged behaviour)", {
        context: opts.context,
        userIds: primary.map((u: any) => String(u._id)),
      });
    }
    return { user: primary[0], field: "email", ambiguous: false, candidateIds: [] };
  }

  for (const field of FALLBACKS) {
    const matches = await User.find({ ...scope, [field]: normalizedEmail }).limit(10);
    if (!matches.length) continue;
    if (matches.length > 1) {
      const candidateIds = matches.map((u: any) => String(u._id));
      authLogger.warn("Login email is ambiguous; refusing", { context: opts.context, field, userIds: candidateIds });
      return { user: null, field: null, ambiguous: true, candidateIds };
    }
    return { user: matches[0], field, ambiguous: false, candidateIds: [] };
  }
  return none;
}
