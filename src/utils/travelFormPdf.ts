import PDFDocument from "pdfkit";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";
import { presignGetObject } from "./s3Presign.js";
import type { ITravelForm } from "../models/TravelForm.js";

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

// ── Page geometry ─────────────────────────────────────────────────────────────
const PG_W = 595.28;
const M = 40;
const CW = PG_W - 2 * M;
const L = M;

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeSlotStr(selected: string): string {
  const norm = (s: string) => s.replace(/–/g, "-").trim();
  const slots = ["Before 6 AM", "6 AM – 12 PM", "12 PM – 6 PM", "After 6 PM"];
  return slots.map((s) => (norm(s) === norm(selected) ? "(X)" : "( )") + " " + s).join("   ");
}

function mealPrefStr(selected: string): string {
  const isVeg = selected === "Veg";
  const isNonVeg = selected === "NonVeg" || selected === "Non-Veg";
  return (isVeg ? "(X)" : "( )") + " Veg   " + (isNonVeg ? "(X)" : "( )") + " Non-Veg";
}

function fmtDate(d: string): string {
  if (!d) return "";
  const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return d;
}

function modeStr(selected: string): string {
  return ["Air", "Rail", "Road", "Others"].map((m) => (m === selected ? "(X)" : "( )") + " " + m).join("   ");
}

function fmtAmount(n: number): string {
  if (!n) return "";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function yesNo(val: boolean): string {
  return val ? "Yes" : "No";
}

// ── PDF builder ───────────────────────────────────────────────────────────────

type PdfDoc = InstanceType<typeof PDFDocument>;

function makePdf(title: string, subtitle: string): {
  doc: PdfDoc;
  fn: string;
  fb: string;
  collect: () => Promise<Buffer>;
} {
  const noto = fs.existsSync(FONT_PATH) && fs.existsSync(FONT_BOLD_PATH);
  const fn = noto ? "NotoSans" : "Helvetica";
  const fb = noto ? "NotoSans-Bold" : "Helvetica-Bold";

  const doc = new PDFDocument({ size: "A4", margins: { top: M, bottom: M, left: M, right: M }, info: { Title: title } });
  if (noto) {
    doc.registerFont("NotoSans", FONT_PATH);
    doc.registerFont("NotoSans-Bold", FONT_BOLD_PATH);
  }

  const collect = () =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

  return { doc, fn, fb, collect };
}

// Draw a single border-only table cell and place text inside it
function drawCell(
  doc: PdfDoc,
  fn: string,
  fb: string,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  opts: { bold?: boolean; align?: "left" | "center" | "right"; size?: number; header?: boolean } = {}
) {
  if (opts.header) {
    doc.strokeColor("#888888").fillColor("#eeeeee").rect(x, y, w, h).fillAndStroke();
  } else {
    doc.strokeColor("#888888").rect(x, y, w, h).stroke();
  }
  doc
    .font(opts.bold || opts.header ? fb : fn)
    .fontSize(opts.size || 8.5)
    .fillColor("#111111")
    .text(text, x + 4, y + 4, {
      width: w - 8,
      height: h - 8,
      align: opts.align || "left",
      lineBreak: true,
    });
}

// Draw a horizontal rule
function hrule(doc: PdfDoc, y: number, color = "#cccccc") {
  doc.strokeColor(color).moveTo(L, y).lineTo(L + CW, y).stroke();
}

// ── Domestic PDF ──────────────────────────────────────────────────────────────

function generateDomesticPdf(form: ITravelForm): Promise<Buffer> {
  const { doc, fn, fb, collect } = makePdf("Domestic Tour Proposal", "");
  const promise = collect();

  const LW = Math.round(CW * 0.57); // label column width
  const VW = CW - LW; // value column width
  const RH = 22; // standard row height
  const RHL = 36; // tall row height (multi-line content)

  let y = M;

  // Logo
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, L, y, { width: 80 });
    y += 40;
  }

  // Title
  doc.font(fb).fontSize(14).fillColor("#111111").text("DOMESTIC TOUR PROPOSAL", L, y, { width: CW, align: "center" });
  y += 20;
  doc.font(fn).fontSize(8).fillColor("#555555").text(
    "(Individual request format only. New forms to be filled for additional team members travelling)",
    L,
    y,
    { width: CW, align: "center" }
  );
  y += 18;

  // Table rows: [label, value, rowHeight]
  const rows: [string, string, number][] = [
    [
      "Name of the Researcher/Staff (Gender: M/F)",
      form.travelerName
        ? `${form.travelerName} (${form.travelerGender === "M" ? "Male" : form.travelerGender === "F" ? "Female" : form.travelerGender || "—"})${form.travelerId ? " | ID: " + form.travelerId : ""}`
        : "",
      RH,
    ],
    ["Purpose of tour", form.purposeOfTour || "", RHL],
    [
      "Station(s) to be visited with duration of stay\nFrom:                       To:",
      [
        form.origin && form.destination ? `${form.origin} to ${form.destination}` : form.destination || "",
        form.departureDate ? `From: ${form.departureDate}` : "",
        form.returnDate && form.returnDate !== "N/A" ? `To: ${form.returnDate}` : "To: N/A",
      ].filter(Boolean).join("\n"),
      RHL,
    ],
    [
      "Date of departure: DD/MM/YYYY",
      (form.departureDate ? fmtDate(form.departureDate) + "\n" : "") + timeSlotStr(form.departureTimeSlot),
      RHL,
    ],
    [
      "Date of return: DD/MM/YYYY",
      (form.returnDate ? fmtDate(form.returnDate) : "N/A") + "\n" + timeSlotStr(form.returnTimeSlot || ""),
      RHL,
    ],
    ["Date(s) of Events", form.eventDates || "", RH],
    [
      "Mode of travel requested",
      modeStr(form.modeOfTravel),
      RH,
    ],
    ["Transport requirement", form.transportRequirement || "", RH],
    ["Accommodation requirement", form.accommodationRequirement || "", RHL],
    ["Name of project to which expenditure is debitable", form.projectName || "", RH],
    ["Funds availability", form.fundsAvailability || "", RH],
    ["Is the tour sponsored?", form.sponsorshipDetails || "", RHL],
    ["Meal Preference", mealPrefStr(form.mealPreference), RH],
    ["Additional details", form.additionalDetails || "", RHL],
  ];

  for (const [label, value, rh] of rows) {
    drawCell(doc, fn, fb, L, y, LW, rh, label, { size: 8.5 });
    drawCell(doc, fn, fb, L + LW, y, VW, rh, value, { size: 8.5 });
    y += rh;
  }

  y += 16;

  // Signature block
  const sigColW = Math.round(CW / 2);
  doc.font(fn).fontSize(8.5).fillColor("#111111");
  doc.text("Signature of Researcher:", L, y);
  doc.text(`${form.requestorSignature || ""}`, L + 130, y, { lineBreak: false });
  doc.text("Date:", L + sigColW, y, { lineBreak: false });
  doc.text(`${form.requestorSignatureDate || ""}`, L + sigColW + 32, y, { lineBreak: false });
  y += 18;
  doc.text("Signature of PI/Director:", L, y);
  doc.text(`${form.approverSignature || ""}`, L + 130, y, { lineBreak: false });
  doc.text("Date:", L + sigColW, y, { lineBreak: false });
  doc.text(`${form.approverSignatureDate || ""}`, L + sigColW + 32, y, { lineBreak: false });
  y += 20;

  // Divider + office-use section
  hrule(doc, y);
  y += 8;
  doc.font(fb).fontSize(8.5).fillColor("#555555").text("For Office purposes only", L, y, { width: CW, align: "center" });
  y += 14;

  // Advance/Per Diem line
  doc.font(fn).fontSize(8.5).fillColor("#111111");
  doc.text("Advance/Per Diem:  Rs. ___________", L, y);
  y += 14;
  doc.text("Travel invoice submitted:   ( ) Air   ( ) Rail   ( ) Road   ( ) Cab   ( ) Lodg/oth", L, y);
  y += 14;

  // Expense table
  const EXP_COLS = [
    { label: "#", w: Math.round(CW * 0.06) },
    { label: "DETAILS", w: Math.round(CW * 0.50) },
    { label: "AMOUNT", w: Math.round(CW * 0.22) },
    { label: "REMARKS", w: CW - Math.round(CW * 0.06) - Math.round(CW * 0.50) - Math.round(CW * 0.22) },
  ];
  const expH = 18;
  const expHeaderH = 18;
  let ex = L;
  for (const col of EXP_COLS) {
    drawCell(doc, fn, fb, ex, y, col.w, expHeaderH, col.label, { header: true, align: "center", size: 8 });
    ex += col.w;
  }
  y += expHeaderH;

  const flightFare = form.flightFare || 0;
  const hotelFare = form.hotelFare || 0;
  const totalFare = flightFare + hotelFare;
  const expRows: [string, string, string, string][] = [
    ["1", "Air/Train/Bus Fare", flightFare > 0 ? fmtAmount(flightFare) : "", ""],
    ["2", "Per Diem", "", ""],
    ["3", "Boarding and Lodging", hotelFare > 0 ? fmtAmount(hotelFare) : "", ""],
    ["4", "Cab", "", ""],
    ["5", "Other expenses", "", ""],
    ["", "TOTAL COST OF TOUR", totalFare > 0 ? fmtAmount(totalFare) : "", ""],
    ["", "AMOUNT CLAIMED", "", ""],
  ];
  for (const [num, detail, amount, remark] of expRows) {
    ex = L;
    for (let i = 0; i < EXP_COLS.length; i++) {
      const vals = [num, detail, amount, remark];
      const bold = detail === "TOTAL COST OF TOUR" || detail === "AMOUNT CLAIMED";
      drawCell(doc, fn, fb, ex, y, EXP_COLS[i].w, expH, vals[i], { bold, size: 8 });
      ex += EXP_COLS[i].w;
    }
    y += expH;
  }

  y += 14;
  const adminColW = Math.round(CW / 3);
  doc.font(fn).fontSize(8).fillColor("#333333");
  doc.text("Verified by (Admin/Accounts):", L, y);
  doc.text("Date:", L + adminColW, y, { lineBreak: false });
  doc.text("Signature:", L + 2 * adminColW, y, { lineBreak: false });

  doc.end();
  return promise;
}

// ── International PDF ─────────────────────────────────────────────────────────

function generateInternationalPdf(form: ITravelForm): Promise<Buffer> {
  const { doc, fn, fb, collect } = makePdf("International Travel Request", "");
  const promise = collect();

  let y = M;

  // Logo
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, L, y, { width: 80 });
    y += 40;
  }

  // Title
  doc.font(fb).fontSize(14).fillColor("#111111").text("INTERNATIONAL TRAVEL REQUEST", L, y, { width: CW, align: "center" });
  y += 20;
  doc.font(fn).fontSize(8).fillColor("#555555").text(
    "(Individual request format only.)",
    L,
    y,
    { width: CW, align: "center" }
  );
  y += 18;

  // Header table (2 x 2)
  const HCW = Math.round(CW / 2);
  const HRH = 24;
  drawCell(doc, fn, fb, L, y, HCW, HRH, `Name: ${form.travelerName || ""}${form.travelerId ? " | ID: " + form.travelerId : ""}`, { size: 8.5 });
  drawCell(doc, fn, fb, L + HCW, y, CW - HCW, HRH, `Designation: ${form.designation || ""}`, { size: 8.5 });
  y += HRH;
  drawCell(doc, fn, fb, L, y, HCW, HRH, `Project: ${form.projectDebitability || ""}`, { size: 8.5 });
  drawCell(doc, fn, fb, L + HCW, y, CW - HCW, HRH, `Purpose: ${form.purposeOfTour || ""}`, { size: 8.5 });
  y += HRH + 10;

  // Countries visited
  doc.font(fb).fontSize(9).fillColor("#111111").text("Countries / cities to be visited:", L, y);
  y += 14;
  if (form.countriesVisited && form.countriesVisited.length > 0) {
    for (const country of form.countriesVisited.slice(0, 4)) {
      doc.font(fn).fontSize(8.5).text(`• ${country}`, L + 8, y);
      y += 13;
    }
  } else {
    doc.font(fn).fontSize(8.5).fillColor("#888888").text("(not specified)", L + 8, y);
    y += 13;
  }
  y += 6;

  // Fields
  const FL = 240; // field label width
  type FieldRow = [string, string];
  const fields: FieldRow[] = [
    ["Total days of absence from station:", `${form.totalDaysAbsent || 0} days`],
    ["Accommodation required:", yesNo(form.accommodationRequired)],
    ["If yes, suggestion for accommodation:", form.accommodationSuggestion || ""],
    ["Advance requested in forex:", form.forexAdvance || ""],
    ["Sponsorship communiqué attached:", yesNo(form.sponsorshipAttached)],
    ["Travel extended beyond conference dates:", yesNo(form.travelExtended)],
    ["Personal holiday days (if any):", form.personalHolidayDays || ""],
    ["International roaming approved:", yesNo(form.internationalRoamingApproved)],
  ];
  for (const [label, value] of fields) {
    doc.font(fn).fontSize(8.5).fillColor("#444444").text(label, L, y, { width: FL, lineBreak: false });
    doc.font(fn).fontSize(8.5).fillColor("#111111").text(value, L + FL + 8, y, { width: CW - FL - 8, lineBreak: false });
    y += 14;
  }
  y += 6;

  // Brief justification
  doc.font(fb).fontSize(8.5).fillColor("#111111").text("Brief justification:", L, y);
  y += 13;
  doc.font(fn).fontSize(8.5).fillColor("#333333");
  const justH = 40;
  doc.rect(L, y, CW, justH).stroke("#aaaaaa");
  doc.text(form.briefJustification || "", L + 4, y + 4, { width: CW - 8, height: justH - 8, lineBreak: true });
  y += justH + 8;

  // Expected outcome
  doc.font(fb).fontSize(8.5).fillColor("#111111").text("Expected outcome / benefit:", L, y);
  y += 13;
  const outH = 30;
  doc.rect(L, y, CW, outH).stroke("#aaaaaa");
  doc.font(fn).fontSize(8.5).fillColor("#333333")
    .text(form.expectedOutcome || "", L + 4, y + 4, { width: CW - 8, height: outH - 8, lineBreak: true });
  y += outH + 8;

  // Contact
  doc.font(fb).fontSize(8.5).fillColor("#111111").text("Contact address and phone while on travel:", L, y);
  y += 13;
  const ctH = 24;
  doc.rect(L, y, CW, ctH).stroke("#aaaaaa");
  doc.font(fn).fontSize(8.5).fillColor("#333333")
    .text(form.contactWhileTraveling || "", L + 4, y + 4, { width: CW - 8, height: ctH - 8, lineBreak: true });
  y += ctH + 10;

  // Financial
  doc.font(fn).fontSize(8.5).fillColor("#111111");
  doc.text(`Total cost estimate (Rs.):  ${fmtAmount(form.invoiceAmount) || ""}`, L, y);
  y += 14;
  doc.text(`Expenditure debitable to:  ${form.projectDebitability || ""}`, L, y);
  y += 14;
  doc.text("Finance Officer Signature: ________________________    Date: ______________", L, y);
  y += 20;

  // Signature block
  const sigColW = Math.round(CW / 2);
  hrule(doc, y);
  y += 10;
  doc.font(fn).fontSize(8.5).fillColor("#111111");
  doc.text("Requestor Signature:", L, y);
  doc.text(`${form.requestorSignature || ""}`, L + 120, y, { lineBreak: false });
  doc.text("Date:", L + sigColW, y, { lineBreak: false });
  doc.text(`${form.requestorSignatureDate || ""}`, L + sigColW + 32, y, { lineBreak: false });
  y += 18;
  doc.text("Sanctioned by PI/Director:", L, y);
  doc.text(`${form.approverSignature || ""}`, L + 144, y, { lineBreak: false });
  doc.text("Date:", L + sigColW, y, { lineBreak: false });
  doc.text(`${form.approverSignatureDate || ""}`, L + sigColW + 32, y, { lineBreak: false });

  doc.end();
  return promise;
}

// ── Public exports ────────────────────────────────────────────────────────────

export function generateTravelFormPdf(form: ITravelForm): Promise<Buffer> {
  if (form.formType === "international") return generateInternationalPdf(form);
  return generateDomesticPdf(form);
}

export async function uploadTravelFormPdf(
  form: ITravelForm
): Promise<{ key: string; url: string }> {
  const buf = await generateTravelFormPdf(form);
  const key = `travel-forms/${form.workspaceId}/${form._id}/${form.formType}-${Date.now()}.pdf`;
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: buf,
      ContentType: "application/pdf",
    })
  );
  const url = await presignGetObject({ bucket: env.S3_BUCKET, key, expiresInSeconds: 3600 });
  return { key, url };
}
