# Backend Architecture

## Stack
- **Runtime:** Node.js + TypeScript (ESM, `"type": "module"`)
- **Framework:** Express.js
- **Database:** MongoDB Atlas via Mongoose
- **Auth:** JWT (Bearer access token + HttpOnly refresh cookie)
- **Storage:** AWS S3 (presigned URLs for upload/download)
- **AI:** Google Gemini (Pluto concierge system)
- **Email:** Nodemailer (SES in prod)
- **PDF:** PDFKit (ticket/voucher generation)
- **External APIs:** TBO (flights + hotels), Razorpay (payments)

## Directory Structure (`apps/backend/src/`)
```
config/          — env, db (Mongoose), CORS, Helmet, AWS SDK
middleware/      — authenticate, requireRoles, requireWorkspace, rateLimit, audit, error
models/          — Mongoose schemas (User, Employee, Vendor, Customer, Workspace, etc.)
routes/          — one file per domain (auth, leaves, attendance, employees, vendors, etc.)
services/        — TBO flight/hotel services, auth service
utils/           — JWT, S3, mailer, PDF, Pluto AI utilities
emails/          — HTML email templates
scripts/         — DB admin scripts (list-users, set-password, fix-roles, etc.)
workers/         — background processing (video analysis)
```

## Auth & RBAC
- Login returns access token (JWT Bearer, 30min TTL) + refresh token (HttpOnly cookie)
- `authenticate` middleware verifies Bearer header
- `requireRoles(...roles)` enforces RBAC; SUPERADMIN always bypasses
- `requireWorkspace` resolves workspace._id from JWT workspaceId via DB lookup

### Role System
Internal roles (stored uppercase in User.roles[]): EMPLOYEE, MANAGER, HR, ADMIN, SUPERADMIN
External roles: VENDOR, CUSTOMER (+ BUSINESS, CLIENT — normalized to Customer)
Workspace roles: REQUESTER, WORKSPACE_LEADER (stored in workspace membership)

## Multi-Tenant (MT) Design
- Staff users: workspaceId embedded in JWT, resolved by requireWorkspace
- Customer users: workspace resolved from customer record
- All route queries scoped to workspace._id (enforced by middleware)
- SUPERADMIN bypasses workspace filter for cross-tenant access

## TBO Integration
- **Flights:** `services/tbo.flight.service.ts` — Search, FareQuote, SSR, Book, TicketLCC
- **Hotels:** `services/tbo.hotel.service.ts` — Search, HotelInfo, GetRoom, PreBook, Book
- **Auth:** `services/tbo.auth.service.ts` — token cached per IST day, ErrorCode 6 = expired → auto-retry
- **Timeout:** 300s for Book/Ticket operations
- **SeatDynamic:** Flat array of seat objects in ticket request (not nested SSR format)
- **MealDynamic:** All meals from SSR included (including NoMeal Price:0)

## Pluto AI System
Multi-utility AI concierge using Google Gemini:
- `plutoInvoke` — core invocation
- `plutoMemory` — conversation memory
- `plutoStateResolver` — state management
- `plutoIntentClassifier` — intent detection
- `plutoHandoffBuilder` — handoff orchestration
- `plutoMetrics` — usage tracking

## Deployment
- **Infra:** AWS App Runner (backend), CloudFront + S3 (frontend)
- **CI/CD:** GitLab CI (monorepo), GitHub subtree push for backend
- **WAF:** AWS WAF with 10 rules (SQLi, XSS, rate limiting, bot control, etc.)
