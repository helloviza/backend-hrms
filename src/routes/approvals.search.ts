// apps/backend/src/routes/approvals.search.ts
//
// Live TBO search for the approval request form, mounted at
// /api/approvals/search INSIDE the approvals router, so requireAuth,
// requireWorkspace and requireAnyFeature("approvalFlowEnabled", "approvalDirectEnabled") have
// already run.
//
// Gate order (each refuses before the next runs):
//   1. demo / impersonation session → 403 "contact sales" (before anything else)
//   2. SaaS HRMS tenant → 403 (blockTravelForSaas; also mounted globally at /api)
//   3. requireTravelMode(APPROVAL_FLOW, APPROVAL_DIRECT)
//   4. who may raise a request (same check as POST /requests)
//   5. per-user and per-workspace limits (Imran D8)
//
// Responses are price-free by construction (services/approvalSearch/selection.ts
// is the contract). Raw TBO results go only to ApprovalSearchSession.
//
// /flights and /hotels call TBO through services/approvalSearch/search.ts.
// /hotel-cities is not built yet (501): the form sends the typed city, which
// the hotel search resolves against the local catalog.

import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { requireTravelMode } from "../middleware/travelModeGuard.js";
import { blockTravelForSaas } from "../middleware/blockTravelForSaas.js";
import { requireCanRaiseRequest } from "./approvals.security.js";
import {
  searchFlightsForApproval,
  searchHotelsForApproval,
  type SearchReply,
} from "../services/approvalSearch/search.js";

const MIN = 60 * 1000;

/** Imran D8: per user 20 flight / 10 hotel searches per 10 min; per workspace 200 / 100 per hour. */
export const SEARCH_LIMITS = {
  flight: { perUser: 20, perUserWindowMs: 10 * MIN, perWorkspace: 200, perWorkspaceWindowMs: 60 * MIN },
  hotel: { perUser: 10, perUserWindowMs: 10 * MIN, perWorkspace: 100, perWorkspaceWindowMs: 60 * MIN },
} as const;

const userKey = (req: Request) => `user:${String((req as any).user?.sub || (req as any).user?._id || "")}`;
const workspaceKey = (req: Request) => `ws:${String((req as any).workspaceObjectId || "")}`;

function limiter(max: number, windowMs: number, keyGenerator: (req: Request) => string, scope: "user" | "workspace") {
  return rateLimit({
    windowMs,
    max,
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error:
        scope === "user"
          ? "You've run a lot of searches in a short time. Please wait a few minutes and try again."
          : "Your company has reached its live search limit for this hour. Please try again later or enter the details manually.",
      code: scope === "user" ? "SEARCH_RATE_LIMITED_USER" : "SEARCH_RATE_LIMITED_WORKSPACE",
    },
  });
}

function limitsFor(kind: keyof typeof SEARCH_LIMITS) {
  const l = SEARCH_LIMITS[kind];
  return [
    limiter(l.perUser, l.perUserWindowMs, userKey, "user"),
    limiter(l.perWorkspace, l.perWorkspaceWindowMs, workspaceKey, "workspace"),
  ];
}

export function isDemoSession(user: any): boolean {
  return user?.isDemoUser === true || user?._demoImpersonation === true;
}

export function blockDemoSearch(req: Request, res: Response, next: NextFunction) {
  if (isDemoSession((req as any).user)) {
    return res.status(403).json({
      error: "Live search isn't available in demo sessions. Contact sales to see it with your own travel data.",
      code: "DEMO_SEARCH_BLOCKED",
    });
  }
  next();
}

const caller = (req: Request) => ({
  userId: String((req as any).user?.sub || (req as any).user?._id || ""),
  workspaceId: (req as any).workspaceObjectId,
});

const run = (search: (input: any, c: ReturnType<typeof caller>) => Promise<SearchReply>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, body } = await search(req.body || {}, caller(req));
      res.setHeader("Cache-Control", "no-store");
      res.status(status).json(body);
    } catch (err) {
      next(err);
    }
  };

const notYet = (what: string) => (_req: Request, res: Response) =>
  res.status(501).json({ error: `${what} search is not available yet.`, code: "NOT_IMPLEMENTED" });

/** A fresh router (fresh limiter counters) — the app mounts the default instance. */
export function buildApprovalSearchRouter(): Router {
  const router = Router();

  router.use(blockDemoSearch);
  router.use(blockTravelForSaas);
  router.use(requireTravelMode("APPROVAL_FLOW", "APPROVAL_DIRECT"));
  router.use(requireCanRaiseRequest);

  router.post("/flights", ...limitsFor("flight"), run(searchFlightsForApproval));
  router.post("/hotels", ...limitsFor("hotel"), run(searchHotelsForApproval));
  router.get("/hotel-cities", notYet("Hotel city"));

  return router;
}

export default buildApprovalSearchRouter();
