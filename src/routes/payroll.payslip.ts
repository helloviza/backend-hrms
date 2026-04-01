import { Router, type Request, type Response, type NextFunction } from "express";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireFeature } from "../middleware/requireFeature.js";
import Payslip from "../models/Payslip.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

const r = Router();

r.use(requireAuth, requireWorkspace, requireFeature("payrollEnabled"), (req: Request, res: Response, next: NextFunction) => {
  if (!req.workspaceId) return res.status(400).json({ error: "workspaceId query param required for SUPERADMIN" });
  next();
});

function hasRole(req: Request, ...roles: string[]): boolean {
  const userRoles: string[] = (req as any).user?.roles || [];
  return userRoles.some(
    (r) => roles.includes(r.toUpperCase()) || r.toUpperCase() === "SUPERADMIN"
  );
}

/* ─── GET /my/:month — Employee views own payslip ─── */
r.get(
  "/my/:month",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { month } = req.params;
      const userId = (req as any).user.sub;
      const workspaceId = req.workspaceId;

      const payslip = await Payslip.findOne({
        workspaceId,
        userId,
        month,
        status: "PUBLISHED",
      }).lean();

      if (!payslip) {
        return res.status(404).json({ error: "Payslip not yet published" });
      }

      return res.json(payslip);
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET /my — List all published payslips for employee ─── */
r.get(
  "/my",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.sub;
      const workspaceId = req.workspaceId;

      const payslips = await Payslip.find({
        workspaceId,
        userId,
        status: "PUBLISHED",
      })
        .sort({ month: -1 })
        .select("month year netPay earnings.grossEarnings deductions.totalDeductions status")
        .lean();

      return res.json({ items: payslips });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET /:payslipId — Full payslip JSON ─── */
r.get(
  "/:payslipId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { payslipId } = req.params;
      const workspaceId = req.workspaceId;
      const userId = (req as any).user.sub;

      const payslip: any = await Payslip.findOne({ _id: payslipId, workspaceId }).lean();
      if (!payslip) return res.status(404).json({ error: "Payslip not found" });

      // Employee can only view own
      if (!hasRole(req, "HR", "ADMIN") && String(payslip.userId) !== String(userId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      return res.json(payslip);
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET /:payslipId/pdf — Generate and download PDF ─── */
r.get(
  "/:payslipId/pdf",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { payslipId } = req.params;
      const workspaceId = req.workspaceId;
      const userId = (req as any).user.sub;

      const payslip: any = await Payslip.findOne({ _id: payslipId, workspaceId }).lean();
      if (!payslip) return res.status(404).json({ error: "Payslip not found" });

      if (!hasRole(req, "HR", "ADMIN") && String(payslip.userId) !== String(userId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const workspace: any = await CustomerWorkspace.findById(workspaceId)
        .select("companyName payrollConfig")
        .lean();
      const companyName = workspace?.companyName || "Company";
      const footerNote = workspace?.payrollConfig?.payslipFooterNote || "";

      const pdfBytes = await generatePayslipPDF(payslip, companyName, footerNote);

      const safeName = (payslip.employeeSnapshot?.name || "employee").replace(/[^a-zA-Z0-9]/g, "_");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="payslip-${safeName}-${payslip.month}.pdf"`
      );
      return res.send(Buffer.from(pdfBytes));
    } catch (err) {
      return next(err);
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
 * PDF GENERATION (pdf-lib)
 * ═══════════════════════════════════════════════════════════════ */

const BRAND = rgb(0, 0x47 / 255, 0x7f / 255); // #00477f
const WHITE = rgb(1, 1, 1);
const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.95, 0.95, 0.95);
const DARK_GRAY = rgb(0.3, 0.3, 0.3);
const RED = rgb(0.8, 0.1, 0.1);

function fmt(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(n));
}

async function generatePayslipPDF(
  ps: any,
  companyName: string,
  footerNote: string
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const M = 40; // margin
  const W = 595 - 2 * M; // usable width
  let y = 842 - M;

  // ─── Helper functions ───
  function drawText(text: string, x: number, yPos: number, size: number, font = helvetica, color = BLACK) {
    page.drawText(text, { x, y: yPos, size, font, color });
  }

  function drawRect(x: number, yPos: number, w: number, h: number, color: any) {
    page.drawRectangle({ x, y: yPos, width: w, height: h, color });
  }

  function drawLine(x1: number, y1: number, x2: number) {
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y1 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
  }

  // ─── 1. Header bar ───
  drawRect(M, y - 40, W, 40, BRAND);
  drawText(companyName, M + 10, y - 28, 14, helveticaBold, WHITE);
  drawText("SALARY SLIP", M + W - 130, y - 28, 14, helveticaBold, WHITE);
  y -= 50;

  // Month/Year
  drawText(`Pay Period: ${ps.month}`, M + 10, y, 10, helveticaBold, BRAND);
  y -= 20;

  // ─── 2. Employee details (2-column grid) ───
  drawRect(M, y - 90, W, 90, GRAY);
  const leftX = M + 10;
  const rightX = M + W / 2 + 10;
  const snap = ps.employeeSnapshot || {};

  const leftFields = [
    ["Name", snap.name],
    ["Employee ID", snap.employeeCode],
    ["Designation", snap.designation],
    ["Department", snap.department],
    ["Date of Joining", snap.dateOfJoining],
  ];

  const rightFields = [
    ["PAN", snap.pan],
    ["UAN", snap.uanNumber],
    ["Bank", `${snap.bankName} ${snap.bankAccountNumber}`],
    ["IFSC", snap.bankIfsc],
    ["PF Number", snap.pfNumber],
  ];

  let detY = y - 14;
  for (let i = 0; i < Math.max(leftFields.length, rightFields.length); i++) {
    if (leftFields[i]) {
      drawText(`${leftFields[i][0]}:`, leftX, detY, 8, helveticaBold, DARK_GRAY);
      drawText(leftFields[i][1] || "-", leftX + 90, detY, 8, helvetica, BLACK);
    }
    if (rightFields[i]) {
      drawText(`${rightFields[i][0]}:`, rightX, detY, 8, helveticaBold, DARK_GRAY);
      drawText(rightFields[i][1] || "-", rightX + 90, detY, 8, helvetica, BLACK);
    }
    detY -= 16;
  }
  y -= 100;

  // ─── 3. Attendance summary bar ───
  drawRect(M, y - 25, W, 25, BRAND);
  const att = ps.attendance || {};
  const attItems = [
    `Working Days: ${att.workingDays}`,
    `Present: ${att.present}`,
    `Absent: ${att.absent}`,
    `LOP: ${att.lopDays}`,
    `Leave: ${att.leaveDays}`,
    `Half Day: ${att.halfDay}`,
  ];
  const attSpacing = W / attItems.length;
  for (let i = 0; i < attItems.length; i++) {
    drawText(attItems[i], M + 8 + i * attSpacing, y - 17, 7, helvetica, WHITE);
  }
  y -= 35;

  // ─── 4. Earnings & Deductions tables ───
  const halfW = W / 2 - 5;

  // Headers
  drawRect(M, y - 18, halfW, 18, BRAND);
  drawText("EARNINGS", M + 10, y - 13, 9, helveticaBold, WHITE);
  drawRect(M + halfW + 10, y - 18, halfW, 18, BRAND);
  drawText("DEDUCTIONS", M + halfW + 20, y - 13, 9, helveticaBold, WHITE);
  y -= 22;

  const earn = ps.earnings || {};
  const ded = ps.deductions || {};

  const earningsRows = [
    ["Basic", earn.basic],
    ["HRA", earn.hra],
    ["Special Allowance", earn.specialAllowance],
    ["LTA", earn.lta],
    ["Medical Allowance", earn.medicalAllowance],
    ["Conveyance", earn.conveyanceAllowance],
    ["Children Edu. Allow.", earn.childrenEducationAllowance],
    ["Other Allowances", earn.otherAllowances],
    ["LOP Deduction", earn.lopDeduction],
  ];

  const deductionRows = [
    ["PF (Employee)", ded.pfEmployee],
    ["ESI (Employee)", ded.esiEmployee],
    ["Professional Tax", ded.pt],
    ["TDS", ded.tds],
    ["Other Deductions", ded.otherDeductions],
  ];

  const maxRows = Math.max(earningsRows.length, deductionRows.length);
  for (let i = 0; i < maxRows; i++) {
    const rowY = y - i * 16;

    if (i % 2 === 0) {
      drawRect(M, rowY - 4, halfW, 16, GRAY);
      drawRect(M + halfW + 10, rowY - 4, halfW, 16, GRAY);
    }

    if (earningsRows[i]) {
      const [label, val] = earningsRows[i];
      const isLop = label === "LOP Deduction" && (val as number) < 0;
      drawText(label as string, M + 10, rowY, 8, helvetica, BLACK);
      drawText(
        `₹${fmt(val as number)}`,
        M + halfW - 70,
        rowY,
        8,
        helvetica,
        isLop ? RED : BLACK
      );
    }

    if (deductionRows[i]) {
      const [label, val] = deductionRows[i];
      drawText(label as string, M + halfW + 20, rowY, 8, helvetica, BLACK);
      drawText(`₹${fmt(val as number)}`, M + W - 70, rowY, 8, helvetica, BLACK);
    }
  }
  y -= maxRows * 16 + 5;

  // Totals row
  drawLine(M, y, M + W);
  y -= 14;
  drawText("Gross Earnings", M + 10, y, 9, helveticaBold, BLACK);
  drawText(`₹${fmt(earn.grossEarnings || 0)}`, M + halfW - 70, y, 9, helveticaBold, BLACK);
  drawText("Total Deductions", M + halfW + 20, y, 9, helveticaBold, BLACK);
  drawText(`₹${fmt(ded.totalDeductions || 0)}`, M + W - 70, y, 9, helveticaBold, BLACK);
  y -= 20;

  // ─── 5. Net Pay box ───
  drawRect(M, y - 35, W, 35, BRAND);
  const netText = `NET PAY: ₹${fmt(ps.netPay || 0)}`;
  const netTextWidth = helveticaBold.widthOfTextAtSize(netText, 16);
  drawText(netText, M + (W - netTextWidth) / 2, y - 24, 16, helveticaBold, WHITE);
  y -= 45;

  // ─── 6. Employer contributions ───
  const empContr = ps.employerContributions || {};
  drawText("Employer Contributions:", M + 10, y, 8, helveticaBold, DARK_GRAY);
  y -= 14;
  drawText(`PF (Employer): ₹${fmt(empContr.pfEmployer || 0)}`, M + 10, y, 8, helvetica, DARK_GRAY);
  drawText(`ESI (Employer): ₹${fmt(empContr.esiEmployer || 0)}`, M + 200, y, 8, helvetica, DARK_GRAY);
  y -= 18;

  // ─── 7. TDS workings ───
  const tds = ps.tdsWorkings || {};
  drawRect(M, y - 16, W, 16, GRAY);
  drawText("TDS COMPUTATION", M + 10, y - 12, 8, helveticaBold, BRAND);
  y -= 22;

  const tdsRows = [
    [`Regime: ${tds.regime}`, `Annual Taxable: ₹${fmt(tds.taxableIncome || 0)}`],
    [`Tax: ₹${fmt(tds.taxBeforeRebate || 0)}`, `Rebate 87A: ₹${fmt(tds.rebate87A || 0)}`],
    [`Cess: ₹${fmt(tds.cess || 0)}`, `Annual Tax: ₹${fmt(tds.annualTax || 0)}`],
    [`Monthly TDS: ₹${fmt(tds.monthlyTds || 0)}`, `TDS Paid YTD: ₹${fmt(tds.tdsPaidSoFar || 0)}`],
  ];
  for (const [left, right] of tdsRows) {
    drawText(left, M + 10, y, 7, helvetica, DARK_GRAY);
    drawText(right, M + W / 2 + 10, y, 7, helvetica, DARK_GRAY);
    y -= 12;
  }
  y -= 10;

  // ─── 8. Footer ───
  drawLine(M, y, M + W);
  y -= 12;
  drawText(
    `This is a computer-generated payslip. Tax regime: ${tds.regime || "NEW"}.`,
    M + 10,
    y,
    7,
    helvetica,
    DARK_GRAY
  );
  if (footerNote) {
    y -= 10;
    drawText(footerNote, M + 10, y, 7, helvetica, DARK_GRAY);
  }

  return doc.save();
}

export default r;
