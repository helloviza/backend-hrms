// apps/backend/src/utils/reportPdf.ts
// Uses PDFKit — same as invoicePdf.ts
import PDFDocument from "pdfkit";
import type { ReportSummary } from "../routes/reports.js";

/* ── Page geometry (A4 landscape) ──────────────────────────────── */
const PG_W = 841.89;
const PG_H = 595.28;
const M = 40;
const CW = PG_W - 2 * M;
const L = M;
const R = PG_W - M;

/* ── Colours ────────────────────────────────────────────────────── */
const C_NAVY = "#0F172A";
const C_PLUM = "#7C3AED";
const C_BLACK = "#000000";
const C_MID = "#475569";
const C_LIGHT = "#94A3B8";
const C_BORDER = "#E2E8F0";
const C_WHITE = "#FFFFFF";
const C_BG = "#F8FAFC";

/* ── Helpers ────────────────────────────────────────────────────── */

function fmtInr(n: number): string {
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function fmtNum(n: number, dec = 1): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: dec, minimumFractionDigits: dec });
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = new Date(d as string);
  if (isNaN(dt.getTime())) return "—";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

function truncStr(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export async function generateReportPdf(
  reportData: ReportSummary,
  dateLabel: string,
  _filters: { workspaceId?: string; type?: string },
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: [PG_W, PG_H], // A4 landscape
      margins: { top: M, bottom: M, left: M, right: M },
      info: { Title: `Plumtrips Booking Report — ${dateLabel}` },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

    /* ── Page header helper ─────────────────────────────────────── */
    function pageHeader(title: string) {
      doc.rect(L, M, CW, 32).fill(C_NAVY);
      doc.fillColor(C_WHITE).font("Helvetica-Bold").fontSize(14)
        .text("Plumtrips Booking Report", L + 12, M + 9, { lineBreak: false });
      doc.fillColor("#94A3B8").font("Helvetica").fontSize(9)
        .text(dateLabel, L + 12, M + 22, { lineBreak: false });
      doc.fillColor("#94A3B8").font("Helvetica").fontSize(9)
        .text(title, R - 200, M + 9, { width: 195, align: "right", lineBreak: false });
    }

    /* ── Page footer helper ─────────────────────────────────────── */
    function pageFooter(pageNum: number) {
      const fy = M + PG_H - M - 12;
      doc.fillColor(C_LIGHT).font("Helvetica").fontSize(7)
        .text(`Plumtrips HRMS · Generated ${today}`, L, fy, { lineBreak: false })
        .text(`Page ${pageNum}`, R - 50, fy, { width: 50, align: "right", lineBreak: false });
      doc.strokeColor(C_BORDER).lineWidth(0.5)
        .moveTo(L, fy - 6).lineTo(R, fy - 6).stroke();
    }

    /* ── Table helpers ──────────────────────────────────────────── */
    function drawTableRow(
      y: number,
      cols: Array<{ x: number; w: number; text: string; align?: "left" | "right" | "center" }>,
      bg: string,
      textColor: string,
      fontSize: number,
      bold = false,
    ) {
      doc.rect(L, y, CW, 16).fill(bg);
      doc.fillColor(textColor).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
      for (const c of cols) {
        doc.text(c.text, c.x + 3, y + 4, { width: c.w - 6, align: c.align || "left", lineBreak: false });
      }
    }

    /* ══════════════════════════════════════════════════════════════
       PAGE 1 — OVERVIEW
    ══════════════════════════════════════════════════════════════ */
    pageHeader("Overview");

    const ov = reportData.overview;
    let y = M + 44;

    // KPI boxes — 6 in a row
    const kpiData = [
      { label: "Total Bookings", value: String(ov.totalBookings) },
      { label: "Total Quoted", value: fmtInr(ov.totalQuoted) },
      { label: "Total Profit", value: fmtInr(ov.totalBaseProfit) },
      { label: "Avg Margin %", value: `${fmtNum(ov.avgMarginPercent)}%` },
      { label: "Invoiced", value: String(ov.invoicedCount) },
      { label: "Pending / WIP", value: String(ov.pendingCount + ov.wipCount) },
    ];
    const kpiW = CW / 6;
    kpiData.forEach((k, i) => {
      const kx = L + i * kpiW;
      doc.rect(kx + 2, y, kpiW - 4, 52).fill(C_BG);
      doc.rect(kx + 2, y, kpiW - 4, 52).stroke(C_BORDER);
      doc.fillColor(C_NAVY).font("Helvetica-Bold").fontSize(16)
        .text(k.value, kx + 4, y + 10, { width: kpiW - 8, align: "center", lineBreak: false });
      doc.fillColor(C_LIGHT).font("Helvetica").fontSize(8)
        .text(k.label, kx + 4, y + 32, { width: kpiW - 8, align: "center", lineBreak: false });
    });
    y += 66;

    // Status breakdown bar
    const total = ov.totalBookings || 1;
    const statuses = [
      { label: "Pending", count: ov.pendingCount, color: "#94A3B8" },
      { label: "WIP", count: ov.wipCount, color: "#F59E0B" },
      { label: "Confirmed", count: ov.confirmedCount, color: "#3B82F6" },
      { label: "Invoiced", count: ov.invoicedCount, color: "#10B981" },
      { label: "Cancelled", count: ov.cancelledCount, color: "#F43F5E" },
    ];

    doc.fillColor(C_MID).font("Helvetica-Bold").fontSize(9)
      .text("Status Breakdown", L, y);
    y += 12;

    let bx = L;
    for (const s of statuses) {
      const bw = (s.count / total) * CW;
      if (bw > 0) {
        doc.rect(bx, y, bw, 12).fill(s.color);
        bx += bw;
      }
    }
    y += 20;

    // Status legend
    let lx = L;
    for (const s of statuses) {
      doc.rect(lx, y, 8, 8).fill(s.color);
      doc.fillColor(C_MID).font("Helvetica").fontSize(7)
        .text(`${s.label} (${s.count})`, lx + 11, y + 1, { lineBreak: false });
      lx += 95;
    }
    y += 20;

    pageFooter(1);

    /* ══════════════════════════════════════════════════════════════
       PAGE 2 — BY CLIENT
    ══════════════════════════════════════════════════════════════ */
    doc.addPage();
    pageHeader("Revenue by Client");
    y = M + 44;

    const clientCols = [
      { x: L, w: 180, label: "Client", align: "left" as const },
      { x: L + 180, w: 55, label: "Bookings", align: "right" as const },
      { x: L + 235, w: 100, label: "Total Quoted", align: "right" as const },
      { x: L + 335, w: 100, label: "Total Profit", align: "right" as const },
      { x: L + 435, w: 75, label: "Margin %", align: "right" as const },
      { x: L + 510, w: 100, label: "Invoiced", align: "right" as const },
      { x: L + 610, w: 151, label: "Pending", align: "right" as const },
    ];

    drawTableRow(y, clientCols.map((c) => ({ ...c, text: c.label })), C_NAVY, C_WHITE, 8, true);
    y += 16;

    for (let i = 0; i < reportData.byClient.length; i++) {
      const r = reportData.byClient[i];
      const bg = i % 2 === 0 ? C_WHITE : C_BG;
      drawTableRow(
        y,
        [
          { x: L, w: 180, text: truncStr(r.clientName, 28), align: "left" },
          { x: L + 180, w: 55, text: String(r.bookings), align: "right" },
          { x: L + 235, w: 100, text: fmtInr(r.totalQuoted), align: "right" },
          { x: L + 335, w: 100, text: fmtInr(r.totalBaseProfit), align: "right" },
          { x: L + 435, w: 75, text: `${fmtNum(r.avgMargin)}%`, align: "right" },
          { x: L + 510, w: 100, text: fmtInr(r.invoicedAmount), align: "right" },
          { x: L + 610, w: 151, text: fmtInr(r.pendingAmount), align: "right" },
        ],
        bg,
        C_BLACK,
        8,
      );
      y += 16;

      if (y > PG_H - M - 30) {
        pageFooter(2);
        doc.addPage();
        pageHeader("Revenue by Client (cont.)");
        y = M + 44;
        drawTableRow(y, clientCols.map((c) => ({ ...c, text: c.label })), C_NAVY, C_WHITE, 8, true);
        y += 16;
      }
    }

    pageFooter(2);

    /* ══════════════════════════════════════════════════════════════
       PAGE 3 — BY TYPE + BY PARTNER
    ══════════════════════════════════════════════════════════════ */
    doc.addPage();
    pageHeader("By Type & Partner");
    y = M + 44;

    // By Type (left half)
    const halfW = CW / 2 - 10;
    doc.fillColor(C_MID).font("Helvetica-Bold").fontSize(9)
      .text("By Booking Type", L, y);
    y += 12;

    const typeCols = [
      { x: L, w: 70 },
      { x: L + 70, w: 40 },
      { x: L + 110, w: 90 },
      { x: L + 200, w: 90 },
      { x: L + 290, w: halfW - 290 },
    ];
    const typeHdrs = ["Type", "Count", "Quoted", "Profit", "Margin%"];
    drawTableRow(y, typeCols.map((c, i) => ({ ...c, text: typeHdrs[i], align: i > 1 ? ("right" as const) : ("left" as const) })), C_NAVY, C_WHITE, 8, true);
    y += 16;

    for (let i = 0; i < reportData.byType.length; i++) {
      const r = reportData.byType[i];
      const bg = i % 2 === 0 ? C_WHITE : C_BG;
      drawTableRow(
        y,
        [
          { x: L, w: 70, text: r.type, align: "left" },
          { x: L + 70, w: 40, text: String(r.count), align: "right" },
          { x: L + 110, w: 90, text: fmtInr(r.totalQuoted), align: "right" },
          { x: L + 200, w: 90, text: fmtInr(r.totalBaseProfit), align: "right" },
          { x: L + 290, w: halfW - 290, text: `${fmtNum(r.avgMargin)}%`, align: "right" },
        ],
        bg, C_BLACK, 8,
      );
      y += 16;
    }

    // By Partner (right half)
    const px = L + halfW + 20;
    let py = M + 44 + 12;
    doc.fillColor(C_MID).font("Helvetica-Bold").fontSize(9)
      .text("By Partner / Supplier", px, M + 44);

    const partCols = [
      { x: px, w: 140 },
      { x: px + 140, w: 40 },
      { x: px + 180, w: 90 },
      { x: px + 270, w: halfW - 270 - 20 },
    ];
    const partHdrs = ["Partner", "Bkgs", "Quoted", "Profit"];
    drawTableRow(py, partCols.map((c, i) => ({ ...c, text: partHdrs[i], align: i > 1 ? ("right" as const) : ("left" as const) })), C_NAVY, C_WHITE, 8, true);
    py += 16;

    for (let i = 0; i < reportData.byPartner.length; i++) {
      const r = reportData.byPartner[i];
      const bg = i % 2 === 0 ? C_WHITE : C_BG;
      drawTableRow(
        py,
        [
          { x: px, w: 140, text: truncStr(r.supplierName, 20), align: "left" },
          { x: px + 140, w: 40, text: String(r.bookings), align: "right" },
          { x: px + 180, w: 90, text: fmtInr(r.totalQuoted), align: "right" },
          { x: px + 270, w: halfW - 270 - 20, text: fmtInr(r.totalBaseProfit), align: "right" },
        ],
        bg, C_BLACK, 8,
      );
      py += 16;
    }

    pageFooter(3);

    /* ══════════════════════════════════════════════════════════════
       PAGE 4 — BY MONTH + UNPAID INVOICES
    ══════════════════════════════════════════════════════════════ */
    doc.addPage();
    pageHeader("Monthly Breakdown & Unpaid Invoices");
    y = M + 44;

    doc.fillColor(C_MID).font("Helvetica-Bold").fontSize(9)
      .text("Monthly Breakdown", L, y);
    y += 12;

    const monthCols = [
      { x: L, w: 120 },
      { x: L + 120, w: 55 },
      { x: L + 175, w: 100 },
      { x: L + 275, w: 100 },
      { x: L + 375, w: 100 },
      { x: L + 475, w: 80 },
    ];
    const monthHdrs = ["Month", "Bookings", "Quoted", "Actual", "Profit", "Margin%"];
    drawTableRow(y, monthCols.map((c, i) => ({ ...c, text: monthHdrs[i], align: i > 1 ? ("right" as const) : ("left" as const) })), C_NAVY, C_WHITE, 8, true);
    y += 16;

    for (let i = 0; i < reportData.byMonth.length; i++) {
      const r = reportData.byMonth[i];
      const bg = i % 2 === 0 ? C_WHITE : C_BG;
      drawTableRow(
        y,
        [
          { x: L, w: 120, text: r.month || "", align: "left" },
          { x: L + 120, w: 55, text: String(r.bookings), align: "right" },
          { x: L + 175, w: 100, text: fmtInr(r.totalQuoted), align: "right" },
          { x: L + 275, w: 100, text: fmtInr(r.totalActual), align: "right" },
          { x: L + 375, w: 100, text: fmtInr(r.totalBaseProfit), align: "right" },
          { x: L + 475, w: 80, text: `${fmtNum(r.avgMargin)}%`, align: "right" },
        ],
        bg, C_BLACK, 8,
      );
      y += 16;
    }

    y += 16;

    if (reportData.unpaidInvoices.length > 0) {
      doc.fillColor("#92400E").font("Helvetica-Bold").fontSize(9)
        .text(`⚠ Unpaid Invoices (${reportData.unpaidInvoices.length})`, L, y);
      y += 12;

      const invCols = [
        { x: L, w: 120 },
        { x: L + 120, w: 160 },
        { x: L + 280, w: 100 },
        { x: L + 380, w: 90 },
        { x: L + 470, w: 80 },
      ];
      const invHdrs = ["Invoice No", "Client", "Amount", "Due Date", "Days Pending"];
      drawTableRow(y, invCols.map((c, i) => ({ ...c, text: invHdrs[i], align: i > 1 ? ("right" as const) : ("left" as const) })), "#FEF3C7", "#92400E", 8, true);
      y += 16;

      for (let i = 0; i < reportData.unpaidInvoices.length; i++) {
        const inv = reportData.unpaidInvoices[i];
        const bg = inv.pendingDays >= 7 ? "#FFF1F2" : (i % 2 === 0 ? C_WHITE : C_BG);
        drawTableRow(
          y,
          [
            { x: L, w: 120, text: inv.invoiceNo, align: "left" },
            { x: L + 120, w: 160, text: truncStr(inv.clientName, 22), align: "left" },
            { x: L + 280, w: 100, text: fmtInr(inv.grandTotal), align: "right" },
            { x: L + 380, w: 90, text: fmtDate(inv.dueDate), align: "right" },
            { x: L + 470, w: 80, text: `${inv.pendingDays}d`, align: "right" },
          ],
          bg, C_BLACK, 8,
        );
        y += 16;
      }
    }

    pageFooter(4);

    doc.end();
  });
}
