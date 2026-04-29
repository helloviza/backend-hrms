import { logTBOCall } from "../utils/tboFileLogger.js";
import { getTBOToken } from "./tbo.auth.service.js";
import { withTBOSessionRetry } from "./tbo.session.helper.js";

export interface VoucherPanPayload {
  isCorporate: boolean;
  hotelRoomsDetails: Array<{
    hotelPassenger: Array<{ PaxId: string; PAN: string }>;
  }>;
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
        request: payload,
        response: data,
        durationMs: Date.now() - start,
      });
      return data;
    },
    (r: any) => r?.GenerateVoucherResult?.ResponseStatus === 4 || r?.GenerateVoucherResult?.Error?.ErrorCode === 6,
  );
}
