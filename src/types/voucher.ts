// apps/backend/src/types/voucher.ts
export type VoucherType = "hotel" | "flight";
export type LayoutType = "SINGLE" | "DUAL" | "GROUP";

export interface BookingInfo {
  booking_id: string | null;
  booking_date: string | null;
  voucher_no: string | null;
  supplier_conf_no: string | null;
  pnr?: string | null;
  fare_type?: string | null;
  ocr_data_line?: string | null;
  custom_logo?: string | null;
}

export interface HotelDetails {
  name: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  contact: string | null;
}

export interface StayDetails {
  check_in_date: string | null;
  check_in_time: string | null;
  check_out_date: string | null;
  check_out_time: string | null;
  total_nights: string | null;
}

export interface GuestDetails {
  primary_guest: string | null;
  total_pax: string | null;
  adults: number;
  children: number;
  all_guest_names: string[];
}

export interface RoomDetails {
  room_type: string | null;
  no_of_rooms: string | null;
  inclusions: string[];
  special_requests: string | null;
}

export interface FlightLeg {
  city: string | null;
  code: string | null;
  time: string | null;
  date: string | null;
  terminal: string | null;
}

export interface Ancillaries {
  cabin_bag: string | null;
  checkin_bag: string | null;
  seat: string | null;
  meal: string | null;
  barcode_string: string | null;
}

export interface FlightSegment {
  airline: string | null;
  flight_no: string | null;
  class: string | null;
  duration: string | null;
  origin: FlightLeg;
  destination: FlightLeg;
  layover_duration?: string | null;
  ancillaries?: Ancillaries;
}

export interface Passenger {
  name: string | null;
  type: string | null;
  ticket_no: string | null;
  phone: string | null;
  email: string | null;
  baggage_check_in: string | null;
  baggage_cabin: string | null;
  seat?: string | null;
  meal?: string | null;
  barcode_string?: string | null;
  special_service?: string | null;
}

export interface FlightDetails {
  segments: FlightSegment[];
}

export interface Policies {
  cancellation_deadline?: string | null;
  is_non_refundable: boolean;
  important_notes: string[];
}

export interface PlumtripsVoucher {
  type: VoucherType;
  layout_type?: LayoutType;
  booking_info: BookingInfo;

  hotel_details?: HotelDetails;
  stay_details?: StayDetails;
  guest_details?: GuestDetails;
  room_details?: RoomDetails;

  flight_details?: FlightDetails;
  passengers?: Passenger[];

  policies: Policies;
}
