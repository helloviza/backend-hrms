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

export interface PlutoReplyV1 {
  title: string;
  context: string;              // 1–2 line executive summary
  tripType: PlutoTripType;

  itinerary?: PlutoItineraryDay[];  // optional (DISCOVERY / PLANNING)

  hotels?: PlutoHotel[];

  nextSteps: string[];

  handoff: boolean;             // 🔑 Auto-handoff signal (Fix #4)
}
