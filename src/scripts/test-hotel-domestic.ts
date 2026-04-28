import dotenv from "dotenv";
dotenv.config();
import { randomUUID } from "crypto";
import { logTBOCall } from "../utils/tboFileLogger.js";
import { consolidateHotelCertificationLogs } from "../services/tbo.log.consolidator.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const END_USER_IP = process.env.TBO_EndUserIp || "192.168.1.1";
const LEAD_EMAIL = "test@plumtrips.com";
const LEAD_PHONE = "9876543210";
const TEST_PANS = [
  "GSBPM2112A",  // from TBO's own API doc — known valid
  "AAAAP0042B",
  "BBBAP0043C",
  "CCCAP0044D",
];

const DOMESTIC_CITY_CODE = "100077";

function getFutureDates(): { checkIn: string; checkOut: string } {
  const ci = new Date();
  ci.setDate(ci.getDate() + 30);
  const co = new Date(ci);
  co.setDate(co.getDate() + 1);
  return {
    checkIn: ci.toISOString().slice(0, 10),
    checkOut: co.toISOString().slice(0, 10),
  };
}

/* ------------------------------------------------------------------ */
/*  Case configs                                                       */
/* ------------------------------------------------------------------ */

interface PaxRoom {
  Adults: number;
  Children: number;
  ChildrenAges: number[] | null;
}

const caseConfigs: Record<number, PaxRoom[]> = {
  1: [{ Adults: 1, Children: 0, ChildrenAges: null }],
  2: [{ Adults: 2, Children: 2, ChildrenAges: [8, 6] }],
  3: [
    { Adults: 1, Children: 0, ChildrenAges: null },
    { Adults: 1, Children: 0, ChildrenAges: null },
  ],
  4: [
    { Adults: 1, Children: 2, ChildrenAges: [8, 6] },
    { Adults: 2, Children: 0, ChildrenAges: null },
  ],
};

const caseLabelMap: Record<number, string> = {
  1: "Case1_Hotel_Domestic_1R_1A",
  2: "Case2_Hotel_Domestic_1R_2A2C",
  3: "Case3_Hotel_Domestic_2R_1A_1A",
  4: "Case4_Hotel_Domestic_2R_1A2C_2A",
};

/* ------------------------------------------------------------------ */
/*  Auth helpers                                                       */
/* ------------------------------------------------------------------ */

function hotelAuthHeader(): string {
  const creds = Buffer.from(
    `${process.env.TBO_HOTEL_USERNAME}:${process.env.TBO_HOTEL_PASSWORD}`,
  ).toString("base64");
  return `Basic ${creds}`;
}


/* ------------------------------------------------------------------ */
/*  HTTP helper                                                        */
/* ------------------------------------------------------------------ */

async function tboHotelPost(
  url: string,
  body: object,
  opts: { method: string; traceId: string; signal?: AbortSignal },
): Promise<any> {
  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: hotelAuthHeader(),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const text = await res.text();
  const durationMs = Date.now() - start;

  if (text.startsWith("<")) {
    throw new Error(`TBO returned HTML/XML: ${text.slice(0, 200)}`);
  }

  const data = JSON.parse(text);
  await logTBOCall({
    method: opts.method,
    traceId: opts.traceId,
    request: body,
    response: data,
    durationMs,
  });
  return data;
}

/* ------------------------------------------------------------------ */
/*  Passenger builder                                                  */
/* ------------------------------------------------------------------ */

interface HotelPassenger {
  Title: string;
  FirstName: string;
  LastName: string;
  MiddleName: string;
  Phoneno: string;
  Email: string;
  PaxType: number;
  LeadPassenger: boolean;
  Age: number;
  PassportNo: string;
  PassportIssueDate: string;
  PassportExpDate: string;
  PAN: string;
}

const guestNames: { title: string; last: string }[] = [
  { title: "Mr", last: "Roomone" },
  { title: "Mrs", last: "Roomtwo" },
  { title: "Miss", last: "Childone" },
  { title: "Miss", last: "Childtwo" },
  { title: "Mr", last: "Roomthree" },
  { title: "Mrs", last: "Roomfour" },
];

function buildPassengers(paxRooms: PaxRoom[], panMandatory: boolean): { HotelPassenger: HotelPassenger[] }[] {
  let nameIdx = 0;
  return paxRooms.map((room, roomIdx) => {
    const passengers: HotelPassenger[] = [];

    // Adults
    for (let a = 0; a < room.Adults; a++) {
      const g = guestNames[nameIdx++];
      const isLead = a === 0;
      passengers.push({
        Title: g.title,
        FirstName: "CertHtl",
        LastName: g.last,
        MiddleName: "",
        Phoneno: isLead ? LEAD_PHONE : "",
        Email: isLead ? LEAD_EMAIL : "",
        PaxType: 1,
        LeadPassenger: isLead,
        Age: 0,
        PassportNo: "",
        PassportIssueDate: "0001-01-01T00:00:00",
        PassportExpDate: "0001-01-01T00:00:00",
        PAN: panMandatory ? "GSBPM2112A" : "",
      });
    }

    // Children
    const ages = room.ChildrenAges || [];
    for (let c = 0; c < room.Children; c++) {
      const g = guestNames[nameIdx++];
      passengers.push({
        Title: g.title,
        FirstName: "CertHtl",
        LastName: g.last,
        MiddleName: "",
        Phoneno: "",
        Email: "",
        PaxType: 2,
        LeadPassenger: false,
        Age: ages[c] || 5,
        PassportNo: "",
        PassportIssueDate: "0001-01-01T00:00:00",
        PassportExpDate: "0001-01-01T00:00:00",
        PAN: panMandatory ? "GSBPM2112A" : "",
      });
    }

    console.log(`[PASSENGERS] Room ${roomIdx + 1}:`, JSON.stringify(passengers, null, 2));
    return { HotelPassenger: passengers };
  });
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const caseNum = parseInt(process.argv[2] || "1", 10);
  if (![1, 2, 3, 4].includes(caseNum)) {
    console.error("Usage: npx tsx src/scripts/test-hotel-domestic.ts <1|2|3|4>");
    process.exit(1);
  }

  console.log(`\n=== TBO Hotel Certification — Case ${caseNum} (Domestic) ===\n`);

  const paxRooms = caseConfigs[caseNum];
  const { checkIn, checkOut } = getFutureDates();
  const caseTraceId = `hotel-domestic-case${caseNum}-${randomUUID().slice(0, 8)}`;

  let bookingId: number | undefined;
  let confirmationNo = "";
  let bookingStatus = "";

  /* ── Step 1: Hotel Codes (hardcoded) ── */
  console.log("\n── Step 1: Hotel Codes (hardcoded from prior search) ──");
  // Hotel code 1241475 confirmed working in Delhi sandbox on 2026-03-19
  // Skipping TBOHotelCodeList static API call — unreachable from dev env
  // For cert purposes, a single known hotel code is sufficient
  const hotelCodesString = "1241475";
  console.log(`[HOTEL-CODES] Using hardcoded hotel code: ${hotelCodesString}`);

  /* ── Step 2: Search ── */
  console.log("\n── Step 2: HotelSearch ──");

  const searchBody = {
    CheckIn: checkIn,
    CheckOut: checkOut,
    HotelCodes: hotelCodesString,
    GuestNationality: "IN",
    PaxRooms: paxRooms,
    ResponseTime: 23,
    IsDetailedResponse: true,
    Filters: { Refundable: false, NoOfRooms: 0, MealType: "All" },
  };

  const searchController = new AbortController();
  const searchTimeout = setTimeout(() => searchController.abort(), 15_000);
  let searchData: any;
  try {
    searchData = await tboHotelPost(
      "https://affiliate.tektravels.com/HotelAPI/Search",
      searchBody,
      { method: "HotelSearch", traceId: caseTraceId, signal: searchController.signal },
    );
  } catch (e: any) {
    if (e.name === "AbortError") {
      console.error("[SEARCH] ❌ Request timed out after 15s");
      console.error("[SEARCH] The TBO search API (affiliate.tektravels.com) may be unreachable");
      console.error("[SEARCH] Try: curl -X POST https://affiliate.tektravels.com/HotelAPI/Search");
      process.exit(1);
    }
    throw e;
  } finally {
    clearTimeout(searchTimeout);
  }

  const rawResults: any[] =
    searchData?.HotelResult ||
    searchData?.HotelSearchResult?.HotelResults ||
    [];
  const allHotels: any[] = Array.isArray(rawResults) ? rawResults.flat() : [];

  if (allHotels.length === 0) {
    console.error("[SEARCH] ❌ No hotels returned from search");
    process.exit(1);
  }

  const selectedHotel = allHotels.find(
    (h: any) => h.Rooms?.some((r: any) => r.BookingCode),
  );

  if (!selectedHotel) {
    console.error("[SEARCH] ❌ No hotel has a BookingCode");
    console.error(
      "[SEARCH] First 3 hotels structure:",
      JSON.stringify(allHotels.slice(0, 3), null, 2),
    );
    process.exit(1);
  }

  let bookingCode: string = selectedHotel.Rooms.find((r: any) => r.BookingCode)!.BookingCode;
  console.log(`[SEARCH] Found ${allHotels.length} hotels`);
  console.log(
    `[SEARCH] Selected: ${selectedHotel.HotelCode} ${selectedHotel.HotelName || ""} Rooms available: ${selectedHotel.Rooms?.length}`,
  );
  console.log(`[SEARCH] BookingCode: ${bookingCode.slice(0, 40)}...`);

  /* ── Step 3: PreBook ── */
  console.log("\n── Step 3: HotelPreBook ──");

  const prebookData = await tboHotelPost(
    "https://affiliate.tektravels.com/HotelAPI/PreBook",
    { BookingCode: bookingCode },
    { method: "HotelPreBook", traceId: caseTraceId },
  );

  console.log("[PREBOOK] Full response:", JSON.stringify(prebookData, null, 2));

  const hotelResult = prebookData?.HotelResult?.[0];
  const prebookRoom = hotelResult?.Rooms?.[0];
  const netAmount = prebookRoom?.NetAmount || prebookRoom?.TotalFare || 0;
  const updatedBookingCode: string = prebookRoom?.BookingCode || bookingCode;
  const validationInfo = prebookData?.ValidationInfo || {};
  const panMandatory = validationInfo?.PanMandatory === true;

  console.log(`[PREBOOK] NetAmount: ${netAmount}`);
  console.log(`[PREBOOK] UpdatedBookingCode: ${updatedBookingCode.slice(0, 40)}...`);
  console.log(`[PREBOOK] ValidationInfo: ${JSON.stringify(validationInfo)}`);
  console.log(`[PREBOOK] PanMandatory: ${panMandatory} — ${panMandatory ? "will send PAN for lead pax" : "no PAN required"}`);

  if (!netAmount) {
    console.error("[PREBOOK] ❌ Could not extract NetAmount from response");
    console.error("[PREBOOK] Room data:", JSON.stringify(prebookRoom, null, 2));
    process.exit(1);
  }

  /* ── Step 4: Build passengers ── */
  console.log("\n── Step 4: Build Passengers ──");

  const hotelRoomsDetails = buildPassengers(paxRooms, panMandatory);

  /* ── Step 5: Book ── */
  console.log("\n── Step 5: HotelBook ──");

  const tboBookPayload = {
    EndUserIp: END_USER_IP,
    BookingCode: updatedBookingCode,
    ClientReferenceId: `PLM-${randomUUID()}`,
    GuestNationality: "IN",
    IsVoucherBooking: true,
    RequestedBookingMode: 5,
    NetAmount: netAmount,
    HotelRoomsDetails: hotelRoomsDetails,
  };

  const bookData = await tboHotelPost(
    "https://hotelbe.tektravels.com/hotelservice.svc/rest/book/",
    tboBookPayload,
    { method: "HotelBook", traceId: caseTraceId },
  );

  console.log("[BOOK] Full response:", JSON.stringify(bookData, null, 2));

  const bookResult = bookData?.BookResult || bookData;
  bookingId = bookResult?.BookingId;
  confirmationNo =
    bookResult?.ConfirmationNo || bookResult?.BookingRefNo || "";
  bookingStatus =
    bookResult?.HotelBookingStatus || bookResult?.BookingStatus || "";
  const tboStatus: number | undefined = bookResult?.Status;

  console.log(`[BOOK] Status: ${tboStatus}, HotelBookingStatus: ${bookingStatus}`);
  console.log(`[BOOK] BookingId: ${bookingId}`);
  console.log(`[BOOK] ConfirmationNo: ${confirmationNo}`);

  if (tboStatus === 3) {
    console.log("[BOOK] ⚠️  Price changed — IsPriceChanged: true");
    console.log(`[BOOK] New NetAmount from response: ${bookResult?.NetAmount}`);
  }

  if (!bookingId && tboStatus !== 1) {
    console.log("[BOOK] ❌ FAILED — no BookingId returned");
    console.log(`[BOOK] Error: ${bookResult?.Error?.ErrorMessage || "unknown"}`);
  }

  /* ── Step 6: GetBookingDetail ── */
  if (bookingId) {
    console.log("\n── Step 6: GetBookingDetail ──");

    const gbdData = await tboHotelPost(
      "https://hotelbe.tektravels.com/hotelservice.svc/rest/GetBookingDetail/",
      { EndUserIp: END_USER_IP, BookingId: Number(bookingId) },
      { method: "HotelGetBookingDetail", traceId: caseTraceId },
    );

    console.log(`[GBD] Status: ${gbdData?.GetBookingDetailResult?.Status ?? gbdData?.Status}`);
    console.log("[GBD] Full response:", JSON.stringify(gbdData, null, 2));
  } else {
    console.log("\n── Step 6: GetBookingDetail — SKIPPED (no BookingId) ──");
  }

  /* ── Step 7: Consolidate cert logs ── */
  console.log("\n── Step 7: Consolidate Logs ──");

  try {
    await consolidateHotelCertificationLogs(
      caseTraceId,
      Number(bookingId) || 0,
      confirmationNo,
      caseLabelMap[caseNum],
    );
    console.log("[CERT] ✅ Logs consolidated as " + caseLabelMap[caseNum]);
  } catch (err: any) {
    console.error("[CERT] ❌ Consolidation failed:", err?.message);
  }

  /* ── Step 8: Summary ── */
  console.log(`
╔══════════════════════════════════════════════════╗
║           CERTIFICATION SUMMARY                  ║
╠══════════════════════════════════════════════════╣
  Case:           ${caseLabelMap[caseNum]}
  City:           Delhi (${DOMESTIC_CITY_CODE})
  CheckIn:        ${checkIn}
  CheckOut:       ${checkOut}
  Rooms:          ${paxRooms.length}
  TraceId:        ${caseTraceId}
  BookingCode:    ${bookingCode.slice(0, 40)}...
  BookingId:      ${bookingId}
  ConfirmationNo: ${confirmationNo}
  Status:         ${bookingStatus}
  Cert:           ${caseLabelMap[caseNum]}
╚══════════════════════════════════════════════════╝`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
