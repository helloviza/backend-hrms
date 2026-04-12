import express from "express";
import ExcelJS from "exceljs";
import mongoose from "mongoose";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { requirePermission } from "../middleware/requirePermission.js";
import Invoice from "../models/Invoice.js";
import ManualBooking from "../models/ManualBooking.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Customer from "../models/Customer.js";
import { generateInvoicePdf } from "../utils/invoicePdf.js";
import { getCompanySettings } from "../models/CompanySettings.js";
import { env } from "../config/env.js";

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

/* ── Helpers ────────────────────────────────────────────────────── */

function csvRow(values: (string | number | undefined | null)[]) {
  return (
    values
      .map((v) => {
        const s = v == null ? "" : String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      })
      .join(",") + "\n"
  );
}

const INVOICE_COLUMNS = [
  "Invoice No",
  "Billing Period",
  "Client",
  "Client GSTIN",
  "Client Address",
  "Our GSTIN",
  "Bookings Count",
  "Subtotal",
  "Total GST",
  "Grand Total",
  "Status",
  "Generated At",
  "Due Date",
  "Paid At",
  "Terms",
  "Notes",
];

function invoiceToRow(inv: any): (string | number | undefined)[] {
  return [
    inv.invoiceNo,
    inv.billingPeriod,
    inv.clientDetails?.companyName,
    inv.clientDetails?.gstin || "",
    inv.clientDetails?.billingAddress || "",
    inv.issuerDetails?.gstin || "",
    inv.bookingIds?.length ?? 0,
    inv.subtotal ?? 0,
    inv.totalGST ?? 0,
    inv.grandTotal ?? 0,
    inv.status,
    inv.generatedAt ? new Date(inv.generatedAt).toLocaleDateString("en-IN") : "",
    inv.dueDate ? new Date(inv.dueDate).toLocaleDateString("en-IN") : "",
    inv.paidAt ? new Date(inv.paidAt).toLocaleDateString("en-IN") : "",
    inv.terms || "Due on Receipt",
    inv.notes || "",
  ];
}

/* ── Generate Invoice ───────────────────────────────────────────── */

// POST /api/admin/invoices/generate
router.post("/generate", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const { bookingIds, billingPeriod, dueDate, notes, terms } = req.body as {
      bookingIds: string[];
      billingPeriod?: string;
      dueDate?: string;
      notes?: string;
      terms?: string;
    };

    if (!Array.isArray(bookingIds) || !bookingIds.length) {
      return res.status(400).json({ error: "bookingIds array is required" });
    }

    // Validate bookings
    const bookings = await ManualBooking.find({
      _id: { $in: bookingIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).lean();

    if (bookings.length !== bookingIds.length) {
      return res.status(400).json({ error: "One or more booking IDs not found" });
    }

    // All must belong to same workspace
    const wsIds = [...new Set(bookings.map((b: any) => b.workspaceId.toString()))];
    if (wsIds.length > 1) {
      return res.status(400).json({ error: "All bookings must belong to the same workspace" });
    }

    // None already invoiced
    const alreadyInvoiced = bookings.filter((b: any) => b.status === "INVOICED");
    if (alreadyInvoiced.length) {
      return res.status(400).json({
        error: `${alreadyInvoiced.length} booking(s) are already invoiced`,
        refs: alreadyInvoiced.map((b: any) => b.bookingRef),
      });
    }

    const wsId = wsIds[0].toString()

    // Look up Customer directly — this is where billing data lives
    const customer = await Customer
      .findById(wsId).lean()

    console.log('[Invoice generate] customer found:',
      customer ? (customer as any).legalName
                 || (customer as any).name
               : 'NOT FOUND')
    console.log('[Invoice generate] wsId used:', wsId)

    const companySettings = await getCompanySettings();
    const issuerState = companySettings.state || process.env.COMPANY_STATE || "";

    const cust = (customer || {}) as any;

    let clientDetails = {
      companyName:    cust.legalName
                      || cust.companyName
                      || cust.name
                      || '',
      gstin:          cust.gstNumber
                      || cust.gstin
                      || '',
      billingAddress: cust.registeredAddress
                      || cust.billingAddress
                      || '',
      contactPerson:  cust.contacts?.primaryContact
                      || cust.contacts?.keyContacts?.[0]?.name
                      || '',
      email:          cust.contacts?.officialEmail
                      || cust.email
                      || '',
      state:          '',  // extract from address if needed later
    };

    console.log('[Invoice generate] clientDetails built:', JSON.stringify(clientDetails));

    const issuerDetails = {
      companyName: companySettings.companyName || process.env.COMPANY_NAME,
      gstin:       companySettings.gstin       || process.env.COMPANY_GSTIN,
      address:     companySettings.address     || process.env.COMPANY_ADDRESS,
      email:       companySettings.email       || process.env.COMPANY_EMAIL,
      phone:       companySettings.phone       || process.env.COMPANY_PHONE,
      website:     companySettings.website     || process.env.COMPANY_WEBSITE,
      state:       issuerState,
    };

    // Determine supply type: IGST if states differ, CGST_SGST if same
    const clientState = clientDetails.state;
    const supplyType =
      issuerState && clientState && issuerState.toLowerCase() === clientState.toLowerCase()
        ? "CGST_SGST"
        : "IGST";

    // Build TWO line items per booking: COST row + SERVICE_FEE row
    const invoiceLineItems: any[] = [];
    for (const b of bookings as any[]) {
      const passengerNames = (b.passengers || []).map((p: any) => p.name);
      const paxStr = passengerNames.join(", ") || "—";

      const route =
        b.itinerary?.origin && b.itinerary?.destination
          ? `${b.itinerary.origin} → ${b.itinerary.destination}`
          : b.itinerary?.hotelName
          ? b.itinerary.hotelName
          : b.itinerary?.description || "—";

      const travelDateStr = b.travelDate
        ? new Date(b.travelDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
        : "";
      const pnr = b.supplierPNR || "";

      const typeLabels: Record<string, string> = {
        FLIGHT: "Flight Cost",
        HOTEL: "Hotel Cost",
        VISA: "Visa Cost",
        SERVICE: "Service Cost",
        TRANSFER: "Transfer Cost",
        OTHER: "Service Cost",
      };
      const costLabel = typeLabels[b.type] || "Service Cost";

      const supplierCost = b.pricing?.supplierCost ?? 0;
      const markupAmount = b.pricing?.markupAmount ?? 0;
      const gstPercent = b.pricing?.gstPercent ?? 18;
      const gstMode = b.pricing?.gstMode || "ON_MARKUP";
      const diff = b.pricing?.diff
        || ((b.pricing?.quotedPrice ?? 0) - (b.pricing?.actualPrice ?? 0))
        || markupAmount
        || 0;
      let igst = 0;
      if (gstMode === "ON_MARKUP") {
        igst = parseFloat((diff * gstPercent / (100 + gstPercent)).toFixed(2));
      } else {
        igst = parseFloat(((b.pricing?.quotedPrice ?? 0) * gstPercent / 100).toFixed(2));
      }

      const costSubDesc = [
        paxStr,
        route,
        travelDateStr ? `Travel Date: ${travelDateStr}` : "",
        pnr ? `PNR: ${pnr}` : "",
      ]
        .filter(Boolean)
        .join(" || ");

      const svcSubDesc = [paxStr, route].filter(Boolean).join(" || ");

      // Row A — Cost
      invoiceLineItems.push({
        bookingRef: b.bookingRef,
        rowType: "COST",
        description: costLabel,
        subDescription: costSubDesc,
        qty: 1,
        rate: supplierCost,
        igst: 0,
        amount: supplierCost,
        passengerNames,
        travelDate: b.travelDate,
        type: b.type,
      });

      // Row B — Service Fee
      invoiceLineItems.push({
        bookingRef: b.bookingRef,
        rowType: "SERVICE_FEE",
        description: "Transaction Fees",
        subDescription: svcSubDesc,
        qty: 1,
        rate: markupAmount,
        igst,
        amount: markupAmount,
        passengerNames,
        travelDate: b.travelDate,
        type: b.type,
      });
    }

    const subtotal = invoiceLineItems.reduce((s, li) => s + (li.amount ?? 0), 0);
    const totalGST = invoiceLineItems.reduce((s, li) => s + (li.igst ?? 0), 0);
    let grandTotal = 0;
    for (const b of bookings as any[]) {
      const gstMode = b.pricing?.gstMode || "ON_MARKUP";
      if (gstMode === "ON_MARKUP") {
        grandTotal += b.pricing?.quotedPrice ?? 0;
      } else {
        grandTotal += b.pricing?.grandTotal ?? ((b.pricing?.quotedPrice ?? 0) + (b.pricing?.gstAmount ?? 0));
      }
    }
    grandTotal = parseFloat(grandTotal.toFixed(2));

    // DEBUG: confirm invoiceLineItems is still a plain array of objects here
    console.log('lineItems type:', typeof invoiceLineItems, 'isArray:', Array.isArray(invoiceLineItems));
    console.log('lineItems[0] type:', invoiceLineItems[0] ? typeof invoiceLineItems[0] : 'empty');
    console.log('lineItems sample:', JSON.stringify(invoiceLineItems[0]));

    const invoice = await Invoice.create({
      workspaceId: wsIds[0],
      billingPeriod,
      bookingIds: bookings.map((b: any) => b._id),
      subtotal: parseFloat(subtotal.toFixed(2)),
      totalGST: parseFloat(totalGST.toFixed(2)),
      grandTotal,
      supplyType,
      issuerState,
      clientState,
      issuerDetails,
      clientDetails,
      terms,
      notes,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      createdBy: req.user._id,
    });

    console.log('[After rename] invoiceLineItems type:', typeof invoiceLineItems);
    console.log('[After rename] isArray:', Array.isArray(invoiceLineItems));

    await Invoice.collection.updateOne(
      { _id: invoice._id },
      { $set: { lineItems: invoiceLineItems } },
    );

    const completeInvoice = await Invoice.collection.findOne({ _id: invoice._id });

    // Mark bookings as INVOICED and record invoice raised date
    const now = new Date();
    await ManualBooking.updateMany(
      { _id: { $in: bookings.map((b: any) => b._id) } },
      { $set: { status: "INVOICED", invoiceId: invoice._id, invoiceRaisedDate: now } },
    );

    res.status(201).json({ ok: true, invoice: completeInvoice });
  } catch (err: any) {
    console.error("[Invoices generate]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── List ─────────────────────────────────────────────────────────── */

// GET /api/admin/invoices
router.get("/", requirePermission("invoices", "READ"), async (req: any, res: any) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const filter: Record<string, any> = {};

    if (req.query.workspaceId) filter.workspaceId = req.query.workspaceId;
    if (req.query.status) filter.status = req.query.status;

    if (req.query.dateFrom || req.query.dateTo) {
      filter.generatedAt = {};
      if (req.query.dateFrom) filter.generatedAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.generatedAt.$lte = new Date(req.query.dateTo);
    }

    const [docs, total] = await Promise.all([
      Invoice.find(filter).sort({ generatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Invoice.countDocuments(filter),
    ]);

    res.json({ ok: true, docs, total, page, pages: Math.ceil(total / limit) });
  } catch (err: any) {
    console.error("[Invoices GET list]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Export ───────────────────────────────────────────────────────── */

// GET /api/admin/invoices/export
router.get("/export", requirePermission("invoices", "READ"), async (req: any, res: any) => {
  try {
    const filter: Record<string, any> = {};
    if (req.query.workspaceId) filter.workspaceId = req.query.workspaceId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.dateFrom || req.query.dateTo) {
      filter.generatedAt = {};
      if (req.query.dateFrom) filter.generatedAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.generatedAt.$lte = new Date(req.query.dateTo);
    }

    const format = req.query.format === "xlsx" ? "xlsx" : "csv";
    const docs = await Invoice.find(filter).sort({ generatedAt: -1 }).lean();

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="invoices-export.csv"');
      res.write(csvRow(INVOICE_COLUMNS));
      for (const inv of docs) res.write(csvRow(invoiceToRow(inv)));
      res.end();
      return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Invoices");

    const headerRow = sheet.addRow(INVOICE_COLUMNS);
    headerRow.font = { bold: true };

    const colWidths = [18, 15, 25, 20, 30, 20, 14, 14, 12, 14, 12, 15, 14, 14, 18, 25];
    colWidths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

    // Monetary columns: Subtotal=8, Total GST=9, Grand Total=10
    [8, 9, 10].forEach((ci) => { sheet.getColumn(ci).numFmt = "#,##0.00"; });

    for (const inv of docs) sheet.addRow(invoiceToRow(inv));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="invoices-export.xlsx"');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err: any) {
    console.error("[Invoices EXPORT]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Add Bookings to Invoice ──────────────────────────────────────── */

// POST /api/admin/invoices/:id/add-bookings
router.post("/:id/add-bookings", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const { bookingIds } = req.body as { bookingIds: string[] };

    if (!Array.isArray(bookingIds) || !bookingIds.length) {
      return res.status(400).json({ error: "bookingIds array is required" });
    }

    const invoice = await Invoice.collection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.id),
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    if (invoice.status === "PAID" || invoice.status === "CANCELLED") {
      return res.status(400).json({ error: "Cannot add bookings to a PAID or CANCELLED invoice" });
    }

    // Fetch new bookings
    const newBookings = await ManualBooking.find({
      _id: { $in: bookingIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).lean();

    if (newBookings.length !== bookingIds.length) {
      return res.status(400).json({ error: "One or more booking IDs not found" });
    }

    // All must belong to same workspaceId as invoice
    const badWs = (newBookings as any[]).filter(
      (b) => b.workspaceId?.toString() !== invoice.workspaceId?.toString(),
    );
    if (badWs.length) {
      return res.status(400).json({
        error: "All bookings must belong to the same workspace as the invoice",
      });
    }

    // None already INVOICED
    const alreadyInvoiced = (newBookings as any[]).filter((b) => b.status === "INVOICED");
    if (alreadyInvoiced.length) {
      return res.status(400).json({
        error: `${alreadyInvoiced.length} booking(s) are already invoiced`,
        refs: alreadyInvoiced.map((b: any) => b.bookingRef),
      });
    }

    // Build new line items (same two-row pattern as /generate)
    const newLineItems: any[] = [];
    for (const b of newBookings as any[]) {
      const passengerNames = (b.passengers || []).map((p: any) => p.name);
      const paxStr = passengerNames.join(", ") || "—";

      const route =
        b.itinerary?.origin && b.itinerary?.destination
          ? `${b.itinerary.origin} → ${b.itinerary.destination}`
          : b.itinerary?.hotelName
          ? b.itinerary.hotelName
          : b.itinerary?.description || "—";

      const travelDateStr = b.travelDate
        ? new Date(b.travelDate).toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })
        : "";
      const pnr = b.supplierPNR || "";

      const typeLabels: Record<string, string> = {
        FLIGHT: "Flight Cost",
        HOTEL: "Hotel Cost",
        VISA: "Visa Cost",
        SERVICE: "Service Cost",
        TRANSFER: "Transfer Cost",
        OTHER: "Service Cost",
      };
      const costLabel = typeLabels[b.type] || "Service Cost";

      const supplierCost = b.pricing?.supplierCost ?? 0;
      const markupAmount = b.pricing?.markupAmount ?? 0;
      const gstPercent = b.pricing?.gstPercent ?? 18;
      const gstMode = b.pricing?.gstMode || "ON_MARKUP";
      const diff =
        b.pricing?.diff ||
        (b.pricing?.quotedPrice ?? 0) - (b.pricing?.actualPrice ?? 0) ||
        markupAmount ||
        0;
      let igst = 0;
      if (gstMode === "ON_MARKUP") {
        igst = parseFloat(((diff * gstPercent) / (100 + gstPercent)).toFixed(2));
      } else {
        igst = parseFloat((((b.pricing?.quotedPrice ?? 0) * gstPercent) / 100).toFixed(2));
      }

      const costSubDesc = [
        paxStr,
        route,
        travelDateStr ? `Travel Date: ${travelDateStr}` : "",
        pnr ? `PNR: ${pnr}` : "",
      ]
        .filter(Boolean)
        .join(" || ");

      const svcSubDesc = [paxStr, route].filter(Boolean).join(" || ");

      newLineItems.push({
        bookingRef: b.bookingRef,
        rowType: "COST",
        description: costLabel,
        subDescription: costSubDesc,
        qty: 1,
        rate: supplierCost,
        igst: 0,
        amount: supplierCost,
        passengerNames,
        travelDate: b.travelDate,
        type: b.type,
      });

      newLineItems.push({
        bookingRef: b.bookingRef,
        rowType: "SERVICE_FEE",
        description: "Transaction Fees",
        subDescription: svcSubDesc,
        qty: 1,
        rate: markupAmount,
        igst,
        amount: markupAmount,
        passengerNames,
        travelDate: b.travelDate,
        type: b.type,
      });
    }

    // Recalculate totals
    const newSubtotal = newLineItems.reduce((s, li) => s + (li.amount ?? 0), 0);
    const newTotalGST = newLineItems.reduce((s, li) => s + (li.igst ?? 0), 0);
    let newGrandTotal = 0;
    for (const b of newBookings as any[]) {
      const gstMode = b.pricing?.gstMode || "ON_MARKUP";
      if (gstMode === "ON_MARKUP") {
        newGrandTotal += b.pricing?.quotedPrice ?? 0;
      } else {
        newGrandTotal +=
          b.pricing?.grandTotal ??
          (b.pricing?.quotedPrice ?? 0) + (b.pricing?.gstAmount ?? 0);
      }
    }

    const updatedSubtotal  = parseFloat(((invoice.subtotal  ?? 0) + newSubtotal).toFixed(2));
    const updatedTotalGST  = parseFloat(((invoice.totalGST  ?? 0) + newTotalGST).toFixed(2));
    const updatedGrandTotal = parseFloat(((invoice.grandTotal ?? 0) + newGrandTotal).toFixed(2));

    await Invoice.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(req.params.id) },
      {
        $push: { lineItems: { $each: newLineItems } },
        $addToSet: {
          bookingIds: {
            $each: bookingIds.map((id) => new mongoose.Types.ObjectId(id)),
          },
        },
        $set: {
          subtotal:   updatedSubtotal,
          totalGST:   updatedTotalGST,
          grandTotal: updatedGrandTotal,
        },
      } as any,
    );

    // Mark new bookings as INVOICED
    const now = new Date();
    await ManualBooking.updateMany(
      { _id: { $in: (newBookings as any[]).map((b) => b._id) } },
      {
        $set: {
          status: "INVOICED",
          invoiceId: new mongoose.Types.ObjectId(req.params.id),
          invoiceRaisedDate: now,
        },
      },
    );

    const updatedInvoice = await Invoice.collection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.id),
    });

    res.json({ ok: true, invoice: updatedInvoice });
  } catch (err: any) {
    console.error("[Invoices add-bookings]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Activity ─────────────────────────────────────────────────────── */

function timeAgo(date: Date): string {
  const diffMs    = Date.now() - new Date(date).getTime();
  const diffMins  = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays  = Math.floor(diffMs / 86400000);
  if (diffMins  < 60) return `${diffMins} minutes ago`;
  if (diffHours < 24) return `${diffHours} hours ago`;
  if (diffDays  === 1) return "Yesterday";
  return `${diffDays} days ago`;
}

// GET /api/admin/invoices/activity
router.get("/activity", requirePermission("invoices", "READ"), async (_req: any, res: any) => {
  try {
    const invoices = await Invoice.find({})
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean();

    const result = invoices.map((inv: any) => {
      let action: string;
      let label: string;
      if (inv.paidAt) {
        action = "paid";
        label  = `Invoice #${inv.invoiceNo} paid`;
      } else if (inv.sentAt) {
        action = "sent";
        label  = `Invoice #${inv.invoiceNo} sent`;
      } else if (inv.status === "CANCELLED") {
        action = "cancelled";
        label  = `Invoice #${inv.invoiceNo} cancelled`;
      } else {
        action = "generated";
        label  = `Invoice #${inv.invoiceNo} generated`;
      }

      return {
        invoiceId:  (inv._id as any).toString(),
        invoiceNo:  inv.invoiceNo,
        action,
        label,
        clientName: inv.clientDetails?.companyName || "",
        timeAgo:    timeAgo(inv.updatedAt as Date),
        timestamp:  inv.updatedAt,
        status:     inv.status,
      };
    });

    res.json(result);
  } catch (err: any) {
    console.error("[Invoices activity]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Insight ──────────────────────────────────────────────────────── */

// GET /api/admin/invoices/insight
router.get("/insight", requirePermission("invoices", "READ"), async (_req: any, res: any) => {
  try {
    const now            = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalThisMonth, paidThisMonth, paidWithin15, outstandingAgg] =
      await Promise.all([
        Invoice.countDocuments({
          generatedAt: { $gte: thisMonthStart },
          status: { $ne: "CANCELLED" },
        }),
        Invoice.countDocuments({
          generatedAt: { $gte: thisMonthStart },
          status: "PAID",
        }),
        Invoice.countDocuments({
          generatedAt: { $gte: thisMonthStart },
          status: "PAID",
          $expr: {
            $lte: [
              { $subtract: ["$paidAt", "$generatedAt"] },
              15 * 24 * 60 * 60 * 1000,
            ],
          },
        }),
        Invoice.aggregate([
          { $match: { status: { $in: ["DRAFT", "SENT"] } } },
          { $group: { _id: null, total: { $sum: "$grandTotal" } } },
        ]),
      ]);

    const outstandingAmount = outstandingAgg[0]?.total ?? 0;
    const clearanceRate = totalThisMonth > 0
      ? Math.round((paidThisMonth / totalThisMonth) * 100)
      : 0;
    const within15Rate = paidThisMonth > 0
      ? Math.round((paidWithin15 / paidThisMonth) * 100)
      : 0;

    let insight: string;
    if (totalThisMonth === 0) {
      insight = "No invoices generated this month yet.";
    } else if (clearanceRate === 100) {
      insight = "All invoices for this month have been cleared.";
    } else if (within15Rate > 0) {
      insight = `${within15Rate}% of invoices this month were cleared within 15 days of issuance.`;
    } else {
      insight = `${clearanceRate}% of invoices this month have been cleared. ${totalThisMonth - paidThisMonth} pending.`;
    }

    res.json({
      totalThisMonth,
      paidThisMonth,
      clearanceRate,
      within15Rate,
      insight,
      outstandingAmount,
    });
  } catch (err: any) {
    console.error("[Invoices insight]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Single ───────────────────────────────────────────────────────── */

// GET /api/admin/invoices/:id
router.get("/:id", requirePermission("invoices", "READ"), async (req: any, res: any) => {
  try {
    const invoice = await Invoice.findById(req.params.id).lean();
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    res.json({ ok: true, invoice });
  } catch (err: any) {
    console.error("[Invoices GET one]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Update Status ────────────────────────────────────────────────── */

// PUT /api/admin/invoices/:id/status
router.put("/:id/status", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const { status, paidAt } = req.body as {
      status: "SENT" | "PAID" | "CANCELLED";
      paidAt?: string;
    };

    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    invoice.status = status;
    if (status === "SENT") invoice.sentAt = new Date();
    if (status === "PAID") invoice.paidAt = paidAt ? new Date(paidAt) : new Date();

    await invoice.save();
    res.json({ ok: true, invoice });
  } catch (err: any) {
    console.error("[Invoices PUT status]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── PDF ──────────────────────────────────────────────────────── */

// POST /api/admin/invoices/:id/pdf
router.post("/:id/pdf", requirePermission("invoices", "WRITE"), async (req: any, res: any) => {
  try {
    const invoice = await Invoice.collection.findOne({
      _id: new mongoose.Types.ObjectId(req.params.id),
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const pdfBuffer = await generateInvoicePdf(invoice as any);

    const s3 = new S3Client({
      region: env.AWS_REGION,
      credentials:
        env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
          : undefined,
    });

    const key = `invoices/${invoice.invoiceNo}.pdf`;
    const bucket = env.S3_BUCKET;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: pdfBuffer,
        ContentType: "application/pdf",
      }),
    );

    const pdfUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: `inline; filename="${invoice.invoiceNo}.pdf"`,
      }),
      { expiresIn: 3600 },
    );

    await Invoice.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(req.params.id) },
      { $set: { pdfUrl } },
    );

    res.json({ ok: true, pdfUrl });
  } catch (err: any) {
    console.error("[Invoices PDF]", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
