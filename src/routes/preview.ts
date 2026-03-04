import { Router, Request, Response } from "express";

const router = Router();

const SERP_API_KEY = process.env.SERPAPI_API_KEY!;
const SERP_BASE = "https://serpapi.com/search.json";

if (!SERP_API_KEY) {
  console.warn("⚠️ SERPAPI_API_KEY not set");
}

function mapCabinClass(cabin?: string): string {
  if (!cabin) return "1";
  const c = cabin.toLowerCase();
  if (c.includes("premium")) return "2";
  if (c.includes("business")) return "3";
  if (c.includes("first")) return "4";
  return "1";
}

/* ------------------------------------------------------------------
 * ✈️ POST /api/preview/flights
 * ------------------------------------------------------------------ */
router.post("/flights", async (req: Request, res: Response) => {
  try {
    const {
      origin,
      destination,
      departDate,
      returnDate,
      tripType = 2,
      adults = 1,
      children = 0,
      cabinClass = "Economy",
      stops,
      maxPrice,
      deepSearch = true, // Default to true to get more inventory
    } = req.body || {};

    if (!origin || !destination || !departDate) {
      return res.status(400).json({ ok: false, message: "Required fields missing" });
    }

    const params = new URLSearchParams({
      engine: "google_flights",
      api_key: SERP_API_KEY,
      departure_id: origin,
      arrival_id: destination,
      outbound_date: departDate,
      type: String(tripType),
      travel_class: mapCabinClass(cabinClass),
      adults: String(adults),
      children: String(children),
      currency: "INR",
      hl: "en",
      deep_search: String(deepSearch),
    });

    if (tripType === 1 && returnDate) params.append("return_date", returnDate);
    if (stops !== undefined) params.append("stops", String(stops));
    if (maxPrice) params.append("max_price", String(maxPrice));

    const r = await fetch(`${SERP_BASE}?${params.toString()}`);
    const data: any = await r.json();

    // FIX: Combine Best + Other and REMOVE the .slice(0, 10)
    const allFlights = [
      ...(data?.best_flights || []),
      ...(data?.other_flights || []),
    ];

    const results = allFlights.map((f: any) => {
      const first = f.flights?.[0];
      const last = f.flights?.[f.flights.length - 1];
      
      // LOGO FIX: Extract IATA code from the logo URL provided by Google
      // Example URL: https://www.gstatic.com/flights/airline_logos/70px/6E.png
      let iata = "";
      if (first?.airline_logo) {
        const parts = first.airline_logo.split('/');
        iata = parts[parts.length - 1].split('.')[0]; 
      }

      return {
        airline: first?.airline || "Multiple Carriers",
        airlineCode: iata, 
        flightNo: first?.flight_number || "",
        departTime: first?.departure_airport?.time || "",
        arriveTime: last?.arrival_airport?.time || "",
        duration: f.total_duration ? `${Math.floor(f.total_duration / 60)}h ${f.total_duration % 60}m` : "",
        stops: (f.flights?.length || 1) - 1,
        approxPrice: f.price || 0,
      };
    });

    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, message: "Failed to fetch flight previews" });
  }
});

/* ------------------------------------------------------------------
 * 🏨 POST /api/preview/hotels
 * ------------------------------------------------------------------ */
router.post("/hotels", async (req: Request, res: Response) => {
  try {
    const { city, checkIn, checkOut, adults = 1, children = 0, rooms = 1, hotelClass } = req.body || {};

    const params = new URLSearchParams({
      engine: "google_hotels",
      api_key: SERP_API_KEY,
      q: city,
      check_in_date: checkIn,
      check_out_date: checkOut,
      adults: String(adults),
      children: String(children),
      rooms: String(rooms),
      currency: "INR",
    });

    if (hotelClass) params.append("hotel_class", String(hotelClass));

    const r = await fetch(`${SERP_BASE}?${params.toString()}`);
    const data: any = await r.json();

    // FIX: Remove .slice(0, 10) to show all properties
    const results = (data?.properties || []).map((h: any) => ({
      name: h?.name || "Unknown Hotel",
      thumbnail: h?.images?.[0]?.thumbnail || h?.thumbnail,
      area: h?.neighborhood || h?.address || "",
      starRating: h?.extracted_hotel_class || h?.hotel_class,
      overallRating: h?.overall_rating,
      approxPricePerNight: Number(h?.rate_per_night?.extracted_lowest) || 0,
    }));

    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, message: "Failed to fetch hotel previews" });
  }
});

export default router;