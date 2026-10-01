// apps/backend/src/services/approvalSearch/selection.test.ts
//
// The price-free CONTRACT for what a requester's live-search pick stores on an
// approval request (cartItems[].meta.selection). Fed TBO-shaped fixtures that
// carry every price field TBO and our margin layer add.
//
// Fails when:
//  - any selection key would be treated as money by the approvals sanitiser
//    (isPriceKey), at any depth;
//  - any string value carries a currency figure;
//  - sanitizeApprovalForViewer would change the selection for a customer;
//  - the key set changes at all (EXPECTED_* below) — a new field must be
//    reviewed here, and a price-like one can't pass the first check anyway.
import { describe, it, expect } from "vitest";

process.env.JWT_SECRET ||= "jwt-secret-for-tests";

const { toFlightSelection, toHotelSelection, toInboundOption, toHotelSearchResult, cabinLabel, parseStars, cancelByDate } =
  await import("./selection.js");
const { isPriceKey, sanitizeApprovalForViewer } = await import("../../routes/approvals.security.js");

/* ── TBO-shaped fixtures (prices everywhere) ─────────────────────────────── */

const seg = (code: string, name: string, no: string, from: string, to: string, dep: string, arr: string, dur: number, ground = 0) => ({
  TripIndicator: 1,
  SegmentIndicator: 1,
  Airline: { AirlineCode: code, AirlineName: name, FlightNumber: no, FareClass: "R", OperatingCarrier: "" },
  Origin: { Airport: { AirportCode: from, AirportName: `${from} Intl`, Terminal: "1", CityCode: from, CityName: `${from} City`, CountryCode: "IN" }, DepTime: dep },
  Destination: { Airport: { AirportCode: to, AirportName: `${to} Intl`, Terminal: "2", CityCode: to, CityName: `${to} City`, CountryCode: "IN" }, ArrTime: arr },
  Duration: dur,
  GroundTime: ground,
  Mile: 0,
  StopOver: false,
  StopPoint: "",
  Baggage: "15 Kg",
  CabinBaggage: "7 Kg",
  CabinClass: 2,
  SupplierFareClass: "Saver",
  NoOfSeatAvailable: 4,
  FareClassification: { Type: "Saver" },
});

const priced = {
  Fare: {
    Currency: "INR", BaseFare: 4632, Tax: 800, YQTax: 300, PublishedFare: 5432, OfferedFare: 5280, TotalFare: 5432,
    CommissionEarned: 120, PLBEarned: 30, IncentiveEarned: 10, TdsOnCommission: 6, ServiceFee: 0, OtherCharges: 50,
    Discount: 0, PGCharge: 0, TaxBreakup: [{ key: "K3", value: 230 }],
  },
  FareBreakdown: [{ Currency: "INR", PassengerType: 1, PassengerCount: 1, BaseFare: 4632, Tax: 800, YQTax: 300 }],
  MiniFareRules: [[{ JourneyPoints: "BLR-BOM", Type: "Cancellation", From: "0", To: "2", Unit: "Days", Details: "INR 3,500" }]],
  _netPublishedFare: 5100,
  _netOfferedFare: 4950,
  _marginPercent: 6,
  _marginAmount: 332,
};

const oneWay = {
  ResultIndex: "OB1", IsLCC: true, IsRefundable: true, ResultFareType: "RegularFare",
  FareClassification: { Color: "#fff", Type: "Saver" }, AirlineRemark: "Fare INR 5432 incl. taxes",
  ...priced,
  Segments: [[
    seg("6E", "IndiGo", "512", "BLR", "DEL", "2026-10-12T07:00:00", "2026-10-12T09:45:00", 165),
    seg("6E", "IndiGo", "2134", "DEL", "BOM", "2026-10-12T11:00:00", "2026-10-12T13:10:00", 130, 75),
  ]],
};
const domesticBack = {
  ResultIndex: "IB4", IsLCC: false, IsRefundable: false, ...priced,
  Segments: [[seg("AI", "Air India", "640", "BOM", "BLR", "2026-10-15T18:00:00", "2026-10-15T19:50:00", 110)]],
};
const intlReturn = {
  ResultIndex: "OB7", IsLCC: false, IsRefundable: true, ...priced,
  Segments: [
    [seg("EK", "Emirates", "507", "BOM", "DXB", "2026-11-01T04:30:00", "2026-11-01T06:15:00", 225)],
    [seg("EK", "Emirates", "500", "DXB", "BOM", "2026-11-08T21:40:00", "2026-11-09T02:10:00", 180)],
  ],
};

const hotel = {
  HotelCode: "1001", HotelName: "Taj Lands End", HotelRating: "FiveStar", Address: "Bandstand, Bandra West, Mumbai",
  CityName: "Mumbai", CountryName: "", Latitude: 19.04, Longitude: 72.82, Currency: "INR",
  Rooms: [
    {
      Name: ["Luxury Room, 1 King Bed"], BookingCode: "1001!TB!1!TB!abc", Inclusion: "Free WiFi, INR 500 spa credit, Breakfast",
      MealType: "BreakFast", IsRefundable: true, WithTransfers: false,
      TotalFare: 28400, TotalTax: 3408, RecommendedSellingRate: 30000, NetAmount: 25000, MinimumRate: 14200,
      DayRates: [[{ BasePrice: 12496 }, { BasePrice: 12496 }]],
      Supplements: [[{ Index: 1, Type: "AtProperty", Description: "City tax", Price: 300, Currency: "INR" }]],
      CancelPolicies: [
        { Index: "1", FromDate: "10-10-2026 00:00:00", ChargeType: "Fixed", CancellationCharge: 0 },
        { Index: "2", FromDate: "11-10-2026 00:00:00", ChargeType: "Percentage", CancellationCharge: 50 },
        { Index: "3", FromDate: "12-10-2026 00:00:00", ChargeType: "Percentage", CancellationCharge: 100 },
      ],
      _displayTotalFare: 30100, _netAmount: 25000, _markupAmount: 5100, _marginPercent: 6, _rsp: 30000,
    },
    {
      Name: ["Deluxe Room"], MealType: "Room_Only", IsRefundable: false, TotalFare: 21000, Inclusion: "",
      CancelPolicies: [{ FromDate: "01-10-2026 00:00:00", ChargeType: "Percentage", CancellationCharge: 100 }],
    },
  ],
};

const AT = new Date("2026-10-02T10:00:00.000Z");

const flightOW = () => toFlightSelection({ out: oneWay, optionRef: "s.0", searchedAt: AT });
const flightRTDom = () =>
  toFlightSelection({ out: oneWay, back: domesticBack, optionRef: "s.0", returnOptionRef: "t.3", searchedAt: AT });
const flightRTIntl = () => toFlightSelection({ out: intlReturn, optionRef: "s.6", searchedAt: AT });
const inboundOpt = () => toInboundOption({ raw: domesticBack, optionRef: "t.3", searchedAt: AT });
const hotelResult = () =>
  toHotelSearchResult({ hotel, refFor: (j) => `h.0.${j}`, checkIn: "2026-10-12", checkOut: "2026-10-14" });
const hotelSel = (room = 0) =>
  toHotelSelection({ hotel, room: hotel.Rooms[room], optionRef: `h.0.${room}`, checkIn: "2026-10-12", checkOut: "2026-10-14", searchedAt: AT });

/* ── walkers ─────────────────────────────────────────────────────────────── */

function keyPaths(v: any, path = "$"): string[] {
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  for (const k of Object.keys(v)) {
    const p = Array.isArray(v) ? `${path}[]` : `${path}.${k}`;
    if (!Array.isArray(v)) out.push(p);
    out.push(...keyPaths(v[k], p));
  }
  return out;
}
const priceKeys = (v: any) => keyPaths(v).filter((p) => isPriceKey(p.split(".").pop()!.replace("[]", "")));
const strings = (v: any): string[] =>
  typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
const CURRENCY_FIGURE = /(₹|&#8377;|\bINR\b|\bRs\.?)\s*\d|\d[\d,]*\s*(₹|\bINR\b)/i;

const EXPECTED_FLIGHT_KEYS = [
  "$.kind", "$.optionRef", "$.returnOptionRef", "$.tripKind", "$.legs", "$.searchedAt",
  "$.legs[].direction", "$.legs[].segments", "$.legs[].stopCount", "$.legs[].journeyMin", "$.legs[].refundable", "$.legs[].isLCC",
  "$.legs[].productLabel", "$.legs[].seatsLeft",
  "$.legs[].segments[].airlineCode", "$.legs[].segments[].airlineName", "$.legs[].segments[].flightNumber",
  "$.legs[].segments[].from", "$.legs[].segments[].from.code", "$.legs[].segments[].from.city", "$.legs[].segments[].from.terminal",
  "$.legs[].segments[].to", "$.legs[].segments[].to.code", "$.legs[].segments[].to.city", "$.legs[].segments[].to.terminal",
  "$.legs[].segments[].departAt", "$.legs[].segments[].arriveAt", "$.legs[].segments[].durationMin", "$.legs[].segments[].layoverMin",
  "$.legs[].segments[].cabin", "$.legs[].segments[].baggage", "$.legs[].segments[].baggage.checkIn", "$.legs[].segments[].baggage.cabin",
].sort();
const EXPECTED_HOTEL_KEYS = [
  "$.kind", "$.optionRef", "$.hotelCode", "$.name", "$.stars", "$.address", "$.city", "$.checkIn", "$.checkOut",
  "$.roomName", "$.mealPlan", "$.refundable", "$.cancelBy", "$.inclusions", "$.searchedAt",
].sort();
const EXPECTED_HOTEL_RESULT_KEYS = [
  "$.hotelCode", "$.name", "$.stars", "$.address", "$.city", "$.checkIn", "$.checkOut", "$.rooms",
  "$.rooms[].optionRef", "$.rooms[].roomName", "$.rooms[].mealPlan", "$.rooms[].refundable", "$.rooms[].cancelBy", "$.rooms[].inclusions",
].sort();
const uniq = (a: string[]) => [...new Set(a)].sort();

/* ── tests ───────────────────────────────────────────────────────────────── */

describe("approval search selection — price-free contract", () => {
  const all = {
    flightOW, flightRTDom, flightRTIntl, inboundOpt,
    hotelRefundable: () => hotelSel(0), hotelNonRefundable: () => hotelSel(1), hotelResult,
  };

  for (const [name, make] of Object.entries(all)) {
    it(`${name}: no key the sanitiser treats as money, no currency figure`, () => {
      const sel = make();
      expect(priceKeys(sel)).toEqual([]);
      for (const s of strings(sel)) expect(s).not.toMatch(CURRENCY_FIGURE);
    });

    it(`${name}: sanitizeApprovalForViewer leaves it unchanged for a customer viewer`, () => {
      const sel = make();
      const doc = { cartItems: [{ type: (sel as any).kind ?? "hotel", title: "x", meta: { selection: sel } }] };
      const out = sanitizeApprovalForViewer(doc, { roles: ["EMPLOYEE"] });
      expect(out.cartItems[0].meta.selection).toEqual(JSON.parse(JSON.stringify(sel)));
    });
  }

  it("the key set is exactly the reviewed allow-list (flight)", () => {
    const keys = uniq([...keyPaths(flightOW()), ...keyPaths(flightRTDom()), ...keyPaths(flightRTIntl()), ...keyPaths(inboundOpt())]);
    expect(keys).toEqual(EXPECTED_FLIGHT_KEYS);
  });

  it("the key set is exactly the reviewed allow-list (hotel)", () => {
    expect(uniq([...keyPaths(hotelSel(0)), ...keyPaths(hotelSel(1))])).toEqual(EXPECTED_HOTEL_KEYS);
  });

  it("the key set is exactly the reviewed allow-list (hotel search result)", () => {
    expect(uniq(keyPaths(hotelResult()))).toEqual(EXPECTED_HOTEL_RESULT_KEYS);
  });

  it("fare-type label and seats left (D2); inbound option is a single back leg", () => {
    expect(flightOW().legs[0]).toMatchObject({ productLabel: "Saver", seatsLeft: 4 });
    expect(toFlightSelection({ out: { ...oneWay, FareClassification: undefined }, optionRef: "x", searchedAt: AT }).legs[0].productLabel).toBe("Regular");
    expect(inboundOpt()).toMatchObject({ tripKind: "RT_DOM", legs: [{ direction: "back" }] });
  });

  it("hotel result rooms are in name order, not TBO's price order", () => {
    expect(hotelResult().rooms.map((r) => r.roomName)).toEqual(["Deluxe Room", "Luxury Room, 1 King Bed"]);
    expect(hotelResult().rooms.map((r) => r.optionRef)).toEqual(["h.0.1", "h.0.0"]);
  });

  it("the guard itself catches a price-like key if one is ever added", () => {
    for (const k of ["totalFare", "fareFamily", "totalDuration", "ratePlan", "cancellationCharges", "netAmount", "price"]) {
      expect(priceKeys({ ...flightOW(), [k]: 1 })).toEqual([`$.${k}`]);
    }
  });

  it("keeps the return leg: domestic round trip from the inbound pick, international from Segments[1]", () => {
    const dom = flightRTDom();
    expect(dom.tripKind).toBe("RT_DOM");
    expect(dom.legs.map((l) => [l.direction, l.segments[0].flightNumber])).toEqual([["out", "512"], ["back", "640"]]);
    expect(dom.legs[1].refundable).toBe(false);

    const intl = flightRTIntl();
    expect(intl.tripKind).toBe("RT_INTL");
    expect(intl.legs.map((l) => `${l.segments[0].from.code}-${l.segments[0].to.code}`)).toEqual(["BOM-DXB", "DXB-BOM"]);

    expect(flightOW().tripKind).toBe("OW");
    expect(flightOW().legs).toHaveLength(1);
  });

  it("maps a connecting itinerary: stops, layover, journey minutes, cabin, baggage", () => {
    const leg = flightOW().legs[0];
    expect(leg.stopCount).toBe(1);
    expect(leg.segments.map((s) => s.layoverMin)).toEqual([0, 75]);
    expect(leg.journeyMin).toBe(165 + 75 + 130);
    expect(leg.segments[0]).toMatchObject({
      airlineCode: "6E", flightNumber: "512", cabin: "Economy",
      from: { code: "BLR", city: "BLR City", terminal: "1" }, departAt: "2026-10-12T07:00:00",
      baggage: { checkIn: "15 Kg", cabin: "7 Kg" },
    });
  });

  it("hotel: stars, meal plan, room name, cancel-by date without amounts, price text stripped from inclusions", () => {
    const h = hotelSel(0);
    expect(h).toMatchObject({
      hotelCode: "1001", name: "Taj Lands End", stars: 5, roomName: "Luxury Room, 1 King Bed",
      mealPlan: "Breakfast", refundable: true, cancelBy: "2026-10-11", checkIn: "2026-10-12",
    });
    expect(h.inclusions).toEqual(["Free WiFi", "spa credit", "Breakfast"]);
    expect(hotelSel(1)).toMatchObject({ mealPlan: "Room only", refundable: false, cancelBy: null, inclusions: [] });
  });

  it("helpers", () => {
    expect(cabinLabel(4)).toBe("Business");
    expect(cabinLabel(99)).toBe("");
    expect([parseStars("FiveStar"), parseStars("3"), parseStars(4), parseStars("All")]).toEqual([5, 3, 4, null]);
    expect(cancelByDate({ IsRefundable: true, CancelPolicies: [] })).toBeNull();
  });
});
