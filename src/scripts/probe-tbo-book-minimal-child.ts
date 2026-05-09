// One-shot diagnostic probe: does TBO HotelBook accept a child pax with NO
// Title/FirstName/LastName — only Age + PaxType + LeadPassenger + PAN?
//
// Flow: Search → PreBook → Book (minimal child payload) → auto-cancel on success.
//
// This script does NOT touch the database. It only hits TBO endpoints and prints
// the outcome. On a successful HOLD booking it fires SendChangeRequest to cancel
// so we don't litter the cert env with test bookings.
//
// Run: pnpm -C apps/backend probe:tbo-book-minimal-child

import "dotenv/config";
import { logTBOCall } from "../utils/tboFileLogger.js";

const SEARCH_URL = "https://affiliate.tektravels.com/HotelAPI/Search";
const PREBOOK_URL = "https://affiliate.tektravels.com/HotelAPI/PreBook";
const BOOK_URL = "https://hotelbe.tektravels.com/hotelservice.svc/rest/book/";
const CHANGE_REQ_URL = "https://HotelBE.tektravels.com/hotelservice.svc/rest/SendChangeRequest";

function hotelAuthHeader(): string {
  const creds = Buffer.from(
    `${process.env.TBO_HOTEL_USERNAME}:${process.env.TBO_HOTEL_PASSWORD}`,
  ).toString("base64");
  return `Basic ${creds}`;
}

function isoDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86400000).toISOString().slice(0, 10);
}

function dump(label: string, payload: unknown): void {
  console.log(`\n----- ${label} -----`);
  console.log(JSON.stringify(payload, null, 2));
}

interface SearchOutcome {
  bookingCode: string;
  totalFare: number;
  hotelCode: string;
  checkIn: string;
  checkOut: string;
}

async function searchOnce(
  hotelCode: string,
  checkIn: string,
  checkOut: string,
): Promise<SearchOutcome | null> {
  const payload = {
    CheckIn: checkIn,
    CheckOut: checkOut,
    HotelCodes: hotelCode,
    GuestNationality: "IN",
    PaxRooms: [{ Adults: 1, Children: 1, ChildrenAges: [8] }],
    ResponseTime: 23,
    IsDetailedResponse: true,
    Filters: { Refundable: false, NoOfRooms: 0, MealType: "All" },
  };
  dump(`HotelSearch REQUEST (HotelCode=${hotelCode}, ${checkIn}→${checkOut})`, payload);
  const t0 = Date.now();
  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: hotelAuthHeader() },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  const durationMs = Date.now() - t0;
  dump(`HotelSearch RESPONSE (HTTP ${res.status}, ${durationMs}ms)`, data);
  await logTBOCall({
    method: "Probe-HotelSearch",
    traceId: `probe-search-${hotelCode}`,
    request: payload,
    response: data,
    durationMs,
  });

  const hotels: any[] = (data as any)?.HotelResult || (data as any)?.HotelSearchResult?.HotelResults || [];
  const room = hotels[0]?.Rooms?.[0];
  if (!room?.BookingCode) return null;
  return {
    bookingCode: String(room.BookingCode),
    totalFare: Number(room.TotalFare ?? 0),
    hotelCode,
    checkIn,
    checkOut,
  };
}

async function findBookingCode(): Promise<SearchOutcome> {
  const baseCheckIn = isoDate(30);
  const baseCheckOut = isoDate(32);
  const altCheckIn = isoDate(44);
  const altCheckOut = isoDate(46);

  const attempts: Array<{ hotel: string; ci: string; co: string }> = [
    { hotel: "1108025", ci: baseCheckIn, co: baseCheckOut },
    { hotel: "6094257", ci: baseCheckIn, co: baseCheckOut },
    { hotel: "1108025", ci: altCheckIn, co: altCheckOut },
    { hotel: "6094257", ci: altCheckIn, co: altCheckOut },
  ];

  for (const a of attempts) {
    const result = await searchOnce(a.hotel, a.ci, a.co);
    if (result) {
      console.log(
        `\nSearch successful, BookingCode=${result.bookingCode} ` +
          `(HotelCode=${result.hotelCode}, ${result.checkIn}→${result.checkOut}, ` +
          `TotalFare=${result.totalFare})`,
      );
      return result;
    }
    console.log(
      `[probe] No rooms for HotelCode=${a.hotel} ${a.ci}→${a.co}, trying next combination…`,
    );
  }
  throw new Error("All search attempts returned zero rooms");
}

interface PreBookOutcome {
  bookingCode: string;
  netAmount: number;
  isRefundable: boolean | null;
  raw: any;
}

async function preBook(bookingCode: string): Promise<PreBookOutcome> {
  const payload = { BookingCode: bookingCode, PaymentMode: "Limit" };
  dump("HotelPreBook REQUEST", payload);
  const t0 = Date.now();
  const res = await fetch(PREBOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: hotelAuthHeader() },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  const durationMs = Date.now() - t0;
  dump(`HotelPreBook RESPONSE (HTTP ${res.status}, ${durationMs}ms)`, data);
  await logTBOCall({
    method: "Probe-HotelPreBook",
    traceId: `probe-prebook`,
    request: payload,
    response: data,
    durationMs,
  });

  // TBO HotelPreBook returns Status: { Code: 200, Description: "Successful" } at the
  // top level — NOT ResponseStatus. The earlier check on ResponseStatus always failed
  // and aborted the probe before Book.
  const statusCode = Number((data as any)?.Status?.Code ?? -1);
  const statusDesc = String((data as any)?.Status?.Description ?? "");
  if (statusCode !== 200) {
    const errMsg =
      (data as any)?.Status?.Description ||
      (data as any)?.Error?.ErrorMessage ||
      (data as any)?.PreBookResult?.Error?.ErrorMessage ||
      "PreBook failed";
    throw new Error(`PreBook Status.Code=${statusCode} (${statusDesc}): ${errMsg}`);
  }
  const hotel =
    (data as any)?.HotelResult?.[0] || (data as any)?.PreBookResult?.HotelResult?.[0];
  const room0 = hotel?.Rooms?.[0];
  const refreshedCode = String(room0?.BookingCode || bookingCode);
  const netAmount = Number(room0?.NetAmount ?? 0);
  if (!refreshedCode || !Number.isFinite(netAmount) || netAmount <= 0) {
    throw new Error(`PreBook returned no usable BookingCode/NetAmount: ${JSON.stringify(room0)}`);
  }
  return {
    bookingCode: refreshedCode,
    netAmount,
    isRefundable: typeof room0?.IsRefundable === "boolean" ? room0.IsRefundable : null,
    raw: data,
  };
}

interface BookOutcome {
  responseStatus: number;
  status: number;
  bookingId: number | null;
  confirmationNo: string | null;
  errorCode: number | null;
  errorMessage: string | null;
  rawResponse: any;
  rawRequest: any;
}

async function bookMinimalChild(prebook: PreBookOutcome): Promise<BookOutcome> {
  const bookPayload = {
    EndUserIp: "1.1.1.1",
    BookingCode: prebook.bookingCode,
    ClientReferenceId: `PROBE-MINIMAL-CHILD-${Date.now()}`,
    GuestNationality: "IN",
    IsVoucherBooking: false,
    RequestedBookingMode: 5,
    NetAmount: prebook.netAmount,
    HotelRoomsDetails: [
      {
        HotelPassenger: [
          {
            Title: "Mr",
            FirstName: "Probe",
            LastName: "Test",
            MiddleName: "",
            Nationality: "IN",
            PaxType: 1,
            LeadPassenger: true,
            Age: 0,
            Phoneno: "9999999999",
            Email: "tbocertification@plumtrips.com",
            PAN: "AAZPI0517R",
          },
          {
            // CHILD WITH MINIMAL FIELDS — this is the hypothesis under test.
            // Deliberately omitted: Title, FirstName, LastName, MiddleName.
            PaxType: 2,
            LeadPassenger: false,
            Age: 8,
            PAN: "AAZPI0517R",
          },
        ],
      },
    ],
  };

  dump("HotelBook REQUEST (minimal child pax)", bookPayload);
  const t0 = Date.now();
  const res = await fetch(BOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: hotelAuthHeader() },
    body: JSON.stringify(bookPayload),
  });
  const data = await res.json().catch(() => ({}));
  const durationMs = Date.now() - t0;
  dump(`HotelBook RESPONSE (HTTP ${res.status}, ${durationMs}ms)`, data);
  await logTBOCall({
    method: "Probe-HotelBook",
    traceId: `probe-book`,
    clientReferenceId: bookPayload.ClientReferenceId,
    request: bookPayload,
    response: data,
    durationMs,
  });

  // Book response wraps everything inside BookResult (NOT at top level).
  const result = (data as any)?.BookResult ?? {};
  return {
    responseStatus: Number(result?.ResponseStatus ?? -1),
    status: Number(result?.Status ?? -1),
    bookingId: result?.BookingId ? Number(result.BookingId) : null,
    confirmationNo: result?.ConfirmationNo ? String(result.ConfirmationNo) : null,
    errorCode: result?.Error?.ErrorCode != null ? Number(result.Error.ErrorCode) : null,
    errorMessage: result?.Error?.ErrorMessage ? String(result.Error.ErrorMessage) : null,
    rawResponse: data,
    rawRequest: bookPayload,
  };
}

async function autoCancel(bookingId: number): Promise<void> {
  console.log(`\n[probe] Auto-cancelling held booking ${bookingId} via SendChangeRequest…`);
  // SendChangeRequest needs TokenId → import lazily so the search/prebook/book path
  // (which uses Basic auth only) doesn't pull in token-cache state up front.
  const { getTBOToken } = await import("../services/tbo.auth.service.js");
  const tokenId = await getTBOToken();

  const payload = {
    BookingMode: 5,
    RequestType: 4,
    Remarks: "Probe test - cancel",
    BookingId: bookingId,
    EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
    TokenId: tokenId,
  };
  dump("SendChangeRequest REQUEST", payload);
  const t0 = Date.now();
  const res = await fetch(CHANGE_REQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: hotelAuthHeader() },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { rawNonJson: text.slice(0, 500) };
  }
  const durationMs = Date.now() - t0;
  dump(`SendChangeRequest RESPONSE (HTTP ${res.status}, ${durationMs}ms)`, data);
  await logTBOCall({
    method: "Probe-SendChangeRequest",
    traceId: `probe-cancel-${bookingId}`,
    bookingId,
    request: payload,
    response: data,
    durationMs,
  });
  const cr = data?.HotelChangeRequestResult;
  if (cr?.ResponseStatus === 1) {
    console.log(
      `[probe] Cancellation submitted. ChangeRequestId=${cr.ChangeRequestId}, ` +
        `ChangeRequestStatus=${cr.ChangeRequestStatus}`,
    );
  } else {
    console.log(
      `[probe] Cancellation FAILED — please cancel BookingId=${bookingId} manually. ` +
        `ResponseStatus=${cr?.ResponseStatus}, Error=${cr?.Error?.ErrorMessage || "unknown"}`,
    );
  }
}

function reportOutcomeA(book: BookOutcome): void {
  console.log("\n========================================");
  console.log("PROBE RESULT: TBO ACCEPTED MINIMAL CHILD");
  console.log("========================================");
  console.log(`Status: ${book.responseStatus} (Confirmed)`);
  console.log(`BookingId: ${book.bookingId}`);
  console.log(`ConfirmationNo: ${book.confirmationNo ?? "(none returned)"}`);
  console.log(
    "Conclusion: Spec is more lenient than literal reading. Title/FirstName/LastName",
  );
  console.log("can be safely omitted for child paxes. Implementation can be simplified.");
  console.log("");
  console.log("ACTION REQUIRED: This was a successful HOLD booking. Cancel it via:");
  console.log(
    `  await sendChangeRequest({ BookingId: ${book.bookingId}, RequestType: 4, Remarks: "Probe test - cancel" })`,
  );
  console.log(`  Or run: pnpm cancel:probe-booking ${book.bookingId}`);
  console.log("========================================");
}

function reportOutcomeB(book: BookOutcome): void {
  console.log("\n========================================");
  console.log("PROBE RESULT: TBO REJECTED MINIMAL CHILD");
  console.log("========================================");
  console.log(`Status: ${book.responseStatus}`);
  console.log(`ErrorCode: ${book.errorCode ?? "(none)"}`);
  console.log(`ErrorMessage: ${book.errorMessage ?? "(none)"}`);
  console.log("Conclusion: TBO requires child name fields per spec line 2005/2007.");
  console.log("Current implementation (auto-synthesized names) is correct.");
  console.log("========================================");
}

function reportOutcomeC(stage: string, err: unknown): void {
  console.log("\n========================================");
  console.log("PROBE RESULT: ERROR — TEST INCONCLUSIVE");
  console.log("========================================");
  console.log(`Stage: ${stage}`);
  const msg =
    err instanceof Error
      ? `${err.message}\n${err.stack ?? ""}`
      : JSON.stringify(err, null, 2);
  console.log(`Error: ${msg}`);
  console.log("Conclusion: Test could not complete. Check credentials, network, or TBO env status.");
  console.log("========================================");
}

async function main(): Promise<void> {
  console.log("=== TBO Hotel Book — Minimal Child Pax Probe ===");
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(
    `TBO_HOTEL_USERNAME set: ${!!process.env.TBO_HOTEL_USERNAME}, ` +
      `TBO_HOTEL_PASSWORD set: ${!!process.env.TBO_HOTEL_PASSWORD}`,
  );

  let stage: "Search" | "PreBook" | "Book" | "Cancel" = "Search";
  try {
    const search = await findBookingCode();

    stage = "PreBook";
    const prebook = await preBook(search.bookingCode);
    console.log(
      `\n[probe] PreBook OK. BookingCode=${prebook.bookingCode}, ` +
        `NetAmount=${prebook.netAmount}, IsRefundable=${prebook.isRefundable}`,
    );

    stage = "Book";
    console.log(
      `\nPreBook captured: BookingCode=${prebook.bookingCode}, NetAmount=${prebook.netAmount}`,
    );
    const book = await bookMinimalChild(prebook);

    const isSuccess =
      book.responseStatus === 1 && book.status === 1 && book.bookingId != null;
    const isReject = book.responseStatus === 2 || book.status === 0;

    if (isSuccess) {
      reportOutcomeA(book);
      stage = "Cancel";
      try {
        await autoCancel(book.bookingId!);
      } catch (cancelErr) {
        console.log(
          `\n[probe] Auto-cancel threw — please cancel BookingId=${book.bookingId} manually.`,
        );
        console.log(cancelErr);
      }
    } else if (isReject) {
      reportOutcomeB(book);
    } else {
      reportOutcomeB(book);
    }
  } catch (err) {
    reportOutcomeC(stage, err);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Probe failed unexpectedly:", e);
  process.exit(1);
});
