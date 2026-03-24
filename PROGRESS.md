# Backend Progress

## Completed

### Hotel Certification (TBO) — All 8 Cases

| Case | Label | Hotel Code | BookingId | ConfirmationNo | Status |
|------|-------|------------|-----------|----------------|--------|
| 1 | Case1_Hotel_Domestic_1R_1A | 1241475 | 2096480 | 7033719619625 | ✅ READY TO SEND |
| 2 | Case2_Hotel_Domestic_1R_2A2C | 1241475 | 2096481 | 7034576689540 | ✅ READY TO SEND |
| 3 | Case3_Hotel_Domestic_2R_1A_1A | 1241475 | 2096482 | 7822538231583 | ✅ READY TO SEND |
| 4 | Case4_Hotel_Domestic_2R_1A2C_2A | 1241475 | 2096483 | 7868267244849 | ✅ READY TO SEND |
| 5 | Case5_Hotel_Intl_1R_1A | 1000171 | 2096484 | 7701945850946 | ✅ READY TO SEND |
| 6 | Case6_Hotel_Intl_1R_2A2C | 1000171 | 2096485 | 7627790884510 | ✅ READY TO SEND |
| 7 | Case7_Hotel_Intl_2R_1A_1A | 1000171 | 2096486 | 7261573421753 | ✅ READY TO SEND |
| 8 | Case8_Hotel_Intl_2R_1A2C_2A | 1000171 | 2096487 | 7295496975088 | ✅ READY TO SEND |

### Sprint R — Hotel Certification + Browser Testing + UI Polish (2026-03-21)

**TBO Hotel Certification:**
- All 8 hotel cases certified and ready to send
- Domestic Cases 1-4: hotel code 1241475 (Delhi sandbox)
- International Cases 5-8: hotel codes 1000171/1000538/1000089
- Key findings: PAN required on every passenger, NetAmount from HotelResult[0].Rooms[0].NetAmount, same PAN (GSBPM2112A) on all passengers when PanMandatory=true
- New scripts: test-hotel-domestic.ts, test-hotel-intl.ts
- New function: consolidateHotelCertificationLogs()

**Backend Bug Fixes:**
- GenerateVoucher: wrong URL + auth fixed
- Book route: RequestedBookingMode:5 added
- Book route: multi-room HotelRoomsDetails support
- Book route: children Age field fixed
- Book route: ClientReferenceId added
- TBO static API: http:// → https:// (was timing out)

**Frontend Hotel UI (Full Redesign):**
- Search bar: MMT-style single-row, custom DateRangePicker, trending cities, autocomplete with intl cities
- Hotel cards: 240px image, blur-up loading, sessionStorage cache, skeleton loading
- Detail page: image gallery, room thumbnails, meal filter, HTML description rendering
- Guests page: two-column MMT layout, sticky booking summary, PAN collection flow
- Review page: two-column, sticky Price Breakup + PAY NOW
- Confirmed page: hotel image, correct cancellation display
- Cancellation charges: corrupted amounts fixed
- Sort options: 5 sort modes including High→Low
- Form submit bug: type="button" added to all non-submit buttons in hotel and flight search forms

## Pending

- [ ] Case 6: LCC Special Return — awaiting TBO confirmation
- [ ] Browser testing: JT=5 Special Return, PriceRBD, NDC
- [ ] Remove ~200 console.log calls from non-priority files
- [ ] Payroll Engine (on hold)
- [ ] Multi-tenant Phase A (295 unscoped queries)
- [ ] Ticket PDF: IB leg on page 2
- [ ] Send TBO hotel cert logs to TBO (Cases 1-8 zipped)
- [ ] Send TBO flight cert logs to TBO (Cases 1-5,7-12 ready)
