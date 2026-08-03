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
  rankHotelsForChat,
  resolveHotelSearchWindow,
  CHAT_HOTEL_RESULT_CAP,
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

/**
 * The guard the REAL searchHotels opens with (tbo.hotel.search.service.ts:154),
 * replicated exactly.
 *
 * This exists because the wholesale `vi.mock` above accepted ANY input and
 * happily returned hotels — so the lane shipped for months calling searchHotels
 * with a CityName and no CityCode, which the real service rejects with HTTP 400
 * before it opens a socket. Every "live hotel" turn silently became the honest
 * handoff and no test noticed. Any future call that drops CityCode now fails
 * here the same way production does.
 */
const realSearchHotelsGuard = async (input: any) =>
  !input?.HotelCodes?.length && !input?.CityCode
    ? { ok: false, status: 400, error: "CityCode or HotelCodes required" }
    : { ok: true, hotels: [tboHotel()], searchId: "s", cityName: "Dubai" };

describe("searchHotelsForChat", () => {
  const args = {
    cityName: "Dubai", cityCode: "115936", countryCode: "AE",
    checkIn: "2026-09-20", checkOut: "2026-09-22",
    adults: 2, rooms: 1,
  };

  it("passes a NON-EMPTY CityCode to searchHotels — the bug was passing none", async () => {
    H.searchHotels.mockImplementation(realSearchHotelsGuard);
    const r = await searchHotelsForChat({ ...args, policyRules: null });

    const sent = H.searchHotels.mock.calls[0][0];
    expect(sent.CityCode).toBe("115936");
    expect(String(sent.CityCode)).not.toBe("");
    // …and because a CityCode was sent, the real guard lets it through.
    expect(r.ok).toBe(true);
  });

  it("the real guard REJECTS the CityName-only payload the lane used to send", async () => {
    H.searchHotels.mockImplementation(realSearchHotelsGuard);
    // Byte-for-byte what the pre-fix searchHotelsForChat sent upstream.
    const asShippedBefore = await (H.searchHotels as any)({
      CityName: "Dubai",
      CountryCode: "AE",
      CheckIn: "2026-09-20",
      CheckOut: "2026-09-22",
      GuestNationality: "IN",
      Rooms: [{ Adults: 2, Children: 0, ChildrenAges: null }],
    });
    expect(asShippedBefore).toEqual({
      ok: false, status: 400, error: "CityCode or HotelCodes required",
    });
  });

  it("a missing CityCode short-circuits to BAD_REQUEST without burning a TBO call", async () => {
    H.searchHotels.mockImplementation(realSearchHotelsGuard);
    const r = await searchHotelsForChat({ ...args, cityCode: "", policyRules: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("BAD_REQUEST");
    expect(r.hotels).toEqual([]);
    expect(H.searchHotels).not.toHaveBeenCalled();
  });

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

  /* ── Pre-rank + cap ──────────────────────────────────────────────────────
   * searchHotels prices up to 400 codes per city. The old `.slice(0, 12)` ran
   * on TBO's batch order, so the twelve properties the user saw were an
   * accident of fan-out, not the twelve worth showing.
   */
  it("caps the reply and ranks BEFORE capping — not TBO's arbitrary first N", async () => {
    // 30 rows, cheapest LAST in TBO order, so an unranked slice would drop it.
    const many = Array.from({ length: 30 }, (_, i) =>
      tboHotel({
        HotelCode: `H${i}`,
        HotelName: `Hotel ${i}`,
        Rooms: [{ RoomTypeName: "Room", TotalFare: 90000 - i * 1000, NetAmount: 1, isRefundable: true }],
      }),
    );
    H.searchHotels.mockResolvedValue({ ok: true, hotels: many, searchId: "s", cityName: "Dubai" });

    const r = await searchHotelsForChat({ ...args, policyRules: null });

    expect(r.hotels).toHaveLength(CHAT_HOTEL_RESULT_CAP);
    expect(r.hotels.length).toBeLessThanOrEqual(CHAT_HOTEL_RESULT_CAP);
    // The cheapest row (H29, last in TBO order) must survive the cap.
    expect(r.hotels[0].HotelCode).toBe("H29");
    // …and the pool is ordered, not arbitrary.
    const fares = r.hotels.map((h) => h.totalINR ?? Infinity);
    expect(fares).toEqual([...fares].sort((a, b) => a - b));
  });

  it("ranks in-policy above cheaper out-of-policy rows", async () => {
    const rows = [
      tboHotel({ HotelCode: "CHEAP_OOP", Rooms: [{ RoomTypeName: "R", TotalFare: 10000, NetAmount: 1 }] }),
      tboHotel({ HotelCode: "PRICIER_OK", Rooms: [{ RoomTypeName: "R", TotalFare: 18000, NetAmount: 1 }] }),
    ];
    H.searchHotels.mockResolvedValue({ ok: true, hotels: rows, searchId: "s", cityName: "Dubai" });

    // 2 nights: 10000/2 = 5000/night breaches a 4000 cap; 18000/2 = 9000 does too.
    // Use a cap that separates them: 6000/night → CHEAP_OOP passes, PRICIER_OK fails.
    const r = await searchHotelsForChat({
      ...args,
      policyRules: { maxHotelPricePerNightINR: 6000, active: true } as any,
    });
    expect(r.hotels[0].HotelCode).toBe("CHEAP_OOP");
    expect(r.hotels[0].policy?.status).toBe("IN_POLICY");
    expect(r.hotels[1].policy?.status).toBe("OUT_OF_POLICY");
  });

  it("a row with no fare is ranked last but never dropped", async () => {
    const rows = [
      tboHotel({ HotelCode: "NOFARE", Rooms: [] }),
      tboHotel({ HotelCode: "PRICED", Rooms: [{ RoomTypeName: "R", TotalFare: 20000, NetAmount: 1 }] }),
    ];
    H.searchHotels.mockResolvedValue({ ok: true, hotels: rows, searchId: "s", cityName: "Dubai" });
    const r = await searchHotelsForChat({ ...args, policyRules: null });
    expect(r.hotels.map((h) => h.HotelCode)).toEqual(["PRICED", "NOFARE"]);
  });
});

/* ── BUG 1: the ownership gate must see dates typed THIS turn ───────────────
 * The gate read only context.locked.dates, but the locked-facts parser runs
 * ~240 lines later in the same handler — so on the turn the user first gives
 * dates the bag is empty, the gate declines, and the answer comes from the AI
 * path. The user had to repeat themselves for the live lane to fire.
 */
describe("resolveHotelSearchWindow — first-turn dates", () => {
  const NOW = new Date("2026-08-04T00:00:00Z");

  it("REGRESSION: a first-turn dated hotel prompt yields a window (locked bag empty)", () => {
    const w = resolveHotelSearchWindow(
      "Give me some hotels in Dubai for 25th Sept Check-in and 26th Sept 2026 Checkout",
      {},
      NOW,
    );
    expect(w).toEqual({ start: "2026-09-25", end: "2026-09-26", source: "prompt" });
  });

  it("reads the year off the second date when the first omits it", () => {
    // "25th Sept" carries no year; the current year is used (unchanged rule).
    const w = resolveHotelSearchWindow("hotels in Dubai 25th Sept and 26th Sept 2026", {}, NOW);
    expect(w?.start).toBe("2026-09-25");
  });

  it("handles the compact one-month range too", () => {
    const w = resolveHotelSearchWindow("hotels in Dubai 12-15 Sep 2026", {}, NOW);
    expect(w).toEqual({ start: "2026-09-12", end: "2026-09-15", source: "prompt" });
  });

  it("a LOCKED pair still wins — a re-statement never clobbers the commitment", () => {
    const w = resolveHotelSearchWindow(
      "hotels in Dubai 25th Sept and 26th Sept 2026",
      { dates: { start: "2026-09-20", end: "2026-09-22" } },
      NOW,
    );
    expect(w).toEqual({ start: "2026-09-20", end: "2026-09-22", source: "locked" });
  });

  it("ONE date is not a stay — no window, so the gate declines rather than guessing", () => {
    expect(resolveHotelSearchWindow("hotels in Dubai on 25th Sept", {}, NOW)).toBeNull();
  });

  it("no dates at all → null", () => {
    expect(resolveHotelSearchWindow("show me hotels in Dubai", {}, NOW)).toBeNull();
  });
});
