// apps/backend/src/scripts/render-voucher-sample.ts
//
// Phase 2b — standalone fidelity check for the new in-process Puppeteer
// renderer. Renders a sample flight e-ticket and a sample hotel voucher from
// the SHARED templates (@plumtrips/shared) through renderHtmlToPdf() and writes
// the PDFs to disk so we can eyeball them against the live SBT voucher design
// BEFORE wiring the renderer into the extract flow (Phase 2c).
//
// Run (local dev — uses native puppeteer Chrome via chromeResolver):
//   pnpm -C apps/backend tsx src/scripts/render-voucher-sample.ts
//   pnpm -C apps/backend tsx src/scripts/render-voucher-sample.ts ./out-dir
//
// It touches NOTHING in the extract flow and writes only to disk.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  generateTicketHTML,
  type TicketBooking,
} from "@plumtrips/shared/voucher-templates/ticketGenerator";
import {
  generateHotelVoucherHTML,
  type HotelVoucherParams,
} from "@plumtrips/shared/voucher-templates/hotelVoucherGenerator";

import { renderHtmlToPdf, closeVoucherPdfBrowser } from "../services/voucherPdfRenderer.js";

const sampleFlight: TicketBooking = {
  pnr: "Q7X4LM",
  bookingId: "PT-FL-2026-004821",
  ticketId: "098-2412345678",
  status: "CONFIRMED",
  origin: { code: "DEL", city: "Delhi" },
  destination: { code: "BOM", city: "Mumbai" },
  departureTime: "2026-06-14T08:35:00+05:30",
  arrivalTime: "2026-06-14T10:50:00+05:30",
  airlineCode: "AI",
  airlineName: "Air India",
  flightNumber: "AI-865",
  cabin: 2,
  passengers: [
    { title: "Mr", firstName: "Imran", lastName: "Khan", paxType: "adult", isLead: true },
    { title: "Mrs", firstName: "Sara", lastName: "Khan", paxType: "adult", isLead: false },
  ],
  baseFare: 8200,
  taxes: 1450,
  extras: 0,
  totalFare: 9650,
  currency: "INR",
  isLCC: false,
  createdAt: new Date().toISOString(),
};

const sampleHotel: HotelVoucherParams = {
  hotelName: "The Taj Mahal Palace",
  hotelAddress: "Apollo Bunder, Colaba, Mumbai, Maharashtra 400001, India",
  supportEmail: "concierge@plumtrips.com",
  checkIn: "2026-06-14",
  checkOut: "2026-06-17",
  roomName: "Luxury Grand Room, Sea View",
  bookingId: "PT-HT-2026-001934",
  confirmationNo: "TBO-99182734",
  bookingRefNo: "BR-557213",
  invoiceNumber: "INV-2026-0481",
  tboReferenceNo: "1456789",
  roomDescription: "King bed · Sea-facing · Complimentary breakfast for two",
  rateConditions: ["Non-smoking", "Free cancellation until 48h before check-in"],
  amenities: ["Free WiFi", "Pool", "Spa", "Airport transfer", "24h room service"],
  guestFirstName: "Imran",
  leadGuestName: "Mr Imran Khan",
  inclusions: ["Daily breakfast", "Welcome drink", "Late checkout (subject to availability)"],
  cancelPolicies: [],
  displayVoucherStatus: "CONFIRMED",
  totalFare: 87400,
  qrUrl: "https://plumtrips.com/booking/PT-HT-2026-001934",
  reconciled: true,
  showPrintButton: false,
};

async function main() {
  const outDir = resolve(process.cwd(), process.argv[2] || "tmp/voucher-samples");
  mkdirSync(outDir, { recursive: true });

  console.log("[sample] generating flight e-ticket HTML …");
  // showPrintButton=false so the floating button doesn't appear in the PDF.
  const flightHtml = await generateTicketHTML(sampleFlight, [], undefined, undefined, false);
  console.log("[sample] rendering flight PDF …");
  const flightPdf = await renderHtmlToPdf(flightHtml);
  const flightPath = resolve(outDir, "sample-flight-voucher.pdf");
  writeFileSync(flightPath, flightPdf);
  console.log(`[sample] wrote ${flightPath} (${flightPdf.length} bytes)`);

  console.log("[sample] generating hotel voucher HTML …");
  const hotelHtml = await generateHotelVoucherHTML(sampleHotel);
  console.log("[sample] rendering hotel PDF …");
  const hotelPdf = await renderHtmlToPdf(hotelHtml);
  const hotelPath = resolve(outDir, "sample-hotel-voucher.pdf");
  writeFileSync(hotelPath, hotelPdf);
  console.log(`[sample] wrote ${hotelPath} (${hotelPdf.length} bytes)`);

  await closeVoucherPdfBrowser();
  console.log("[sample] done — open the PDFs above to eyeball fidelity.");
}

main().catch(async (err) => {
  console.error("[sample] failed:", err);
  await closeVoucherPdfBrowser().catch(() => {});
  process.exit(1);
});
