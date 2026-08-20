// apps/backend/src/routes/consumer.invoices.ts
//
// THE CONSUMER'S OWN TAX INVOICES — /api/consumer/invoices.
//
// ══════════════════════════════════════════════════════════════════════
// OWN-SCOPE RUNS THROUGH THE APPLICATION, NOT THROUGH THE WORKSPACE.
// ══════════════════════════════════════════════════════════════════════
// Invoice.workspaceId on a D2C invoice is the HOUSE Customer._id — every
// consumer's receipt carries the same one, because that row exists purely
// so the tenant-shaped invoicing pipeline has something to group on
// (services/d2cInvoicing.ts explains why). Querying invoices by workspace
// would therefore return EVERY consumer's invoice to EVERY consumer. It is
// not a weak fence; it is an anti-fence.
//
// So the join runs the other way, always:
//
//     VisaApplication { consumerId: me, d2cInvoiceId: <id> }  ->  Invoice
//
// consumerId is the real boundary — the same rule
// routes/consumer.payments.ts states, and the same one ConsumerProfile is
// built on. An invoice id that is not reachable from one of MY
// applications does not exist as far as this router is concerned, and the
// answer is 404 with no distinction between "someone else's" and "not a
// thing" — no oracle either way.
//
// ── WHY THE PDF IS STREAMED AND NOT PRESIGNED ────────────────────────
// The B2B routes (routes/invoices.ts) render the PDF, PUT it to S3 and
// hand back a presigned URL. That is wrong for this surface for the same
// reason routes/consumer.profile.ts gives about passport scans: a
// presigned URL is a bearer credential that outlives the session and can
// be forwarded. A tax invoice names the person, the amount and the
// registration it was issued under. Ownership is re-checked on every byte
// request instead.
//
// It also happens to be the only thing that works in dev — S3_ENDPOINT
// points at a local MinIO that is usually not running — but that is a
// side benefit, not the reason.
//
// ── THE INVOICE IS SERVED FROM ITS OWN SNAPSHOT, UNENRICHED ──────────
// routes/invoices.ts runs enrichClientDetails() before rendering, which
// back-fills gaps in the stored clientDetails from the LIVE Customer row.
// That is right for B2B, where the Customer IS the buyer. Here the live
// Customer row is the house tenant, so enrichment could only ever pull
// Plumtrips' own details into a consumer's bill-to block. The frozen
// snapshot is both safer and more correct — an issued tax invoice is a
// point-in-time document, not a view over current data.
import { Router } from "express";
import mongoose from "mongoose";

import { requireConsumer } from "../middleware/requireConsumer.js";
import Invoice from "../models/Invoice.js";
import VisaApplication from "../models/VisaApplication.js";
import VisaRequest from "../models/VisaRequest.js";
import { d2cWorkspaceObjectId } from "../services/consumerWorkspace.js";
import { generateInvoicePdf } from "../utils/invoicePdf.js";
import logger from "../utils/logger.js";

const router = Router();
router.use(requireConsumer);

const invoicesLogger = logger.child({ module: "consumerInvoices" });

function me(req: any): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(String(req.consumer.id));
}

/**
 * Drop zero-amount rows from a CONSUMER-facing render.
 *
 * ── WHAT THE ZERO ROW IS ─────────────────────────────────────────────
 * A D2C visa booking has actualPrice 0 — embassy and VFS fees are zero on
 * a corridor we don't pay a post out of, and everything the consumer paid
 * is service fee + GST. utils/invoiceLineItems.ts's ON_MARKUP branch
 * always emits a COST row plus a SERVICE_FEE row, so the COST row comes
 * out as "Visa Cost … ₹0.00". Correct arithmetic, meaningless line.
 *
 * ── WHY FILTERING IS SAFE ────────────────────────────────────────────
 * The PDF's totals do NOT come from the rows. utils/invoicePdf.ts reads
 * invoice.subtotal, invoice.cgstAmount/sgstAmount/igstAmount and
 * invoice.grandTotal as stored fields (see its Sub Total / GST / Total
 * block). The line items drive the TABLE and nothing else, so removing a
 * ₹0 row changes what is displayed and cannot change what is charged.
 *
 * ── WHY IT LIVES HERE AND NOT IN invoicePdf.ts ───────────────────────
 * utils/invoicePdf.ts is shared with every B2B caller and is NOT touched
 * by this feature. Filtering at this call site is what makes
 * "consumer-only" true by construction rather than by a flag someone
 * could later pass from the wrong place.
 *
 * If EVERY row is zero the original array is returned untouched — a table
 * with no rows at all is a broken document, and that is worse than an
 * unhelpful one.
 */
export function suppressZeroAmountLines(lineItems: any[]): any[] {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return lineItems ?? [];
  const nonZero = lineItems.filter((li) => Number(li?.amount ?? 0) !== 0);
  return nonZero.length > 0 ? nonZero : lineItems;
}

/** The consumer-safe shape of one invoice. Everything the receipt needs and
 *  nothing about our tenancy: no workspaceId, no house Customer, no
 *  bookingIds, no createdBy, no seller internals beyond the two facts a tax
 *  invoice must show anyway (who issued it, under which GSTIN). */
function publicInvoice(invoice: any, application: any, referenceNumber: string | null) {
  return {
    id: String(invoice._id),
    invoiceNo: invoice.invoiceNo,
    // invoiceDate is the document's own date; d2cInvoicedAt is when we
    // raised it. Both are real and they can differ, so both are sent
    // rather than one being passed off as the other.
    invoiceDate: invoice.invoiceDate ?? null,
    invoicedAt: application?.d2cInvoicedAt ?? null,
    amountInr: invoice.grandTotal ?? null,
    currency: "INR",
    // What it is FOR — the case, so a reader can tie the document to a trip.
    applicationId: String(application._id),
    referenceNumber,
    destinationIso2: application.destinationIso2 ?? null,
    destinationName: application.ruleSnapshot?.destinationName ?? null,
    // The two issuer facts that are ON the printed invoice anyway. Sending
    // them lets the list say who issued it without a second fetch; sending
    // MORE (address, bank, series config) would be leaking our setup.
    issuedBy: invoice.issuerDetails?.companyName ?? null,
    issuerGstin: invoice.issuerDetails?.gstin ?? null,
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * GET / — every invoice raised against this consumer's own cases.
 * ───────────────────────────────────────────────────────────────────── */

router.get("/", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const workspaceId = d2cWorkspaceObjectId();

    /* d2cInvoiceId != null is the gate. A paid case whose invoice has not
     * been raised (or whose raise failed — the webhook deliberately does
     * not fail a payment over it) simply is not in this list yet, which is
     * exactly what the page's empty-state copy promises. */
    const applications: any[] = await VisaApplication.find({
      consumerId,
      workspaceId,
      d2cPaymentStatus: "PAID",
      d2cInvoiceId: { $ne: null },
    })
      .select("requestId destinationIso2 ruleSnapshot.destinationName d2cInvoiceId d2cInvoiceNo d2cInvoicedAt")
      .lean();

    if (applications.length === 0) {
      return res.json({ ok: true, invoices: [] });
    }

    const invoiceIds = applications.map((a) => a.d2cInvoiceId);
    const invoices: any[] = await Invoice.find({ _id: { $in: invoiceIds } })
      .select("invoiceNo invoiceDate grandTotal issuerDetails.companyName issuerDetails.gstin")
      .lean();
    const invoiceById = new Map(invoices.map((i) => [String(i._id), i]));

    const requestIds = applications
      .map((a) => a.requestId)
      .filter((id: any) => mongoose.isValidObjectId(id));
    const requests: any[] = requestIds.length
      ? await VisaRequest.find({ _id: { $in: requestIds } }).select("referenceNumber").lean()
      : [];
    const requestById = new Map(requests.map((r) => [String(r._id), r]));

    const rows = applications
      .map((a) => {
        const invoice = invoiceById.get(String(a.d2cInvoiceId));
        // A dangling d2cInvoiceId (invoice deleted out from under the case)
        // is dropped rather than rendered as a row with no number. Logged,
        // because it should be impossible.
        if (!invoice) {
          invoicesLogger.warn("application references an invoice that no longer exists", {
            applicationId: String(a._id),
            d2cInvoiceId: String(a.d2cInvoiceId),
          });
          return null;
        }
        const request = requestById.get(String(a.requestId)) ?? null;
        return publicInvoice(invoice, a, request?.referenceNumber ?? null);
      })
      .filter(Boolean)
      // Newest first, same as the payment history above it on the page.
      .sort((x: any, y: any) => {
        const xt = x.invoiceDate ? new Date(x.invoiceDate).getTime() : -Infinity;
        const yt = y.invoiceDate ? new Date(y.invoiceDate).getTime() : -Infinity;
        return yt - xt;
      });

    return res.json({ ok: true, invoices: rows });
  } catch (err: any) {
    invoicesLogger.error("consumer invoice list failed", { error: err?.message });
    return res.status(500).json({ error: "We couldn't load your invoices." });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /:invoiceId/pdf — the document itself.
 *
 * Rendered on the fly from the stored invoice, exactly like the B2B
 * routes do, then streamed. The ONE difference from a B2B render is the
 * zero-row suppression above, and it is applied here rather than inside
 * the shared renderer.
 * ───────────────────────────────────────────────────────────────────── */

router.get("/:invoiceId/pdf", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const { invoiceId } = req.params;

    // A malformed id is "not found", never a 400 — a different status for a
    // different shape of wrong id is an oracle, however small.
    if (!mongoose.isValidObjectId(invoiceId)) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    /* THE OWNERSHIP CLAUSE — part of the query, not a check on a loaded
     * row. An invoice belonging to another consumer, or a B2B invoice,
     * matches no application of mine and is never loaded at all. */
    const application: any = await VisaApplication.findOne({
      consumerId,
      workspaceId: d2cWorkspaceObjectId(),
      d2cPaymentStatus: "PAID",
      d2cInvoiceId: new mongoose.Types.ObjectId(invoiceId),
    })
      .select("_id d2cInvoiceId")
      .lean();

    if (!application) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    // Raw collection read, matching how routes/invoices.ts loads an invoice
    // for rendering: lineItems is a Mixed path written via the raw driver.
    const invoice: any = await Invoice.collection.findOne({
      _id: new mongoose.Types.ObjectId(invoiceId),
    });
    if (!invoice) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    /* ── THE CONSUMER RENDER ─────────────────────────────────────────
     * Three deviations from a B2B render, all expressed HERE rather than
     * in the shared renderer, and all opt-in there:
     *
     *   1. the ₹0 line is dropped (suppressZeroAmountLines, above);
     *   2. no bank-details card — Razorpay already took this money, and
     *      printing account numbers on the receipt invites a second,
     *      duplicate payment;
     *   3. it reads as settled — "AMOUNT PAID" and "STATUS / Paid" rather
     *      than "BALANCE DUE" and a due date.
     *
     * `paid: true` is a safe assertion at this call site and not a guess:
     * the list query and the ownership clause above both require
     * d2cPaymentStatus "PAID", which only routes/razorpay.webhook.ts
     * writes, and only after Razorpay confirms capture AND the amount
     * cross-check passes. An invoice that reaches this line is settled in
     * full by construction. */
    const pdfBuffer = await generateInvoicePdf(
      { ...invoice, lineItems: suppressZeroAmountLines(invoice.lineItems) } as any,
      undefined,
      { hideBankDetails: true, paid: true },
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${String(invoice.invoiceNo || "invoice").replace(/"/g, "")}.pdf"`,
    );
    // A tax invoice names the person and the amount; no shared cache holds it.
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(pdfBuffer);
  } catch (err: any) {
    invoicesLogger.error("consumer invoice pdf failed", {
      error: err?.message,
      invoiceId: req.params?.invoiceId,
    });
    return res.status(500).json({ error: "We couldn't produce your invoice." });
  }
});

export default router;
