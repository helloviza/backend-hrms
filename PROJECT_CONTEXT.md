# Project Context

## Session: 2026-04-01/02 — Security Audit + TBO Investigation

### Security Audit Complete (120 issues, 53 files)
- P0: /register role escalation fixed, /ticket-lcc auth added
- P1: workspace filters added to all routes (9 files)
- P2: SUPERADMIN empty results fixed, frontend guards fixed
- P3/P4: rate limiting, console.log cleanup, temp endpoints removed

### MT Migration Complete
- requireWorkspace resolves real workspace._id via DB lookup
- workspaceId in JWT for staff users
- WORKSPACE_LEADER no longer auto-added to JWT
- Customer approval flow (Flow 2) working end-to-end
- L1/L2/L0 nav access control fixed

### TBO Flight Ticketing — BLOCKED
Status: "Invalid Resource Requested" on TicketLCC
Root cause: Unknown — payload format has been tested in
multiple configurations (flat, nested, WayType variants).
All return same error. Sandbox account enabled per TBO.
Next step: Fresh session — compare full flight & hotel
code against TBO API docs field by field.

TraceId threading: Confirmed correct (Search -> FareQuote -> SSR -> Ticket)
SeatDynamic: Currently sending flat array (per official docs)
IsPriceChangeAccepted: false (correct default)

### Open Items
1. TBO flight ticketing — needs fresh investigation
2. Profile /profile/me {code,city} React render error
3. Attendance CSV lopDays bug (attendance.ts line 775)
4. Bundleojoy onboarding setup

### Git State
- origin: GitLab (gitlab.com/plumtrips/plumtrips-hrms)
- github: GitHub (github.com/helloviza/backend-hrms) — subtree of apps/backend
- Last commit: fix: TBO SeatDynamic must be flat array per official API docs

### Demo Workspace
- customerId: 69661b3ce82304bcddacd885
- workspaceId: 69679a7628330a58d29f2254
- L1: thesaatphereindia@gmail.com (CUSTOMER, REQUESTER)
- L2: salescynosurechannel@gmail.com (CUSTOMER, WORKSPACE_LEADER)
- travelFlow: APPROVAL_FLOW
