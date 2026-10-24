// apps/backend/src/routes/public.partnerRequest.ts
//
// The public side of partner lead links, mounted at /api/public next to the
// travel-request form (routes/public.travelRequest.ts, untouched). No login.
//
//   GET  /api/public/partner-links/:code   which partner, which services
//   GET  /api/public/partner-links/:code/hotel-cities?q=
//                                          the form's hotel city typeahead (the
//                                          local catalogue, as on the request form)
//   POST /api/public/partner-request       a student's request → a case in the
//                                          ops queue (services/partnerIntake.create.ts)
//
// POST protections, in order:
//   1. honeypot   — a filled hidden field gets a fake success and no write
//                   (a 4xx would teach a bot which field to leave blank);
//   2. per-IP     — partnerRequestLimiter, 8 / 15 min;
//   3. per-code   — the link's daily cap (PartnerLink.dailyCap, default 200),
//                   checked here before Turnstile and taken atomically by the
//                   service once the request is valid, so failed attempts
//                   never use up a partner's budget;
//   4. Turnstile  — the same fail-closed gate as the other public forms;
//   5. validation — the request form's own item rules, in the service.
//
// Every response is {ok, caseNumber} or an error message. Never an id, a
// price, the partner's ids or origins. An unknown, inactive or mismatched
// link is the same 404 everywhere.
import { Router, type Request, type Response, type NextFunction } from "express";
import PartnerLink from "../models/PartnerLink.js";
import { partnerHotelCityLimiter, partnerLinkResolveLimiter, partnerRequestLimiter } from "../middleware/rateLimit.js";
import { hotelCityTypeahead } from "./approvals.search.js";
import { createTurnstileGate } from "../middleware/turnstile.js";
import { todayIST } from "../services/approvalItemRules.js";
import { CartItemError } from "../services/approvalCartItems.js";
import { TravellerError } from "../services/approvalTravellers.js";
import {
  createPartnerIntakeCase,
  newCaseNumber,
  PartnerIntakeError,
  resolveActivePartnerLink,
} from "../services/partnerIntake.create.js";
import logger from "../utils/logger.js";

const router = Router();
const log = logger.child({ module: "partner-request" });

const NOT_FOUND_BODY = { error: "This link is not available." };
const SERVICE_LABELS: Record<string, string> = { flight: "Flight", hotel: "Hotel", visa: "Visa" };

/* ── GET /partner-links/:code ─────────────────────────────────────────────── */

router.get("/partner-links/:code", partnerLinkResolveLimiter, async (req: Request, res: Response) => {
  try {
    const resolved = await resolveActivePartnerLink(req.params.code);
    if (!resolved) return res.status(404).json(NOT_FOUND_BODY);
    await PartnerLink.updateOne({ _id: resolved.link._id }, { $inc: { clicks: 1 } });
    const services = (Array.isArray(resolved.link.services) && resolved.link.services.length ? resolved.link.services : Object.keys(SERVICE_LABELS))
      .map(String)
      .filter((s: string) => SERVICE_LABELS[s]);
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, partnerDisplayName: resolved.partnerName, services });
  } catch (err) {
    log.error("resolve failed", { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: "Something went wrong. Please try again shortly." });
  }
});

/* ── GET /partner-links/:code/hotel-cities ────────────────────────────────── */

// The request form's own typeahead (routes/approvals.search.ts), for an active
// link that offers hotels. A catalogue read only: no prices exist in it.
router.get("/partner-links/:code/hotel-cities", partnerHotelCityLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await resolveActivePartnerLink(req.params.code);
    const services: string[] = resolved?.link?.services?.length ? resolved.link.services.map(String) : Object.keys(SERVICE_LABELS);
    if (!resolved || !services.includes("hotel")) return res.status(404).json(NOT_FOUND_BODY);
    return hotelCityTypeahead(req, res, next);
  } catch (err) {
    log.error("hotel city lookup failed", { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: "Something went wrong. Please try again shortly." });
  }
});

/* ── POST /partner-request ────────────────────────────────────────────────── */

function honeypotGate(req: Request, res: Response, next: NextFunction) {
  const trap = (req.body as any)?.hpField;
  if (typeof trap === "string" && trap.trim().length > 0) {
    log.warn("honeypot triggered, discarding silently", { ip: req.ip });
    return res.status(201).json({ ok: true, caseNumber: newCaseNumber() });
  }
  next();
}

/** The link must resolve, and today's cap must not be used up. Read-only: the service takes the slot. */
async function linkAndDailyCap(req: Request, res: Response, next: NextFunction) {
  try {
    const resolved = await resolveActivePartnerLink((req.body as any)?.code);
    if (!resolved) return res.status(404).json(NOT_FOUND_BODY);
    const { link } = resolved;
    const cap = Number(link.dailyCap) || 0;
    if (link.dailyCountDay === todayIST() && cap > 0 && Number(link.dailyCount) >= cap) {
      return res.status(429).json({ error: "We're receiving a lot of requests right now. Please try again tomorrow.", code: "DAILY_CAP" });
    }
    next();
  } catch (err) {
    log.error("link check failed", { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: "We couldn't submit your request. Please try again shortly." });
  }
}

const verifyTurnstile = createTurnstileGate("partner-request");

router.post(
  "/partner-request",
  honeypotGate,
  partnerRequestLimiter,
  linkAndDailyCap,
  verifyTurnstile,
  async (req: Request, res: Response) => {
    const b: any = req.body || {};
    try {
      const result = await createPartnerIntakeCase({
        code: b.code,
        submissionId: b.submissionId,
        cartItems: b.cartItems,
        contact: b.contact,
        consent: b.consent,
        comments: b.comments,
        embedMode: b.embedMode,
        parentOrigin: b.parentOrigin,
        utm: b.utm,
        ip: req.ip,
        referrer: String(req.get("referer") || ""),
      });
      log.info("submission processed", { deduped: result.deduped });
      return res.status(result.deduped ? 200 : 201).json({ ok: true, caseNumber: result.caseNumber });
    } catch (err: any) {
      if (err instanceof PartnerIntakeError) {
        if (err.status === 404) return res.status(404).json(NOT_FOUND_BODY);
        return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
      }
      if (err instanceof CartItemError) {
        return res.status(400).json({ error: err.message, code: err.code, itemIndex: err.itemIndex, field: err.field, missing: err.issues[0]?.missing });
      }
      if (err instanceof TravellerError) return res.status(400).json({ error: err.message, code: err.code, missing: err.missing });
      log.error("processing failed", { error: err?.message || String(err) });
      return res.status(500).json({ error: "We couldn't submit your request. Please try again shortly." });
    }
  },
);

export default router;
