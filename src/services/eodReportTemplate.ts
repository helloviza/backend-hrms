// apps/backend/src/services/eodReportTemplate.ts
//
// Builds a self-contained HTML document for the EOD WhatsApp image.
// The document is rendered to PNG at 720×fullPage by eodImageRenderer.
//
// IMPORTANT: per product decision, the Alerts visual section is REMOVED from
// the image. Per-alert toggles still exist in the model and are honoured by
// the text fallback (buildEodMessageFromSnapshot). Do not add alerts back to
// the image without explicit product approval.

import type { EodSnapshot } from "./eodSnapshot.js";

/* ─── Colour tokens ──────────────────────────────────────────── */
const C = {
  red: "#C73E1D",
  redDark: "#791F1F",
  redBgSoft: "#FCEBEB",
  pink: "#F8F4F2",
  white: "#FFFFFF",
  ink: "#1A1A1A",
  muted: "#6B6B6B",
  divider: "#E5E0DD",
  green: "#0F6E56",
  blue: "#185FA5",
  orange: "#D85A30",
  barIdle: "#D8D2CD",
};

/* ─── Helpers ────────────────────────────────────────────────── */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtINR(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Math.round(n || 0));
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-IN").format(n || 0);
}

/** Short Indian rupee form for chart labels: <1L → "₹Xk", >=1L → "₹X.XL". */
function shortINR(n: number): string {
  const v = Math.round(n || 0);
  if (v === 0) return "₹0";
  if (Math.abs(v) >= 10_000_000) return `₹${(v / 10_000_000).toFixed(1)}Cr`;
  if (Math.abs(v) >= 100_000) return `₹${(v / 100_000).toFixed(1)}L`;
  if (Math.abs(v) >= 1_000) return `₹${Math.round(v / 1_000)}k`;
  return `₹${v}`;
}

function bookingTypeLabel(t: string): string {
  switch (t) {
    case "FLIGHT":
      return "Flights";
    case "HOTEL":
      return "Hotels";
    case "VISA":
      return "Visas";
    case "TRANSFER":
    case "CAB":
      return "Transfers";
    case "TRAIN":
      return "Trains";
    case "FOREX":
      return "Forex";
    case "ESIM":
      return "eSIM";
    case "HOLIDAYS":
      return "Holidays";
    case "EVENTS":
      return "Events";
    case "OTHER":
      return "Other";
    default:
      return t.charAt(0) + t.slice(1).toLowerCase();
  }
}

function bookingTypeColor(t: string): string {
  if (t === "FLIGHT") return C.blue;
  if (t === "HOTEL") return C.orange;
  return "#6B6B6B";
}

/* ─── 7-day bar chart (inline SVG) ───────────────────────────── */
function renderTrendSvg(trend: EodSnapshot["trend7d"]): string {
  const W = 600;
  const labelTop = 20;
  const chartTop = 28;
  const chartH = 130;
  const xLabelTop = chartTop + chartH + 4;
  const H = xLabelTop + 18;

  const n = trend.length || 1;
  const innerPad = 12;
  const slotW = (W - innerPad * 2) / n;
  const barW = Math.min(64, slotW * 0.62);
  const barGap = (slotW - barW) / 2;

  const max = Math.max(1, ...trend.map((t) => t.netSales));

  const bars = trend
    .map((t, i) => {
      const slotX = innerPad + slotW * i;
      const x = slotX + barGap;
      const h = max > 0 ? Math.max(2, (t.netSales / max) * chartH) : 2;
      const y = chartTop + (chartH - h);
      const fill = t.isToday ? C.red : C.barIdle;
      const labelX = slotX + slotW / 2;
      return `
        <text x="${labelX}" y="${labelTop}" font-size="10" font-weight="600" fill="${C.ink}" text-anchor="middle">${escapeHtml(shortINR(t.netSales))}</text>
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" ry="3" fill="${fill}" />
        <text x="${labelX}" y="${xLabelTop + 12}" font-size="10" fill="${t.isToday ? C.red : C.muted}" font-weight="${t.isToday ? "700" : "500"}" text-anchor="middle">${escapeHtml(t.label)}</text>
      `;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;">
      <line x1="0" x2="${W}" y1="${chartTop + chartH}" y2="${chartTop + chartH}" stroke="${C.divider}" stroke-width="1" />
      ${bars}
    </svg>
  `;
}

/* ─── Booking-type split bar ─────────────────────────────────── */
function renderTypeSplitBar(rows: EodSnapshot["breakdown"]): string {
  if (!rows.length) return "";

  const totalBookings = rows.reduce((s, r) => s + r.bookings, 0) || 1;
  const cells = rows
    .map((r) => {
      const pct = (r.bookings / totalBookings) * 100;
      const color = bookingTypeColor(r._id);
      const label = `${escapeHtml(bookingTypeLabel(r._id))} · ${r.bookings} · ${escapeHtml(fmtINR(r.netSales))}`;
      return `
        <div style="flex: ${pct.toFixed(2)} 1 0; min-width:0; background:${color}; padding:9px 12px; color:#fff; font-size:11px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${label}
        </div>`;
    })
    .join("");

  return `
    <div style="display:flex; width:100%; border-radius:6px; overflow:hidden;">
      ${cells}
    </div>
  `;
}

/* ─── List rows (performers / clients) ───────────────────────── */
function renderListRows(rows: { name: string; bookings: number; revenue: number }[]): string {
  return rows
    .map(
      (r, i) => `
    <div style="display:flex; justify-content:space-between; align-items:baseline; padding:10px 0; border-top:${i === 0 ? "0" : `1px solid ${C.divider}`};">
      <div style="font-size:12px; font-weight:600; color:${C.ink}; max-width:55%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(r.name)}</div>
      <div style="display:flex; gap:8px; align-items:baseline;">
        <span style="font-size:10px; color:${C.muted};">${fmtNum(r.bookings)} booking${r.bookings !== 1 ? "s" : ""}</span>
        <span style="font-size:12px; font-weight:700; color:${C.ink};">${escapeHtml(fmtINR(r.revenue))}</span>
      </div>
    </div>
  `,
    )
    .join("");
}

/* ─── Pipeline rows ─────────────────────────────────────────── */
function renderPipelineRows(p: NonNullable<EodSnapshot["pipeline"]>): string {
  const row = (
    label: string,
    countLabel: string,
    amount: string | null,
    highlight = false,
  ) => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:9px 12px; border-radius:6px; margin-bottom:4px; ${highlight ? `background:${C.redBgSoft};` : ""}">
      <div style="font-size:12px; font-weight:${highlight ? "700" : "600"}; color:${highlight ? C.redDark : C.ink};">${escapeHtml(label)}</div>
      <div style="display:flex; gap:8px; align-items:baseline; color:${highlight ? C.redDark : C.ink};">
        <span style="font-size:10px; ${highlight ? "" : `color:${C.muted};`}">${escapeHtml(countLabel)}</span>
        ${amount ? `<span style="font-size:12px; font-weight:700;">${escapeHtml(amount)}</span>` : ""}
      </div>
    </div>
  `;

  return [
    row(
      "Awaiting payment",
      `${fmtNum(p.awaitingPayment.count)} invoice${p.awaitingPayment.count !== 1 ? "s" : ""}`,
      fmtINR(p.awaitingPayment.total),
    ),
    row(
      "Overdue >7 days",
      `${fmtNum(p.overdue.count)} invoice${p.overdue.count !== 1 ? "s" : ""}`,
      fmtINR(p.overdue.total),
      p.overdue.count > 0,
    ),
    row("Drafts to send", `${fmtNum(p.draftsToSendCount)}`, null),
    row("Approval requests pending", `${fmtNum(p.approvalRequestsPending)}`, null),
    row("Holds expiring in 24h", `${fmtNum(p.holdsExpiring)}`, null),
  ].join("");
}

/* ─── Section heading ───────────────────────────────────────── */
function sectionHeading(title: string): string {
  return `
    <div style="font-size:10px; font-weight:700; letter-spacing:0.12em; color:${C.muted}; text-transform:uppercase; margin: 18px 0 10px;">
      ${escapeHtml(title)}
    </div>
  `;
}

/* ─── Main builder ───────────────────────────────────────────── */
export function buildEodHtml(snapshot: EodSnapshot): string {
  const { sections, today, wtd, mtd, breakdown, performers, clients, pipeline } = snapshot;

  const todayBlock = sections.todaySnapshot
    ? `
    <div style="background:${C.pink}; border-radius:10px; padding:18px; margin-top:18px;">
      <div style="display:flex; justify-content:space-between; align-items:baseline;">
        <div style="font-size:11px; font-weight:700; color:${C.muted}; letter-spacing:0.1em; text-transform:uppercase;">Total bookings</div>
        <div style="font-size:30px; font-weight:800; color:${C.ink}; line-height:1;">${fmtNum(today.bookings)}</div>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:baseline; margin-top:14px;">
        <div style="font-size:11px; font-weight:700; color:${C.muted}; letter-spacing:0.1em; text-transform:uppercase;">Total sales</div>
        <div style="font-size:18px; font-weight:700; color:${C.ink};">${escapeHtml(fmtINR(today.revenue))}</div>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:baseline; margin-top:8px;">
        <div style="font-size:11px; font-weight:700; color:${C.muted}; letter-spacing:0.1em; text-transform:uppercase;">Total profit</div>
        <div style="font-size:16px; font-weight:700; color:${C.ink};">${escapeHtml(fmtINR(today.baseProfit))}</div>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:baseline; margin-top:8px;">
        <div style="font-size:11px; font-weight:700; color:${C.muted}; letter-spacing:0.1em; text-transform:uppercase;">Margin %*</div>
        <div style="font-size:18px; font-weight:800; color:${C.green};">${today.margin.toFixed(1)}%</div>
      </div>
      <div style="font-size:10px; color:#888; font-style:italic; margin-top:6px; text-align:right;">
        * Margin % = Profit ÷ Net Sales (Total Sales − GST)
      </div>
    </div>
  `
    : "";

  const trendBlock = `
    ${sectionHeading("7-day trend · Net sales")}
    ${renderTrendSvg(snapshot.trend7d)}
  `;

  /* WTD + MTD as a side-by-side pair, or full-width when one is hidden */
  const summaryColumn = (title: string, k: NonNullable<typeof wtd>) => `
    <div style="flex:1; min-width:0; padding:12px 14px; background:${C.white}; border-left:3px solid ${C.red}; border-radius:6px;">
      <div style="font-size:10px; font-weight:700; letter-spacing:0.1em; color:${C.muted}; text-transform:uppercase; margin-bottom:8px;">${escapeHtml(title)}</div>
      <div style="display:grid; grid-template-columns:1fr auto; row-gap:5px; column-gap:10px;">
        <div style="font-size:11px; color:${C.muted};">Bookings</div>
        <div style="font-size:12px; font-weight:700; color:${C.ink}; text-align:right;">${fmtNum(k.bookings)}</div>
        <div style="font-size:11px; color:${C.muted};">Sales</div>
        <div style="font-size:12px; font-weight:700; color:${C.ink}; text-align:right;">${escapeHtml(fmtINR(k.revenue))}</div>
        <div style="font-size:11px; color:${C.muted};">Profit</div>
        <div style="font-size:12px; font-weight:700; color:${C.ink}; text-align:right;">${escapeHtml(fmtINR(k.baseProfit))}</div>
        <div style="font-size:11px; color:${C.muted};">Margin</div>
        <div style="font-size:12px; font-weight:800; color:${C.green}; text-align:right;">${k.margin.toFixed(1)}%</div>
      </div>
    </div>
  `;

  const summaryBlock =
    wtd || mtd
      ? `
    <div style="display:flex; gap:10px; margin-top:14px; background:${C.pink}; border-radius:10px; padding:10px;">
      ${wtd ? summaryColumn(`Week to date (Mon–${snapshot.dayOfMonth})`, wtd) : ""}
      ${mtd ? summaryColumn(`Month to date (${snapshot.monthLabel} 1–${snapshot.dayOfMonth})`, mtd) : ""}
    </div>
  `
      : "";

  const breakdownBlock =
    sections.typeBreakdown && breakdown.length
      ? `
    ${sectionHeading("Booking type · Today")}
    ${renderTypeSplitBar(breakdown)}
  `
      : "";

  const performersBlock =
    sections.topPerformers && performers.length
      ? `
    ${sectionHeading("Top performers · Today")}
    <div>${renderListRows(performers)}</div>
  `
      : "";

  const clientsBlock =
    sections.topClients && clients.length
      ? `
    ${sectionHeading("Top clients · Today")}
    <div>${renderListRows(clients)}</div>
  `
      : "";

  const pipelineBlock =
    sections.pipelineFollowups && pipeline
      ? `
    ${sectionHeading("Pipeline & follow-ups")}
    <div>${renderPipelineRows(pipeline)}</div>
  `
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>EOD Snapshot</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: ${C.white}; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: ${C.ink};
    -webkit-font-smoothing: antialiased;
  }
  .canvas {
    width: 720px;
    background: ${C.white};
    padding: 24px 40px;
  }
  .card {
    width: 640px;
    margin: 0 auto;
  }
  .header {
    background: ${C.red};
    color: ${C.white};
    padding: 18px 18px 16px;
    border-radius: 10px;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
  }
  .header h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.01em;
  }
  .header .sub {
    font-size: 11px;
    margin-top: 4px;
    opacity: 0.92;
  }
  .header .time {
    font-size: 11px;
    opacity: 0.92;
    text-align: right;
  }
  .footer {
    margin-top: 22px;
    padding-top: 12px;
    border-top: 1px solid ${C.divider};
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: ${C.muted};
  }
</style>
</head>
<body>
  <div class="canvas">
    <div class="card">
      <div class="header">
        <div>
          <h1>Plumtrips</h1>
          <div class="sub">Daily snapshot · ${escapeHtml(snapshot.dateLabel)}</div>
        </div>
        <div class="time">${escapeHtml(snapshot.timeLabel)} IST</div>
      </div>

      ${todayBlock}
      ${trendBlock}
      ${summaryBlock}
      ${breakdownBlock}
      ${performersBlock}
      ${clientsBlock}
      ${pipelineBlock}

      <div class="footer">
        <span>plumbox.plumtrips.com</span>
        <span>Generated ${escapeHtml(snapshot.timeLabelLong)}</span>
      </div>
    </div>
  </div>
</body>
</html>`;
}
