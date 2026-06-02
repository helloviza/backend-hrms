// apps/backend/src/utils/creditNotePdf.ts
//
// Credit-note PDF renderer. Mirrors the "Architect Ledger" layout of
// invoicePdf.ts (same fonts, geometry, palette and line-item table) but is
// adapted for credit notes: "CREDIT NOTE" title, an "AGAINST INVOICE" stat box,
// a reason-for-credit block, and an original-invoice reference card in place of
// the bank-details card (a credit note requests no payment).
import PDFDocument from "pdfkit";
import https from "https";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import type { ICreditNote } from "../models/CreditNote.js";
import { getCompanySettings, type ICompanySettings } from "../models/CompanySettings.js";
import { numberToWords } from "./numberToWords.js";
import logger from "./logger.js";

/* ── Font paths — resolved relative to this file ───── */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const FONT_PATH      = path.join(__dirname, "..", "fonts", "NotoSans-Regular.ttf");
const FONT_BOLD_PATH = path.join(__dirname, "..", "fonts", "NotoSans-Bold.ttf");

async function ensureFonts() {
  if (!fs.existsSync(FONT_PATH)) {
    console.warn("[CN PDF] NotoSans-Regular.ttf not found at:", FONT_PATH);
    console.warn("[CN PDF] ₹ symbol will render as fallback — place font in src/fonts/");
  }
  if (!fs.existsSync(FONT_BOLD_PATH)) {
    console.warn("[CN PDF] NotoSans-Bold.ttf not found at:", FONT_BOLD_PATH);
  }
}

/* ── Page geometry ──────────────────────────────────── */
const PG_W = 595.28;
const PG_H = 841.89;
const M = 34.02; // 12mm in points
const CW = PG_W - 2 * M; // content width ~527
const L = M;
const R = PG_W - M;

/* ── Colours — Architect Ledger ─────────────────────── */
const C_PRIMARY   = "#131b2e";   // headings, bold labels
const C_BODY      = "#191c1e";   // body text
const C_MID       = "#505f76";   // secondary / metadata
const C_SURF_LOW  = "#f4f5f6";   // table header, reference card
const C_SURF_MID  = "#e8eaec";   // dividers, box borders
const C_TINY      = "#d8dadc";   // powered-by footer

/* ── Helpers ────────────────────────────────────────── */
function fmtDate(d: Date | string | undefined): string {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

async function fetchBuffer(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchBuffer(res.headers.location).then(resolve);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}

/* ── State codes for Place of Supply ───────────────── */
const STATE_CODES: Record<string, string> = {
  "andhra pradesh": "37",
  "assam": "18",
  "bihar": "10",
  "chandigarh": "04",
  "delhi": "07",
  "goa": "30",
  "gujarat": "24",
  "haryana": "06",
  "himachal pradesh": "02",
  "jharkhand": "20",
  "karnataka": "29",
  "kerala": "32",
  "madhya pradesh": "23",
  "maharashtra": "27",
  "odisha": "21",
  "punjab": "03",
  "rajasthan": "08",
  "tamil nadu": "33",
  "telangana": "36",
  "uttar pradesh": "09",
  "uttarakhand": "05",
  "west bengal": "19",
};

/* ── Prefetched render assets ───────────────────────── */
// Company settings + logo are identical across every credit note in a batch
// (e.g. the backfill script). Fetch once and inject to avoid N round-trips.
export interface CreditNotePdfPrefetch {
  settings: ICompanySettings;
  logoBuffer: Buffer | null;
}

export async function prefetchCreditNoteAssets(): Promise<CreditNotePdfPrefetch> {
  const settings = await getCompanySettings();
  const logoBuffer = settings.logoUrl ? await fetchBuffer(settings.logoUrl) : null;
  return { settings, logoBuffer };
}

/* ── Main export ────────────────────────────────────── */
export async function generateCreditNotePdf(
  creditNote: ICreditNote,
  prefetch?: CreditNotePdfPrefetch,
): Promise<Buffer> {
  await ensureFonts();

  const useNoto = fs.existsSync(FONT_PATH) && fs.existsSync(FONT_BOLD_PATH);
  const FONT_NORMAL = useNoto ? "NotoSans" : "Helvetica";
  const FONT_BOLD   = useNoto ? "NotoSans-Bold" : "Helvetica-Bold";

  // Font-aware currency formatter — Helvetica cannot render the ₹ glyph.
  function fmtCur(n: number): string {
    const prefix = useNoto ? "₹" : "Rs.";
    return prefix + n.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  const dbSettings = prefetch?.settings ?? await getCompanySettings();
  const logoBuffer = prefetch
    ? prefetch.logoBuffer
    : (dbSettings.logoUrl ? await fetchBuffer(dbSettings.logoUrl) : null);

  const cn = creditNote as any;
  const issuerSnap = cn.issuerDetails ?? {};
  const issuer = {
    companyName:  issuerSnap.companyName  || dbSettings.companyName  || "",
    address:      issuerSnap.address      || dbSettings.address      || "",
    addressLine1: issuerSnap.addressLine1 || (dbSettings as any).addressLine1 || "",
    addressLine2: issuerSnap.addressLine2 || (dbSettings as any).addressLine2 || "",
    city:         issuerSnap.city         || (dbSettings as any).city         || "",
    country:      issuerSnap.country      || (dbSettings as any).country      || "India",
    pincode:      issuerSnap.pincode      || (dbSettings as any).pincode       || "",
    state:        issuerSnap.state        || dbSettings.supplierState || dbSettings.state || "",
    gstin:        issuerSnap.gstin        || dbSettings.gstin         || "",
    email:        issuerSnap.email        || dbSettings.email         || "",
    website:      issuerSnap.website      || dbSettings.website       || "",
  };
  const client = cn.clientDetails ?? {};

  let isIgst: boolean;
  let gstLabel2 = "SGST"; // second GST column label for split tax
  if (cn.supplyType === "IGST" || cn.supplyType === "EXPORT") {
    isIgst = true;
  } else if (cn.supplyType === "CGST_SGST") {
    isIgst = false;
    gstLabel2 = "SGST";
  } else if (cn.supplyType === "CGST_UTGST") {
    isIgst = false;
    gstLabel2 = "UTGST";
  } else {
    logger.warn(`[CN PDF] Unexpected supplyType: "${cn.supplyType ?? "(undefined)"}" — defaulting to IGST`);
    isIgst = true;
  }
  const lineItems = cn.lineItems ?? [];

  // index of last SERVICE_FEE row (for disclaimer)
  let lastSvcIdx = -1;
  for (let i = lineItems.length - 1; i >= 0; i--) {
    if ((lineItems[i] as any).rowType === "SERVICE_FEE") { lastSvcIdx = i; break; }
  }

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: M, bottom: M, left: M, right: M },
      info: { Title: `Credit Note ${cn.creditNoteNo}` },
    });

    if (useNoto) {
      doc.registerFont("NotoSans", FONT_PATH);
      doc.registerFont("NotoSans-Bold", FONT_BOLD_PATH);
    }
    doc.font(FONT_NORMAL);

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Table column widths & x positions ──
    const COL_W = isIgst
      ? [CW * 0.50, CW * 0.06, CW * 0.13, CW * 0.13, CW * 0.18]
      : [CW * 0.41, CW * 0.05, CW * 0.12, CW * 0.12, CW * 0.12, CW * 0.18];
    const COL_X: number[] = [L];
    for (let i = 0; i < COL_W.length - 1; i++) COL_X.push(COL_X[i] + COL_W[i]);
    const HDR_H = 20;
    const HDRS = isIgst
      ? ["DESCRIPTION", "QTY", "RATE", "IGST (18%)", "CREDIT"]
      : ["DESCRIPTION", "QTY", "RATE", "CGST (9%)", `${gstLabel2} (9%)`, "CREDIT"];
    const ALIGNS: Array<"center" | "left" | "right"> = isIgst
      ? ["left", "center", "right", "right", "right"]
      : ["left", "center", "right", "right", "right", "right"];

    function drawTableHeader(yPos: number) {
      doc.rect(L, yPos, CW, HDR_H).fill(C_SURF_LOW);
      doc.fillColor(C_MID).fontSize(8).font(FONT_BOLD);
      for (let i = 0; i < HDRS.length; i++) {
        doc.text(HDRS[i], COL_X[i] + 4, yPos + 6, {
          width: COL_W[i] - 8,
          align: ALIGNS[i],
          lineBreak: false,
        });
      }
    }

    let y = M;

    /* ═══════════════════════════════════════════════
       HEADER — logo+title left, two stat boxes right
    ═══════════════════════════════════════════════ */
    const LEFT_COL_W = CW * 0.52;

    // Logo
    let logoBottomY = y;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, L, y, { fit: [160, 60] });
        logoBottomY = y + 68;
      } catch {
        logoBottomY = y;
      }
    } else {
      doc.rect(L, y, 44, 44).fill(C_PRIMARY);
      logoBottomY = y + 50;
    }

    // "CREDIT NOTE" + number + date below logo
    doc.fillColor(C_PRIMARY).fontSize(26).font(FONT_BOLD)
      .text("CREDIT NOTE", L, logoBottomY + 6, { width: LEFT_COL_W, lineBreak: false });
    doc.fontSize(12).font(FONT_NORMAL).fillColor(C_MID)
      .text(`# ${cn.creditNoteNo}`, L, logoBottomY + 36, { width: LEFT_COL_W, lineBreak: false });
    const cnDateDisplay = fmtDate(cn.creditNoteDate || cn.generatedAt);
    doc.fontSize(10).font(FONT_NORMAL).fillColor(C_MID)
      .text(`Date: ${cnDateDisplay}`, L, logoBottomY + 52, { width: LEFT_COL_W, lineBreak: false });

    const leftTitleBottomY = logoBottomY + 68;

    // Right — two stat boxes side by side
    const BOX_W = 120;
    const BOX_H = 58;
    const BOX_GAP = 8;
    const BOX2_X = R - BOX_W;
    const BOX1_X = BOX2_X - BOX_W - BOX_GAP;
    const BOX_Y = M;

    // Box 1: TOTAL CREDIT
    doc.rect(BOX1_X, BOX_Y, BOX_W, BOX_H).fill(C_PRIMARY);
    doc.fillColor("#aab4c4").fontSize(9).font(FONT_NORMAL)
      .text("TOTAL CREDIT", BOX1_X + 8, BOX_Y + 9, { width: BOX_W - 16, lineBreak: false });
    doc.fillColor("#ffffff").fontSize(14).font(FONT_BOLD)
      .text(fmtCur(cn.grandTotal ?? 0), BOX1_X + 8, BOX_Y + 24, { width: BOX_W - 16, lineBreak: false });

    // Box 2: AGAINST INVOICE
    doc.rect(BOX2_X, BOX_Y, BOX_W, BOX_H).fill(C_SURF_LOW);
    doc.fillColor(C_MID).fontSize(9).font(FONT_NORMAL)
      .text("AGAINST INVOICE", BOX2_X + 8, BOX_Y + 9, { width: BOX_W - 16, lineBreak: false });
    doc.fillColor(C_PRIMARY).fontSize(11).font(FONT_BOLD)
      .text(cn.originalInvoiceNo || "—", BOX2_X + 8, BOX_Y + 23, { width: BOX_W - 16, lineBreak: false });
    if (cn.originalInvoiceDate) {
      doc.fillColor(C_MID).fontSize(8).font(FONT_NORMAL)
        .text(fmtDate(cn.originalInvoiceDate), BOX2_X + 8, BOX_Y + 40, { width: BOX_W - 16, lineBreak: false });
    }

    y = Math.max(leftTitleBottomY, BOX_Y + BOX_H) + 24;

    /* ═══════════════════════════════════════════════
       FROM + BILL TO — two columns
    ═══════════════════════════════════════════════ */
    const fromBillY = y;

    // FROM (left)
    const leftColW = Math.floor(CW * 0.44);
    doc.fillColor(C_MID).fontSize(8).font(FONT_NORMAL)
      .text("FROM", L, y, { width: leftColW, lineBreak: false });
    y += 14;
    doc.fillColor(C_PRIMARY).fontSize(12).font(FONT_BOLD)
      .text(issuer.companyName || "—", L, y, { width: leftColW });
    y += doc.heightOfString(issuer.companyName || "—", { width: leftColW, fontSize: 12 }) + 4;
    doc.fontSize(9).font(FONT_NORMAL).fillColor(C_MID);
    const hasStructuredIssuer = !!(issuer.addressLine1 || issuer.city);
    if (hasStructuredIssuer) {
      if (issuer.addressLine1) {
        doc.text(issuer.addressLine1, L, y, { width: leftColW });
        y += doc.heightOfString(issuer.addressLine1, { width: leftColW }) + 3;
      }
      if (issuer.addressLine2) {
        doc.text(issuer.addressLine2, L, y, { width: leftColW });
        y += doc.heightOfString(issuer.addressLine2, { width: leftColW }) + 3;
      }
      const issuerCityLine = [issuer.city, issuer.state, issuer.pincode].filter(Boolean).join(", ");
      if (issuerCityLine) {
        doc.text(issuerCityLine, L, y, { width: leftColW });
        y += 13;
      }
      if (issuer.country) {
        doc.text(issuer.country, L, y, { width: leftColW });
        y += 13;
      }
    } else {
      doc.fontSize(10);
      if (issuer.address) {
        doc.text(issuer.address, L, y, { width: leftColW });
        y += doc.heightOfString(issuer.address, { width: leftColW }) + 4;
      }
      if (issuer.state) {
        doc.fontSize(9).text(issuer.state, L, y, { width: leftColW });
        y += 13;
      }
    }
    doc.fontSize(9).font(FONT_NORMAL).fillColor(C_MID);
    if (issuer.gstin) {
      doc.text(`GSTIN: ${issuer.gstin}`, L, y, { width: leftColW });
      y += 13;
    }
    if (issuer.email) {
      doc.text(issuer.email, L, y, { width: leftColW });
      y += doc.heightOfString(issuer.email, { width: leftColW }) + 2;
    }
    if (issuer.website) {
      doc.text(issuer.website, L, y, { width: leftColW });
      y += doc.heightOfString(issuer.website, { width: leftColW }) + 2;
    }

    // BILL TO (right)
    const rightColW = Math.floor(CW * 0.44);
    const billToX = L + Math.floor(CW / 2) + 12;
    let billY = fromBillY;

    doc.fillColor(C_MID).fontSize(8).font(FONT_NORMAL)
      .text("BILL TO", billToX, billY, { width: rightColW, lineBreak: false });
    billY += 14;

    const clientName = client.companyName || client.name || client.contactPerson || "";
    const clientAddress = client.billingAddress || client.address || "";

    if (clientName) {
      doc.fillColor(C_PRIMARY).fontSize(12).font(FONT_BOLD)
        .text(clientName, billToX, billY, { width: rightColW });
      billY += doc.heightOfString(clientName, { width: rightColW, fontSize: 12 }) + 4;
      doc.fontSize(9).font(FONT_NORMAL).fillColor(C_MID);
      const hasStructuredClient = !!(client.addressLine1 || client.city);
      if (hasStructuredClient) {
        if (client.addressLine1) {
          doc.text(client.addressLine1, billToX, billY, { width: rightColW });
          billY += doc.heightOfString(client.addressLine1, { width: rightColW }) + 3;
        }
        if (client.addressLine2) {
          doc.text(client.addressLine2, billToX, billY, { width: rightColW });
          billY += doc.heightOfString(client.addressLine2, { width: rightColW }) + 3;
        }
        const clientCityLine = [client.city, client.state, client.pincode].filter(Boolean).join(", ");
        if (clientCityLine) {
          doc.text(clientCityLine, billToX, billY, { width: rightColW });
          billY += 13;
        }
        if (client.country) {
          doc.text(client.country, billToX, billY, { width: rightColW });
          billY += 13;
        }
      } else {
        if (clientAddress) {
          const addressText = clientAddress
            .replace(/\n+/g, ", ")
            .replace(/,\s*,/g, ",")
            .replace(/\s+/g, " ")
            .trim();
          doc.text(addressText, billToX, billY, { width: rightColW });
          billY += doc.heightOfString(addressText, { width: rightColW, fontSize: 9 }) + 4;
        }
        if (client.state) {
          doc.text(client.state, billToX, billY, { width: rightColW });
          billY += 13;
        }
      }
      if (client.gstin) {
        doc.text(`GSTIN: ${client.gstin}`, billToX, billY, { width: rightColW });
        billY += 13;
      }
    } else {
      doc.fontSize(10).font(FONT_NORMAL).fillColor(C_MID)
        .text("Client details not available", billToX, billY, { width: rightColW });
      billY += 13;
    }

    y = Math.max(y, billY) + 20;

    // Place of Supply
    const clientState = cn.clientState || client.state || "";
    if (clientState) {
      const stateCode = STATE_CODES[clientState.toLowerCase().trim()] || "";
      const placeOfSupply = stateCode ? `${clientState} (${stateCode})` : clientState;
      doc.fontSize(8).font(FONT_NORMAL).fillColor(C_MID)
        .text(`Place Of Supply: ${placeOfSupply}`, L, y);
      y += 14;
    }

    /* ═══════════════════════════════════════════════
       REASON FOR CREDIT
    ═══════════════════════════════════════════════ */
    {
      const reasonText = cn.reasonText || "";
      const gstReasonLine = cn.gstReasonCode
        ? `GST Reason ${cn.gstReasonCode}${cn.gstReasonText ? ` — ${cn.gstReasonText}` : ""}`
        : "";
      if (reasonText || gstReasonLine || cn.reasonNote) {
        doc.fontSize(8).font(FONT_BOLD).fillColor(C_MID)
          .text("REASON FOR CREDIT", L, y, { width: CW, lineBreak: false });
        y += 12;
        if (reasonText) {
          doc.fontSize(9).font(FONT_NORMAL).fillColor(C_BODY)
            .text(reasonText, L, y, { width: CW });
          y += doc.heightOfString(reasonText, { width: CW, fontSize: 9 }) + 2;
        }
        if (gstReasonLine) {
          doc.fontSize(8).font(FONT_NORMAL).fillColor(C_MID)
            .text(gstReasonLine, L, y, { width: CW });
          y += doc.heightOfString(gstReasonLine, { width: CW, fontSize: 8 }) + 2;
        }
        if (cn.reasonNote) {
          doc.fontSize(8).font(FONT_NORMAL).fillColor(C_MID)
            .text(cn.reasonNote, L, y, { width: CW });
          y += doc.heightOfString(cn.reasonNote, { width: CW, fontSize: 8 }) + 2;
        }
        y += 6;
      }
    }

    /* ═══════════════════════════════════════════════
       LINE ITEMS TABLE
    ═══════════════════════════════════════════════ */
    y += 8;
    drawTableHeader(y);
    y += HDR_H;

    const DISCLAIMER =
      "All quoted prices are fully inclusive of applicable taxes and transaction fees; " +
      "no additional charges shall be levied on the end user.";

    for (let idx = 0; idx < lineItems.length; idx++) {
      const li = lineItems[idx] as any;

      const isLastSvc = idx === lastSvcIdx;
      const descLine1 = li.description || "";

      let descLine2 = (li.subDescription || "")
        .split(" || ").filter((p: string) => p !== "?").join(" || ")
        .replace(/→/g, "->");
      if (!useNoto) {
        descLine2 = descLine2
          .replace(/—/g, "-")
          .replace(/₹/g, "Rs.")
          .replace(/[^\x00-\x7F]/g, "?");
      }

      // Estimate row height
      const descFontSize = 9;
      const subFontSize = 8;
      const discFontSize = 7.5;
      const padV = 12;

      let estH = padV;
      doc.font(FONT_BOLD).fontSize(descFontSize);
      estH += doc.heightOfString(descLine1, { width: COL_W[0] - 8 });
      if (descLine2) {
        doc.font(FONT_NORMAL).fontSize(subFontSize);
        estH += 3 + doc.heightOfString(descLine2, { width: COL_W[0] - 8 });
      }
      if (isLastSvc && cn.showInclusiveTaxNote) {
        doc.font(FONT_NORMAL).fontSize(discFontSize);
        estH += 3 + doc.heightOfString(DISCLAIMER, { width: COL_W[0] - 8 });
      }
      estH = Math.max(estH, 24);

      // Page break
      if (y + estH > PG_H - M - 150) {
        doc.addPage();
        y = M;
        drawTableHeader(y);
        y += HDR_H;
      }

      // Description
      let dY = y + 6;
      const descX = COL_X[0] + 4;
      const descW = COL_W[0] - 8;

      doc.fontSize(descFontSize).font(FONT_BOLD).fillColor(C_BODY)
        .text(descLine1, descX, dY, { width: descW });
      dY += doc.heightOfString(descLine1, { width: descW, fontSize: descFontSize }) + 3;

      if (descLine2) {
        doc.fontSize(subFontSize).font(FONT_NORMAL).fillColor(C_MID)
          .text(descLine2, descX, dY, { width: descW });
        dY += doc.heightOfString(descLine2, { width: descW, fontSize: subFontSize }) + 3;
      }

      if (isLastSvc && cn.showInclusiveTaxNote) {
        doc.fontSize(discFontSize).font(FONT_NORMAL).fillColor(C_MID)
          .text(DISCLAIMER, descX, dY, { width: descW });
      }

      // QTY
      doc.fontSize(9).font(FONT_NORMAL).fillColor(C_BODY)
        .text(String(li.qty ?? 1), COL_X[1] + 1, y + 7, {
          width: COL_W[1] - 2,
          align: "center",
          lineBreak: false,
        });

      // RATE
      doc.text(fmtCur(li.rate ?? 0), COL_X[2] + 2, y + 7, {
        width: COL_W[2] - 4,
        align: "right",
        lineBreak: false,
      });

      if (isIgst) {
        // IGST
        const igstVal = li.igst ?? 0;
        doc.fillColor(igstVal > 0 ? C_BODY : C_MID)
          .text(igstVal > 0 ? fmtCur(igstVal) : "—", COL_X[3] + 2, y + 7, {
            width: COL_W[3] - 4,
            align: "right",
            lineBreak: false,
          });
        // CREDIT amount
        doc.fillColor(C_BODY)
          .text(fmtCur(li.amount ?? 0), COL_X[4] + 2, y + 7, {
            width: COL_W[4] - 4,
            align: "right",
            lineBreak: false,
          });
      } else {
        // CGST + SGST (each = igst / 2)
        const halfGst = (li.igst ?? 0) / 2;
        doc.fillColor(halfGst > 0 ? C_BODY : C_MID)
          .text(halfGst > 0 ? fmtCur(halfGst) : "—", COL_X[3] + 2, y + 7, {
            width: COL_W[3] - 4,
            align: "right",
            lineBreak: false,
          });
        doc.fillColor(halfGst > 0 ? C_BODY : C_MID)
          .text(halfGst > 0 ? fmtCur(halfGst) : "—", COL_X[4] + 2, y + 7, {
            width: COL_W[4] - 4,
            align: "right",
            lineBreak: false,
          });
        // CREDIT amount
        doc.fillColor(C_BODY)
          .text(fmtCur(li.amount ?? 0), COL_X[5] + 2, y + 7, {
            width: COL_W[5] - 4,
            align: "right",
            lineBreak: false,
          });
      }

      y += estH;
    }

    /* ═══════════════════════════════════════════════
       BOTTOM SECTION — original-invoice reference left, totals right
    ═══════════════════════════════════════════════ */
    y += 20;

    const bottomH = 120;
    if (y + bottomH > PG_H - M - 60) {
      doc.addPage();
      y = M;
    }

    const REF_W = CW * 0.40;
    const REF_X = L;
    const REF_CARD_H = 110;

    // Reference card — filled rect
    doc.rect(REF_X, y, REF_W, REF_CARD_H).fill(C_SURF_LOW);
    let refY = y + 10;
    doc.fillColor(C_PRIMARY).fontSize(11).font(FONT_BOLD)
      .text("Original Invoice", REF_X + 10, refY, { lineBreak: false });
    refY += 20;

    function refRow(label: string, value: string) {
      doc.fontSize(7).font(FONT_NORMAL).fillColor(C_MID)
        .text(label, REF_X + 12, refY, { width: REF_W - 24, lineBreak: false });
      doc.fontSize(9).font(FONT_BOLD).fillColor(C_BODY)
        .text(value, REF_X + 12, refY + 10, { width: REF_W - 24, lineBreak: false });
      refY += 28;
    }

    refRow("INVOICE NUMBER", cn.originalInvoiceNo || "—");
    refRow("INVOICE DATE", cn.originalInvoiceDate ? fmtDate(cn.originalInvoiceDate) : "—");
    refRow("INVOICE AMOUNT", fmtCur(cn.originalInvoiceAmount ?? 0));

    // Totals block — right column
    const TOT_W = CW * 0.55;
    const TOT_X = R - TOT_W;
    const TOT_LW = TOT_W * 0.55;
    const TOT_VX = TOT_X + TOT_LW;
    const TOT_VW = TOT_W - TOT_LW;
    let totY = y;

    function totRow(label: string, value: string, bold = false, sz = 10) {
      doc.fontSize(sz)
        .font(bold ? FONT_BOLD : FONT_NORMAL)
        .fillColor(C_MID)
        .text(label, TOT_X, totY, { width: TOT_LW, align: "right", lineBreak: false });
      doc.font(bold ? FONT_BOLD : FONT_NORMAL)
        .fillColor(C_BODY)
        .text(value, TOT_VX, totY, { width: TOT_VW, align: "right", lineBreak: false });
      totY += sz + 7;
    }

    totRow("Sub Total", fmtCur(cn.subtotal ?? 0));
    if (isIgst) {
      totRow("IGST (18%)", fmtCur(cn.igstAmount ?? cn.totalGST ?? 0));
    } else {
      const cgst = cn.cgstAmount ?? (cn.totalGST ?? 0) / 2;
      const sgstOrUtgst = cn.utgstAmount > 0
        ? cn.utgstAmount
        : cn.sgstAmount ?? (cn.totalGST ?? 0) / 2;
      totRow("CGST (9%)", fmtCur(cgst));
      totRow(`${gstLabel2} (9%)`, fmtCur(sgstOrUtgst));
    }

    // Thin rule
    doc.strokeColor(C_SURF_MID).lineWidth(0.5)
      .moveTo(TOT_X, totY).lineTo(R, totY).stroke();
    totY += 8;

    // "Total Credit" label + value
    doc.fontSize(13).font(FONT_BOLD).fillColor(C_PRIMARY)
      .text("Total Credit", TOT_X, totY, { width: TOT_LW, align: "right", lineBreak: false });
    doc.fontSize(16).font(FONT_BOLD).fillColor("#00477f")
      .text(fmtCur(cn.grandTotal ?? 0), TOT_VX, totY - 2, { width: TOT_VW, align: "right", lineBreak: false });
    totY += 22;

    // Total in words
    const words = numberToWords(cn.grandTotal ?? 0);
    doc.fontSize(9).font(FONT_NORMAL).fillColor(C_MID)
      .text(words, TOT_X, totY, { width: TOT_W, align: "right" });
    totY += doc.heightOfString(words, { width: TOT_W, fontSize: 9 }) + 4;

    // "Verified by Plumtrips" badge
    const badgeW = 130;
    const badgeH = 18;
    const badgeX = R - badgeW;
    const badgeY = totY + 6;
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 9).fill("#e0f0ff");

    const circleX = badgeX + 14;
    const circleY = badgeY + 9;
    const circleR = 5;
    doc.save();
    doc.circle(circleX, circleY, circleR).fill("#00477f");
    doc.strokeColor("#ffffff").lineWidth(1.2).lineCap("round").lineJoin("round")
      .moveTo(circleX - 2.5, circleY)
      .lineTo(circleX - 0.5, circleY + 2)
      .lineTo(circleX + 3,   circleY - 2.5)
      .stroke();
    doc.restore();

    doc.fontSize(8).font(FONT_BOLD).fillColor("#00477f")
      .text("Verified by Plumtrips", badgeX + 24, badgeY + 5, { width: badgeW - 28, align: "left", lineBreak: false });
    doc.fillColor(C_BODY).strokeColor("#000000");
    totY = badgeY + badgeH;

    y = Math.max(y + REF_CARD_H, totY) + 20;

    /* ═══════════════════════════════════════════════
       FOOTER
    ═══════════════════════════════════════════════ */
    const footerH = 40;
    if (y + footerH > PG_H - M) {
      doc.addPage();
      y = M;
    }

    doc.strokeColor(C_SURF_MID).lineWidth(0.5).moveTo(L, y).lineTo(R, y).stroke();
    y += 10;

    doc.fontSize(9).font(FONT_NORMAL).fillColor(C_MID)
      .text("This credit note adjusts the referenced invoice. Please reach out for any billing inquiries.", L, y, { align: "center", width: CW });
    y += 14;

    const footerY = y;
    doc.fontSize(7).font(FONT_NORMAL).fillColor(C_TINY)
      .text("POWERED BY  Plumbox", L, footerY, { align: "center", width: CW, lineBreak: false });

    const FOOTER_LOGO_PATH = path.join(__dirname, "..", "assets", "logo.png");
    if (fs.existsSync(FOOTER_LOGO_PATH)) {
      try {
        const logoTextW = doc.widthOfString("POWERED BY  Plumbox");
        const logoStartX = L + CW / 2 + logoTextW / 2 + 4;
        doc.image(FOOTER_LOGO_PATH, logoStartX, footerY - 1, { height: 8, fit: [32, 8] });
      } catch { /* logo draw failed — skip */ }
    }

    doc.end();
  });
}
