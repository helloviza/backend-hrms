import helmet from "helmet";

export const helmetMiddleware = helmet({
  // Force HTTPS — 1 year, include subdomains
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  // Block MIME type sniffing
  noSniff: true,
  // Block clickjacking
  frameguard: { action: "deny" },
  // Hide Express signature
  hidePoweredBy: true,
  // XSS filter
  xssFilter: true,
  // Referrer policy
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  // Content Security Policy
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://checkout.razorpay.com",
        "https://js.stripe.com",
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
      ],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com",
      ],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https://pics.avs.io",
        "https://*.amazonaws.com",
        "https://lh3.googleusercontent.com",
      ],
      connectSrc: [
        "'self'",
        "https://api.hrms.plumtrips.com",
        "https://plumbox.plumtrips.com",
        "https://api.razorpay.com",
        "wss://meet.mylearnex.com",
      ],
      frameSrc: [
        "https://api.razorpay.com",
        "https://checkout.razorpay.com",
      ],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  // Cross-Origin policies
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  crossOriginResourcePolicy: { policy: "cross-origin" },
});
