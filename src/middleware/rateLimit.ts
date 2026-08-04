import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// General API limiter — all routes
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

// Auth limiter — login, register, forgot-password
// login and refresh are skipped here; they're still covered by apiLimiter (500/15 min)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  skip: (req) =>
    req.path.includes('/login') ||
    req.path.includes('/refresh'),
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts, please try again later.' },
});

// TBO flight search limiter — expensive external API call
export const flightSearchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many search requests, please slow down.' },
});

// TBO hotel search limiter
export const hotelSearchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many hotel search requests, please slow down.' },
});

// Copilot AI limiter — Gemini API calls
export const copilotLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many AI requests, please slow down.' },
});

// Public hotel-photo image endpoint — UNAUTHENTICATED and billable.
//
// This is the real guard now that the endpoint is public: auth used to be what
// stood between the internet and a Google Places Photo call, and auth was the
// wrong tool (it also broke every <img> in production, which cannot send a
// cookie cross-origin). A per-IP limit is the right tool.
//
// Sized against genuine use, not worst case: a hotel answer shows at most 12
// photos, the response is browser-cached for 24h, and a resolved photo is
// served from our own cache — so a real user costs ~12 requests once a day.
// 120/min leaves an office behind one NAT plenty of room while capping a
// scripted hammer at two orders of magnitude below anything that would matter
// on the bill.
export const hotelPhotoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.HOTEL_PHOTO_RATE_LIMIT) || 120,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many photo requests, please slow down.' },
});

// Public travel-request form — unauthenticated write endpoint; a real
// applicant submits once per visit, so this stays tight (bot/spam surface).
export const travelRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});
