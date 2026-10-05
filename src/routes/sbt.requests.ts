import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { sbtLogger } from "../utils/logger.js";
import { sendMail } from "../utils/mailer.js";
import SBTRequest from "../models/SBTRequest.js";
import User from "../models/User.js";
import CustomerMember from "../models/CustomerMember.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import { requireFeature } from "../middleware/requireFeature.js";
import { buildEmailShell, eCard, eRow, eLabel, eBtn, escapeHtml } from "./approvals.email.js";
import TravelForm from "../models/TravelForm.js";
import { sellingFlightResults, stripHotelCost } from "../services/sbtQuote.js";

const router = express.Router();

/** A request as its requester / booker / Workspace Leader sees it: the option
 *  they picked without any supplier net, commission or margin field (the stored
 *  selectedOption is untouched). */
function customerRequest(request: any) {
  if (!request) return request;
  const r = typeof request.toObject === "function" ? request.toObject() : { ...request };
  if (r.selectedOption) r.selectedOption = stripHotelCost(sellingFlightResults(r.selectedOption, 0));
  return r;
}

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

    res.status(201).json(customerRequest(request));
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

    res.json({ ok: true, requests: (requests as any[]).map(customerRequest) });
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

    res.json(customerRequest(request));
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

    res.json({ ok: true, requests: enriched.map(customerRequest) });
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

    res.json(customerRequest(request));
  } catch (err: any) {
    sbtLogger.error("SBT request detail failed", { error: err.message });
    res.status(500).json({ error: "Failed to load request" });
  }
});

/* ─── POST /:id/book — retired ──────────────────────────────────────────── */
// An L2 / Workspace Leader books a request through the normal SBT flow: the
// inbox opens /sbt/flights?requestId=… (or /sbt/hotels), which pre-fills the
// search and travellers, then fare validation → server quote → checkout (card
// or company wallet) → server-side fulfilment. The request links to the paid
// booking and moves to BOOKED when it is ticketed (services/sbtRequestBooking.ts).
// This route used to call TBO directly with no payment, mark the booking
// "paid" and record the net fare as its total; it now books nothing.
router.post("/:id/book", (_req: any, res: any) => {
  return res.status(403).json({
    error: "Please book this request through checkout",
    code: "CHECKOUT_REQUIRED",
  });
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

    res.json(customerRequest(request));
  } catch (err: any) {
    sbtLogger.error("SBT request rejection failed", { error: err.message });
    res.status(500).json({ error: "Failed to reject request" });
  }
});

export default router;
