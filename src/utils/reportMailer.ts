// apps/backend/src/utils/reportMailer.ts
// Env vars used: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (infrastructure only — not moved to DB)
import { sendMail } from "./mailer.js";
import type { IReportSchedule } from "../models/ReportSchedule.js";
import type { ReportSummary } from "../routes/reports.js";
import { generateReportPdf } from "./reportPdf.js";
import { getCompanySettings } from "../models/CompanySettings.js";

/* ── Formatters ─────────────────────────────────────────────────── */

function fmtInr(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtNum(n: number, decimals = 0): string {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(n);
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = new Date(d as string);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/* ── HTML email template ────────────────────────────────────────── */

function buildEmailHtml(
  report: ReportSummary,
  dateLabel: string,
  clientFacing: boolean,
): string {
  const ov = report.overview;

  /* ── KPI boxes ── */
  const kpis: Array<{ label: string; value: string }> = clientFacing
    ? [
        { label: "Total Bookings", value: fmtNum(ov.totalBookings) },
        { label: "Total Quoted", value: fmtInr(ov.totalQuoted) },
        { label: "Invoiced", value: fmtNum(ov.invoicedCount) },
        { label: "Pending / WIP", value: fmtNum(ov.pendingCount + ov.wipCount) },
        { label: "Confirmed", value: fmtNum(ov.confirmedCount) },
        { label: "Cancelled", value: fmtNum(ov.cancelledCount) },
      ]
    : [
        { label: "Total Bookings", value: fmtNum(ov.totalBookings) },
        { label: "Total Quoted", value: fmtInr(ov.totalQuoted) },
        { label: "Total Base Profit", value: fmtInr(ov.totalBaseProfit) },
        { label: "Avg Margin %", value: `${fmtNum(ov.avgMarginPercent, 1)}%` },
        { label: "Invoiced", value: fmtNum(ov.invoicedCount) },
        { label: "Pending / WIP", value: fmtNum(ov.pendingCount + ov.wipCount) },
      ];

  function kpiCell(k: { label: string; value: string }): string {
    return `<td style="width:33.3%;padding:6px;">
      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:14px 10px;text-align:center;">
        <div style="font-size:20px;font-weight:700;color:#0F172A;">${k.value}</div>
        <div style="font-size:11px;color:#64748B;margin-top:4px;">${k.label}</div>
      </div>
    </td>`;
  }

  const kpiRow1 = kpis.slice(0, 3).map(kpiCell).join("");
  const kpiRow2 = kpis.slice(3, 6).map(kpiCell).join("");

  /* ── Top-10 by client ── */
  const topClients = [...report.byClient].slice(0, 10);
  const clientRows = topClients
    .map(
      (c) => `
    <tr style="border-bottom:1px solid #F1F5F9;">
      <td style="padding:8px 10px;font-size:12px;color:#0F172A;">${c.clientName}</td>
      <td style="padding:8px 10px;font-size:12px;text-align:center;color:#475569;">${c.bookings}</td>
      <td style="padding:8px 10px;font-size:12px;text-align:right;color:#0F172A;">${fmtInr(c.totalQuoted)}</td>
      ${
        !clientFacing
          ? `<td style="padding:8px 10px;font-size:12px;text-align:right;color:#059669;">${fmtInr(c.totalBaseProfit)}</td>
      <td style="padding:8px 10px;font-size:12px;text-align:right;color:#7C3AED;">${fmtNum(c.avgMargin, 1)}%</td>`
          : ""
      }
    </tr>`,
    )
    .join("");

  const clientTableHeader = clientFacing
    ? `<th style="padding:10px;text-align:left;font-size:11px;color:#94A3B8;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Client</th>
       <th style="padding:10px;text-align:center;font-size:11px;color:#94A3B8;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Bookings</th>
       <th style="padding:10px;text-align:right;font-size:11px;color:#94A3B8;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Quoted</th>`
    : `<th style="padding:10px;text-align:left;font-size:11px;color:#94A3B8;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Client</th>
       <th style="padding:10px;text-align:center;font-size:11px;color:#94A3B8;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Bookings</th>
       <th style="padding:10px;text-align:right;font-size:11px;color:#94A3B8;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Quoted</th>
       <th style="padding:10px;text-align:right;font-size:11px;color:#94A3B8;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Profit</th>
       <th style="padding:10px;text-align:right;font-size:11px;color:#94A3B8;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Margin%</th>`;

  /* ── Unpaid invoices section ── */
  let unpaidSection = "";
  if (!clientFacing && report.unpaidInvoices.length > 0) {
    const invoiceRows = report.unpaidInvoices
      .map((inv) => {
        const rowBg = inv.pendingDays >= 7 ? "#FFF1F2" : "#FFFBEB";
        return `<tr style="background:${rowBg};border-bottom:1px solid #FEE2E2;">
          <td style="padding:8px 10px;font-size:12px;font-weight:600;color:#0F172A;">${inv.invoiceNo}</td>
          <td style="padding:8px 10px;font-size:12px;color:#475569;">${inv.clientName}</td>
          <td style="padding:8px 10px;font-size:12px;text-align:right;color:#0F172A;">${fmtInr(inv.grandTotal)}</td>
          <td style="padding:8px 10px;font-size:12px;color:#64748B;">${fmtDate(inv.dueDate)}</td>
          <td style="padding:8px 10px;font-size:12px;text-align:right;font-weight:${inv.pendingDays >= 7 ? "700" : "400"};color:${inv.pendingDays >= 7 ? "#E11D48" : "#D97706"};">${inv.pendingDays}d</td>
        </tr>`;
      })
      .join("");

    unpaidSection = `
    <div style="margin-top:32px;">
      <div style="background:#FEF3C7;border-left:4px solid #F59E0B;padding:12px 16px;border-radius:8px;margin-bottom:12px;">
        <span style="font-size:14px;font-weight:700;color:#92400E;">⚠ Unpaid Invoices (${report.unpaidInvoices.length})</span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #FEE2E2;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#FFF1F2;">
            <th style="padding:10px;text-align:left;font-size:11px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Invoice No</th>
            <th style="padding:10px;text-align:left;font-size:11px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Client</th>
            <th style="padding:10px;text-align:right;font-size:11px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Amount</th>
            <th style="padding:10px;text-align:left;font-size:11px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Due Date</th>
            <th style="padding:10px;text-align:right;font-size:11px;color:#94A3B8;font-weight:600;text-transform:uppercase;">Days Pending</th>
          </tr>
        </thead>
        <tbody>${invoiceRows}</tbody>
      </table>
    </div>`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#0F172A;padding:28px 32px;">
            <div style="font-size:22px;font-weight:800;color:#FFFFFF;letter-spacing:-0.02em;">Plumtrips</div>
            <div style="font-size:13px;color:#94A3B8;margin-top:4px;">Booking Report${clientFacing ? " — Summary" : ""}</div>
            <div style="font-size:12px;color:#64748B;margin-top:8px;padding-top:8px;border-top:1px solid #1E293B;">${dateLabel}</div>
          </td>
        </tr>

        <!-- KPI grid -->
        <tr>
          <td style="padding:24px 24px 8px;">
            <div style="font-size:13px;font-weight:700;color:#0F172A;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.05em;">Overview</div>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>${kpiRow1}</tr>
              <tr>${kpiRow2}</tr>
            </table>
          </td>
        </tr>

        <!-- By Client -->
        <tr>
          <td style="padding:16px 24px 8px;">
            <div style="font-size:13px;font-weight:700;color:#0F172A;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.05em;">Revenue by Client</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #E2E8F0;border-radius:8px;overflow:hidden;">
              <thead>
                <tr style="background:#F8FAFC;">${clientTableHeader}</tr>
              </thead>
              <tbody>${clientRows}</tbody>
            </table>
          </td>
        </tr>

        <!-- Unpaid invoices -->
        <tr><td style="padding:0 24px;">${unpaidSection}</td></tr>

        <!-- Footer -->
        <tr>
          <td style="padding:24px 32px;background:#F8FAFC;border-top:1px solid #E2E8F0;">
            <div style="font-size:11px;color:#94A3B8;line-height:1.6;">
              This report was automatically generated by Plumtrips HRMS.<br>
              To manage report schedules, visit your admin dashboard.<br>
              <em>Reply to remove yourself from this list.</em>
            </div>
            <div style="font-size:10px;color:#CBD5E1;margin-top:12px;">
              Peachmint Trips and Planners Pvt. Ltd. · India
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/* ── Main export ─────────────────────────────────────────────────── */

export async function sendReportEmail(
  schedule: IReportSchedule & { includeUnpaid?: boolean },
  reportData: ReportSummary,
  dateLabel: string,
): Promise<void> {
  const dbSettings = await getCompanySettings();
  const fromEmail = dbSettings.reportsFromEmail || process.env.REPORTS_FROM_EMAIL || "reports@plumtrips.com";
  const fromName = dbSettings.reportsFromName || "Plumtrips Reports";
  const from = `${fromName} <${fromEmail}>`;
  const subject = `Plumtrips Booking Report — ${dateLabel}`;

  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];

  // Generate PDF if needed
  if (schedule.format === "EMAIL_PDF" || schedule.format === "BOTH") {
    try {
      const pdfBuf = await generateReportPdf(reportData, dateLabel, {});
      attachments.push({
        filename: "plumtrips-report.pdf",
        content: pdfBuf,
        contentType: "application/pdf",
      });
    } catch (err) {
      console.error("[reportMailer] PDF generation failed:", err);
    }
  }

  const html = buildEmailHtml(reportData, dateLabel, false);

  await sendMail({
    from,
    to: schedule.recipients,
    subject,
    html,
    kind: "DEFAULT",
    attachments: attachments.length ? attachments : undefined,
  });

  // Client-facing version (stripped of cost/margin data)
  if (schedule.includeClientFacing && schedule.clientFacingRecipients?.length) {
    const clientHtml = buildEmailHtml(reportData, dateLabel, true);
    await sendMail({
      from,
      to: schedule.clientFacingRecipients,
      subject,
      html: clientHtml,
      kind: "DEFAULT",
    });
  }
}
