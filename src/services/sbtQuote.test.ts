// services/sbtQuote — customer-facing price shapes (pure functions, no DB).
import { describe, it, expect } from "vitest";
import {
  sellingFlight,
  sellingFlightResults,
  stripFlightBookingFares,
  applyQuoteFares,
  customerRoom,
  customerHotelResults,
  policiesWithoutAmounts,
  customerFlightBooking,
  customerHotelBooking,
} from "./sbtQuote.js";

const FARE = {
  BaseFare: 8000, Tax: 1800, PublishedFare: 9800, OfferedFare: 9500, CommissionEarned: 250, PLBEarned: 30,
  IncentiveEarned: 20, TdsOnCommission: 12.5, TdsOnPLB: 1.5, TdsOnIncentive: 1, AdditionalTxnFeeOfrd: 5, AdditionalTxnFeePub: 5,
  _netPublishedFare: 9800, _netOfferedFare: 9500, Currency: "INR",
};
const BREAKDOWN = [
  { PassengerType: 1, BaseFare: 6000, Tax: 1200 },
  { PassengerType: 2, BaseFare: 2000, Tax: 600 },
];

describe("flights", () => {
  it("sellingFlight: Published = Offered = selling, margin folded into BaseFare and the breakdown", () => {
    const f = sellingFlight({ ResultIndex: "R", Fare: { ...FARE }, FareBreakdown: BREAKDOWN }, 10);
    expect(f.Fare.PublishedFare).toBe(10780);
    expect(f.Fare.OfferedFare).toBe(10780);
    expect(f.Fare.BaseFare + f.Fare.Tax).toBeCloseTo(10780, 2);
    for (const k of ["CommissionEarned", "PLBEarned", "IncentiveEarned", "TdsOnCommission", "_netOfferedFare", "AdditionalTxnFeeOfrd"]) {
      expect(f.Fare).not.toHaveProperty(k);
    }
    const fb = f.FareBreakdown as any[];
    expect(fb[0].BaseFare + fb[1].BaseFare - 8000).toBeCloseTo(980, 2);
  });

  it("no margin: still no cost field, OfferedFare is the published price", () => {
    const f = sellingFlight({ ResultIndex: "R", Fare: { ...FARE } }, 0);
    expect(f.Fare.OfferedFare).toBe(9800);
    expect(f.Fare.BaseFare).toBe(8000);
    expect(f.Fare).not.toHaveProperty("CommissionEarned");
  });

  it("sellingFlightResults finds results at any depth (round trip, single, multi-city legs)", () => {
    const out = sellingFlightResults({ Response: { Results: [[{ ResultIndex: "A", Fare: { ...FARE } }], [{ ResultIndex: "B", Fare: { ...FARE } }]] } }, 10);
    expect(JSON.stringify(out)).not.toMatch(/Commission|_net|Tds/);
    expect(out.Response.Results[1][0].Fare.OfferedFare).toBe(10780);
  });

  it("stripFlightBookingFares drops every Fare / FareBreakdown node and cost key, keeps ids", () => {
    const out = stripFlightBookingFares({ Response: { Response: { PNR: "P", BookingId: 1, FlightItinerary: { Fare: FARE, Passenger: [{ Fare: FARE, Ticket: { TicketId: 9 } }] } } } });
    expect(JSON.stringify(out)).not.toMatch(/Fare|Commission/);
    expect(out.Response.Response.FlightItinerary.Passenger[0].Ticket.TicketId).toBe(9);
  });

  it("applyQuoteFares: per pax type from the quote; the client's Fare is discarded", () => {
    const quote = { netFare: FARE, netFareBreakdown: BREAKDOWN };
    const out: any[] = applyQuoteFares([{ PaxType: 1, Fare: { OfferedFare: 1 } }, { PaxType: 2 }, { PaxType: 3 }] as any[], quote);
    expect(out[0].Fare.BaseFare).toBe(6000);
    expect(out[0].Fare.OfferedFare).toBe(9500);
    expect(out[0].Fare.CommissionEarned).toBe(250);
    expect(out[1].Fare.BaseFare).toBe(2000);
    expect(out[2].Fare.BaseFare).toBe(6000); // no infant row → the adult's, as the browser did
  });
});

describe("hotels", () => {
  const ROOM = {
    Name: ["Deluxe"], BookingCode: "BC", TotalFare: 10000, NetAmount: 10000, TotalTax: 1000, RecommendedSellingRate: 12000,
    recommendedSellingRate: 12000, DayRates: [[{ BasePrice: 1 }, { BasePrice: 1 }, { BasePrice: 1 }]],
    PriceBreakUp: [{ AgentCommission: 400 }], _displayTotalFare: 11000, MealType: "BB", SomethingNew: "x",
    CancelPolicies: [{ FromDate: "d1", ChargeType: "Percentage", CancellationCharge: 100 }],
  };

  it("customerRoom is an allow-list: unknown and cost fields never pass", () => {
    const r = customerRoom({ ...ROOM }, 10);
    expect(r._displayTotalFare).toBe(12000); // the RSP floor beats net + 10%
    expect(r._displayPerNight).toBeCloseTo((12000 - 1000) / 3, 2);
    for (const k of ["TotalFare", "NetAmount", "RecommendedSellingRate", "recommendedSellingRate", "DayRates", "PriceBreakUp", "SomethingNew"]) {
      expect(r).not.toHaveProperty(k);
    }
    expect(r.CancelPolicies[0]).toEqual({ FromDate: "d1", ChargeType: "Percentage", CancellationCharge: 100 });
  });

  it("policiesWithoutAmounts turns a fixed charge into the share of the room it is", () => {
    expect(policiesWithoutAmounts([{ FromDate: "a", ChargeType: 1, CancellationCharge: 2500 }], 10000))
      .toEqual([{ FromDate: "a", ChargeType: "Percentage", CancellationCharge: 25 }]);
    expect(policiesWithoutAmounts([{ FromDate: "a", ChargeType: "Fixed", CancellationCharge: 0 }], 10000)[0].CancellationCharge).toBe(0);
  });

  it("customerHotelResults (search / concierge hotel search shape): hotel-level net gone too", () => {
    const out = customerHotelResults([{ HotelCode: "H", TotalFare: 9000, MinimumRate: 9000, Rooms: [{ ...ROOM }] }], 10);
    expect(JSON.stringify(out)).not.toMatch(/"TotalFare"|NetAmount|RecommendedSellingRate|recommendedSellingRate|DayRates|AgentCommission|MinimumRate/);
    expect(out[0].Rooms[0]._displayTotalFare).toBe(12000);
  });
});

describe("booking documents", () => {
  it("flight: no net, margin, fare breakdown or TBO fare; base + taxes + extras = total", () => {
    const at = new Date("2026-11-01T00:00:00Z");
    const d = customerFlightBooking({
      totalFare: 10780, baseFare: 8000, taxes: 1800, extras: 0, netAmount: 9500, marginAmount: 1280, marginPercent: 13.47,
      fareBreakdown: { baseFare: 8000 }, passengers: [{ firstName: "A", fare: { base: 1 } }], bookedAt: at,
      raw: { Response: { FlightItinerary: { Fare: FARE, MiniFareRules: [[{ Type: "Reissue" }]] } } },
    });
    expect(d.baseFare + d.taxes).toBe(10780);
    expect(JSON.stringify(d)).not.toMatch(/netAmount|marginAmount|marginPercent|fareBreakdown|"Fare"|Commission/);
    expect(d.passengers[0]).toEqual({ firstName: "A" });
    expect(d.bookedAt).toBe(at); // dates pass through untouched
    expect(d.raw.Response.FlightItinerary.MiniFareRules[0][0].Type).toBe("Reissue");
  });

  it("hotel: no net / commission / TDS / RSP; supplier payloads stripped; policies amount-free", () => {
    const d = customerHotelBooking({
      totalFare: 11000, netAmount: 10000, agentCommission: 300, tds: 6, recommendedSellingRate: 10500, isPublishedFare: true,
      cancelPolicies: [{ FromDate: "a", ChargeType: "Fixed", CancellationCharge: 5000 }],
      bookingDetailRaw: { HotelPolicyDetail: "No pets", TotalFare: 10000, NetAmount: 10000 },
      tboVoucherData: { GenerateVoucherResult: { HotelDetails: { TotalFare: 10000 } } },
    });
    expect(d.totalFare).toBe(11000);
    expect(JSON.stringify(d)).not.toMatch(/netAmount|NetAmount|agentCommission|"tds"|recommendedSellingRate|isPublishedFare|TotalFare/);
    expect(d.bookingDetailRaw.HotelPolicyDetail).toBe("No pets");
    expect(d.cancelPolicies[0].CancellationCharge).toBe(50);
  });
});
