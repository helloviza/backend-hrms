/**
 * TBO Hotel Certification — All 8 Cases
 * ======================================
 * Run from: apps/backend/
 * Command:  npx tsx src/scripts/test-hotel-cert-all-cases.ts
 *
 * Produces: apps/backend/src/logs/tbo/hotel-cert/
 *   ├── Authentication.txt          ← shared auth log (one for all cases)
 *   ├── Case1_Hotel_Domestic_1R_1A/
 *   │   ├── HotelSearch.txt
 *   │   ├── HotelPreBook.txt
 *   │   ├── HotelBook.txt
 *   │   ├── HotelGetBookingDetail.txt
 *   │   └── _summary.json
 *   ├── Case2_Hotel_Domestic_1R_2A2C/   ...same structure
 *   ...
 *   └── Case8_Hotel_Intl_2R_1A2C_2A/    ...same structure
 *
 * Case Matrix:
 *   Case 1: Domestic  | 1 Room  | 1A
 *   Case 2: Domestic  | 1 Room  | 2A 2C
 *   Case 3: Domestic  | 2 Rooms | (1A) + (1A)
 *   Case 4: Domestic  | 2 Rooms | (1A 2C) + (2A)
 *   Case 5: Intl      | 1 Room  | 1A
 *   Case 6: Intl      | 1 Room  | 2A 2C
 *   Case 7: Intl      | 2 Rooms | (1A) + (1A)
 *   Case 8: Intl      | 2 Rooms | (1A 2C) + (2A)
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });

// ─── CONFIG ────────────────────────────────────────────────────────────────

const HOTEL_USERNAME = process.env.TBO_HOTEL_USERNAME!;
const HOTEL_PASSWORD = process.env.TBO_HOTEL_PASSWORD!;
const TBO_CLIENT_ID = process.env.TBO_ClientId!;
const TBO_USERNAME = process.env.TBO_UserName!;
const TBO_PASSWORD = process.env.TBO_Password!;
const END_USER_IP = process.env.TBO_EndUserIp || "49.43.241.81";
const BASIC_AUTH = Buffer.from(`${HOTEL_USERNAME}:${HOTEL_PASSWORD}`).toString("base64");

const AUTH_URL = "http://Sharedapi.tektravels.com/SharedData.svc/rest/Authenticate";

// TBO Hotel API endpoints (HTTPS for hotel, unlike flights)
const SEARCH_URL = "https://affiliate.tektravels.com/HotelAPI/Search";
const PREBOOK_URL = "https://affiliate.tektravels.com/HotelAPI/PreBook";
const BOOK_URL = "https://hotelbe.tektravels.com/hotelservice.svc/rest/book/";
const GET_BOOKING_DETAIL_URL = "https://hotelbe.tektravels.com/hotelservice.svc/rest/GetBookingDetail/";

// Cert hotel codes — mix of domestic (Delhi) and international (Dubai)
// Using known working hotel codes from previous certification run
const DOMESTIC_HOTEL_CODES = "1000084,1000027,1000089,1000171,1000167,1000302,1000198,1000538,1000648,1000937";
const INTL_HOTEL_CODES = "1000957,1000847,1000872,1001049,1001056,1001143,1001122,1001046,1463986,1491912";

// Dates: check-in tomorrow+7, check-out +1 day
const today = new Date();
const checkIn = new Date(today);
checkIn.setDate(today.getDate() + 7);
const checkOut = new Date(checkIn);
checkOut.setDate(checkIn.getDate() + 1);

const CHECK_IN = checkIn.toISOString().split("T")[0];
const CHECK_OUT = checkOut.toISOString().split("T")[0];

// Output directory
const OUT_DIR = path.resolve("src/logs/tbo/hotel-cert");

// ─── CERT PASSENGER DATA ───────────────────────────────────────────────────

const ADULT_1 = {
  Title: "Mr",
  FirstName: "CertHtl",
  LastName: "Adulone",
  MiddleName: "",
  Phoneno: "9876543210",
  Email: "test@plumtrips.com",
  PaxType: 1,
  LeadPassenger: true,
  Age: 0,
  PassportNo: "",
  PassportIssueDate: "0001-01-01T00:00:00",
  PassportExpDate: "0001-01-01T00:00:00",
  PAN: "GSBPM2112A",
};

const ADULT_2 = {
  Title: "Mrs",
  FirstName: "CertHtl",
  LastName: "Adultwo",
  MiddleName: "",
  Phoneno: "9876543210",
  Email: "test2@plumtrips.com",
  PaxType: 1,
  LeadPassenger: false,
  Age: 0,
  PassportNo: "",
  PassportIssueDate: "0001-01-01T00:00:00",
  PassportExpDate: "0001-01-01T00:00:00",
  PAN: "GSBPM2112A",
};

const CHILD_1 = {
  Title: "Miss",
  FirstName: "CertHtl",
  LastName: "Childone",
  MiddleName: "",
  Phoneno: "9876543210",
  Email: "test@plumtrips.com",
  PaxType: 2,
  LeadPassenger: false,
  Age: 8,
  PassportNo: "",
  PassportIssueDate: "0001-01-01T00:00:00",
  PassportExpDate: "0001-01-01T00:00:00",
  PAN: "GSBPM2112A",
};

const CHILD_2 = {
  Title: "Miss",
  FirstName: "CertHtl",
  LastName: "Childtwo",
  MiddleName: "",
  Phoneno: "9876543210",
  Email: "test@plumtrips.com",
  PaxType: 2,
  LeadPassenger: false,
  Age: 6,
  PassportNo: "",
  PassportIssueDate: "0001-01-01T00:00:00",
  PassportExpDate: "0001-01-01T00:00:00",
  PAN: "GSBPM2112A",
};

// ─── CASE DEFINITIONS ─────────────────────────────────────────────────────

interface CaseConfig {
  label: string;
  isInternational: boolean;
  paxRooms: { Adults: number; Children: number; ChildrenAges: number[] | null }[];
  guestRooms: { HotelPassenger: typeof ADULT_1[] }[];
}

const CASES: CaseConfig[] = [
  // Case 1: Domestic 1R 1A
  {
    label: "Case1_Hotel_Domestic_1R_1A",
    isInternational: false,
    paxRooms: [{ Adults: 1, Children: 0, ChildrenAges: null }],
    guestRooms: [{ HotelPassenger: [{ ...ADULT_1, LeadPassenger: true }] }],
  },

  // Case 2: Domestic 1R 2A2C
  {
    label: "Case2_Hotel_Domestic_1R_2A2C",
    isInternational: false,
    paxRooms: [{ Adults: 2, Children: 2, ChildrenAges: [8, 6] }],
    guestRooms: [
      {
        HotelPassenger: [
          { ...ADULT_1, LeadPassenger: true },
          { ...ADULT_2, LeadPassenger: false },
          { ...CHILD_1 },
          { ...CHILD_2 },
        ],
      },
    ],
  },

  // Case 3: Domestic 2R (1A) + (1A)
  {
    label: "Case3_Hotel_Domestic_2R_1A_1A",
    isInternational: false,
    paxRooms: [
      { Adults: 1, Children: 0, ChildrenAges: null },
      { Adults: 1, Children: 0, ChildrenAges: null },
    ],
    guestRooms: [
      { HotelPassenger: [{ ...ADULT_1, LeadPassenger: true }] },
      { HotelPassenger: [{ ...ADULT_2, LeadPassenger: true }] },
    ],
  },

  // Case 4: Domestic 2R (1A2C) + (2A)
  {
    label: "Case4_Hotel_Domestic_2R_1A2C_2A",
    isInternational: false,
    paxRooms: [
      { Adults: 1, Children: 2, ChildrenAges: [8, 6] },
      { Adults: 2, Children: 0, ChildrenAges: null },
    ],
    guestRooms: [
      {
        HotelPassenger: [
          { ...ADULT_1, LeadPassenger: true },
          { ...CHILD_1 },
          { ...CHILD_2 },
        ],
      },
      {
        HotelPassenger: [
          { ...ADULT_2, LeadPassenger: true },
          { ...ADULT_1, LeadPassenger: false, FirstName: "CertHtl", LastName: "Adulthree" },
        ],
      },
    ],
  },

  // Case 5: International 1R 1A
  {
    label: "Case5_Hotel_Intl_1R_1A",
    isInternational: true,
    paxRooms: [{ Adults: 1, Children: 0, ChildrenAges: null }],
    guestRooms: [{ HotelPassenger: [{ ...ADULT_1, LeadPassenger: true }] }],
  },

  // Case 6: International 1R 2A2C
  {
    label: "Case6_Hotel_Intl_1R_2A2C",
    isInternational: true,
    paxRooms: [{ Adults: 2, Children: 2, ChildrenAges: [8, 6] }],
    guestRooms: [
      {
        HotelPassenger: [
          { ...ADULT_1, LeadPassenger: true },
          { ...ADULT_2, LeadPassenger: false },
          { ...CHILD_1 },
          { ...CHILD_2 },
        ],
      },
    ],
  },

  // Case 7: International 2R (1A) + (1A)
  {
    label: "Case7_Hotel_Intl_2R_1A_1A",
    isInternational: true,
    paxRooms: [
      { Adults: 1, Children: 0, ChildrenAges: null },
      { Adults: 1, Children: 0, ChildrenAges: null },
    ],
    guestRooms: [
      { HotelPassenger: [{ ...ADULT_1, LeadPassenger: true }] },
      { HotelPassenger: [{ ...ADULT_2, LeadPassenger: true }] },
    ],
  },

  // Case 8: International 2R (1A2C) + (2A)
  {
    label: "Case8_Hotel_Intl_2R_1A2C_2A",
    isInternational: true,
    paxRooms: [
      { Adults: 1, Children: 2, ChildrenAges: [8, 6] },
      { Adults: 2, Children: 0, ChildrenAges: null },
    ],
    guestRooms: [
      {
        HotelPassenger: [
          { ...ADULT_1, LeadPassenger: true },
          { ...CHILD_1 },
          { ...CHILD_2 },
        ],
      },
      {
        HotelPassenger: [
          { ...ADULT_2, LeadPassenger: true },
          { ...ADULT_1, LeadPassenger: false, FirstName: "CertHtl", LastName: "Adulthree" },
        ],
      },
    ],
  },
];

// ─── UTILITIES ─────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function formatLog(label: string, req: unknown, res: unknown): string {
  return `Request :\n\n${JSON.stringify(req, null, 2)}\n\nResponse :\n\n${JSON.stringify(res, null, 2)}\n`;
}

function writeLog(dir: string, filename: string, req: unknown, res: unknown) {
  fs.writeFileSync(path.join(dir, filename), formatLog(filename.replace(".txt", ""), req, res), "utf8");
}

async function hotelPost(url: string, body: unknown): Promise<{ req: unknown; res: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Basic ${BASIC_AUTH}`,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  const data = await response.json();
  return { req: body, res: data };
}

// ─── AUTH ──────────────────────────────────────────────────────────────────

async function authenticate(): Promise<{ tokenId: string; logEntry: { req: unknown; res: unknown } }> {
  log("Authenticating with TBO SharedData API...");

  const authReq = {
    ClientId: TBO_CLIENT_ID,
    UserName: TBO_USERNAME,
    Password: TBO_PASSWORD,
    EndUserIp: END_USER_IP,
  };

  const response = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(authReq),
  });

  if (!response.ok) {
    throw new Error(`Auth HTTP ${response.status}`);
  }

  const authRes = await response.json();
  const tokenId = (authRes as any).TokenId;

  if (!tokenId) {
    throw new Error(`Auth failed — no TokenId. Response: ${JSON.stringify(authRes).substring(0, 300)}`);
  }

  log(`✅ Auth OK — TokenId: ${tokenId.substring(0, 20)}...`);
  return {
    tokenId,
    logEntry: { req: authReq, res: authRes },
  };
}

// ─── HOTEL BOOKING FLOW ────────────────────────────────────────────────────

async function runCase(cfg: CaseConfig, authLog: { req: unknown; res: unknown }) {
  const caseDir = path.join(OUT_DIR, cfg.label);
  fs.mkdirSync(caseDir, { recursive: true });

  const hotelCodes = cfg.isInternational ? INTL_HOTEL_CODES : DOMESTIC_HOTEL_CODES;
  const clientRef = `PLM-CERT-${Date.now()}`;

  log(`\n${"=".repeat(60)}`);
  log(`Running ${cfg.label}`);
  log(`CheckIn: ${CHECK_IN}  CheckOut: ${CHECK_OUT}`);
  log(`Rooms: ${cfg.paxRooms.length}  Intl: ${cfg.isInternational}`);
  log(`${"=".repeat(60)}`);

  // ── 1. SEARCH ─────────────────────────────────────────────────────────────
  log("Step 1/4: HotelSearch...");
  const searchReq = {
    CheckIn: CHECK_IN,
    CheckOut: CHECK_OUT,
    HotelCodes: hotelCodes,
    GuestNationality: "IN",
    PaxRooms: cfg.paxRooms,
    ResponseTime: 23,
    IsDetailedResponse: true,
    Filters: { Refundable: false, NoOfRooms: 0, MealType: "All" },
  };

  const searchResult = await hotelPost(SEARCH_URL, searchReq);
  writeLog(caseDir, "HotelSearch.txt", searchResult.req, searchResult.res);

  const searchData = searchResult.res as any;
  if (searchData.Status?.Code !== 200 || !searchData.HotelResult?.length) {
    throw new Error(`Search failed: ${JSON.stringify(searchData.Status)}`);
  }

  // Pick first available hotel result
  const hotelResult = searchData.HotelResult[0];
  const bookingCode = hotelResult.Rooms[0]?.BookingCode;
  const hotelCode = hotelResult.HotelCode;
  const hotelName = hotelResult.HotelName ?? `Hotel-${hotelCode}`;

  if (!bookingCode) throw new Error("No BookingCode in search result");
  log(`✅ Search OK — Hotel: ${hotelName} (${hotelCode}), BookingCode: ${bookingCode.substring(0, 40)}...`);

  // ── 2. PREBOOK ────────────────────────────────────────────────────────────
  log("Step 2/4: HotelPreBook...");
  const preBookReq = {
    BookingCode: bookingCode,
    CustomerDetails: cfg.guestRooms,
    PaymentMode: "Limit",
    ClientReferenceId: clientRef,
    GuestNationality: "IN",
    EndUserIp: END_USER_IP,
  };

  const preBookResult = await hotelPost(PREBOOK_URL, preBookReq);
  writeLog(caseDir, "HotelPreBook.txt", preBookResult.req, preBookResult.res);

  const preBookData = preBookResult.res as any;
  if (preBookData.Status?.Code !== 200) {
    throw new Error(`PreBook failed: ${JSON.stringify(preBookData.Status)}`);
  }

  // Extract NetAmount from PreBook response (fallback to search TotalFare)
  const netAmount =
    preBookData.HotelResult?.[0]?.Rooms?.[0]?.NetAmount ??
    preBookData.HotelResult?.[0]?.Rooms?.[0]?.TotalFare ??
    hotelResult.Rooms[0]?.TotalFare ??
    hotelResult.Rooms[0]?.NetAmount;

  log(`✅ PreBook OK — NetAmount: ${netAmount}`);

  // ── 3. BOOK ───────────────────────────────────────────────────────────────
  log("Step 3/4: HotelBook...");
  const bookReq = {
    EndUserIp: END_USER_IP,
    BookingCode: bookingCode,
    ClientReferenceId: clientRef,
    GuestNationality: "IN",
    IsVoucherBooking: true,
    RequestedBookingMode: 5,
    NetAmount: netAmount,
    HotelRoomsDetails: cfg.guestRooms,
  };

  const bookResult = await hotelPost(BOOK_URL, bookReq);
  writeLog(caseDir, "HotelBook.txt", bookResult.req, bookResult.res);

  const bookData = bookResult.res as any;
  const br = bookData.BookResult ?? bookData;
  const bookingId = br.BookingId ?? br.BookingRefNo;
  const confirmationNo = br.ConfirmationNo ?? br.ClientReferenceId;

  if (!bookingId) {
    throw new Error(`Book failed — no BookingId. Response: ${JSON.stringify(bookData).substring(0, 300)}`);
  }
  log(`✅ Book OK — BookingId: ${bookingId}, ConfirmationNo: ${confirmationNo}`);

  // ── 4. GET BOOKING DETAIL ─────────────────────────────────────────────────
  log("Step 4/4: HotelGetBookingDetail...");
  const getDetailReq = {
    BookingId: bookingId,
    EndUserIp: END_USER_IP,
  };

  const getDetailResult = await hotelPost(GET_BOOKING_DETAIL_URL, getDetailReq);
  writeLog(caseDir, "HotelGetBookingDetail.txt", getDetailResult.req, getDetailResult.res);

  const detailData = getDetailResult.res as any;
  log(`✅ GetBookingDetail OK — Status: ${detailData.Status?.Code}`);

  // ── AUTHENTICATION LOG (per-case copy) ────────────────────────────────────
  writeLog(caseDir, "Authentication.txt", authLog.req, authLog.res);

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  const summary = {
    caseLabel: cfg.label,
    hotelCode,
    hotelName,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    bookingCode: bookingCode.substring(0, 80) + "...",
    bookingId,
    confirmationNo,
    netAmount,
    rooms: cfg.paxRooms.length,
    isInternational: cfg.isInternational,
    consolidatedAt: new Date().toISOString(),
    files: ["Authentication.txt", "HotelSearch.txt", "HotelPreBook.txt", "HotelBook.txt", "HotelGetBookingDetail.txt"],
  };

  fs.writeFileSync(path.join(caseDir, "_summary.json"), JSON.stringify(summary, null, 2), "utf8");

  log(`✅ ${cfg.label} COMPLETE — BookingId ${bookingId}`);
  return summary;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
  log("TBO Hotel Certification — All 8 Cases");
  log(`Output directory: ${OUT_DIR}`);
  log(`Check-in: ${CHECK_IN}  Check-out: ${CHECK_OUT}`);
  log("");

  if (!HOTEL_USERNAME || !HOTEL_PASSWORD) {
    console.error("❌ TBO_HOTEL_USERNAME or TBO_HOTEL_PASSWORD not set in .env");
    process.exit(1);
  }
  if (!TBO_CLIENT_ID || !TBO_USERNAME || !TBO_PASSWORD) {
    console.error("❌ TBO_CLIENT_ID, TBO_USERNAME, or TBO_PASSWORD not set in .env");
    process.exit(1);
  }

  // Create output directory
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Authenticate once
  const { logEntry: authLog } = await authenticate();

  // Write shared Authentication.txt at root (one for all cases, as required by TBO)
  fs.writeFileSync(
    path.join(OUT_DIR, "Authentication.txt"),
    formatLog("Authentication", authLog.req, authLog.res),
    "utf8"
  );
  log(`✅ Authentication.txt written (shared)\n`);

  // Run all 8 cases sequentially (avoid overwhelming TBO sandbox)
  const results: any[] = [];
  const failed: string[] = [];

  for (const cfg of CASES) {
    try {
      const summary = await runCase(cfg, authLog);
      results.push(summary);
      // Small delay between cases
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err: any) {
      log(`❌ ${cfg.label} FAILED: ${err.message}`);
      failed.push(`${cfg.label}: ${err.message}`);
    }
  }

  // ── FINAL REPORT ────────────────────────────────────────────────────────
  log("\n" + "=".repeat(60));
  log("CERTIFICATION RUN COMPLETE");
  log("=".repeat(60));

  for (const r of results) {
    log(`✅ ${r.caseLabel} — BookingId: ${r.bookingId} | ${r.hotelName}`);
  }

  if (failed.length) {
    log("\n❌ FAILED CASES:");
    failed.forEach((f) => log(`   ${f}`));
  }

  log(`\n📁 Logs at: ${OUT_DIR}`);
  log(`   Each case folder contains:`);
  log(`     Authentication.txt`);
  log(`     HotelSearch.txt`);
  log(`     HotelPreBook.txt`);
  log(`     HotelBook.txt`);
  log(`     HotelGetBookingDetail.txt`);
  log(`     _summary.json`);
  log(`\nNext: zip each case folder individually and send to TBO.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
