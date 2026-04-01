import { getTBOToken, getTokenAcquiredAt, clearTBOToken } from "./tbo.auth.service.js";
import { logTBOCall } from "../utils/tboFileLogger.js";

/* ── NDC airline detection ──────────────────────────────────────────────────── */

const NDC_AIRLINE_CODES = new Set(["EK", "LH", "BA", "SQ", "WY", "EY", "GF"]);
// Note: AI can be GDS or NDC depending on fare — treat as NDC when IsNDC flag is true on the flight result

export function isNDCFlight(airlineCode: string, isNDCFlag?: boolean): boolean {
  return NDC_AIRLINE_CODES.has(airlineCode) || isNDCFlag === true;
}

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
  "http://api.tektravels.com/BookingEngineService_Air/AirService.svc/rest";

const FLIGHT_BOOK_BASE =
  process.env.TBO_FLIGHT_BOOK_BASE_URL ||
  "http://api.tektravels.com/BookingEngineService_AirBook/AirService.svc/rest";

const TIMEOUT = Number(process.env.TBO_HTTP_TIMEOUT_MS || 300_000);

async function post(path: string, body: object, _retried = false, base = FLIGHT_BASE): Promise<unknown> {
  const method = path.replace(/^\//, ""); // "/FareQuote" → "FareQuote"
  const traceId = (body as any)?.TraceId || undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const start = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawText = await res.text();
    if (method === "Ticket") {
      console.log(`[TBO-DEBUG ${method}] HTTP ${res.status} | raw (first 500):`, rawText.substring(0, 500));
    }
    if (rawText.startsWith("<") || rawText.startsWith("<?")) {
      throw new Error(`TBO returned XML instead of JSON (likely malformed request): ${rawText.slice(0, 300)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new Error(`TBO returned non-JSON response (HTTP ${res.status}): ${rawText.slice(0, 300)}`);
    }
    if (method === "Ticket") {
      const resp = (json as any)?.Response;
      console.log(`[TBO-DEBUG ${method}] ErrorCode:`, resp?.Error?.ErrorCode, '| ErrorMessage:', resp?.Error?.ErrorMessage, '| ResponseStatus:', resp?.ResponseStatus);
    }
    const durationMs = Date.now() - start;

    // Fire-and-forget file log — never awaited to avoid slowing the flow
    logTBOCall({ method, traceId, request: body, response: json, durationMs });

    // ErrorCode 6 = invalid/expired token — clear cache and retry once with fresh token
    const errCode = (json as any)?.Response?.Error?.ErrorCode;
    if (errCode === 6 && !_retried) {
      console.warn(`[TBO] ErrorCode 6 on ${method} — clearing token and retrying`);
      clearTBOToken();
      const freshToken = await getTBOToken({ forceRefresh: true });
      const retryBody = { ...body, TokenId: freshToken };
      return post(path, retryBody, true, base);
    }

    return json;
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
  JourneyType?: 1 | 2 | 3 | 4 | 5;
  cabinClass?: number;
  Sources?: string | null;
}) {
  const token = await getTBOToken();
  console.log('[TBO-TOKEN-USED] Search TokenId:', token.slice(0, 8));
  const endUserIp = process.env.TBO_EndUserIp || "1.1.1.1";

  const cabinClass = String(params.cabinClass ?? 1);
  const jt = params.JourneyType ?? 1;
  const isReturn = jt === 2 || jt === 5;

  // Outbound segment (always present)
  const segments: object[] = [
    {
      Origin: params.origin,
      Destination: params.destination,
      FlightCabinClass: cabinClass,
      PreferredDepartureTime: `${params.departDate}T00:00:00`,
      PreferredArrivalTime: `${params.departDate}T00:00:00`,
    },
  ];

  // Round-trip (JourneyType 2 or 5) requires a second segment with origin/destination swapped
  if (isReturn && params.returnDate) {
    segments.push({
      Origin: params.destination,
      Destination: params.origin,
      FlightCabinClass: cabinClass,
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
    JourneyType: String(jt),
    PreferredAirlines: null,
    Segments: segments,
    Sources: params.Sources ?? null,
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
  console.log('[TBO-TOKEN-USED] SearchMultiCity TokenId:', token.slice(0, 8));
  const endUserIp = process.env.TBO_EndUserIp || "1.1.1.1";

  const Segments = params.segments.map(seg => ({
    Origin: seg.origin,
    Destination: seg.destination,
    FlightCabinClass: String(seg.cabinClass ?? 2),
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
  console.log('[TBO-TOKEN-USED] FareQuote TokenId:', token.slice(0, 8));
  // ResultIndex may be comma-separated for Special Return (e.g. "OB3,IB7") — TBO handles natively
  return post("/FareQuote", {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    TraceId: params.TraceId,
    ResultIndex: params.ResultIndex,
  });
}

export async function getPriceRBD(params: {
  TraceId: string;
  AdultCount: number;
  ChildCount: number;
  InfantCount: number;
  AirSearchResult: Array<{
    ResultIndex: string;
    Source: number;
    IsLCC: boolean;
    IsRefundable: boolean;
    AirlineRemark: string;
    Segments: Array<Array<{
      TripIndicator: number;
      SegmentIndicator: number;
      Airline: {
        AirlineCode: string;
        AirlineName: string;
        FlightNumber: string;
        FareClass: string;
        OperatingCarrier: string;
      };
    }>>;
  }>;
}) {
  const token = await getTBOToken();
  console.log('[TBO-TOKEN-USED] PriceRBD TokenId:', token.slice(0, 8));
  return post("/PriceRBD", {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    TraceId: params.TraceId,
    AdultCount: params.AdultCount,
    ChildCount: params.ChildCount,
    InfantCount: params.InfantCount,
    AirSearchResult: params.AirSearchResult,
  });
}

export async function getFareRule(params: {
  TraceId: string;
  ResultIndex: string;
}) {
  const token = await getTBOToken();
  console.log('[TBO-TOKEN-USED] FareRule TokenId:', token.slice(0, 8));
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
  console.log('[TBO-TOKEN-USED] SSR TokenId:', token.slice(0, 8));
  return post("/SSR", {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    TraceId: params.TraceId,
    ResultIndex: params.ResultIndex,
  });
}

/* ── TBO FlightNameValidation helpers ──────────────────────────────────────── */

function sanitizeName(name: string): string {
  if (!name) return "X";
  // Keep only letters, spaces, hyphens, apostrophes (strip digits & other chars)
  let clean = name.replace(/[^a-zA-Z\s\-']/g, "").trim();
  // Collapse multiple spaces/hyphens
  clean = clean.replace(/\s{2,}/g, " ").replace(/-{2,}/g, "-");
  // Truncate to 32 chars
  clean = clean.slice(0, 32).trim();
  return clean || "X";
}

function sanitizeTitle(title: string): string {
  const titleMap: Record<string, string> = {
    "MR": "Mr", "MRS": "Mrs", "MS": "Ms", "MISS": "Miss",
    "MSTR": "Mstr", "MASTER": "Master", "DR": "DR",
    "CHD": "CHD", "MST": "MST", "PROF": "PROF", "INF": "Inf",
  };
  const upper = (title || "Mr").toUpperCase();
  return titleMap[upper] || "Mr";
}

function sanitizeContactNo(raw: string | undefined, isLeadPax?: boolean): string {
  const digits = (raw || "").replace(/\D/g, "").slice(-10);
  if (digits.length >= 10) return digits;
  if (isLeadPax) throw new Error("Valid 10-digit phone number is required for lead passenger");
  throw new Error("Valid 10-digit phone number is required for passenger contact");
}

function sanitizePassportDate(dateStr: string | undefined): string {
  if (!dateStr) return "";
  // Already full ISO: "2028-06-15T00:00:00" or "2028-06-15"
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return dateStr.split("T")[0] + "T00:00:00";
  }
  // Month-only "YYYY-MM": append "-01"
  if (/^\d{4}-\d{2}$/.test(dateStr)) {
    return dateStr + "-01T00:00:00";
  }
  return "";
}

function sanitizeDOB(dob: string | undefined, paxType: number): string {
  if (!dob || !dob.trim()) {
    if (paxType === 2) throw new Error("Date of birth is required for Child passengers");
    if (paxType === 3) throw new Error("Date of birth is required for Infant passengers");
    return "";
  }
  // Already ISO: "1990-01-01T00:00:00" or "1990-01-01"
  if (/^\d{4}-\d{2}-\d{2}/.test(dob)) {
    return dob.includes("T") ? dob : dob + "T00:00:00";
  }
  // DD/MM/YYYY → ISO
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dob)) {
    const [day, month, year] = dob.split("/");
    return `${year}-${month}-${day}T00:00:00`;
  }
  // DD-MM-YYYY → ISO
  if (/^\d{2}-\d{2}-\d{4}$/.test(dob)) {
    const [day, month, year] = dob.split("-");
    return `${year}-${month}-${day}T00:00:00`;
  }
  // Unparseable DOB — hard-reject for child/infant, allow empty for adult
  if (paxType === 2) throw new Error("Invalid date of birth format for Child passenger");
  if (paxType === 3) throw new Error("Invalid date of birth format for Infant passenger");
  return "";
}

/* ── Airline-specific pre-booking validations ──────────────────────────────── */

const SPICEJET_GULF_DESTINATIONS = new Set(["DXB", "RUH", "SHJ"]);
const NEPAL_DESTINATIONS = new Set(["KTM"]);

function validateAirlineSpecific(
  airlineCode: string,
  passengers: Array<Record<string, any>>,
  destinationCode: string,
): void {
  const code = (airlineCode || "").toUpperCase();

  // AirAsia (I5 = AirAsia India, AK = AirAsia): first passenger must have CountryCode + CountryName
  if (code === "I5" || code === "AK") {
    const firstPax = passengers[0];
    if (firstPax && (!firstPax.CountryCode || !firstPax.CountryName)) {
      throw new Error("AirAsia requires CountryCode and CountryName for the first passenger");
    }
  }

  // SpiceJet (SG): FirstName and LastName must be distinct
  if (code === "SG") {
    for (const pax of passengers) {
      const first = (pax.FirstName || "").trim().toUpperCase();
      const last = (pax.LastName || "").trim().toUpperCase();
      if (first && last && first === last) {
        throw new Error(`SpiceJet requires First Name and Last Name to be different for passenger: ${pax.FirstName} ${pax.LastName}`);
      }
    }
  }

  const dest = (destinationCode || "").toUpperCase();

  // SpiceJet Gulf routes (Dubai/Riyadh/Sharjah): passport mandatory for all pax
  if (code === "SG" && SPICEJET_GULF_DESTINATIONS.has(dest)) {
    for (const pax of passengers) {
      if (!pax.PassportNo) {
        const name = `${pax.FirstName || ""} ${pax.LastName || ""}`.trim();
        throw new Error(`Passport is mandatory for SpiceJet Gulf route (${dest}) — missing for: ${name}`);
      }
    }
  }

  // SpiceJet/IndiGo to Nepal (KTM): passport mandatory for Adult + Child
  if ((code === "SG" || code === "6E") && NEPAL_DESTINATIONS.has(dest)) {
    for (const pax of passengers) {
      const paxType = Number(pax.PaxType) || 1;
      if ((paxType === 1 || paxType === 2) && !pax.PassportNo) {
        const name = `${pax.FirstName || ""} ${pax.LastName || ""}`.trim();
        throw new Error(`Passport is mandatory for ${code === "SG" ? "SpiceJet" : "IndiGo"} flights to Nepal — missing for: ${name}`);
      }
    }
  }
}

export async function bookFlight(params: {
  TraceId: string;
  ResultIndex: string;
  Passengers: Array<Record<string, any> & {
    guardianDetails?: {
      Title?: string;
      FirstName: string;
      LastName: string;
      PAN?: string;
      PassportNo?: string;
    };
  }>;
  isPassportFullDetailRequired?: boolean;
  isNDC?: boolean;
  airlineCode?: string;
  destinationCode?: string;
  IsGSTMandatory?: boolean;
  GSTCompanyInfo?: {
    GSTCompanyName: string;
    GSTCompanyAddress: string;
    GSTCompanyContactNumber: string;
    GSTCompanyEmail: string;
    GSTIN: string;
  };
}) {
  if (!Array.isArray(params.Passengers) || params.Passengers.length === 0) {
    throw new Error("bookFlight: Passengers array is missing or empty");
  }

  if (params.IsGSTMandatory === true && !params.GSTCompanyInfo) {
    throw new Error("GST company details are mandatory for this fare. Please provide your company GSTIN.");
  }

  // CRITICAL: TBO requires the SAME TokenId across the entire
  // Search→PriceRBD→FareQuote→SSR→Book chain. Never force-refresh
  // here — use the same cached token that Search/FareQuote/SSR used.
  let token: string;
  try {
    token = await getTBOToken();
  } catch (tokenErr: any) {
    console.error("[BOOK TOKEN ERROR]", tokenErr?.message);
    throw tokenErr;
  }

  const tokenAcquiredAt = getTokenAcquiredAt();
  console.log('[TBO-TOKEN-USED] Book TokenId:', token.slice(0, 8),
    'age minutes:', ((Date.now() - tokenAcquiredAt) / 60000).toFixed(2));

  const leadPax = (params.Passengers as any[]).find((p: any) => p.IsLeadPax) || (params.Passengers as any[])[0];
  const leadEmail = leadPax?.Email || "";
  const needsPassportIssueDate = params.isPassportFullDetailRequired === true;
  const ndcMode = params.isNDC === true;

  // GDS Book: only the exact fields from the working Case1 request.
  // No Meal, Seat, SeatDynamic, MealDynamic, Baggage, or CellCountryCode.
  // NDC Book: adds CellCountryCode, email on every pax, dots stripped from names,
  // and full passport fields always sent.
  const sanitizedPassengers = (params.Passengers as any[]).map((p: any) => {
    const firstName = sanitizeName(p.FirstName);
    const lastName = sanitizeName(p.LastName);
    const paxType = Number(p.PaxType) || 1;

    const pax: Record<string, unknown> = {
      Title: sanitizeTitle(p.Title),
      FirstName: firstName,
      LastName: lastName.length < 2 ? "XX" : lastName,
      PaxType: paxType,
      DateOfBirth: sanitizeDOB(p.DateOfBirth, paxType),
      Gender: (() => {
        const g = Number(p.Gender);
        if (g !== 1 && g !== 2) throw new Error(`Gender is required for passenger: ${firstName} ${lastName.length < 2 ? "XX" : lastName}`);
        return g;
      })(),
      PassportNo: p.PassportNo || "",
      PassportExpiry: sanitizePassportDate(p.PassportExpiry),
      PassportIssueCountryCode: p.PassportIssueCountryCode || p.passportIssueCountry || "IN",
      Nationality: p.Nationality || "IN",
      AddressLine1: p.AddressLine1 || "India",
      AddressLine2: p.AddressLine2 || "",
      City: p.City || "Delhi",
      CountryCode: p.CountryCode || "IN",
      CountryName: p.CountryName || "India",
      ContactNo: sanitizeContactNo(p.ContactNo, p.IsLeadPax),
      Email: ndcMode ? (p.Email || leadEmail) : leadEmail,
      IsLeadPax: p.IsLeadPax ?? false,
      FFAirlineCode: p.FFAirlineCode || null,
      FFNumber: p.FFNumber || "",
      GSTCompanyAddress: p.GSTCompanyAddress || "",
      GSTCompanyContactNumber: p.GSTCompanyContactNumber || "",
      GSTCompanyName: p.GSTCompanyName || "",
      GSTNumber: p.GSTNumber || "",
      GSTCompanyEmail: p.GSTCompanyEmail || "",
      Fare: {
        Currency: p.Fare?.Currency || "INR",
        BaseFare: Number(p.Fare?.BaseFare) || 0,
        Tax: Number(p.Fare?.Tax) || 0,
        YQTax: Number(p.Fare?.YQTax) || 0,
        AdditionalTxnFeeOfrd: Number(p.Fare?.AdditionalTxnFeeOfrd) || 0,
        AdditionalTxnFeePub: Number(p.Fare?.AdditionalTxnFeePub) || 0,
        PGCharge: 0,
        OtherCharges: Number(p.Fare?.OtherCharges) || 0,
        Discount: Number(p.Fare?.Discount) || 0,
        PublishedFare: Number(p.Fare?.PublishedFare) || 0,
        OfferedFare: Number(p.Fare?.OfferedFare) || 0,
        TdsOnCommission: Number(p.Fare?.TdsOnCommission) || 0,
        TdsOnPLB: Number(p.Fare?.TdsOnPLB) || 0,
        TdsOnIncentive: Number(p.Fare?.TdsOnIncentive) || 0,
        ServiceFee: Number(p.Fare?.ServiceFee) || 0,
        TransactionFee: Number(p.Fare?.TransactionFee) || 0,
        AirTransFee: Number(p.Fare?.AirTransFee) || 0,
        CommissionEarned: Number(p.Fare?.CommissionEarned) || 0,
        PLBEarned: Number(p.Fare?.PLBEarned) || 0,
        IncentiveEarned: Number(p.Fare?.IncentiveEarned) || 0,
      },
    };

    // NDC: CellCountryCode mandatory, full passport always sent
    if (ndcMode) {
      pax.CellCountryCode = "91";
      pax.PassportIssueDate = sanitizePassportDate(p.PassportIssueDate) || "2015-01-01T00:00:00";
    }

    if (needsPassportIssueDate && !ndcMode) {
      pax.PassportIssueDate = sanitizePassportDate(p.PassportIssueDate) || "2015-01-01T00:00:00";
    }

    // Infant title override — TBO requires "Mstr" for male, "Miss" for female
    if (paxType === 3) {
      pax.Title = pax.Gender === 1 ? "Mstr" : "Miss";
    }

    // GuardianDetails for Child/Infant passengers
    if ((paxType === 2 || paxType === 3) && p.guardianDetails) {
      pax.GuardianDetails = {
        Title: sanitizeTitle(p.guardianDetails.Title),
        FirstName: sanitizeName(p.guardianDetails.FirstName),
        LastName: sanitizeName(p.guardianDetails.LastName),
        ...(p.guardianDetails.PAN ? { PAN: p.guardianDetails.PAN } : {}),
        ...(p.guardianDetails.PassportNo ? { PassportNo: p.guardianDetails.PassportNo } : {}),
      };
    }

    return pax;
  });

  // Airline-specific validations (AirAsia, SpiceJet, etc.)
  if (params.airlineCode) {
    validateAirlineSpecific(params.airlineCode, sanitizedPassengers, params.destinationCode || "");
  }

  const payload: Record<string, unknown> = {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    TraceId: params.TraceId,
    ResultIndex: params.ResultIndex,
    Passengers: sanitizedPassengers,
    IsPriceChangedAccepted: true,
  };
  if (params.GSTCompanyInfo) payload.GSTCompanyInfo = params.GSTCompanyInfo;

  console.log('[BOOK-PAX-KEYS]', Object.keys((payload.Passengers as any[])[0]));
  console.log('[BOOK-PAX0-FARE]', JSON.stringify((payload.Passengers as any[])[0]?.Fare, null, 2));
  console.log('[BOOK-PAYLOAD-TO-TBO]', JSON.stringify(payload).slice(0, 1000));

  return post("/Book", payload, false, FLIGHT_BOOK_BASE);
}

export async function ticketFlight(params: {
  TraceId: string;
  PNR: string;
  BookingId: number;
}) {
  const token = await getTBOToken();
  console.log('[TBO-TOKEN-USED] Ticket TokenId:', token.slice(0, 8));
  const gdsPayload = {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    TraceId: params.TraceId,
    PNR: params.PNR,
    BookingId: params.BookingId,
  };
  // GDS Ticket requires only these 5 fields — NO Passengers array
  const gdsResult = await post("/Ticket", gdsPayload, false, FLIGHT_BOOK_BASE) as any;

  // Auto-retry with IsPriceChangedAccepted if TBO signals price changed
  const gdsChanged = gdsResult?.Response?.IsPriceChanged === true
    || gdsResult?.Response?.Response?.IsPriceChanged === true;
  if (gdsChanged) {
    console.warn("[TBO TICKET] IsPriceChanged in ticket response — retrying with IsPriceChangedAccepted=true");
    return post("/Ticket", { ...gdsPayload, IsPriceChangedAccepted: true }, false, FLIGHT_BOOK_BASE);
  }
  return gdsResult;
}

/* ── SSR sanitizers — strip extra fields TBO rejects ──────────────────── */

function sanitizeMealDynamic(meals: any[]): any[] {
  if (!Array.isArray(meals)) return [];
  return meals.map((m: any) => ({
    AirlineCode: m.AirlineCode ?? "",
    FlightNumber: m.FlightNumber ?? "",
    WayType: m.WayType ?? 2,
    Code: m.Code ?? "",
    Description: Number(m.Description) || 2,
    AirlineDescription: m.AirlineDescription ?? "",
    Quantity: m.Quantity ?? 1,
    Currency: m.Currency ?? "INR",
    Price: Number(m.Price) || 0,
    Origin: m.Origin ?? "",
    Destination: m.Destination ?? "",
  }));
}

function sanitizeBaggage(bags: any[]): any[] {
  if (!Array.isArray(bags)) return [];
  return bags.map((b: any) => ({
    AirlineCode: b.AirlineCode ?? "",
    FlightNumber: b.FlightNumber ?? "",
    WayType: b.WayType ?? 2,
    Code: b.Code ?? "",
    Description: Number(b.Description) || 2,
    Weight: b.Weight ?? 0,
    Currency: b.Currency ?? "INR",
    Price: Number(b.Price) || 0,
    Origin: b.Origin ?? "",
    Destination: b.Destination ?? "",
  }));
}

function sanitizeSeatDynamic(seats: any[]): any[] {
  if (!Array.isArray(seats)) return [];
  return seats.map((seg: any) => ({
    SegmentSeat: (Array.isArray(seg.SegmentSeat) ? seg.SegmentSeat : []).map((ss: any) => ({
      RowSeats: (Array.isArray(ss.RowSeats) ? ss.RowSeats : []).map((rs: any) => ({
        Seats: (Array.isArray(rs.Seats) ? rs.Seats : []).map((s: any) => ({
          AirlineCode: s.AirlineCode ?? "",
          FlightNumber: s.FlightNumber ?? "",
          CraftType: s.CraftType ?? "",
          Origin: s.Origin ?? "",
          Destination: s.Destination ?? "",
          AvailablityType: s.AvailablityType ?? 0,
          Description: Number(s.Description) || 2,
          Code: s.Code ?? "",
          RowNo: s.RowNo ?? "",
          SeatNo: s.SeatNo ?? "",
          SeatType: s.SeatType ?? 0,
          SeatWayType: s.SeatWayType ?? 0,
          Compartment: s.Compartment ?? 0,
          Deck: s.Deck ?? 0,
          Currency: s.Currency ?? "INR",
          Price: Number(s.Price) || 0,
        })),
      })),
    })),
  }));
}

export async function ticketLCC(params: {
  TraceId: string;
  ResultIndex: string;
  Passengers: Array<Record<string, any> & {
    guardianDetails?: {
      Title?: string;
      FirstName: string;
      LastName: string;
      PAN?: string;
      PassportNo?: string;
    };
  }>;
  IsPriceChangedAccepted?: boolean;
  isNDC?: boolean;
  isInternational?: boolean;
  airlineCode?: string;
  destinationCode?: string;
  Segments?: Array<Array<{ Origin: { Airport: { CountryCode?: string } }; Destination: { Airport: { CountryCode?: string } } }>>;
  FreeBaggage?: Array<{ AirlineCode: string; FlightNumber: string; WayType: number; Code: string; Description: number; Weight: number; Currency: string; Price: number; Origin: string; Destination: string }>;
  IsGSTMandatory?: boolean;
  GSTCompanyInfo?: {
    GSTCompanyName: string;
    GSTCompanyAddress: string;
    GSTCompanyContactNumber: string;
    GSTCompanyEmail: string;
    GSTIN: string;
  };
}) {
  if (params.IsGSTMandatory === true && !params.GSTCompanyInfo) {
    throw new Error("GST company details are mandatory for this fare. Please provide your company GSTIN.");
  }

  const token = await getTBOToken();
  console.log('[TBO-TOKEN-USED] TicketLCC TokenId:', token.slice(0, 8));
  const ndcMode = params.isNDC === true;
  const lccLeadPax = ndcMode
    ? ((params.Passengers as any[]).find((p: any) => p.IsLeadPax) || (params.Passengers as any[])[0])
    : null;
  const lccLeadEmail = lccLeadPax?.Email || "";

  // Derive international flag: explicit param, or check if any segment leaves/enters India
  const isInternational = params.isInternational ?? (
    Array.isArray(params.Segments) && params.Segments.some(journey =>
      journey.some(seg =>
        seg.Origin?.Airport?.CountryCode !== "IN" ||
        seg.Destination?.Airport?.CountryCode !== "IN"
      )
    )
  );

  // Sanitize passengers for TBO: ensure correct types, formats, and all required fields
  const sanitizedPassengers = (params.Passengers as any[]).map((p: any) => {
    const firstName = sanitizeName(p.FirstName);
    const lastName = sanitizeName(p.LastName);
    const pax: Record<string, unknown> = {
      Title: sanitizeTitle(p.Title),
      FirstName: firstName,
      LastName: lastName.length < 2 ? "XX" : lastName,
      PaxType: Number(p.PaxType) || 1,
      DateOfBirth: sanitizeDOB(p.DateOfBirth, Number(p.PaxType) || 1),
      Gender: (() => {
        const g = Number(p.Gender);
        if (g !== 1 && g !== 2) throw new Error(`Gender is required for passenger: ${firstName} ${lastName.length < 2 ? "XX" : lastName}`);
        return g;
      })(),
      PassportNo: p.PassportNo || "",
      PassportExpiry: sanitizePassportDate(p.PassportExpiry),
      PassportIssueCountryCode: p.PassportIssueCountryCode || p.passportIssueCountry || "IN",
      ContactNo: sanitizeContactNo(p.ContactNo, p.IsLeadPax),
      Email: ndcMode ? (p.Email || lccLeadEmail) : (p.Email || ""),
      IsLeadPax: p.IsLeadPax ?? false,
      CountryCode: p.CountryCode || "IN",
      CountryName: p.CountryName || "India",
      Nationality: p.Nationality || "IN",
      City: p.City || "Delhi",
      AddressLine1: p.AddressLine1 || "India",
      AddressLine2: p.AddressLine2 || "",
      FFAirlineCode: p.FFAirlineCode || null,
      FFNumber: p.FFNumber || "",
      GSTCompanyAddress: p.GSTCompanyAddress || "",
      GSTCompanyContactNumber: p.GSTCompanyContactNumber || "",
      GSTCompanyName: p.GSTCompanyName || "",
      GSTNumber: p.GSTNumber || "",
      GSTCompanyEmail: p.GSTCompanyEmail || "",
      Fare: {
        Currency: p.Fare?.Currency || "INR",
        BaseFare: Number(p.Fare?.BaseFare) || 0,
        Tax: Number(p.Fare?.Tax) || 0,
        YQTax: Number(p.Fare?.YQTax) || 0,
        AdditionalTxnFeeOfrd: Number(p.Fare?.AdditionalTxnFeeOfrd) || 0,
        AdditionalTxnFeePub: Number(p.Fare?.AdditionalTxnFeePub) || 0,
        PGCharge: 0,
        OtherCharges: Number(p.Fare?.OtherCharges) || 0,
        Discount: Number(p.Fare?.Discount) || 0,
        PublishedFare: Number(p.Fare?.PublishedFare) || 0,
        OfferedFare: Number(p.Fare?.OfferedFare) || 0,
        TdsOnCommission: Number(p.Fare?.TdsOnCommission) || 0,
        TdsOnPLB: Number(p.Fare?.TdsOnPLB) || 0,
        TdsOnIncentive: Number(p.Fare?.TdsOnIncentive) || 0,
        ServiceFee: Number(p.Fare?.ServiceFee) || 0,
        TransactionFee: Number(p.Fare?.TransactionFee) || 0,
        AirTransFee: Number(p.Fare?.AirTransFee) || 0,
        CommissionEarned: Number(p.Fare?.CommissionEarned) || 0,
        PLBEarned: Number(p.Fare?.PLBEarned) || 0,
        IncentiveEarned: Number(p.Fare?.IncentiveEarned) || 0,
      },
    };

    // FIX 1: Infant title override — TBO requires "Mstr" for male, "Miss" for female
    if (pax.PaxType === 3) {
      pax.Title = pax.Gender === 1 ? "Mstr" : "Miss";
    }

    // GuardianDetails for Child/Infant passengers
    if ((pax.PaxType === 2 || pax.PaxType === 3) && p.guardianDetails) {
      pax.GuardianDetails = {
        Title: sanitizeTitle(p.guardianDetails.Title),
        FirstName: sanitizeName(p.guardianDetails.FirstName),
        LastName: sanitizeName(p.guardianDetails.LastName),
        ...(p.guardianDetails.PAN ? { PAN: p.guardianDetails.PAN } : {}),
        ...(p.guardianDetails.PassportNo ? { PassportNo: p.guardianDetails.PassportNo } : {}),
      };
    }

    // NDC: CellCountryCode mandatory, full passport always sent
    if (ndcMode) {
      pax.CellCountryCode = "91";
      pax.PassportIssueDate = sanitizePassportDate(p.PassportIssueDate) || "2015-01-01T00:00:00";
    }

    // SSR arrays — strict field sanitization; omit placeholders & empty arrays
    const MEAL_PLACEHOLDERS = ["", "nomeal", "no_meal", "none", "no meal preference"];
    const BAG_PLACEHOLDERS = ["", "nobaggage", "no baggage", "no_baggage", "no extra baggage"];
    const SEAT_PLACEHOLDERS = ["", "noseat", "no_seat"];

    if (Array.isArray(p.MealDynamic) && p.MealDynamic.length > 0) {
      const validMeals = sanitizeMealDynamic(p.MealDynamic).filter((m: any) =>
        m.Code &&
        !MEAL_PLACEHOLDERS.includes(m.Code.toLowerCase()) &&
        m.AirlineCode &&
        m.FlightNumber
      );
      if (validMeals.length > 0) pax.MealDynamic = validMeals;
    }
    // TBO requirement: free baggage (Price:0) must be auto-included for international LCC
    if (Array.isArray(p.Baggage) && p.Baggage.length > 0) {
      const validBaggage = sanitizeBaggage(p.Baggage).filter((b: any) =>
        b.Code &&
        !BAG_PLACEHOLDERS.includes(b.Code.toLowerCase()) &&
        b.AirlineCode &&
        b.FlightNumber &&
        (isInternational || b.Price > 0 || b.Weight > 0)
      );
      if (validBaggage.length > 0) pax.Baggage = validBaggage;
    } else if (isInternational && Array.isArray(params.FreeBaggage) && params.FreeBaggage.length > 0 && Number(p.PaxType) !== 3) {
      // Auto-include free baggage from SSR for international LCC when user selected none
      const freeBags = sanitizeBaggage(params.FreeBaggage).filter((b: any) =>
        b.Code && b.AirlineCode && b.FlightNumber && b.Price === 0
      );
      if (freeBags.length > 0) pax.Baggage = freeBags;
    }
    if (Array.isArray(p.SeatDynamic) && p.SeatDynamic.length > 0) {
      const cleaned = sanitizeSeatDynamic(p.SeatDynamic);
      // Filter innermost seats — strip placeholders
      const filtered = cleaned.map((seg: any) => ({
        SegmentSeat: (seg.SegmentSeat ?? []).map((ss: any) => ({
          RowSeats: (ss.RowSeats ?? []).map((rs: any) => ({
            Seats: (rs.Seats ?? []).filter((s: any) =>
              s.Code &&
              !SEAT_PLACEHOLDERS.includes(s.Code.toLowerCase()) &&
              s.SeatNo != null &&
              s.SeatNo !== ""
            ),
          })).filter((rs: any) => rs.Seats.length > 0),
        })).filter((ss: any) => ss.RowSeats.length > 0),
      })).filter((seg: any) => seg.SegmentSeat.length > 0);
      if (filtered.length > 0) pax.SeatDynamic = filtered;
    }
    if (p.SeatPreference !== undefined) {
      pax.SeatPreference = p.SeatPreference;
    }

    // Infant (PaxType 3) must NOT have any SSR — strip as safety net
    if (Number(p.PaxType) === 3) {
      delete pax.MealDynamic;
      delete pax.Baggage;
      delete pax.SeatDynamic;
      delete pax.SeatPreference;
    }

    return pax;
  });

  // FIX 2: Enforce exactly one IsLeadPax=true
  const leadIndices = sanitizedPassengers
    .map((p, i) => (p.IsLeadPax === true ? i : -1))
    .filter(i => i !== -1);
  if (leadIndices.length === 0) {
    const firstAdult = sanitizedPassengers.findIndex(p => p.PaxType === 1);
    sanitizedPassengers[firstAdult !== -1 ? firstAdult : 0].IsLeadPax = true;
  } else if (leadIndices.length > 1) {
    for (let k = 1; k < leadIndices.length; k++) {
      sanitizedPassengers[leadIndices[k]].IsLeadPax = false;
    }
  }

  // Airline-specific validations (AirAsia, SpiceJet, etc.)
  if (params.airlineCode) {
    validateAirlineSpecific(params.airlineCode, sanitizedPassengers, params.destinationCode || "");
  }

  const payload: Record<string, unknown> = {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: token,
    TraceId: params.TraceId,
    ResultIndex: params.ResultIndex,
    Passengers: sanitizedPassengers,
    IsPriceChangedAccepted: true,
  };
  if (params.GSTCompanyInfo) payload.GSTCompanyInfo = params.GSTCompanyInfo;

  (payload.Passengers as any[])?.forEach((p: any, i: number) => {
    console.log(`[TICKET-LCC PAX ${i + 1}]`, JSON.stringify({
      Title: p.Title, FirstName: p.FirstName,
      PaxType: p.PaxType, DateOfBirth: p.DateOfBirth,
      IsLeadPax: p.IsLeadPax,
      hasMeal: !!p.MealDynamic?.length,
      hasSeat: !!p.SeatDynamic?.length,
      hasBaggage: !!p.Baggage?.length,
      FareBaseFare: p.Fare?.BaseFare,
      mealWayType: p.MealDynamic?.[0]?.WayType,
      seatWayType: p.SeatDynamic?.[0]?.SegmentSeat?.[0]
        ?.RowSeats?.[0]?.Seats?.[0]?.SeatWayType,
    }));
  });

  console.log('[TICKET-LCC FULL PAYLOAD]', JSON.stringify(payload, null, 2));

  const lccResult = await post("/Ticket", payload, false, FLIGHT_BOOK_BASE) as any;

  // Auto-retry with IsPriceChangedAccepted if TBO signals price changed
  const lccChanged = lccResult?.Response?.IsPriceChanged === true
    || lccResult?.Response?.Response?.IsPriceChanged === true;
  if (lccChanged && !payload.IsPriceChangedAccepted) {
    console.warn("[TBO TICKET] IsPriceChanged in ticket response — retrying with IsPriceChangedAccepted=true");
    return post("/Ticket", { ...payload, IsPriceChangedAccepted: true }, false, FLIGHT_BOOK_BASE);
  }
  return lccResult;
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
  }, false, FLIGHT_BOOK_BASE);
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
  }, false, FLIGHT_BOOK_BASE);
}
