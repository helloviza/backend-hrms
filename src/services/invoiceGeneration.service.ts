// Invoice-generation service.
//
// Single callable home for the logic that previously lived inline (and
// duplicated) inside POST /api/admin/invoices/generate and
// POST /api/admin/invoices/bulk-generate. The two HTTP routes are now thin
// wrappers that parse/validate their input and call createInvoiceFromBookings.
//
// Two output shapes:
//   format: 'COMBINED'  → ONE invoice for all bookingIds   (the old /generate path)
//   format: 'SEPARATE'  → ONE invoice per booking          (the old /bulk-generate loop)
//
// Reuses the existing leaf helpers (buildLineItemsForBooking,
// buildCombinedLineItems, resolveGstWithBypass, calculateGSTAmounts,
// getCompanySettings, resolveCustomerState, buildAddressStr) — GST/line math is
// NOT reimplemented here.
//
// Canonical behavior is the richer /generate path: SEPARATE invoices now also
// honour gstTypeOverride and the workspace-address fallback, and use the
// ex-GST subtotal formula. See infra/audit/auto-invoice-refactor.md for the
// reviewed behavioral deltas this causes for the /bulk-generate path.

import mongoose from "mongoose";
import Invoice from "../models/Invoice.js";
import ManualBooking from "../models/ManualBooking.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Customer from "../models/Customer.js";
import { getCompanySettings } from "../models/CompanySettings.js";
import { buildLineItemsForBooking, buildCombinedLineItems } from "../utils/invoiceLineItems.js";
import { resolveCustomerState, buildAddressStr } from "../utils/invoiceClient.js";
import { detectGSTType, calculateGSTAmounts, GST_STATE_CODES, UNION_TERRITORIES, type GSTType } from "../utils/gstDetection.js";
import { resolveSellerGstProfile, SellerGstinNotFoundError } from "../utils/sellerGstResolver.js";
import { triggerTaskAutomation } from "./taskAutomation.js";

/* ── Error type so route wrappers can reproduce the exact HTTP responses ── */

export class InvoiceGenerationError extends Error {
  httpStatus: number;
  body: any;
  constructor(httpStatus: number, body: any) {
    super(body?.message || body?.error || "Invoice generation failed");
    this.name = "InvoiceGenerationError";
    this.httpStatus = httpStatus;
    this.body = body;
  }
}

/* ── Customer._id → CustomerWorkspace resolution (centralized) ──────────────
 * ManualBooking.workspaceId stores a Customer._id; Invoice.workspaceId stores
 * the CustomerWorkspace._id (falling back to the Customer._id when no workspace
 * exists). This is the single forward-conversion helper; it returns both the
 * resolved invoice workspaceId AND the workspace doc (the doc is needed for the
 * address fallback). Replaces the inline conversions previously at
 * routes/invoices.ts (/generate and /bulk-generate).
 */
export async function resolveInvoiceWorkspace(
  customerId: string | mongoose.Types.ObjectId,
): Promise<{ invoiceWorkspaceId: any; workspace: any }> {
  const workspace = await CustomerWorkspace.findOne({ customerId: String(customerId) }).lean();
  return { invoiceWorkspaceId: (workspace as any)?._id ?? customerId, workspace: workspace ?? null };
}

export interface GstResolution {
  ok: boolean;
  gstType?: GSTType;
  detection?: {
    gstType: GSTType;
    supplierState: string;
    customerState: string;
    supplierStateCode: string;
    customerStateCode: string;
    placeOfSupply: string;
    canCalculate: true;
    bypassed: boolean;
    bypassReason?: string;
  };
  bypassed?: boolean;
  reason?: string;
  missingField?: string;
}

export function resolveGstWithBypass(input: {
  gstBypass: boolean;
  gstBypassReason: string;
  supplierState: string;
  customerState: string;
  customerCountry: string;
}): GstResolution {
  if (input.gstBypass) {
    // Reuses gstDetection's UNION_TERRITORIES — UTs without their own
    // legislature only (Delhi/Puducherry/J&K levy SGST, not UTGST; see
    // gstDetection.ts). One source of truth for this classification.
    const gstType: GSTType = UNION_TERRITORIES.has(input.supplierState)
      ? "CGST_UTGST"
      : "CGST_SGST";
    const customerState = input.customerState || "";
    const placeOfSupply = customerState.trim() ? customerState.trim() : input.supplierState;
    return {
      ok: true,
      gstType,
      detection: {
        gstType,
        supplierState: input.supplierState,
        customerState,
        supplierStateCode: GST_STATE_CODES[input.supplierState] || "",
        customerStateCode: customerState ? GST_STATE_CODES[customerState] || "" : "",
        placeOfSupply,
        canCalculate: true,
        bypassed: true,
        bypassReason: input.gstBypassReason,
      },
      bypassed: true,
    };
  }

  const detection = detectGSTType({
    supplierState: input.supplierState,
    customerState: input.customerState,
    customerCountry: input.customerCountry,
  });
  if (!detection.canCalculate) {
    return {
      ok: false,
      reason: detection.reason || "GST detection failed",
      missingField: detection.reason?.includes("state") ? "state" : "unknown",
    };
  }
  return {
    ok: true,
    gstType: detection.gstType,
    detection: {
      gstType: detection.gstType,
      supplierState: detection.supplierState,
      customerState: detection.customerState,
      supplierStateCode: detection.supplierStateCode,
      customerStateCode: detection.customerStateCode,
      placeOfSupply: detection.placeOfSupply,
      canCalculate: true,
      bypassed: false,
    },
    bypassed: false,
  };
}

/* ── Service options ───────────────────────────────────────────────────── */

export interface CreateInvoiceOpts {
  format: "COMBINED" | "SEPARATE";
  // Line presentation for the single-invoice (COMBINED) format: 'SEPARATE'
  // itemises every booking, 'COMBINED' merges per category. Totals are
  // identical either way. Ignored for format 'SEPARATE'. Default 'SEPARATE'.
  lineItemStyle?: "COMBINED" | "SEPARATE";
  billingPeriod?: string;
  invoiceDate?: Date | string;
  dueDate?: Date | string;
  notes?: string;
  terms?: string;
  showInclusiveTaxNote?: boolean;
  gstTypeOverride?: GSTType;
  gstOverrideReason?: string;
  gstBypass?: boolean;
  gstBypassReason?: string;
  // Per-invoice seller-registration override (multi-GSTIN). Must match an
  // active gstProfiles entry — resolveSellerGstProfile throws otherwise.
  // Selection order: this override → per-client default (later step) → the
  // global isDefault profile → flat-field synthesis (registry not seeded).
  sellerGstin?: string;
  // Per-invoice place-of-supply override — the operator's chosen client GST
  // state at the generation popup. Absent = auto-resolve via
  // Customer.gstRegisteredState fallback chain (today's behaviour, unchanged).
  customerStateOverride?: string;
  createdBy: string;
  isDemoUser?: boolean;
  // Explicit tenant scope for non-HTTP callers (e.g. the auto-invoice
  // scheduler). Reserved seam — accepted but intentionally unused for now;
  // tenant-scope enforcement is a separate later phase.
  workspaceScope?: mongoose.Types.ObjectId | null;
}

const ALLOWED_OVERRIDES: GSTType[] = ["CGST_SGST", "CGST_UTGST", "IGST", "EXPORT", "NONE"];

interface InvoiceContext {
  invoiceWorkspaceId: any;
  clientDetails: any;
  issuerDetails: any;
  detection: any;
  resolvedGstType: GSTType;
  bypassGstType: GSTType | undefined;
  useOverride: boolean;
  issuerState: string;
  clientState: string;
}

/** Build the per-batch client/issuer/GST context once (all bookings in a call
 *  share one workspace, so this is resolved a single time). Mirrors the old
 *  /generate block including the workspace-address fallback. */
function buildInvoiceContext(
  customer: any,
  workspace: any,
  companySettings: any,
  invoiceWorkspaceId: any,
  opts: CreateInvoiceOpts,
): InvoiceContext {
  const cust = (customer || {}) as any;
  const custAddr: any = cust.address ?? {};
  // Workspace address fallback for customers with no structured address
  const addrFallback: any = (!custAddr.street && !custAddr.city)
    ? ((workspace as any)?.address ?? {})
    : {};

  const { state: customerStateRaw, country: customerCountry } = resolveCustomerState(cust);
  const effectiveState = customerStateRaw || addrFallback.state || "";
  const effectiveCountry = customerCountry || addrFallback.country || "India";

  // Place-of-supply override from the generation popup — when absent, this is
  // exactly effectiveState (today's auto-resolved behaviour, unchanged).
  const resolvedCustomerState = (opts.customerStateOverride || "").trim() || effectiveState;

  // Multi-GST: resolve which of Peachmint's registrations this invoice is
  // issued under. override → customer default → global default →
  // flat-field synthesis. The chosen profile's state feeds detectGSTType
  // below in place of the flat supplierState — detectGSTType itself is
  // untouched.
  let sellerProfile;
  try {
    sellerProfile = resolveSellerGstProfile({
      overrideGstin: opts.sellerGstin,
      customerDefaultGstin: cust.defaultSellerGstin,
      companySettings,
    });
  } catch (err) {
    if (err instanceof SellerGstinNotFoundError) {
      throw new InvoiceGenerationError(400, {
        error: "SELLER_GSTIN_NOT_FOUND",
        message: err.message,
      });
    }
    throw err;
  }
  const issuerState = sellerProfile.state;

  const resolution = resolveGstWithBypass({
    gstBypass: opts.gstBypass === true,
    gstBypassReason: (opts.gstBypassReason || "").trim(),
    supplierState: issuerState,
    customerState: resolvedCustomerState,
    customerCountry: effectiveCountry,
  });
  if (!resolution.ok) {
    throw new InvoiceGenerationError(400, {
      error: "GST_DETECTION_FAILED",
      message: resolution.reason,
      customerId: cust._id,
      missingField: resolution.missingField,
      hint: "Update customer profile with state before generating invoice",
    });
  }
  const detection = resolution.detection;

  const useOverride = Boolean(opts.gstTypeOverride && ALLOWED_OVERRIDES.includes(opts.gstTypeOverride));
  if (useOverride && !opts.gstOverrideReason) {
    throw new InvoiceGenerationError(400, {
      error: "gstOverrideReason is required when using gstTypeOverride",
    });
  }
  const resolvedGstType: GSTType = useOverride ? opts.gstTypeOverride! : (resolution.gstType as GSTType);

  const custAddrLine1 = custAddr.street  || addrFallback.line1   || "";
  const custAddrLine2 = custAddr.street2 || addrFallback.line2   || "";
  const custCity      = custAddr.city    || addrFallback.city    || "";
  const custCountry   = custAddr.country || addrFallback.country || "India";
  const custPincode   = custAddr.pincode  || addrFallback.pincode || "";

  const clientDetails = {
    companyName:    cust.legalName || cust.companyName || cust.name || "",
    gstin:          cust.gstNumber || cust.gstin || "",
    billingAddress: cust.registeredAddress || cust.billingAddress ||
      buildAddressStr({ addressLine1: custAddrLine1, addressLine2: custAddrLine2, city: custCity, state: detection.customerState, country: custCountry, pincode: custPincode }),
    addressLine1:   custAddrLine1,
    addressLine2:   custAddrLine2,
    city:           custCity,
    country:        custCountry,
    pincode:        custPincode,
    contactPerson:  cust.contacts?.primaryContact || cust.contacts?.keyContacts?.[0]?.name || "",
    email:          cust.contacts?.officialEmail || cust.email || "",
    state:          detection.customerState,
  };

  const issuerDetails = {
    companyName:  sellerProfile.legalName || companySettings.companyName || process.env.COMPANY_NAME,
    gstin:        sellerProfile.gstin,
    address:      companySettings.address     || process.env.COMPANY_ADDRESS,
    addressLine1: sellerProfile.addressLine1,
    addressLine2: sellerProfile.addressLine2,
    city:         sellerProfile.city,
    country:      sellerProfile.country,
    pincode:      sellerProfile.pincode,
    email:        companySettings.email       || process.env.COMPANY_EMAIL,
    phone:        companySettings.phone       || process.env.COMPANY_PHONE,
    website:      companySettings.website     || process.env.COMPANY_WEBSITE,
    state:        issuerState,
  };

  return {
    invoiceWorkspaceId,
    clientDetails,
    issuerDetails,
    detection,
    resolvedGstType,
    bypassGstType: resolution.gstType as GSTType | undefined,
    useOverride,
    issuerState,
    clientState: detection.customerState,
  };
}

/** Create ONE invoice from the given bookings. Used for both COMBINED (all
 *  bookings, line presentation per lineItemStyle) and SEPARATE (a single
 *  booking). Returns the freshly-refetched raw invoice doc (includes the
 *  lineItems written via the raw collection update) — identical to the shape
 *  the old /generate route returned. */
async function createOneInvoice(
  bookingsForInvoice: any[],
  ctx: InvoiceContext,
  opts: CreateInvoiceOpts,
  useCombinedLineItems: boolean,
  resolvedInvoiceDate: Date,
): Promise<any> {
  const lineItems: any[] = useCombinedLineItems
    ? buildCombinedLineItems(bookingsForInvoice as any[])
    : bookingsForInvoice.flatMap((b: any) => buildLineItemsForBooking(b));

  // Per-row Amount = Rate × Qty + GST, so Σ amount across rows equals grandTotal.
  // Subtotal is back-extracted as (Σ amount − Σ GST). pricing-based grandTotal
  // remains the source of truth and serves as a defensive cross-check.
  const totalAmount = lineItems.reduce((s, li) => s + (li.amount ?? 0), 0);
  const totalGST = lineItems.reduce((s, li) => s + (li.igst ?? 0), 0);
  const subtotal = parseFloat((totalAmount - totalGST).toFixed(2));
  let grandTotal = 0;
  for (const b of bookingsForInvoice as any[]) {
    // Group Booking with an explicit lineItems[] table: pricing.grandTotal is
    // ALWAYS the authoritative Σ line-amount total (ManualBooking.ts pre-save
    // hook) regardless of gstMode — gstMode is a stale/irrelevant leftover
    // field for these bookings, not the "quotedPrice already includes GST"
    // signal the branch below assumes. See infra/audit/
    // events-line-items-audit.md.
    if (Array.isArray(b.lineItems) && b.lineItems.length > 0) {
      grandTotal += b.pricing?.grandTotal ?? 0;
      continue;
    }
    const gstMode = b.pricing?.gstMode || "ON_MARKUP";
    if (gstMode === "ON_MARKUP") {
      grandTotal += b.pricing?.quotedPrice ?? 0;
    } else {
      grandTotal += b.pricing?.grandTotal ?? ((b.pricing?.quotedPrice ?? 0) + (b.pricing?.gstAmount ?? 0));
    }
  }
  grandTotal = parseFloat(grandTotal.toFixed(2));

  // Sanity: Σ amount should equal pricing.grandTotal under the per-row contract.
  const reconciledFromAmounts = parseFloat(totalAmount.toFixed(2));
  if (Math.abs(reconciledFromAmounts - grandTotal) > 1) {
    const bookingRefs = (bookingsForInvoice as any[]).map((b: any) => b.bookingRef).join(",");
    console.warn(
      `[invoice ${bookingRefs}] reconciliation drift: ` +
      `Σ amount=${reconciledFromAmounts} vs pricing.grandTotal=${grandTotal}`,
    );
  }

  const rawTotalGST = parseFloat(totalGST.toFixed(2));
  const gstAmounts = calculateGSTAmounts(rawTotalGST, ctx.resolvedGstType);

  const invoice = await Invoice.create({
    workspaceId: ctx.invoiceWorkspaceId,
    billingPeriod: opts.billingPeriod,
    bookingIds: bookingsForInvoice.map((b: any) => b._id),
    subtotal: parseFloat(subtotal.toFixed(2)),
    totalGST: rawTotalGST,
    grandTotal,
    supplyType: ctx.resolvedGstType,
    cgstAmount: gstAmounts.cgst,
    sgstAmount: gstAmounts.sgst,
    utgstAmount: gstAmounts.utgst,
    igstAmount: gstAmounts.igst,
    gstTypeAutoDetected: ctx.detection.gstType,
    gstTypeOverridden: ctx.useOverride ? true : false,
    gstOverrideReason: ctx.useOverride ? opts.gstOverrideReason : undefined,
    gstOverrideBy: ctx.useOverride ? opts.createdBy : undefined,
    gstBypass: opts.gstBypass === true,
    gstBypassType: opts.gstBypass === true ? (ctx.bypassGstType as "CGST_SGST" | "CGST_UTGST") : null,
    gstBypassReason: opts.gstBypass === true ? (opts.gstBypassReason || "").trim() : "",
    placeOfSupply: ctx.detection.placeOfSupply,
    issuerState: ctx.issuerState,
    clientState: ctx.clientState,
    issuerDetails: ctx.issuerDetails,
    clientDetails: ctx.clientDetails,
    terms: opts.terms,
    notes: opts.notes,
    showInclusiveTaxNote: opts.showInclusiveTaxNote === true,
    invoiceDate: resolvedInvoiceDate,
    dueDate: opts.dueDate ? new Date(opts.dueDate) : undefined,
    createdBy: opts.createdBy,
  } as any);

  // Store lineItems bypassing mongoose validation (lineItems schema is Mixed).
  await Invoice.collection.updateOne(
    { _id: invoice._id },
    { $set: { lineItems } },
  );

  const completeInvoice = await Invoice.collection.findOne({ _id: invoice._id });

  // Mark bookings INVOICED and record invoice raised date.
  await ManualBooking.updateMany(
    { _id: { $in: bookingsForInvoice.map((b: any) => b._id) } },
    { $set: { status: "INVOICED", invoiceId: invoice._id, invoiceRaisedDate: new Date() } },
  );

  // Task automation hook (fire-and-forget).
  triggerTaskAutomation("invoice.created", {
    workspaceId: String(ctx.invoiceWorkspaceId),
    entityType: "INVOICE",
    entityId: invoice._id,
    entityRef: invoice.invoiceNo,
    ownerId: opts.createdBy,
    variables: {
      invoiceNo: invoice.invoiceNo,
      customerName: ctx.clientDetails.companyName || "",
    },
  }).catch(() => {});

  return completeInvoice;
}

/**
 * Generate invoice(s) from a set of manual bookings.
 *
 * COMBINED → one invoice for all bookingIds (rejects the whole call if any
 *            booking is already invoiced).
 * SEPARATE → one invoice per eligible booking; bookings that are already
 *            invoiced / cancelled (or fail mid-create) are skipped, and the
 *            created invoices are returned. Callers that need a per-booking
 *            failure breakdown derive it from the returned set vs the input.
 *
 * Throws InvoiceGenerationError (with httpStatus + body) for batch-level
 * failures so HTTP wrappers can reproduce today's exact responses.
 */
export async function createInvoiceFromBookings(
  bookingIds: string[],
  opts: CreateInvoiceOpts,
): Promise<any[]> {
  if (!Array.isArray(bookingIds) || !bookingIds.length) {
    throw new InvoiceGenerationError(400, { error: "bookingIds array is required" });
  }

  const resolvedInvoiceDate = opts.invoiceDate ? new Date(opts.invoiceDate) : new Date();

  // Demo Platform: demo callers invoice only demo bookings; real callers protected.
  const demoClause = opts.isDemoUser ? { isDemo: true } : { isDemo: { $ne: true } };
  const bookings = await ManualBooking.find({
    _id: { $in: bookingIds.map((id) => new mongoose.Types.ObjectId(id)) },
    ...demoClause,
  }).lean();

  if (bookings.length !== bookingIds.length) {
    throw new InvoiceGenerationError(400, { error: "One or more booking IDs not found" });
  }

  // All must belong to the same workspace (Customer._id on the booking).
  const wsIds = [...new Set((bookings as any[]).map((b: any) => b.workspaceId.toString()))];
  if (wsIds.length > 1) {
    throw new InvoiceGenerationError(400, { error: "All bookings must belong to the same workspace" });
  }
  const wsId = wsIds[0].toString();

  const customer = await Customer.findById(wsId).lean();
  const { invoiceWorkspaceId, workspace } = await resolveInvoiceWorkspace(wsId);

  const companySettings = await getCompanySettings();

  const ctx = buildInvoiceContext(customer, workspace, companySettings, invoiceWorkspaceId, opts);

  if (opts.format === "COMBINED") {
    // None already invoiced (whole-batch reject — preserves /generate behavior).
    const alreadyInvoiced = (bookings as any[]).filter((b: any) => b.status === "INVOICED");
    if (alreadyInvoiced.length) {
      throw new InvoiceGenerationError(400, {
        error: `${alreadyInvoiced.length} booking(s) are already invoiced`,
        refs: alreadyInvoiced.map((b: any) => b.bookingRef),
      });
    }
    const useCombinedLineItems = opts.lineItemStyle === "COMBINED";
    const invoice = await createOneInvoice(bookings as any[], ctx, opts, useCombinedLineItems, resolvedInvoiceDate);
    return [invoice];
  }

  // SEPARATE — one invoice per eligible booking, sequential to keep invoice
  // numbers in booking order. Ineligible/failed bookings are skipped; the
  // caller derives the failure list from the returned set.
  const created: any[] = [];
  for (const booking of bookings as any[]) {
    if (booking.invoiceId || booking.status === "INVOICED" || booking.status === "CANCELLED") {
      continue;
    }
    try {
      const invoice = await createOneInvoice([booking], ctx, opts, false, resolvedInvoiceDate);
      created.push(invoice);
    } catch (err: any) {
      console.error(`[createInvoiceFromBookings] booking ${booking.bookingRef}:`, err?.message);
      // Skip — surfaced to the caller as a non-generated booking.
    }
  }
  return created;
}
