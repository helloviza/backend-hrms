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
// /hotel-cities is the hotel city / hotel name typeahead: the local catalogue
// only (services/hotelCatalogSearch.ts), never a TBO call.

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
import { searchHotelCatalog } from "../services/hotelCatalogSearch.js";
import { parseStars } from "../services/approvalSearch/selection.js";
import { normalizeSearch } from "../jobs/static-data-refresh.js";

const MIN = 60 * 1000;

/** Imran D8: per user 20 flight / 10 hotel searches per 10 min; per workspace 200 / 100 per hour. */
export const SEARCH_LIMITS = {
  flight: { perUser: 20, perUserWindowMs: 10 * MIN, perWorkspace: 200, perWorkspaceWindowMs: 60 * MIN },
  hotel: { perUser: 10, perUserWindowMs: 10 * MIN, perWorkspace: 100, perWorkspaceWindowMs: 60 * MIN },
  // Typeahead: one call per pause in typing, a database read only.
  hotelCity: { perUser: 120, perUserWindowMs: 10 * MIN, perWorkspace: 2000, perWorkspaceWindowMs: 60 * MIN },
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

/** Typeahead result: a city or a specific hotel. No prices exist in the catalogue. */
export type HotelPlaceOption = {
  type: "city" | "hotel";
  name: string;
  city: string;
  country: string;
  countryCode: string;
  cityCode: string;
  hotelCode?: string;
  stars?: number | null;
};

export const TYPEAHEAD_MIN_CHARS = 2;
const TYPEAHEAD_MAX_CHARS = 80;
const TYPEAHEAD_CAP = 10;

/** GET /hotel-cities?q= — cities and hotels from the local catalogue. */
export async function hotelCityTypeahead(req: Request, res: Response, next: NextFunction) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const q = String(req.query?.q ?? "").trim().slice(0, TYPEAHEAD_MAX_CHARS);
    if (normalizeSearch(q).length < TYPEAHEAD_MIN_CHARS) return res.json({ ok: true, results: [] });

    // Ranking hint only (India first on ties); never a filter.
    const priorityCode = String(req.query?.countryCode || "IN").trim().toUpperCase().slice(0, 2) || "IN";
    const { cities, hotels } = await searchHotelCatalog(q, { priorityCode, cityCap: TYPEAHEAD_CAP, hotelCap: TYPEAHEAD_CAP });

    const results: HotelPlaceOption[] = [
      ...cities.map((c) => ({
        type: "city" as const,
        name: c.name,
        city: c.name,
        country: c.countryName,
        countryCode: c.countryCode,
        cityCode: c.code,
      })),
      ...hotels.map((h) => ({
        type: "hotel" as const,
        name: h.hotelName,
        city: h.cityName,
        country: h.countryCode ? h.countryName : h.cityCountryName,
        countryCode: h.countryCode || h.cityCountryCode,
        cityCode: h.cityCode,
        hotelCode: h.hotelCode,
        stars: parseStars(h.rating),
      })),
    ];
    res.json({ ok: true, results });
  } catch (err) {
    next(err);
  }
}

/** A fresh router (fresh limiter counters) — the app mounts the default instance. */
export function buildApprovalSearchRouter(): Router {
  const router = Router();

  router.use(blockDemoSearch);
  router.use(blockTravelForSaas);
  router.use(requireTravelMode("APPROVAL_FLOW", "APPROVAL_DIRECT"));
  router.use(requireCanRaiseRequest);

  router.post("/flights", ...limitsFor("flight"), run(searchFlightsForApproval));
  router.post("/hotels", ...limitsFor("hotel"), run(searchHotelsForApproval));
  router.get("/hotel-cities", ...limitsFor("hotelCity"), hotelCityTypeahead);

  return router;
}

export default buildApprovalSearchRouter();
