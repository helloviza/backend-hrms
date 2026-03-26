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
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
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
