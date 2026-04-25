import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { sbtLogger } from "../utils/logger.js";
import { sendMail } from "../utils/mailer.js";
import SBTRequest from "../models/SBTRequest.js";
import User from "../models/User.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import CustomerMember from "../models/CustomerMember.js";
import { getFareQuote, bookFlight } from "../services/tbo.flight.service.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import { requireFeature } from "../middleware/requireFeature.js";
import { buildEmailShell, eCard, eRow, eLabel, eBtn, escapeHtml } from "./approvals.email.js";
import TravelForm from "../models/TravelForm.js";

const router = express.Router();
router.use(requireAuth);
router.use(requireWorkspace);
router.use(requireFeature("sbtEnabled"));

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function userId(req: any): string {
  return String(req.user?._id ?? req.user?.id ?? req.user?.sub ?? "");
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
      .select("sbtRole sbtAssignedBookerId customerId name email roles")
      .lean() as any;

    const userCustomerId = user?.customerId?.toString();
    const wsCustomerId = req.workspace?.customerId?.toString();
    if (!user || userCustomerId !== wsCustomerId) {
      return res.status(403).json({ error: "Access denied", code: "WORKSPACE_MISMATCH" });
    }

    const postRoles = (Array.isArray(user?.roles) ? user.roles : []).map((r: any) => String(r || "").toUpperCase().replace(/[\s\-_]/g, ""));
    const isWLPost = postRoles.includes("WORKSPACELEADER");

    if (!isWLPost && user.sbtRole !== "L1" && user.sbtRole !== "BOTH") {
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

    const { type, searchParams, selectedOption, requesterNotes, passengerDetails, contactDetails, travelFormId } = req.body;
    if (!type || !searchParams || !selectedOption) {
      return res.status(400).json({ error: "type, searchParams, and selectedOption are required" });
    }

    // Travel form enforcement — only when feature is enabled for this workspace
    if (req.workspace?.config?.features?.travelFormEnabled) {
      if (!travelFormId) {
        return res.status(400).json({
          error: "Travel form is required before submitting this request. Please complete the travel form.",
          requiresTravelForm: true,
        });
      }
      const travelForm = await TravelForm.findOne({
        _id: travelFormId,
        workspaceId: req.workspaceObjectId,
      }).lean();
      if (!travelForm) {
        return res.status(400).json({
          error: "Travel form not found. Please complete the travel form before submitting.",
          requiresTravelForm: true,
        });
      }
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
      workspaceId: req.workspaceObjectId,
    });

    // Link travel form to this request if provided
    if (travelFormId) {
      await TravelForm.findByIdAndUpdate(travelFormId, {
        $set: { requestId: request._id, status: "submitted" },
        $addToSet: { requestIds: request._id },
      });
    }

    // Send email to L2 booker
    const booker = await User.findById(assignedBookerId)
      .select("name email")
      .lean() as any;

    sbtLogger.info("[SBT EMAIL] Attempting to send to:", { userId: assignedBookerId, email: booker?.email, event: "request_raised" });
    if (!booker) {
      sbtLogger.warn("[SBT EMAIL] User not found:", { userId: assignedBookerId, event: "request_raised" });
    }

    if (booker?.email) {
      const desc = describeOption(type, selectedOption, searchParams);
      const date = travelDate(type, searchParams);
      const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

      const sbtEmailBody = `
        ${eCard(`
          ${eLabel("Request Details")}
          <table cellpadding="0" cellspacing="0">
            ${eRow("From", escapeHtml(user.name || user.email))}
            ${eRow("Type", escapeHtml(type === "flight" ? "Flight" : "Hotel"))}
            ${eRow("Route / Hotel", escapeHtml(desc))}
            ${date ? eRow("Travel Date", escapeHtml(date)) : ""}
            ${requesterNotes ? eRow("Notes", escapeHtml(requesterNotes)) : ""}
          </table>
        `)}
        <div style="margin-top:16px;">
          ${eBtn("View in Booking Inbox", `${frontendUrl}/sbt/inbox`, "#4f46e5", "#ffffff")}
        </div>
      `;

      await sendMail({
        to: booker.email,
        subject: `New SBT Request from ${user.name || user.email} — ${desc}`,
        kind: "REQUESTS",
        html: buildEmailShell(sbtEmailBody, {
          title: "New Booking Request",
          subtitle: "A travel request needs your attention",
          badgeText: "ACTION REQUIRED",
          badgeColor: "#f59e0b",
        }),
      }).catch((e: any) => sbtLogger.error("[SBT EMAIL FAILED]", { event: "request_raised", recipient: booker.email, error: e?.message || e }));
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
    const user = await User.findById(uid).select("sbtRole customerId roles").lean() as any;

    const myCustomerId = user?.customerId?.toString();
    const myWsCustomerId = req.workspace?.customerId?.toString();
    if (!user || myCustomerId !== myWsCustomerId) {
      return res.status(403).json({ error: "Access denied", code: "WORKSPACE_MISMATCH" });
    }

    const myRoles = (Array.isArray(user?.roles) ? user.roles : []).map((r: any) => String(r || "").toUpperCase().replace(/[\s\-_]/g, ""));
    const isWLMy = myRoles.includes("WORKSPACELEADER");

    if (!isWLMy && (user.sbtRole !== "L1" && user.sbtRole !== "BOTH")) {
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

    const inboxUserCustomerId = user?.customerId?.toString();
    const inboxWsCustomerId = req.workspace?.customerId?.toString();
    if (!user || inboxUserCustomerId !== inboxWsCustomerId) {
      return res.status(403).json({ error: "Access denied", code: "WORKSPACE_MISMATCH" });
    }

    const allRoles = (Array.isArray(user?.roles) ? user.roles : []).map((r: any) => String(r || "").toUpperCase().replace(/[\s\-_]/g, ""));
    const isWL = allRoles.includes("WORKSPACELEADER");

    if (user.sbtRole !== "L2" && user.sbtRole !== "BOTH" && !isWL) {
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

    // Batch-lookup requester travelerIds
    const requesterEmails = [
      ...new Set(
        (requests as any[]).map((r: any) => r.requesterId?.email).filter(Boolean)
      ),
    ] as string[];

    const inboxTidMap: Record<string, string> = {};
    if (requesterEmails.length > 0 && user?.customerId) {
      const memberDocs = await CustomerMember.find({
        customerId: user.customerId,
        email: { $in: requesterEmails },
      })
        .select("email travelerId")
        .lean();
      for (const m of memberDocs) {
        inboxTidMap[String((m as any).email).toLowerCase()] = String((m as any).travelerId || "");
      }
    }

    const enriched = (requests as any[]).map((r: any) => ({
      ...r,
      requesterTravelerId: inboxTidMap[String(r.requesterId?.email || "").toLowerCase()] || "",
    }));

    res.json({ ok: true, requests: enriched });
  } catch (err: any) {
    sbtLogger.error("SBT inbox failed", { error: err.message });
    res.status(500).json({ error: "Failed to load inbox" });
  }
});

/* ─── GET /:id — single request detail ────────────────────────────────── */

router.get("/:id", async (req: any, res: any) => {
  try {
    const uid = userId(req);
    const request = await SBTRequest.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId })
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

    const bookUserCustomerId = user?.customerId?.toString();
    const bookWsCustomerId = req.workspace?.customerId?.toString();
    if (!user || bookUserCustomerId !== bookWsCustomerId) {
      return res.status(403).json({ error: "Access denied", code: "WORKSPACE_MISMATCH" });
    }

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

    const { bookerNotes } = req.body || {};
    const opt = request.selectedOption as any;

    // Build TBO-format passengers from request's passenger details
    const tboPassengers = (request as any).passengerDetails?.map((pax: any, index: number) => {
      // Derive PaxType: explicit field → age from DOB → default adult
      let paxType = 1; // default Adult
      if (pax.paxType === "child" || pax.paxType === 2) {
        paxType = 2;
      } else if (pax.paxType === "infant" || pax.paxType === 3) {
        paxType = 3;
      } else if (pax.paxType === "adult" || pax.paxType === 1) {
        paxType = 1;
      } else if (pax.dateOfBirth) {
        // Fallback: derive from age at departure
        const dob = new Date(pax.dateOfBirth);
        const dep = opt?.departureTime ? new Date(opt.departureTime) : new Date();
        const ageMs = dep.getTime() - dob.getTime();
        const ageYears = ageMs / (365.25 * 24 * 60 * 60 * 1000);
        if (ageYears < 2) paxType = 3;       // Infant
        else if (ageYears < 12) paxType = 2;  // Child
      }

      // Gender: 1=Male, 2=Female, 3=Other
      const gender = pax.gender === "Male" ? 1 : pax.gender === "Female" ? 2 : 3;

      // Title: respect paxType + gender
      let title: string;
      if (paxType === 3) {
        // Infant: "Mstr" for male, "Ms" for female
        title = gender === 2 ? "Ms" : "Mstr";
      } else if (paxType === 2) {
        // Child: "Mstr" for male, "Ms" for female
        title = gender === 2 ? "Ms" : "Mstr";
      } else {
        // Adult: "Mr" for male, "Ms" for female
        title = gender === 2 ? "Ms" : "Mr";
      }

      // DOB is mandatory for Child and Infant (TBO requirement)
      const dob = pax.dateOfBirth || "";
      if ((paxType === 2 || paxType === 3) && !dob) {
        sbtLogger.warn("Missing DOB for child/infant passenger", {
          requestId: request._id,
          passengerIndex: index,
          paxType,
        });
      }

      return {
        Title: title,
        FirstName: pax.firstName,
        LastName: pax.lastName,
        PaxType: paxType,
        DateOfBirth: dob,
        Gender: gender,
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
        // Infants cannot have Baggage or Seat SSR — only Meal is allowed
        ...(paxType === 3 ? { Baggage: [], Seat: null } : {}),
      };
    }) || [];

    let booking: any;

    if (request.type === "flight") {
      const seg = opt?.Segments?.[0]?.[0] || {};
      const traceId = opt?.TraceId || (request.searchParams as any)?.TraceId || "";
      const resultIndex = opt?.ResultIndex || "";

      let tboBookResult: any = null;
      let parsedFareBreakdown: any[] = [];
      let fqFare: any = null;

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
            // Step 2: Parse FareBreakdown from FareQuote for per-passenger fares
            const fqResults = fqResponse?.Results || fqResponse;
            fqFare = fqResults?.Fare || {};
            const rawBreakdown: any[] = fqResults?.FareBreakdown || [];

            // Build per-pax fare lookup: PaxType → { perPaxBaseFare, perPaxTax }
            const fareByPaxType = new Map<number, { perPaxBaseFare: number; perPaxTax: number }>();
            for (const fb of rawBreakdown) {
              const pt = fb.PassengerType ?? fb.PaxType ?? 1;
              const count = fb.PassengerCount ?? 1;
              fareByPaxType.set(pt, {
                perPaxBaseFare: Math.round(((fb.BaseFare ?? 0) / count) * 100) / 100,
                perPaxTax: Math.round(((fb.Tax ?? 0) / count) * 100) / 100,
              });
              parsedFareBreakdown.push({
                passengerType: pt,
                passengerCount: count,
                baseFare: fb.BaseFare ?? 0,
                tax: fb.Tax ?? 0,
                perPaxBaseFare: Math.round(((fb.BaseFare ?? 0) / count) * 100) / 100,
                perPaxTax: Math.round(((fb.Tax ?? 0) / count) * 100) / 100,
              });
            }

            // Attach per-pax Fare to each passenger for TBO Book/Ticket
            if (fareByPaxType.size > 0) {
              for (const pax of tboPassengers) {
                const paxFare = fareByPaxType.get(pax.PaxType) || fareByPaxType.get(1);
                if (paxFare) {
                  pax.Fare = {
                    BaseFare: paxFare.perPaxBaseFare,
                    Tax: paxFare.perPaxTax,
                    YQTax: 0,
                    AdditionalTxnFeeOfrd: 0,
                    AdditionalTxnFeePub: 0,
                    PGCharge: 0,
                    Currency: fqFare?.Currency || opt?.Fare?.Currency || "INR",
                  };
                }
              }
            }

            // Step 3: Book with TBO (passengers now carry per-pax fares)
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

      // Use FareQuote fares if available, fall back to selectedOption fares
      // Use || (not ??) so that 0 falls through; PublishedFare checked before TotalFare
      const finalBaseFare =
        fqFare?.BaseFare || opt?.Fare?.BaseFare || opt?.baseFare || 0;
      const finalTaxes =
        fqFare?.Tax || opt?.Fare?.Tax || opt?.taxes || 0;
      const finalTotal =
        fqFare?.PublishedFare ||
        fqFare?.OfferedFare ||
        (finalBaseFare + finalTaxes) ||
        opt?.Fare?.PublishedFare ||
        opt?.Fare?.OfferedFare ||
        opt?.Fare?.TotalFare ||
        opt?.totalFare ||
        0;
      const finalCurrency = fqFare?.Currency ?? opt?.Fare?.Currency ?? opt?.currency ?? "INR";

      console.log('[BOOKING CREATE]', {
        requesterId: String(request.requesterId),
        bookerUserId: String(req.user?._id ?? req.user?.id ?? req.user?.sub ?? ""),
        requestId: String(request._id)
      });
      booking = await SBTBooking.create({
        userId: request.requesterId,
        customerId: String(request.customerId || ""),
        sbtRequestId: request._id,
        workspaceId: (req as any).workspaceObjectId,
        traceId: traceId || "",
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
        baseFare: finalBaseFare,
        taxes: finalTaxes,
        totalFare: finalTotal,
        currency: finalCurrency,
        fareBreakdown: parsedFareBreakdown.length > 0 ? parsedFareBreakdown : undefined,
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
        workspaceId: (req as any).workspaceObjectId,
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

    sbtLogger.info("[SBT EMAIL] Attempting to send to:", { userId: request.requesterId, email: requester?.email, event: "request_booked" });
    if (!requester) {
      sbtLogger.warn("[SBT EMAIL] User not found:", { userId: request.requesterId, event: "request_booked" });
    }

    if (requester?.email) {
      const desc = describeOption(request.type, request.selectedOption, request.searchParams);
      const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
      const paxNames = ((request as any).passengerDetails || [])
        .map((p: any) => `${p.firstName || ""} ${p.lastName || ""}`.trim())
        .filter(Boolean)
        .join(", ");

      const confirmedBody = `
        ${eCard(`
          ${eLabel("Booking Details")}
          <table cellpadding="0" cellspacing="0">
            ${request.type === "flight" && (booking as any)?.pnr ? eRow("PNR", escapeHtml((booking as any).pnr)) : ""}
            ${request.type === "hotel" && (booking as any)?.confirmationNo ? eRow("Booking Ref", escapeHtml((booking as any).confirmationNo)) : ""}
            ${eRow(request.type === "flight" ? "Route" : "Hotel", escapeHtml(desc))}
            ${paxNames ? eRow("Passengers", escapeHtml(paxNames)) : ""}
            ${(booking as any)?.totalFare ? eRow("Total Fare", escapeHtml(`${(booking as any).currency || "INR"} ${(booking as any).totalFare}`)) : ""}
            ${bookerNotes ? eRow("Booker Notes", escapeHtml(bookerNotes)) : ""}
          </table>
        `)}
        <div style="margin-top:16px;">
          ${eBtn("View My Requests & Tickets", `${frontendUrl}/sbt/my-requests`, "#10b981", "#ffffff")}
        </div>
      `;

      await sendMail({
        to: requester.email,
        subject: `Your travel request has been booked — ${desc}`,
        kind: "CONFIRMATIONS",
        html: buildEmailShell(confirmedBody, {
          title: "Your Trip is Confirmed",
          subtitle: "Your booking has been processed",
          badgeText: "CONFIRMED",
          badgeColor: "#10b981",
        }),
      }).catch((e: any) => sbtLogger.error("[SBT EMAIL FAILED]", { event: "request_booked", recipient: requester.email, error: e?.message || e }));
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

    const rejUserCustomerId = user?.customerId?.toString();
    const rejWsCustomerId = req.workspace?.customerId?.toString();
    if (!user || rejUserCustomerId !== rejWsCustomerId) {
      return res.status(403).json({ error: "Access denied", code: "WORKSPACE_MISMATCH" });
    }

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

    sbtLogger.info("[SBT EMAIL] Attempting to send to:", { userId: request.requesterId, email: requester?.email, event: "request_rejected" });
    if (!requester) {
      sbtLogger.warn("[SBT EMAIL] User not found:", { userId: request.requesterId, event: "request_rejected" });
    }

    if (requester?.email) {
      const desc = describeOption(request.type, request.selectedOption, request.searchParams);
      const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

      const rejectedBody = `
        ${eCard(`
          ${eLabel("Request Details")}
          <table cellpadding="0" cellspacing="0">
            ${eRow(request.type === "flight" ? "Route" : "Hotel", escapeHtml(desc))}
            ${eRow("Reason", escapeHtml(rejectionReason))}
            ${alternativeSuggestion ? eRow("Alternative Suggestion", escapeHtml(alternativeSuggestion)) : ""}
          </table>
        `)}
        <div style="margin-top:16px;">
          ${eBtn("Raise a New Request", `${frontendUrl}/sbt/my-requests`, "#6366f1", "#ffffff")}
        </div>
      `;

      await sendMail({
        to: requester.email,
        subject: `Your travel request needs attention — ${desc}`,
        kind: "REQUESTS",
        html: buildEmailShell(rejectedBody, {
          title: "Booking Request Update",
          subtitle: "Your travel request has been reviewed",
          badgeText: "NOT APPROVED",
          badgeColor: "#ef4444",
        }),
      }).catch((e: any) => sbtLogger.error("[SBT EMAIL FAILED]", { event: "request_rejected", recipient: requester.email, error: e?.message || e }));
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
