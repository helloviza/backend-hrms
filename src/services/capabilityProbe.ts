// apps/backend/src/services/capabilityProbe.ts
//
// THE SOFT CAPABILITY CHECK — "does this caller hold X?", answered as a
// boolean instead of as a 403.
//
// ══════════════════════════════════════════════════════════════════════
// WHY THIS IS NOT requirePermission
// ══════════════════════════════════════════════════════════════════════
// requirePermission is a GATE: it decides whether the request happens at
// all, and its only two outcomes are next() and 403. That is right for a
// capability that governs a whole endpoint, and wrong for one that governs
// a FIELD.
//
// The Master Sheet is the case in point. Every reader with
// visaApplication:READ is entitled to the sheet — the rows, the rungs, the
// corridors, the funnel counts. What only some of them are entitled to is
// the contact column. Chaining requirePermission("consumerContactPII") onto
// that route would turn a missing grant into "you may not see the sheet",
// which is not the rule; the rule is "you see the sheet, with the addresses
// masked". A gate cannot express that, because a gate has nowhere to put
// the third answer.
//
// So this returns a boolean and never touches the response. The endpoint
// resolves it ONCE, and the value flows into the shaping function that
// every row, every drill-down and every export passes through.
//
// ── GENERALISED FROM userHoldsScreeningCapability ────────────────────
// services/visaScreeningAuthority.ts got here first, with the same shape
// for a different key. Two capabilities asking the same question two ways
// is how the two answers eventually disagree — so the rules live here once
// and that function's semantics are preserved exactly:
//
//   • status: "active" IS PART OF THE FILTER. requirePermission does not
//     apply it (it reads UserPermission by userId alone), and that is a
//     latent difference rather than a decision — a suspended grant should
//     not confer anything. This is the stricter of the two behaviours and
//     the right one to generalise: erring toward masking is safe, erring
//     toward disclosure is not.
//   • THE SUPERADMIN BYPASS IS KEPT, because it exists at the gate. An
//     account that bypasses requirePermission entirely, sees every module,
//     and is the break-glass for a broken permission system cannot be the
//     one reader shown asterisks — it would make the masking look broken
//     rather than deliberate, and there is nothing an L8 could not read by
//     other means anyway.
//
// ── WHY IT TAKES req AND NOT (userId, roles) ─────────────────────────
// SUPERADMIN detection is isSuperAdmin(req)'s job — the same function
// requirePermission and routes/admin.consumers.ts use — and it reads more
// than roles[]: `role`, `isSuperAdmin`, and crucially the demo-impersonation
// refusal. A hand-rolled roles.includes("SUPERADMIN") here would silently
// re-open the demo-impersonation escalation that check was added to close.
// Taking req is what makes that impossible to get wrong at a call site.
import mongoose from "mongoose";

import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { UserPermission, hasAccess, type AccessLevel } from "../models/UserPermission.js";

/**
 * True when this caller holds `moduleKey` at `min` access or above.
 *
 * NEVER THROWS AND NEVER RESPONDS. A caller with no session, an
 * unparseable id, or no UserPermission row at all is simply `false` — the
 * masked branch — because this answers a question about a field, and a
 * question about a field has no failure mode that should cost the reader
 * their page.
 *
 * One indexed query on a unique key ({ userId: 1 } is unique on
 * UserPermission), resolved once per request by design: a per-row call
 * would be one lookup per row of a sheet whose whole point is that it is
 * long.
 */
export async function holdsCapability(
  req: unknown,
  moduleKey: string,
  min: AccessLevel = "READ",
): Promise<boolean> {
  // The break-glass account, and the same detector the gate uses — see the
  // file header for why this is isSuperAdmin(req) and not a roles check.
  if (isSuperAdmin(req as any)) return true;

  const user = (req as any)?.user;
  const userId = String(user?._id || user?.id || user?.sub || "");
  if (!mongoose.isValidObjectId(userId)) return false;

  const perm = await UserPermission.findOne({ userId, status: "active" })
    // Projected to the one path, so a probe cannot become an accidental
    // reader of the whole permission document.
    .select(`modules.${moduleKey}`)
    .lean();

  const access: AccessLevel = ((perm as any)?.modules?.[moduleKey]?.access as AccessLevel) || "NONE";
  return hasAccess(access, min);
}
