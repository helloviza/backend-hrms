// apps/backend/src/utils/cstepPacketPdf.ts
//
// CSTEP Travel & Claim Portal — combined "packet" PDF. One downloadable PDF
// per travel request, assembled in this fixed order:
//   1. Itinerary page(s) — Onward + Return legs from the Step 4 Travel
//      Report, rendered fresh with pdfkit, mirroring
//      cstepTourProposalPdf.ts's own header/style (same fonts/logo/
//      drawCell helper).
//   2. Supporting documents — one light caption/separator page per report
//      leg (in leg order: every Onward leg, then every Return leg),
//      followed by that leg's attachment merged in: a PDF attachment's
//      pages are copied in directly; a JPG/PNG attachment is embedded as a
//      full page scaled to fit. A leg with no attachment, an attachment
//      that can't be fetched from S3, or a format pdf-lib can't embed
//      (WebP is an accepted upload type but pdf-lib only embeds JPG/PNG)
//      gets a plain "Document unavailable" placeholder page instead —
//      never aborts the whole packet over one bad file.
//   3. The approval form — the SAME generator GET /requests/:id/pdf already
//      uses, dispatched on formType exactly the same way, appended last
//      with its digital signatures intact.
//
// Built on pdf-lib (already a dependency — see routes/payroll.payslip.ts
// for this codebase's other usage) as the single assembling document:
// pdfkit's itinerary output and the existing approval-form PDF are just
// byte buffers loaded in and merged via PDFDocument.load()+copyPages();
// caption/placeholder pages are drawn directly on the assembling doc (no
// extra pdfkit round-trip needed for a page of plain text).

import PDFDocument from "pdfkit";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { PDFDocument as PdfLibDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";
import { getObjectBuffer } from "./s3Upload.js";
import type { ICstepTravelRequest } from "../models/cstep/CstepTravelRequest.js";
import type { ICstepReportLeg, CstepReportDirection } from "../models/cstep/CstepReportLeg.js";
import type { ICstepAttachment } from "../models/cstep/CstepAttachment.js";
import {
  generateCstepTourProposalPdf,
  type CstepTravellerInfo,
  type CstepApprovalTrailEntry,
  type CstepSettlementPdfData,
} from "./cstepTourProposalPdf.js";
import { generateCstepEventRequestPdf } from "./cstepEventRequestPdf.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FONT_PATH = path.join(__dirname, "..", "fonts", "NotoSans-Regular.ttf");
const FONT_BOLD_PATH = path.join(__dirname, "..", "fonts", "NotoSans-Bold.ttf");
const LOGO_PATH = path.join(__dirname, "..", "assets", "logos", "cstep-logo.png");

const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : undefined,
});

// ── Page geometry (A4, matches cstepTourProposalPdf.ts) ───────────────────
const PG_W = 595.28;
const PG_H = 841.89;
const M = 40;
const CW = PG_W - 2 * M;

const MODE_LABELS: Record<string, string> = {
  FLIGHT: "Flight",
  HOTEL: "Hotel",
  CAB: "Cab",
  TRAIN: "Train",
  BUS: "Bus",
  VISA: "Visa",
  FOREX: "Forex",
  STATIONERY: "Stationery",
  OTHER: "Other",
};

const DIRECTION_LABELS: Record<CstepReportDirection, string> = { ONWARD: "Onward", RETURN: "Return" };

export type CstepPacketReportLeg = {
  leg: ICstepReportLeg;
  attachment: ICstepAttachment | null;
};

function fmtDate(d?: string): string {
  if (!d) return "";
  const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return d;
}

function fmtAmount(n?: number): string {
  if (n === undefined || n === null) return "";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function legCaption(leg: ICstepReportLeg): string {
  const mode = MODE_LABELS[leg.travelMode] || leg.travelMode;
  const route = [leg.fromLocation, leg.toLocation].filter(Boolean).join(" → ");
  return [DIRECTION_LABELS[leg.direction], mode, route].filter(Boolean).join(" · ");
}

// ── 1. Itinerary page(s) — pdfkit, mirroring cstepTourProposalPdf.ts ───────

function drawCell(
  doc: InstanceType<typeof PDFDocument>,
  fn: string,
  fb: string,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  opts: { align?: "left" | "center" | "right"; size?: number; header?: boolean } = {},
) {
  if (opts.header) {
    doc.strokeColor("#888888").fillColor("#eeeeee").rect(x, y, w, h).fillAndStroke();
  } else {
    doc.strokeColor("#888888").rect(x, y, w, h).stroke();
  }
  doc
    .font(opts.header ? fb : fn)
    .fontSize(opts.size || 8.5)
    .fillColor("#111111")
    .text(text, x + 4, y + 4, { width: w - 8, height: h - 8, align: opts.align || "left", lineBreak: true });
}

function generateItineraryPdf(request: ICstepTravelRequest, orderedLegs: CstepPacketReportLeg[]): Promise<Buffer> {
  const noto = fs.existsSync(FONT_PATH) && fs.existsSync(FONT_BOLD_PATH);
  const fn = noto ? "NotoSans" : "Helvetica";
  const fb = noto ? "NotoSans-Bold" : "Helvetica-Bold";

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: M, bottom: M, left: M, right: M },
    info: { Title: "Travel Packet — Itinerary" },
  });
  if (noto) {
    doc.registerFont("NotoSans", FONT_PATH);
    doc.registerFont("NotoSans-Bold", FONT_BOLD_PATH);
  }

  const promise = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  let y = M;
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, M, y, { width: 80 });
    y += 40;
  }
  doc.font(fb).fontSize(14).fillColor("#111111").text("TRAVEL PACKET — ITINERARY", M, y, { width: CW, align: "center" });
  y += 20;
  doc
    .font(fn)
    .fontSize(8)
    .fillColor("#555555")
    .text("(Generated by the Plumtrips CSTEP Portal — combined itinerary, supporting documents & approval form)", M, y, {
      width: CW,
      align: "center",
    });
  y += 16;
  const statusLine = [`Status: ${request.status}`, request.claimReference ? `TIN: ${request.claimReference}` : null]
    .filter(Boolean)
    .join("     ");
  doc.font(fb).fontSize(9).fillColor("#091426").text(statusLine, M, y, { width: CW, align: "center" });
  y += 24;

  const COLS = [
    { label: "FROM → TO", w: Math.round(CW * 0.32) },
    { label: "DATE", w: Math.round(CW * 0.18) },
    { label: "MODE", w: Math.round(CW * 0.14) },
    { label: "FARE", w: Math.round(CW * 0.18) },
    { label: "PAID BY", w: 0 },
  ];
  COLS[4].w = CW - COLS[0].w - COLS[1].w - COLS[2].w - COLS[3].w;
  const ROW_H = 26;
  const HEADER_H = 16;

  function drawLegTable(title: string, rows: CstepPacketReportLeg[]) {
    if (y + 60 > PG_H - M) {
      doc.addPage();
      y = M;
    }
    doc.font(fb).fontSize(10).fillColor("#111111").text(title, M, y, { width: CW });
    y += 16;

    if (rows.length === 0) {
      doc.font(fn).fontSize(8.5).fillColor("#888888").text("(no legs reported)", M, y, { width: CW });
      y += 20;
      return;
    }

    let x = M;
    for (const col of COLS) {
      drawCell(doc, fn, fb, x, y, col.w, HEADER_H, col.label, { header: true, align: "center", size: 7.5 });
      x += col.w;
    }
    y += HEADER_H;

    for (const { leg, attachment } of rows) {
      if (y + ROW_H > PG_H - M) {
        doc.addPage();
        y = M;
      }
      const route = [leg.fromLocation, leg.toLocation].filter(Boolean).join(" → ") || "—";
      const dateRange = [fmtDate(leg.fromDate), fmtDate(leg.toDate)].filter(Boolean).join(" – ") || "—";
      const fare = leg.fare ? `${fmtAmount(leg.fare)} ${leg.currency || ""}`.trim() : "—";
      const paidBy = (leg.paidBy === "CSTEP" ? "Booked by CSTEP" : "Self Paid") + (attachment ? "" : " · no document");

      x = M;
      drawCell(doc, fn, fb, x, y, COLS[0].w, ROW_H, route + (leg.remarks ? `\n${leg.remarks}` : ""), { size: 8 });
      x += COLS[0].w;
      drawCell(doc, fn, fb, x, y, COLS[1].w, ROW_H, dateRange, { size: 8, align: "center" });
      x += COLS[1].w;
      drawCell(doc, fn, fb, x, y, COLS[2].w, ROW_H, MODE_LABELS[leg.travelMode] || leg.travelMode, { size: 8, align: "center" });
      x += COLS[2].w;
      drawCell(doc, fn, fb, x, y, COLS[3].w, ROW_H, fare, { size: 8, align: "right" });
      x += COLS[3].w;
      drawCell(doc, fn, fb, x, y, COLS[4].w, ROW_H, paidBy, { size: 7, align: "center" });
      y += ROW_H;
    }
    y += 14;
  }

  const onward = orderedLegs.filter((l) => l.leg.direction === "ONWARD");
  const ret = orderedLegs.filter((l) => l.leg.direction === "RETURN");
  drawLegTable("Onward Journey", onward);
  drawLegTable("Return Journey", ret);

  if (orderedLegs.length === 0) {
    doc.font(fn).fontSize(9).fillColor("#888888").text("No travel report has been filed for this request yet.", M, y, { width: CW });
  }

  doc.end();
  return promise;
}

// ── 2. Supporting documents — caption/separator + merged/placeholder pages ─

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function appendCaptionPage(pdf: PdfLibDocument, font: PDFFont, boldFont: PDFFont, caption: string, subtitle?: string) {
  const page = pdf.addPage([PG_W, PG_H]);
  const topY = PG_H - M - 40;
  page.drawText("SUPPORTING DOCUMENT", { x: M, y: topY, size: 9, font: boldFont, color: rgb(0.45, 0.45, 0.45) });
  page.drawText(caption, { x: M, y: topY - 24, size: 15, font: boldFont, color: rgb(0.05, 0.08, 0.15) });
  if (subtitle) {
    page.drawText(subtitle, { x: M, y: topY - 44, size: 9.5, font, color: rgb(0.4, 0.4, 0.4) });
  }
  page.drawLine({
    start: { x: M, y: topY - 56 },
    end: { x: PG_W - M, y: topY - 56 },
    thickness: 0.75,
    color: rgb(0.75, 0.75, 0.75),
  });
}

function appendPlaceholderMessage(pdf: PdfLibDocument, font: PDFFont, boldFont: PDFFont, message: string) {
  const page = pdf.addPage([PG_W, PG_H]);
  const midY = PG_H / 2 + 20;
  page.drawText("Document unavailable", { x: M, y: midY, size: 13, font: boldFont, color: rgb(0.6, 0.15, 0.15) });
  let y = midY - 22;
  for (const line of wrapText(message, font, 9.5, CW)) {
    page.drawText(line, { x: M, y, size: 9.5, font, color: rgb(0.35, 0.35, 0.35) });
    y -= 14;
  }
}

async function appendAttachment(
  pdf: PdfLibDocument,
  font: PDFFont,
  boldFont: PDFFont,
  leg: ICstepReportLeg,
  attachment: ICstepAttachment | null,
): Promise<void> {
  const caption = legCaption(leg);
  appendCaptionPage(pdf, font, boldFont, caption, attachment?.originalName);

  if (!attachment) {
    appendPlaceholderMessage(pdf, font, boldFont, "No supporting document was uploaded for this leg.");
    return;
  }

  let bytes: Buffer;
  try {
    bytes = await getObjectBuffer(attachment.s3Key);
  } catch (err: any) {
    console.error("[cstepPacketPdf] Failed to fetch attachment", attachment.s3Key, err?.message);
    appendPlaceholderMessage(
      pdf,
      font,
      boldFont,
      "This document could not be retrieved from storage. Please view it from the Travel Report instead.",
    );
    return;
  }

  const mime = (attachment.mime || "").toLowerCase();
  try {
    if (mime === "application/pdf") {
      const srcDoc = await PdfLibDocument.load(bytes, { ignoreEncryption: true });
      const pages = await pdf.copyPages(srcDoc, srcDoc.getPageIndices());
      pages.forEach((p) => pdf.addPage(p));
      return;
    }
    if (mime === "image/png" || mime === "image/jpeg" || mime === "image/jpg") {
      const image = mime === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const maxW = PG_W - 2 * M;
      const maxH = PG_H - 2 * M;
      const scale = Math.min(maxW / image.width, maxH / image.height, 1);
      const w = image.width * scale;
      const h = image.height * scale;
      const page = pdf.addPage([PG_W, PG_H]);
      page.drawImage(image, { x: (PG_W - w) / 2, y: (PG_H - h) / 2, width: w, height: h });
      return;
    }
    // Accepted at upload time (e.g. image/webp) but pdf-lib can only embed
    // JPG/PNG raster images — never silently drop the document, note why.
    appendPlaceholderMessage(
      pdf,
      font,
      boldFont,
      `This document's format (${attachment.mime || "unknown"}) can't be embedded in the packet. Please view/download it from the Travel Report instead.`,
    );
  } catch (err: any) {
    console.error("[cstepPacketPdf] Failed to embed attachment", attachment.s3Key, err?.message);
    appendPlaceholderMessage(
      pdf,
      font,
      boldFont,
      "This document could not be added to the packet. Please view it from the Travel Report instead.",
    );
  }
}

// ── Public exports ────────────────────────────────────────────────────────

export async function generateCstepPacketPdf(
  request: ICstepTravelRequest,
  traveller: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
  legs: CstepPacketReportLeg[],
  settlement?: CstepSettlementPdfData,
): Promise<Buffer> {
  const orderedLegs = [
    ...legs.filter((l) => l.leg.direction === "ONWARD"),
    ...legs.filter((l) => l.leg.direction === "RETURN"),
  ];

  const pdf = await PdfLibDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

  // 1. Itinerary
  const itineraryBytes = await generateItineraryPdf(request, orderedLegs);
  const itineraryDoc = await PdfLibDocument.load(itineraryBytes);
  const itineraryPages = await pdf.copyPages(itineraryDoc, itineraryDoc.getPageIndices());
  itineraryPages.forEach((p) => pdf.addPage(p));

  // 2. Supporting documents, in leg order (Onward, then Return) — never
  // let one bad/missing document fail the whole packet.
  for (const entry of orderedLegs) {
    await appendAttachment(pdf, font, boldFont, entry.leg, entry.attachment);
  }

  // 3. Approval form — same generator + formType dispatch as
  // GET /requests/:id/pdf, appended last.
  const approvalBytes =
    request.formType === "EVENT_REQUEST"
      ? await generateCstepEventRequestPdf(request, traveller, trail)
      : await generateCstepTourProposalPdf(request, traveller, trail, settlement);
  const approvalDoc = await PdfLibDocument.load(approvalBytes);
  const approvalPages = await pdf.copyPages(approvalDoc, approvalDoc.getPageIndices());
  approvalPages.forEach((p) => pdf.addPage(p));

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

export async function uploadCstepPacketPdf(
  request: ICstepTravelRequest,
  traveller: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
  legs: CstepPacketReportLeg[],
  settlement?: CstepSettlementPdfData,
): Promise<{ key: string }> {
  const buf = await generateCstepPacketPdf(request, traveller, trail, legs, settlement);
  const key = `cstep-packets/${request.workspaceId}/${request._id}/packet-${Date.now()}.pdf`;
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: buf,
      ContentType: "application/pdf",
    }),
  );
  return { key };
}
