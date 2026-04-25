import express from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import User from "../models/User.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import SBTRequest from "../models/SBTRequest.js";
import TravelForm from "../models/TravelForm.js";
import CustomerMember from "../models/CustomerMember.js";
import { uploadTravelFormPdf } from "../utils/travelFormPdf.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { env } from "../config/env.js";

const router = express.Router();

// ── Privileged roles bypass SBT user check ────────────────────────────────────
function isPrivileged(req: any): boolean {
  const roles = (req.user?.roles || [])
    .map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""));
  return (
    roles.includes("SUPERADMIN") ||
    roles.includes("ADMIN") ||
    roles.includes("HR") ||
    roles.includes("WORKSPACELEADER") ||
    req.user?.customerMemberRole === "WORKSPACE_LEADER"
  );
}

// ── requireSBT — same pattern as sbt.flights.ts ───────────────────────────────
async function requireSBT(req: any, res: any, next: any) {
  try {
    if (isPrivileged(req)) return next();
    const userId = req.user?.id || req.user?._id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const user = await User.findById(userId).select("sbtEnabled customerId").lean();
    const wsCustomerId = req.workspace?.customerId?.toString();
    const userCustomerId = (user as any)?.customerId?.toString();
    if (wsCustomerId && userCustomerId && wsCustomerId !== userCustomerId) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (!user || !(user as any).sbtEnabled) {
      return res.status(403).json({ error: "SBT access not enabled for this account" });
    }
    next();
  } catch {
    return res.status(500).json({ error: "Authorization check failed" });
  }
}

// ── requireTravelForm — feature gate ─────────────────────────────────────────
function requireTravelForm(req: any, res: any, next: any) {
  if (isPrivileged(req)) return next();
  const ws = req.workspace;
  if (!ws?.config?.features?.travelFormEnabled) {
    return res.status(403).json({ error: "Travel form feature is not enabled for this workspace." });
  }
  next();
}

// Apply auth chain to all routes
router.use(requireAuth);
router.use(requireWorkspace);
router.use(requireSBT);
router.use(requireTravelForm);

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveGender(title: string): "M" | "F" | "" {
  const t = (title || "").toLowerCase().trim();
  if (t === "mr") return "M";
  if (t === "mrs" || t === "miss" || t === "ms") return "F";
  return "";
}

function toTimeSlot(isoTime: string): string {
  if (!isoTime) return "";
  // Extract hour directly from ISO string to avoid timezone issues
  const match = isoTime.match(/T(\d{2}):/);
  if (!match) return "";
  const h = parseInt(match[1], 10);
  if (h < 6) return "Before 6 AM";
  if (h < 12) return "6 AM – 12 PM";
  if (h < 18) return "12 PM – 6 PM";
  return "After 6 PM";
}

function toDateStr(isoOrDate: string): string {
  if (!isoOrDate) return "";
  const isoMatch = isoOrDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(isoOrDate)) return isoOrDate;
  const d = new Date(isoOrDate);
  if (isNaN(d.getTime())) return isoOrDate;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

async function autoPopulateFromFlight(bookingId: string, workspaceObjectId: mongoose.Types.ObjectId) {
  const booking = await SBTBooking.findOne({ _id: bookingId, workspaceId: workspaceObjectId }).lean();
  if (!booking) return null;

  const lead = (booking.passengers || []).find((p: any) => p.isLead) || booking.passengers?.[0];
  const firstName = lead?.firstName || "";
  const lastName = lead?.lastName || "";
  const travelerName = [firstName, lastName].filter(Boolean).join(" ");
  const travelerGender = deriveGender(lead?.title || "");
  const origin = booking.origin?.city ? `${booking.origin.city} (${booking.origin.code})` : "";
  const destination = booking.destination?.city ? `${booking.destination.city} (${booking.destination.code})` : "";
  const departureDate = toDateStr(booking.departureTime);
  const departureTimeSlot = toTimeSlot(booking.departureTime);

  // Look up requesterNotes from linked SBTRequest for purpose
  let purposeOfTour = "";
  if ((booking as any).sbtRequestId) {
    const req = await SBTRequest.findById((booking as any).sbtRequestId).select("requesterNotes").lean();
    purposeOfTour = (req as any)?.requesterNotes || "";
  }

  return {
    travelerName,
    travelerGender,
    origin,
    destination,
    departureDate,
    returnDate: "",
    departureTimeSlot,
    returnTimeSlot: "",
    modeOfTravel: "Air",
    transportRequirement: "Flight booked via Plumtrips",
    purposeOfTour,
    flightFare: booking.totalFare || 0,
    invoiceAmount: booking.totalFare || 0,
  };
}

async function autoPopulateFromHotel(bookingId: string, workspaceObjectId: mongoose.Types.ObjectId) {
  const booking = await SBTHotelBooking.findOne({ _id: bookingId, workspaceId: workspaceObjectId }).lean();
  if (!booking) return null;

  const lead = (booking.guests || []).find((g: any) => g.LeadPassenger) || booking.guests?.[0];
  const firstName = lead?.FirstName || "";
  const lastName = lead?.LastName || "";
  const travelerName = [firstName, lastName].filter(Boolean).join(" ");
  const travelerGender = deriveGender(lead?.Title || "");
  const destination = booking.cityName ? `${booking.cityName}${booking.countryCode ? ", " + booking.countryCode : ""}` : "";
  const departureDate = toDateStr(booking.checkIn);
  const returnDate = toDateStr(booking.checkOut);
  const totalDaysAbsent = booking.checkIn && booking.checkOut
    ? Math.ceil((new Date(booking.checkOut).getTime() - new Date(booking.checkIn).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  return {
    travelerName,
    travelerGender,
    origin: "",
    destination,
    departureDate,
    returnDate,
    departureTimeSlot: "",
    returnTimeSlot: "",
    modeOfTravel: "Others",
    transportRequirement: "Hotel booked via Plumtrips",
    accommodationRequirement: `${booking.hotelName || ""} (${departureDate} to ${returnDate})`,
    purposeOfTour: "",
    hotelFare: booking.totalFare || 0,
    invoiceAmount: booking.totalFare || 0,
    countriesVisited: booking.countryCode !== "IN" ? [booking.countryCode || ""] : [],
    totalDaysAbsent,
    _countryCode: booking.countryCode || "IN",
  };
}

// ── POST / — create or return existing draft ──────────────────────────────────
router.post("/", async (req: any, res: any) => {
  try {
    const { bookingId, bookingType, formType, requestId: incomingRequestId, ...fields } = req.body as {
      bookingId?: string;
      bookingType: "flight" | "hotel";
      formType?: "domestic" | "international";
      requestId?: string;
      [key: string]: any;
    };

    if (!bookingType) {
      return res.status(400).json({ error: "bookingType is required" });
    }

    const hasBookingId = !!bookingId;
    if (hasBookingId && !mongoose.Types.ObjectId.isValid(bookingId!)) {
      return res.status(400).json({ error: "Invalid bookingId" });
    }

    const userId = req.user?.id || req.user?._id;

    // Return existing draft if booking-linked form already exists
    if (hasBookingId) {
      const existing = await TravelForm.findOne({
        workspaceId: req.workspaceObjectId,
        bookingId,
        ...(formType ? { formType } : {}),
      }).lean();
      if (existing) return res.json({ form: existing });
    }

    // Auto-populate from booking (only when bookingId provided)
    let autoFields: Record<string, any> = {};
    if (hasBookingId) {
      let fetched: Record<string, any> | null = null;
      if (bookingType === "flight") {
        fetched = await autoPopulateFromFlight(bookingId!, req.workspaceObjectId);
      } else {
        fetched = await autoPopulateFromHotel(bookingId!, req.workspaceObjectId);
      }
      if (!fetched) {
        return res.status(404).json({ error: "Booking not found" });
      }
      autoFields = fetched;
    }

    // Resolve formType — hotel can auto-detect from booking country
    const { _countryCode, ...safeAutoFields } = autoFields as Record<string, any>;
    let resolvedFormType: "domestic" | "international";
    if (formType) {
      resolvedFormType = formType;
    } else if (bookingType === "hotel") {
      resolvedFormType = (_countryCode && _countryCode !== "IN") ? "international" : "domestic";
    } else {
      return res.status(400).json({ error: "formType is required" });
    }

    // Look up requester's travelerId
    const requesterEmail = String(req.user?.email || "").toLowerCase().trim();
    const wsCustomerId = (req as any).workspace?.customerId;
    let formTravelerId = "";
    if (requesterEmail && wsCustomerId) {
      const memberDoc = await CustomerMember.findOne({
        customerId: wsCustomerId,
        email: requesterEmail,
      }).select("travelerId").lean();
      formTravelerId = (memberDoc as any)?.travelerId || "";
    }

    const form = await TravelForm.create({
      workspaceId: req.workspaceObjectId,
      bookingId: hasBookingId ? bookingId : null,
      bookingType,
      formType: resolvedFormType,
      status: "draft",
      travelerId: formTravelerId,
      ...safeAutoFields,
      ...fields,
      ...(incomingRequestId ? {
        requestId: incomingRequestId,
        requestIds: [incomingRequestId],
      } : {}),
      createdBy: userId,
      updatedBy: userId,
    });

    return res.status(201).json({ form });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to create travel form" });
  }
});

// ── GET /find-trip — detect existing travel form for same trip (±2 days) ─────
router.get("/find-trip", async (req: any, res: any) => {
  try {
    const { email, checkInDate } = req.query as { email?: string; checkInDate?: string };
    if (!email || !checkInDate) {
      return res.status(400).json({ error: "email and checkInDate are required" });
    }
    const checkIn = new Date(checkInDate);
    if (isNaN(checkIn.getTime())) {
      return res.status(400).json({ error: "Invalid checkInDate" });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() }).select("_id").lean();
    if (!user) return res.json({ found: false });

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentForms = await TravelForm.find({
      workspaceId: req.workspaceObjectId,
      createdBy: (user as any)._id,
      status: { $in: ["draft", "submitted", "approved"] },
      createdAt: { $gte: thirtyDaysAgo },
    }).lean();

    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    const match = recentForms.find((f) => {
      if (!f.departureDate) return false;
      let formDate: Date;
      // Handle DD/MM/YYYY
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(f.departureDate)) {
        const [d, m, y] = f.departureDate.split("/");
        formDate = new Date(+y, +m - 1, +d);
      } else {
        // Fallback: let JS parse locale strings like "15 Apr 2026" or ISO
        formDate = new Date(f.departureDate);
      }
      if (isNaN(formDate.getTime())) return false;
      return Math.abs(formDate.getTime() - checkIn.getTime()) <= TWO_DAYS_MS;
    });

    if (match) return res.json({ found: true, form: match });
    return res.json({ found: false });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to find trip" });
  }
});

// ── PUT /:id/add-hotel — link hotel booking to an existing travel form ────────
router.put("/:id/add-hotel", async (req: any, res: any) => {
  try {
    const form = await TravelForm.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId });
    if (!form) return res.status(404).json({ error: "Form not found" });

    const { hotelName, checkIn, checkOut, fare, countryCode, hotelRequestId } = req.body as {
      hotelName?: string; checkIn?: string; checkOut?: string; fare?: number; countryCode?: string; hotelRequestId?: string;
    };
    const userId = req.user?.id || req.user?._id;

    if (hotelRequestId && mongoose.Types.ObjectId.isValid(hotelRequestId)) {
      const rid = new mongoose.Types.ObjectId(hotelRequestId);
      if (!form.requestIds) (form as any).requestIds = [];
      const already = (form.requestIds as any[]).some((r: any) => r.toString() === rid.toString());
      if (!already) (form.requestIds as any[]).push(rid);
    }

    form.hotelFare = fare || 0;
    form.invoiceAmount = (form.flightFare || 0) + form.hotelFare;
    form.accommodationRequirement = `${hotelName || ""} (${toDateStr(checkIn || "")} to ${toDateStr(checkOut || "")})`;

    if (form.formType === "international") {
      form.accommodationRequired = true;
      form.accommodationSuggestion = hotelName || "";
    }

    form.updatedBy = userId;
    await form.save();
    return res.json({ form });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to update travel form" });
  }
});

// ── GET /booking/:bookingId — get form(s) for a booking ───────────────────────
router.get("/booking/:bookingId", async (req: any, res: any) => {
  try {
    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ error: "Invalid bookingId" });
    }
    const forms = await TravelForm.find({
      workspaceId: req.workspaceObjectId,
      bookingId,
    }).lean();
    return res.json({ forms });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to fetch travel forms" });
  }
});

// ── GET /request/:requestId — get form linked to an SBT request ──────────────
router.get("/request/:requestId", async (req: any, res: any) => {
  try {
    const { requestId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ error: "Invalid requestId" });
    }
    const rid = new mongoose.Types.ObjectId(requestId);
    const form = await TravelForm.findOne({
      $or: [
        { requestId: rid },
        { requestIds: rid },
      ],
      workspaceId: req.workspaceObjectId,
    }).lean();
    if (!form) return res.status(404).json({ error: "Travel form not found for this request" });
    return res.json({ form });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to fetch travel form" });
  }
});

// ── PUT /:id — update editable fields ────────────────────────────────────────
router.put("/:id", async (req: any, res: any) => {
  try {
    const form = await TravelForm.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId });
    if (!form) return res.status(404).json({ error: "Travel form not found" });
    if (form.status === "rejected") {
      return res.status(400).json({ error: "Cannot edit a form that has been rejected" });
    }

    const IMMUTABLE = new Set(["workspaceId", "bookingId", "bookingType", "formType", "status", "createdBy", "_id"]);
    const userId = req.user?.id || req.user?._id;
    const body = { ...req.body };
    if (body.travelerGender === "Male") body.travelerGender = "M";
    if (body.travelerGender === "Female") body.travelerGender = "F";

    for (const [k, v] of Object.entries(body)) {
      if (!IMMUTABLE.has(k)) (form as any)[k] = v;
    }
    form.updatedBy = userId;
    await form.save();

    return res.json({ form });
  } catch (err: any) {
    console.error("[TravelForm] Update error:", err);
    return res.status(500).json({ error: err.message || "Failed to update travel form" });
  }
});

// ── POST /:id/submit ──────────────────────────────────────────────────────────
router.post("/:id/submit", async (req: any, res: any) => {
  try {
    const form = await TravelForm.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId });
    if (!form) return res.status(404).json({ error: "Travel form not found" });
    if (form.status !== "draft") {
      return res.status(400).json({ error: "Only draft forms can be submitted" });
    }

    const userId = req.user?.id || req.user?._id;
    const { signature, signatureDate } = req.body as { signature?: string; signatureDate?: string };

    form.status = "submitted";
    if (signature) form.requestorSignature = signature;
    if (signatureDate) form.requestorSignatureDate = signatureDate;
    form.updatedBy = userId;
    await form.save();

    return res.json({ form });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to submit travel form" });
  }
});

// ── POST /:id/approve — approve and generate PDF ──────────────────────────────
router.post("/:id/approve", async (req: any, res: any) => {
  try {
    const form = await TravelForm.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId });
    if (!form) return res.status(404).json({ error: "Travel form not found" });
    if (form.status !== "submitted" && form.status !== "approved") {
      return res.status(400).json({ error: "Only submitted or approved forms can be re-approved" });
    }

    const userId = req.user?.id || req.user?._id;
    const { signature, signatureDate } = req.body as { signature?: string; signatureDate?: string };

    form.status = "approved";
    if (signature) form.approverSignature = signature;
    if (signatureDate) form.approverSignatureDate = signatureDate;
    form.updatedBy = userId;
    await form.save();

    // Generate and upload PDF
    try {
      const { key } = await uploadTravelFormPdf(form);
      form.pdfS3Key = key;
      form.pdfGeneratedAt = new Date();
      await form.save();
    } catch (pdfErr: any) {
      // PDF generation failure does not block approval
      console.error("[TravelForm] PDF generation failed:", pdfErr?.message);
    }

    let pdfUrl: string | null = null;
    if (form.pdfS3Key) {
      try {
        pdfUrl = await presignGetObject({ bucket: env.S3_BUCKET, key: form.pdfS3Key, expiresInSeconds: 3600 });
      } catch {
        // non-critical
      }
    }

    return res.json({ form, pdfUrl });
  } catch (err: any) {
    console.error("[TravelForm] Approve error:", err);
    return res.status(500).json({ error: err.message || "Failed to approve travel form" });
  }
});

// ── POST /:id/reject ──────────────────────────────────────────────────────────
router.post("/:id/reject", async (req: any, res: any) => {
  try {
    const form = await TravelForm.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId });
    if (!form) return res.status(404).json({ error: "Travel form not found" });
    if (form.status !== "submitted") {
      return res.status(400).json({ error: "Only submitted forms can be rejected" });
    }

    const userId = req.user?.id || req.user?._id;
    form.status = "rejected";
    if (req.body?.reason) form.additionalDetails = req.body.reason;
    form.updatedBy = userId;
    await form.save();

    return res.json({ form });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to reject travel form" });
  }
});

// ── GET /:id/pdf — get (or generate) PDF URL ──────────────────────────────────
router.get("/:id/pdf", async (req: any, res: any) => {
  try {
    const form = await TravelForm.findOne({ _id: req.params.id, workspaceId: req.workspaceObjectId });
    if (!form) return res.status(404).json({ error: "Travel form not found" });

    if (!form.pdfS3Key) {
      const { key } = await uploadTravelFormPdf(form);
      form.pdfS3Key = key;
      form.pdfGeneratedAt = new Date();
      await form.save();
    }

    const url = await presignGetObject({ bucket: env.S3_BUCKET, key: form.pdfS3Key, expiresInSeconds: 3600 });
    return res.json({ url });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "Failed to generate PDF" });
  }
});

export default router;
