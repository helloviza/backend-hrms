// apps/backend/src/services/crmSalesPulseTemplate.ts
//
// TEMPLATE layer — renders a SalesPulseSnapshot to a single premium-executive
// HTML document, built for the render Lambda's PDF (A4) mode. No data work here.
//
// Fonts: Poppins (headings/KPIs) + Inter (body) are requested via Google Fonts,
// but EVERY font-family also carries a system fallback stack so a render env
// without network/those fonts still produces a clean document — missing fonts
// must never break the render.
//
// Empty/thin states are first-class: ₹ panels with no captured value render an
// honest "deal values not yet captured" message instead of a ₹0 headline, and
// the layout is designed to look intentional with as few as 3 reps, a lopsided
// funnel, and ₹0 pipeline.

import type { SalesPulseSnapshot, KpiCard } from "./crmSalesPulseSnapshot.js";
import { fmtInr } from "./crmSalesPulseSnapshot.js";

const HEAD_FROM = "#00477f";
const HEAD_TO = "#003866";
const CORAL = "#ff6b5e";
const INK = "#0f1b2d";
const MUTED = "#5b6b82";
const FAINT = "#8a99ad";
const BORDER = "#e6ebf2";
const SURFACE = "#ffffff";
const PANEL = "#f7f9fc";
const GREEN = "#10b981";
const RED = "#ef4444";
const AMBER = "#f59e0b";

const FONT_HEAD = "'Poppins',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_BODY = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-IN").format(n || 0);
}
function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function initials(name: string): string {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ── Section heading ── */
function sectionTitle(text: string, sub?: string): string {
  return `<div style="display:flex;align-items:baseline;gap:8px;margin:0 0 12px;">
    <div style="font-family:${FONT_HEAD};font-size:13px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${INK};">${esc(text)}</div>
    ${sub ? `<div style="font-family:${FONT_BODY};font-size:11px;color:${FAINT};">${esc(sub)}</div>` : ""}
  </div>`;
}

/* ── Header ── */
function renderHeader(s: SalesPulseSnapshot): string {
  return `
  <div style="background:linear-gradient(135deg,${HEAD_FROM} 0%,${HEAD_TO} 100%);padding:26px 30px;color:#fff;border-radius:16px 16px 0 0;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle;">
        <div style="font-family:${FONT_HEAD};font-size:13px;font-weight:600;letter-spacing:0.22em;color:#bcd4ec;text-transform:uppercase;">PLUMTRIPS</div>
        <div style="font-family:${FONT_HEAD};font-size:27px;font-weight:700;letter-spacing:-0.01em;margin-top:3px;">Sales Pulse</div>
        <div style="font-family:${FONT_BODY};font-size:12.5px;color:#cfe0f1;margin-top:7px;">${esc(s.dateLabel)} &nbsp;·&nbsp; ${esc(s.windowLabel)}</div>
      </td>
      <td style="vertical-align:top;text-align:right;">
        <span style="display:inline-block;background:${CORAL};color:#fff;font-family:${FONT_BODY};font-size:11px;font-weight:700;letter-spacing:0.03em;padding:6px 13px;border-radius:999px;box-shadow:0 4px 12px rgba(255,107,94,0.35);">● Auto Triggered · ${esc(s.fireSlotLabel)}</span>
        <div style="font-family:${FONT_BODY};font-size:10.5px;color:#aac3dd;margin-top:10px;">Generated ${esc(s.timeLabel)} IST</div>
      </td>
    </tr></table>
  </div>`;
}

/* ── KPI grid (2×4) ── */
// CSS-drawn triangle (no glyph-font dependency — the render Lambda's Chromium
// lacks emoji + ▲▼→, which would otherwise tofu).
function triUp(color: string): string {
  return `<span style="display:inline-block;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:6px solid ${color};vertical-align:middle;margin-right:3px;"></span>`;
}
function triDown(color: string): string {
  return `<span style="display:inline-block;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:6px solid ${color};vertical-align:middle;margin-right:3px;"></span>`;
}
function triRight(color: string): string {
  return `<span style="display:inline-block;width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent;border-left:7px solid ${color};vertical-align:middle;"></span>`;
}

function renderKpiCard(k: KpiCard): string {
  const goodWhenDown = k.key === "lost";
  let deltaHtml = "";
  if (k.delta != null && k.deltaDir && k.deltaDir !== "flat") {
    const isUp = k.deltaDir === "up";
    const good = goodWhenDown ? !isUp : isUp;
    const color = good ? GREEN : RED;
    deltaHtml = `<span style="color:${color};font-weight:700;">${isUp ? triUp(color) : triDown(color)}${Math.abs(k.delta)}</span> <span style="color:${FAINT};">vs yest.</span>`;
  } else if (k.delta != null) {
    deltaHtml = `<span style="color:${FAINT};">no change vs yest.</span>`;
  }
  return `<td style="width:25%;padding:6px;">
    <div style="background:${SURFACE};border:1px solid ${BORDER};border-radius:13px;padding:15px 14px 13px;height:100%;box-shadow:0 1px 2px rgba(16,30,54,0.04);">
      <div style="width:24px;height:4px;border-radius:3px;background:linear-gradient(90deg,#2f7fd4,#00477f);"></div>
      <div style="font-family:${FONT_HEAD};font-size:26px;font-weight:700;color:${INK};margin-top:11px;line-height:1;">${fmtNum(k.value)}</div>
      <div style="font-family:${FONT_BODY};font-size:11px;color:${MUTED};margin-top:5px;font-weight:600;">${esc(k.label)}</div>
      <div style="font-family:${FONT_BODY};font-size:10px;margin-top:5px;">${deltaHtml || `<span style="color:${FAINT};">—</span>`}</div>
    </div>
  </td>`;
}
function renderKpis(s: SalesPulseSnapshot): string {
  const grid = s.kpis.slice(0, 8);
  const row1 = grid.slice(0, 4).map(renderKpiCard).join("");
  const row2 = grid.slice(4, 8).map(renderKpiCard).join("");
  return `<div style="padding:18px 24px 4px;">
    ${sectionTitle("Today at a Glance", "cumulative since 12:00 AM IST")}
    <table width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;">
      <tr>${row1}</tr>
      <tr>${row2}</tr>
    </table>
  </div>`;
}

/* ── Leaderboard ── */
function statusDot(status: string): string {
  const map: Record<string, string> = { green: GREEN, amber: AMBER, red: RED, neutral: "#cbd5e1" };
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${map[status] ?? "#cbd5e1"};"></span>`;
}
function renderLeaderboard(s: SalesPulseSnapshot): string {
  const reps = s.leaderboard.reps.slice(0, 8);
  const maxScore = Math.max(1, ...reps.map((r) => r.score));
  const rows = reps.length
    ? reps
        .map((r, i) => {
          const w = Math.round((r.score / maxScore) * 100);
          return `<div style="margin-bottom:9px;">
            <div style="display:flex;align-items:center;justify-content:space-between;font-family:${FONT_BODY};font-size:11px;margin-bottom:3px;">
              <span style="color:${INK};font-weight:600;">${statusDot(r.status)} ${i + 1}. ${esc(r.ownerName)}</span>
              <span style="color:${MUTED};">${r.score} <span style="color:${FAINT};">· ${r.activities} act</span></span>
            </div>
            <div style="background:${BORDER};border-radius:6px;height:7px;overflow:hidden;">
              <div style="width:${w}%;height:7px;background:linear-gradient(90deg,#2f7fd4,#00477f);border-radius:6px;"></div>
            </div>
          </div>`;
        })
        .join("")
    : `<div style="font-family:${FONT_BODY};font-size:11px;color:${FAINT};padding:8px 0;">No rep activity logged yet today.</div>`;
  return `<div>
    ${sectionTitle("Team Leaderboard")}
    ${rows}
    <div style="font-family:${FONT_BODY};font-size:10px;color:${FAINT};margin-top:8px;border-top:1px dashed ${BORDER};padding-top:7px;">
      Team avg score: <b style="color:${MUTED};">${s.leaderboard.teamAverage}</b> · weights: ${Object.entries(s.leaderboard.weights).map(([k, v]) => `${k} ${v}`).join(", ")}
    </div>
  </div>`;
}

/* ── Pipeline movement funnel ── */
function renderFunnel(s: SalesPulseSnapshot): string {
  const maxC = Math.max(1, ...s.movement.map((m) => m.count));
  const rows = s.movement
    .map((m) => {
      const w = Math.round((m.count / maxC) * 100);
      return `<div style="margin-bottom:7px;">
        <div style="display:flex;align-items:center;justify-content:space-between;font-family:${FONT_BODY};font-size:10.5px;margin-bottom:2px;">
          <span style="color:${INK};font-weight:600;">${esc(m.label)}</span>
          <span style="color:${MUTED};">${fmtNum(m.count)}</span>
        </div>
        <div style="background:${BORDER};border-radius:5px;height:14px;overflow:hidden;">
          <div style="width:${Math.max(w, m.count > 0 ? 4 : 0)}%;height:14px;background:${m.color};border-radius:5px;"></div>
        </div>
      </div>`;
    })
    .join("");
  return `<div>
    ${sectionTitle("Pipeline Movement")}
    ${rows}
    <div style="font-family:${FONT_BODY};font-size:10px;color:${FAINT};margin-top:6px;">Leads entering each stage today.</div>
  </div>`;
}

/* ── Stage distribution donut (SVG) ── */
function renderDonut(s: SalesPulseSnapshot): string {
  const data = s.stageDistribution.filter((d) => d.count > 0);
  const total = data.reduce((a, b) => a + b.count, 0);
  const R = 52, SW = 22, CX = 70, CY = 70;
  const circ = 2 * Math.PI * R;
  let offset = 0;
  const segs = total
    ? data
        .map((d) => {
          const frac = d.count / total;
          const len = frac * circ;
          const seg = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${d.color}" stroke-width="${SW}"
            stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${CX} ${CY})"></circle>`;
          offset += len;
          return seg;
        })
        .join("")
    : `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${BORDER}" stroke-width="${SW}"></circle>`;
  const legend = (total ? data : s.stageDistribution.slice(0, 6))
    .map(
      (d) => `<div style="display:flex;align-items:center;gap:6px;font-family:${FONT_BODY};font-size:10px;color:${MUTED};margin-bottom:3px;">
        <span style="width:8px;height:8px;border-radius:2px;background:${d.color};display:inline-block;"></span>
        <span style="flex:1;color:${INK};">${esc(d.label)}</span>
        <span>${fmtNum(d.count)}${total ? ` · ${d.pct}%` : ""}</span>
      </div>`,
    )
    .join("");
  return `<div>
    ${sectionTitle("Stage Distribution")}
    <div style="text-align:center;margin-bottom:8px;">
      <svg width="140" height="140" viewBox="0 0 140 140">${segs}
        <text x="${CX}" y="${CY - 2}" text-anchor="middle" font-family="${FONT_HEAD}" font-size="22" font-weight="700" fill="${INK}">${fmtNum(total)}</text>
        <text x="${CX}" y="${CY + 15}" text-anchor="middle" font-family="${FONT_BODY}" font-size="9" fill="${FAINT}">total leads</text>
      </svg>
    </div>
    ${legend}
  </div>`;
}

/* ── Three-column row: leaderboard 33 / funnel 34 / donut 33 ── */
function renderThreeCol(s: SalesPulseSnapshot): string {
  const cells: string[] = [];
  if (s.sections.leaderboard) cells.push(`<td style="width:33%;vertical-align:top;padding:0 9px;">${renderLeaderboard(s)}</td>`);
  if (s.sections.pipelineMovement) cells.push(`<td style="width:34%;vertical-align:top;padding:0 9px;border-left:1px solid ${BORDER};border-right:1px solid ${BORDER};">${renderFunnel(s)}</td>`);
  if (s.sections.stageDistribution) cells.push(`<td style="width:33%;vertical-align:top;padding:0 9px;">${renderDonut(s)}</td>`);
  if (!cells.length) return "";
  return `<div style="padding:14px 16px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;"><tr>${cells.join("")}</tr></table>
  </div>`;
}

/* ── Heatmap ── */
function heatColor(count: number, max: number, reached: boolean): string {
  if (!reached) return "background:repeating-linear-gradient(45deg,#f1f4f8,#f1f4f8 4px,#e9eef4 4px,#e9eef4 8px);";
  if (count <= 0) return `background:${PANEL};`;
  const intensity = max > 0 ? count / max : 0;
  // light → deep brand blue
  const alpha = (0.18 + intensity * 0.72).toFixed(2);
  return `background:rgba(0,71,127,${alpha});`;
}
function renderHeatmap(s: SalesPulseSnapshot): string {
  const reps = s.heatmap.reps.slice(0, 8);
  const head = `<tr>
    <td style="font-family:${FONT_BODY};font-size:10px;color:${FAINT};padding:4px 8px;">Rep</td>
    ${s.heatmap.slots.map((sl) => `<td style="text-align:center;font-family:${FONT_BODY};font-size:10px;color:${sl.reached ? MUTED : FAINT};padding:4px;">${esc(sl.label)}${sl.reached ? "" : " ·"}</td>`).join("")}
  </tr>`;
  const body = reps.length
    ? reps
        .map((r) => {
          const cells = r.counts
            .map((c, i) => {
              const reached = s.heatmap.slots[i].reached;
              const txt = reached && c > 0 ? `<span style="color:${c / (s.heatmap.maxCell || 1) > 0.6 ? "#fff" : INK};font-weight:600;">${c}</span>` : "";
              return `<td style="padding:3px;"><div style="${heatColor(c, s.heatmap.maxCell, reached)}border-radius:6px;height:26px;line-height:26px;text-align:center;font-family:${FONT_BODY};font-size:11px;">${txt}</div></td>`;
            })
            .join("");
          return `<tr>
            <td style="font-family:${FONT_BODY};font-size:11px;color:${INK};font-weight:600;padding:3px 8px;white-space:nowrap;">${esc(r.ownerName)}</td>
            ${cells}
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" style="font-family:${FONT_BODY};font-size:11px;color:${FAINT};padding:10px 8px;">No activity logged in any time slot yet.</td></tr>`;
  return `<div style="padding:6px 24px 14px;">
    ${sectionTitle("Activity Heatmap", `${s.heatmap.reachedCount}/4 time slots reached`)}
    <table width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;">${head}${body}</table>
  </div>`;
}

/* ── Companies touched bar ── */
function renderCompanies(s: SalesPulseSnapshot): string {
  const reps = s.companiesTouched.byRep.slice(0, 8);
  const max = Math.max(1, ...reps.map((r) => r.count));
  const rows = reps.length
    ? reps
        .map(
          (r) => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:7px;">
        <span style="width:120px;font-family:${FONT_BODY};font-size:11px;color:${INK};font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.ownerName)}</span>
        <span style="flex:1;background:${BORDER};border-radius:5px;height:12px;overflow:hidden;"><span style="display:block;width:${Math.round((r.count / max) * 100)}%;height:12px;background:linear-gradient(90deg,#5aa0e0,#00477f);border-radius:5px;"></span></span>
        <span style="width:28px;text-align:right;font-family:${FONT_BODY};font-size:11px;color:${MUTED};">${r.count}</span>
      </div>`,
        )
        .join("")
    : `<div style="font-family:${FONT_BODY};font-size:11px;color:${FAINT};">No companies touched yet today.</div>`;
  return `<div style="padding:6px 24px 14px;">
    ${sectionTitle("Companies Touched", `${s.companiesTouched.total} distinct today`)}
    ${rows}
  </div>`;
}

/* ── Rep performance cards ── */
function renderRepCards(s: SalesPulseSnapshot): string {
  const cards = s.repCards.slice(0, 9);
  if (!cards.length) {
    return `<div style="padding:6px 24px 14px;">${sectionTitle("Rep Performance")}<div style="font-family:${FONT_BODY};font-size:11px;color:${FAINT};">No reps own leads yet.</div></div>`;
  }
  const cellArr = cards.map((r) => renderRepCardCell(r));
  const rowsHtml: string[] = [];
  for (let i = 0; i < cellArr.length; i += 3) {
    rowsHtml.push(`<tr>${cellArr.slice(i, i + 3).join("")}</tr>`);
  }
  return `<div style="padding:6px 18px 14px;">
    ${sectionTitle("Rep Performance")}
    <table width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;">${rowsHtml.join("")}</table>
    <div style="font-family:${FONT_BODY};font-size:9.5px;color:${FAINT};padding:2px 6px;">* ${esc(s.meta.productivityNote)}</div>
  </div>`;
}
function renderRepCardCell(r: SalesPulseSnapshot["repCards"][number]): string {
  return `<td style="width:33.33%;padding:6px;vertical-align:top;">
      <div style="background:${SURFACE};border:1px solid ${BORDER};border-radius:12px;padding:13px;">
        <div style="display:flex;align-items:center;gap:9px;">
          <span style="width:30px;height:30px;border-radius:50%;background:#eaf1f9;color:${HEAD_FROM};font-family:${FONT_HEAD};font-weight:700;font-size:11px;display:inline-flex;align-items:center;justify-content:center;">${esc(initials(r.ownerName))}</span>
          <span style="font-family:${FONT_BODY};font-size:12px;font-weight:700;color:${INK};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.ownerName)}</span>
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;">
          <tr>
            <td style="text-align:center;"><div style="font-family:${FONT_HEAD};font-size:17px;font-weight:700;color:${INK};">${fmtNum(r.activities)}</div><div style="font-family:${FONT_BODY};font-size:9px;color:${FAINT};">activities</div></td>
            <td style="text-align:center;"><div style="font-family:${FONT_HEAD};font-size:17px;font-weight:700;color:${INK};">${fmtNum(r.leads)}</div><div style="font-family:${FONT_BODY};font-size:9px;color:${FAINT};">leads</div></td>
            <td style="text-align:center;"><div style="font-family:${FONT_HEAD};font-size:17px;font-weight:700;color:${INK};">${fmtNum(r.demos)}</div><div style="font-family:${FONT_BODY};font-size:9px;color:${FAINT};">demos</div></td>
            <td style="text-align:center;"><div style="font-family:${FONT_HEAD};font-size:17px;font-weight:700;color:${GREEN};">${fmtNum(r.won)}</div><div style="font-family:${FONT_BODY};font-size:9px;color:${FAINT};">won</div></td>
          </tr>
        </table>
        <div style="margin-top:10px;">
          <div style="display:flex;justify-content:space-between;font-family:${FONT_BODY};font-size:9.5px;color:${MUTED};margin-bottom:3px;"><span>Productivity*</span><span>${r.productivityPct}%</span></div>
          <div style="background:${BORDER};border-radius:5px;height:6px;overflow:hidden;"><div style="width:${Math.min(100, r.productivityPct)}%;height:6px;background:${r.productivityPct >= 50 ? GREEN : r.productivityPct > 0 ? AMBER : "#cbd5e1"};border-radius:5px;"></div></div>
        </div>
      </div>
    </td>`;
}

/* ── Lead ageing alert ── */
function renderAgeing(s: SalesPulseSnapshot): string {
  const rows = s.ageingAlert.length
    ? s.ageingAlert
        .map(
          (l) => `<tr style="border-bottom:1px solid ${BORDER};">
        <td style="padding:8px 6px;"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${l.color};margin-right:7px;"></span><span style="font-family:${FONT_BODY};font-size:11.5px;color:${INK};font-weight:600;">${esc(l.name)}</span></td>
        <td style="padding:8px 6px;font-family:${FONT_BODY};font-size:11px;color:${MUTED};">${esc(l.stageLabel)}</td>
        <td style="padding:8px 6px;font-family:${FONT_BODY};font-size:11px;color:${MUTED};">${esc(l.ownerName)}</td>
        <td style="padding:8px 6px;text-align:right;font-family:${FONT_HEAD};font-size:12px;font-weight:700;color:${l.daysSince >= 30 ? RED : l.daysSince >= 14 ? AMBER : MUTED};">${l.daysSince}d</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="4" style="font-family:${FONT_BODY};font-size:11px;color:${FAINT};padding:10px 6px;">No open leads — nothing ageing. 🎉</td></tr>`;
  return `<div style="padding:6px 24px 14px;">
    ${sectionTitle("Lead Ageing Alert", "oldest 5 by days since last activity")}
    <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
  </div>`;
}

/* ── Conversion tracker ── */
function renderConversion(s: SalesPulseSnapshot): string {
  const steps = s.conversion.steps;
  if (!steps.length) return "";
  const stepCells = steps
    .map((st, i) => {
      const rate = i > 0 ? s.conversion.stepRates[i - 1] : null;
      const arrow = i > 0
        ? `<td style="text-align:center;vertical-align:middle;width:64px;">
            <div style="font-family:${FONT_BODY};font-size:9.5px;color:${FAINT};margin-bottom:4px;">${rate && rate.pct != null ? rate.pct + "%" : "—"}</div>
            ${triRight(FAINT)}
          </td>`
        : "";
      return `${arrow}<td style="text-align:center;">
        <div style="background:${PANEL};border:1px solid ${BORDER};border-radius:12px;padding:14px 8px;">
          <div style="font-family:${FONT_HEAD};font-size:24px;font-weight:700;color:${INK};">${fmtNum(st.count)}</div>
          <div style="font-family:${FONT_BODY};font-size:10.5px;color:${MUTED};margin-top:3px;">${esc(st.label)}</div>
        </div>
      </td>`;
    })
    .join("");
  return `<div style="padding:6px 24px 14px;">
    ${sectionTitle("Conversion Tracker")}
    <table width="100%" cellpadding="0" cellspacing="0"><tr>${stepCells}</tr></table>
    <div style="font-family:${FONT_BODY};font-size:9.5px;color:${FAINT};margin-top:6px;">${esc(s.conversion.basis)}</div>
  </div>`;
}

/* ── Sales insights panel ── */
function renderInsights(s: SalesPulseSnapshot): string {
  const lines = s.insights.lines
    .map((l) => `<li style="font-family:${FONT_BODY};font-size:11.5px;color:#e9f1fb;margin-bottom:7px;line-height:1.45;">${esc(l)}</li>`)
    .join("");
  const closure = s.insights.closureValueKnown
    ? `<div style="font-family:${FONT_HEAD};font-size:22px;font-weight:700;color:#fff;">${fmtInr(s.insights.estimatedClosureValue)}</div>
       <div style="font-family:${FONT_BODY};font-size:10.5px;color:#a9c4e2;margin-top:2px;">Estimated closure value · open deals</div>`
    : `<div style="font-family:${FONT_BODY};font-size:13px;font-weight:600;color:#cfe0f1;">Deal values not yet captured</div>
       <div style="font-family:${FONT_BODY};font-size:10.5px;color:#a9c4e2;margin-top:3px;">Add deal values to leads to surface an estimated closure figure here.</div>`;
  return `<div style="padding:6px 24px 18px;">
    <div style="background:linear-gradient(135deg,${HEAD_FROM},${HEAD_TO});border-radius:14px;padding:18px 20px;">
      <div style="font-family:${FONT_HEAD};font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#bcd4ec;margin-bottom:12px;">Sales Insights</div>
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:top;width:62%;padding-right:16px;"><ul style="margin:0;padding-left:16px;">${lines}</ul></td>
        <td style="vertical-align:middle;width:38%;border-left:1px solid rgba(255,255,255,0.16);padding-left:18px;">${closure}</td>
      </tr></table>
    </div>
  </div>`;
}

/* ── Footer ── */
function renderFooter(s: SalesPulseSnapshot): string {
  return `<div style="background:${HEAD_TO};color:#aac3dd;padding:16px 30px;border-radius:0 0 16px 16px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:${FONT_BODY};font-size:10.5px;color:#aac3dd;">
        Plumtrips Sales Pulse · auto-generated executive briefing.<br>
        Peachmint Trips and Planners Pvt. Ltd. · India
      </td>
      <td style="text-align:right;font-family:${FONT_BODY};font-size:10.5px;color:#7f9cba;">${esc(s.dateLabel)}<br>${esc(s.timeLabel)} IST</td>
    </tr></table>
  </div>`;
}

/* ─────────────────────────── Public ─────────────────────────── */
export function buildSalesPulseHtml(s: SalesPulseSnapshot): string {
  const sec = s.sections;
  const body = [
    renderHeader(s),
    sec.kpis ? renderKpis(s) : "",
    renderThreeCol(s),
    sec.activityHeatmap ? renderHeatmap(s) : "",
    sec.companiesTouched ? renderCompanies(s) : "",
    sec.repPerformance ? renderRepCards(s) : "",
    sec.leadAgeing ? renderAgeing(s) : "",
    sec.conversionTracker ? renderConversion(s) : "",
    sec.insights ? renderInsights(s) : "",
    renderFooter(s),
  ].join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Plumtrips Sales Pulse — ${esc(s.dateLabel)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;600;700&display=swap');
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #eef2f7; font-family: ${FONT_BODY}; }
  /* Rendered as a single continuous PNG (not paged PDF). The sheet width is
     pinned to the render Lambda's 720px image viewport so the layout fills the
     image edge-to-edge with no horizontal overflow; fullPage capture handles
     the vertical length. */
  .sheet { width: 720px; margin: 0 auto; background: ${SURFACE}; }
</style>
</head>
<body>
  <div class="sheet">${body}</div>
</body>
</html>`;
}
