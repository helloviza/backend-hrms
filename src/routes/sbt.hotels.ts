import express from "express";
import { randomUUID } from "crypto";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { sbtLogger } from "../utils/logger.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import SBTRequest from "../models/SBTRequest.js";
import { getTBOToken } from "../services/tbo.auth.service.js";
import { generateHotelVoucher } from "../services/tbo.hotel.service.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { sendMail } from "../utils/mailer.js";
import { logTBOCall } from "../utils/tboFileLogger.js";

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

    const user = await User.findById(userId).select("sbtEnabled").lean();
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
    const user = await User.findById(userId)
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

// Pre-load Indian cities on startup
(async () => {
  try {
    await fetchCityList("IN");
    sbtLogger.info("Indian city list cached on startup");
  } catch (e) {
    sbtLogger.warn("Failed to pre-load Indian cities", { error: e instanceof Error ? e.message : String(e) });
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
      const matches = MOCK_CITIES.filter(c =>
        c.CityName.toLowerCase().includes(q) ||
        c.CountryName.toLowerCase().includes(q)
      ).slice(0, 15);
      return res.json({ success: true, cities: matches, source: "mock" });
    }

    const q = ((req.query.q as string) || "").toLowerCase().trim();
    if (!q || q.length < 2) return res.json([]);

    // Search Indian cities first
    let cities = await fetchCityList("IN");
    let matches = cities.filter((c) =>
      c.CityName.toLowerCase().includes(q)
    );

    // If no Indian results and query is long enough, search a few countries
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

    res.json(matches.slice(0, 15));
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
    } = req.body;

    if (!CityCode || !CheckIn || !CheckOut) {
      return res.status(400).json({ error: "CityCode, CheckIn, CheckOut required" });
    }

    // 1. Get hotel code list (includes metadata: name, rating, address)
    const hotelList = await fetchHotelCodeList(CityCode, CountryCode);
    if (!hotelList.length) {
      return res.json({ Hotels: [], SearchId: randomUUID(), CityName });
    }

    // Build a lookup map: HotelCode → metadata
    const hotelMeta = new Map<string, HotelCodeEntry>();
    for (const h of hotelList) hotelMeta.set(h.HotelCode, h);

    // 2. Split hotel codes into chunks of 100
    const allCodes = hotelList.map((h) => h.HotelCode);
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

    const searchId = randomUUID();
    searchCache.set(searchId, { data: allResults, ts: Date.now() });

    res.json({
      TraceId: "",
      Hotels: allResults,
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

router.post("/prebook", async (req: any, res: any) => {
  try {
    if (process.env.TBO_ENV === "mock") {
      return res.json({
        success: true,
        prebookId: "MOCK-PREBOOK-" + Date.now(),
        status: "Prebooked",
        source: "mock",
      });
    }

    const { BookingCode } = req.body;
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
    const data = await tboRes.json();
    logTBOCall({ method: "HotelPreBook", traceId: BookingCode.split("!TB!")[4] || "hotel-prebook", request: tboPayload, response: data, durationMs: Date.now() - t0 });
    res.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "PreBook failed";
    sbtLogger.error("Hotel prebook failed", { error: msg });
    res.status(500).json({ error: msg });
  }
});

// ─── 4. POST /payment/create-order ───────────────────────────────────────────

router.post("/payment/create-order", async (req: any, res: any) => {
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

router.post("/payment/verify", async (req: any, res: any) => {
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
      GuestNationality = "IN",
      NetAmount,
      Guests,
      UserIp = "1.1.1.1",
      PaymentId,
    } = req.body;

    if (!BookingCode) return res.status(400).json({ error: "BookingCode required" });

    const mapGuest = (g: any) => ({
      Title: g.Title || "Mr",
      FirstName: g.FirstName,
      LastName: g.LastName,
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
    });

    const HotelRoomsDetails = req.body.HotelRoomsDetails
      ? (req.body.HotelRoomsDetails as any[]).map((room: any) => ({
          HotelPassenger: (room.Guests || []).map(mapGuest),
        }))
      : [{ HotelPassenger: (Guests || []).map(mapGuest) }];

    const tboPayload = {
      EndUserIp: UserIp,
      BookingCode,
      ClientReferenceId: `PLM-${Date.now()}`,
      GuestNationality,
      IsVoucherBooking: true,
      RequestedBookingMode: 5,
      NetAmount,
      HotelRoomsDetails,
    };
    const t0 = Date.now();
    const tboRes = await fetch(
      "https://hotelbe.tektravels.com/hotelservice.svc/rest/book/",
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
    const bookTraceId = data?.BookResult?.TraceId || BookingCode.split("!TB!")[4] || "hotel-book";
    logTBOCall({ method: "HotelBook", traceId: bookTraceId, request: tboPayload, response: data, durationMs: Date.now() - t0 });

    const result = data?.BookResult || data;
    res.json({
      ok: true,
      BookingId: result?.BookingId ?? "",
      ConfirmationNo: result?.ConfirmationNo ?? "",
      BookingRefNo: result?.BookingRefNo ?? "",
      HotelBookingStatus: result?.HotelBookingStatus ?? result?.BookingStatus ?? "",
      PaymentId,
      raw: data,  // Full TBO BookHotel response for debugging & backfill
    });

    // Fire-and-forget: generate hotel voucher
    const tboBookingId = Number(result?.BookingId);
    if (tboBookingId) {
      generateHotelVoucher(tboBookingId)
        .then(async (voucherRes) => {
          // Will be linked to saved booking later via bookingId field
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
      BookingId: result?.BookingId, userId: req.user?.id,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Hotel booking failed";
    sbtLogger.error("Hotel booking failed", { userId: req.user?.id, error: msg });
    res.status(500).json({ error: msg });
  }
});

// ─── 6b. GET /voucher/:bookingId ─────────────────────────────────────────────

router.get("/voucher/:bookingId", async (req: any, res: any) => {
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

// ─── 7. POST /bookings/save ──────────────────────────────────────────────────

router.post("/bookings/save", async (req: any, res: any) => {
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
      status: b.status || "CONFIRMED",
      failureReason: b.failureReason || "",
      paymentStatus: b.paymentStatus || "paid",
      paymentId: b.paymentId || "",
      razorpayOrderId: b.razorpayOrderId || "",
      razorpayAmount: b.razorpayAmount || 0,
      isVouchered: b.isVouchered ?? true,
      paymentMode: b.paymentMode === "official" ? "official" : "personal",
      raw: b.raw ?? null,
      bookedAt: new Date(),
    });

    // If this booking fulfils an SBT request, mark it as BOOKED and notify L1
    if (b.sbtRequestId) {
      try {
        const sbtReq = await SBTRequest.findById(b.sbtRequestId);
        if (sbtReq && sbtReq.status === "PENDING") {
          sbtReq.status = "BOOKED";
          (sbtReq as any).hotelBookingId = doc._id;
          sbtReq.actedAt = new Date();
          await sbtReq.save();

          const requester = await User.findById(sbtReq.requesterId)
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

router.get("/bookings", requireSBT, async (req: any, res: any) => {
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
});

// ─── 9a. POST /bookings/sync-all-pending ─────────────────────────────────────

router.post("/bookings/sync-all-pending", async (req: any, res: any) => {
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

router.post("/bookings/:id/sync-status", async (req: any, res: any) => {
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

    const doc = await SBTHotelBooking.findById(req.params.id);
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

// ─── 10. POST /bookings/:id/cancel ──────────────────────────────────────────

router.post("/bookings/:id/cancel", requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    const doc = await SBTHotelBooking.findOne({ _id: req.params.id, userId });
    if (!doc) return res.status(404).json({ error: "Booking not found" });
    if (doc.status === "CANCELLED")
      return res.status(400).json({ error: "Already cancelled" });

    // Call TBO Cancel with shared token (token-based auth)
    try {
      const token = await getTBOToken();
      const cancelPayload = {
        EndUserIp: req.body.UserIp || "1.1.1.1",
        TokenId: token,
        BookingId: Number(doc.bookingId) || 0,
        RequestType: 2, // actual cancellation
      };
      const t0 = Date.now();
      const cancelRes = await fetch(
        "https://hotelbe.tektravels.com/hotelservice.svc/rest/cancel/",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cancelPayload),
        }
      );
      const cancelData = await cancelRes.json();
      logTBOCall({ method: "HotelCancel", traceId: `hotel-cancel-${doc.bookingId}`, request: cancelPayload, response: cancelData, durationMs: Date.now() - t0 });
    } catch (e) {
      sbtLogger.warn("TBO hotel cancel call failed", { bookingId: doc.bookingId, error: e instanceof Error ? e.message : String(e) });
    }

    doc.status = "CANCELLED";
    doc.cancelledAt = new Date();
    await doc.save();

    res.json({ ok: true, booking: doc });
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
      const imgs: string[] = h.Images || [];
      if (code && imgs.length > 0) {
        imageMap[code] = imgs[0];
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

    const tboPayload = { Hotelcodes: hotelCodes, Language: "en", IsRoomDetailRequired: true };
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
      }
    );
    const data = await tboRes.json();
    logTBOCall({ method: "HotelDetails", traceId: `hotel-details-${hotelCodes.split(",")[0]}`, request: tboPayload, response: data, durationMs: Date.now() - t0 });
    res.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Hotel details failed";
    sbtLogger.error("Hotel details failed", { error: msg });
    res.status(500).json({ error: msg });
  }
});

export default router;
