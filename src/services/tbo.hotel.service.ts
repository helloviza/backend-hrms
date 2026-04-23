import { logTBOCall } from "../utils/tboFileLogger.js";

export async function generateHotelVoucher(bookingId: number): Promise<any> {
  const creds = Buffer.from(
    `${process.env.TBO_HOTEL_USERNAME}:${process.env.TBO_HOTEL_PASSWORD}`
  ).toString("base64");
  const payload = {
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    BookingId: bookingId,
    RequestedBookingMode: 5,
  };

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
}
