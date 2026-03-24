// apps/backend/src/scripts/migrateTravelBookings.ts
// One-time migration: backfill TravelBooking from SBTBooking, SBTHotelBooking, ApprovalRequest
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import TravelBooking from "../models/TravelBooking.js";
import User from "../models/User.js";

type TBStatus = "CONFIRMED" | "CANCELLED" | "PENDING" | "FAILED";
type TBService =
  | "FLIGHT"
  | "HOTEL"
  | "VISA"
  | "CAB"
  | "FOREX"
  | "ESIM"
  | "HOLIDAY"
  | "MICE"
  | "GIFTING"
  | "DECOR";

function mapStatus(s: string): TBStatus {
  if (s === "CONFIRMED") return "CONFIRMED";
  if (s === "CANCELLED") return "CANCELLED";
  if (s === "FAILED") return "FAILED";
  return "PENDING";
}

const SERVICE_MAP: Record<string, TBService> = {
  flight: "FLIGHT",
  flights: "FLIGHT",
  air: "FLIGHT",
  hotel: "HOTEL",
  hotels: "HOTEL",
  stay: "HOTEL",
  visa: "VISA",
  cab: "CAB",
  cabs: "CAB",
  taxi: "CAB",
  transfer: "CAB",
  forex: "FOREX",
  fx: "FOREX",
  currency: "FOREX",
  esim: "ESIM",
  "e-sim": "ESIM",
  sim: "ESIM",
  holiday: "HOLIDAY",
  holidays: "HOLIDAY",
  package: "HOLIDAY",
  tour: "HOLIDAY",
  mice: "MICE",
  gifting: "GIFTING",
  decor: "DECOR",
};

function parseServiceToken(raw: string): TBService | null {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  return SERVICE_MAP[s] || null;
}

function extractFromComments(history: any[]): { service: TBService | null; amount: number } {
  let service: TBService | null = null;
  let amount = 0;

  // Scan all history entries (newest first for priority)
  const entries = Array.isArray(history) ? [...history].reverse() : [];
  for (const h of entries) {
    const text = String(h?.comment || "");

    if (!service) {
      const sm = text.match(/\[SERVICE:([^\]]+)\]/i);
      if (sm?.[1]) service = parseServiceToken(sm[1]);
    }

    if (!amount) {
      const am = text.match(/\[BOOKING_AMOUNT:([^\]]+)\]/i);
      if (am?.[1]) {
        const n = Number(String(am[1]).replace(/[₹,]/g, "").trim());
        if (Number.isFinite(n) && n > 0) amount = n;
      }
    }

    if (service && amount) break;
  }

  // Also try cartItems for service type if not found in comments
  return { service, amount };
}

async function run() {
  await connectDb();
  console.log("Connected to MongoDB\n");

  let flightCount = 0;
  let hotelCount = 0;
  let approvalParsed = 0;
  let conciergeCreated = 0;
  let conciergeSkipped = 0;

  // ── Step 1: SBTBooking → TravelBooking ──
  console.log("Migrating SBTBooking records...");
  const flights = await SBTBooking.find().lean().exec();
  for (const f of flights as any[]) {
    try {
      await TravelBooking.findOneAndUpdate(
        { reference: f._id },
        {
          tenantId: f.customerId || "default",
          service: "FLIGHT",
          amount: f.totalFare || 0,
          userId: f.userId,
          status: mapStatus(f.status),
          paymentMode: f.paymentMode === "personal" ? "PERSONAL" : "OFFICIAL",
          source: "SBT",
          reference: f._id,
          referenceModel: "SBTBooking",
          destination: f.destination?.city || "",
          origin: f.origin?.city || "",
          bookedAt: f.bookedAt || f.createdAt,
          travelDate: f.departureTime ? new Date(f.departureTime) : null,
          travelDateEnd: f.arrivalTime ? new Date(f.arrivalTime) : null,
          metadata: {
            airlineName: f.airlineName,
            flightNumber: f.flightNumber,
            pnr: f.pnr,
            passengers: f.passengers?.length || 0,
          },
        },
        { upsert: true, new: true },
      );
      flightCount++;
    } catch (e: any) {
      console.error(`  Flight ${f._id} failed: ${e.message}`);
    }
  }
  console.log(`  ${flightCount} / ${flights.length} SBTBooking records migrated\n`);

  // ── Step 2: SBTHotelBooking → TravelBooking ──
  console.log("Migrating SBTHotelBooking records...");
  const hotels = await SBTHotelBooking.find().lean().exec();
  for (const h of hotels as any[]) {
    try {
      await TravelBooking.findOneAndUpdate(
        { reference: h._id },
        {
          tenantId: h.customerId || "default",
          service: "HOTEL",
          amount: h.totalFare || h.netAmount || 0,
          userId: h.userId,
          status: mapStatus(h.status),
          paymentMode: h.paymentMode === "personal" ? "PERSONAL" : "OFFICIAL",
          source: "SBT",
          reference: h._id,
          referenceModel: "SBTHotelBooking",
          destination: h.cityName || "",
          origin: "",
          bookedAt: h.bookedAt || h.createdAt,
          travelDate: h.checkIn ? new Date(h.checkIn) : null,
          travelDateEnd: h.checkOut ? new Date(h.checkOut) : null,
          metadata: {
            hotelName: h.hotelName,
            checkIn: h.checkIn,
            checkOut: h.checkOut,
            rooms: h.rooms,
            guests: h.guests?.length || 0,
          },
        },
        { upsert: true, new: true },
      );
      hotelCount++;
    } catch (e: any) {
      console.error(`  Hotel ${h._id} failed: ${e.message}`);
    }
  }
  console.log(`  ${hotelCount} / ${hotels.length} SBTHotelBooking records migrated\n`);

  // ── Step 3: ApprovalRequest (concierge bookings) ──
  console.log("Parsing ApprovalRequest records (adminState=done)...");
  const approvals = await ApprovalRequest.find({ adminState: "done" }).lean().exec();
  approvalParsed = approvals.length;

  // Build email→userId lookup for frontlinerEmail
  const emails = new Set<string>();
  for (const a of approvals as any[]) {
    if (a.frontlinerEmail) emails.add(String(a.frontlinerEmail).trim().toLowerCase());
  }
  const emailUsers = await User.find(
    { email: { $in: [...emails] } },
    { _id: 1, email: 1 },
  ).lean().exec();
  const emailToUserId: Record<string, any> = {};
  for (const u of emailUsers as any[]) {
    emailToUserId[String(u.email).toLowerCase()] = u._id;
  }

  for (const a of approvals as any[]) {
    const hist = Array.isArray(a.history) ? a.history : [];
    const { service, amount } = extractFromComments(hist);

    // Also try bookingAmount field directly
    const finalAmount = amount || a.bookingAmount || 0;

    // Also try to infer service from cartItems if not in comments
    let finalService = service;
    if (!finalService && Array.isArray(a.cartItems) && a.cartItems.length) {
      const cartType = String(a.cartItems[0]?.type || "").trim();
      finalService = parseServiceToken(cartType);
    }

    if (!finalService || finalAmount <= 0) {
      conciergeSkipped++;
      continue;
    }

    // Resolve userId: try frontlinerId as ObjectId, else look up by email
    let userId: any = null;
    const fid = String(a.frontlinerId || "").trim();
    if (fid && mongoose.Types.ObjectId.isValid(fid)) {
      userId = new mongoose.Types.ObjectId(fid);
    }
    if (!userId) {
      const femail = String(a.frontlinerEmail || "").trim().toLowerCase();
      userId = emailToUserId[femail] || null;
    }
    if (!userId) {
      conciergeSkipped++;
      continue;
    }

    try {
      await TravelBooking.findOneAndUpdate(
        { reference: a._id },
        {
          tenantId: a.customerId || "default",
          service: finalService,
          amount: finalAmount,
          userId,
          status: "CONFIRMED",
          paymentMode: "OFFICIAL",
          source: "CONCIERGE",
          reference: a._id,
          referenceModel: "ApprovalRequest",
          destination: "",
          origin: "",
          bookedAt: a.updatedAt || a.createdAt,
          metadata: {
            ticketId: a.ticketId,
            customerName: a.customerName,
            frontlinerName: a.frontlinerName,
          },
        },
        { upsert: true, new: true },
      );
      conciergeCreated++;
    } catch (e: any) {
      console.error(`  ApprovalRequest ${a._id} failed: ${e.message}`);
      conciergeSkipped++;
    }
  }

  console.log(`  ${approvalParsed} ApprovalRequest records parsed`);
  console.log(`  ${conciergeCreated} concierge bookings created`);
  console.log(`  ${conciergeSkipped} skipped (no service/amount token or no userId)\n`);

  // ── Summary ──
  const total = await TravelBooking.countDocuments();
  console.log("━━━ Migration Summary ━━━");
  console.log(`  SBTBooking       → ${flightCount} migrated`);
  console.log(`  SBTHotelBooking  → ${hotelCount} migrated`);
  console.log(`  ApprovalRequest  → ${conciergeCreated} concierge created (${conciergeSkipped} skipped)`);
  console.log(`  Total TravelBooking docs: ${total}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━");

  process.exit(0);
}

run().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
