// apps/backend/src/utils/invoicePdf.ts
import PDFDocument from "pdfkit";
import https from "https";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import type { IInvoice } from "../models/Invoice.js";
import { getCompanySettings } from "../models/CompanySettings.js";
import logger from "./logger.js";

/* ── Font paths — resolved relative to this file ───── */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const FONT_PATH      = path.join(__dirname, "..", "fonts", "NotoSans-Regular.ttf");
const FONT_BOLD_PATH = path.join(__dirname, "..", "fonts", "NotoSans-Bold.ttf");

// Fonts are bundled in src/fonts/ — just verify they exist at startup
async function ensureFonts() {
  if (!fs.existsSync(FONT_PATH)) {
    console.warn("[PDF] NotoSans-Regular.ttf not found at:", FONT_PATH);
    console.warn("[PDF] ₹ symbol will render as fallback — place font in src/fonts/");
  }
  if (!fs.existsSync(FONT_BOLD_PATH)) {
    console.warn("[PDF] NotoSans-Bold.ttf not found at:", FONT_BOLD_PATH);
  }
}

/* ── Page geometry ──────────────────────────────────── */
const PG_W = 595.28;
const PG_H = 841.89;
const M = 34.02; // 12mm in points (was 15mm / 42.52)
const CW = PG_W - 2 * M; // content width ~527
const L = M;
const R = PG_W - M;

/* ── Colours — Architect Ledger ─────────────────────── */
const C_PRIMARY   = "#131b2e";   // headings, bold labels
const C_BODY      = "#191c1e";   // body text
const C_MID       = "#505f76";   // secondary / metadata
const C_SURF_LOW  = "#f4f5f6";   // table header, bank card
const C_SURF_MID  = "#e8eaec";   // dividers, box borders
const C_EMERALD   = "#4edea3";   // grand total
const C_TINY      = "#d8dadc";   // powered-by footer

/* ── Helpers ────────────────────────────────────────── */
function fmtInr(n: number): string {
  return "₹" + n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

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

/* ── Number to Indian words ─────────────────────────── */
function numberToWords(amount: number): string {
  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen",
  ];
  const tensW = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function twoDigit(n: number): string {
    if (n === 0) return "";
    if (n < 20) return ones[n];
    const t = tensW[Math.floor(n / 10)];
    const o = ones[n % 10];
    return o ? `${t}-${o}` : t;
  }

  function threeDigit(n: number): string {
    if (n === 0) return "";
    const h = Math.floor(n / 100);
    const r = n % 100;
    let s = h > 0 ? `${ones[h]} Hundred` : "";
    if (r > 0) s += (s ? " " : "") + twoDigit(r);
    return s;
  }

  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);

  if (rupees === 0 && paise === 0) return "Indian Rupee Zero Only";

  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thou = Math.floor((rupees % 100_000) / 1_000);
  const rem = rupees % 1_000;

  if (crore > 0) parts.push(`${threeDigit(crore)} Crore`);
  if (lakh > 0) parts.push(`${twoDigit(lakh)} Lakh`);
  if (thou > 0) parts.push(`${twoDigit(thou)} Thousand`);
  if (rem > 0) parts.push(threeDigit(rem));

  let result = parts.join(" ");
  result += paise > 0 ? ` and ${twoDigit(paise)} Paise Only` : " Only";
  return `Indian Rupee ${result}`;
}

/* ── Main export ────────────────────────────────────── */
export async function generateInvoicePdf(invoice: IInvoice): Promise<Buffer> {
  await ensureFonts();

  const useNoto = fs.existsSync(FONT_PATH) && fs.existsSync(FONT_BOLD_PATH);
  const FONT_NORMAL = useNoto ? "NotoSans" : "Helvetica";
  const FONT_BOLD   = useNoto ? "NotoSans-Bold" : "Helvetica-Bold";

  console.log('[PDF] FONT_PATH exists:', fs.existsSync(FONT_PATH));
  console.log('[PDF] FONT_BOLD_PATH exists:', fs.existsSync(FONT_BOLD_PATH));
  console.log('[PDF] useNoto:', useNoto);
  console.log('[PDF] FONT_PATH:', FONT_PATH);

  // Font-aware currency formatter — use Rs. prefix when NotoSans is unavailable
  // (Helvetica cannot render the ₹ glyph; it renders as ¹ or a box)
  function fmtCur(n: number): string {
    const prefix = useNoto ? "₹" : "Rs.";
    return prefix + n.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  const dbSettings = await getCompanySettings();
  const logoBuffer = dbSettings.logoUrl ? await fetchBuffer(dbSettings.logoUrl) : null;

  console.log('[PDF] clientDetails:', JSON.stringify((invoice as any).clientDetails));
  const issuerSnap = (invoice as any).issuerDetails ?? {};
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
  const client = (invoice as any).clientDetails ?? {};
  let isIgst: boolean;
  let gstLabel2 = "SGST"; // second GST column label for split tax
  if (invoice.supplyType === "IGST" || invoice.supplyType === "EXPORT") {
    isIgst = true;
  } else if (invoice.supplyType === "CGST_SGST") {
    isIgst = false;
    gstLabel2 = "SGST";
  } else if (invoice.supplyType === "CGST_UTGST") {
    isIgst = false;
    gstLabel2 = "UTGST";
  } else {
    logger.warn(`[PDF] Unexpected supplyType: "${invoice.supplyType ?? "(undefined)"}" — defaulting to IGST`);
    isIgst = true;
  }
  const lineItems = invoice.lineItems ?? [];

  // index of last SERVICE_FEE row (for disclaimer)
  let lastSvcIdx = -1;
  for (let i = lineItems.length - 1; i >= 0; i--) {
    if ((lineItems[i] as any).rowType === "SERVICE_FEE") { lastSvcIdx = i; break; }
  }

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: M, bottom: M, left: M, right: M },
      info: { Title: `Tax Invoice ${invoice.invoiceNo}` },
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
    // IGST (5 cols): DESC 50 | QTY 6 | RATE 13 | IGST 13 | AMT 18
    // Split (6 cols): DESC 41 | QTY 5 | RATE 12 | CGST 12 | SGST 12 | AMT 18
    const COL_W = isIgst
      ? [CW * 0.50, CW * 0.06, CW * 0.13, CW * 0.13, CW * 0.18]
      : [CW * 0.41, CW * 0.05, CW * 0.12, CW * 0.12, CW * 0.12, CW * 0.18];
    const COL_X: number[] = [L];
    for (let i = 0; i < COL_W.length - 1; i++) COL_X.push(COL_X[i] + COL_W[i]);
    const HDR_H = 20;
    const HDRS = isIgst
      ? ["DESCRIPTION", "QTY", "RATE", "IGST (18%)", "AMOUNT"]
      : ["DESCRIPTION", "QTY", "RATE", "CGST (9%)", `${gstLabel2} (9%)`, "AMOUNT"];
    const ALIGNS: Array<"center" | "left" | "right"> = isIgst
      ? ["left", "center", "right", "right", "right"]
      : ["left", "center", "right", "right", "right", "right"];

    function drawTableHeader(y: number) {
      doc.rect(L, y, CW, HDR_H).fill(C_SURF_LOW);
      doc.fillColor(C_MID).fontSize(8).font(FONT_BOLD);
      for (let i = 0; i < HDRS.length; i++) {
        doc.text(HDRS[i], COL_X[i] + 4, y + 6, {
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
      // dark navy square placeholder
      doc.rect(L, y, 44, 44).fill(C_PRIMARY);
      logoBottomY = y + 50;
    }

    // "TAX INVOICE" + invoice number + invoice date below logo
    doc.fillColor(C_PRIMARY).fontSize(26).font(FONT_BOLD)
      .text("TAX INVOICE", L, logoBottomY + 6, { width: LEFT_COL_W, lineBreak: false });
    doc.fontSize(12).font(FONT_NORMAL).fillColor(C_MID)
      .text(`# ${invoice.invoiceNo}`, L, logoBottomY + 36, { width: LEFT_COL_W, lineBreak: false });
    const invoiceDateDisplay = fmtDate((invoice as any).invoiceDate || invoice.generatedAt);
    doc.fontSize(10).font(FONT_NORMAL).fillColor(C_MID)
      .text(`Date: ${invoiceDateDisplay}`, L, logoBottomY + 52, { width: LEFT_COL_W, lineBreak: false });

    const leftTitleBottomY = logoBottomY + 68;

    // Right — two stat boxes side by side
    const BOX_W = 120; // was 100 — wider to accommodate large amounts without clipping
    const BOX_H = 58;
    const BOX_GAP = 8;
    const BOX2_X = R - BOX_W;
    const BOX1_X = BOX2_X - BOX_W - BOX_GAP;
    const BOX_Y = M;

    // Box 1: BALANCE DUE
    doc.rect(BOX1_X, BOX_Y, BOX_W, BOX_H).fill(C_PRIMARY);
    doc.fillColor("#aab4c4").fontSize(9).font(FONT_NORMAL)
      .text("BALANCE DUE", BOX1_X + 8, BOX_Y + 9, { width: BOX_W - 16, lineBreak: false });
    doc.fillColor("#ffffff").fontSize(14).font(FONT_BOLD)
      .text(fmtCur(invoice.grandTotal ?? 0), BOX1_X + 8, BOX_Y + 24, { width: BOX_W - 16, lineBreak: false });

    // Box 2: DUE DATE
    doc.rect(BOX2_X, BOX_Y, BOX_W, BOX_H).fill(C_SURF_LOW);
    doc.fillColor(C_MID).fontSize(9).font(FONT_NORMAL)
      .text("DUE DATE", BOX2_X + 8, BOX_Y + 9, { width: BOX_W - 16, lineBreak: false });
    const dueDateStr = invoice.dueDate ? fmtDate(invoice.dueDate) : "On Receipt";
    doc.fillColor(C_PRIMARY).fontSize(11).font(FONT_BOLD)
      .text(dueDateStr, BOX2_X + 8, BOX_Y + 26, { width: BOX_W - 16, lineBreak: false });

    y = Math.max(leftTitleBottomY, BOX_Y + BOX_H) + 24;

    /* ═══════════════════════════════════════════════
       FROM + BILL TO — two columns
    ═══════════════════════════════════════════════ */
    const HALF = CW / 2;
    const fromBillY = y;

    // FROM (left) — ~44% of content width, scales with margins
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

    // BILL TO (right) — mirror of leftColW, starts just past center
    const rightColW = Math.floor(CW * 0.44);
    const billToX = L + Math.floor(CW / 2) + 12;
    let billY = fromBillY;

    doc.fillColor(C_MID).fontSize(8).font(FONT_NORMAL)
      .text("BILL TO", billToX, billY, { width: rightColW, lineBreak: false });
    billY += 14;

    const clientName = client.companyName || (client as any).name || (client as any).contactPerson || "";
    const clientAddress = client.billingAddress || (client as any).address || "";

    if (clientName) {
      doc.fillColor(C_PRIMARY).fontSize(12).font(FONT_BOLD)
        .text(clientName, billToX, billY, { width: rightColW });
      billY += doc.heightOfString(clientName, { width: rightColW, fontSize: 12 }) + 4;
      doc.fontSize(9).font(FONT_NORMAL).fillColor(C_MID);
      const hasStructuredClient = !!((client as any).addressLine1 || (client as any).city);
      if (hasStructuredClient) {
        if ((client as any).addressLine1) {
          doc.text((client as any).addressLine1, billToX, billY, { width: rightColW });
          billY += doc.heightOfString((client as any).addressLine1, { width: rightColW }) + 3;
        }
        if ((client as any).addressLine2) {
          doc.text((client as any).addressLine2, billToX, billY, { width: rightColW });
          billY += doc.heightOfString((client as any).addressLine2, { width: rightColW }) + 3;
        }
        const clientCityLine = [(client as any).city, (client as any).state, (client as any).pincode].filter(Boolean).join(", ");
        if (clientCityLine) {
          doc.text(clientCityLine, billToX, billY, { width: rightColW });
          billY += 13;
        }
        if ((client as any).country) {
          doc.text((client as any).country, billToX, billY, { width: rightColW });
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
        if ((client as any).state) {
          doc.text((client as any).state, billToX, billY, { width: rightColW });
          billY += 13;
        }
      }
      if ((client as any).gstin) {
        doc.text(`GSTIN: ${(client as any).gstin}`, billToX, billY, { width: rightColW });
        billY += 13;
      }
    } else {
      doc.fontSize(10).font(FONT_NORMAL).fillColor(C_MID)
        .text("Client details not available", billToX, billY, { width: rightColW });
      billY += 13;
    }

    y = Math.max(y, billY) + 20;

    // Place of Supply
    const clientState = invoice.clientState || (client as any).state || "";
    if (clientState) {
      const stateCode = STATE_CODES[clientState.toLowerCase().trim()] || "";
      const placeOfSupply = stateCode ? `${clientState} (${stateCode})` : clientState;
      doc.fontSize(8).font(FONT_NORMAL).fillColor(C_MID)
        .text(`Place Of Supply: ${placeOfSupply}`, L, y);
      y += 14;
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

    // Track booking pair index for alternating row bg
    const bookingPairIdx: number[] = [];
    let pairCount = -1;
    for (const li of lineItems) {
      if ((li as any).rowType === "COST") pairCount++;
      bookingPairIdx.push(pairCount);
    }

    for (let idx = 0; idx < lineItems.length; idx++) {
      const li = lineItems[idx] as any;

      const isLastSvc = idx === lastSvcIdx;
      const descLine1 = li.description || "";

      let descLine2 = (li.subDescription || "")
        .split(" || ").filter(p => p !== "?").join(" || ")
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
      if (isLastSvc && (invoice as any).showInclusiveTaxNote) {
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

      // Alternating row bg — every other booking pair
      // no alternating background — all rows white

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

      if (isLastSvc && (invoice as any).showInclusiveTaxNote) {
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
        // AMOUNT
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
        // AMOUNT
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
       BOTTOM SECTION — bank details left, totals right
    ═══════════════════════════════════════════════ */
    y += 20;

    // Check if bottom section fits
    const bottomH = 120;
    if (y + bottomH > PG_H - M - 60) {
      doc.addPage();
      y = M;
    }

    const BANK_W = CW * 0.40;
    const BANK_X = L;
    const BANK_CARD_H = 110;

    // Bank Details card — filled rect
    doc.rect(BANK_X, y, BANK_W, BANK_CARD_H).fill(C_SURF_LOW);
    let bankY = y + 10;
    doc.fillColor(C_PRIMARY).fontSize(11).font(FONT_BOLD)
      .text("Bank Details", BANK_X + 10, bankY, { lineBreak: false });
    bankY += 18;

    // Account Holder — full width
    const holderVal = dbSettings.bankAccountHolder || issuer.companyName || "—";
    doc.fontSize(7).font(FONT_NORMAL).fillColor(C_MID)
      .text("ACCOUNT HOLDER", BANK_X + 12, bankY, { lineBreak: false });
    doc.fontSize(9).font(FONT_BOLD).fillColor(C_BODY)
      .text(holderVal, BANK_X + 12, bankY + 10, { width: BANK_W - 24 });
    const holderLines = Math.ceil(holderVal.length / 35);
    bankY += 10 + (holderLines * 12) + 10;

    // Account Number + IFSC — two columns
    const col1X = BANK_X + 12;
    const col2X = BANK_X + (BANK_W / 2) + 4;
    const colW = (BANK_W / 2) - 16;

    doc.fontSize(7).font(FONT_NORMAL).fillColor(C_MID)
      .text("ACCOUNT NUMBER", col1X, bankY, { width: colW, lineBreak: false });
    doc.fontSize(9).font(FONT_BOLD).fillColor(C_BODY)
      .text(dbSettings.bankAccountNumber || "—", col1X, bankY + 10, { width: colW, lineBreak: false });

    doc.fontSize(7).font(FONT_NORMAL).fillColor(C_MID)
      .text("IFSC CODE", col2X, bankY, { width: colW, lineBreak: false });
    doc.fontSize(9).font(FONT_BOLD).fillColor(C_BODY)
      .text(dbSettings.bankIfsc || "—", col2X, bankY + 10, { width: colW, lineBreak: false });

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

    totRow("Sub Total", fmtCur(invoice.subtotal ?? 0));
    if (isIgst) {
      totRow("IGST (18%)", fmtCur((invoice as any).igstAmount ?? invoice.totalGST ?? 0));
    } else {
      const cgst = (invoice as any).cgstAmount ?? (invoice.totalGST ?? 0) / 2;
      const sgstOrUtgst = (invoice as any).utgstAmount > 0
        ? (invoice as any).utgstAmount
        : (invoice as any).sgstAmount ?? (invoice.totalGST ?? 0) / 2;
      totRow("CGST (9%)", fmtCur(cgst));
      totRow(`${gstLabel2} (9%)`, fmtCur(sgstOrUtgst));
    }

    // Thin rule
    doc.strokeColor(C_SURF_MID).lineWidth(0.5)
      .moveTo(TOT_X, totY).lineTo(R, totY).stroke();
    totY += 8;

    // "Total" label
    doc.fontSize(13).font(FONT_BOLD).fillColor(C_PRIMARY)
      .text("Total", TOT_X, totY, { width: TOT_LW, align: "right", lineBreak: false });
    // Grand total in deep blue — reduced from 20→16 to prevent overflow in value column
    doc.fontSize(16).font(FONT_BOLD).fillColor("#00477f")
      .text(fmtCur(invoice.grandTotal ?? 0), TOT_VX, totY - 2, { width: TOT_VW, align: "right", lineBreak: false });
    totY += 22;

    // Total in words
    const words = numberToWords(invoice.grandTotal ?? 0);
    doc.fontSize(9).font(FONT_NORMAL).fillColor(C_MID)
      .text(words, TOT_X, totY, { width: TOT_W, align: "right" });
    totY += doc.heightOfString(words, { width: TOT_W, fontSize: 9 }) + 4;

    // "Verified by Plumtrips" badge
    const badgeText = "Verified by Plumtrips";
    const badgeW = 130;
    const badgeH = 18;
    const badgeX = R - badgeW;
    const badgeY = totY + 6;
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 9).fill("#e0f0ff");

    // Filled circle + white tick (solid style, crisp at small sizes)
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

    y = Math.max(y + BANK_CARD_H, totY) + 20;

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
      .text("Thank you for your business. Please reach out for any billing inquiries.", L, y, { align: "center", width: CW });
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
