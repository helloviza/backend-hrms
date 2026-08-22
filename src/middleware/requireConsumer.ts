// apps/backend/src/middleware/requireConsumer.ts
//
// The consumer-side guard. Deliberately NOT a variant of requireAuth — a
// separate function, a separate secret, and a separate request property.
//
// ══════════════════════════════════════════════════════════════════════
// IT SETS req.consumer, NEVER req.user. THIS IS A HARD RULE.
// ══════════════════════════════════════════════════════════════════════
//
// Every authorisation guard in this codebase — requireWorkspace,
// requirePermission, requireFeature, requireSuperAdmin, isSuperAdmin,
// requireRoles, requireAdmin, customerApprovalGuard, requireActiveMember —
// reads req.user and NONE of them verifies a token (confirmed by reading all
// of them: infra/audit/helloviza-d2c-tokenwall-2026-08-15.md §2.2). Setting
// req.user here would hand a consumer identity to every one of them at once.
//
// It would also trip the global shim at server.ts:263, which runs
// requireWorkspace for any request that has a req.user and whose prefix is
// not in WORKSPACE_EXEMPT. /api/consumer IS exempt, so the shim is skipped
// either way — but the rule stands independently of that, because the exempt
// list is one edit away from someone else's change.
//
// ── WHY THE DB READ ───────────────────────────────────────────────────
// Step 4/5 below loads the consumer to compare tokenVersion. That is one
// indexed findById per authenticated request, and it is the price of REAL
// revocation. The B2B side has no denylist, no tokenVersion and no session
// store (tokenwall audit §5.3), so a revoked B2B user keeps working until
// their token expires — up to 30 minutes. The consumer side does not inherit
// that, and logout here actually means logout.
import type { Request, Response, NextFunction } from "express";
import Consumer from "../models/Consumer.js";
import { verifyConsumerAccessToken } from "../utils/consumerJwt.js";
import { CONSUMER_ACCESS_COOKIE } from "../config/consumerAuth.js";
import { HELLOVIZA_D2C_WORKSPACE_ID } from "../services/consumerWorkspace.js";

export interface RequestConsumer {
  id: string;
  email: string;
  name: string;
  tokenVersion: number;
  /**
   * When the account was created — the real "member since".
   *
   * Optional because a Consumer row written before `timestamps: true`
   * would not carry one. Every row in every environment checked does,
   * but a reader must not have to trust that: the surfaces that show it
   * render nothing when it is absent rather than substituting a date
   * that means something else (routes/consumer.profile.ts publishes it
   * as `memberSince`, and AccountBanner omits the line on null).
   */
  createdAt?: Date;
}

declare global {
  namespace Express {
    interface Request {
      consumer?: RequestConsumer;
      /** The synthetic D2C tenant. Stamped, never resolved from a DB read. */
      consumerWorkspaceId?: string;
    }
  }
}

function extractConsumerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const t = header.slice("Bearer ".length).trim();
    if (t) return t;
  }

  // Only ONE cookie name is accepted, unlike requireAuth (which scavenges
  // five) and routes/workspace.ts (which reads a different five). A guard
  // that accepts many names is a guard whose surface nobody can enumerate.
  const raw = (req as any).cookies?.[CONSUMER_ACCESS_COOKIE];
  if (typeof raw === "string" && raw.trim()) return raw.trim();

  return null;
}

export async function requireConsumer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractConsumerToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let payload;
  try {
    // THE WALL. A B2B token dies on this line with
    // `JsonWebTokenError: invalid signature` — it never reaches the aud check
    // below, and the aud check is not what stops it.
    payload = verifyConsumerAccessToken(token);
  } catch {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  try {
    const consumer = await Consumer.findById(payload.sub)
      // createdAt rides along on a read this request already makes — no
      // extra query for the "Member since" line.
      .select("_id email name tokenVersion status createdAt")
      .lean();

    if (!consumer) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    if ((consumer as any).status !== "ACTIVE") {
      res.status(403).json({ error: "Account is not active" });
      return;
    }
    // REVOCATION. A logout ($inc tokenVersion) makes every token minted
    // before it fail here, access and refresh alike.
    if ((consumer as any).tokenVersion !== payload.tokenVersion) {
      res.status(401).json({ error: "Session has been revoked" });
      return;
    }

    req.consumer = {
      id: String((consumer as any)._id),
      email: (consumer as any).email,
      name: (consumer as any).name,
      tokenVersion: (consumer as any).tokenVersion,
      createdAt: (consumer as any).createdAt,
    };
    // Constant, no DB read — see services/consumerWorkspace.ts for why this
    // is a hardcoded id rather than an upserted one.
    req.consumerWorkspaceId = HELLOVIZA_D2C_WORKSPACE_ID;

    next();
  } catch (err) {
    next(err);
  }
}

export default requireConsumer;
