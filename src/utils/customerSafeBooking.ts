// Customer-safe projections for SBT booking documents.
//
// Cost/margin and supplier-payload fields MUST NEVER reach a customer:
//   flights — netAmount, marginAmount, marginPercent, baseFare, taxes, extras,
//             fareBreakdown, passengers[].fare, raw
//   hotels  — netAmount, marginAmount, marginPercent, agentCommission, tds,
//             recommendedSellingRate, isPublishedFare, raw, tboVoucherData,
//             bookingDetailRaw
//
// These projections use an explicit allowlist: anything not picked here is
// dropped, so any field added to the schema later defaults to HIDDEN on
// customer paths. totalFare / displayAmount are the customer-facing sell
// price (what the traveller is charged) — NOT supplier cost.

function reduceUser(doc: any): { userId: string; _user: { name: string; email: string } } {
  const pop = doc.userId && typeof doc.userId === "object" ? doc.userId : null;
  const userId = pop ? String(pop._id) : String(doc.userId || "");
  const name = pop
    ? pop.name || [pop.firstName, pop.lastName].filter(Boolean).join(" ") || ""
    : doc._user?.name || "";
  const email = pop ? pop.email || "" : doc._user?.email || "";
  return { userId, _user: { name, email } };
}

export function toCustomerSafeFlight(doc: any) {
  const { userId, _user } = reduceUser(doc);
  return {
    _id: doc._id,
    bookingId: doc.bookingId,
    pnr: doc.pnr,
    returnPnr: doc.returnPnr,
    ticketId: doc.ticketId,
    status: doc.status,
    paymentMode: doc.paymentMode,
    origin: doc.origin ? { code: doc.origin.code, city: doc.origin.city } : undefined,
    destination: doc.destination ? { code: doc.destination.code, city: doc.destination.city } : undefined,
    airlineCode: doc.airlineCode,
    airlineName: doc.airlineName,
    flightNumber: doc.flightNumber,
    cabin: doc.cabin,
    departureTime: doc.departureTime,
    arrivalTime: doc.arrivalTime,
    isReturn: doc.isReturn,
    isLCC: doc.isLCC,
    isRefundable: doc.isRefundable,
    // customer-facing sell price only — never netAmount/marginAmount/baseFare/taxes/extras
    totalFare: doc.totalFare,
    displayAmount: doc.displayAmount,
    currency: doc.currency,
    // traveller names only — never passengers[].fare or passport/DOB cost detail
    passengers: Array.isArray(doc.passengers)
      ? doc.passengers.map((p: any) => ({
          title: p.title,
          firstName: p.firstName,
          lastName: p.lastName,
          paxType: p.paxType,
          isLead: p.isLead,
        }))
      : [],
    contactEmail: doc.contactEmail,
    contactPhone: doc.contactPhone,
    bookedAt: doc.bookedAt,
    createdAt: doc.createdAt,
    cancelledAt: doc.cancelledAt,
    userId,
    _user,
  };
}

export function toCustomerSafeHotel(doc: any) {
  const { userId, _user } = reduceUser(doc);
  return {
    _id: doc._id,
    bookingId: doc.bookingId,
    confirmationNo: doc.confirmationNo,
    bookingRefNo: doc.bookingRefNo,
    hotelName: doc.hotelName,
    cityName: doc.cityName,
    countryCode: doc.countryCode,
    checkIn: doc.checkIn,
    checkOut: doc.checkOut,
    rooms: doc.rooms,
    roomName: doc.roomName,
    mealType: doc.mealType,
    status: doc.status,
    paymentMode: doc.paymentMode,
    isRefundable: doc.isRefundable,
    // customer-facing sell price only — never netAmount/marginAmount/agentCommission/tds/recommendedSellingRate
    totalFare: doc.totalFare,
    displayAmount: doc.displayAmount,
    currency: doc.currency,
    // guest names only
    guests: Array.isArray(doc.guests)
      ? doc.guests.map((g: any) => ({
          Title: g.Title,
          FirstName: g.FirstName,
          LastName: g.LastName,
          PaxType: g.PaxType,
          LeadPassenger: g.LeadPassenger,
        }))
      : [],
    bookedAt: doc.bookedAt,
    createdAt: doc.createdAt,
    cancelledAt: doc.cancelledAt,
    userId,
    _user,
  };
}
