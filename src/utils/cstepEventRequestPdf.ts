// apps/backend/src/utils/cstepEventRequestPdf.ts
//
// CSTEP Travel & Claim Portal — Event Request PDF (Event Request addition;
// digital-signature pass). The printable paper form for the Event Request
// proforma: the filled event details on top (title, participants, host
// institution, nature/duration/location/venue, registration fee, funds
// availability, etc.), and a sign-off / committee-decision area at the
// bottom for the odd physical copy — Proposer/Host-Institution signature +
// date lines, then a "For Committee / Admin decision only" block (decision
// line, blank remarks box, Admin + Committee Chair signature lines). No
// claim/expense/settlement table here — Event Request never opens a
// CstepClaim (see routes/cstep.ts's approve handler); that's Tour-
// Proposal-only.
//
// The system is the source of truth: the Proposer line prints a text-based
// DIGITAL signature (name + "Digitally signed via CSTEP portal · <date>")
// once the request has been submitted (SUBMIT), and the Committee Chair
// line does the same once it's been approved (APPROVE) — both read from
// the CstepApproval `trail` already passed into this renderer. Host
// Institution and Admin verification stay blank always: neither role has a
// corresponding recorded action to derive a signature from. A stage that
// hasn't happened yet stays a genuinely blank line for wet signing. The
// full audit trail is NOT printed as a table here — only these inline
// signature lines; the trail itself stays on the on-screen detail view
// only.
//
// Deliberately a PARALLEL renderer, mirroring utils/cstepTourProposalPdf.ts's
// own approach (itself a parallel renderer next to utils/travelFormPdf.ts):
// same library (pdfkit), same fonts/logo assets, same S3-upload-then-presign
// pattern, own copies of the small drawing helpers — so this file never
// touches, and can never destabilize, the Tour Proposal PDF. Only the
// CstepTravellerInfo/CstepApprovalTrailEntry TYPES are imported from that
// file (a read-only reference to its exported shapes, not its rendering
// code) so both renderers agree on what data they're handed.

import PDFDocument from "pdfkit";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";
import type { ICstepTravelRequest, ICstepEventParticipantEntry } from "../models/cstep/CstepTravelRequest.js";
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

// ── Page geometry ─────────────────────────────────────────────────────────────
const PG_W = 595.28;
const M = 40;
const CW = PG_W - 2 * M;
const L = M;

// ── Helpers ───────────────────────────────────────────────────────────────────

const EVENT_NATURE_LABELS: Record<string, string> = {
  WORKSHOP: "Workshop",
  CONFERENCE: "Conference",
  SEMINAR: "Seminar",
  OTHER: "Other",
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

function eventNatureLabel(request: ICstepTravelRequest): string {
  if (!request.eventNature) return "";
  const label = EVENT_NATURE_LABELS[request.eventNature] || request.eventNature;
  if (request.eventNature === "OTHER" && request.eventNatureOther) {
    return `Other (${request.eventNatureOther})`;
  }
  return label;
}

function yesNo(flag?: boolean, note?: string): string {
  if (!flag) return "No";
  return note && note.trim() ? `Yes — ${note.trim()}` : "Yes";
}

function fmtAmount(n?: number): string {
  if (!n) return "";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function participantLines(participants?: ICstepEventParticipantEntry[]): string[] {
  if (!participants) return [];
  return participants
    .filter((p) => p.organisation)
    .map((p) => `${p.organisation}${p.count != null ? ` — ${p.count}` : ""}`);
}

// ── Digital signatures (read from the audit trail, print-only) ───────────────
// Own copy of the same small helpers cstepTourProposalPdf.ts uses — kept
// duplicated rather than imported, matching this file's existing "own
// copies of the small drawing helpers" isolation (see module note): only
// TYPES cross the file boundary, never rendering/derivation logic.

type CstepSignature = { name: string; date: string };

function fmtSignatureDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/** Earliest entry of the given action, or undefined if that stage never
 * happened. */
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

function drawHeaderBlock(doc: PdfDoc, fn: string, fb: string, y: number, request: ICstepTravelRequest): number {
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, L, y, { width: 80 });
    y += 40;
  }

  doc.font(fb).fontSize(14).fillColor("#111111").text("EVENT REQUEST", L, y, { width: CW, align: "center" });
  y += 20;
  doc
    .font(fn)
    .fontSize(8)
    .fillColor("#555555")
    .text("(Generated by the Plumtrips CSTEP Portal — pre-event request only)", L, y, { width: CW, align: "center" });
  y += 16;

  const statusLine = [`Status: ${request.status}`, request.claimReference ? `TIN: ${request.claimReference}` : null]
    .filter(Boolean)
    .join("     ");
  doc.font(fb).fontSize(9).fillColor("#091426").text(statusLine, L, y, { width: CW, align: "center" });
  y += 18;

  return y;
}

// ── Sign-off / committee-decision section ─────────────────────────────────────
// The Proposer and Committee Chair lines print a digital signature when
// that stage has genuinely happened (see drawSignOffSection); Host
// Institution and Admin verification always stay blank — see module note.

/** One ruled line + caption underneath, side by side in two columns — BLANK
 * for hand-signing unless that side's `signed` info is supplied, in which
 * case the person's name prints where the wet signature would sit (same
 * ruled-line position either way) and "Digitally signed via CSTEP portal ·
 * <date>" prints in place of the blank "Date: ____" line. `withDateLine`:
 * also prints a "Date: ____" line (or the digital-signature date line)
 * between the ruled line and the caption. */
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
  const sigSpace = 24;
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
  // signature to print — so a signed Committee Chair still gets its
  // "Digitally signed..." line even on the Admin/Committee-Chair pair
  // (withDateLine=false, captions fold "and date" into themselves), while a
  // fully-blank pair renders byte-for-byte as before (no extra row).
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

/** Blank decision line + blank remarks box for the committee/admin. */
function drawCommitteeDecisionBlock(doc: PdfDoc, fn: string, fb: string, y: number): number {
  doc.font(fb).fontSize(9).fillColor("#555555").text("For Committee / Admin decision only", L, y, { width: CW, align: "center" });
  y += 16;

  doc.font(fn).fontSize(8.5).fillColor("#111111").text("Decision:   (   ) Approved      (   ) Not Approved", L, y);
  y += 18;

  doc.font(fn).fontSize(8.5).fillColor("#111111").text("Remarks:", L, y);
  y += 13;
  const remarksH = 40;
  doc.rect(L, y, CW, remarksH).stroke("#aaaaaa");
  y += remarksH + 10;

  return y;
}

/** The sign-off section: Proposer signature (digital once SUBMIT has
 * happened; Host Institution always blank — no corresponding recorded
 * action), the committee decision block (always blank), and the Admin/
 * Committee-Chair pair (Admin always blank; Committee Chair digital once
 * APPROVE has happened). Paginates if it would run off the page. */
function drawSignOffSection(doc: PdfDoc, fn: string, fb: string, y: number, trail: CstepApprovalTrailEntry[]): number {
  const ESTIMATED_HEIGHT = 260;
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
    "Signature of Event Coordinator / Proposer",
    "Signature of Head of Department / Host Institution",
    true,
    submitSignature,
    null,
  );
  y += 10;

  y = drawCommitteeDecisionBlock(doc, fn, fb, y);
  y += 6;

  y = drawSignatureLinePair(
    doc,
    fn,
    fb,
    y,
    "Admin verification — signature and date",
    "Committee Chair — signature and date",
    false,
    null,
    approveSignature,
  );

  return y;
}

// ── Event Request PDF ─────────────────────────────────────────────────────────

function generateEventRequestPdf(
  request: ICstepTravelRequest,
  proposer: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
): Promise<Buffer> {
  const { doc, fn, fb, collect } = makePdf("Event Request");
  const promise = collect();

  let y = drawHeaderBlock(doc, fn, fb, M, request);

  const LW = Math.round(CW * 0.42);
  const VW = CW - LW;
  const RH = 22;
  const RHL = 36;

  const fundsAvailability = request.eventFundsAvailability;
  const fundsAvailabilityValue = fundsAvailability?.amount
    ? `${fmtAmount(fundsAvailability.amount)}${fundsAvailability.note ? ` — ${fundsAvailability.note}` : ""}`
    : fundsAvailability?.note || "";

  const meals = request.participantMeals;
  const mealsValue =
    meals?.lunchCount != null || meals?.dinnerCount != null
      ? `Lunch: ${meals?.lunchCount ?? 0}   Dinner: ${meals?.dinnerCount ?? 0}`
      : "";

  const rows: [string, string, number][] = [
    [
      "Proposer",
      `${proposer.name}${proposer.gender ? ` (${proposer.gender})` : ""}${proposer.travelerId ? " | ID: " + proposer.travelerId : ""}`,
      RH,
    ],
    ["Title of the event", request.purpose || "", RHL],
    ["Participants (organisation — count)", participantLines(request.eventParticipants).join("\n") || "", RHL],
    ["Host institution / organisation", request.hostInstitution || "", RH],
    ["Nature of event", eventNatureLabel(request), RH],
    ["Duration and dates of the event", fmtDateRange(request.departureDate, request.returnDate), RH],
    ["Location of the event", request.eventLocation || "", RH],
    ["Venue", request.eventVenue || "", RH],
    ["Registration fee (if any)", fmtAmount(request.registrationFee) || "None", RH],
    ["Participants presenting paper(s)?", yesNo(request.presentingPaper, request.presentingPaperDetails), RHL],
    ["Project name to be accounted / debited", [request.project, request.projectDebitable].filter(Boolean).join(" — ") || "", RH],
    ["Project funds availability", fundsAvailabilityValue, RH],
    ["Travel & accommodation support required", yesNo(request.accommodationRequired, request.accommodationRequiredNote), RHL],
    ["Number of participants (meals)", mealsValue, RH],
    ["Additional details / remarks", request.otherInstructions || "", RHL],
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
  drawSignOffSection(doc, fn, fb, y, trail);

  doc.end();
  return promise;
}

// ── Public exports ────────────────────────────────────────────────────────────

export function generateCstepEventRequestPdf(
  request: ICstepTravelRequest,
  proposer: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
): Promise<Buffer> {
  return generateEventRequestPdf(request, proposer, trail);
}

export async function uploadCstepEventRequestPdf(
  request: ICstepTravelRequest,
  proposer: CstepTravellerInfo,
  trail: CstepApprovalTrailEntry[],
): Promise<{ key: string }> {
  const buf = await generateCstepEventRequestPdf(request, proposer, trail);
  const key = `cstep-event-requests/${request.workspaceId}/${request._id}/event-request-${Date.now()}.pdf`;
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
