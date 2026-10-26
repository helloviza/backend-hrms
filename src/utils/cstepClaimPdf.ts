// apps/backend/src/utils/cstepClaimPdf.ts
//
// CSTEP Travel & Claim Portal — the claim PDFs (claims addition). One shared
// scaffold (header, claim header table, totals block, sign-off) with a body
// per claim type:
//
// Expense Claim (module 2): the Expenses table (date / description / amount
// / invoice), then subtotal, tax, total, less advance and the amount due BY
// or TO CSTEP, with the project as the "bill to". The tax invoice is
// required on submit, so it normally carries no Declaration; one only
// prints if an item somehow has no invoice at all (see claimDeclarationItems).
//
// Local Travel Claim (module 1): claimant + claim header on top, the Travel table
// (date / from / to / mode / fare / bill), the Food table, the totals block
// net of the advance (amount due BY CSTEP to the claimant, or TO CSTEP from
// the claimant — both shown, never zeroed), the auto-generated "Declaration
// (where no supports available)" listing every item with no bill (see
// claimDeclarationItems), and a sign-off area.
//
// Declaration form (#8): the same items as a standalone, signable
// self-declaration PDF of their own (generateCstepClaimDeclarationPdf) —
// generated at claim submission and regenerated whenever the invoice-less
// set changes (routes/cstep.ts ensureClaimDeclaration). A Tour / Event's
// travel report uses the same form for its legs marked "No bill
// available", generated at report submission.
//
// Signatures follow the Event Request PDF's rule: the system is the source
// of truth, so a line prints a text-based DIGITAL signature only once that
// stage has genuinely happened in the CstepApproval `trail` — Claimant at
// SUBMIT, Approver at APPROVE, Admin at ADMIN_VERIFY, Finance at
// FINANCE_SETTLE — and stays a blank line for wet signing until then.
//
// Deliberately a PARALLEL renderer, the same way cstepEventRequestPdf.ts is
// one next to cstepTourProposalPdf.ts: same library (pdfkit), fonts, logo
// and S3-upload pattern, its own copies of the small drawing helpers, so it
// can never destabilize the other two. Only the shared TYPES are imported.

import PDFDocument from "pdfkit";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";
import type { ICstepTravelRequest } from "../models/cstep/CstepTravelRequest.js";
import type { ICstepReportLeg } from "../models/cstep/CstepReportLeg.js";
import type { CstepTravellerInfo, CstepApprovalTrailEntry } from "./cstepTourProposalPdf.js";

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

/** The verified figures, once the claim's settlement exists (from approve). */
export interface CstepClaimSettlementPdfData {
  status?: string; // "VERIFYING" | "FINALIZED"
  amountClaimed?: number;
  advanceTaken?: number;
  amountDueByCstep?: number;
  amountDueToCstep?: number;
}

// ── Page geometry ─────────────────────────────────────────────────────────────
const PG_W = 595.28;
const M = 40;
const CW = PG_W - 2 * M;
const L = M;
const PAGE_BOTTOM = 790;

// ── Helpers ───────────────────────────────────────────────────────────────────

const MODE_LABELS: Record<string, string> = {
  CAB: "Cab",
  LOCAL_TAXI: "Local taxi",
  METRO: "Metro",
  BUS: "Bus",
  OWN_VEHICLE: "Own vehicle",
};

function fmtDate(d?: string): string {
  if (!d) return "";
  const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return d;
}

function fmtDateRange(from?: string, to?: string): string {
  const f = fmtDate(from);
  const t = fmtDate(to);
  if (f && t) return `${f} to ${t}`;
  return f || t || "";
}

/** NotoSans has no "→" glyph (it prints as a box), so the PDFs say "to". */
function pdfText(s: string): string {
  return s.replace(/ → /g, " to ");
}

function inr(n?: number): string {
  return `₹${(Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The self-declaration statement — on the standalone Declaration form and in
 * the claim PDF's Declaration section alike.
 * PLACEHOLDER WORDING — to be confirmed by CSTEP (their exact legal text).
 */
export const CLAIM_DECLARATION_TEXT =
  "I hereby declare that the expenses listed above were genuinely incurred by me for official purposes, and that no bill or invoice is available for them.";

export type CstepClaimDeclarationKind = "TRAVEL" | "FOOD" | "OTHER" | "EXPENSE" | "REPORT_LEG";

const SERVICE_LABELS: Record<string, string> = {
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

/** One row of the claim's "Declaration (where no supports available)". */
export interface CstepClaimDeclarationEntry {
  lineId: string; // the claim line's _id; "otherExpenses" for the Local Travel lump sum
  kind: CstepClaimDeclarationKind;
  date?: string; // "YYYY-MM-DD"
  particulars: string;
  amount: number;
  currency?: string; // a report leg's own currency; claim lines are always INR
}

/** The report-leg fields the Declaration reads. */
export type CstepDeclarationReportLeg = Pick<
  ICstepReportLeg,
  "_id" | "direction" | "travelMode" | "fromLocation" | "toLocation" | "fromDate" | "fare" | "currency" | "remarks" | "attachmentId" | "noBill"
>;

/**
 * The Declaration: every claim item with no bill or invoice attached, in form
 * order. The ONE derivation the claim PDF's section, the standalone
 * Declaration form and the claim detail view (GET /requests/:id's
 * claimDeclaration) all use, so they can never disagree.
 *   Local Travel — a travel line with no receipt (marked "no bill"), a food
 *     line with no receipt, and the "Other expenses" amount (it has nowhere
 *     to attach one).
 *   Expense — a line with no invoice of its own when the claim has no
 *     claim-level tax invoice either (submit requires one, so normally none).
 * Tours / Events: every travel-report leg marked "No bill available" (and
 *   with no document) — report/submit requires one or the other on every
 *   leg. Onward legs first, then Return, each in the order given.
 */
export function claimDeclarationItems(
  request: Pick<ICstepTravelRequest, "formType" | "travelLines" | "foodLines" | "otherExpenses" | "expenseLines" | "invoiceAttachmentIds">,
  reportLegs: CstepDeclarationReportLeg[] = [],
): CstepClaimDeclarationEntry[] {
  if (request.formType === "LOCAL_TRAVEL_CLAIM") {
    const travel = (request.travelLines || [])
      .filter((l) => !l.attachmentId)
      .map((l) => ({
        lineId: String(l._id || ""),
        kind: "TRAVEL" as const,
        date: l.date,
        particulars: `${MODE_LABELS[l.mode || ""] || "Travel"}: ${[l.from, l.to].filter(Boolean).join(" → ")}${l.remarks ? ` — ${l.remarks}` : ""}`,
        amount: Number(l.fare) || 0,
      }));
    const food = (request.foodLines || [])
      .filter((l) => !l.attachmentId)
      .map((l) => ({
        lineId: String(l._id || ""),
        kind: "FOOD" as const,
        date: l.date,
        particulars: `Food${l.remarks ? `: ${l.remarks}` : ""}`,
        amount: Number(l.amount) || 0,
      }));
    const other = Number(request.otherExpenses) > 0
      ? [{ lineId: "otherExpenses", kind: "OTHER" as const, date: undefined, particulars: "Other expenses", amount: Number(request.otherExpenses) }]
      : [];
    return [...travel, ...food, ...other];
  }
  if (request.formType === "EXPENSE_CLAIM") {
    if ((request.invoiceAttachmentIds || []).length > 0) return [];
    return (request.expenseLines || [])
      .filter((l) => !l.attachmentId)
      .map((l) => ({
        lineId: String(l._id || ""),
        kind: "EXPENSE" as const,
        date: l.date,
        particulars: l.description || "Expense",
        amount: Number(l.amount) || 0,
      }));
  }
  const declared = reportLegs.filter((l) => l.noBill === true && !l.attachmentId);
  return [...declared.filter((l) => l.direction === "ONWARD"), ...declared.filter((l) => l.direction !== "ONWARD")].map((l) => {
    // A booked leg seeded from its arrangement often has no route of its own —
    // its remarks (the arranged details) say what it was instead.
    const route = [l.fromLocation, l.toLocation].filter(Boolean).join(" → ");
    return {
      lineId: String(l._id || ""),
      kind: "REPORT_LEG" as const,
      date: l.fromDate,
      particulars: `${l.direction === "ONWARD" ? "Onward" : "Return"} ${SERVICE_LABELS[l.travelMode] || l.travelMode}${route ? `: ${route}` : ""}${l.remarks ? ` — ${l.remarks}` : ""}`,
      amount: Number(l.fare) || 0,
      currency: (l.currency || "INR").toUpperCase(),
    };
  });
}

/** An item's amount in its own currency — ₹ for INR (every claim line). */
function itemMoney(d: CstepClaimDeclarationEntry): string {
  if (!d.currency || d.currency === "INR") return inr(d.amount);
  return `${d.currency} ${(Number(d.amount) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The items' total — one figure per currency, never summed across them. */
function itemsTotal(items: CstepClaimDeclarationEntry[]): string {
  const byCurrency = new Map<string, number>();
  for (const d of items) {
    const c = d.currency || "INR";
    byCurrency.set(c, (byCurrency.get(c) || 0) + (Number(d.amount) || 0));
  }
  if (byCurrency.size === 0) return inr(0);
  return [...byCurrency].map(([currency, amount]) => itemMoney({ currency, amount } as CstepClaimDeclarationEntry)).join(" + ");
}

/** What the Declaration form shows, hashed — the cache key: the form is
 * regenerated whenever any of it changes (an item added, removed or
 * re-amounted, the reference issued, the claimant renamed, a resubmission). */
export function claimDeclarationHash(input: {
  items: CstepClaimDeclarationEntry[];
  claimantName: string;
  claimReference?: string;
  formType?: string;
  submittedAt?: string;
}): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

type CstepSignature = { name: string; date: string };

function fmtSignatureDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/** Latest entry of the given action — a returned-and-resubmitted claim signs
 * with its most recent submission, a re-verified one with its latest
 * verification. */
function latestEntryOfAction(trail: CstepApprovalTrailEntry[], action: string): CstepApprovalTrailEntry | undefined {
  const matches = trail.filter((e) => e.action === action);
  if (matches.length === 0) return undefined;
  return matches.reduce((latest, e) => (new Date(e.at).getTime() > new Date(latest.at).getTime() ? e : latest));
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

function ensureRoom(doc: PdfDoc, y: number, h: number): number {
  if (y + h > PAGE_BOTTOM) {
    doc.addPage();
    return M;
  }
  return y;
}

function sectionTitle(doc: PdfDoc, fb: string, y: number, title: string): number {
  y = ensureRoom(doc, y, 40);
  doc.font(fb).fontSize(10).fillColor("#091426").text(title, L, y);
  return y + 16;
}

/** A ruled table: header row + one row per entry, widths as fractions of CW. */
function drawTable(
  doc: PdfDoc,
  fn: string,
  fb: string,
  y: number,
  columns: Array<{ label: string; frac: number; align?: "left" | "center" | "right" }>,
  rows: string[][],
): number {
  const widths = columns.map((c) => Math.round(CW * c.frac));
  widths[widths.length - 1] = CW - widths.slice(0, -1).reduce((a, b) => a + b, 0);
  const RH = 20;

  const header = (yy: number) => {
    let x = L;
    columns.forEach((c, i) => {
      drawCell(doc, fn, fb, x, yy, widths[i], RH, c.label, { header: true, size: 8, align: c.align });
      x += widths[i];
    });
    return yy + RH;
  };

  y = ensureRoom(doc, y, RH * 2);
  y = header(y);
  for (const row of rows) {
    if (y + RH > PAGE_BOTTOM) {
      doc.addPage();
      y = header(M);
    }
    let x = L;
    row.forEach((text, i) => {
      drawCell(doc, fn, fb, x, y, widths[i], RH, text, { size: 8, align: columns[i].align });
      x += widths[i];
    });
    y += RH;
  }
  return y;
}

/** A Tour Proposal / Event Request — its Declaration covers travel-report
 * legs, so the form speaks of the traveller and the tour, not a claim. */
function isTravelReportForm(request: Pick<ICstepTravelRequest, "formType">): boolean {
  return request.formType === "TOUR_PROPOSAL" || request.formType === "EVENT_REQUEST";
}

function drawHeaderBlock(doc: PdfDoc, fn: string, fb: string, y: number, request: ICstepTravelRequest, title: string): number {
  const report = isTravelReportForm(request);
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
    .text(`(Generated by the Plumtrips CSTEP Portal — ${report ? "travel report" : "reimbursement claim"})`, L, y, { width: CW, align: "center" });
  y += 16;

  const statusLine = [`Status: ${request.status}`, request.claimReference ? `${report ? "Ref" : "Claim ref"}: ${request.claimReference}` : null]
    .filter(Boolean)
    .join("     ");
  doc.font(fb).fontSize(9).fillColor("#091426").text(statusLine, L, y, { width: CW, align: "center" });
  return y + 18;
}

/** One ruled line + caption pair in two columns; prints the digital
 * signature where the wet one would sit once that stage has happened. */
function drawSignatureLinePair(
  doc: PdfDoc,
  fn: string,
  fb: string,
  y: number,
  captions: [string, string],
  signed: [CstepSignature | null, CstepSignature | null],
): number {
  const gap = 24;
  const colW = Math.round((CW - gap) / 2);
  const positions = [L, L + colW + gap];
  const lineY = y + 24;

  for (let i = 0; i < 2; i++) {
    const x = positions[i];
    doc.strokeColor("#333333").lineWidth(0.75).moveTo(x, lineY).lineTo(x + colW, lineY).stroke();
    const info = signed[i];
    if (info) doc.font(fb).fontSize(9.5).fillColor("#091426").text(info.name, x, lineY - 13, { width: colW, lineBreak: false });
  }
  const capY = lineY + 4;
  for (let i = 0; i < 2; i++) {
    const info = signed[i];
    doc
      .font(fn)
      .fontSize(info ? 7 : 8)
      .fillColor(info ? "#6b7280" : "#333333")
      .text(info ? `Digitally signed via CSTEP portal · ${info.date}` : "Date: ____________________", positions[i], capY);
  }
  doc.font(fn).fontSize(8).fillColor("#444444").text(captions[0], positions[0], capY + 14, { width: colW });
  doc.font(fn).fontSize(8).fillColor("#444444").text(captions[1], positions[1], capY + 14, { width: colW });
  return capY + 34;
}

// ── Local Travel Claim PDF ────────────────────────────────────────────────────

function generateLocalTravelClaimPdf(
  request: ICstepTravelRequest,
  claimant: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
  settlement?: CstepClaimSettlementPdfData,
): Promise<Buffer> {
  const { doc, fn, fb, collect } = makePdf("Local Travel Claim");
  const promise = collect();

  let y = drawHeaderBlock(doc, fn, fb, M, request, "LOCAL TRAVEL CLAIM");

  y = drawClaimHeaderTable(doc, fn, fb, y, request, claimant, "Project to be debited");
  y += 14;

  // Travel lines.
  const travelLines = request.travelLines || [];
  y = sectionTitle(doc, fb, y, "Travel");
  if (travelLines.length) {
    y = drawTable(
      doc,
      fn,
      fb,
      y,
      [
        { label: "#", frac: 0.05, align: "center" },
        { label: "Date", frac: 0.13 },
        { label: "From", frac: 0.2 },
        { label: "To", frac: 0.2 },
        { label: "Mode", frac: 0.13 },
        { label: "Fare", frac: 0.15, align: "right" },
        { label: "Bill", frac: 0.14, align: "center" },
      ],
      travelLines.map((l, i) => [
        String(i + 1),
        fmtDate(l.date),
        l.from || "",
        l.to || "",
        MODE_LABELS[l.mode || ""] || "",
        inr(l.fare),
        l.noBill ? "No bill" : l.attachmentId ? "Attached" : "",
      ]),
    );
  } else {
    doc.font(fn).fontSize(8.5).fillColor("#555555").text("No travel lines.", L, y);
    y += 14;
  }
  y += 12;

  // Food lines.
  const foodLines = request.foodLines || [];
  y = sectionTitle(doc, fb, y, "Food");
  if (foodLines.length) {
    y = drawTable(
      doc,
      fn,
      fb,
      y,
      [
        { label: "#", frac: 0.05, align: "center" },
        { label: "Date", frac: 0.13 },
        { label: "Remarks", frac: 0.53 },
        { label: "Amount", frac: 0.15, align: "right" },
        { label: "Bill", frac: 0.14, align: "center" },
      ],
      foodLines.map((l, i) => [String(i + 1), fmtDate(l.date), l.remarks || "", inr(l.amount), l.attachmentId ? "Attached" : "—"]),
    );
  } else {
    doc.font(fn).fontSize(8.5).fillColor("#555555").text("No food lines.", L, y);
    y += 14;
  }
  y += 14;

  // Totals — the claimant's own figures, then the verified ones if any.
  const t = request.claimTotals;
  y = sectionTitle(doc, fb, y, "Totals");
  y = drawTotalsBlock(doc, fn, fb, y, [
    ["Total travel", inr(t?.travel), false],
    ["Total food", inr(t?.food), false],
    ["Other expenses", inr(t?.other), false],
    ["Total claimed", inr(t?.gross), true],
    ["Less: advance taken", inr(t?.advance), false],
    t && t.dueToCstep > 0 ? ["Amount due to CSTEP", inr(t.dueToCstep), true] : ["Amount due by CSTEP", inr(t?.dueByCstep), true],
    ...verifiedTotalRows(settlement),
  ]);
  y += 14;

  // Declaration — every item with no bill (claimDeclarationItems).
  const declaration = claimDeclarationItems(request);
  if (declaration.length) {
    y = sectionTitle(doc, fb, y, "Declaration (where no supports available)");
    y = drawTable(
      doc,
      fn,
      fb,
      y,
      [
        { label: "#", frac: 0.05, align: "center" },
        { label: "Date", frac: 0.13 },
        { label: "Particulars", frac: 0.62 },
        { label: "Amount", frac: 0.2, align: "right" },
      ],
      declaration.map((d, i) => [String(i + 1), fmtDate(d.date), pdfText(d.particulars), inr(d.amount)]),
    );
    y = ensureRoom(doc, y + 6, 30);
    doc
      .font(fn)
      .fontSize(8.5)
      .fillColor("#111111")
      .text(CLAIM_DECLARATION_TEXT, L, y, { width: CW });
    y += 26;
  }

  drawClaimSignOff(doc, fn, fb, y, trail);

  doc.end();
  return promise;
}

// ── Declaration form (#8) ─────────────────────────────────────────────────────

/** The standalone self-declaration for a claim's items with no bill: the
 * claim header, the items with their total, the statement, and the
 * claimant's signature — digital once the claim has been submitted (the
 * claim PDF's rule), a blank line for wet signing until then. */
function generateClaimDeclarationPdf(
  request: ICstepTravelRequest,
  claimant: CstepTravellerInfo,
  items: CstepClaimDeclarationEntry[],
  trail: CstepApprovalTrailEntry[],
): Promise<Buffer> {
  const { doc, fn, fb, collect } = makePdf("Declaration — expenses without bills");
  const promise = collect();
  const report = isTravelReportForm(request);

  let y = drawHeaderBlock(doc, fn, fb, M, request, "SELF-DECLARATION — EXPENSES WITHOUT BILLS");
  y = drawClaimHeaderTable(
    doc,
    fn,
    fb,
    y,
    request,
    claimant,
    request.formType === "EXPENSE_CLAIM" ? "Project (bill to)" : "Project to be debited",
  );
  y += 14;

  y = sectionTitle(doc, fb, y, "Items without a bill or invoice");
  y = drawTable(
    doc,
    fn,
    fb,
    y,
    [
      { label: "#", frac: 0.05, align: "center" },
      { label: "Date", frac: 0.13 },
      { label: "Description", frac: 0.62 },
      { label: "Amount", frac: 0.2, align: "right" },
    ],
    items.map((d, i) => [String(i + 1), d.date ? fmtDate(d.date) : report ? "" : "Claim period", pdfText(d.particulars), itemMoney(d)]),
  );
  y = drawTotalsBlock(doc, fn, fb, y + 6, [["Total without bills", itemsTotal(items), true]]);
  y += 14;

  y = ensureRoom(doc, y, 60);
  doc.font(fb).fontSize(10).fillColor("#111111").text("Declaration", L, y);
  y += 16;
  doc.font(fn).fontSize(9.5).fillColor("#111111").text(CLAIM_DECLARATION_TEXT, L, y, { width: CW });
  y = doc.y + 30;

  y = ensureRoom(doc, y, 80);
  // A travel report signs with its latest report submission (a returned
  // report is resubmitted the same way), a claim with its latest submit.
  const signed = signatureFromEntry(
    report ? latestEntryOfAction(trail, "SUBMIT_REPORT") : latestEntryOfAction(trail, "SUBMIT") || latestEntryOfAction(trail, "RESUBMIT"),
  );
  const colW = Math.round((CW - 24) / 2);
  const lineY = y + 24;
  doc.strokeColor("#333333").lineWidth(0.75).moveTo(L, lineY).lineTo(L + colW, lineY).stroke();
  if (signed) doc.font(fb).fontSize(9.5).fillColor("#091426").text(signed.name, L, lineY - 13, { width: colW, lineBreak: false });
  doc
    .font(fn)
    .fontSize(signed ? 7 : 8)
    .fillColor(signed ? "#6b7280" : "#333333")
    .text(signed ? `Digitally signed via CSTEP portal · ${signed.date}` : "Date: ____________________", L, lineY + 4);
  doc.font(fn).fontSize(8).fillColor("#444444").text(`Signature of the ${report ? "traveller" : "claimant"} — ${claimant.name}`, L, lineY + 18, { width: colW });
  doc.font(fn).fontSize(8).fillColor("#444444").text("Place: ____________________", L + colW + 24, lineY + 4, { width: colW });

  doc.end();
  return promise;
}

/** The claim sign-off, shared by both claim types: Claimant (SUBMIT /
 * RESUBMIT) + Approver (APPROVE), then CSTEP Admin (ADMIN_VERIFY) + Finance
 * (FINANCE_SETTLE) — each digital once that stage has happened. */
function drawClaimSignOff(doc: PdfDoc, fn: string, fb: string, y: number, trail: CstepApprovalTrailEntry[]) {
  y = ensureRoom(doc, y + 6, 150);
  y = drawSignatureLinePair(
    doc,
    fn,
    fb,
    y,
    ["Signature of the claimant", "Approved by (Approver)"],
    [signatureFromEntry(latestEntryOfAction(trail, "SUBMIT") || latestEntryOfAction(trail, "RESUBMIT")), signatureFromEntry(latestEntryOfAction(trail, "APPROVE"))],
  );
  y += 8;
  drawSignatureLinePair(
    doc,
    fn,
    fb,
    y,
    ["Verified by (CSTEP Admin)", "Settled by (Finance)"],
    [signatureFromEntry(latestEntryOfAction(trail, "ADMIN_VERIFY")), signatureFromEntry(latestEntryOfAction(trail, "FINANCE_SETTLE"))],
  );
}

/** The claim header table both claim types open with. `projectLabel` is
 * "Project to be debited" (Local Travel) or "Project (bill to)" (Expense). */
function drawClaimHeaderTable(
  doc: PdfDoc,
  fn: string,
  fb: string,
  y: number,
  request: ICstepTravelRequest,
  claimant: CstepTravellerInfo,
  projectLabel: string,
): number {
  const LW = Math.round(CW * 0.32);
  const VW = CW - LW;
  const report = isTravelReportForm(request);
  const rows: [string, string, number][] = [
    [
      report ? "Traveller" : "Claimant",
      `${claimant.name}${claimant.gender ? ` (${claimant.gender})` : ""}${claimant.travelerId ? " | ID: " + claimant.travelerId : ""}`,
      22,
    ],
    ["Purpose", request.purpose || "", 30],
    [projectLabel, [request.project, request.projectDebitable].filter(Boolean).join(" — "), 22],
    [report ? "Travel period" : "Claim period", fmtDateRange(request.departureDate, request.returnDate), 22],
  ];
  if (request.otherInstructions) rows.push(["Remarks", request.otherInstructions, 30]);
  for (const [label, value, rh] of rows) {
    y = ensureRoom(doc, y, rh);
    drawCell(doc, fn, fb, L, y, LW, rh, label, { bold: true });
    drawCell(doc, fn, fb, L + LW, y, VW, rh, value);
    y += rh;
  }
  return y;
}

/** A right-aligned two-column totals block. */
function drawTotalsBlock(doc: PdfDoc, fn: string, fb: string, y: number, rows: Array<[string, string, boolean]>): number {
  const TW = Math.round(CW * 0.5);
  for (const [label, value, bold] of rows) {
    y = ensureRoom(doc, y, 20);
    drawCell(doc, fn, fb, L + CW - TW * 2, y, TW, 20, label, { bold });
    drawCell(doc, fn, fb, L + CW - TW, y, TW, 20, value, { bold, align: "right" });
    y += 20;
  }
  return y;
}

/** The verified (settlement) rows appended to a claim's totals block. */
function verifiedTotalRows(settlement?: CstepClaimSettlementPdfData): Array<[string, string, boolean]> {
  if (!settlement) return [];
  const label = settlement.status === "FINALIZED" ? "Verified" : "Under verification";
  return [
    [`${label}: amount claimed`, inr(settlement.amountClaimed), false],
    Number(settlement.amountDueToCstep) > 0
      ? [`${label}: due to CSTEP`, inr(settlement.amountDueToCstep), true]
      : [`${label}: due by CSTEP`, inr(settlement.amountDueByCstep), true],
  ];
}

// ── Expense Claim PDF ─────────────────────────────────────────────────────────

function generateExpenseClaimPdf(
  request: ICstepTravelRequest,
  claimant: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
  settlement?: CstepClaimSettlementPdfData,
): Promise<Buffer> {
  const { doc, fn, fb, collect } = makePdf("Expense Claim");
  const promise = collect();

  let y = drawHeaderBlock(doc, fn, fb, M, request, "EXPENSE CLAIM");
  y = drawClaimHeaderTable(doc, fn, fb, y, request, claimant, "Project (bill to)");
  y += 14;

  const lines = request.expenseLines || [];
  const invoices = request.invoiceAttachmentIds || [];
  y = sectionTitle(doc, fb, y, "Expenses");
  y = drawTable(
    doc,
    fn,
    fb,
    y,
    [
      { label: "#", frac: 0.05, align: "center" },
      { label: "Date", frac: 0.13 },
      { label: "Description", frac: 0.5 },
      { label: "Amount", frac: 0.17, align: "right" },
      { label: "Invoice", frac: 0.15, align: "center" },
    ],
    lines.map((l, i) => [
      String(i + 1),
      fmtDate(l.date),
      l.description || "",
      inr(l.amount),
      l.attachmentId ? "Attached" : invoices.length ? "Claim invoice" : "",
    ]),
  );
  y += 14;

  const t = request.claimTotals;
  y = sectionTitle(doc, fb, y, "Totals");
  y = drawTotalsBlock(doc, fn, fb, y, [
    ["Subtotal", inr(t?.subtotal), false],
    ["Tax (IGST)", inr(t?.tax), false],
    ["Total", inr(t?.gross), true],
    ["Less: advance taken", inr(t?.advance), false],
    t && t.dueToCstep > 0 ? ["Amount due to CSTEP", inr(t.dueToCstep), true] : ["Amount due by CSTEP", inr(t?.dueByCstep), true],
    ["Project (bill to)", [request.project, request.projectDebitable].filter(Boolean).join(" — ") || "—", false],
    ...verifiedTotalRows(settlement),
  ]);
  y += 8;
  y = ensureRoom(doc, y, 20);
  const lineInvoices = lines.filter((l) => l.attachmentId).length;
  doc
    .font(fn)
    .fontSize(8.5)
    .fillColor("#555555")
    .text(
      invoices.length || lineInvoices
        ? `Tax invoice(s) attached: ${invoices.length} for the whole claim, ${lineInvoices} on individual lines.`
        : "No tax invoice attached.",
      L,
      y,
      { width: CW },
    );
  y += 18;

  // Declaration — only if an item has no invoice at all (normally none).
  const declaration = claimDeclarationItems(request);
  if (declaration.length) {
    y = sectionTitle(doc, fb, y, "Declaration (where no supports available)");
    y = drawTable(
      doc,
      fn,
      fb,
      y,
      [
        { label: "#", frac: 0.05, align: "center" },
        { label: "Date", frac: 0.13 },
        { label: "Particulars", frac: 0.62 },
        { label: "Amount", frac: 0.2, align: "right" },
      ],
      declaration.map((d, i) => [String(i + 1), fmtDate(d.date), pdfText(d.particulars), inr(d.amount)]),
    );
    y = ensureRoom(doc, y + 6, 30);
    doc.font(fn).fontSize(8.5).fillColor("#111111").text(CLAIM_DECLARATION_TEXT, L, y, { width: CW });
    y += 26;
  }

  drawClaimSignOff(doc, fn, fb, y, trail);
  doc.end();
  return promise;
}

// ── Public exports ────────────────────────────────────────────────────────────

export function generateCstepLocalTravelClaimPdf(
  request: ICstepTravelRequest,
  claimant: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
  settlement?: CstepClaimSettlementPdfData,
): Promise<Buffer> {
  return generateLocalTravelClaimPdf(request, claimant, trail, settlement);
}

export async function uploadCstepLocalTravelClaimPdf(
  request: ICstepTravelRequest,
  claimant: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
  settlement?: CstepClaimSettlementPdfData,
): Promise<{ key: string }> {
  const buf = await generateCstepLocalTravelClaimPdf(request, claimant, trail, settlement);
  const key = `cstep-claims/${request.workspaceId}/${request._id}/local-travel-claim-${Date.now()}.pdf`;
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

export function generateCstepExpenseClaimPdf(
  request: ICstepTravelRequest,
  claimant: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
  settlement?: CstepClaimSettlementPdfData,
): Promise<Buffer> {
  return generateExpenseClaimPdf(request, claimant, trail, settlement);
}

export async function uploadCstepExpenseClaimPdf(
  request: ICstepTravelRequest,
  claimant: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
  settlement?: CstepClaimSettlementPdfData,
): Promise<{ key: string }> {
  const buf = await generateCstepExpenseClaimPdf(request, claimant, trail, settlement);
  const key = `cstep-claims/${request.workspaceId}/${request._id}/expense-claim-${Date.now()}.pdf`;
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

export function generateCstepClaimDeclarationPdf(
  request: ICstepTravelRequest,
  claimant: CstepTravellerInfo,
  items: CstepClaimDeclarationEntry[],
  trail: CstepApprovalTrailEntry[],
): Promise<Buffer> {
  return generateClaimDeclarationPdf(request, claimant, items, trail);
}

export async function uploadCstepClaimDeclarationPdf(
  request: ICstepTravelRequest,
  claimant: CstepTravellerInfo,
  items: CstepClaimDeclarationEntry[],
  trail: CstepApprovalTrailEntry[],
): Promise<{ key: string }> {
  const buf = await generateCstepClaimDeclarationPdf(request, claimant, items, trail);
  const key = `cstep-claims/${request.workspaceId}/${request._id}/declaration-${Date.now()}.pdf`;
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
