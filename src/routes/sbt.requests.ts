import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { sbtLogger } from "../utils/logger.js";
import { sendMail } from "../utils/mailer.js";
import SBTRequest from "../models/SBTRequest.js";
import User from "../models/User.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import { getFareQuote, bookFlight } from "../services/tbo.flight.service.js";

const router = express.Router();
router.use(requireAuth);

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function userId(req: any): string {
  return String(req.user?._id ?? req.user?.id ?? "");
}

function describeOption(type: string, opt: any, params: any): string {
  if (type === "flight") {
    const seg = opt?.Segments?.[0]?.[0] || opt?.segments?.[0]?.[0] || {};
    const orig = seg?.Origin?.Airport?.CityName || params?.origin || "";
    const dest = seg?.Destination?.Airport?.CityName || params?.destination || "";
    return `${orig} → ${dest}`;
  }
  return opt?.HotelName || opt?.hotelName || params?.hotelName || "Hotel";
}

function travelDate(type: string, params: any): string {
  if (type === "flight") {
    return params?.departDate || params?.DepartDate || params?.PreferredDepartureTime || "";
  }
  return params?.CheckIn || params?.checkIn || "";
}

/* ─── POST / — L1 raises a new request ────────────────────────────────── */

router.post("/", async (req: any, res: any) => {
  try {
    const uid = userId(req);
    const user = await User.findById(uid)
      .select("sbtRole sbtAssignedBookerId customerId name email")
      .lean() as any;

    if (!user) return res.status(401).json({ error: "Unauthorized" });

    if (user.sbtRole !== "L1" && user.sbtRole !== "BOTH") {
      return res.status(403).json({ error: "SBT Requestor access required", code: "NOT_L1" });
    }

    let assignedBookerId = user.sbtAssignedBookerId;

    // Auto-assign workspace leader as booker if none explicitly set
    if (!assignedBookerId && user.customerId) {
      const leader = await User.findOne({
        customerId: user.customerId,
        roles: { $in: ["WORKSPACE_LEADER"] },
        _id: { $ne: uid }, // cannot be self
      }).select("_id").lean() as any;

      if (leader) {
        assignedBookerId = leader._id;
      }
    }

    if (!assignedBookerId) {
      return res.status(400).json({
        error: "No L2 booker assigned to your account. Contact your Workspace Leader.",
      });
    }

    const { type, searchParams, selectedOption, requesterNotes, passengerDetails, contactDetails } = req.body;
    if (!type || !searchParams || !selectedOption) {
      return res.status(400).json({ error: "type, searchParams, and selectedOption are required" });
    }

    // Validate passenger details
    if (passengerDetails) {
      if (!Array.isArray(passengerDetails) || passengerDetails.length === 0) {
        return res.status(400).json({ error: "passengerDetails must be a non-empty array" });
      }
      for (let i = 0; i < passengerDetails.length; i++) {
        const pax = passengerDetails[i];
        if (!pax.firstName || !pax.lastName || !pax.gender) {
          return res.status(400).json({
            error: `Passenger ${i + 1}: firstName, lastName, and gender are required`,
          });
        }
        if (!["Male", "Female", "Other"].includes(pax.gender)) {
          return res.status(400).json({
            error: `Passenger ${i + 1}: gender must be Male, Female, or Other`,
          });
        }
      }
    }

    const request = await SBTRequest.create({
      customerId: user.customerId,
      requesterId: uid,
      assignedBookerId,
      type,
      searchParams,
      selectedOption,
      requesterNotes: requesterNotes || null,
      passengerDetails: passengerDetails || [],
      contactDetails: contactDetails || {},
      status: "PENDING",
    });

    // Send email to L2 booker
    const booker = await User.findById(assignedBookerId)
      .select("name email")
      .lean() as any;

    if (booker?.email) {
      const desc = describeOption(type, selectedOption, searchParams);
      const date = travelDate(type, searchParams);
      const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

      await sendMail({
        to: booker.email,
        subject: `New SBT Request from ${user.name || user.email} — ${desc}`,
        kind: "REQUESTS",
        html: `
          <h3>New Travel Request</h3>
          <p><strong>From:</strong> ${user.name || user.email}</p>
          <p><strong>Type:</strong> ${type === "flight" ? "Flight" : "Hotel"}</p>
          <p><strong>Route/Hotel:</strong> ${desc}</p>
          ${date ? `<p><strong>Travel Date:</strong> ${date}</p>` : ""}
          ${requesterNotes ? `<p><strong>Notes:</strong> ${requesterNotes}</p>` : ""}
          <p><a href="${frontendUrl}/sbt/inbox">View in Booking Inbox</a></p>
        `,
      }).catch((e: any) => sbtLogger.warn("Failed to send SBT request email", { error: e?.message }));
    }

    sbtLogger.info("SBT request raised", {
      requestId: request._id,
      requesterId: uid,
      assignedBookerId: String(assignedBookerId),
      type,
    });

    res.status(201).json(request);
  } catch (err: any) {
    sbtLogger.error("SBT request creation failed", { error: err.message });
    res.status(500).json({ error: "Failed to create request" });
  }
});

/* ─── GET /my — L1 sees their own requests ────────────────────────────── */

router.get("/my", async (req: any, res: any) => {
  try {
    const uid = userId(req);
    const user = await User.findById(uid).select("sbtRole").lean() as any;

    if (!user || (user.sbtRole !== "L1" && user.sbtRole !== "BOTH")) {
      return res.status(403).json({ error: "SBT Requestor access required", code: "NOT_L1" });
    }

    const requests = await SBTRequest.find({ requesterId: uid })
      .populate("assignedBookerId", "name email")
      .sort({ requestedAt: -1 })
      .lean();

    res.json({ ok: true, requests });
  } catch (err: any) {
    sbtLogger.error("SBT my requests failed", { error: err.message });
    res.status(500).json({ error: "Failed to load requests" });
  }
});

/* ─── DELETE /:id/cancel — L1 cancels their own PENDING request ──────── */

router.delete("/:id/cancel", async (req: any, res: any) => {
  try {
    const uid = userId(req);
    const request = await SBTRequest.findOne({ _id: req.params.id, requesterId: uid });

    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status !== "PENDING") {
      return res.status(400).json({ error: "Only pending requests can be cancelled" });
    }

    request.status = "CANCELLED";
    request.cancelledAt = new Date();
    await request.save();

    sbtLogger.info("SBT request cancelled by requester", {
      requestId: request._id,
      requesterId: uid,
    });

    res.json(request);
  } catch (err: any) {
    sbtLogger.error("SBT request cancel failed", { error: err.message });
    res.status(500).json({ error: "Failed to cancel request" });
  }
});

/* ─── GET /inbox — L2 sees requests assigned to them ──────────────────── */

router.get("/inbox", async (req: any, res: any) => {
  try {
    const uid = userId(req);
    const user = await User.findById(uid).select("sbtRole roles customerId").lean() as any;

    const allRoles = (Array.isArray(user?.roles) ? user.roles : []).map((r: any) => String(r || "").toUpperCase().replace(/[\s\-_]/g, ""));
    const isWL = allRoles.includes("WORKSPACELEADER");

    if (!user || (user.sbtRole !== "L2" && user.sbtRole !== "BOTH" && !isWL)) {
      return res.status(403).json({ error: "SBT Booker access required", code: "NOT_L2" });
    }

    // Optional status filter: PENDING (default), BOOKED, REJECTED, CANCELLED, ALL
    const statusParam = (req.query.status as string || "").toUpperCase();
    const statusFilter: any =
      statusParam === "ALL" ? {} :
      ["PENDING", "BOOKED", "REJECTED", "CANCELLED"].includes(statusParam)
        ? { status: statusParam }
        : { status: "PENDING" };

    // Workspace Leader sees ALL company requests; L2/BOTH only see assigned
    const filter: any = isWL
      ? { customerId: user.customerId, ...statusFilter }
      : { assignedBookerId: uid, ...statusFilter };

    const requests = await SBTRequest.find(filter)
      .populate("requesterId", "name email")
      .sort({ requestedAt: -1 })
      .lean();

    res.json({ ok: true, requests });
  } catch (err: any) {
    sbtLogger.error("SBT inbox failed", { error: err.message });
    res.status(500).json({ error: "Failed to load inbox" });
  }
});

/* ─── GET /:id — single request detail ────────────────────────────────── */

router.get("/:id", async (req: any, res: any) => {
  try {
    const uid = userId(req);
    const request = await SBTRequest.findById(req.params.id)
      .populate("requesterId", "name email")
      .populate("assignedBookerId", "name email")
      .lean() as any;

    if (!request) return res.status(404).json({ error: "Request not found" });

    const isRequester = String(request.requesterId?._id || request.requesterId) === uid;
    const isBooker = String(request.assignedBookerId?._id || request.assignedBookerId) === uid;

    // Workspace Leader can view any request in their company
    const detailUser = await User.findById(uid).select("roles customerId").lean() as any;
    const detailRoles = (Array.isArray(detailUser?.roles) ? detailUser.roles : []).map((r: any) => String(r || "").toUpperCase().replace(/[\s\-_]/g, ""));
    const isWLDetail = detailRoles.includes("WORKSPACELEADER") && String(detailUser?.customerId) === String(request.customerId);

    if (!isRequester && !isBooker && !isWLDetail) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.json(request);
  } catch (err: any) {
    sbtLogger.error("SBT request detail failed", { error: err.message });
    res.status(500).json({ error: "Failed to load request" });
  }
});

/* ─── POST /:id/book — L2 books the request ──────────────────────────── */

router.post("/:id/book", async (req: any, res: any) => {
  try {
    const uid = userId(req);
    const user = await User.findById(uid).select("sbtRole roles customerId").lean() as any;

    const bookRoles = (Array.isArray(user?.roles) ? user.roles : []).map((r: any) => String(r || "").toUpperCase().replace(/[\s\-_]/g, ""));
    const isWLBooker = bookRoles.includes("WORKSPACELEADER");

    if (!user || (user.sbtRole !== "L2" && user.sbtRole !== "BOTH" && !isWLBooker)) {
      return res.status(403).json({ error: "SBT Booker access required", code: "NOT_L2" });
    }

    // Workspace Leader can book any company request; L2/BOTH only their assigned
    const findFilter: any = isWLBooker
      ? { _id: req.params.id, customerId: user.customerId, status: "PENDING" }
      : { _id: req.params.id, assignedBookerId: uid, status: "PENDING" };

    const request = await SBTRequest.findOne(findFilter);

    if (!request) {
      return res.status(403).json({ error: "Request not found or not assigned to you" });
    }

    // Prevent self-booking
    if (String(request.requesterId) === uid) {
      return res.status(403).json({ error: "You cannot book your own request" });
    }

    const { bookerNotes } = req.body || {};
    const opt = request.selectedOption as any;

    // Build TBO-format passengers from request's passenger details
    const tboPassengers = (request as any).passengerDetails?.map((pax: any, index: number) => ({
      Title: pax.gender === "Female" ? "Ms" : "Mr",
      FirstName: pax.firstName,
      LastName: pax.lastName,
      PaxType: 1,
      DateOfBirth: pax.dateOfBirth || "",
      Gender: pax.gender === "Male" ? 1 : pax.gender === "Female" ? 2 : 3,
      PassportNo: pax.passportNumber || "",
      PassportExpiry: pax.passportExpiry || "",
      Nationality: pax.nationality || "IN",
      AddressLine1: "",
      City: "",
      CountryCode: pax.nationality || "IN",
      CountryName: "",
      ContactNo: (request as any).contactDetails?.phone || "",
      Email: (request as any).contactDetails?.email || "",
      IsLeadPax: index === 0,
      FFAirlineCode: null,
      FFNumber: null,
      GSTCompanyAddress: "",
      GSTCompanyContactNumber: "",
      GSTCompanyName: "",
      GSTNumber: "",
      GSTCompanyEmail: "",
    })) || [];

    let booking: any;

    if (request.type === "flight") {
      const seg = opt?.Segments?.[0]?.[0] || {};
      const traceId = opt?.TraceId || (request.searchParams as any)?.TraceId || "";
      const resultIndex = opt?.ResultIndex || "";

      let tboBookResult: any = null;

      // Call TBO APIs if we have TraceId and passengers
      if (traceId && resultIndex && tboPassengers.length > 0) {
        try {
          // Step 1: Re-validate fare
          const fqResult = await getFareQuote({
            TraceId: traceId,
            ResultIndex: resultIndex,
          });

          const fqResponse = (fqResult as any)?.Response || fqResult;
          if (fqResponse?.ResponseStatus === 2 || fqResponse?.Error?.ErrorCode) {
            sbtLogger.warn("SBT FareQuote failed for request booking", {
              requestId: request._id,
              error: fqResponse?.Error,
            });
            // Fall through to create local record with placeholder PNR
          } else {
            // Step 2: Book with TBO
            tboBookResult = await bookFlight({
              TraceId: traceId,
              ResultIndex: resultIndex,
              Passengers: tboPassengers,
            });

            const bookResponse = tboBookResult?.Response || tboBookResult;
            if (bookResponse?.Error?.ErrorCode) {
              sbtLogger.warn("SBT TBO Book failed", {
                requestId: request._id,
                error: bookResponse?.Error,
              });
              tboBookResult = null; // Fall through to local record
            }
          }
        } catch (tboErr: any) {
          sbtLogger.warn("SBT TBO booking call failed, creating local record", {
            requestId: request._id,
            error: tboErr?.message,
          });
        }
      }

      const tboResponse = tboBookResult?.Response || tboBookResult;
      const tboBookingId = tboResponse?.BookingId || opt?.BookingId;
      const tboPNR = tboResponse?.PNR || opt?.PNR;

      booking = await SBTBooking.create({
        userId: request.requesterId,
        customerId: String(request.customerId || ""),
        sbtRequestId: request._id,
        pnr: tboPNR || `REQ-${Date.now()}`,
        bookingId: tboBookingId || `BK-${Date.now()}`,
        ticketId: tboResponse?.TicketId || opt?.TicketId || "",
        status: "CONFIRMED",
        origin: {
          code: seg?.Origin?.Airport?.AirportCode || opt?.origin?.code || "",
          city: seg?.Origin?.Airport?.CityName || opt?.origin?.city || "",
        },
        destination: {
          code: seg?.Destination?.Airport?.AirportCode || opt?.destination?.code || "",
          city: seg?.Destination?.Airport?.CityName || opt?.destination?.city || "",
        },
        departureTime: seg?.Origin?.DepTime || opt?.departureTime || "",
        arrivalTime: seg?.Destination?.ArrTime || opt?.arrivalTime || "",
        airlineCode: seg?.Airline?.AirlineCode || opt?.airlineCode || "",
        airlineName: seg?.Airline?.AirlineName || opt?.airlineName || "",
        flightNumber: seg?.Airline?.FlightNumber || opt?.flightNumber || "",
        cabin: seg?.CabinClass || opt?.cabin || 2,
        passengers: tboPassengers.length > 0 ? tboPassengers : (opt?.passengers || []),
        baseFare: opt?.Fare?.BaseFare || opt?.baseFare || 0,
        taxes: opt?.Fare?.Tax || opt?.taxes || 0,
        totalFare: opt?.Fare?.TotalFare || opt?.totalFare || 0,
        currency: opt?.Fare?.Currency || opt?.currency || "INR",
        isLCC: opt?.IsLCC ?? false,
        paymentStatus: "paid",
        bookedAt: new Date(),
        raw: tboBookResult || opt,
      });

      request.bookingId = booking._id;
    } else {
      // Hotel booking
      booking = await SBTHotelBooking.create({
        userId: request.requesterId,
        customerId: String(request.customerId || ""),
        sbtRequestId: request._id,
        bookingId: opt?.BookingId || "",
        confirmationNo: opt?.ConfirmationNo || "",
        bookingRefNo: opt?.BookingRefNo || "",
        hotelCode: opt?.HotelCode || opt?.hotelCode || "",
        hotelName: opt?.HotelName || opt?.hotelName || "",
        cityName: opt?.CityName || opt?.cityName || "",
        checkIn: opt?.CheckIn || opt?.checkIn || "",
        checkOut: opt?.CheckOut || opt?.checkOut || "",
        rooms: opt?.rooms || 1,
        guests: opt?.guests || [],
        roomName: opt?.RoomName || opt?.roomName || "",
        mealType: opt?.MealType || opt?.mealType || "",
        totalFare: opt?.TotalFare || opt?.totalFare || 0,
        netAmount: opt?.NetAmount || opt?.netAmount || opt?.TotalFare || opt?.totalFare || 0,
        currency: opt?.Currency || opt?.currency || "INR",
        isRefundable: opt?.IsRefundable ?? false,
        status: "CONFIRMED",
        paymentStatus: "paid",
        bookedAt: new Date(),
      });

      request.hotelBookingId = booking._id;
    }

    request.status = "BOOKED";
    request.bookerNotes = bookerNotes || null;
    request.actedAt = new Date();
    await request.save();

    // Send email to L1
    const requester = await User.findById(request.requesterId)
      .select("name email")
      .lean() as any;

    if (requester?.email) {
      const desc = describeOption(request.type, request.selectedOption, request.searchParams);
      const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

      await sendMail({
        to: requester.email,
        subject: `Your travel request has been booked — ${desc}`,
        kind: "CONFIRMATIONS",
        html: `
          <h3>Booking Confirmed</h3>
          <p>Your ${request.type === "flight" ? "flight" : "hotel"} request has been booked.</p>
          <p><strong>Route/Hotel:</strong> ${desc}</p>
          ${request.type === "flight" && booking?.pnr ? `<p><strong>PNR:</strong> ${booking.pnr}</p>` : ""}
          ${request.type === "hotel" && booking?.confirmationNo ? `<p><strong>Booking Ref:</strong> ${booking.confirmationNo}</p>` : ""}
          ${bookerNotes ? `<p><strong>Booker Notes:</strong> ${bookerNotes}</p>` : ""}
          <p><a href="${frontendUrl}/sbt/my-requests">View My Requests</a></p>
        `,
      }).catch((e: any) => sbtLogger.warn("Failed to send SBT booked email", { error: e?.message }));
    }

    sbtLogger.info("SBT request booked by L2", {
      requestId: request._id,
      bookingId: booking._id,
      bookerId: uid,
    });

    res.json({ request, booking });
  } catch (err: any) {
    sbtLogger.error("SBT request booking failed", { error: err.message });
    res.status(500).json({ error: "Failed to book request" });
  }
});

/* ─── POST /:id/reject — L2 rejects or suggests alternative ──────────── */

router.post("/:id/reject", async (req: any, res: any) => {
  try {
    const uid = userId(req);
    const user = await User.findById(uid).select("sbtRole roles customerId").lean() as any;

    const rejRoles = (Array.isArray(user?.roles) ? user.roles : []).map((r: any) => String(r || "").toUpperCase().replace(/[\s\-_]/g, ""));
    const isWLReject = rejRoles.includes("WORKSPACELEADER");

    if (!user || (user.sbtRole !== "L2" && user.sbtRole !== "BOTH" && !isWLReject)) {
      return res.status(403).json({ error: "SBT Booker access required", code: "NOT_L2" });
    }

    const rejFilter: any = isWLReject
      ? { _id: req.params.id, customerId: user.customerId, status: "PENDING" }
      : { _id: req.params.id, assignedBookerId: uid, status: "PENDING" };

    const request = await SBTRequest.findOne(rejFilter);

    if (!request) {
      return res.status(403).json({ error: "Request not found or not assigned to you" });
    }

    const { rejectionReason, alternativeSuggestion } = req.body || {};
    if (!rejectionReason) {
      return res.status(400).json({ error: "rejectionReason is required" });
    }

    request.status = "REJECTED";
    request.rejectionReason = rejectionReason;
    request.alternativeSuggestion = alternativeSuggestion || null;
    request.actedAt = new Date();
    await request.save();

    // Send email to L1
    const requester = await User.findById(request.requesterId)
      .select("name email")
      .lean() as any;

    if (requester?.email) {
      const desc = describeOption(request.type, request.selectedOption, request.searchParams);
      const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

      await sendMail({
        to: requester.email,
        subject: `Your travel request needs attention — ${desc}`,
        kind: "REQUESTS",
        html: `
          <h3>Request Update</h3>
          <p>Your ${request.type === "flight" ? "flight" : "hotel"} request was not approved.</p>
          <p><strong>Route/Hotel:</strong> ${desc}</p>
          <p><strong>Reason:</strong> ${rejectionReason}</p>
          ${alternativeSuggestion ? `<p><strong>Suggested Alternative:</strong> ${alternativeSuggestion}</p>` : ""}
          <p><a href="${frontendUrl}/sbt/my-requests">Raise a New Request</a></p>
        `,
      }).catch((e: any) => sbtLogger.warn("Failed to send SBT rejection email", { error: e?.message }));
    }

    sbtLogger.info("SBT request rejected", {
      requestId: request._id,
      bookerId: uid,
      reason: rejectionReason,
    });

    res.json(request);
  } catch (err: any) {
    sbtLogger.error("SBT request rejection failed", { error: err.message });
    res.status(500).json({ error: "Failed to reject request" });
  }
});

export default router;
