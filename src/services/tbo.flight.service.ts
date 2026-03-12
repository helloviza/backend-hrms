import { getTBOToken } from "./tbo.auth.service.js";

/* ── TBO Response Types (additive — used for documentation & future typing) ── */

export interface TBOMiniFareRule {
  JourneyPoints?: string;
  Type?: string;
  From?: string;
  To?: string;
  Unit?: string;
  Details?: string;
  OnlineRefundAllowed?: boolean;
}

export interface TBOFareBreakdown {
  BaseFare?: number;
  Tax?: number;
  YQTax?: number;
  AdditionalTxnFeeOfrd?: number;
  AdditionalTxnFeePub?: number;
  PGCharge?: number;
  SupplierReissueCharges?: number;
  Currency?: string;
  PaxType?: number;
  PassengerCount?: number;
  TaxBreakUp?: Array<{ key: string; value: number }>;
}

export interface TBOFare {
  BaseFare: number;
  Tax: number;
  TotalFare: number;
  PublishedFare: number;
  OfferedFare?: number;
  Currency: string;
  PGCharge?: number;
  TotalBaggageCharges?: number;
  TotalMealCharges?: number;
  TotalSeatCharges?: number;
  TotalSpecialServiceCharges?: number;
  TaxBreakup?: Array<{ key: string; value: number }>;
}

export interface TBOSegment {
  Baggage?: string;
  CabinBaggage?: string;
  CabinClass?: number;
  Duration?: number;
  GroundTime?: number;
  Mile?: number;
  StopOver?: boolean;
  StopPoint?: string;
  NoOfSeatAvailable?: number;
  SupplierFareClass?: string | null;
  Remark?: string | null;
  FlightInfoIndex?: string;
  FareClassification?: { Type?: string };
  Airline: {
    AirlineCode: string;
    AirlineName: string;
    FlightNumber: string;
    FareClass?: string;
    OperatingCarrier?: string;
  };
  Origin: {
    DepTime: string;
    Airport: {
      AirportCode: string;
      AirportName?: string;
      Terminal?: string;
      CityCode?: string;
      CityName?: string;
      CountryCode?: string;
      CountryName?: string;
    };
  };
  Destination: {
    ArrTime: string;
    Airport: {
      AirportCode: string;
      AirportName?: string;
      Terminal?: string;
      CityCode?: string;
      CityName?: string;
      CountryCode?: string;
      CountryName?: string;
    };
  };
}

export interface TBOFlightResult {
  ResultIndex: string;
  IsLCC: boolean;
  NonRefundable: boolean;
  Fare: TBOFare;
  FareBreakdown?: TBOFareBreakdown[];
  Segments: TBOSegment[][];
  IsPanRequiredAtBook?: boolean;
  IsPanRequiredAtTicket?: boolean;
  IsPassportRequiredAtBook?: boolean;
  IsPassportRequiredAtTicket?: boolean;
  IsPassportFullDetailRequiredAtBook?: boolean;
  GSTAllowed?: boolean;
  IsGSTMandatory?: boolean;
  FirstNameFormat?: string | null;
  LastNameFormat?: string | null;
  IsBookableIfSeatNotAvailable?: boolean;
  IsHoldAllowedWithSSR?: boolean;
  IsHoldMandatoryWithSSR?: boolean;
  ResultFareType?: string;
  ValidatingAirline?: string;
  AirlineCode?: string;
  FareClassification?: { Color?: string; Type?: string };
  SearchCombinationType?: number;
  IsTransitVisaRequired?: boolean;
  MiniFareRules?: TBOMiniFareRule[][];
}

/* ─────────────────────────────────────────────────────────────────────────── */

const FLIGHT_BASE =
  process.env.TBO_FLIGHT_BASE_URL ||
  "https://api.tektravels.com/BookingEngineService_Air/AirService.svc/rest";

const TIMEOUT = Number(process.env.TBO_HTTP_TIMEOUT_MS || 90_000);

async function post(path: string, body: object) {
  console.log(`[TBO POST] ${FLIGHT_BASE}${path}\n[TBO PAYLOAD]`, JSON.stringify(body, null, 2));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(`${FLIGHT_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function searchFlights(params: {
  origin: string;
  destination: string;
  departDate: string;
  returnDate?: string;
  adults?: number;
  children?: number;
  infants?: number;
  JourneyType?: 1 | 2;
  cabinClass?: number;
}) {
  const token = await getTBOToken();
  const endUserIp = process.env.TBO_EndUserIp || "1.1.1.1";

  const segments: object[] = [
    {
      Origin: params.origin,
      Destination: params.destination,
      FlightCabinClass: String(params.cabinClass ?? 1),
      PreferredDepartureTime: `${params.departDate}T00:00:00`,
      PreferredArrivalTime: `${params.departDate}T00:00:00`,
    },
  ];

  if (params.JourneyType === 2 && params.returnDate) {
    segments.push({
      Origin: params.destination,
      Destination: params.origin,
      FlightCabinClass: String(params.cabinClass ?? 1),
      PreferredDepartureTime: `${params.returnDate}T00:00:00`,
      PreferredArrivalTime: `${params.returnDate}T00:00:00`,
    });
  }

  return post("/Search", {
    EndUserIp: endUserIp,
    TokenId: token,
    AdultCount: String(params.adults ?? 1),
    ChildCount: String(params.children ?? 0),
    InfantCount: String(params.infants ?? 0),
    DirectFlight: "false",
    OneStopFlight: "false",
    JourneyType: String(params.JourneyType ?? 1),
    PreferredAirlines: null,
    Segments: segments,
    Sources: null,
  });
}

export async function searchMultiCity(params: {
  segments: Array<{
    origin: string;
    destination: string;
    departDate: string;
    cabinClass?: number;
  }>;
  adults?: number;
  children?: number;
  infants?: number;
}) {
  const token = await getTBOToken();
  const endUserIp = process.env.TBO_EndUserIp || "1.1.1.1";

  const Segments = params.segments.map(seg => ({
    Origin: seg.origin,
    Destination: seg.destination,
    FlightCabinClass: seg.cabinClass ?? 2,
    PreferredDepartureTime: `${seg.departDate}T00:00:00`,
    PreferredArrivalTime: `${seg.departDate}T00:00:00`,
  }));

  return post("/Search", {
    EndUserIp: endUserIp,
    TokenId: token,
    AdultCount: String(params.adults ?? 1),
    ChildCount: String(params.children ?? 0),
    InfantCount: String(params.infants ?? 0),
    DirectFlight: "false",
    OneStopFlight: "false",
    JourneyType: "3",
    PreferredAirlines: null,
    Segments,
    Sources: null,
  });
}

export async function getFareQuote(params: {
  TraceId: string;
  ResultIndex: string;
}) {
  const token = await getTBOToken();
  return post("/FareQuote", {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    TraceId: params.TraceId,
    ResultIndex: params.ResultIndex,
  });
}

export async function getFareRule(params: {
  TraceId: string;
  ResultIndex: string;
}) {
  const token = await getTBOToken();
  return post("/FareRule", {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    TraceId: params.TraceId,
    ResultIndex: params.ResultIndex,
  });
}

export async function getSSR(params: {
  TraceId: string;
  ResultIndex: string;
}) {
  const token = await getTBOToken();
  return post("/SSR", {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    TraceId: params.TraceId,
    ResultIndex: params.ResultIndex,
  });
}

export async function bookFlight(params: {
  TraceId: string;
  ResultIndex: string;
  Passengers: unknown[];
}) {
  const token = await getTBOToken();
  return post("/Book", {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    TraceId: params.TraceId,
    ResultIndex: params.ResultIndex,
    Passengers: params.Passengers,
  });
}

export async function ticketFlight(params: {
  TraceId: string;
  PNR: string;
  BookingId: number;
  Passengers: unknown[];
  IsPriceChangeAccepted?: boolean;
}) {
  const token = await getTBOToken();
  return post("/Ticket", {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    TraceId: params.TraceId,
    PNR: params.PNR,
    BookingId: params.BookingId,
    Passengers: params.Passengers,
    IsPriceChangeAccepted: params.IsPriceChangeAccepted ?? false,
  });
}

export async function ticketLCC(params: {
  TraceId: string;
  ResultIndex: string;
  Passengers: unknown[];
  IsPriceChangeAccepted?: boolean;
}) {
  const token = await getTBOToken();
  return post("/Ticket", {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    TraceId: params.TraceId,
    ResultIndex: params.ResultIndex,
    Passengers: params.Passengers,
    IsPriceChangeAccepted: params.IsPriceChangeAccepted ?? false,
  });
}

export async function releasePNR(params: {
  BookingId: number;
  PNR: string;
}) {
  const token = await getTBOToken();
  return post("/ReleasePNRRequest", {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    BookingId: params.BookingId,
    PNR: params.PNR,
  });
}

export async function getBookingDetails(params: { bookingId: string }) {
  const token = await getTBOToken();
  return post("/GetBookingDetails", {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    BookingId: params.bookingId,
  });
}

export async function getBookingDetailsByPNR(params: {
  PNR: string;
  FirstName: string;
  LastName?: string;
}) {
  const token = await getTBOToken();
  return post("/GetBookingDetails", {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    PNR: params.PNR,
    FirstName: params.FirstName,
    LastName: params.LastName || "",
  });
}
