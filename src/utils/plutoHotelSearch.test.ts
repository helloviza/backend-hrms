import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ searchHotels: vi.fn() }));
vi.mock("../services/tbo.hotel.search.service.js", () => ({
  searchHotels: H.searchHotels,
  isHotelSearchError: (r: any) => r && r.ok === false,
}));

const {
  isHotelRequest,
  extractHotelCity,
  extractStarFilter,
  nightsBetween,
  mapHotelForChat,
  searchHotelsForChat,
} = await import("./plutoHotelSearch.js");

/**
 * Shaped exactly as tbo.hotel.search.service builds it: raw TBO HotelResult,
 * metadata merged at step 7 (HotelName/HotelRating/Address/CityName), rooms
 * normalized + margin-applied at step 10 (_displayTotalFare, isRefundable).
 */
function tboHotel(over: Record<string, any> = {}) {
  return {
    HotelCode: "1402689",
    HotelName: "Grand Hyatt Dubai",
    HotelRating: "5",
    Address: "Sheikh Rashid Road, Bur Dubai",
    CityName: "Dubai",
    CountryName: "United Arab Emirates",
    Latitude: "25.2285",
    Longitude: "55.3273",
    Rooms: [
      {
        RoomTypeName: "King Room, City View",
        TotalFare: 20000,
        NetAmount: 20000,
        _displayTotalFare: 22000,
        _netAmount: 20000,
        _markupAmount: 2000,
        isRefundable: true,
        cancelPolicies: [],
        supplements: [],
      },
    ],
    ...over,
  };
}

beforeEach(() => H.searchHotels.mockReset());

describe("intent + extraction", () => {
  it("detects hotel requests", () => {
    for (const p of [
      "Show me 5-star hotels in Dubai",
      "where to stay in Tokyo",
      "I need accommodation",
      "find me a resort",
    ]) expect(isHotelRequest(p)).toBe(true);
    expect(isHotelRequest("cheapest flight to Dubai")).toBe(false);
  });

  it("extracts the city the user named", () => {
    expect(extractHotelCity("Show me 5-star hotels in Dubai")).toBe("Dubai");
    expect(extractHotelCity("where to stay in New York")).toBe("New York");
    expect(extractHotelCity("show me hotels")).toBeNull();
  });

  it("maps star qualifiers to a real filter", () => {
    expect(extractStarFilter("5-star hotels")).toBe(5);
    expect(extractStarFilter("four star hotel")).toBe(4);
    expect(extractStarFilter("luxury hotel")).toBe(5);
    expect(extractStarFilter("a hotel")).toBeNull();
  });

  it("counts nights", () => {
    expect(nightsBetween("2026-09-20", "2026-09-24")).toBe(4);
    expect(nightsBetween("2026-09-20", "2026-09-20")).toBe(0);
    expect(nightsBetween(undefined, "2026-09-24")).toBe(0);
  });
});

describe("branch ownership — when the live lane may take the turn", () => {
  // Mirrors the guard in copilot.travel.ts. The hotel lane owns a turn ONLY
  // when a real search can run; anything less must fall through to the AI path
  // so the locked-facts extractor still gets to lock what the user just typed.
  const owns = (prompt: string, locked: any = {}) => {
    const city = isHotelRequest(prompt)
      ? extractHotelCity(prompt) || locked?.destination?.name || null
      : null;
    const hotelLed = Boolean(city) && !/\b(fly|flying|flight|flights)\b/i.test(prompt);
    return hotelLed && Boolean(locked?.dates?.start) && Boolean(locked?.dates?.end);
  };
  const dates = { dates: { start: "2026-09-20", end: "2026-09-22" } };

  it("owns a hotel-led turn once dates are locked", () => {
    expect(owns("Show me 5-star hotels in Dubai", dates)).toBe(true);
    expect(owns("where to stay", { ...dates, destination: { name: "Dubai" } })).toBe(true);
  });

  it("does NOT hijack a compound planning turn that merely mentions a hotel", () => {
    // The spillproof opener: all four facts must reach the extractor together.
    expect(
      owns("Flying to Singapore from Delhi 12-15 Sep, hotel near Marina Bay", dates),
    ).toBe(false);
    expect(owns("cheapest flight and a business hotel in Dubai", dates)).toBe(false);
  });

  it("does NOT own the turn before dates are locked — falls through to gather", () => {
    expect(owns("Show me 5-star hotels in Dubai")).toBe(false);
    expect(owns("Show me hotels in Dubai", { dates: { start: "2026-09-20" } })).toBe(false);
  });

  it("does NOT own a turn with no hotel intent at all", () => {
    expect(owns("Plan a 3-day trip to Tokyo", dates)).toBe(false);
  });
});

describe("mapHotelForChat — real fields only", () => {
  it("carries BOOKABLE IDENTITY (the thing AI hotels never had)", () => {
    const m = mapHotelForChat(tboHotel(), 2);
    expect(m.HotelCode).toBe("1402689");
    expect(m.Rooms[0].RoomTypeName).toBe("King Room, City View");
  });

  it("derives per-night from the real margin-applied fare", () => {
    const m = mapHotelForChat(tboHotel(), 2);
    expect(m.totalINR).toBe(22000);
    expect(m.perNightINR).toBe(11000);
    expect(m.nights).toBe(2);
  });

  it("picks the CHEAPEST room when several are offered", () => {
    const m = mapHotelForChat(
      tboHotel({
        Rooms: [
          { RoomTypeName: "Suite", TotalFare: 50000, _displayTotalFare: 55000 },
          { RoomTypeName: "Standard", TotalFare: 18000, _displayTotalFare: 19800 },
        ],
      }),
      2,
    );
    expect(m.Rooms[0].RoomTypeName).toBe("Standard");
    expect(m.perNightINR).toBe(9900);
  });

  it("passes a real rating through", () => {
    expect(mapHotelForChat(tboHotel(), 2).rating).toBe(5);
    expect(mapHotelForChat(tboHotel({ HotelRating: "", StarRating: 4 }), 2).rating).toBe(4);
  });

  it("OMITS the rating entirely when the source has none — never fabricates", () => {
    expect(mapHotelForChat(tboHotel({ HotelRating: "", StarRating: undefined }), 2).rating).toBeNull();
    expect(mapHotelForChat(tboHotel({ HotelRating: "0" }), 2).rating).toBeNull();
    expect(mapHotelForChat(tboHotel({ HotelRating: "N/A" }), 2).rating).toBeNull();
  });

  it("passes the property's OWN coordinate through, as numbers", () => {
    // Step 7 of tbo.hotel.search.service merges these onto every HotelResult;
    // dropping them was what forced hotel pins to be city centroids.
    const m = mapHotelForChat(tboHotel({ Latitude: "25.2285", Longitude: "55.3273" }), 2);
    expect(m.Latitude).toBeCloseTo(25.2285, 4);
    expect(m.Longitude).toBeCloseTo(55.3273, 4);
  });

  it("accepts coordinates already given as numbers", () => {
    const m = mapHotelForChat(tboHotel({ Latitude: 25.2285, Longitude: 55.3273 }), 2);
    expect(m.Latitude).toBeCloseTo(25.2285, 4);
  });

  it("yields NULL coordinates rather than junk when the metadata has none", () => {
    // A HotelResult whose HotelCode had no entry in hotelMeta never gets the
    // step-7 merge, so it reaches us with no Latitude/Longitude at all.
    const unmerged: any = tboHotel();
    delete unmerged.Latitude;
    delete unmerged.Longitude;
    const noMeta = mapHotelForChat(unmerged, 2);
    expect(noMeta.Latitude).toBeNull();
    expect(noMeta.Longitude).toBeNull();

    for (const bad of ["", "N/A", null, undefined, "abc"]) {
      const m = mapHotelForChat(tboHotel({ Latitude: bad, Longitude: bad }), 2);
      expect(m.Latitude).toBeNull();
      expect(m.Longitude).toBeNull();
    }
  });

  it("leaves price null rather than inventing one when there is no fare", () => {
    const m = mapHotelForChat(tboHotel({ Rooms: [] }), 2);
    expect(m.totalINR).toBeNull();
    expect(m.perNightINR).toBeNull();
  });

  it("does not divide by zero nights", () => {
    expect(mapHotelForChat(tboHotel(), 0).perNightINR).toBeNull();
  });
});

describe("searchHotelsForChat", () => {
  const args = {
    cityName: "Dubai", countryCode: "AE",
    checkIn: "2026-09-20", checkOut: "2026-09-22",
    adults: 2, rooms: 1,
  };

  it("returns real annotated rows on success", async () => {
    H.searchHotels.mockResolvedValue({
      ok: true, hotels: [tboHotel()], searchId: "s1", cityName: "Dubai",
    });
    const r = await searchHotelsForChat({ ...args, policyRules: null });
    expect(r.ok).toBe(true);
    expect(r.hotels).toHaveLength(1);
    expect(r.hotels[0].HotelCode).toBe("1402689");
    expect(r.hotels[0].policy).toBeTruthy();
  });

  it("sends the occupancy it was given as PaxRooms", async () => {
    H.searchHotels.mockResolvedValue({ ok: true, hotels: [tboHotel()], searchId: "s", cityName: "Dubai" });
    await searchHotelsForChat({ ...args, adults: 3, rooms: 2, policyRules: null });
    const sent = H.searchHotels.mock.calls[0][0];
    expect(sent.Rooms).toHaveLength(2);
    expect(sent.Rooms[0].Adults).toBe(3);
    expect(sent.CheckIn).toBe("2026-09-20");
  });

  it("passes a star filter through when the user asked for one", async () => {
    H.searchHotels.mockResolvedValue({ ok: true, hotels: [tboHotel()], searchId: "s", cityName: "Dubai" });
    await searchHotelsForChat({ ...args, starRating: 5, policyRules: null });
    expect(H.searchHotels.mock.calls[0][0].Filters.StarRating).toBe(5);
  });

  it("NO_AVAILABILITY → ok:false with NO fabricated hotels", async () => {
    H.searchHotels.mockResolvedValue({ ok: false, status: 404, code: "NO_HOTELS_FOUND", message: "none" });
    const r = await searchHotelsForChat({ ...args, policyRules: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("NO_AVAILABILITY");
    expect(r.hotels).toEqual([]);
  });

  it("upstream 502 → ok:false, empty (the 401/outage path)", async () => {
    H.searchHotels.mockResolvedValue({ ok: false, status: 502, code: "HOTEL_API_ERROR", message: "down" });
    const r = await searchHotelsForChat({ ...args, policyRules: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("UPSTREAM_ERROR");
    expect(r.hotels).toEqual([]);
  });

  it("a THROWN error never escapes — no hotels, honest reason", async () => {
    // ...Once, matching the repo's established pattern: the persistent variant
    // leaves a rejected promise queued past the test and gets reported as an
    // unhandled error even though the code under test caught it.
    H.searchHotels.mockRejectedValueOnce(new Error("socket hang up"));
    const r = await searchHotelsForChat({ ...args, policyRules: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("UPSTREAM_ERROR");
    expect(r.hotels).toEqual([]);
  });

  it("an empty hotels array is treated as no availability, not success", async () => {
    H.searchHotels.mockResolvedValue({ ok: true, hotels: [], searchId: "s", cityName: "Dubai" });
    const r = await searchHotelsForChat({ ...args, policyRules: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("NO_AVAILABILITY");
  });

  it("annotates policy with the SAME evaluator flights use (cap breach → OUT_OF_POLICY)", async () => {
    H.searchHotels.mockResolvedValue({ ok: true, hotels: [tboHotel()], searchId: "s", cityName: "Dubai" });
    const r = await searchHotelsForChat({
      ...args,
      policyRules: { maxHotelPricePerNightINR: 5000, active: true } as any,
    });
    expect(r.hotels[0].policy?.status).toBe("OUT_OF_POLICY");
    // Hotels share the flight reason vocabulary — same evaluator, same codes.
    expect(r.hotels[0].policy?.reasons).toContain("price_above_cap");
  });
});
