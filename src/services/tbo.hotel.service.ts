import { logTBOCall } from "../utils/tboFileLogger.js";
import { getTBOToken } from "./tbo.auth.service.js";
import { withTBOSessionRetry } from "./tbo.session.helper.js";

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
  const creds = Buffer.from(
    `${process.env.TBO_HOTEL_USERNAME}:${process.env.TBO_HOTEL_PASSWORD}`
  ).toString("base64");

  const errors: string[] = [];

  for (const lookup of lookups) {
    try {
      const result = await withTBOSessionRetry(
        async (tokenId) => {
          let payload: Record<string, unknown>;
          if (lookup.mode === "bookingId") {
            payload = { EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1", TokenId: tokenId, BookingId: lookup.bookingId };
          } else if (lookup.mode === "confirmationNo") {
            payload = { EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1", TokenId: tokenId, ConfirmationNo: lookup.confirmationNo, Name: lookup.guestName };
          } else {
            payload = { EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1", TokenId: tokenId, TraceId: lookup.traceId };
          }

          const t0 = Date.now();
          const res = await fetch(
            "https://hotelbe.tektravels.com/hotelservice.svc/rest/GetBookingDetail/",
            { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${creds}` }, body: JSON.stringify(payload) }
          );
          const data = await res.json();
          logTBOCall({
            method: "HotelGetBookingDetail",
            traceId: `gbd-${lookup.mode}`,
            bookingId: lookup.mode === "bookingId" ? lookup.bookingId : undefined,
            request: payload,
            response: data,
            durationMs: Date.now() - t0,
          });
          return data;
        },
        (r: any) => {
          const inner = r?.GetBookingDetailResult || r?.BookResult || r;
          return inner?.ResponseStatus === 4 || inner?.Error?.ErrorCode === 6;
        },
      );
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
  const creds = Buffer.from(
    `${process.env.TBO_HOTEL_USERNAME}:${process.env.TBO_HOTEL_PASSWORD}`
  ).toString("base64");

  // CROSS-002: withTBOSessionRetry handles ResponseStatus=4/ErrorCode=6 with single retry.
  return withTBOSessionRetry(
    async (tokenId) => {
      // POST-001: When panPayload is provided (hold + PanMandatory flow), include
      // IsCorporate and HotelRoomsDetails[].HotelPassenger[].PaxId+PAN in the request.
      const payload: Record<string, unknown> = {
        EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
        TokenId: tokenId,
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
    },
    (r: any) => r?.GenerateVoucherResult?.ResponseStatus === 4 || r?.GenerateVoucherResult?.Error?.ErrorCode === 6,
  );
}
