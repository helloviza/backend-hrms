// apps/backend/src/server.ts
import express from "express";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import compression from "compression";
import path from "path";

import { connectDb } from "./config/db.js";
import { corsMiddleware } from "./config/cors.js";
import { helmetMiddleware } from "./config/helmet.js";
import { errorHandler } from "./middleware/error.js";
import { env } from "./config/env.js";

// ─────────────── CORE ROUTES ───────────────
import auth from "./routes/auth.js";
import attendance from "./routes/attendance.js";
import leaves from "./routes/leaves.js";
import holidays from "./routes/holidays.js";
import uploads from "./routes/uploads.js";
import * as onboarding from "./routes/onboarding.js";
import masterDataRouter from "./routes/masterData.js";
import customerUsersRouter from "./routes/customerUsers.js";

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
  }),
);

// URL-encoded
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Cookies
app.use(cookieParser());

// Compression AFTER parsers
app.use(compression());

/**
 * No-store for fresh admin data
 */
function noStore(_req: any, res: any, next: any) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
}

// approvals + booking history + refresh should never be cached
app.use("/api/approvals", noStore);
app.use("/api/booking-history", noStore);
app.use("/api/auth/refresh", noStore);

// Static uploads
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

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
      // eslint-disable-next-line no-console
      console.log(`✅ Mounted ${prefix} <- ${modulePath}`);
    }
  } catch {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.log(`ℹ️ Skipped mount ${prefix} (missing/failed): ${modulePath}`);
    }
  }
}

/* ────────────────────────────────────────────────────────────────
 * API ROUTES
 * ──────────────────────────────────────────────────────────────── */

// Auth & users
app.use("/api/auth", auth);
app.use("/api/users", users);

// HRMS employee master
app.use("/api/employees", employeesRouter);

// Core HRMS data
app.use("/api/stats", stats);
app.use("/api/logs", logs);
app.use("/api/attendance", attendance);
app.use("/api/leave", leaves);
app.use("/api/holidays", holidays);
app.use("/api/uploads", uploads);
app.use("/api/onboarding", (onboarding as any).default || onboarding);
app.use("/api/master-data", masterDataRouter);
app.use("/api/password", passwordRoutes);

// Vendor & Business service matrices
app.use("/api/vendor-services", vendorServicesRouter);
app.use("/api/business-services", businessServicesRouter);

// Vendor / Customer master + “me” endpoints
app.use("/api/vendors", vendorsRouter);
app.use("/api/customers", customersRouter);

// Customer User Management
app.use("/api/customer/users", customerUsersRouter);

// Legacy / extra self routes if still used
app.use("/api", vendorCustomerSelfRouter);

// Workspace v1
app.use("/api/v1/workspace", workspaceRouter);

// Dashboards
app.use("/api/dashboard", dashboardRouter);

// Assistants & copilot
app.use("/api/assistant", assistantRouter);
app.use("/api/assistant", assistantHrRouter);
app.use("/api/copilot", copilotRouter);

// HR policies & org chart
app.use("/api/hr/policies", hrPoliciesRouter);
app.use("/api/hr", hrOrgChartRouter);

// Admin
app.use("/api/admin", adminRouter);
app.use("/api/admin", adminAnalyticsRouter);

/**
 * ✅ Booking History MUST match frontend calls:
 * Frontend calls: /api/approvals/history
 * So we mount bookingHistory under /api/approvals.
 *
 * Also keep /api/booking-history as an alias (optional).
 */
app.use("/api/approvals", bookingHistory);
app.use("/api/booking-history", bookingHistory);

// Optional modules
void safeMount("/api/approvals", "./routes/approvals.js");
void safeMount("/api/settings", "./routes/settings.js");

/* ────────────────────────────────────────────────────────────────
 * FALLBACKS
 * ──────────────────────────────────────────────────────────────── */
app.use("/api", stubs);

/* ────────────────────────────────────────────────────────────────
 * ERROR HANDLER
 * ──────────────────────────────────────────────────────────────── */
app.use(errorHandler);

export default app;

/* ────────────────────────────────────────────────────────────────
 * BOOTSTRAP
 * ──────────────────────────────────────────────────────────────── */
if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
  (async () => {
    try {
      await connectDb();

      const server = app.listen(env.PORT, () => {
        // eslint-disable-next-line no-console
        console.log(`✅ API running on port ${env.PORT}`);
      });

      const shutdown = () => {
        // eslint-disable-next-line no-console
        console.log("🛑 Gracefully shutting down server...");
        server.close(() => process.exit(0));
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("❌ Failed to start server:", err);
      process.exit(1);
    }
  })();
}
