// apps/backend/src/utils/cstepTourProposalPdf.ts
//
// CSTEP Travel & Claim Portal — Tour Proposal PDF (Step 1 Polish, Part C;
// PDF fix pass; digital-signature pass). This is the PRINTABLE PAPER FORM,
// not a digital record: the top half is the filled-in proposal (traveller
// details, trip details, status, TIN if issued); the bottom half reproduces
// CSTEP's paper form's sign-off area — Researcher/PI signature + date
// lines, a Funds availability line, and a "For Office (Accounts/Admin)
// purposes only" expense table + Admin/Accounts signature lines.
//
// The system is the source of truth: the Researcher and PI/Director
// signature lines print a text-based DIGITAL signature (name + "Digitally
// signed via CSTEP portal · <date>") whenever that stage has genuinely
// happened — SUBMIT for the Researcher, APPROVE for the PI/Director — read
// from the CstepApproval `trail` already passed into this renderer. A
// stage that hasn't happened yet stays a genuinely blank line for wet
// signing. The Funds availability line and the Office expense table +
// Admin/Accounts lines stay blank always (no finance-stage action type
// exists yet, and the Office settlement table is post-trip, Steps 5-6, not
// built). The full CstepApproval audit trail is NOT printed as a table
// here — only these inline signature blocks; the trail itself stays on the
// on-screen detail view only. Does NOT attempt Annexure-IX claim/expense/
// settlement tables — those belong to the post-trip claim phases and don't
// exist yet.
//
// Deliberately a PARALLEL renderer, not a reuse of utils/travelFormPdf.ts:
// that engine is shaped around ITravelForm's flat field set (travelerName,
// origin, destination, flightFare, ...), while CstepTravelRequest has a
// different, nested shape (stations[]/countries[], a soft travelerProfileId
// reference). Mirrors travelFormPdf.ts's approach instead — same library
// (pdfkit), same fonts/logo assets, same S3-upload-then-presign pattern —
// without touching that file's contract at all.

import PDFDocument from "pdfkit";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";
import type { ICstepTravelRequest, ICstepStationEntry, ICstepCountryEntry } from "../models/cstep/CstepTravelRequest.js";

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

export type CstepTravellerInfo = {
  name: string;
  gender?: string;
  travelerId?: string;
};

export type CstepApprovalTrailEntry = {
  action: string;
  actorName?: string;
  at: string;
  comment?: string;
};

// Step 5 addition — the Office/Accounts settlement data (CstepSettlement),
// once it exists, fills the previously-always-blank "For Office (Accounts /
// Admin) purposes only" table (see drawOfficeExpenseTable). Deliberately
// just the numbers the table needs, not the full CstepSettlement shape —
// this renderer has no business knowing about lines/per-diem overrides/etc.
export type CstepSettlementPdfData = {
  buckets: { airRailBus: number; perDiem: number; boardingLodging: number; cab: number; other: number };
  totalCostOfTour: number;
  amountClaimed: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const TIME_BAND_LABELS: Record<string, string> = {
  BEFORE_6AM: "Before 6 AM",
  "6AM_12PM": "6 AM – 12 PM",
  "12PM_6PM": "12 PM – 6 PM",
  AFTER_6PM: "After 6 PM",
};

const MODE_LABELS: Record<string, string> = { AIR: "Air", RAIL: "Rail", ROAD: "Road", OTHER: "Other" };

function fmtDate(d?: string): string {
  if (!d) return "";
  const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return d;
}

function timeBandLabel(band?: string): string {
  return band ? TIME_BAND_LABELS[band] || band : "";
}

function modesLabel(modes?: string[], modeOther?: string): string {
  if (!modes || modes.length === 0) return "";
  const labels = modes.map((m) => MODE_LABELS[m] || m);
  if (modes.includes("OTHER") && modeOther) {
    return labels.map((l) => (l === "Other" ? `Other (${modeOther})` : l)).join(", ");
  }
  return labels.join(", ");
}

function yesNo(flag?: boolean, note?: string): string {
  if (!flag) return "No";
  return note && note.trim() ? `Yes — ${note.trim()}` : "Yes";
}

function mealLabel(v?: string): string {
  if (v === "VEG") return "Veg";
  if (v === "NON_VEG") return "Non-veg";
  return "";
}

function fmtAmount(n?: number): string {
  if (!n) return "";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function stationLines(stations?: ICstepStationEntry[]): string[] {
  if (!stations) return [];
  return stations
    .filter((s) => s.from || s.to)
    .map((s) => {
      const route = [s.from, s.to].filter(Boolean).join(" → ");
      return s.durationOfStay ? `${route} · ${s.durationOfStay}` : route;
    });
}

function countryLines(countries?: ICstepCountryEntry[]): string[] {
  if (!countries) return [];
  return countries
    .filter((c) => c.country)
    .map((c) => {
      const range = [fmtDate(c.fromDate), fmtDate(c.toDate)].filter(Boolean).join(" → ");
      return range ? `${c.country} · ${range}` : String(c.country);
    });
}

// ── Digital signatures (read from the audit trail, print-only) ───────────────
// The system is the source of truth: a stage that has genuinely happened in
// the app (submitted / approved) prints a text-based digital signature here
// instead of a blank line. This reads ONLY the CstepApproval entries already
// passed in as `trail` — no new queries — and never prints the trail itself
// as a table (that stays on-screen only, per TravelRequestDetail.tsx).

export type CstepSignature = { name: string; date: string };

function fmtSignatureDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/** Earliest entry of the given action, or undefined if the stage never
 * happened. Earliest matters for SUBMIT specifically — a resubmitted (i.e.
 * RETURNED-then-fixed) proposal keeps its ORIGINAL submission signature,
 * not a later one; RESUBMIT is a separate, distinct action and is never
 * matched here. */
function firstEntryOfAction(trail: CstepApprovalTrailEntry[], action: string): CstepApprovalTrailEntry | undefined {
  const matches = trail.filter((e) => e.action === action);
  if (matches.length === 0) return undefined;
  return matches.reduce((earliest, e) => (new Date(e.at).getTime() < new Date(earliest.at).getTime() ? e : earliest));
}

function signatureFromEntry(entry: CstepApprovalTrailEntry | undefined): CstepSignature | null {
  if (!entry) return null;
  return { name: entry.actorName || "—", date: fmtSignatureDate(entry.at) };
}

// ── PDF builder ───────────────────────────────────────────────────────────────

type PdfDoc = InstanceType<typeof PDFDocument>;

function makePdf(title: string): { doc: PdfDoc; fn: string; fb: string; collect: () => Promise<Buffer> } {
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

function drawCell(
  doc: PdfDoc,
  fn: string,
  fb: string,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  opts: { bold?: boolean; align?: "left" | "center" | "right"; size?: number; header?: boolean } = {},
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
    .text(text, x + 4, y + 4, { width: w - 8, height: h - 8, align: opts.align || "left", lineBreak: true });
}

function drawHeaderBlock(
  doc: PdfDoc,
  fn: string,
  fb: string,
  y: number,
  title: string,
  request: ICstepTravelRequest,
): number {
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, L, y, { width: 80 });
    y += 40;
  }

  doc.font(fb).fontSize(14).fillColor("#111111").text(title, L, y, { width: CW, align: "center" });
  y += 20;
  doc
    .font(fn)
    .fontSize(8)
    .fillColor("#555555")
    .text("(Generated by the Plumtrips CSTEP Portal — pre-trip proposal only)", L, y, { width: CW, align: "center" });
  y += 16;

  const statusLine = [
    `Status: ${request.status}`,
    request.claimReference ? `TIN: ${request.claimReference}` : null,
  ]
    .filter(Boolean)
    .join("     ");
  doc.font(fb).fontSize(9).fillColor("#091426").text(statusLine, L, y, { width: CW, align: "center" });
  y += 18;

  return y;
}

// ── Sign-off / Office section ─────────────────────────────────────────────────
// Reproduces the bottom of CSTEP's paper form. The Researcher/PI signature
// lines print a digital signature (name + date) when that stage has
// genuinely happened (read from the trail — see drawSignOffSection); the
// Funds availability line and the Office expense table + Admin/Accounts
// lines always stay blank for hand-filling (see their own doc comments for
// why). The full approval-trail TABLE is never printed here either way —
// only individual signature lines, derived from the trail, not the trail
// itself.

/** One ruled line + caption underneath, side by side in two columns — BLANK
 * for hand-signing unless that side's `signed` info is supplied, in which
 * case the person's name prints where the wet signature would sit (on the
 * ruled line, same position either way) and "Digitally signed via CSTEP
 * portal · <date>" prints in place of the blank "Date: ____" line. Layout
 * position is identical in both cases — only whether the ink is real or
 * digital changes. `withDateLine`: also prints a "Date: ____" line (or the
 * digital-signature date line) between the ruled line and the caption
 * (used for the Researcher/PI block; the Admin/Accounts pair below the
 * office table folds "and date" into its own caption instead, so it never
 * has a signature to wire — see module note). */
function drawSignatureLinePair(
  doc: PdfDoc,
  fn: string,
  fb: string,
  y: number,
  leftCaption: string,
  rightCaption: string,
  withDateLine: boolean,
  leftSigned: CstepSignature | null = null,
  rightSigned: CstepSignature | null = null,
): number {
  const gap = 24;
  const colW = Math.round((CW - gap) / 2);
  const positions = [L, L + colW + gap];
  const signed = [leftSigned, rightSigned];
  const sigSpace = 24; // blank room to physically sign above the ruled line
  const lineY = y + sigSpace;

  for (let i = 0; i < 2; i++) {
    const x = positions[i];
    doc.strokeColor("#333333").lineWidth(0.75).moveTo(x, lineY).lineTo(x + colW, lineY).stroke();
    const info = signed[i];
    if (info) {
      doc.font(fb).fontSize(9.5).fillColor("#091426").text(info.name, x, lineY - 13, { width: colW, lineBreak: false });
    }
  }

  // The date/digital-signature row shows whenever the caller asked for a
  // Date line (withDateLine) OR at least one side actually has a digital
  // signature to print — so a fully-blank pair (the Admin/Accounts pair,
  // which never receives signed info today) renders byte-for-byte as
  // before, with no extra row, while a signed side always gets its
  // "Digitally signed..." line even under a withDateLine=false caption
  // (defensive — kept consistent with cstepEventRequestPdf.ts's own copy
  // of this helper, which does exercise that combination).
  let capY = lineY + 4;
  const showDateRow = withDateLine || signed.some(Boolean);
  if (showDateRow) {
    for (let i = 0; i < 2; i++) {
      const x = positions[i];
      const info = signed[i];
      if (info) {
        doc.font(fn).fontSize(7).fillColor("#6b7280").text(`Digitally signed via CSTEP portal · ${info.date}`, x, capY);
      } else if (withDateLine) {
        doc.font(fn).fontSize(8).fillColor("#333333").text("Date: ____________________", x, capY);
      }
    }
    capY += 14;
  }

  doc.font(fn).fontSize(8).fillColor("#444444").text(leftCaption, positions[0], capY, { width: colW });
  doc.font(fn).fontSize(8).fillColor("#444444").text(rightCaption, positions[1], capY, { width: colW });

  return capY + 20;
}

/** Blank "Funds availability" line — label + an empty ruled line for the
 * Finance Officer to sign against. Deliberately NEVER wired to a digital
 * signature: there is no finance-stage CstepApproval action type yet (the
 * finance queue added in the CSTEP mapping work is a read-only view of
 * APPROVED requests, not itself a recorded action) — inventing one here
 * would be printing something the system never actually recorded. Stays
 * blank until that action type exists. */
function drawFundsAvailabilityLine(doc: PdfDoc, fn: string, fb: string, y: number): number {
  doc
    .font(fn)
    .fontSize(8.5)
    .fillColor("#111111")
    .text("Funds availability (to be confirmed by Finance Officer with signature):", L, y, { width: CW });
  y += 16;
  doc.strokeColor("#333333").lineWidth(0.75).moveTo(L, y).lineTo(L + CW, y).stroke();
  return y + 18;
}

/** "For Office (Accounts / Admin) purposes only" expense table — the Amount
 * column is filled from the Step 5 CstepSettlement's buckets/totals once one
 * exists for this request (regardless of whether it's still VERIFYING or
 * already FINALIZED — the Official may want to see live figures mid-review);
 * every Amount cell stays empty for hand-filling when `settlement` is
 * undefined (no settlement started yet), exactly as before this addition.
 * Remarks stays blank either way — only the Details labels are pre-printed,
 * per the paper form's fixed row structure. */
function drawOfficeExpenseTable(doc: PdfDoc, fn: string, fb: string, y: number, settlement?: CstepSettlementPdfData): number {
  doc.font(fb).fontSize(9).fillColor("#555555").text("For Office (Accounts / Admin) purposes only", L, y, { width: CW, align: "center" });
  y += 16;

  const COLS = [
    { label: "DETAILS", w: Math.round(CW * 0.5) },
    { label: "AMOUNT", w: Math.round(CW * 0.24) },
    { label: "REMARKS", w: 0 },
  ];
  COLS[2].w = CW - COLS[0].w - COLS[1].w;

  const headerH = 16;
  let x = L;
  for (const col of COLS) {
    drawCell(doc, fn, fb, x, y, col.w, headerH, col.label, { header: true, align: "center", size: 7.5 });
    x += col.w;
  }
  y += headerH;

  const rows: [string, boolean, number | undefined][] = [
    ["1.  Air / Train / Bus Fare", false, settlement?.buckets.airRailBus],
    ["2.  Per Diem", false, settlement?.buckets.perDiem],
    ["3.  Boarding and Lodging", false, settlement?.buckets.boardingLodging],
    ["4.  Cab", false, settlement?.buckets.cab],
    ["5.  Other expenses", false, settlement?.buckets.other],
    ["TOTAL COST OF TOUR", true, settlement?.totalCostOfTour],
    ["AMOUNT CLAIMED", true, settlement?.amountClaimed],
  ];
  const rowH = 18;
  for (const [detail, bold, amount] of rows) {
    x = L;
    drawCell(doc, fn, fb, x, y, COLS[0].w, rowH, detail, { size: 8, bold });
    x += COLS[0].w;
    drawCell(doc, fn, fb, x, y, COLS[1].w, rowH, amount !== undefined ? fmtAmount(amount) : "", { size: 8, align: "right", bold });
    x += COLS[1].w;
    drawCell(doc, fn, fb, x, y, COLS[2].w, rowH, "", { size: 8 });
    y += rowH;
  }

  return y;
}

/** The sign-off section: Researcher/PI signatures (digital where the
 * corresponding stage has actually happened — SUBMIT for the Researcher,
 * APPROVE for the PI/Director — blank otherwise), the Funds availability
 * line (always blank, see its own doc comment), and the Office expense
 * table (filled once a Step 5 CstepSettlement exists — see
 * drawOfficeExpenseTable) + Admin/Accounts signatures (digital once the
 * settlement has actually been finalized — SETTLE in the trail — blank
 * otherwise; the same Official signs both Admin and Accounts, there being
 * no separate accounts-stage action). Paginates if it would run off the
 * page. */
function drawSignOffSection(
  doc: PdfDoc,
  fn: string,
  fb: string,
  y: number,
  trail: CstepApprovalTrailEntry[],
  settlement?: CstepSettlementPdfData,
): number {
  const ESTIMATED_HEIGHT = 340;
  if (y + ESTIMATED_HEIGHT > 800) {
    doc.addPage();
    y = M;
  }

  const submitSignature = signatureFromEntry(firstEntryOfAction(trail, "SUBMIT"));
  const approveSignature = signatureFromEntry(firstEntryOfAction(trail, "APPROVE"));

  y = drawSignatureLinePair(
    doc,
    fn,
    fb,
    y,
    "Signature of Researcher Initiating Proposal",
    "Signature of PI (in case of Project) or Director",
    true,
    submitSignature,
    approveSignature,
  );
  y += 10;

  y = drawFundsAvailabilityLine(doc, fn, fb, y);
  y += 10;

  y = drawOfficeExpenseTable(doc, fn, fb, y, settlement);
  y += 16;

  const settleSignature = signatureFromEntry(firstEntryOfAction(trail, "SETTLE"));
  y = drawSignatureLinePair(
    doc,
    fn,
    fb,
    y,
    "Admin signature and date upon verification",
    "Accounts signature and date upon verification",
    false,
    settleSignature,
    settleSignature,
  );

  return y;
}

// ── Domestic PDF ──────────────────────────────────────────────────────────────

function generateDomesticProposalPdf(
  request: ICstepTravelRequest,
  traveller: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
  settlement?: CstepSettlementPdfData,
): Promise<Buffer> {
  const { doc, fn, fb, collect } = makePdf("Domestic Tour Proposal");
  const promise = collect();

  let y = drawHeaderBlock(doc, fn, fb, M, "DOMESTIC TOUR PROPOSAL", request);

  const LW = Math.round(CW * 0.42);
  const VW = CW - LW;
  const RH = 22;
  const RHL = 36;

  const rows: [string, string, number][] = [
    [
      "Name of the Traveller (Gender)",
      `${traveller.name}${traveller.gender ? ` (${traveller.gender})` : ""}${traveller.travelerId ? " | ID: " + traveller.travelerId : ""}`,
      RH,
    ],
    ["Purpose of tour", request.purpose || "", RHL],
    ["Station(s) to be visited with duration of stay", stationLines(request.stations).join("\n") || "", RHL],
    ["Date of departure", (fmtDate(request.departureDate) || "") + (request.departureTimeBand ? `\n${timeBandLabel(request.departureTimeBand)}` : ""), RH],
    ["Date of return", (fmtDate(request.returnDate) || "") + (request.returnTimeBand ? `\n${timeBandLabel(request.returnTimeBand)}` : ""), RH],
    ["Date(s) of Events", request.eventDates || "", RH],
    ["Mode of travel requested", modesLabel(request.modesRequested, request.modeOther), RH],
    ["Transport requirement", yesNo(request.transportRequired, request.transportRequiredNote), RH],
    ["Accommodation requirement", yesNo(request.accommodationRequired, request.accommodationRequiredNote), RHL],
    ["Project debitable to", [request.project, request.projectDebitable].filter(Boolean).join(" — ") || "", RH],
    ["Is the tour sponsored?", yesNo(request.sponsored, request.sponsoredDetails), RHL],
    ["Meal Preference", mealLabel(request.mealPreference) || "", RH],
    ["Additional details", request.otherInstructions || "", RHL],
  ];

  for (const [label, value, rh] of rows) {
    if (y + rh > 780) {
      doc.addPage();
      y = M;
    }
    drawCell(doc, fn, fb, L, y, LW, rh, label, { size: 8.5, bold: true });
    drawCell(doc, fn, fb, L + LW, y, VW, rh, value, { size: 8.5 });
    y += rh;
  }

  y += 16;
  drawSignOffSection(doc, fn, fb, y, trail, settlement);

  doc.end();
  return promise;
}

// ── International PDF ─────────────────────────────────────────────────────────

function generateInternationalProposalPdf(
  request: ICstepTravelRequest,
  traveller: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
  settlement?: CstepSettlementPdfData,
): Promise<Buffer> {
  const { doc, fn, fb, collect } = makePdf("International Travel Request");
  const promise = collect();

  let y = drawHeaderBlock(doc, fn, fb, M, "INTERNATIONAL TRAVEL REQUEST", request);

  const HCW = Math.round(CW / 2);
  const HRH = 24;
  drawCell(doc, fn, fb, L, y, HCW, HRH, `Name: ${traveller.name}${traveller.travelerId ? " | ID: " + traveller.travelerId : ""}`, { size: 8.5 });
  drawCell(doc, fn, fb, L + HCW, y, CW - HCW, HRH, `Project: ${[request.project, request.projectDebitable].filter(Boolean).join(" — ")}`, { size: 8.5 });
  y += HRH;
  drawCell(doc, fn, fb, L, y, HCW, HRH, `Purpose: ${request.purpose || ""}`, { size: 8.5 });
  drawCell(doc, fn, fb, L + HCW, y, CW - HCW, HRH, `Days absent: ${request.daysAbsent ?? 0}`, { size: 8.5 });
  y += HRH + 10;

  doc.font(fb).fontSize(9).fillColor("#111111").text("Countries / cities to be visited:", L, y);
  y += 14;
  const countries = countryLines(request.countries);
  if (countries.length > 0) {
    for (const line of countries) {
      doc.font(fn).fontSize(8.5).fillColor("#111111").text(`• ${line}`, L + 8, y);
      y += 13;
    }
  } else {
    doc.font(fn).fontSize(8.5).fillColor("#888888").text("(not specified)", L + 8, y);
    y += 13;
  }
  y += 6;

  const FL = 240;
  const fields: [string, string][] = [
    ["Departure date / time:", `${fmtDate(request.departureDate)} ${timeBandLabel(request.departureTimeBand)}`.trim()],
    ["Return date / time:", `${fmtDate(request.returnDate)} ${timeBandLabel(request.returnTimeBand)}`.trim()],
    ["Mode of travel requested:", modesLabel(request.modesRequested, request.modeOther)],
    ["Accommodation required:", yesNo(request.accommodationRequired, request.accommodationRequiredNote)],
    [
      "Advance requested in forex:",
      request.advanceForex?.amount ? `${request.advanceForex.amount} ${request.advanceForex.currency || ""}`.trim() : "",
    ],
    ["Sponsorship communiqué attached:", yesNo(request.sponsorshipInvitationAttached)],
    ["Travel extended beyond conference dates:", yesNo(request.extendedBeyondDates)],
    [
      "Personal holiday days (if any):",
      request.personalDays?.count
        ? `${request.personalDays.count}${request.personalDays.dates?.length ? ` (${request.personalDays.dates.map((d) => fmtDate(d)).join(", ")})` : ""}`
        : "",
    ],
    ["International roaming approved:", yesNo(request.roamingApproved)],
  ];
  for (const [label, value] of fields) {
    if (y > 760) {
      doc.addPage();
      y = M;
    }
    doc.font(fn).fontSize(8.5).fillColor("#444444").text(label, L, y, { width: FL, lineBreak: false });
    doc.font(fn).fontSize(8.5).fillColor("#111111").text(value || "—", L + FL + 8, y, { width: CW - FL - 8, lineBreak: false });
    y += 14;
  }
  y += 6;

  doc.font(fb).fontSize(8.5).fillColor("#111111").text("Brief justification:", L, y);
  y += 13;
  const justH = 40;
  doc.rect(L, y, CW, justH).stroke("#aaaaaa");
  doc.font(fn).fontSize(8.5).fillColor("#333333").text(request.justification || "", L + 4, y + 4, { width: CW - 8, height: justH - 8, lineBreak: true });
  y += justH + 8;

  doc.font(fb).fontSize(8.5).fillColor("#111111").text("Expected outcome / benefit:", L, y);
  y += 13;
  const outH = 30;
  doc.rect(L, y, CW, outH).stroke("#aaaaaa");
  doc.font(fn).fontSize(8.5).fillColor("#333333").text(request.expectedOutcome || "", L + 4, y + 4, { width: CW - 8, height: outH - 8, lineBreak: true });
  y += outH + 8;

  doc.font(fb).fontSize(8.5).fillColor("#111111").text("Contact address and phone while on travel:", L, y);
  y += 13;
  const ctH = 24;
  doc.rect(L, y, CW, ctH).stroke("#aaaaaa");
  doc.font(fn).fontSize(8.5).fillColor("#333333").text(request.contactWhileTravelling || "", L + 4, y + 4, { width: CW - 8, height: ctH - 8, lineBreak: true });
  y += ctH + 10;

  doc.font(fn).fontSize(8.5).fillColor("#111111");
  doc.text(`Total cost estimate (Rs.): ${fmtAmount(request.estimatedCost) || "—"}`, L, y);
  y += 14;
  doc.text(`Additional details: ${request.otherInstructions || "—"}`, L, y, { width: CW });
  y += 20;

  drawSignOffSection(doc, fn, fb, y, trail, settlement);

  doc.end();
  return promise;
}

// ── Public exports ────────────────────────────────────────────────────────────

export function generateCstepTourProposalPdf(
  request: ICstepTravelRequest,
  traveller: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
  settlement?: CstepSettlementPdfData,
): Promise<Buffer> {
  if (request.type === "INTERNATIONAL") return generateInternationalProposalPdf(request, traveller, trail, settlement);
  return generateDomesticProposalPdf(request, traveller, trail, settlement);
}

export async function uploadCstepTourProposalPdf(
  request: ICstepTravelRequest,
  traveller: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
  settlement?: CstepSettlementPdfData,
): Promise<{ key: string }> {
  const buf = await generateCstepTourProposalPdf(request, traveller, trail, settlement);
  const key = `cstep-tour-proposals/${request.workspaceId}/${request._id}/proposal-${Date.now()}.pdf`;
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
