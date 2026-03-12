import express from "express";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { sbtLogger } from "../utils/logger.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTRequest from "../models/SBTRequest.js";
import SBTConfig from "../models/SBTConfig.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { sendMail } from "../utils/mailer.js";
import { clearTBOToken, logoutTBO, getTBOTokenStatus, getAgencyBalance } from "../services/tbo.auth.service.js";
import {
  searchFlights,
  searchMultiCity,
  getFareQuote,
  getFareRule,
  bookFlight,
  ticketFlight,
  ticketLCC,
  getBookingDetails,
  getBookingDetailsByPNR,
  getSSR,
  releasePNR,
} from "../services/tbo.flight.service.js";

const router = express.Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadJson<T>(filename: string): T {
  const file = path.join(__dirname, "../data", filename);
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

type Airport = {
  code: string; name: string; city: string;
  cityCode: string; country: string; countryCode: string; label: string;
};

router.use(requireAuth);

// ─── SBT access guard ────────────────────────────────────────────────────────
// Verifies the user has sbtEnabled=true in the DB.
// Admin/SuperAdmin/HR users bypass this check so they can always inspect SBT data.
async function requireSBT(req: any, res: any, next: any) {
  try {
    const roles: string[] = (req.user?.roles || []).map((r: string) =>
      String(r).toUpperCase()
    );
    if (roles.includes("ADMIN") || roles.includes("SUPERADMIN") || roles.includes("HR")) {
      return next();
    }

    const userId = req.user?.id || req.user?._id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const user = await User.findById(userId).select("sbtEnabled").lean();
    if (!user || !(user as any).sbtEnabled) {
      return res.status(403).json({ error: "SBT access not enabled for this account" });
    }
    next();
  } catch {
    return res.status(500).json({ error: "Authorization check failed" });
  }
}

// ─── Travel-mode / booking-type guard for flights ────────────────────────────
async function requireFlightAccess(req: any, res: any, next: any) {
  try {
    const roles: string[] = (req.user?.roles || []).map((r: string) =>
      String(r).toUpperCase()
    );
    if (roles.includes("ADMIN") || roles.includes("SUPERADMIN") || roles.includes("HR")) {
      return next();
    }

    const userId = req.user?.id || req.user?._id;
    const user = await User.findById(userId)
      .select("sbtBookingType customerId")
      .lean();

    if (!user) return res.status(401).json({ error: "User not found" });

    // Check user-level sbtBookingType
    if ((user as any).sbtBookingType &&
        (user as any).sbtBookingType !== "flight" &&
        (user as any).sbtBookingType !== "both") {
      return res.status(403).json({
        error: "Flight booking not permitted for your account",
        code: "FLIGHT_ACCESS_DENIED",
      });
    }

    // Check workspace-level travelMode
    if ((user as any).customerId) {
      const workspace = await CustomerWorkspace.findOne({ customerId: (user as any).customerId })
        .select("travelMode")
        .lean();

      if (workspace?.travelMode === "HOTELS_ONLY") {
        return res.status(403).json({
          error: "Flight booking not enabled for your company",
          code: "COMPANY_FLIGHT_ACCESS_DENIED",
        });
      }

      if (workspace?.travelMode === "APPROVAL_FLOW") {
        return res.status(403).json({
          error: "Direct booking not permitted. Please use the approval flow.",
          code: "APPROVAL_FLOW_REQUIRED",
        });
      }
    }

    next();
  } catch {
    return res.status(500).json({ error: "Access check failed" });
  }
}

// GET /api/sbt/flights/token/status — show current TBO token state (ADMIN only)
router.get("/token/status", requireAdmin, (_req: any, res: any) => {
  res.json({ ok: true, ...getTBOTokenStatus() });
});

// POST /api/sbt/flights/token/clear — clear in-memory cache (ADMIN only)
router.post("/token/clear", requireAdmin, (_req: any, res: any) => {
  clearTBOToken();
  res.json({ ok: true, message: "TBO token cache cleared. Will re-authenticate on next search." });
});

// POST /api/sbt/flights/token/logout — kill token on TBO side + clear cache (ADMIN only)
router.post("/token/logout", requireAdmin, async (_req: any, res: any) => {
  await logoutTBO();
  res.json({ ok: true, message: "TBO token logged out and cache cleared." });
});

// GET /api/sbt/flights/agency-balance — TBO wallet balance (ADMIN only)
router.get("/agency-balance", requireAdmin, async (_req: any, res: any) => {
  try {
    const data = await getAgencyBalance();
    res.json({ ok: true, ...(data as object) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch agency balance";
    res.status(500).json({ error: msg });
  }
});

// GET /api/sbt/flights/airports?q=del
router.get("/airports", (req, res) => {
  try {
    const airports = loadJson<Airport[]>("airports.json");
    const q = (req.query.q as string || "").toLowerCase().trim();
    if (!q || q.length < 2) return res.json([]);
    const codeExact = airports.filter(a => a.code?.toLowerCase() === q);
    const cityStarts = airports.filter(a => a.city?.toLowerCase().startsWith(q) && a.code?.toLowerCase() !== q);
    const nameStarts = airports.filter(
      a => a.name?.toLowerCase().startsWith(q) &&
        !a.city?.toLowerCase().startsWith(q) &&
        a.code?.toLowerCase() !== q
    );
    const matches = [...codeExact, ...cityStarts, ...nameStarts];
    res.json(matches.slice(0, 10));
  } catch (err: any) {
    sbtLogger.error("Airport search failed", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/airlines
router.get("/airlines", (_req, res) => {
  try {
    const airlines = loadJson<Record<string, string>>("airlines.json");
    res.json(airlines);
  } catch (err: any) {
    sbtLogger.error("Airlines list failed", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/search
router.post("/search", requireSBT, requireFlightAccess, async (req: any, res: any) => {
  try {
    if (process.env.TBO_ENV === "mock") {
      const { mockFlightSearch } = await import("../data/mock-flights.js");
      return res.json(mockFlightSearch);
    }
    const { JourneyType, segments, ...rest } = req.body;
    if (JourneyType === 3 || JourneyType === "3") {
      const result = await searchMultiCity({ segments, adults: rest.adults, children: rest.children, infants: rest.infants });
      return res.json(result);
    }
    const result: any = await searchFlights({ ...rest, JourneyType });
    const tboStatus = result?.Response?.ResponseStatus ?? result?.Response?.Status;
    if (tboStatus !== undefined && tboStatus !== 1) {
      const errMsg = result?.Response?.Error?.ErrorMessage || "Unknown TBO error";
      const errCode = result?.Response?.Error?.ErrorCode ?? "unknown";
      return res.status(502).json({
        error: `TBO Error ${errCode}: ${errMsg}`,
        tboStatus,
        tboResponse: result?.Response,
      });
    }
    res.json(result);
  } catch (err: any) {
    sbtLogger.error("Flight search failed", { userId: req.user?.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/farequote
router.post("/farequote", async (req: any, res: any) => {
  try {
    if (process.env.TBO_ENV === "mock") {
      return res.json({
        Response: {
          ResponseStatus: 1,
          Results: {
            IsLCC: true,
            NonRefundable: false,
            ResultIndex: req.body.ResultIndex,
            IsPriceChanged: false,
            Fare: {
              BaseFare: 3500,
              Tax: 800,
              TotalFare: 4300,
              PublishedFare: 4300,
              Currency: "INR",
            },
            Segments: [],
          },
        },
      });
    }
    const result = await getFareQuote(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/farerule
router.post("/farerule", async (req: any, res: any) => {
  try {
    if (process.env.TBO_ENV === "mock") {
      return res.json({
        Response: {
          ResponseStatus: 1,
          FareRules: [
            {
              Origin: req.body.Origin || "DEL",
              Destination: req.body.Destination || "BOM",
              FareRuleDetail:
                "Cancellation: ₹3,500 fee applies 0-24 hrs before departure.\nDate Change: ₹2,000 fee + fare difference.\nNo-show: Non-refundable.",
            },
          ],
        },
      });
    }
    const result = await getFareRule(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/book
router.post("/book", requireSBT, requireFlightAccess, async (req: any, res: any) => {
  try {
    const result = await bookFlight(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/ticket
router.post("/ticket", async (req: any, res: any) => {
  try {
    const result = await ticketFlight(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/booking/:id
router.get("/booking/:id", async (req: any, res: any) => {
  try {
    const result = await getBookingDetails({ bookingId: req.params.id });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/ssr
router.post("/ssr", async (req: any, res: any) => {
  try {
    if (process.env.TBO_ENV === "mock") {
      return res.json({
        Response: {
          ResponseStatus: 1,
          SeatDynamic: [],
          Baggage: [],
          MealDynamic: [],
        },
      });
    }
    const result = await getSSR(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/ticket-lcc
router.post("/ticket-lcc", async (req: any, res: any) => {
  try {
    const result = await ticketLCC(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/release
router.post("/release", async (req: any, res: any) => {
  try {
    const result = await releasePNR(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/booking/pnr/:pnr?firstName=X&lastName=Y
router.get("/booking/pnr/:pnr", async (req: any, res: any) => {
  try {
    const result = await getBookingDetailsByPNR({
      PNR: req.params.pnr,
      FirstName: req.query.firstName || "",
      LastName: req.query.lastName || "",
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Booking persistence routes ──────────────────────────────────────────────

// POST /api/sbt/flights/bookings/save — persist a confirmed booking
router.post("/bookings/save", async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const b = req.body;

    // Task 7: Check if webhook already created/confirmed this booking
    if (b.razorpayOrderId) {
      const existing = await SBTBooking.findOne({ razorpayOrderId: b.razorpayOrderId });
      if (existing && existing.status === "CONFIRMED") {
        // Webhook beat the frontend — update with any missing details
        existing.pnr = b.pnr || existing.pnr;
        existing.bookingId = b.bookingId || existing.bookingId;
        existing.ticketId = b.ticketId || existing.ticketId;
        existing.passengers = b.passengers?.length ? b.passengers : existing.passengers;
        existing.contactEmail = b.contactEmail || existing.contactEmail;
        existing.contactPhone = b.contactPhone || existing.contactPhone;
        existing.raw = b.raw ?? existing.raw;
        await existing.save();
        return res.json({ ok: true, booking: existing, webhookRecovered: true });
      }
    }

    const doc = await SBTBooking.create({
      userId,
      customerId: (req.user as any)?.customerId ?? undefined,
      sbtRequestId: b.sbtRequestId || undefined,
      pnr: b.pnr || `MOCK-${Date.now()}`,
      bookingId: b.bookingId || `BK-${Date.now()}`,
      ticketId: b.ticketId ?? "",
      status: b.status ?? "CONFIRMED",
      origin: b.origin,
      destination: b.destination,
      departureTime: b.departureTime,
      arrivalTime: b.arrivalTime,
      airlineCode: b.airlineCode,
      airlineName: b.airlineName,
      flightNumber: b.flightNumber,
      cabin: b.cabin ?? 2,
      passengers: b.passengers ?? [],
      contactEmail: b.contactEmail ?? "",
      contactPhone: b.contactPhone ?? "",
      baseFare: b.baseFare,
      taxes: b.taxes ?? 0,
      extras: b.extras ?? 0,
      totalFare: b.totalFare,
      currency: b.currency ?? "INR",
      isLCC: b.isLCC ?? false,
      razorpayPaymentId: b.razorpayPaymentId ?? "",
      razorpayOrderId: b.razorpayOrderId ?? "",
      razorpayAmount: b.razorpayAmount ?? 0,
      paymentStatus: b.paymentStatus ?? "pending",
      paymentTimestamp: b.paymentTimestamp ? new Date(b.paymentTimestamp) : undefined,
      bookedAt: new Date(),
      raw: b.raw,
    });

    // If this booking fulfils an SBT request, mark it as BOOKED and notify L1
    if (b.sbtRequestId) {
      try {
        const sbtReq = await SBTRequest.findById(b.sbtRequestId);
        if (sbtReq && sbtReq.status === "PENDING") {
          sbtReq.status = "BOOKED";
          (sbtReq as any).bookingId = doc._id;
          sbtReq.actedAt = new Date();
          await sbtReq.save();

          // Send confirmation email to L1 requester
          const requester = await User.findById(sbtReq.requesterId)
            .select("name email").lean() as any;
          if (requester?.email) {
            const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
            await sendMail({
              to: requester.email,
              subject: `Your flight has been booked — PNR ${doc.pnr}`,
              kind: "CONFIRMATIONS",
              html: `
                <h3>Booking Confirmed</h3>
                <p>Your flight request has been booked successfully.</p>
                <p><strong>PNR:</strong> ${doc.pnr}</p>
                <p><strong>Route:</strong> ${b.origin?.city || ""} → ${b.destination?.city || ""}</p>
                <p><strong>Departure:</strong> ${b.departureTime || ""}</p>
                <p><a href="${frontendUrl}/sbt/my-requests">View My Requests</a></p>
              `,
            }).catch((e: any) => sbtLogger.warn("Failed to send SBT booked email", { error: e?.message }));
          }
          sbtLogger.info("SBT request marked BOOKED via flight booking", {
            sbtRequestId: b.sbtRequestId, bookingDocId: doc._id,
          });
        }
      } catch (reqErr: any) {
        sbtLogger.warn("Failed to update SBT request after booking", { error: reqErr?.message });
      }
    }

    res.json({ ok: true, booking: doc });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to save booking";
    res.status(500).json({ error: msg });
  }
});

// GET /api/sbt/flights/bookings — list current user's bookings
router.get("/bookings", requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const bookings = await SBTBooking.find({ userId }).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, bookings });
  } catch (err: any) {
    sbtLogger.error("Bookings list failed", { userId: req.user?.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/bookings/:id — single booking detail
router.get("/bookings/:id", requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    const doc = await SBTBooking.findOne({ _id: req.params.id, userId }).lean();
    if (!doc) return res.status(404).json({ error: "Booking not found" });
    res.json({ ok: true, booking: doc });
  } catch (err: any) {
    sbtLogger.error("Booking detail failed", { userId: req.user?.id, bookingId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/bookings/:id/cancel-charges — estimate cancellation charges
router.get("/bookings/:id/cancel-charges", async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    const doc = await SBTBooking.findOne({ _id: req.params.id, userId }).lean();
    if (!doc) return res.status(404).json({ error: "Booking not found" });
    if (doc.status === "CANCELLED") return res.status(400).json({ error: "Already cancelled" });

    // Estimate: cancellation fee is ~15% of base fare (placeholder logic)
    const cancellationFee = Math.round(doc.baseFare * 0.15);
    const refundAmount = Math.max(0, doc.totalFare - cancellationFee);
    res.json({
      ok: true,
      bookingId: doc.bookingId,
      pnr: doc.pnr,
      cancellationFee,
      refundAmount,
      currency: doc.currency,
    });
  } catch (err: any) {
    sbtLogger.error("Cancel charges failed", { userId: req.user?.id, bookingId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/bookings/:id/cancel — cancel a booking
router.post("/bookings/:id/cancel", requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    const doc = await SBTBooking.findOne({ _id: req.params.id, userId });
    if (!doc) return res.status(404).json({ error: "Booking not found" });
    if (doc.status === "CANCELLED") return res.status(400).json({ error: "Already cancelled" });

    doc.status = "CANCELLED";
    doc.cancelledAt = new Date();
    await doc.save();

    res.json({ ok: true, booking: doc });
  } catch (err: any) {
    sbtLogger.error("Booking cancel failed", { userId: req.user?.id, bookingId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Razorpay Payment ───────────────────────────────────────────────────────

// POST /api/sbt/flights/payment/create-order
router.post("/payment/create-order", async (req: any, res: any) => {
  try {
    const { amount, currency = "INR", receipt } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return res.status(503).json({ error: "Payment gateway not configured" });
    }

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const orderRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100), // paise
        currency,
        receipt: receipt || `sbt_${Date.now()}`,
      }),
    });
    const order = await orderRes.json() as any;
    if (!orderRes.ok) {
      return res.status(502).json({ error: order?.error?.description || "Razorpay order creation failed" });
    }
    res.json({ ok: true, orderId: order.id, amount: order.amount, currency: order.currency, keyId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Payment order creation failed";
    res.status(500).json({ error: msg });
  }
});

// POST /api/sbt/flights/payment/verify
router.post("/payment/verify", async (req: any, res: any) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification fields" });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res.status(503).json({ error: "Payment gateway not configured" });
    }

    const { createHmac } = await import("crypto");
    const expectedSignature = createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Payment verification failed — signature mismatch" });
    }

    res.json({ ok: true, verified: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Payment verification failed";
    res.status(500).json({ error: msg });
  }
});

// GET /api/sbt/flights/offer — public-ish (auth only, no admin) offer config for tickets
router.get("/offer", async (_req: any, res: any) => {
  try {
    const doc = await SBTConfig.findOne({ key: "offer" }).lean();
    if (!doc) return res.json({ ok: true, enabled: false });
    res.json({ ok: true, ...((doc.value as any) ?? {}), enabled: (doc.value as any)?.enabled ?? false });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
