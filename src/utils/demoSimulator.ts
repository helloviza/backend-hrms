// apps/backend/src/utils/demoSimulator.ts
//
// Demo Platform Sprint 2 — booking simulator.
//
// Every TBO booking write route checks `req.user.isDemoUser` and, if true,
// delegates to `maybeRouteToDemoSimulator(req, res, kind)`. The simulator
// produces a response structurally indistinguishable from the real TBO path,
// persists demo bookings into the existing SBTBooking / SBTHotelBooking
// collections (flagged `isDemo:true, createdByDemoUser:true`), and deducts
// from the demo workspace's wallet — without ever touching TBO.
//
// Design decisions (from the Sprint 2 audit):
//   P1: caller installs `if (await maybeRouteToDemoSimulator(...)) return;`
//       as the FIRST line inside each route handler's outer try{}.
//   P2: DB write → wallet deduct (mirrors real path order).
//   P3: wallet sufficient-funds check duplicated inline below (see TODO).
//   P4: synthetic PNRs are `${prefix}-${6 random alphanumeric upper}`.
//   P5: voucher template watermark is driven via VoucherExtraction.isDemo,
//       wired by the adapter — NOT this file.
//
// TODO post-Monday: centralize the wallet sufficient-funds check from
// sbt.wallet.ts:32-95. Currently inline-duplicated to avoid HTTP self-call
// latency in the highest-stakes UX path. See Sprint 2 audit P3.
import type { Request, Response } from "express";
import { randomBytes } from "crypto";
import mongoose from "mongoose";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import SBTRequest from "../models/SBTRequest.js";
import { sbtLogger } from "./logger.js";

export type DemoBookingKind =
  | "flight-book"
  | "flight-ticket"
  | "flight-ticket-lcc"
  | "flight-release"
  | "flight-cancel"
  | "flight-manual-reissue"
  | "flight-reissue-search"
  | "flight-reissue"
  | "hotel-prebook"
  | "hotel-book"
  | "hotel-voucher"
  | "hotel-generate-voucher"
  | "hotel-cancel"
  | "sbt-request-book";

/* ───────────────────────── PNR generation ───────────────────────── */

const PNR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // omit O,I,0,1

function randomAlphanumeric6(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += PNR_ALPHABET[bytes[i] % PNR_ALPHABET.length];
  }
  return out;
}

async function generateDemoPNR(prefix: "DMO-FLT" | "HTL-DMO"): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `${prefix}-${randomAlphanumeric6()}`;
    const collide = prefix === "DMO-FLT"
      ? await SBTBooking.findOne({ pnr: candidate }).select("_id").lean()
      : await SBTHotelBooking.findOne({ confirmationNo: candidate }).select("_id").lean();
    if (!collide) return candidate;
  }
  // Vanishingly unlikely at demo volumes (32^6 ≈ 1B suffix space).
  throw new Error("Could not generate a unique demo PNR after 5 attempts");
}

/* ───────────────────────── Wallet check ───────────────────────── */

type WalletResult = {
  ok: boolean;
  reason?: "wallet_disabled" | "limit_exceeded" | "no_workspace";
  remaining?: number;
  spendAfter?: number;
  monthlyLimit?: number;
};

async function simulateWalletDeduct(
  workspaceId: any,
  amount: number,
): Promise<WalletResult> {
  if (!workspaceId) return { ok: false, reason: "no_workspace" };
  const ws: any = await CustomerWorkspace.findById(workspaceId).lean();
  const ob = ws?.sbtOfficialBooking ?? {};

  if (!ob?.enabled) return { ok: false, reason: "wallet_disabled" };

  const monthKey = new Date().toISOString().slice(0, 7);
  let currentMonthSpend: number = ob.currentMonthSpend ?? 0;
  if (ob.lastResetMonth !== monthKey) {
    await CustomerWorkspace.findOneAndUpdate(
      { _id: workspaceId },
      {
        $set: {
          "sbtOfficialBooking.currentMonthSpend": 0,
          "sbtOfficialBooking.lastResetMonth": monthKey,
        },
      },
      { runValidators: false },
    );
    currentMonthSpend = 0;
  }

  const monthlyLimit: number = ob.monthlyLimit ?? 0;
  if (monthlyLimit > 0 && currentMonthSpend + amount > monthlyLimit) {
    return {
      ok: false,
      reason: "limit_exceeded",
      remaining: Math.max(0, monthlyLimit - currentMonthSpend),
    };
  }

  await CustomerWorkspace.findOneAndUpdate(
    { _id: workspaceId },
    { $inc: { "sbtOfficialBooking.currentMonthSpend": amount } },
    { runValidators: false },
  );

  return { ok: true, spendAfter: currentMonthSpend + amount, monthlyLimit };
}

async function refundDemoWallet(workspaceId: any, amount: number): Promise<void> {
  if (!workspaceId || amount <= 0) return;
  const ws: any = await CustomerWorkspace.findById(workspaceId).select("sbtOfficialBooking").lean();
  const current: number = ws?.sbtOfficialBooking?.currentMonthSpend ?? 0;
  const cappedRefund = Math.min(amount, current); // never below zero
  if (cappedRefund <= 0) return;
  await CustomerWorkspace.findOneAndUpdate(
    { _id: workspaceId },
    { $inc: { "sbtOfficialBooking.currentMonthSpend": -cappedRefund } },
    { runValidators: false },
  );
}

/* ───────────────────────── small helpers ───────────────────────── */

function getUserId(req: any): string {
  return String(req.user?._id ?? req.user?.id ?? req.user?.sub ?? "");
}

function asObjectId(id: any): mongoose.Types.ObjectId | undefined {
  if (!id) return undefined;
  const s = String(id);
  if (mongoose.Types.ObjectId.isValid(s)) return new mongoose.Types.ObjectId(s);
  return undefined;
}

/* ───────────────────────── flight handlers ───────────────────────── */

async function handleFlightBook(req: any, res: Response): Promise<void> {
  const traceId = req.body?.TraceId || `demo-${Date.now()}`;
  const pnr = await generateDemoPNR("DMO-FLT");
  const synthBookingId = Math.floor(1000000000 + Math.random() * 8999999999); // 10-digit numeric

  const passengers: any[] = Array.isArray(req.body?.Passengers) ? req.body.Passengers : [];
  const totalFare: number = Number(req.body?.totalFare ?? req.body?.netAmount ?? 0);
  const baseFare: number = Number(req.body?.baseFare ?? 0);
  const taxes: number = Number(req.body?.taxes ?? 0);

  const workspaceId = (req as any).workspaceObjectId;
  const userId = asObjectId(getUserId(req));

  // P2: persist first, then wallet deduct
  const doc = await SBTBooking.create({
    userId: userId as any,
    workspaceId,
    pnr,
    bookingId: String(synthBookingId),
    ticketId: "",
    traceId,
    status: "CONFIRMED",
    origin: {
      code: req.body?.originCode || "DEL",
      city: req.body?.originCity || "Delhi",
    },
    destination: {
      code: req.body?.destinationCode || "BOM",
      city: req.body?.destinationCity || "Mumbai",
    },
    departureTime: req.body?.departureDate || new Date().toISOString(),
    arrivalTime: req.body?.arrivalDate || new Date().toISOString(),
    airlineCode: req.body?.airlineCode || "DM",
    airlineName: req.body?.airlineName || "Demo Airways",
    flightNumber: req.body?.flightNumber || "DM-101",
    cabin: req.body?.cabin ?? 2,
    passengers: passengers.map((p) => ({
      title: p.Title || "Mr",
      firstName: p.FirstName || "",
      lastName: p.LastName || "",
      paxType: String(p.PaxType ?? "adult"),
      isLead: !!p.IsLeadPax,
      contactNo: p.ContactNo || "",
      email: p.Email || "",
    })),
    contactEmail: passengers[0]?.Email || "",
    contactPhone: passengers[0]?.ContactNo || "",
    baseFare,
    taxes,
    extras: 0,
    totalFare,
    currency: req.body?.currency || "INR",
    isLCC: false,
    paymentMode: "official",
    ticketingStatus: "NOT_ATTEMPTED",
    bookedAt: new Date(),
    isDemo: true,
    createdByDemoUser: true,
  });

  const wallet = await simulateWalletDeduct(workspaceId, totalFare);
  if (!wallet.ok) {
    await SBTBooking.findByIdAndUpdate(doc._id, {
      status: "FAILED",
      failureReason: `wallet_${wallet.reason}`,
    });
    sbtLogger.info("[DEMO] flight-book wallet rejected", { reason: wallet.reason, totalFare });
    res.status(402).json({
      error: wallet.reason === "limit_exceeded"
        ? "Monthly travel limit exceeded for this demo workspace."
        : "Wallet is not enabled for this demo workspace.",
      code: wallet.reason.toUpperCase(),
      isDemo: true,
    });
    return;
  }

  sbtLogger.info("[DEMO] flight-book persisted + wallet deducted", { pnr, bookingId: synthBookingId, totalFare });

  // Mimic the TBO Book response shape so the existing route consumers render normally.
  res.json({
    Response: {
      ResponseStatus: 1,
      Error: { ErrorCode: 0, ErrorMessage: "" },
      TraceId: traceId,
      Response: {
        PNR: pnr,
        BookingId: synthBookingId,
        IsPriceChanged: false,
        FlightItinerary: {
          PNR: pnr,
          BookingId: synthBookingId,
          IsLCC: false,
          Passenger: passengers,
        },
      },
    },
    PNR: pnr,
    BookingId: synthBookingId,
    BookedPassengers: passengers,
    caseLabel: "Case_Demo_Flight",
    isPriceChanged: false,
    isDemo: true,
  });
}

async function handleFlightTicket(req: any, res: Response): Promise<void> {
  const pnr = req.body?.PNR || "";
  const bookingId = req.body?.BookingId || "";
  const userId = getUserId(req);

  // Find the previously-created demo booking and stamp it TICKETED.
  const doc = await SBTBooking.findOne({
    $or: [
      { pnr, isDemo: true },
      { bookingId: String(bookingId), isDemo: true },
    ],
    userId: asObjectId(userId) as any,
  });
  const synthTicketId = `T${Math.floor(100000000 + Math.random() * 899999999)}`;

  if (doc) {
    doc.ticketingStatus = "TICKETED";
    doc.ticketId = synthTicketId;
    (doc as any).ticketIds = [Number(synthTicketId.slice(1))];
    await doc.save();
  }

  sbtLogger.info("[DEMO] flight-ticket marked TICKETED", { pnr, bookingId });

  res.json({
    Response: {
      ResponseStatus: 1,
      Error: { ErrorCode: 0, ErrorMessage: "" },
      TraceId: req.body?.TraceId || `demo-${Date.now()}`,
      Response: {
        PNR: pnr,
        BookingId: bookingId,
        TicketId: synthTicketId,
        FlightItinerary: {
          PNR: pnr,
          BookingId: bookingId,
          Passenger: doc?.passengers ?? [],
        },
      },
    },
    isDemo: true,
  });
}

async function handleFlightTicketLCC(req: any, res: Response): Promise<void> {
  const traceId = req.body?.TraceId || `demo-${Date.now()}`;
  const pnr = await generateDemoPNR("DMO-FLT");
  const synthBookingId = Math.floor(1000000000 + Math.random() * 8999999999);
  const synthTicketId = `T${Math.floor(100000000 + Math.random() * 899999999)}`;

  const passengers: any[] = Array.isArray(req.body?.Passengers) ? req.body.Passengers : [];
  const totalFare: number = Number(req.body?.totalFare ?? req.body?.netAmount ?? 0);
  const workspaceId = (req as any).workspaceObjectId;
  const userId = asObjectId(getUserId(req));

  const doc = await SBTBooking.create({
    userId: userId as any,
    workspaceId,
    pnr,
    bookingId: String(synthBookingId),
    ticketId: synthTicketId,
    ticketIds: [Number(synthTicketId.slice(1))],
    traceId,
    status: "CONFIRMED",
    origin: {
      code: req.body?.originCode || "DEL",
      city: req.body?.originCity || "Delhi",
    },
    destination: {
      code: req.body?.destinationCode || "BOM",
      city: req.body?.destinationCity || "Mumbai",
    },
    departureTime: req.body?.departureDate || new Date().toISOString(),
    arrivalTime: req.body?.arrivalDate || new Date().toISOString(),
    airlineCode: req.body?.airlineCode || "DM",
    airlineName: req.body?.airlineName || "Demo Airways",
    flightNumber: req.body?.flightNumber || "DM-201",
    cabin: req.body?.cabin ?? 2,
    passengers: passengers.map((p) => ({
      title: p.Title || "Mr",
      firstName: p.FirstName || "",
      lastName: p.LastName || "",
      paxType: String(p.PaxType ?? "adult"),
      isLead: !!p.IsLeadPax,
      contactNo: p.ContactNo || "",
      email: p.Email || "",
    })),
    contactEmail: passengers[0]?.Email || "",
    contactPhone: passengers[0]?.ContactNo || "",
    baseFare: Number(req.body?.baseFare ?? 0),
    taxes: Number(req.body?.taxes ?? 0),
    extras: 0,
    totalFare,
    currency: req.body?.currency || "INR",
    isLCC: true,
    paymentMode: "official",
    ticketingStatus: "TICKETED",
    bookedAt: new Date(),
    isDemo: true,
    createdByDemoUser: true,
  });

  const wallet = await simulateWalletDeduct(workspaceId, totalFare);
  if (!wallet.ok) {
    await SBTBooking.findByIdAndUpdate(doc._id, {
      status: "FAILED",
      failureReason: `wallet_${wallet.reason}`,
    });
    sbtLogger.info("[DEMO] flight-ticket-lcc wallet rejected", { reason: wallet.reason, totalFare });
    res.status(402).json({
      error: wallet.reason === "limit_exceeded"
        ? "Monthly travel limit exceeded for this demo workspace."
        : "Wallet is not enabled for this demo workspace.",
      code: wallet.reason.toUpperCase(),
      isDemo: true,
    });
    return;
  }

  sbtLogger.info("[DEMO] flight-ticket-lcc persisted + wallet deducted", { pnr, bookingId: synthBookingId, totalFare });

  res.json({
    Response: {
      ResponseStatus: 1,
      Error: { ErrorCode: 0, ErrorMessage: "" },
      TraceId: traceId,
      Response: {
        PNR: pnr,
        BookingId: synthBookingId,
        TicketId: synthTicketId,
        IsPriceChanged: false,
        FlightItinerary: {
          PNR: pnr,
          BookingId: synthBookingId,
          IsLCC: true,
          Passenger: passengers,
        },
      },
    },
    isDemo: true,
  });
}

async function handleFlightRelease(req: any, res: Response): Promise<void> {
  const pnr = req.body?.PNR || "";
  const bookingId = req.body?.BookingId || "";
  const userId = getUserId(req);

  const doc = await SBTBooking.findOne({
    $or: [
      { pnr, isDemo: true },
      { bookingId: String(bookingId), isDemo: true },
    ],
    userId: asObjectId(userId) as any,
  });
  if (doc && doc.ticketingStatus !== "TICKETED") {
    doc.status = "CANCELLED";
    doc.cancelledAt = new Date();
    await doc.save();
  }

  sbtLogger.info("[DEMO] flight-release", { pnr, bookingId });

  res.json({
    Response: {
      ResponseStatus: 1,
      Error: { ErrorCode: 0, ErrorMessage: "" },
      PNRReleased: true,
    },
    isDemo: true,
  });
}

async function handleFlightCancel(req: any, res: Response): Promise<void> {
  const userId = getUserId(req);
  const doc = await SBTBooking.findOne({ _id: req.params?.id, userId: asObjectId(userId) as any, isDemo: true });
  if (!doc) {
    res.status(404).json({ error: "Demo booking not found", isDemo: true });
    return;
  }
  if (doc.status === "CANCELLED") {
    res.status(400).json({ error: "Already cancelled", isDemo: true });
    return;
  }

  // 25% cancellation charge (synthetic, deterministic so the demo shows realistic refund math)
  const cancelCharge = Math.round((doc.totalFare || 0) * 0.25);
  const refundAmount = Math.max(0, (doc.totalFare || 0) - cancelCharge);

  doc.status = "CANCELLED";
  doc.cancelledAt = new Date();
  (doc as any).cancellationCharge = cancelCharge;
  (doc as any).refundedAmount = refundAmount;
  await doc.save();

  await refundDemoWallet((req as any).workspaceObjectId, refundAmount);

  sbtLogger.info("[DEMO] flight-cancel", { bookingId: doc._id, cancelCharge, refundAmount });

  res.json({
    ok: true,
    status: "CANCELLED",
    cancellationCharge: cancelCharge,
    refundedAmount: refundAmount,
    pnr: doc.pnr,
    isDemo: true,
  });
}

async function handleFlightReissueSearch(req: any, res: Response): Promise<void> {
  const userId = getUserId(req);
  const doc = await SBTBooking.findOne({ _id: req.params?.id, userId: asObjectId(userId) as any, isDemo: true }).lean();
  if (!doc) {
    res.status(404).json({ error: "Demo booking not found", isDemo: true });
    return;
  }

  const newDate = String(req.query?.departDate || "");
  const baseFare = (doc.totalFare || 0);
  const options = [
    { ResultIndex: `DEMO-RS-${randomAlphanumeric6()}`, totalFare: baseFare + 1500, airlineName: doc.airlineName, flightNumber: doc.flightNumber, departureTime: `${newDate}T08:00:00` },
    { ResultIndex: `DEMO-RS-${randomAlphanumeric6()}`, totalFare: baseFare + 2200, airlineName: doc.airlineName, flightNumber: doc.flightNumber, departureTime: `${newDate}T14:30:00` },
    { ResultIndex: `DEMO-RS-${randomAlphanumeric6()}`, totalFare: baseFare + 3100, airlineName: doc.airlineName, flightNumber: doc.flightNumber, departureTime: `${newDate}T19:45:00` },
  ];

  sbtLogger.info("[DEMO] flight-reissue-search", { bookingId: doc._id, newDate, options: options.length });

  res.json({ ok: true, options, TraceId: `demo-rs-${Date.now()}`, isDemo: true });
}

async function handleFlightManualReissue(req: any, res: Response): Promise<void> {
  const userId = getUserId(req);
  const doc = await SBTBooking.findOne({ _id: req.params?.id, userId: asObjectId(userId) as any, isDemo: true });
  if (!doc) {
    res.status(404).json({ error: "Demo booking not found", isDemo: true });
    return;
  }
  const { newDate, remarks } = req.body || {};
  const changeRequestId = `DEMO-CR-${randomAlphanumeric6()}`;
  (doc as any).changeRequests = [
    ...((doc as any).changeRequests || []),
    {
      requestType: "MANUAL_REISSUE",
      requestedNewDate: newDate,
      remarks: String(remarks || "").slice(0, 500),
      status: "submitted",
      raisedAt: new Date(),
      raisedBy: asObjectId(userId),
    },
  ];
  await doc.save();

  sbtLogger.info("[DEMO] flight-manual-reissue", { bookingId: doc._id, newDate });

  res.json({ ok: true, changeRequestId, status: "submitted", isDemo: true });
}

async function handleFlightReissue(req: any, res: Response): Promise<void> {
  const userId = getUserId(req);
  const doc = await SBTBooking.findOne({ _id: req.params?.id, userId: asObjectId(userId) as any, isDemo: true });
  if (!doc) {
    res.status(404).json({ error: "Demo booking not found", isDemo: true });
    return;
  }
  const priceDiff = Math.max(0, Number(req.body?.priceDiff ?? 0));

  if (priceDiff > 0) {
    const wallet = await simulateWalletDeduct((req as any).workspaceObjectId, priceDiff);
    if (!wallet.ok) {
      res.status(402).json({
        error: wallet.reason === "limit_exceeded"
          ? "This reissue would exceed your monthly travel limit."
          : "Wallet is not enabled for this demo workspace.",
        code: wallet.reason.toUpperCase(),
        isDemo: true,
      });
      return;
    }
  }

  const newPNR = await generateDemoPNR("DMO-FLT");
  const oldPNR = doc.pnr;
  doc.status = "REISSUED";
  (doc as any).originalPNR = oldPNR;
  doc.pnr = newPNR;
  doc.isReissued = true;
  await doc.save();

  sbtLogger.info("[DEMO] flight-reissue", { oldPNR, newPNR, priceDiff });

  res.json({
    ok: true,
    status: "REISSUED",
    oldPNR,
    newPNR,
    priceDiff,
    isDemo: true,
  });
}

/* ───────────────────────── hotel handlers ───────────────────────── */

async function handleHotelPrebook(_req: any, res: Response): Promise<void> {
  const prebookId = `DEMO-PB-${randomAlphanumeric6()}`;
  const validUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  sbtLogger.info("[DEMO] hotel-prebook", { prebookId });
  res.json({
    success: true,
    prebookId,
    status: "Prebooked",
    validUntil,
    source: "demo",
    isDemo: true,
  });
}

async function handleHotelBook(req: any, res: Response): Promise<void> {
  const confirmationNo = await generateDemoPNR("HTL-DMO");
  const synthBookingId = String(Math.floor(1000000 + Math.random() * 8999999));
  const workspaceId = (req as any).workspaceObjectId;
  const userId = asObjectId(getUserId(req));
  const netAmount: number = Number(req.body?.NetAmount ?? req.body?.netAmount ?? req.body?.totalFare ?? 0);
  const guests: any[] = Array.isArray(req.body?.Guests) ? req.body.Guests : [];
  const lead = guests.find((g) => g.LeadPassenger) || guests[0] || {};

  const doc = await SBTHotelBooking.create({
    userId: userId as any,
    workspaceId,
    bookingId: synthBookingId,
    confirmationNo,
    bookingRefNo: confirmationNo,
    hotelCode: req.body?.HotelCode || "DEMO-HOTEL",
    hotelName: req.body?.HotelName || "Demo Grand Hotel",
    cityName: req.body?.CityName || "Mumbai",
    cityCode: req.body?.CityCode || "100537",
    countryCode: req.body?.CountryCode || "IN",
    checkIn: req.body?.CheckIn || new Date().toISOString().slice(0, 10),
    checkOut: req.body?.CheckOut || new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    rooms: Number(req.body?.NoOfRooms ?? 1),
    guests: guests.map((g) => ({
      Title: g.Title || "Mr",
      FirstName: g.FirstName || "",
      LastName: g.LastName || "",
      PaxType: Number(g.PaxType ?? 1),
      LeadPassenger: !!g.LeadPassenger,
    })),
    roomName: req.body?.RoomName || "Demo Standard Room",
    mealType: req.body?.MealType || "Room Only",
    totalFare: Number(req.body?.totalFare ?? netAmount),
    netAmount,
    currency: req.body?.currency || "INR",
    isRefundable: true,
    cancelPolicies: [],
    status: "CONFIRMED",
    paymentStatus: "paid",
    paymentId: `DEMO-PAY-${randomAlphanumeric6()}`,
    isVouchered: false,
    paymentMode: "official",
    statusCheckDone: true,
    bookingDetailFetched: true,
    bookingDetailFetchedAt: new Date(),
    bookedAt: new Date(),
    isDemo: true,
    createdByDemoUser: true,
  });

  const wallet = await simulateWalletDeduct(workspaceId, netAmount);
  if (!wallet.ok) {
    await SBTHotelBooking.findByIdAndUpdate(doc._id, {
      status: "FAILED",
      failureReason: `wallet_${wallet.reason}`,
    });
    sbtLogger.info("[DEMO] hotel-book wallet rejected", { reason: wallet.reason, netAmount });
    res.status(402).json({
      error: wallet.reason === "limit_exceeded"
        ? "Monthly travel limit exceeded for this demo workspace."
        : "Wallet is not enabled for this demo workspace.",
      code: wallet.reason.toUpperCase(),
      isDemo: true,
    });
    return;
  }

  sbtLogger.info("[DEMO] hotel-book persisted + wallet deducted", { confirmationNo, bookingId: synthBookingId, netAmount });

  res.json({
    ok: true,
    BookResult: {
      ResponseStatus: 1,
      BookingId: synthBookingId,
      ConfirmationNo: confirmationNo,
      BookingRefNo: confirmationNo,
      Status: 1,
      GuestName: `${lead.FirstName || ""} ${lead.LastName || ""}`.trim(),
    },
    bookingId: synthBookingId,
    confirmationNo,
    docId: doc._id,
    isDemo: true,
  });
}

async function handleHotelVoucher(req: any, res: Response): Promise<void> {
  const userId = getUserId(req);
  const bookingId = String(req.params?.bookingId || "");
  const doc = await SBTHotelBooking.findOne({ bookingId, userId: asObjectId(userId) as any, isDemo: true });
  if (!doc) {
    res.status(404).json({ error: "Demo booking not found", isDemo: true });
    return;
  }
  // Idempotent — match real GET /voucher/:bookingId semantics.
  if (doc.isVouchered) {
    res.json({
      ok: true,
      voucherStatus: doc.voucherStatus || "GENERATED",
      voucherData: doc.tboVoucherData ?? null,
      deduplicated: true,
      isDemo: true,
    });
    return;
  }
  doc.isVouchered = true;
  doc.voucherStatus = "GENERATED";
  doc.voucherGeneratedAt = new Date();
  await doc.save();

  sbtLogger.info("[DEMO] hotel-voucher generated", { bookingId });

  res.json({
    ok: true,
    voucherStatus: "GENERATED",
    voucherData: { Demo: true, ConfirmationNo: doc.confirmationNo },
    isDemo: true,
  });
}

async function handleHotelGenerateVoucher(req: any, res: Response): Promise<void> {
  const userId = getUserId(req);
  const doc = await SBTHotelBooking.findOne({ _id: req.params?.id, userId: asObjectId(userId) as any, isDemo: true });
  if (!doc) {
    res.status(404).json({ error: "Demo booking not found", isDemo: true });
    return;
  }
  if (doc.isVouchered) {
    res.json({
      ok: true,
      voucherStatus: doc.voucherStatus || "GENERATED",
      voucherData: doc.tboVoucherData ?? null,
      deduplicated: true,
      isDemo: true,
    });
    return;
  }

  // Wallet deduct on voucher gen for HELD bookings (mirrors real path at sbt.hotels.ts:2241).
  if (doc.isHeld && (doc.netAmount ?? 0) > 0) {
    const wallet = await simulateWalletDeduct((req as any).workspaceObjectId, doc.netAmount!);
    if (!wallet.ok) {
      res.status(402).json({
        error: wallet.reason === "limit_exceeded"
          ? "Monthly travel limit exceeded for this demo workspace."
          : "Wallet is not enabled for this demo workspace.",
        code: wallet.reason.toUpperCase(),
        isDemo: true,
      });
      return;
    }
  }

  doc.isVouchered = true;
  doc.voucherStatus = "GENERATED";
  doc.voucherGeneratedAt = new Date();
  doc.isHeld = false;
  await doc.save();

  sbtLogger.info("[DEMO] hotel-generate-voucher", { mongoId: doc._id, confirmationNo: doc.confirmationNo });

  res.json({
    ok: true,
    voucherStatus: "GENERATED",
    voucherData: { Demo: true, ConfirmationNo: doc.confirmationNo },
    isDemo: true,
  });
}

async function handleHotelCancel(req: any, res: Response): Promise<void> {
  const userId = getUserId(req);
  const doc = await SBTHotelBooking.findOne({ _id: req.params?.id, userId: asObjectId(userId) as any, isDemo: true });
  if (!doc) {
    res.status(404).json({ error: "Demo booking not found", isDemo: true });
    return;
  }
  if (doc.status === "CANCELLED" || doc.status === "CANCEL_PENDING") {
    res.status(409).json({ ok: false, error: "Booking is already cancelled.", isDemo: true });
    return;
  }
  const cancelCharge = Math.round((doc.netAmount || 0) * 0.25);
  const refundAmount = Math.max(0, (doc.netAmount || 0) - cancelCharge);

  doc.status = "CANCELLED";
  doc.cancelledAt = new Date();
  (doc as any).cancellationCharge = cancelCharge;
  (doc as any).refundedAmount = refundAmount;
  (doc as any).changeRequestId = `DEMO-CR-${randomAlphanumeric6()}`;
  await doc.save();

  await refundDemoWallet((req as any).workspaceObjectId, refundAmount);

  sbtLogger.info("[DEMO] hotel-cancel", { mongoId: doc._id, cancelCharge, refundAmount });

  res.json({
    ok: true,
    status: "CANCELLED",
    cancellationCharge: cancelCharge,
    refundedAmount: refundAmount,
    changeRequestId: (doc as any).changeRequestId,
    isDemo: true,
  });
}

/* ───────────────────────── approval-flow handler ───────────────────────── */

async function handleSbtRequestBook(req: any, res: Response): Promise<void> {
  const requestId = req.params?.id;
  const sbtReq: any = await SBTRequest.findOne({ _id: requestId, customerId: (req as any).workspace?.customerId });
  if (!sbtReq) {
    res.status(404).json({ error: "Request not found", isDemo: true });
    return;
  }

  // Approval-flow booking. Persist the demo flight booking analogous to handleFlightBook
  // but tagged as the SBT-request fulfillment.
  const pnr = await generateDemoPNR("DMO-FLT");
  const synthBookingId = Math.floor(1000000000 + Math.random() * 8999999999);
  const opt: any = sbtReq.selectedOption || {};
  const totalFare: number = Number(opt?.totalFare ?? opt?.Fare?.PublishedFare ?? 0);
  const workspaceId = (req as any).workspaceObjectId;
  const userId = asObjectId(getUserId(req));

  const doc = await SBTBooking.create({
    userId: (sbtReq.requesterId ?? userId) as any,
    workspaceId,
    sbtRequestId: sbtReq._id,
    pnr,
    bookingId: String(synthBookingId),
    ticketId: "",
    status: "CONFIRMED",
    origin: { code: opt?.originCode || "DEL", city: opt?.originCity || "Delhi" },
    destination: { code: opt?.destinationCode || "BOM", city: opt?.destinationCity || "Mumbai" },
    departureTime: opt?.departureTime || new Date().toISOString(),
    arrivalTime: opt?.arrivalTime || new Date().toISOString(),
    airlineCode: opt?.airlineCode || "DM",
    airlineName: opt?.airlineName || "Demo Airways",
    flightNumber: opt?.flightNumber || "DM-301",
    cabin: opt?.cabin ?? 2,
    passengers: (sbtReq.passengerDetails || []).map((p: any) => ({
      title: p.title || "Mr",
      firstName: p.firstName || "",
      lastName: p.lastName || "",
      paxType: String(p.paxType ?? "adult"),
      isLead: !!p.isLead,
      email: p.email,
    })),
    contactEmail: sbtReq.passengerDetails?.[0]?.email || "",
    contactPhone: sbtReq.passengerDetails?.[0]?.contactNo || "",
    baseFare: Number(opt?.baseFare ?? 0),
    taxes: Number(opt?.taxes ?? 0),
    extras: 0,
    totalFare,
    currency: "INR",
    isLCC: !!opt?.isLCC,
    paymentMode: "official",
    ticketingStatus: "TICKETED",
    bookedAt: new Date(),
    isDemo: true,
    createdByDemoUser: true,
  });

  const wallet = await simulateWalletDeduct(workspaceId, totalFare);
  if (!wallet.ok) {
    await SBTBooking.findByIdAndUpdate(doc._id, {
      status: "FAILED",
      failureReason: `wallet_${wallet.reason}`,
    });
    res.status(402).json({
      error: wallet.reason === "limit_exceeded"
        ? "Monthly travel limit exceeded for this demo workspace."
        : "Wallet is not enabled for this demo workspace.",
      code: wallet.reason.toUpperCase(),
      isDemo: true,
    });
    return;
  }

  sbtReq.status = "BOOKED";
  (sbtReq as any).bookingId = doc._id;
  sbtReq.actedAt = new Date();
  await sbtReq.save();

  sbtLogger.info("[DEMO] sbt-request-book", { requestId, pnr, totalFare });

  res.json({
    ok: true,
    booking: doc,
    pnr,
    bookingId: synthBookingId,
    isDemo: true,
  });
}

/* ───────────────────────── dispatcher ───────────────────────── */

export async function maybeRouteToDemoSimulator(
  req: Request,
  res: Response,
  kind: DemoBookingKind,
): Promise<boolean> {
  if (!(req as any).user?.isDemoUser) return false;

  try {
    switch (kind) {
      case "flight-book":            await handleFlightBook(req, res); break;
      case "flight-ticket":          await handleFlightTicket(req, res); break;
      case "flight-ticket-lcc":      await handleFlightTicketLCC(req, res); break;
      case "flight-release":         await handleFlightRelease(req, res); break;
      case "flight-cancel":          await handleFlightCancel(req, res); break;
      case "flight-reissue-search":  await handleFlightReissueSearch(req, res); break;
      case "flight-manual-reissue":  await handleFlightManualReissue(req, res); break;
      case "flight-reissue":         await handleFlightReissue(req, res); break;
      case "hotel-prebook":          await handleHotelPrebook(req, res); break;
      case "hotel-book":             await handleHotelBook(req, res); break;
      case "hotel-voucher":          await handleHotelVoucher(req, res); break;
      case "hotel-generate-voucher": await handleHotelGenerateVoucher(req, res); break;
      case "hotel-cancel":           await handleHotelCancel(req, res); break;
      case "sbt-request-book":       await handleSbtRequestBook(req, res); break;
      default: {
        // Exhaustiveness guard
        const _x: never = kind;
        void _x;
        res.status(500).json({ error: "demo_simulator_unknown_kind", isDemo: true });
      }
    }
  } catch (e: any) {
    sbtLogger.error("[DEMO] simulator threw", { kind, error: e?.message });
    if (!res.headersSent) {
      res.status(500).json({ error: "demo_simulator_failed", message: e?.message, isDemo: true });
    }
  }
  return true;
}
