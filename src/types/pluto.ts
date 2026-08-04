// apps/backend/src/types/pluto.ts

export type PlutoTripType =
  | "business"
  | "holiday"
  | "mice"
  | "event";

export interface PlutoItineraryDay {
  day: number;
  heading: string;
  details: string[];
}

export interface PlutoHotel {
  name: string;
  area: string;
  approxPrice: string;
  whyGood: string;
}

// Phase 2 live hotel results — real, bookable rows (HotelCode + dates +
// occupancy) from searchHotelsForChat. When present these SUPERSEDE the
// model-invented `hotels` above, same mirror of the frontend's own
// PlutoReplyV1 (ConciergePage.tsx) that field already carries.
export interface PlutoHotelSearch {
  city: string;
  countryCode: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  rooms: number;
  assumedOccupancy?: boolean;
  hotels: any[];
  searchId?: string;
  source?: "tbo";
}

export interface PlutoReplyV1 {
  title: string;
  context: string;              // 1–2 line executive summary
  tripType: PlutoTripType;

  itinerary?: PlutoItineraryDay[];  // optional (DISCOVERY / PLANNING)

  hotels?: PlutoHotel[];

  // Set outside the model's own JSON (routes/copilot.travel.ts, AFTER the
  // model call) when a live hotel search superseded `hotels` above — see
  // that file's "Itinerary hotel section" comment for why the itinerary
  // path needs this even though it never asks the model for it directly.
  hotelSearch?: PlutoHotelSearch;

  // Set alongside the RESOLVED-but-no-dates outcome in copilot.travel.ts's
  // "Itinerary hotel section" block: the city resolves live but we don't
  // have real dates yet, so the frontend renders an inline "01 · Stays"
  // dates-ask instead of either fabricated cards or a live search — never
  // ALSO duplicated into nextSteps (that was the original implementation;
  // it buried the ask in the generic bottom question row, disconnected
  // from any hotel context).
  hotelsAwaitingDates?: { city: string };

  nextSteps: string[];

  handoff: boolean;             // 🔑 Auto-handoff signal (Fix #4)
}
