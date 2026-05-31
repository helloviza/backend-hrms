import { logTBOCall } from "../utils/tboFileLogger.js";
import { assertNotDemoTBO } from "../utils/demoContext.js";

export interface VoucherPanPayload {
  isCorporate: boolean;
  hotelRoomsDetails: Array<{
    hotelPassenger: Array<{ PaxId: string; PAN: string }>;
  }>;
}

export type BookingDetailLookup =
  | { mode: "bookingId"; bookingId: number }
  | { mode: "confirmationNo"; confirmationNo: string; guestName: string }
  | { mode: "traceId"; traceId: string };

/**
 * POST-004: GetBookingDetail with three fallback lookup modes.
 * Tries each mode in order and returns the first successful result.
 */
export async function getBookingDetail(lookups: BookingDetailLookup[]): Promise<any> {
  // Fail-closed: a demo request must never fetch live booking details from TBO.
  assertNotDemoTBO("hotel:GetBookingDetail");
  const creds = Buffer.from(
    `${process.env.TBO_HOTEL_USERNAME}:${process.env.TBO_HOTEL_PASSWORD}`
  ).toString("base64");

  const errors: string[] = [];

  for (const lookup of lookups) {
    try {
      // Hotel REST API authenticates via Basic Auth ONLY (TBO_HOTEL_*).
      // Per the certified contract, GetBookingDetail takes NO body TokenId —
      // the cert request body was just { BookingId, EndUserIp }. A body TokenId
      // minted from the AIR account is rejected as ErrorCode 6 "Invalid Token".
      let payload: Record<string, unknown>;
      if (lookup.mode === "bookingId") {
        payload = { EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1", BookingId: lookup.bookingId };
      } else if (lookup.mode === "confirmationNo") {
        payload = { EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1", ConfirmationNo: lookup.confirmationNo, Name: lookup.guestName };
      } else {
        payload = { EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1", TraceId: lookup.traceId };
      }

      const t0 = Date.now();
      const res = await fetch(
        "https://hotelbe.tektravels.com/hotelservice.svc/rest/GetBookingDetail/",
        { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${creds}` }, body: JSON.stringify(payload) }
      );
      const result = (await res.json()) as any;
      logTBOCall({
        method: "HotelGetBookingDetail",
        traceId: `gbd-${lookup.mode}`,
        bookingId: lookup.mode === "bookingId" ? lookup.bookingId : undefined,
        request: payload,
        response: result,
        durationMs: Date.now() - t0,
      });
      const inner = result?.GetBookingDetailResult || result?.BookResult || result;
      if (inner?.ResponseStatus === 1) return inner;
      const errMsg = inner?.Error?.ErrorMessage || `mode=${lookup.mode} ResponseStatus=${inner?.ResponseStatus}`;
      errors.push(errMsg);
    } catch (e: any) {
      errors.push(`mode=${lookup.mode}: ${e?.message || String(e)}`);
    }
  }

  throw new Error(`GetBookingDetail failed all lookup modes. Errors: ${errors.join(" | ")}`);
}

export async function generateHotelVoucher(bookingId: number, panPayload?: VoucherPanPayload): Promise<any> {
  // Fail-closed: never generate a live TBO voucher for a demo request (the
  // generate-voucher route also short-circuits demo upstream).
  assertNotDemoTBO("hotel:GenerateVoucher");
  const creds = Buffer.from(
    `${process.env.TBO_HOTEL_USERNAME}:${process.env.TBO_HOTEL_PASSWORD}`
  ).toString("base64");

  // Hotel REST API authenticates via Basic Auth ONLY (TBO_HOTEL_*).
  // Per the certified contract, GenerateVoucher takes NO body TokenId — a body
  // TokenId minted from the AIR account is rejected as ErrorCode 6 "Invalid Token".
  // POST-001: When panPayload is provided (hold + PanMandatory flow), include
  // IsCorporate and HotelRoomsDetails[].HotelPassenger[].PaxId+PAN in the request.
  const payload: Record<string, unknown> = {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    BookingId: bookingId,
    RequestedBookingMode: 5,
  };

  if (panPayload) {
    payload.IsCorporate = panPayload.isCorporate ? "true" : "false";
    payload.HotelRoomsDetails = panPayload.hotelRoomsDetails.map((room) => ({
      HotelPassenger: room.hotelPassenger,
    }));
  }

  const start = Date.now();
  const response = await fetch(
    "https://hotelbe.tektravels.com/hotelservice.svc/rest/GenerateVoucher/",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${creds}`,
      },
      body: JSON.stringify(payload),
    }
  );
  if (!response.ok) {
    throw new Error(`TBO GenerateVoucher failed: HTTP ${response.status}`);
  }
  const data = await response.json();
  logTBOCall({
    method: "GenerateHotelVoucher",
    traceId: `hotel-voucher-${bookingId}`,
    bookingId,
    request: payload,
    response: data,
    durationMs: Date.now() - start,
  });
  return data;
}
