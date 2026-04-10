import express from "express";
import { randomUUID } from "crypto";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { sbtLogger } from "../utils/logger.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import SBTRequest from "../models/SBTRequest.js";
import { generateHotelVoucher } from "../services/tbo.hotel.service.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { sendMail } from "../utils/mailer.js";
import { logTBOCall } from "../utils/tboFileLogger.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import { requireFeature } from "../middleware/requireFeature.js";
import { getMarginConfig, applyMargin } from "../utils/margin.js";
import { getTBOToken } from "../services/tbo.auth.service.js";

// ── Mock data (TBO_ENV=mock) ─────────────────────────────────────────────
const MOCK_CITIES = [
  { CityCode: "100537", CityName: "Mumbai", CountryCode: "IN", CountryName: "India" },
  { CityCode: "100077", CityName: "Delhi", CountryCode: "IN", CountryName: "India" },
  { CityCode: "100217", CityName: "Bangalore", CountryCode: "IN", CountryName: "India" },
  { CityCode: "100418", CityName: "Chennai", CountryCode: "IN", CountryName: "India" },
  { CityCode: "100290", CityName: "Hyderabad", CountryCode: "IN", CountryName: "India" },
  { CityCode: "100364", CityName: "Kolkata", CountryCode: "IN", CountryName: "India" },
  { CityCode: "100447", CityName: "Pune", CountryCode: "IN", CountryName: "India" },
  { CityCode: "100158", CityName: "Goa", CountryCode: "IN", CountryName: "India" },
];

const MOCK_HOTEL_RESULTS = [
  {
    HotelCode: "MOCK001",
    HotelName: "Mock Grand Hotel",
    StarRating: 5,
    Address: "123 Mock Street",
    Latitude: 19.076,
    Longitude: 72.877,
    HotelPicture: "",
    Rooms: [
      {
        RoomIndex: 1,
        RoomTypeName: "Deluxe Room",
        RatePlanCode: "RP001",
        Price: { RoomPrice: 4500, Tax: 810, TotalFare: 5310, Currency: "INR" },
        MealType: "Breakfast Included",
        IsRefundable: true,
      },
    ],
    cheapestFare: 5310,
  },
  {
    HotelCode: "MOCK002",
    HotelName: "Mock Business Inn",
    StarRating: 3,
    Address: "456 Mock Avenue",
    Latitude: 19.082,
    Longitude: 72.881,
    HotelPicture: "",
    Rooms: [
      {
        RoomIndex: 1,
        RoomTypeName: "Standard Room",
        RatePlanCode: "RP002",
        Price: { RoomPrice: 2200, Tax: 396, TotalFare: 2596, Currency: "INR" },
        MealType: "Room Only",
        IsRefundable: false,
      },
    ],
    cheapestFare: 2596,
  },
];

const router = express.Router();
router.use(requireAuth);
router.use(requireWorkspace);
router.use(requireFeature("hotelBookingEnabled"));

// ─── SBT access guard ────────────────────────────────────────────────────────
// Verifies the user has sbtEnabled=true in the DB.
// Admin/SuperAdmin users bypass this check so they can always inspect SBT data.
async function requireSBT(req: any, res: any, next: any) {
  try {
    const roles: string[] = (req.user?.roles || []).map((r: string) =>
      String(r).toUpperCase()
    );
    if (roles.includes("ADMIN") || roles.includes("SUPERADMIN") || roles.includes("HR")) {
      return next();
    }

    const userId = req.user?.id || req.user?._id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const user = await User.findOne({ _id: userId, workspaceId: req.workspaceObjectId }).select("sbtEnabled").lean();
    if (!user || !(user as any).sbtEnabled) {
      return res.status(403).json({ error: "SBT access not enabled for this account" });
    }
    next();
  } catch {
    return res.status(500).json({ error: "Authorization check failed" });
  }
}

// ─── Travel-mode / booking-type guard for hotels ─────────────────────────────
async function requireHotelAccess(req: any, res: any, next: any) {
  try {
    const roles: string[] = (req.user?.roles || []).map((r: string) =>
      String(r).toUpperCase()
    );
    if (roles.includes("ADMIN") || roles.includes("SUPERADMIN") || roles.includes("HR")) {
      return next();
    }

    const userId = req.user?.id || req.user?._id;
    const user = await User.findOne({ _id: userId, workspaceId: req.workspaceObjectId })
      .select("sbtBookingType customerId")
      .lean();

    if (!user) return res.status(401).json({ error: "User not found" });

    // Check user-level sbtBookingType
    if ((user as any).sbtBookingType &&
        (user as any).sbtBookingType !== "hotel" &&
        (user as any).sbtBookingType !== "both") {
      return res.status(403).json({
        error: "Hotel booking not permitted for your account",
        code: "HOTEL_ACCESS_DENIED",
      });
    }

    // Check workspace-level travelMode
    if ((user as any).customerId) {
      const workspace = await CustomerWorkspace.findOne({ customerId: (user as any).customerId })
        .select("travelMode")
        .lean();

      if (workspace?.travelMode === "FLIGHTS_ONLY") {
        return res.status(403).json({
          error: "Hotel booking not enabled for your company",
          code: "COMPANY_HOTEL_ACCESS_DENIED",
        });
      }

      if (workspace?.travelMode === "APPROVAL_FLOW") {
        return res.status(403).json({
          error: "Direct booking not permitted. Please use the approval flow.",
          code: "APPROVAL_FLOW_REQUIRED",
        });
      }
    }

    next();
  } catch {
    return res.status(500).json({ error: "Access check failed" });
  }
}

// ─── TBO Hotel API Auth (Basic) ──────────────────────────────────────────────

function hotelAuthHeader(): string {
  const creds = Buffer.from(
    `${process.env.TBO_HOTEL_USERNAME}:${process.env.TBO_HOTEL_PASSWORD}`
  ).toString("base64");
  return `Basic ${creds}`;
}

function hotelStaticAuthHeader(): string {
  const creds = Buffer.from(
    `${process.env.TBO_HOTEL_STATIC_USERNAME}:${process.env.TBO_HOTEL_STATIC_PASSWORD}`
  ).toString("base64");
  return `Basic ${creds}`;
}

// ─── In-memory caches ────────────────────────────────────────────────────────

interface CityEntry {
  CityId: string;
  CityName: string;
  CountryCode: string;
  CountryName: string;
}

const cityCache = new Map<string, { data: CityEntry[]; ts: number }>();
const CITY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

const searchCache = new Map<string, { data: unknown; ts: number }>();
const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5min

const hotelDetailsCache = new Map<string, { data: any; ts: number }>();
const DETAILS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ─── Hotel name search index ──────────────────────────────────────────────────

interface HotelIndexEntry extends HotelCodeEntry {
  CityCode: string;
}
const hotelNameIndex: HotelIndexEntry[] = [];
const hotelIndexedCities = new Set<string>();

const HOTEL_INDEX_CITIES = [
  { code: "130443", country: "IN" }, // New Delhi
  { code: "144306", country: "IN" }, // Mumbai
  { code: "111124", country: "IN" }, // Bengaluru
  { code: "127343", country: "IN" }, // Chennai
  { code: "145710", country: "IN" }, // Hyderabad
];

async function ensureHotelIndexed(cityCode: string, countryCode: string): Promise<void> {
  if (hotelIndexedCities.has(cityCode)) return;
  hotelIndexedCities.add(cityCode);
  try {
    const hotels = await fetchHotelCodeList(cityCode, countryCode);
    for (const h of hotels) hotelNameIndex.push({ ...h, CityCode: cityCode });
  } catch (err) {
    console.error(`[HOTEL-INDEX] Failed to index city ${cityCode}:`, err instanceof Error ? err.message : String(err));
    hotelIndexedCities.delete(cityCode);
  }
}

/** Resolve a city name → TBO CityId using the already-cached Indian city list. */
async function resolveCityCode(cityName: string): Promise<string | null> {
  try {
    const cities = await fetchCityList("IN");
    const lc = cityName.toLowerCase();
    const match = cities.find(c => c.CityName.toLowerCase() === lc)
      || cities.find(c => c.CityName.toLowerCase().includes(lc));
    return match?.CityId ?? null;
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchCityList(countryCode: string): Promise<CityEntry[]> {
  const cached = cityCache.get(countryCode);
  if (cached && Date.now() - cached.ts < CITY_CACHE_TTL) return cached.data;

  const tboPayload = { CountryCode: countryCode };
  const t0 = Date.now();
  const res = await fetch(
    `https://api.tbotechnology.in/TBOHolidays_HotelAPI/CityList?CountryCode=${countryCode}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: hotelStaticAuthHeader(),
      },
      body: JSON.stringify(tboPayload),
    }
  );
  const data = (await res.json()) as {
    CityList?: { Code: string; Name: string }[];
  };
  logTBOCall({ method: "HotelCityList", traceId: `city-${countryCode}`, request: tboPayload, response: data, durationMs: Date.now() - t0 });
  // TBO returns { Code, Name } — normalize to our CityEntry shape
  const cities: CityEntry[] = (data?.CityList || []).map((c) => ({
    CityId: c.Code,
    CityName: c.Name,
    CountryCode: countryCode,
    CountryName: "",
  }));
  cityCache.set(countryCode, { data: cities, ts: Date.now() });
  return cities;
}

// Pre-load Indian cities and popular hotel names on startup
(async () => {
  try {
    await fetchCityList("IN");
    sbtLogger.info("Indian city list cached on startup");

    // Fixed codes for top metro cities
    for (const { code, country } of HOTEL_INDEX_CITIES) {
      await ensureHotelIndexed(code, country);
    }

    // Dynamically resolve additional city codes from the cached TBOCityList
    const additionalCityNames = ["Goa", "Jaipur", "Agra", "Kolkata", "Pune", "Ahmedabad"];
    for (const cityName of additionalCityNames) {
      const code = await resolveCityCode(cityName);
      if (code) {
        await ensureHotelIndexed(code, "IN");
      } else {
        sbtLogger.warn(`[HOTEL-INDEX] Could not resolve CityCode for: ${cityName}`);
      }
    }

    console.log('[HOTEL-INDEX] Loaded', hotelNameIndex.length, 'hotels for name search');
    sbtLogger.info(`Hotel name index built: ${hotelNameIndex.length} hotels`);
  } catch (e) {
    sbtLogger.warn("Failed to pre-load hotel data", { error: e instanceof Error ? e.message : String(e) });
  }
})();

interface HotelCodeEntry {
  HotelCode: string;
  HotelName: string;
  Latitude: string;
  Longitude: string;
  HotelRating: string;
  Address: string;
  CityName: string;
  CountryName: string;
  CountryCode: string;
}

async function fetchHotelCodeList(
  cityCode: string,
  countryCode: string
): Promise<HotelCodeEntry[]> {
  const tboPayload = { CityCode: cityCode, CountryCode: countryCode };
  const t0 = Date.now();
  const res = await fetch(
    "https://api.tbotechnology.in/TBOHolidays_HotelAPI/TBOHotelCodeList",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: hotelStaticAuthHeader(),
      },
      body: JSON.stringify(tboPayload),
    }
  );
  const data = (await res.json()) as { Hotels?: HotelCodeEntry[] };
  logTBOCall({ method: "HotelCodeList", traceId: `codes-${cityCode}`, request: tboPayload, response: { hotelCount: data?.Hotels?.length ?? 0 }, durationMs: Date.now() - t0 });
  return data?.Hotels || [];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

// ─── 1. GET /cities?q=Mumbai ─────────────────────────────────────────────────

router.get("/cities", async (req: any, res: any) => {
  try {
    if (process.env.TBO_ENV === "mock") {
      const q = (req.query.q as string || "").toLowerCase();
      const cityMatches = MOCK_CITIES.filter(c =>
        c.CityName.toLowerCase().includes(q) ||
        c.CountryName.toLowerCase().includes(q)
      ).slice(0, 10).map(c => ({ type: "city" as const, CityId: c.CityCode, ...c }));
      return res.json(cityMatches);
    }

    const q = ((req.query.q as string) || "").toLowerCase().trim();
    if (!q || q.length < 2) return res.json([]);

    // ── City search (TBO) — failures must not block hotel name results ──────────
    type CityResult = { type: "city"; CityId: string; CityName: string; CountryCode: string; CountryName: string };
    let cityResults: CityResult[] = [];
    try {
      // Search Indian cities first (uses 24h in-memory cache)
      const cities = await fetchCityList("IN");
      let matches = cities.filter((c) => c.CityName.toLowerCase().includes(q));

      // If no Indian results, search a few international countries
      if (!matches.length && q.length > 2) {
        const countryRes = await fetch(
          "https://api.tbotechnology.in/TBOHolidays_HotelAPI/CountryList",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: hotelStaticAuthHeader(),
            },
            body: "{}",
          }
        );
        const countryData = (await countryRes.json()) as {
          CountryList?: { Code: string; Name: string }[];
        };
        const countries = (countryData?.CountryList || [])
          .filter((c) => c.Code !== "IN")
          .slice(0, 5);

        for (const country of countries) {
          const intlCities = await fetchCityList(country.Code);
          const intlMatches = intlCities.filter((c) =>
            c.CityName.toLowerCase().includes(q)
          );
          matches.push(...intlMatches);
          if (matches.length >= 10) break;
        }
      }

      cityResults = matches.slice(0, 10).map(c => ({ type: "city" as const, ...c }));
    } catch (cityErr) {
      console.error(
        "[HOTEL-SEARCH] City search failed, returning hotel-only results:",
        cityErr instanceof Error ? cityErr.message : String(cityErr)
      );
    }

    // ── Hotel name search — always runs, uses local in-memory index ──────────────
    const hotelMatches = q.length >= 3
      ? hotelNameIndex
          .filter(h => h.HotelName.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 8)
          .map(h => ({
            type: "hotel" as const,
            HotelCode: h.HotelCode,
            HotelName: h.HotelName,
            CityName: h.CityName,
            CityCode: h.CityCode,
          }))
      : [];


    res.json([...cityResults, ...hotelMatches]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "City search failed";
    sbtLogger.error("Hotel city search failed", { error: msg });
    res.status(500).json({ error: msg });
  }
});

// ─── 2. POST /search ─────────────────────────────────────────────────────────

router.post("/search", requireSBT, requireHotelAccess, async (req: any, res: any) => {
  try {
    if (process.env.TBO_ENV === "mock") {
      const searchId = Math.random().toString(36).slice(2, 10);
      return res.json({
        success: true,
        searchId,
        hotels: MOCK_HOTEL_RESULTS,
        source: "mock",
      });
    }

    const {
      CityCode,
      CityName,
      CheckIn,
      CheckOut,
      Rooms,
      GuestNationality = "IN",
      CountryCode = "IN",
      HotelCodes: directHotelCodes,
    } = req.body;

    const directCodes: string[] = Array.isArray(directHotelCodes) ? directHotelCodes : [];

    if (!directCodes.length && !CityCode) {
      return res.status(400).json({ error: "CityCode or HotelCodes required" });
    }
    if (!CheckIn || !CheckOut) {
      return res.status(400).json({ error: "CheckIn and CheckOut required" });
    }

    // Build hotel metadata map and collect codes to search
    const hotelMeta = new Map<string, HotelCodeEntry>();
    let allCodes: string[];

    if (directCodes.length) {
      // Hotel name search: use provided codes directly, pull metadata from index
      for (const entry of hotelNameIndex) {
        if (directCodes.includes(entry.HotelCode)) hotelMeta.set(entry.HotelCode, entry);
      }
      allCodes = directCodes;
    } else {
      // City search: fetch all hotels in the city
      const hotelList = await fetchHotelCodeList(CityCode, CountryCode);
      if (!hotelList.length) {
        return res.json({ Hotels: [], SearchId: randomUUID(), CityName });
      }
      for (const h of hotelList) hotelMeta.set(h.HotelCode, h);
      allCodes = hotelList.map((h) => h.HotelCode);
    }

    // 2. Split hotel codes into chunks of 100
    const chunks = chunk(allCodes, 100);

    // 3. Build PaxRooms
    const PaxRooms = (Rooms || [{ Adults: 1, Children: 0, ChildrenAges: null }]).map(
      (r: any) => ({
        Adults: r.Adults || r.adults || 1,
        Children: r.Children || r.children || 0,
        ChildrenAges: r.ChildrenAges || r.childrenAges || null,
      })
    );

    // 4. Fire parallel search requests (max 5 concurrent)
    const MAX_CONCURRENT = 5;
    const allResults: any[] = [];
    const searchTraceId = `hotel-search-${randomUUID().slice(0, 8)}`;

    for (let i = 0; i < chunks.length; i += MAX_CONCURRENT) {
      const batch = chunks.slice(i, i + MAX_CONCURRENT);
      const promises = batch.map(async (hotelCodeChunk, batchIdx) => {
        const tboPayload = {
          CheckIn,
          CheckOut,
          HotelCodes: hotelCodeChunk.join(","),
          GuestNationality,
          PaxRooms,
          ResponseTime: 23,
          IsDetailedResponse: true,
          Filters: { Refundable: false, NoOfRooms: 0, MealType: "All" },
        };
        const t0 = Date.now();
        try {
          const r = await fetch("https://affiliate.tektravels.com/HotelAPI/Search", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: hotelAuthHeader(),
            },
            body: JSON.stringify(tboPayload),
          });
          const data = await r.json();
          logTBOCall({ method: `HotelSearch_batch${i + batchIdx}`, traceId: searchTraceId, request: tboPayload, response: data, durationMs: Date.now() - t0 });
          return data;
        } catch {
          logTBOCall({ method: `HotelSearch_batch${i + batchIdx}`, traceId: searchTraceId, request: tboPayload, response: { error: "fetch failed" }, durationMs: Date.now() - t0 });
          return null;
        }
      });
      const results = await Promise.all(promises);
      for (const r of results) {
        const d = r as any;
        if (d?.HotelResult) allResults.push(...d.HotelResult);
        else if (d?.HotelSearchResult?.HotelResults)
          allResults.push(...d.HotelSearchResult.HotelResults);
      }
    }

    // 5. Merge metadata from HotelCodeList into search results
    for (const hotel of allResults) {
      const meta = hotelMeta.get(hotel.HotelCode);
      if (meta) {
        hotel.HotelName = meta.HotelName;
        hotel.HotelRating = meta.HotelRating;
        hotel.Address = meta.Address;
        hotel.Latitude = meta.Latitude;
        hotel.Longitude = meta.Longitude;
        hotel.CityName = meta.CityName;
        hotel.CountryName = meta.CountryName;
      }
    }

    // 6. Sort by cheapest room TotalFare ascending
    allResults.sort((a, b) => {
      const fa =
        a.Rooms?.[0]?.TotalFare ?? a.TotalFare ?? a.MinimumRate ?? Infinity;
      const fb =
        b.Rooms?.[0]?.TotalFare ?? b.TotalFare ?? b.MinimumRate ?? Infinity;
      return fa - fb;
    });

    // 7. Return clean error if TBO returned no availability
    if (allResults.length === 0) {
      return res.status(404).json({
        message: "No hotels found for selected dates. Please try different dates or destination.",
        code: "NO_HOTELS_FOUND",
      });
    }

    const searchId = randomUUID();
    searchCache.set(searchId, { data: allResults, ts: Date.now() });

    // Apply margin to display prices (net prices stay in _net* fields for TBO booking)
    const margins = await getMarginConfig();
    let hotelsToSend: any[] = allResults;
    if (margins.enabled) {
      const isHotelDomestic = (CountryCode || "IN") === "IN";
      const marginPct = isHotelDomestic ? margins.hotel.domestic : margins.hotel.international;
      if (marginPct > 0) {
        hotelsToSend = allResults.map((hotel: any) => ({
          ...hotel,
          Rooms: hotel.Rooms?.map((room: any) => {
            const net = room.TotalFare ?? 0;
            const display = applyMargin(net, marginPct);
            return {
              ...room,
              _netTotalFare: net,
              _netAmount: room.NetAmount ?? net,
              TotalFare: display,
              TotalTax: applyMargin(room.TotalTax ?? 0, marginPct),
              _marginPercent: marginPct,
              _marginAmount: display - net,
            };
          }),
        }));
      }
    }

    res.json({
      TraceId: "",
      Hotels: hotelsToSend,
      SearchId: searchId,
      CityName: CityName || "",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Hotel search failed";
    sbtLogger.error("Hotel search failed", { userId: req.user?.id, error: msg });
    res.status(500).json({ error: msg });
  }
});

// ─── 3. POST /prebook ────────────────────────────────────────────────────────

router.post("/prebook", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    if (process.env.TBO_ENV === "mock") {
      return res.json({
        success: true,
        prebookId: "MOCK-PREBOOK-" + Date.now(),
        status: "Prebooked",
        source: "mock",
      });
    }

    const { BookingCode, searchPrice } = req.body;
    if (!BookingCode) return res.status(400).json({ error: "BookingCode required" });

    const tboPayload = { BookingCode };
    const t0 = Date.now();
    const tboRes = await fetch(
      "https://affiliate.tektravels.com/HotelAPI/PreBook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: hotelAuthHeader(),
        },
        body: JSON.stringify(tboPayload),
      }
    );
    const data = (await tboRes.json()) as any;
    logTBOCall({ method: "HotelPreBook", traceId: BookingCode.split("!TB!")[4] || "hotel-prebook", request: tboPayload, response: data, durationMs: Date.now() - t0 });

    const prebookHotel = data?.HotelResult?.[0] || data?.PreBookResult?.HotelResult?.[0];
    const room0 = prebookHotel?.Rooms?.[0];

    // Compare PreBook NetAmount against the search price the user saw
    const netAmount = room0?.NetAmount ?? room0?.TotalFare ?? 0;
    const recommendedSellingRate = room0?.RecommendedSellingRate ?? null;
    const priceChanged = typeof searchPrice === "number" && searchPrice > 0
      ? netAmount !== searchPrice
      : false;
    const priceDiff = priceChanged ? netAmount - searchPrice : 0;

    // Apply margin to display TotalFare (NetAmount stays original for TBO Book)
    const prebookMargins = await getMarginConfig();
    let displayTotalFare = room0?.TotalFare ?? netAmount;
    let prebookMarginPct = 0;
    if (prebookMargins.enabled) {
      // Default to domestic (IN) — caller can pass countryCode in body for international
      const isHotelDomestic = ((req.body as any).countryCode || "IN") === "IN";
      prebookMarginPct = isHotelDomestic
        ? prebookMargins.hotel.domestic
        : prebookMargins.hotel.international;
      if (prebookMarginPct > 0) {
        displayTotalFare = applyMargin(room0?.TotalFare ?? netAmount, prebookMarginPct);
      }
    }

    res.json({
      ...data,
      priceChanged,
      priceDiff,
      netAmount,
      recommendedSellingRate,
      displayTotalFare,
      marginPercent: prebookMarginPct,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "PreBook failed";
    sbtLogger.error("Hotel prebook failed", { error: msg });
    res.status(500).json({ error: msg });
  }
});

// ─── 4. POST /payment/create-order ───────────────────────────────────────────

router.post("/payment/create-order", requireAuth, async (req: any, res: any) => {
  try {
    const { amount, currency = "INR", receipt } = req.body;
    if (!amount || amount <= 0)
      return res.status(400).json({ error: "Invalid amount" });

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return res
        .status(503)
        .json({ error: "Payment gateway not configured" });
    }

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const orderRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100),
        currency,
        receipt: receipt || `sbt_htl_${Date.now()}`,
      }),
    });
    const order = (await orderRes.json()) as any;
    if (!orderRes.ok) {
      return res.status(502).json({
        error: order?.error?.description || "Razorpay order creation failed",
      });
    }
    res.json({
      ok: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId,
    });
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Payment order creation failed";
    res.status(500).json({ error: msg });
  }
});

// ─── 5. POST /payment/verify ─────────────────────────────────────────────────

router.post("/payment/verify", requireAuth, async (req: any, res: any) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res
        .status(400)
        .json({ error: "Missing payment verification fields" });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res
        .status(503)
        .json({ error: "Payment gateway not configured" });
    }

    const { createHmac } = await import("crypto");
    const expectedSignature = createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res
        .status(400)
        .json({ error: "Payment verification failed — signature mismatch" });
    }

    res.json({ ok: true, verified: true });
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Payment verification failed";
    res.status(500).json({ error: msg });
  }
});

// ─── 6. POST /book ───────────────────────────────────────────────────────────

router.post("/book", requireSBT, requireHotelAccess, async (req: any, res: any) => {
  try {
    const {
      BookingCode,
      GuestNationality: _reqNationality,
      NetAmount,
      Guests,
      UserIp = "1.1.1.1",
      PaymentId,
      bookingMode = "voucher",
    } = req.body;

    // Derive GuestNationality: lead guest in HotelRoomsDetails > explicit field > "IN"
    const _allGuests: any[] =
      (req.body.HotelRoomsDetails as any[] | undefined)?.flatMap((r: any) => r.Guests || []) ??
      (Guests as any[] | undefined) ??
      [];
    const _leadGuest = _allGuests.find((g: any) => g.LeadPassenger) ?? _allGuests[0];
    const GuestNationality: string = _leadGuest?.Nationality || _reqNationality || "IN";

    if (!BookingCode) return res.status(400).json({ error: "BookingCode required" });

    const mapGuest = (g: any) => ({
      Title: g.Title || "Mr",
      FirstName: g.FirstName?.substring(0, 25),
      LastName: g.LastName?.substring(0, 25),
      MiddleName: "",
      Phoneno: g.Phone || "",
      Email: g.Email || "",
      PaxType: g.PaxType || 1,
      LeadPassenger: g.LeadPassenger || false,
      Age: g.PaxType === 2 ? (g.Age || 8) : 0,
      PassportNo: g.PassportNo || "",
      PassportIssueDate: g.PassportIssueDate || "0001-01-01T00:00:00",
      PassportExpDate: g.PassportExpDate || "0001-01-01T00:00:00",
      PAN: g.PAN || "",
      CorporatePAN: g.CorporatePAN || "",
    });

    const HotelRoomsDetails = req.body.HotelRoomsDetails
      ? (req.body.HotelRoomsDetails as any[]).map((room: any) => ({
          HotelPassenger: (room.Guests || []).map(mapGuest),
        }))
      : [{ HotelPassenger: (Guests || []).map(mapGuest) }];

    const { DepartureCity, DepartureDate, FlightNumber } = req.body as any;

    const clientRef = `PLM-${Date.now()}`;
    const tboPayload: Record<string, unknown> = {
      EndUserIp: UserIp,
      BookingCode,
      ClientReferenceId: clientRef,
      GuestNationality,
      IsVoucherBooking: bookingMode !== "hold",
      RequestedBookingMode: 5,
      NetAmount,
      HotelRoomsDetails,
    };
    if (DepartureCity) {
      tboPayload.DepartureCity = DepartureCity;
      tboPayload.DepartureDate = DepartureDate || "";
      tboPayload.FlightNumber = FlightNumber || "";
    }

    // Helper: call GetBookingDetail to verify actual booking status
    async function verifyBookingStatus(bookingId: number): Promise<any> {
      const detailPayload = { EndUserIp: "1.1.1.1", BookingId: bookingId };
      const dt0 = Date.now();
      const detailRes = await fetch(
        "https://hotelbe.tektravels.com/hotelservice.svc/rest/GetBookingDetail/",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: hotelAuthHeader(),
          },
          body: JSON.stringify(detailPayload),
        }
      );
      const detailData = (await detailRes.json()) as any;
      logTBOCall({ method: "HotelGetBookingDetail", traceId: `hotel-book-verify-${bookingId}`, request: detailPayload, response: detailData, durationMs: Date.now() - dt0 });
      return detailData?.GetBookingDetailResult || detailData?.BookResult || detailData;
    }

    // Helper: send success response and (if not hold) fire-and-forget voucher generation
    async function sendSuccessAndVoucher(result: any, data: any) {
      const isHeld = bookingMode === "hold";

      // For hold bookings: Book response rarely includes LastVoucherDate.
      // Call GetBookingDetail immediately to retrieve it.
      if (isHeld && result?.BookingId) {
        try {
          const details = await verifyBookingStatus(Number(result.BookingId));
          const detailVoucherDate =
            details?.LastVoucherDate ??
            details?.HotelRoomsDetails?.[0]?.LastVoucherDate ??
            null;
          if (detailVoucherDate && !result.LastVoucherDate) {
            result = { ...result, LastVoucherDate: detailVoucherDate };
          }
        } catch (detailErr) {
          console.warn('[HOLD-BOOK] GetBookingDetail for LastVoucherDate failed:', detailErr);
        }
      }


      const lastVoucherDate =
        result?.LastVoucherDate ??
        result?.LastCancellationDate ??
        result?.VoucherDate ??
        null;

      // Invalidate search cache so next search shows fresh availability
      searchCache.clear();

      res.json({
        ok: true,
        bookingId: String(result?.BookingId ?? ""),
        BookingId: result?.BookingId ?? "",
        ConfirmationNo: result?.ConfirmationNo ?? "",
        BookingRefNo: result?.BookingRefNo ?? "",
        HotelBookingStatus: result?.HotelBookingStatus ?? result?.BookingStatus ?? "",
        PaymentId,
        isHeld,
        lastVoucherDate,
        raw: data,
      });

      const tboBookingId = Number(result?.BookingId);
      if (tboBookingId && !isHeld) {
        generateHotelVoucher(tboBookingId)
          .then(async (voucherRes) => {
            try {
              await SBTHotelBooking.findOneAndUpdate(
                { bookingId: String(tboBookingId) },
                {
                  tboVoucherData: voucherRes,
                  voucherStatus: voucherRes?.Response?.ResponseStatus === 1
                    ? "GENERATED" : "FAILED",
                }
              );
            } catch { /* silent */ }
          })
          .catch(() => {});
      }

      sbtLogger.info("Hotel booking TBO response stored", {
        BookingId: result?.BookingId, isHeld, userId: req.user?.id,
      });
    }

    const t0 = Date.now();
    let data: any;
    let bookTimedOut = false;

    try {
      const bookController = new AbortController();
      const bookTimer = setTimeout(() => bookController.abort(), 90_000);
      try {
        const tboRes = await fetch(
          "https://hotelbe.tektravels.com/hotelservice.svc/rest/book/",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: hotelAuthHeader(),
            },
            body: JSON.stringify(tboPayload),
            signal: bookController.signal,
          }
        );
        data = (await tboRes.json()) as any;
      } finally {
        clearTimeout(bookTimer);
      }
    } catch (bookErr: any) {
      const isTimeout = bookErr?.name === "AbortError";
      bookTimedOut = true;
      sbtLogger.warn("TBO Hotel Book call failed, verifying via GetBookingDetail", {
        userId: req.user?.id, isTimeout, error: bookErr?.message, clientRef,
      });
      logTBOCall({ method: "HotelBook", traceId: `hotel-book-${clientRef}`, request: tboPayload, response: { error: bookErr?.message, isTimeout }, durationMs: Date.now() - t0 });
    }

    // Happy path: Book call succeeded with a response
    if (data && !bookTimedOut) {
      const bookTraceId = data?.BookResult?.TraceId || BookingCode.split("!TB!")[4] || "hotel-book";
      logTBOCall({ method: "HotelBook", traceId: bookTraceId, request: tboPayload, response: data, durationMs: Date.now() - t0 });


      const result = data?.BookResult || data;
      const bookingId = Number(result?.BookingId);
      const status = (result?.HotelBookingStatus || result?.BookingStatus || "").toLowerCase();

      // TBO returns BookingId: 0 and null status when the booking is rejected
      // (e.g. expired BookingCode, insufficient inventory, session timeout).
      // Treat this as a hard failure — never surface it as success.
      if (!bookingId && !status) {
        const tboError =
          result?.Error?.ErrorMessage ||
          data?.BookResult?.Error?.ErrorMessage ||
          data?.Error?.ErrorMessage ||
          "TBO rejected the booking (BookingId: 0)";
        const tboCode =
          result?.Error?.ErrorCode ??
          data?.BookResult?.Error?.ErrorCode ??
          data?.Error?.ErrorCode ??
          null;
        sbtLogger.error("Hotel booking rejected by TBO — BookingId: 0", {
          tboError, tboCode, bookingMode, userId: req.user?.id, BookingCode,
        });
        return res.status(502).json({
          ok: false,
          error: "Hotel booking failed at supplier",
          tboError,
          tboCode,
          BookingId: 0,
        });
      }

      // If TBO returned a BookingId but status is unclear, verify
      if (bookingId && status !== "confirmed" && status !== "vouchered") {
        try {
          const verified = await verifyBookingStatus(bookingId);
          const verifiedStatus = (verified?.HotelBookingStatus || verified?.BookingStatus || "").toLowerCase();
          if (verifiedStatus === "confirmed" || verifiedStatus === "vouchered") {
            return sendSuccessAndVoucher(verified, data);
          }
        } catch { /* fall through to return original result */ }
      }

      return sendSuccessAndVoucher(result, data);
    }

    // Timeout/error path: verify booking status via GetBookingDetail
    // TBO may have processed the booking despite the timeout
    // We don't have a BookingId yet, so we need to search by ClientReferenceId
    // Unfortunately GetBookingDetail requires BookingId, so we check if the
    // error response contained a partial BookingId
    const partialBookingId = Number(data?.BookResult?.BookingId || data?.BookingId || 0);

    if (partialBookingId) {
      try {
        const verified = await verifyBookingStatus(partialBookingId);
        const verifiedStatus = (verified?.HotelBookingStatus || verified?.BookingStatus || "").toLowerCase();

        if (verifiedStatus === "confirmed" || verifiedStatus === "vouchered") {
          sbtLogger.info("Hotel booking confirmed via GetBookingDetail after timeout", {
            BookingId: partialBookingId, userId: req.user?.id,
          });
          return sendSuccessAndVoucher(verified, { recovered: true, original: data });
        }

        if (verifiedStatus === "failed" || verifiedStatus === "cancelled") {
          return res.status(502).json({
            ok: false,
            error: `Booking ${verifiedStatus} — ${verified?.FailureReason || "TBO did not confirm the reservation"}`,
            HotelBookingStatus: verifiedStatus,
            BookingId: partialBookingId,
          });
        }

        // Status is pending or unknown
        return res.status(202).json({
          ok: false,
          status: "BOOKING_UNCERTAIN",
          error: "Booking status is uncertain — please contact support",
          HotelBookingStatus: verifiedStatus || "unknown",
          BookingId: partialBookingId,
        });
      } catch (verifyErr: any) {
        sbtLogger.error("GetBookingDetail also failed after Book timeout", {
          BookingId: partialBookingId, userId: req.user?.id,
          error: verifyErr?.message,
        });
        return res.status(202).json({
          ok: false,
          status: "BOOKING_UNCERTAIN",
          error: "Booking status could not be verified — please contact support",
          BookingId: partialBookingId,
        });
      }
    }

    // No BookingId at all — booking likely never reached TBO
    return res.status(202).json({
      ok: false,
      status: "BOOKING_UNCERTAIN",
      error: "Booking timed out and status could not be verified — please contact support",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Hotel booking failed";
    sbtLogger.error("Hotel booking failed", { userId: req.user?.id, error: msg });
    res.status(500).json({ error: msg });
  }
});

// ─── 6b. GET /voucher/:bookingId ─────────────────────────────────────────────

router.get("/voucher/:bookingId", requireAuth, async (req: any, res: any) => {
  try {
    const booking = await SBTHotelBooking.findOne({ bookingId: req.params.bookingId });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    if (booking.tboVoucherData) {
      return res.json({
        ok: true,
        voucherStatus: booking.voucherStatus,
        voucherData: booking.tboVoucherData,
      });
    }

    // Voucher not generated yet — try generating now
    const numericId = Number(req.params.bookingId);
    if (!numericId) return res.status(400).json({ error: "Invalid booking ID" });

    const voucherRes = await generateHotelVoucher(numericId);
    const status = voucherRes?.Response?.ResponseStatus === 1 ? "GENERATED" : "FAILED";

    await SBTHotelBooking.findByIdAndUpdate(booking._id, {
      tboVoucherData: voucherRes,
      voucherStatus: status,
    }).catch(() => {});

    res.json({ ok: true, voucherStatus: status, voucherData: voucherRes });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Voucher retrieval failed";
    res.status(500).json({ error: msg });
  }
});

// ─── 6c. POST /bookings/:id/generate-voucher ─────────────────────────────────

router.post("/bookings/:id/generate-voucher", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    const booking = await SBTHotelBooking.findOne({
      _id: req.params.id,
      userId: req.user?._id ?? req.user?.id,
    });
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (!booking.isHeld) return res.status(400).json({ error: "Booking is not in held state" });

    if (booking.lastVoucherDate && new Date() > booking.lastVoucherDate) {
      return res.status(400).json({ error: "Hold period has expired — booking may have been auto-cancelled by the supplier" });
    }

    const numericId = Number(booking.bookingId);
    if (!numericId) return res.status(400).json({ error: "Invalid booking ID" });

    // ── Optional payment before generating voucher ────────────────────
    const { paymentId, walletPayment } = req.body as { paymentId?: string; walletPayment?: boolean };

    if (walletPayment && req.workspaceObjectId) {
      // Deduct from agency wallet before calling TBO
      try {
        await CustomerWorkspace.findOneAndUpdate(
          { _id: req.workspaceObjectId },
          { $inc: { 'sbtOfficialBooking.currentMonthSpend': booking.netAmount ?? 0 } },
          { runValidators: false },
        );
      } catch (walletErr) {
        sbtLogger.error('[GEN-VOUCHER] Failed to deduct wallet spend', { bookingId: booking.bookingId, error: walletErr });
      }
    }

    if (paymentId) {
      // Save Razorpay payment ID against the booking before generating
      await SBTHotelBooking.findByIdAndUpdate(booking._id, { razorpayPaymentId: paymentId }).catch(() => {});
    }

    const voucherRes = await generateHotelVoucher(numericId);

    // ── Detect ErrorCode 2 = genuine agency balance insufficient ─────
    const gvr = voucherRes?.GenerateVoucherResult;
    const tboErrorCode = gvr?.Error?.ErrorCode;
    const tboErrorMsg = gvr?.Error?.ErrorMessage || "";
    const isBalanceError =
      tboErrorCode === 2 &&
      (tboErrorMsg.toLowerCase().includes("balance") ||
       tboErrorMsg.toLowerCase().includes("insufficient") ||
       tboErrorMsg.toLowerCase().includes("credit"));

    if (isBalanceError) {
      console.log('[GEN-VOUCHER] TBO agency balance insufficient', { tboErrorCode, tboErrorMsg });
      return res.status(402).json({
        requiresPayment: true,
        amount: booking.netAmount ?? booking.totalFare ?? 0,
        bookingId: booking._id,
        message: "Agency wallet balance insufficient to confirm this booking",
        code: "PAYMENT_REQUIRED",
        tboError: tboErrorMsg,
      });
    }

    const success = gvr?.ResponseStatus === 1;

    await SBTHotelBooking.findByIdAndUpdate(booking._id, {
      isHeld: false,
      voucherGeneratedAt: new Date(),
      status: success ? "CONFIRMED" : booking.status,
      tboVoucherData: voucherRes,
      voucherStatus: success ? "GENERATED" : "FAILED",
      isVouchered: success,
    });

    if (!success) {
      const errMsg = tboErrorMsg || "Voucher generation failed at supplier";
      console.log('[GEN-VOUCHER] failed — TBO error:', errMsg, '| ResponseStatus:', gvr?.ResponseStatus);
      return res.status(502).json({ error: errMsg, voucherData: voucherRes });
    }

    sbtLogger.info("Hotel hold booking vouchered", { bookingId: booking.bookingId, userId: req.user?.id });
    res.json({ ok: true, voucherStatus: "GENERATED", voucherData: voucherRes });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Voucher generation failed";
    res.status(500).json({ error: msg });
  }
});

// ─── 7. POST /bookings/save ──────────────────────────────────────────────────

router.post("/bookings/save", requireAuth, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const b = req.body;

    // Task 7: Check if webhook already created/confirmed this booking
    if (b.razorpayOrderId) {
      const existing = await SBTHotelBooking.findOne({ razorpayOrderId: b.razorpayOrderId });
      if (existing && existing.status === "CONFIRMED") {
        // Webhook beat the frontend — update with any missing details
        existing.bookingId = b.bookingId || existing.bookingId;
        existing.confirmationNo = b.confirmationNo || existing.confirmationNo;
        existing.bookingRefNo = b.bookingRefNo || existing.bookingRefNo;
        existing.guests = b.guests?.length ? b.guests : existing.guests;
        existing.hotelCode = b.hotelCode || existing.hotelCode;
        existing.hotelName = b.hotelName || existing.hotelName;
        existing.roomName = b.roomName || existing.roomName;
        await existing.save();
        return res.json({ ok: true, booking: existing, webhookRecovered: true });
      }
    }

    const doc = await SBTHotelBooking.create({
      userId,
      customerId: (req.user as any)?.customerId ?? undefined,
      sbtRequestId: b.sbtRequestId || undefined,
      workspaceId: req.workspaceObjectId,
      bookingId: b.bookingId || "",
      confirmationNo: b.confirmationNo || "",
      bookingRefNo: b.bookingRefNo || "",
      hotelCode: b.hotelCode || "",
      hotelName: b.hotelName || "",
      cityName: b.cityName || "",
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      rooms: b.rooms || 1,
      guests: b.guests || [],
      roomName: b.roomName || "",
      mealType: b.mealType || "",
      totalFare: b.totalFare,
      netAmount: b.netAmount || b.totalFare || 0,
      currency: b.currency || "INR",
      isRefundable: b.isRefundable ?? false,
      cancelPolicies: b.cancelPolicies || [],
      status: b.isHeld ? "HELD" : (b.status || "CONFIRMED"),
      failureReason: b.failureReason || "",
      paymentStatus: b.paymentStatus || "paid",
      paymentId: b.paymentId || "",
      razorpayOrderId: b.razorpayOrderId || "",
      razorpayAmount: b.razorpayAmount || 0,
      isVouchered: b.isHeld ? false : (b.isVouchered ?? true),
      isHeld: b.isHeld ?? false,
      lastVoucherDate: b.lastVoucherDate ? new Date(b.lastVoucherDate) : undefined,
      paymentMode: b.paymentMode === "official" ? "official" : "personal",
      raw: b.raw ?? null,
      bookedAt: new Date(),
    });

    // Increment workspace monthly spend for official bookings — never for hold bookings
    if (b.paymentMode === "official" && !b.isHeld && req.workspaceObjectId) {
      try {
        await CustomerWorkspace.findOneAndUpdate(
          { _id: req.workspaceObjectId },
          { $inc: { 'sbtOfficialBooking.currentMonthSpend': b.totalFare ?? 0 } },
          { runValidators: false },
        );
      } catch (spendErr) {
        sbtLogger.error('[OfficialBooking] Failed to track spend', {
          workspaceId: req.workspaceObjectId,
          amount: b.totalFare,
          error: spendErr,
        });
      }
    }

    // If this booking fulfils an SBT request, mark it as BOOKED and notify L1
    if (b.sbtRequestId) {
      try {
        const sbtReq = await scopedFindById(SBTRequest, b.sbtRequestId, req.workspaceObjectId);
        if (sbtReq && sbtReq.status === "PENDING") {
          sbtReq.status = "BOOKED";
          (sbtReq as any).hotelBookingId = doc._id;
          sbtReq.actedAt = new Date();
          await sbtReq.save();

          const requester = await User.findOne({ _id: sbtReq.requesterId, workspaceId: req.workspaceObjectId })
            .select("name email").lean() as any;
          if (requester?.email) {
            const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
            await sendMail({
              to: requester.email,
              subject: `Your hotel has been booked — ${b.hotelName || "Hotel"}`,
              kind: "CONFIRMATIONS",
              html: `
                <h3>Hotel Booking Confirmed</h3>
                <p>Your hotel request has been booked successfully.</p>
                <p><strong>Hotel:</strong> ${b.hotelName || ""}</p>
                <p><strong>Check-in:</strong> ${b.checkIn || ""}</p>
                <p><strong>Check-out:</strong> ${b.checkOut || ""}</p>
                ${b.confirmationNo ? `<p><strong>Confirmation:</strong> ${b.confirmationNo}</p>` : ""}
                <p><a href="${frontendUrl}/sbt/my-requests">View My Requests</a></p>
              `,
            }).catch((e: any) => sbtLogger.warn("Failed to send SBT hotel booked email", { error: e?.message }));
          }
          sbtLogger.info("SBT request marked BOOKED via hotel booking", {
            sbtRequestId: b.sbtRequestId, bookingDocId: doc._id,
          });
        }
      } catch (reqErr: any) {
        sbtLogger.warn("Failed to update SBT request after hotel booking", { error: reqErr?.message });
      }
    }

    res.json({ ok: true, booking: doc });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to save hotel booking";
    res.status(500).json({ error: msg });
  }
});

// ─── 8. GET /bookings ────────────────────────────────────────────────────────

const getHotelBookingsHandler = async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const bookings = await SBTHotelBooking.find({ userId })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ ok: true, bookings });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to list hotel bookings";
    sbtLogger.error("Hotel bookings list failed", { userId: req.user?.id, error: msg });
    res.status(500).json({ error: msg });
  }
};
router.get("/bookings", requireSBT, getHotelBookingsHandler);
router.get("/my-bookings", requireSBT, getHotelBookingsHandler);

// ─── 9a. POST /bookings/sync-all-pending ─────────────────────────────────────

router.post("/bookings/sync-all-pending", requireAuth, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const pendingBookings = await SBTHotelBooking.find({ userId, status: "PENDING" });
    if (pendingBookings.length === 0) {
      return res.json({ ok: true, synced: 0, updated: 0 });
    }

    let updated = 0;
    for (const doc of pendingBookings) {
      if (!doc.bookingId) continue;
      try {
        const detailPayload = { EndUserIp: "1.1.1.1", BookingId: Number(doc.bookingId) || 0 };
        const t0 = Date.now();
        const tboRes = await fetch(
          "https://hotelbe.tektravels.com/hotelservice.svc/rest/GetBookingDetail/",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: hotelAuthHeader(),
            },
            body: JSON.stringify(detailPayload),
          }
        );
        const data = (await tboRes.json()) as any;
        logTBOCall({ method: "HotelGetBookingDetail", traceId: `hotel-sync-${doc.bookingId}`, request: detailPayload, response: data, durationMs: Date.now() - t0 });
        const result = data?.GetBookingDetailResult || data?.BookResult || data;
        const tboStatus = (result?.HotelBookingStatus || result?.BookingStatus || "").toLowerCase();

        let newStatus: string | null = null;
        if (tboStatus === "confirmed") newStatus = "CONFIRMED";
        else if (tboStatus === "cancelled") newStatus = "CANCELLED";
        else if (tboStatus === "failed") newStatus = "FAILED";

        if (newStatus && newStatus !== doc.status) {
          await SBTHotelBooking.findByIdAndUpdate(doc._id, { status: newStatus });
          updated++;
        }
      } catch (e) {
        sbtLogger.warn("Failed to sync hotel booking", { bookingId: doc.bookingId, error: e instanceof Error ? e.message : String(e) });
      }
    }

    res.json({ ok: true, synced: pendingBookings.length, updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Sync failed";
    sbtLogger.error("Hotel sync all pending failed", { error: msg });
    res.status(500).json({ error: msg });
  }
});

// ─── 9b. POST /bookings/:id/sync-status ─────────────────────────────────────

router.post("/bookings/:id/sync-status", requireAuth, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const doc = await SBTHotelBooking.findOne({ _id: req.params.id, userId });
    if (!doc) return res.status(404).json({ error: "Booking not found" });

    if (doc.status === "CONFIRMED" || doc.status === "CANCELLED") {
      return res.json({ ok: true, status: doc.status, updated: false });
    }

    if (!doc.bookingId) {
      return res.json({ ok: true, status: doc.status, updated: false });
    }

    const detailPayload = { EndUserIp: "1.1.1.1", BookingId: Number(doc.bookingId) || 0 };
    const t0 = Date.now();
    const tboRes = await fetch(
      "https://hotelbe.tektravels.com/hotelservice.svc/rest/GetBookingDetail/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: hotelAuthHeader(),
        },
        body: JSON.stringify(detailPayload),
      }
    );
    const data = (await tboRes.json()) as any;
    logTBOCall({ method: "HotelGetBookingDetail", traceId: `hotel-status-${doc.bookingId}`, request: detailPayload, response: data, durationMs: Date.now() - t0 });
    const result = data?.GetBookingDetailResult || data?.BookResult || data;
    const tboStatus = (result?.HotelBookingStatus || result?.BookingStatus || "").toLowerCase();

    let newStatus: string = doc.status;
    if (tboStatus === "confirmed") newStatus = "CONFIRMED";
    else if (tboStatus === "cancelled") newStatus = "CANCELLED";
    else if (tboStatus === "failed") newStatus = "FAILED";

    const didUpdate = newStatus !== doc.status;
    if (didUpdate) {
      await SBTHotelBooking.findByIdAndUpdate(doc._id, { status: newStatus });
    }

    res.json({ ok: true, status: newStatus, updated: didUpdate });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Status sync failed";
    sbtLogger.error("Hotel sync status failed", { bookingId: req.params.id, error: msg });
    res.status(500).json({ error: msg });
  }
});

// ─── 9d. POST /bookings/refund-orphaned ──────────────────────────────────────
// ADMIN ONLY — one-time use for orphaned payment recovery

router.post("/bookings/refund-orphaned", requireAdmin, async (req: any, res: any) => {
  try {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return res.status(503).json({ error: "Razorpay not configured" });
    }

    const orphaned = await SBTHotelBooking.find({
      status: { $in: ["PENDING", "FAILED"] },
      bookingId: "",
      paymentId: { $ne: "" },
    });

    if (orphaned.length === 0) {
      return res.json({ ok: true, refunded: [], message: "No orphaned bookings found" });
    }

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const refunded: { hotelName: string; amount: number; refundId: string; paymentId: string }[] = [];

    for (const doc of orphaned) {
      try {
        const refundRes = await fetch(
          `https://api.razorpay.com/v1/payments/${doc.paymentId}/refund`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${auth}`,
            },
            body: JSON.stringify({
              amount: Math.round(doc.totalFare * 100), // paise
            }),
          }
        );
        const refundData = (await refundRes.json()) as any;

        if (refundData?.id) {
          await SBTHotelBooking.findByIdAndUpdate(doc._id, {
            status: "FAILED",
            failureReason: `TBO booking failed. Razorpay refund initiated: ${refundData.id}`,
          });
          refunded.push({
            hotelName: doc.hotelName,
            amount: doc.totalFare,
            refundId: refundData.id,
            paymentId: doc.paymentId,
          });
          sbtLogger.info("Refund OK", { hotelName: doc.hotelName, amount: doc.totalFare, refundId: refundData.id });
        } else {
          sbtLogger.warn("Refund failed", { hotelName: doc.hotelName, response: refundData });
          await SBTHotelBooking.findByIdAndUpdate(doc._id, {
            status: "FAILED",
            failureReason: `TBO booking failed. Refund attempt failed: ${refundData?.error?.description || JSON.stringify(refundData)}`,
          });
        }
      } catch (e) {
        sbtLogger.error("Refund error", { hotelName: doc.hotelName, error: e instanceof Error ? e.message : String(e) });
      }
    }

    res.json({ ok: true, refunded });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Refund operation failed";
    sbtLogger.error("Hotel refund orphaned failed", { error: msg });
    res.status(500).json({ error: msg });
  }
});

// ─── 9e. POST /bookings/:id/mark-failed ──────────────────────────────────────
// ADMIN ONLY — mark a stuck pending booking as failed

router.post("/bookings/:id/mark-failed", requireAdmin, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const doc = await scopedFindById(SBTHotelBooking, req.params.id, req.workspaceObjectId);
    if (!doc) return res.status(404).json({ error: "Booking not found" });

    if (doc.bookingId && doc.bookingId.length > 0) {
      return res.status(400).json({ error: "Booking has a valid TBO BookingId — cannot mark as failed" });
    }
    if (doc.status !== "PENDING") {
      return res.status(400).json({ error: `Booking status is ${doc.status}, not PENDING` });
    }

    const reason = req.body.reason || "TBO booking failed after payment. No BookingId received.";
    await SBTHotelBooking.findByIdAndUpdate(doc._id, {
      status: "FAILED",
      failureReason: reason,
    });

    res.json({ ok: true, updated: true, bookingId: doc._id, newStatus: "FAILED", reason });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Mark failed operation failed";
    sbtLogger.error("Hotel mark failed error", { bookingId: req.params.id, error: msg });
    res.status(500).json({ error: msg });
  }
});

// ─── 10a. GET /bookings/:id/cancel-preview ──────────────────────────────────

router.get("/bookings/:id/cancel-preview", requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    const booking = await SBTHotelBooking.findOne({ _id: req.params.id, userId });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const today = new Date();
    const totalFare = booking.totalFare || 0;
    const policies = (booking.cancelPolicies || []) as any[];

    let cancellationCharge = 0;
    let chargePercent = 0;
    let isFreeCancel = true;
    let policyApplied = "Free cancellation";

    // Find the latest policy whose FromDate is on or before today
    const sortedPolicies = [...policies].sort(
      (a, b) => new Date(b.FromDate).getTime() - new Date(a.FromDate).getTime()
    );

    let applicablePolicy: any = null;
    for (const policy of sortedPolicies) {
      if (new Date(policy.FromDate) <= today) {
        applicablePolicy = policy;
        break;
      }
    }

    if (applicablePolicy) {
      if (!applicablePolicy.CancellationCharge || applicablePolicy.CancellationCharge === 0) {
        isFreeCancel = true;
        cancellationCharge = 0;
        policyApplied = "Free cancellation — no charges apply";
      } else if (applicablePolicy.ChargeType === "Percentage") {
        chargePercent = applicablePolicy.CancellationCharge;
        cancellationCharge = Math.round((chargePercent / 100) * totalFare);
        isFreeCancel = false;
        policyApplied = `${chargePercent}% cancellation charge applies from ${new Date(applicablePolicy.FromDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;
      } else {
        // Fixed charge
        cancellationCharge = applicablePolicy.CancellationCharge;
        isFreeCancel = cancellationCharge === 0;
        policyApplied = `Fixed charge of ₹${cancellationCharge.toLocaleString("en-IN")} applies`;
      }
    }

    const refundAmount = Math.max(0, totalFare - cancellationCharge);

    return res.json({
      cancellationCharge,
      refundAmount,
      totalFare,
      chargePercent,
      isFreeCancel,
      policyApplied,
      isHeld: booking.isHeld || false,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Preview failed";
    sbtLogger.error("Hotel cancel-preview error", { bookingId: req.params.id, error: msg });
    res.status(500).json({ error: msg });
  }
});

// ─── 10. POST /bookings/:id/cancel ──────────────────────────────────────────

router.post("/bookings/:id/cancel", requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    const doc = await SBTHotelBooking.findOne({ _id: req.params.id, userId });
    if (!doc) return res.status(404).json({ error: "Booking not found" });
    if (doc.status === "CANCELLED")
      return res.status(409).json({ error: "Booking already cancelled" });

    const numericBookingId = Number(doc.bookingId);
    const tokenId = await getTBOToken();
    const endUserIp = process.env.TBO_EndUserIp || "1.1.1.1";

    // ── Step 1: SendChangeRequest ────────────────────────────────────────────
    const changeReqPayload = {
      BookingMode: 5,
      RequestType: 4,
      Remarks: "Cancelled by user",
      BookingId: numericBookingId,
      EndUserIp: endUserIp,
      TokenId: tokenId,
    };
    const t0 = Date.now();
    const changeRes = await fetch(
      "https://HotelBE.tektravels.com/hotelservice.svc/rest/SendChangeRequest",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: hotelAuthHeader(),
        },
        body: JSON.stringify(changeReqPayload),
      }
    );

    const changeRawText = await changeRes.text();
    console.log("[CANCEL] SendChangeRequest response:", changeRawText.substring(0, 500));

    let changeData: any;
    try {
      changeData = JSON.parse(changeRawText);
    } catch {
      throw new Error(`TBO SendChangeRequest returned non-JSON: ${changeRawText.substring(0, 200)}`);
    }
    logTBOCall({ method: "HotelSendChangeRequest", traceId: `hotel-cancel-${doc.bookingId}`, request: changeReqPayload, response: changeData, durationMs: Date.now() - t0 });

    const changeResult = changeData?.HotelChangeRequestResult;
    if (!changeResult || changeResult.ResponseStatus !== 1) {
      throw new Error(`TBO cancel failed: ${changeResult?.Error?.ErrorMessage || "Unknown error"}`);
    }

    const changeRequestId: string = changeResult.ChangeRequestId;
    let cancelStatus: number = changeResult.ChangeRequestStatus;
    let cancellationCharge = 0;
    let refundedAmount = 0;

    // ── Step 2: Poll GetChangeRequestStatus if pending/in-progress ───────────
    if (cancelStatus === 1 || cancelStatus === 2) {
      for (let i = 0; i < 3; i++) {
        await new Promise<void>((r) => setTimeout(r, 2000));

        const statusPayload = {
          BookingMode: 5,
          ChangeRequestId: changeRequestId,
          EndUserIp: endUserIp,
          TokenId: tokenId,
        };
        const t1 = Date.now();
        const statusRes = await fetch(
          "https://HotelBE.tektravels.com/hotelservice.svc/rest/GetChangeRequestStatus",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: hotelAuthHeader(),
            },
            body: JSON.stringify(statusPayload),
          }
        );

        const statusData = (await statusRes.json()) as any;
        logTBOCall({ method: "HotelGetChangeRequestStatus", traceId: `hotel-cancel-status-${doc.bookingId}-${i}`, request: statusPayload, response: statusData, durationMs: Date.now() - t1 });

        const statusResult = statusData?.HotelChangeRequestStatusResult;
        cancelStatus = statusResult?.ChangeRequestStatus;
        cancellationCharge = statusResult?.CancellationCharge || 0;
        refundedAmount = statusResult?.RefundedAmount || 0;

        console.log("[CANCEL] Status poll:", { attempt: i + 1, cancelStatus, cancellationCharge, refundedAmount });

        if (cancelStatus === 3 || cancelStatus === 4) break;
      }
    }

    // ── Evaluate final status ────────────────────────────────────────────────
    if (cancelStatus === 3) {
      // Processed — successfully cancelled
      doc.status = "CANCELLED";
      doc.cancelledAt = new Date();
      doc.cancellationCharge = cancellationCharge;
      doc.refundedAmount = refundedAmount;
      doc.changeRequestId = changeRequestId;
      await doc.save();

      sbtLogger.info("Hotel booking cancelled", {
        module: "sbt",
        bookingId: doc.bookingId,
        changeRequestId,
        cancellationCharge,
        refundedAmount,
        userId,
      });

      // Decrement spend if official booking in same calendar month
      if ((doc as any).paymentMode === "official" && (doc as any).workspaceId) {
        const bookingMonth = doc.createdAt.toISOString().slice(0, 7);
        const currentMonth = new Date().toISOString().slice(0, 7);
        if (bookingMonth === currentMonth) {
          try {
            await CustomerWorkspace.findOneAndUpdate(
              { _id: (doc as any).workspaceId },
              [{ $set: {
                "sbtOfficialBooking.currentMonthSpend": {
                  $max: [0, { $subtract: ["$sbtOfficialBooking.currentMonthSpend", (doc as any).totalFare || 0] }],
                },
              }}],
              { runValidators: false }
            );
            sbtLogger.info("[OfficialBooking] Spend reversed on cancellation", {
              bookingId: doc._id,
              amount: (doc as any).totalFare,
              workspaceId: (doc as any).workspaceId,
            });
          } catch (err) {
            sbtLogger.error("[OfficialBooking] Failed to reverse spend on cancellation", {
              bookingId: doc._id,
              error: err,
            });
          }
        }
      }

      return res.json({ ok: true, cancellationCharge, refundedAmount, changeRequestId });
    } else if (cancelStatus === 4) {
      // Rejected by TBO
      return res.status(409).json({ error: "TBO rejected the cancellation request", changeRequestId });
    } else {
      // Still pending after polling — mark CANCEL_PENDING for ops review
      doc.status = "CANCEL_PENDING";
      doc.changeRequestId = changeRequestId;
      await doc.save();

      return res.status(202).json({
        ok: true,
        pending: true,
        message: "Cancellation is being processed",
        changeRequestId,
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Cancellation failed";
    sbtLogger.error("Hotel cancel failed", { bookingId: req.params.id, error: msg });
    res.status(500).json({ error: msg });
  }
});

// ─── 10a. GET /images?hotelCodes=xxx,yyy ────────────────────────────────────

router.get("/images", async (req: any, res: any) => {
  try {
    const hotelCodes = (req.query.hotelCodes as string) || "";
    if (!hotelCodes) return res.status(400).json({ error: "hotelCodes required" });

    // Split, dedupe, limit to 20 codes
    const codes = [...new Set(hotelCodes.split(",").map((c: string) => c.trim()).filter(Boolean))].slice(0, 20);

    const tboPayload = {
      Hotelcodes: codes.join(","),
      Language: "en",
      IsRoomDetailRequired: false,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let data: any = {};
    try {
      const t0 = Date.now();
      const tboRes = await fetch(
        "https://api.tbotechnology.in/TBOHolidays_HotelAPI/HotelDetails",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: hotelStaticAuthHeader(),
          },
          body: JSON.stringify(tboPayload),
          signal: controller.signal,
        }
      );
      data = await tboRes.json();
      logTBOCall({
        method: "HotelImages",
        traceId: `hotel-images-${codes[0]}`,
        request: tboPayload,
        response: { hotelCount: data?.HotelDetails?.length ?? 0 },
        durationMs: Date.now() - t0,
      });
    } finally {
      clearTimeout(timeout);
    }

    // Build { HotelCode: imageUrl } map
    const hotels: any[] = data?.HotelDetails || data?.Hotels || [];
    const imageMap: Record<string, string> = {};
    for (const h of hotels) {
      const code = h.HotelCode || h.TBOHotelCode || "";
      const imgs = h.Images || [];
      const imageUrls = imgs.map((img: any) =>
        typeof img === "string" ? img : (img.Url || img.url || "")
      ).filter(Boolean);
      if (code && imageUrls.length > 0) {
        imageMap[code] = imageUrls[0];
      }
    }

    res.json({ ok: true, images: imageMap });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Image fetch failed";
    // Never error on image fetch — return empty map
    res.json({ ok: true, images: {} });
  }
});

// ─── 10b. GET /details?hotelCodes=xxx,yyy ────────────────────────────────────

router.get("/details", async (req: any, res: any) => {
  try {
    if (process.env.TBO_ENV === "mock") {
      return res.json({
        success: true,
        hotel: MOCK_HOTEL_RESULTS[0],
        source: "mock",
      });
    }

    const hotelCodes = (req.query.hotelCodes as string) || "";
    if (!hotelCodes) return res.status(400).json({ error: "hotelCodes required" });

    // Check cache first (keyed by hotelCodes string)
    const cached = hotelDetailsCache.get(hotelCodes);
    if (cached && Date.now() - cached.ts < DETAILS_CACHE_TTL) {
      return res.json(cached.data);
    }

    const tboPayload = { Hotelcodes: hotelCodes, Language: "en", IsRoomDetailRequired: true };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    let data: any;
    try {
      const t0 = Date.now();
      const tboRes = await fetch(
        "https://api.tbotechnology.in/TBOHolidays_HotelAPI/HotelDetails",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: hotelStaticAuthHeader(),
          },
          body: JSON.stringify(tboPayload),
          signal: controller.signal,
        }
      );
      data = await tboRes.json();
      logTBOCall({ method: "HotelDetails", traceId: `hotel-details-${hotelCodes.split(",")[0]}`, request: tboPayload, response: data, durationMs: Date.now() - t0 });
    } finally {
      clearTimeout(timeout);
    }

    // Normalize Images arrays to string URLs
    const hotelList: any[] = data?.HotelDetails || data?.Hotels || [];
    for (const h of hotelList) {
      if (Array.isArray(h.Images)) {
        h.Images = h.Images.map((img: any) =>
          typeof img === "string" ? img : (img.Url || img.url || "")
        ).filter(Boolean);
      }
    }

    hotelDetailsCache.set(hotelCodes, { data, ts: Date.now() });
    res.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Hotel details failed";
    sbtLogger.error("Hotel details failed", { error: msg });
    res.status(500).json({ error: msg });
  }
});

// ─── 10c. POST /rooms ────────────────────────────────────────────────────────

router.post("/rooms", requireAuth, requireSBT, requireHotelAccess, async (req: any, res: any) => {
  try {
    const {
      hotelCode,
      checkIn,
      checkOut,
      Rooms: roomsArray,
      adults = 1,
      children = 0,
      childrenAges = null,
      rooms = 1,
      guestNationality = "IN",
    } = req.body;

    if (!hotelCode || !checkIn || !checkOut) {
      return res.status(400).json({ error: "hotelCode, checkIn, checkOut required" });
    }

    const paxRooms: Array<{ Adults: number; Children: number; ChildrenAges: number[] | null }> =
      Array.isArray(roomsArray) && roomsArray.length > 0
        ? roomsArray.map((r: any) => ({
            Adults: r.Adults || r.adults || 1,
            Children: r.Children ?? r.children ?? 0,
            ChildrenAges: r.ChildrenAges ?? r.childrenAges ?? null,
          }))
        : Array.from({ length: rooms }, () => ({
            Adults: adults,
            Children: children,
            ChildrenAges: childrenAges,
          }));

    const tboPayload = {
      CheckIn: checkIn,
      CheckOut: checkOut,
      HotelCodes: String(hotelCode),
      GuestNationality: guestNationality,
      PaxRooms: paxRooms,
      ResponseTime: 23,
      IsDetailedResponse: true,
      Filters: { Refundable: false, NoOfRooms: 0, MealType: "All" },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let data: any;
    try {
      const t0 = Date.now();
      const tboRes = await fetch("https://affiliate.tektravels.com/HotelAPI/Search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: hotelAuthHeader(),
        },
        body: JSON.stringify(tboPayload),
        signal: controller.signal,
      });
      data = await tboRes.json();
      logTBOCall({
        method: "HotelRooms",
        traceId: `hotel-rooms-${hotelCode}`,
        request: tboPayload,
        response: data,
        durationMs: Date.now() - t0,
      });
    } finally {
      clearTimeout(timeout);
    }

    const results: any[] = data?.HotelResult || data?.HotelSearchResult?.HotelResults || [];
    const match = results.find(
      (h: any) => String(h.HotelCode) === String(hotelCode)
    );

    if (!match || !match.Rooms?.length) {
      return res.status(404).json({ error: "No rooms found for the selected hotel and dates" });
    }

    res.json({ ok: true, rooms: match.Rooms });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Room fetch failed";
    sbtLogger.error("Hotel rooms fetch failed", { error: msg });
    res.status(500).json({ error: msg });
  }
});

export default router;
