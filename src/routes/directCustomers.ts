// apps/backend/src/routes/directCustomers.ts
import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requirePermission } from "../middleware/requirePermission.js";
import Customer from "../models/Customer.js";
import { GST_STATE_CODES } from "../utils/gstDetection.js";
import { normalizeGstin } from "../utils/gstinState.js";
import { addRegistration, checkGstin } from "../services/gstRegistrations.js";

const router = Router();

const PAN_RE   = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function generateDirectCode(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `DIR-${year}-`;
  const last: any = await Customer.findOne({ customerCode: new RegExp(`^${prefix}`) })
    .sort({ customerCode: -1 })
    .lean()
    .exec();
  if (!last?.customerCode) return `${prefix}0001`;
  const num = parseInt(last.customerCode.split("-")[2] || "0", 10) || 0;
  return `${prefix}${String(num + 1).padStart(4, "0")}`;
}

/**
 * POST /api/admin/direct-customers
 * Create a Direct Customer (walk-in / individual).
 * Requires manualBookings WRITE permission.
 */
router.post(
  "/",
  requireAuth,
  requireWorkspace,
  requirePermission("directCustomers", "WRITE"),
  async (req: any, res, next) => {
    try {
      const {
        displayName,
        email: rawEmail,
        phone,
        address,
        gstNumber,
        gstRegisteredState,
        panNumber,
        notes,
      } = req.body || {};

      // ── Validation ─────────────────────────────────────────────
      const name = String(displayName || "").trim();
      if (!name || name.length < 2 || name.length > 100) {
        return res.status(400).json({ error: "displayName must be 2–100 characters" });
      }

      const email = String(rawEmail || "").trim().toLowerCase();
      if (!email || !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: "A valid email is required" });
      }

      if (panNumber && !PAN_RE.test(String(panNumber).toUpperCase())) {
        return res.status(400).json({ error: "Invalid PAN format (e.g. ABCDE1234F)" });
      }

      // GSTIN (R2): the same checks as every GST registration — format, check
      // digit, PAN, a current state code, not on another company — and its
      // state is the GSTIN's own: a different typed state is refused.
      const gstin = normalizeGstin(gstNumber);
      if (gstin) {
        const chk = await checkGstin({ panNumber: panNumber ? String(panNumber).toUpperCase() : "", gstRegistrations: [] }, gstin);
        if (!chk.ok) {
          return res.status(chk.code === "GSTIN_ON_OTHER_COMPANY" ? 409 : 400).json({ error: chk.error, code: chk.code, ...(chk.otherCompany ? { otherCompany: chk.otherCompany } : {}) });
        }
        const typed = gstRegisteredState ? String(gstRegisteredState).trim() : "";
        if (typed && typed.toLowerCase() !== String(chk.state).toLowerCase()) {
          return res.status(400).json({ error: `GSTIN ${gstin} is registered in ${chk.state}, not ${typed}.`, code: "STATE_FROM_GSTIN" });
        }
      }

      const wsId = req.workspaceObjectId;

      // ── Duplicate check ─────────────────────────────────────────
      const existing: any = await Customer.findOne({ email, workspaceId: wsId }).lean().exec();
      if (existing) {
        if (existing.customerType === "DIRECT") {
          // Return existing record — idempotent
          return res.json({
            ok: true,
            duplicate: true,
            customer: {
              _id:          String(existing._id),
              customerCode: existing.customerCode || "",
              name:         existing.name || "",
              email:        existing.email || "",
              customerType: existing.customerType,
              address:      existing.address || {},
              gstNumber:    existing.gstNumber || "",
              panNumber:    existing.panNumber || "",
            },
          });
        }
        // Existing BUSINESS customer with same email
        return res.status(409).json({
          error: "A business customer with this email already exists. Use that instead.",
          existingId: String(existing._id),
          existingName: existing.legalName || existing.name || "",
        });
      }

      // ── Create ──────────────────────────────────────────────────
      const customerCode = await generateDirectCode();

      const normalizedAddress = address ? {
        street:  String(address.line1 || "").trim(),
        street2: String(address.line2 || "").trim(),
        city:    String(address.city  || "").trim(),
        state:   String(address.state || "").trim(),
        country: String(address.country || "India").trim(),
        pincode: String(address.pincode || "").trim(),
      } : {};

      // A GSTIN-less customer may still carry a typed state; with a GSTIN the
      // registration service sets the state (and gstNumber) from it.
      const gstState = !gstin && gstRegisteredState ? String(gstRegisteredState).trim() : undefined;

      let doc: any = await Customer.create({
        workspaceId:          wsId,
        customerType:         "DIRECT",
        customerCode,
        name,
        legalName:            name,
        companyName:          name,
        email,
        phone:                phone ? String(phone).trim() : undefined,
        address:              normalizedAddress,
        // Without a GSTIN the status stays unset (NOT_SET) for staff to mark —
        // never assumed UNREGISTERED. With one, addRegistration below makes
        // the company REGISTERED.
        gstRegisteredState:   gstState,
        gstRegisteredStateCode: gstState ? (GST_STATE_CODES[gstState] || "") : undefined,
        panNumber:            panNumber ? String(panNumber).toUpperCase().trim() : undefined,
        notes:                notes ? String(notes).trim() : undefined,
        type:                 "CUSTOMER",
        status:               "ACTIVE",
        createdBy:            new mongoose.Types.ObjectId(String(req.user._id || req.user.id || req.user.sub)),
      } as any);

      if (gstin) {
        await addRegistration(
          doc._id,
          { gstin },
          { actorId: String(req.user._id || req.user.id || req.user.sub || ""), source: "POST /admin/direct-customers" },
        );
        doc = await Customer.findById(doc._id).lean();
      }

      return res.status(201).json({
        ok: true,
        customer: {
          _id:          String(doc._id),
          customerCode: doc.customerCode || "",
          name:         (doc as any).name || "",
          email:        (doc as any).email || "",
          customerType: (doc as any).customerType || "DIRECT",
          address:      (doc as any).address || {},
          gstNumber:    (doc as any).gstNumber || "",
          panNumber:    (doc as any).panNumber || "",
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
