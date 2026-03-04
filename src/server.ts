// apps/backend/src/server.ts
import express from "express";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";

import { connectDb } from "./config/db.js";
import { corsMiddleware } from "./config/cors.js";
import { helmetMiddleware } from "./config/helmet.js";
import { errorHandler } from "./middleware/error.js";
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
import vendorCustomerSelfRouter from "./routes/vendorCustomerSelf.js";

// ✅ Workspace (customer/vendor/business logo + workspace meta)
import workspaceRouter from "./routes/workspace.js";

// ✅ Google Places (Hotels)
import placesRouter from "./routes/places.js";

// ✅ NEW WORKFLOW: proposals
import proposalsRouter from "./routes/proposals.js";

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

// Logging first
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Security headers
app.use(helmetMiddleware);

// CORS
app.use(corsMiddleware);

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
app.use("/api/vouchers", vouchers);

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
    console.log("🖼️  Serving /uploads from =", uploadsDir);
  }
} else {
  if (process.env.NODE_ENV !== "production") {
    console.log("🧼 Local /uploads serving is DISABLED (S3-only mode).");
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

/* ────────────────────────────────────────────────────────────────
 * SAFE MOUNT (optional)
 * ──────────────────────────────────────────────────────────────── */
async function safeMount(prefix: string, modulePath: string) {
  try {
    const mod = await import((modulePath as unknown) as string);
    const router = (mod as any).default || mod;
    if (router) {
      app.use(prefix, router);
      console.log(`✅ Mounted ${prefix} <- ${modulePath}`);
    }
  } catch {
    if (process.env.NODE_ENV !== "production") {
      console.log(`ℹ️ Skipped mount ${prefix} (missing/failed): ${modulePath}`);
    }
  }
}

/* ────────────────────────────────────────────────────────────────
 * API ROUTES
 * ──────────────────────────────────────────────────────────────── */

// Google Places
app.use("/api", placesRouter);

// Proposals
app.use("/api/proposals", proposalsRouter);

// Auth & users
app.use("/api/auth", auth);
app.use("/api/users", users);

// HRMS
app.use("/api/employees", employeesRouter);
app.use("/api/stats", stats);
app.use("/api/logs", logs);
app.use("/api/attendance", attendance);
app.use("/api/leave", leaves);
app.use("/api/holidays", holidays);

// Uploads
app.use("/api/uploads", uploads);

// Onboarding & master
app.use("/api/onboarding", (onboarding as any).default || onboarding);
app.use("/api/master-data", masterDataRouter);
app.use("/api/password", passwordRoutes);

// Vendor & business
app.use("/api/vendor-services", vendorServicesRouter);
app.use("/api/business-services", businessServicesRouter);
app.use("/api/vendors", vendorsRouter);
app.use("/api/customers", customersRouter);
app.use("/api/customer/users", customerUsersRouter);
app.use("/api", vendorCustomerSelfRouter);

// Workspace
app.use("/api/v1/workspace", workspaceRouter);

// Copilot & Pluto
app.use("/api/v1/copilot/travel", travelCopilotRoutes);
app.use("/api/v1/pluto/video", plutoVideoRouter);
app.use("/api/copilot", copilotRouter);
app.use("/api/assistant", assistantRouter);
app.use("/api/assistant", assistantHrRouter);
app.use("/api/v1/copilot/video", copilotVideoConsent);
app.use("/api/v1/admin", adminVideoRouter);

// Flights
app.use("/api/v1/flights", flightRoutes);

// Dashboards
app.use("/api/dashboard", dashboardRouter);

// HR
app.use("/api/hr/policies", hrPoliciesRouter);
app.use("/api/hr", hrOrgChartRouter);

// Admin
app.use("/api/admin", adminRouter);
app.use("/api/admin", adminAnalyticsRouter);

// Approvals & booking history
app.use("/api/approvals", approvalsRouter);
app.use("/api/approvals", bookingHistory);
app.use("/api/booking-history", bookingHistory);

// Optional
void safeMount("/api/settings", "./routes/settings.js");

// Stubs
app.use("/api/stubs", stubs);

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
      await connectDb();

      // 🔥 START BACKGROUND WORKERS (ADDED – SAFE)
      startBackgroundWorkers();

      const server = app.listen(env.PORT, () => {
        console.log(`✅ API running on port ${env.PORT}`);
      });

      const shutdown = () => {
        console.log("🛑 Gracefully shutting down server...");
        server.close(() => process.exit(0));
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (err) {
      console.error("❌ Failed to start server:", err);
      process.exit(1);
    }
  })();
}