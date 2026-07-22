// apps/backend/src/server.ts
// ⚠️ MUST be the first import: back-fills process.env from the APP_SECRETS
// bundle (and loads .env) BEFORE config/env.ts or any route reads SMTP_*/
// GOOGLE_PLACES_API_KEY/PIXABAY_API_KEY at module-load time.
import "./bootstrap/loadSecrets.js";

import express from "express";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import logger from "./utils/logger.js";

import { connectDb } from "./config/db.js";
import { corsMiddleware } from "./config/cors.js";
import { helmetMiddleware } from "./config/helmet.js";
import { errorHandler } from "./middleware/error.js";
import { requireWorkspace } from "./middleware/requireWorkspace.js";
import { blockTravelForSaas } from "./middleware/blockTravelForSaas.js";
import { requireAuth } from "./middleware/auth.js";
import { requireFeature } from "./middleware/requireFeature.js";
import { apiLimiter, authLimiter, flightSearchLimiter, hotelSearchLimiter, copilotLimiter } from "./middleware/rateLimit.js";
import { env } from "./config/env.js";
import vouchers from "./routes/vouchers.js";

// ─────────────── CORE ROUTES ───────────────
import auth from "./routes/auth.js";
import attendance from "./routes/attendance.js";
import leaves from "./routes/leaves.js";
import holidays from "./routes/holidays.js";
import uploads from "./routes/uploads.js";
import * as onboarding from "./routes/onboarding.js";
import masterDataRouter from "./routes/masterData.js";
import customerUsersRouter from "./routes/customerUsers.js";
import previewRoutes from "./routes/preview.js";
import flightRoutes from "./routes/flightRoutes.js";

// ✅ Approvals (MUST be statically mounted; do NOT safeMount)
import approvalsRouter from "./routes/approvals.js";

// ✅ Booking History (Booked/Cancelled outcomes + admin PDFs)
import bookingHistory from "./routes/bookingHistory.js";

// Newly added modules
import users from "./routes/users.js";
import stats from "./routes/stats.js";
import logs from "./routes/logs.js";
import stubs from "./routes/stubs.js";
import passwordRoutes from "./routes/password.js";

// ✅ Employees (HRMS master employee records)
import employeesRouter from "./routes/employees.js";

// ✅ HR assistant routers
import assistantRouter from "./routes/assistant.js";
import assistantHrRouter from "./routes/assistantHr.js";
import travelCopilotRoutes from "./routes/copilot.travel.js";
import { runPlutoBootCheck } from "./services/plutoBootCheck.js";
import { invokePlutoGemini } from "./utils/plutoGeminiInvoke.js";
import plutoVideoRouter from "./routes/pluto.video.js";
import copilotVideoConsent from "./routes/copilot.videoConsent.js";
import adminVideoRouter from "./routes/admin.video.js";


// 🔥 Background workers (NEW – safe add)
import { startBackgroundWorkers } from "./workers/index.js";

// ✅ Copilot router (manager / HR queries)
import copilotRouter from "./routes/copilot.js";

// ✅ HR / Manager dashboard overview router
import dashboardRouter from "./routes/dashboard.js";

// ✅ HR policies + org chart
import hrPoliciesRouter from "./routes/hrPolicies.js";
import hrOrgChartRouter from "./routes/hrOrgChart.js";

// ✅ Admin routes (reports, exports, vendor/business views, etc.)
import adminRouter from "./routes/admin.js";

// ✅ Admin analytics (for /api/admin/analytics)
import adminAnalyticsRouter from "./routes/adminAnalytics.js";

// ✅ Vendor & Business service capability routes
import vendorServicesRouter from "./routes/vendorServices.js";
import businessServicesRouter from "./routes/businessServices.js";

// ✅ Vendor / Customer master + self endpoints
import vendorsRouter from "./routes/vendors.js";
import customersRouter from "./routes/customers.js";
import directCustomersRouter from "./routes/directCustomers.js";
import vendorCustomerSelfRouter from "./routes/vendorCustomerSelf.js";

// ✅ Workspace (customer/vendor/business logo + workspace meta)
import workspaceRouter from "./routes/workspace.js";

// ✅ Google Places (Hotels)
import placesRouter from "./routes/places.js";

// ✅ NEW WORKFLOW: proposals
import proposalsRouter from "./routes/proposals.js";

// ✅ Image proxy (same-origin fetch for S3 assets)
import proxyRouter from "./routes/proxy.js";

// ✅ Remote Work Presence & Video Collaboration
import activityRoutes from "./routes/activity.js";
import presenceRoutes from "./routes/presence.js";
import meetingRoutes from "./routes/meetings.js";
import leadsRouter from "./routes/leads.js";
import crmCompaniesRouter from "./routes/crm.companies.js";
import crmContactsRouter from "./routes/crm.contacts.js";

const app = express();

/* ────────────────────────────────────────────────────────────────
 * GLOBAL APP SETTINGS
 * ──────────────────────────────────────────────────────────────── */
app.disable("x-powered-by");
app.set("trust proxy", 1);

// Prevent 304 with empty body on APIs
app.set("etag", false);

if (process.env.NODE_ENV !== "production") {
  app.set("json spaces", 2);
}

/* ────────────────────────────────────────────────────────────────
 * MIDDLEWARE ORDER (IMPORTANT)
 * ──────────────────────────────────────────────────────────────── */

// Request ID middleware — adds unique ID to every request for log correlation
app.use((req: any, res, next) => {
  req.requestId = randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});

// Logging first
morgan.token("request-id", (req: any) => req.requestId);
app.use(
  morgan(
    process.env.NODE_ENV === "production"
      ? ":request-id :method :url :status :response-time ms"
      : ":request-id :method :url :status :response-time ms"
  )
);

// Security headers
app.use(helmetMiddleware);

// Handle preflight requests explicitly
app.options("*", corsMiddleware);

// CORS
app.use(corsMiddleware);

// Log suspicious requests
app.use((req, res, next) => {
  const suspicious = [
    "/.env", "/wp-admin", "/phpmyadmin",
    "/admin.php", "/.git", "/config.php",
    "/config.json", "/config.yml", "/config.xml",
    "/shell", "/cmd", "/eval",
  ];
  const path = req.path.toLowerCase();
  if (suspicious.some(s => path.includes(s)) && !path.startsWith("/api/")) {
    console.warn(
      `[SECURITY] Suspicious request blocked: ${req.method} ${req.path} IP: ${req.ip} UA: ${req.headers["user-agent"]}`
    );
    return res.status(404).json({ error: "Not found" });
  }
  next();
});

// Razorpay webhook — MUST be before express.json() to receive raw body
import razorpayWebhookRouter from "./routes/razorpay.webhook.js";
if (env.DEPLOYMENT_MODE === "plumbox") {
  // KEEP_IN_PLUMBOX — Razorpay webhook (Plumtrips Travel payments).
  // Must be mounted BEFORE express.json() so it receives the raw body.
  app.use("/api/webhooks", express.raw({ type: "application/json" }), razorpayWebhookRouter);
}

// WhatsApp Cloud API webhook (Expense Management inbound capture).
// MUST be before express.json() so POST /webhook receives the raw body for
// X-Hub-Signature-256 verification. Also mounted before the rate limiter so the
// 5s Meta ack window is never throttled.
import whatsappWebhookRouter from "./routes/whatsapp.webhook.js";
app.use("/api/whatsapp", express.raw({ type: "application/json" }), whatsappWebhookRouter);

// Travel-intake webhook (public "PlumTrips International Travel Information
// Form" → Apps Script → here). HMAC-signed, unauthenticated, creates
// HOUSE-tenant ManualBooking rows. MUST be before express.json() for the raw
// body HMAC check, same shape as the Razorpay webhook above.
import travelIntakeRouter from "./routes/intake.travel.js";
import publicTravelRequestRouter from "./routes/public.travelRequest.js";
import publicSupportContactRouter from "./routes/publicSupportContact.js";
if (env.DEPLOYMENT_MODE === "plumbox") {
  // KEEP_IN_PLUMBOX — manual bookings (and this intake feed) are Plumtrips Travel only.
  app.use("/api/intake", express.raw({ type: "application/json" }), travelIntakeRouter);
}

// JSON parser
app.use(
  express.json({
    limit: "10mb",
    strict: false,
    type: ["application/json", "application/*+json", "text/json", "text/plain"],
    verify: (req: any, _res, buf) => {
      if (buf && buf.length > 0) {
        try {
          req.rawBody = buf.toString("utf8");
        } catch {
          req.rawBody = buf.toString();
        }
      }
    },
  })
);

// URL-encoded
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Cookies
app.use(cookieParser());

// Compression AFTER parsers
app.use(compression());

// Rate limiting — after CORS, before routes
app.use("/api", apiLimiter);
app.use("/api/auth", authLimiter);
app.use("/api/sbt/flights/search", flightSearchLimiter);
app.use("/api/sbt/hotels/search", hotelSearchLimiter);
app.use("/api/copilot", copilotLimiter);

/* ────────────────────────────────────────────────────────────────
 * WORKSPACE SCOPING — runs after per-route requireAuth sets req.user.
 * Skips when req.user is absent (public/webhook routes).
 * Exempts: /api/auth, /api/health, /api/_probe, /api/webhooks
 * ──────────────────────────────────────────────────────────────── */
const WORKSPACE_EXEMPT = new Set(["/api/auth", "/api/health", "/api/_probe", "/api/webhooks", "/api/whatsapp", "/api/stubs", "/api/intake", "/api/public"]);
app.use("/api", (req: any, res, next) => {
  // Skip public routes
  const basePath = "/api" + (req.path.split("/").slice(0, 2).join("/") || "");
  if (WORKSPACE_EXEMPT.has(basePath) || !req.user) return next();
  return requireWorkspace(req, res, next);
});

// SaaS HRMS tenant route gate — blocks Travel routes for SAAS_HRMS workspaces
app.use("/api", blockTravelForSaas);

// Strip trailing slashes from all API routes
app.use((req, res, next) => {
  if (req.path !== '/' && req.path.endsWith('/')) {
    const query = req.url.slice(req.path.length);
    const safepath = req.path.slice(0, -1).replace(/\/+/g, '/');
    res.redirect(301, safepath + query);
    return;
  }
  next();
});

/**
 * No-store for fresh workflow data
 */
function noStore(_req: any, res: any, next: any) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
}

// approvals + proposals + booking history + refresh should never be cached
app.use("/api/approvals", noStore);
app.use("/api/proposals", noStore);
app.use("/api/booking-history", noStore);
app.use("/api/auth/refresh", noStore);
if (env.DEPLOYMENT_MODE === "plumbox") {
  // SHARED_API — Vouchers (will be exposed via tenant API in Phase 4)
  app.use("/api/vouchers", requireAuth, requireWorkspace, requireFeature("vouchersEnabled"), vouchers);
}

// Native public travel-request form — unauthenticated, browser-facing.
// KEEP_IN_PLUMBOX — manual bookings (and this intake path) are Plumtrips
// Travel only, same convention as /api/intake above. Own per-route rate
// limiter is applied inside public.travelRequest.ts itself.
if (env.DEPLOYMENT_MODE === "plumbox") {
  app.use("/api/public", publicTravelRequestRouter);
}

// Support-contact lookup — unauthenticated, used by useSupportEmail() across
// customer/vendor/pre-auth surfaces. Not gated to plumbox: works in every
// deployment mode, falling back to the CompanySettings schema default.
app.use("/api/public", publicSupportContactRouter);

/* ────────────────────────────────────────────────────────────────
 * STATIC UPLOADS
 * ──────────────────────────────────────────────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(process.cwd(), "uploads");

const disableLocalUploads =
  String(process.env.DISABLE_LOCAL_UPLOADS || "").toLowerCase() === "true";

if (!disableLocalUploads) {
  app.use("/uploads", express.static(uploadsDir));
  if (process.env.NODE_ENV !== "production") {
    logger.info("Serving /uploads from", { path: uploadsDir });
  }
} else {
  if (process.env.NODE_ENV !== "production") {
    logger.info("Local /uploads serving is DISABLED (S3-only mode)");
  }
}

/* ────────────────────────────────────────────────────────────────
 * HEALTH / PROBE
 * ──────────────────────────────────────────────────────────────── */
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || "development",
    uptime: process.uptime(),
    time: new Date().toISOString(),
  });
});

app.get("/api/_probe", (_req, res) => {
  res.status(200).send("ok");
});

// TEMPORARY DEBUG ROUTE — REMOVE AFTER TBO IP VERIFICATION (created May 2026)
app.get("/api/debug/myip", async (_req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const upstream = await fetch("https://api.ipify.org?format=json", {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const data = await upstream.json();
    console.log("[DEBUG_MYIP]", data);
    return res.status(200).json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log("[DEBUG_MYIP] error", message);
    return res.status(502).json({ ok: false, error: message });
  } finally {
    clearTimeout(timeout);
  }
});

/* ────────────────────────────────────────────────────────────────
 * SAFE MOUNT (optional)
 * ──────────────────────────────────────────────────────────────── */
async function safeMount(prefix: string, modulePath: string) {
  try {
    const mod = await import((modulePath as unknown) as string);
    const router = (mod as any).default || mod;
    if (router) {
      app.use(prefix, router);
      logger.info("Mounted route", { prefix, modulePath });
    }
  } catch {
    if (process.env.NODE_ENV !== "production") {
      logger.info("Skipped mount (missing/failed)", { prefix, modulePath });
    }
  }
}

/* ────────────────────────────────────────────────────────────────
 * API ROUTES
 * ──────────────────────────────────────────────────────────────── */

if (env.DEPLOYMENT_MODE === "plumbox") {
  // SHARED_API — Google Places (Hotels) (will be exposed via tenant API in Phase 4)
  app.use("/api/places", placesRouter);

  // KEEP_IN_PLUMBOX — Proposals (Plumtrips Travel workflow)
  app.use("/api/proposals", proposalsRouter);
}

// Auth & users (signup/invite-accept are public routes on the same prefix)
import signupRouter from "./routes/auth.signup.js";
app.use("/api/auth", signupRouter);
app.use("/api/auth", auth);

// Self-service signup (fully public — no requireAuth)
import selfServiceSignupRouter from "./routes/signup.js";
app.use("/api/signup", selfServiceSignupRouter);

// SaaS HRMS self-service signup (fully public — no requireAuth)
import saasSignupRouter from "./routes/saas.signup.js";
app.use("/api/saas", saasSignupRouter);

// SaaS HRMS setup-progress API (authenticated)
import saasSetupRouter from "./routes/saas.setup.js";
app.use("/api/saas", saasSetupRouter);

app.use("/api/users", users);

// HRMS
app.use("/api/employees", employeesRouter);
app.use("/api/stats", stats);
app.use("/api/logs", logs);
app.use("/api/attendance", attendance);
app.use("/api/leaves", leaves);
app.use("/api/holidays", holidays);

// Uploads
app.use("/api/uploads", uploads);

// Documents (employee document vault)
import documentsRouter from "./routes/documents.js";
app.use("/api/documents", documentsRouter);

// Onboarding & master
app.use("/api/onboarding", (onboarding as any).default || onboarding);
app.use("/api/master-data", masterDataRouter);

// Department & Designation master lists
import masterDataDeptRouter from "./routes/masterData.departments.js";
app.use("/api/master-data", masterDataDeptRouter);

app.use("/api/password", passwordRoutes);

// Vendor & business
if (env.DEPLOYMENT_MODE === "plumbox") {
  // KEEP_IN_PLUMBOX — Vendor / Business / Customer master + self endpoints (Plumtrips Travel)
  app.use("/api/vendor-services", vendorServicesRouter);
  app.use("/api/business-services", businessServicesRouter);
  app.use("/api/vendors", vendorsRouter);
  app.use("/api/customers", customersRouter);
  app.use("/api/admin/direct-customers", directCustomersRouter);
  app.use("/api/customer/users", customerUsersRouter);
  app.use("/api", vendorCustomerSelfRouter);
}

// Workspace
app.use("/api/v1/workspace", workspaceRouter);

// Expense Bands
import expenseBandsRouter from "./routes/expenseBands.js";
app.use("/api/v1/workspace", expenseBandsRouter);

// Expense Management — read API + export (Sprint 3a). Tenant-scoped; role-gated
// in-handler (Finance/Admin see all workspace expenses, others see own).
import expensesRouter from "./routes/expenses.js";
app.use("/api/expenses", requireAuth, requireWorkspace, requireFeature("expensesEnabled"), expensesRouter);

// Expense categories (Layer 1) — tenant-scoped managed category list.
import expenseCategoriesRouter from "./routes/expenseCategories.js";
app.use("/api/expense-categories", requireAuth, requireWorkspace, requireFeature("expensesEnabled"), expenseCategoriesRouter);

// Expense reports (Layer 2) — tenant-scoped; owner-only mutations, admin-all reads.
import expenseReportsRouter from "./routes/expenseReports.js";
app.use("/api/reports", requireAuth, requireWorkspace, requireFeature("expensesEnabled"), expenseReportsRouter);

// Expense administration — the assignment surface (capabilities + manager).
// Tenant-scoped; expense-Admin-gated in-router (isAdmin from expense.access).
import expenseAdminRouter from "./routes/expenseAdmin.js";
app.use("/api/expense-admin", requireAuth, requireWorkspace, requireFeature("expensesEnabled"), expenseAdminRouter);

// Expense advances (System B) — cash advances, a peer of claims. Gated behind
// BOTH expensesEnabled AND advancesEnabled (requireExpenseAdvancesFeature runs
// the expenses check first, then the advances opt-in).
import expenseAdvancesRouter from "./routes/expenseAdvances.js";
import { requireExpenseAdvancesFeature } from "./middleware/requireFeature.js";
app.use("/api/expense-advances", requireAuth, requireWorkspace, requireExpenseAdvancesFeature, expenseAdvancesRouter);

// Reports hub (Activity Logs report) — fused claim+advance audit stream on the
// shared report contract. Tenant-scoped; seesAll (finance/admin) gated in-router.
import expenseActivityRouter from "./routes/expenseActivity.js";
app.use("/api/expense-activity", requireAuth, requireWorkspace, requireFeature("expensesEnabled"), expenseActivityRouter);

// Workspace provisioning (onboarding, invites)
import onboardingRouter from "./routes/workspace.onboarding.js";
import inviteRouter from "./routes/workspace.invites.js";
import workspaceBrandingRouter from "./routes/workspace.branding.js";
import travellerProfilesRouter from "./routes/workspace.travellers.js";
app.use("/api/workspace/onboarding", onboardingRouter);
app.use("/api/workspace/invites", inviteRouter);
app.use("/api/workspace/branding", workspaceBrandingRouter);
app.use("/api/workspace/travellers", travellerProfilesRouter);

// SUPERADMIN provisioning
import { requireSuperAdmin } from "./middleware/requireSuperAdmin.js";
import superadminWorkspacesRouter from "./routes/superadmin.workspaces.js";
app.use("/api/superadmin", requireAuth, requireSuperAdmin, superadminWorkspacesRouter);

// Copilot & Pluto
if (env.DEPLOYMENT_MODE === "plumbox") {
  // KEEP_IN_PLUMBOX — Travel copilot (Plumtrips Travel ops)
  app.use("/api/v1/copilot/travel", requireAuth, requireWorkspace, requireFeature("sbtEnabled"), travelCopilotRoutes);

  // Pluto AI provider boot check (loud warning if a tier's key is missing;
  // optional Gemini ping behind PLUTO_BOOT_PING). Fire-and-forget — never
  // crashes boot for a missing fallback.
  void runPlutoBootCheck({
    pingGemini: (p) => invokePlutoGemini(p),
  });
}
app.use("/api/v1/pluto/video", plutoVideoRouter);
app.use("/api/copilot", copilotRouter);
app.use("/api/v1/copilot/manager", copilotRouter);
app.use("/api/assistant", assistantRouter);
app.use("/api/assistant", assistantHrRouter);
app.use("/api/v1/copilot/video", copilotVideoConsent);
app.use("/api/v1/admin", adminVideoRouter);

// Flights
if (env.DEPLOYMENT_MODE === "plumbox") {
  // KEEP_IN_PLUMBOX — Legacy flight routes (Plumtrips Travel)
  app.use("/api/v1/flights", flightRoutes);
}

// SBT (Self-Booking Tool) — TBO integration
import sbtFlightsRouter from "./routes/sbt.flights.js";
import sbtHotelsRouter from "./routes/sbt.hotels.js";
import sbtRequestsRouter from "./routes/sbt.requests.js";
import sbtWalletRouter from "./routes/sbt.wallet.js";
import sbtConfigRouter from "./routes/sbt.config.js";
import sbtCityImageRouter from "./routes/sbt.cityImage.js";
import travelFormRouter from "./routes/travelForm.js";
// Customer-facing READ-ONLY booking history (TravelBooking mirror, no feature gate)
import myBookingsRouter from "./routes/myBookings.js";

if (env.DEPLOYMENT_MODE === "plumbox") {
  // SHARED_API — SBT (Self-Booking Tool) routes (will be exposed via tenant API in Phase 4)
  app.use("/api/sbt/flights", sbtFlightsRouter);
  app.use("/api/sbt/hotels", sbtHotelsRouter);
  app.use("/api/sbt/requests", sbtRequestsRouter);
  app.use("/api/sbt/wallet", sbtWalletRouter);
  app.use("/api/sbt/config", sbtConfigRouter);
  app.use("/api/sbt/city-image", sbtCityImageRouter);
  app.use("/api/travel-forms", requireAuth, requireWorkspace, requireFeature("travelFormEnabled"), travelFormRouter);
  // Read-only booking history for any authenticated workspace member — NO requireFeature
  app.use("/api/my-bookings", requireAuth, requireWorkspace, myBookingsRouter);
}

// SBT Admin (offer config)
import adminSBTRouter from "./routes/admin.sbt.js";
// Admin Billing Console
import adminBillingRouter from "./routes/admin.billing.js";
// Unified Billing (TravelBooking — all services)
import unifiedBillingRoutes from "./routes/admin.unified.billing.js";

if (env.DEPLOYMENT_MODE === "plumbox") {
  // KEEP_IN_PLUMBOX — Travel admin (SBT config, billing console, unified billing)
  app.use("/api/admin/sbt", requireAuth, requireWorkspace, requireFeature("sbtEnabled"), adminSBTRouter);
  app.use("/api/admin/billing", requireAuth, requireWorkspace, requireFeature("sbtEnabled"), adminBillingRouter);
  // NO requireFeature — same reasoning as /api/my-bookings. These are READ-ONLY
  // travel-spend aggregations over the cost-free TravelBooking mirror, and the
  // router enforces per-caller scope itself (resolveAccessScope: GLOBAL for
  // admins, ORG by tenantId for customer leaders/approvers, OWN otherwise). A
  // capability flag (sbtEnabled) must not gate a customer from reading their own
  // org's booking history, so SBT-off customers (e.g. manual-only) can load it.
  app.use("/api/admin/unified", requireAuth, requireWorkspace, unifiedBillingRoutes);
}

// Dashboards
app.use("/api/dashboard", dashboardRouter);

// HR
app.use("/api/hr/policies", hrPoliciesRouter);
app.use("/api/hr", hrOrgChartRouter);

// Admin — Demo Platform (impersonation endpoints, audit log) — mounted before
// broad /api/admin routers so that adminAnalyticsRouter's router.use(requireAdmin)
// does not intercept these paths before admin.demo's own demoAccess-based gate.
import adminDemoRouter from "./routes/admin.demo.js";
app.use("/api/admin/demo", adminDemoRouter);

// Manual Bookings — mounted before broad /api/admin routers so that
// adminAnalyticsRouter's router.use(requireAdmin) does not intercept
// these paths before manualBookingsRouter (which uses billing-access
// instead of requireAdmin to allow RM-scoped access).
import manualBookingsRouter from "./routes/manualBookings.js";

if (env.DEPLOYMENT_MODE === "plumbox") {
  // KEEP_IN_PLUMBOX — Manual bookings + broad /api/admin routers (Plumtrips Travel).
  // Order matters: manualBookings must precede adminRouter/adminAnalyticsRouter
  // so the broad mounts do not intercept the manual-bookings paths.
  app.use("/api/admin/manual-bookings", requireAuth, requireWorkspace, requireFeature("sbtEnabled"), manualBookingsRouter);
  // Admin
  app.use("/api/admin", adminRouter);
  app.use("/api/admin", adminAnalyticsRouter);
}
app.use("/api/admin", users);

// Admin — Data export (DPDP Act 2023 compliance)
import adminDataExportRouter from "./routes/admin.dataExport.js";
app.use("/api/admin", adminDataExportRouter);

// Admin — SBT Booking Register (Super-Admin + @plumtrips.com only; exposes
// cross-company supplier cost/margin — guards live inside the router).
import sbtBookingRegisterRouter from "./routes/sbt.bookingRegister.js";
app.use("/api/admin/sbt/booking-register", sbtBookingRegisterRouter);

// Admin — Payment orphans (Razorpay webhook mismatches)
import adminPaymentOrphansRouter from "./routes/admin.paymentOrphans.js";
if (env.DEPLOYMENT_MODE === "plumbox") {
  // KEEP_IN_PLUMBOX — Razorpay payment-orphans console (Plumtrips Travel)
  app.use("/api/admin/payment-orphans", adminPaymentOrphansRouter);
}

// Admin — Session logs (Winston logging + session tracking)
import adminSessionsRouter from "./routes/admin.sessions.js";
app.use("/api/admin/sessions", adminSessionsRouter);

// Ticketing — manual ingest trigger (SUPERADMIN only)
import ticketsAdminRouter from "./routes/tickets.admin.js";
// Ticketing — agent console (list, detail, reply, status, assign, tags)
import ticketsConsoleRouter from "./routes/tickets.console.js";
// Email templates (workspace-scoped, supportTickets permission)
import emailTemplatesRouter from "./routes/emailTemplates.js";
// Invoices, Reports, Company Settings (admin-only via router-level requireAdmin)
import invoicesRouter, { workspaceRouter as invoicesWorkspaceRouter } from "./routes/invoices.js";
import creditNotesAdminRouter, { workspaceRouter as creditNotesWorkspaceRouter } from "./routes/creditNotes.js";
import reportsRouter from "./routes/reports.js";
import companySettingsRouter from "./routes/companySettings.js";
// Billing Permissions (Super Admin grant/revoke + my-access for all users)
import billingPermissionsRouter from "./routes/billingPermissions.js";

if (env.DEPLOYMENT_MODE === "plumbox") {
  // KEEP_IN_PLUMBOX — Travel-specific admin features:
  //   ticketing, email templates, invoices, reports, company settings,
  //   billing permissions (all Plumtrips Travel admin surfaces).
  app.use("/api/admin/tickets", requireAuth, requireWorkspace, requireFeature("ticketsEnabled"), ticketsAdminRouter);
  app.use("/api/admin/tickets", requireAuth, requireWorkspace, requireFeature("ticketsEnabled"), ticketsConsoleRouter);
  app.use("/api/admin/email-templates", emailTemplatesRouter);
  app.use("/api/invoices/workspace", requireAuth, requireWorkspace, requireFeature("invoicesEnabled"), invoicesWorkspaceRouter);
  app.use("/api/admin/invoices", requireAuth, requireWorkspace, requireFeature("invoicesEnabled"), invoicesRouter);
  // Credit Notes — child of the invoice surface; reuse the invoicesEnabled feature flag.
  app.use("/api/credit-notes/workspace", requireAuth, requireWorkspace, requireFeature("invoicesEnabled"), creditNotesWorkspaceRouter);
  app.use("/api/admin/credit-notes", requireAuth, requireWorkspace, requireFeature("invoicesEnabled"), creditNotesAdminRouter);
  app.use("/api/admin/reports", reportsRouter);
  app.use("/api/admin/company-settings", companySettingsRouter);
  app.use("/api/billing-permissions", billingPermissionsRouter);
}

// Unified Permissions (UserPermission model — replaces BillingPermission long-term)
import permissionsRouter from "./routes/permissions.js";
app.use("/api/permissions", permissionsRouter);

// Approvals & booking history
if (env.DEPLOYMENT_MODE === "plumbox") {
  // SHARED_API — Approvals router (will be exposed via tenant API in Phase 4)
  app.use("/api/approvals", approvalsRouter);
  // KEEP_IN_PLUMBOX — Booking history (Plumtrips Travel-specific outcomes + admin PDFs)
  app.use("/api/approvals", bookingHistory);
  app.use("/api/booking-history", bookingHistory);
}

// Optional
void safeMount("/api/settings", "./routes/settings.js");

// Stubs
app.use("/api/stubs", stubs);

// EOD WhatsApp Report
import eodReportRouter from "./routes/eodReport.js";
if (env.DEPLOYMENT_MODE === "plumbox") {
  // KEEP_IN_PLUMBOX — EOD WhatsApp report (Plumtrips Travel ops)
  app.use("/api/eod-report", eodReportRouter);
}

// CRM Sales Pulse Report (email, multi-time IST). Auth is enforced inside the
// router (requireAuth + requireSuperAdmin).
import crmSalesPulseRouter from "./routes/crmSalesPulse.js";
if (env.DEPLOYMENT_MODE === "plumbox") {
  // KEEP_IN_PLUMBOX — Sales Pulse report (Plumtrips Travel CRM)
  app.use("/api/crm/sales-pulse", crmSalesPulseRouter);
}

// Image proxy
app.use("/api/proxy", proxyRouter);

// Remote Work Presence & Video Collaboration
app.use("/api/activity", activityRoutes);
app.use("/api/presence", requireAuth, requireWorkspace, presenceRoutes);
app.use("/api/meetings", meetingRoutes);

// Sales CRM
if (env.DEPLOYMENT_MODE === "plumbox") {
  // KEEP_IN_PLUMBOX — Sales CRM (Plumtrips Travel)
  app.use("/api/leads", requireAuth, requireWorkspace, requireFeature("crmEnabled"), leadsRouter);
  app.use("/api/crm/companies", requireAuth, requireWorkspace, requireFeature("crmEnabled"), crmCompaniesRouter);
  app.use("/api/crm/contacts", requireAuth, requireWorkspace, requireFeature("crmEnabled"), crmContactsRouter);
}

// Tasks / Reminders
import tasksRouter from "./routes/tasks.js";
// Task Automations (settings)
import taskAutomationsRouter from "./routes/admin.task-automations.js";

if (env.DEPLOYMENT_MODE === "plumbox") {
  // KEEP_IN_PLUMBOX — Tasks & task automations (Plumtrips Travel ops)
  app.use("/api/admin/tasks", tasksRouter);
  app.use("/api/admin/task-automations", taskAutomationsRouter);
}

// In-app notifications
import notificationsRouter from "./routes/notifications.js";
app.use("/api/admin/notifications", notificationsRouter);

// Plumbox internal chat (SSE + conversations + messages)
import chatRouter from "./routes/chat.js";
app.use("/api/chat", chatRouter);

// ✅ Payroll routes
import payrollSalaryRouter from "./routes/payroll.salary.js";
import payrollRunRouter from "./routes/payroll.run.js";
import payrollPayslipRouter from "./routes/payroll.payslip.js";
import payrollReimbursementsRouter from "./routes/payroll.reimbursements.js";
import payrollDeclarationRouter from "./routes/payroll.declaration.js";
import workspaceSettingsRouter from "./routes/workspace.settings.js";
app.use("/api/payroll/salary", payrollSalaryRouter);
app.use("/api/payroll/runs", payrollRunRouter);
app.use("/api/payroll/payslip", payrollPayslipRouter);
app.use("/api/payroll/reimbursements", payrollReimbursementsRouter);
app.use("/api/payroll/declaration", payrollDeclarationRouter);
app.use("/api/workspace/settings", workspaceSettingsRouter);

// Preview (flight/hotel inventory for approval flow)
if (env.DEPLOYMENT_MODE === "plumbox") {
  // SHARED_API — Preview (will be exposed via tenant API in Phase 4)
  app.use("/api/preview", previewRoutes);
}

// 404
app.use("/api", (_req, res) => {
  return res.status(404).json({ ok: false, message: "API route not found" });
});

// Error handler
app.use(errorHandler);

export default app;

/* ────────────────────────────────────────────────────────────────
 * BOOTSTRAP
 * ──────────────────────────────────────────────────────────────── */
if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
  (async () => {
    try {
      // ─────────────────────────────────────────────────────────────
      // GLOBAL PROCESS GUARDS
      // whatsapp-web.js / puppeteer can emit late EBUSY/ENOTEMPTY/ENOENT against
      // the EFS-mounted .wwebjs_auth session dir AFTER the awaited call already
      // returned — these surface as unhandledRejection/uncaughtException with no
      // catch site. Swallow ONLY that narrow class (matched on BOTH error code
      // AND a path/message referencing .wwebjs_auth) to keep the WA host alive.
      // Everything else keeps normal semantics: a real uncaughtException still
      // exits(1) so ECS restarts cleanly (a dropped Mongo connection etc. must
      // NOT be eaten).
      const isWwebjsLockError = (err: unknown): boolean => {
        const e = err as any;
        const code = e?.code;
        if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "ENOENT") return false;
        const haystack = `${e?.path ?? ""} ${e?.message ?? ""} ${e?.stack ?? ""}`;
        return haystack.includes(".wwebjs_auth");
      };

      process.on("unhandledRejection", (reason: unknown) => {
        if (isWwebjsLockError(reason)) {
          const e = reason as any;
          logger.warn("[WA] Swallowed .wwebjs_auth lock unhandledRejection — process kept alive", {
            code: e?.code,
            path: e?.path,
            message: e?.message,
          });
          return;
        }
        // Non-matching: log loudly, keep current behavior (do not force-exit on
        // unhandled rejections).
        const e = reason as any;
        logger.error("Unhandled promise rejection", {
          message: e?.message ?? String(reason),
          stack: e?.stack,
          name: e?.name,
        });
      });

      process.on("uncaughtException", (err: Error) => {
        if (isWwebjsLockError(err)) {
          const e = err as any;
          logger.warn("[WA] Swallowed .wwebjs_auth lock uncaughtException — process kept alive", {
            code: e?.code,
            path: e?.path,
            message: err?.message,
          });
          return;
        }
        // Non-matching: log loudly and exit so ECS restarts cleanly. Do NOT
        // silently continue — a corrupted process state (dropped Mongo
        // connection, etc.) must not be eaten.
        logger.error("Uncaught exception — exiting(1) for a clean ECS restart", {
          message: err?.message,
          stack: err?.stack,
          name: err?.name,
        });
        process.exit(1);
      });

      await connectDb();

      // Deterministically build the Pluto correctness-critical indexes (the
      // handoff-dedup + tenant-scope guards depend on them) before serving
      // traffic. Log-and-continue — never crashes boot.
      const { ensurePlutoIndexes } = await import("./bootstrap/ensurePlutoIndexes.js");
      await ensurePlutoIndexes().catch((e: unknown) => logger.warn("[PLUTO INDEXES] ensure failed", { e }));

      // WA_HOST=true designates the dedicated WhatsApp host — the always-on
      // Fargate service that owns the single whatsapp-web.js client
      // (clientId "plumtrips-eod"). That host runs ONLY the EOD + Sales Pulse
      // WhatsApp crons; every other cron/worker runs on the primary backend
      // instead, so they never double-fire (duplicate emails, Gmail ingestion,
      // static-data refreshes) across the two always-on hosts.
      const IS_WA_HOST = process.env.WA_HOST === "true";

      // ✅ START EOD WHATSAPP CRON (also self-gated by EOD_CRON_DISABLED)
      const { startEodCron } = await import("./jobs/eodCron.js");
      startEodCron().catch((e: unknown) => logger.error("[EOD] Cron start failed", { e }));

      // ✅ START CRM SALES PULSE CRON (no-op while config.enabled=false, the default)
      const { startSalesPulseCron } = await import("./jobs/crmSalesPulseCron.js");
      startSalesPulseCron().catch((e: unknown) => logger.error("[SalesPulse] Cron start failed", { e }));

      if (!IS_WA_HOST) {
        // 🔥 START BACKGROUND WORKERS (ADDED – SAFE)
        startBackgroundWorkers();

        // ✅ START REPORT SCHEDULER
        const { startReportScheduler } = await import("./jobs/reportScheduler.js");
        startReportScheduler();

        // PLUMBOX-005: Hold-booking voucher deadline reminders (24h + 1h)
        const { startHoldBookingReminderCron } = await import("./jobs/hold-booking-reminder.js");
        startHoldBookingReminderCron();

        // BUCKET-C-1: TBO static data refresh (15-day spec rule)
        const { startStaticDataRefreshCron, seedStaticDataIfEmpty } = await import("./jobs/static-data-refresh.js");
        startStaticDataRefreshCron();
        seedStaticDataIfEmpty().catch((e: unknown) => logger.warn("[StaticRefresh] Seed failed", { e }));

        // BUCKET-C-3: Orphaned PENDING booking cleanup (hourly)
        const { startOrphanPendingCleanupCron } = await import("./jobs/orphan-pending-cleanup.js");
        startOrphanPendingCleanupCron();

        // TICKETING: Auto-ingest Gmail → tickets (every 60s)
        const { startTicketIngestionCron } = await import("./jobs/ticketIngestionCron.js");
        startTicketIngestionCron();

        // TASKS: Email reminders (due-soon / due-now / overdue) — every 5 min
        const { startTaskReminderCron } = await import("./jobs/taskReminderCron.js");
        startTaskReminderCron();

        // TASKS: Daily digest at 10:00 AM IST
        const { startTaskDigestCron } = await import("./jobs/taskDigestCron.js");
        startTaskDigestCron();
      } else {
        logger.info("[WA-HOST] WA_HOST=true — running EOD + Sales Pulse crons only; all other crons/workers skipped on this host");
      }

      const server = app.listen(env.PORT, () => {
        logger.info("API running", { port: env.PORT });
      });

      const shutdown = async () => {
        logger.info("Gracefully shutting down server...");
        server.close(async () => {
          try {
            const mongoose = await import("mongoose");
            await mongoose.default.disconnect();
            logger.info("MongoDB disconnected on shutdown");
          } catch (e) {
            // ignore disconnect errors during shutdown
          }
          process.exit(0);
        });
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (err) {
      logger.error("Failed to start server", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
      process.exit(1);
    }
  })();
}