# Backend Changelog

## [2026-03-27]

### Sprint T — Security Hardening + Employee Profile Fixes

#### Security
- AWS WAF: 10 backend rules (Common, SQLi, Bad Inputs, Known Bad Inputs, IP Reputation, Anonymous IP, Admin Protection override for /api/admin/*, rate limit 2000/5min, Bot Control, BodySizeRestriction Count mode)
- CORS hardened: no-origin request fix, preflight fix
- S3 CORS: added plumbox.plumtrips.com to AllowedOrigins (avatar upload fix)
- Helmet CSP, HSTS, frameguard configured

#### Grant HRMS Access
- Credentials email sent in all 3 paths (A: existing user, B: new user, C: onboarding approval)
- Email includes Employee ID, login URL, officialEmail
- isActive: true added to activation object
- activatedByAdmin fixed for 4 existing users (DB migration)

#### Employee Profile (PUT /employees/:id)
- Employee _id → ownerId → User lookup (was using Employee _id directly as User _id)
- Object.assign: strip dangerous fields before applying to User document (_id, passwordHash, refreshToken, roles, ownerId, onboardingId, onboardingSnapshot)
- Prefixed unused destructured vars with _ for linter compliance

#### Session
- Access token TTL extended from 15 minutes → 30 minutes

## [2026-03-21]

### Sprint R — Hotel Certification + Browser Testing + UI Polish

#### TBO Hotel Certification (All 8 Cases Complete)
- Cases 1-4 Domestic: hotel 1241475, BookingIds 2096480-2096483
- Cases 5-8 International: BookingIds 2096484-2096487
- PAN rule: same PAN on ALL passengers when PanMandatory=true
- NetAmount path: HotelResult[0].Rooms[0].NetAmount
- Scripts: test-hotel-domestic.ts, test-hotel-intl.ts
- Consolidator: consolidateHotelCertificationLogs() added

#### Backend Fixes
- GenerateVoucher: URL fixed to hotelbe.tektravels.com, Basic auth, RequestedBookingMode:5
- Book route: multi-room HotelRoomsDetails, Age fix, ClientReferenceId, RequestedBookingMode:5
- TBO static API URLs: http → https (critical perf fix)
- Phone field: Phoneno → Phone in guest mapper

#### Frontend Hotel Redesign
- Search: MMT-style bar, custom DateRangePicker (two-month), blur-up images, sessionStorage cache, skeleton loading, 5 sort options, meal type filter, intl city autocomplete
- Detail: HTML description, room thumbnails, meal pills
- Guests: two-column sticky layout
- Review: two-column, sticky PAY NOW panel, redundant price breakdown removed
- Confirmed: hotel image, cancellation fix
- Forms: type="button" fix on all non-submit buttons

## [2026-03-20]

### Hotel Certification — All 8 Cases Complete
- Cases 1–8 all confirmed via test scripts
- Domestic Cases 1–4: hotel code 1241475, Delhi sandbox
- International Cases 5–8: hotel codes 1000171/1000538/1000089
- Key fixes applied during cert run:
  - NetAmount: extracted from HotelResult[0].Rooms[0].NetAmount
  - ValidationInfo: read from top-level prebookData.ValidationInfo
  - PAN: sent on every passenger when PanMandatory=true
  - Multi-room: HotelRoomsDetails array with one entry per room
  - RequestedBookingMode: 5 added to all Book payloads
- New scripts: test-hotel-domestic.ts, test-hotel-intl.ts
- New service function: consolidateHotelCertificationLogs()
- Bug fixes: GenerateVoucher URL+auth, Book route multi-room,
  children Age field, ClientReferenceId added
