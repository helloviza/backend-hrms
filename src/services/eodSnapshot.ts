// apps/backend/src/services/eodSnapshot.ts
import {
  EodReportConfig,
  normalizeSections,
  type IEodSections,
  type IEodAlertToggles,
  type IEodRecipient,
} from "../models/EodReportConfig.js";
import { whatsappService } from "./whatsappService.js";
import ManualBooking from "../models/ManualBooking.js";
import Invoice from "../models/Invoice.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import User from "../models/User.js";
import Customer from "../models/Customer.js";
import { parseISTStart, parseISTEnd } from "../utils/dateIST.js";
import { buildEodHtml } from "./eodReportTemplate.js";
import { renderEodImage } from "./eodImageRenderer.js";
import logger from "../utils/logger.js";

/* ─────────────────────────── Types ─────────────────────────── */
export interface RangeKpis {
  bookings: number;
  revenue: number;
  gst: number;
  netSales: number;
  baseProfit: number;
  margin: number;
}

export interface TypeBreakdownRow {
  _id: string;
  bookings: number;
  netSales: number;
  baseProfit: number;
  margin: number;
}

export interface TopPerformer {
  name: string;
  bookings: number;
  revenue: number;
}

export interface TopClient {
  name: string;
  bookings: number;
  revenue: number;
}

export interface PipelineMetrics {
  awaitingPayment: { count: number; total: number };
  overdue: { count: number; total: number };
  draftsToSendCount: number;
  approvalRequestsPending: number;
  holdsExpiring: number;
}

export interface TrendPoint {
  label: string;
  netSales: number;
  isToday: boolean;
}

export interface EodSnapshot {
  generatedAt: Date;
  dateLabel: string;
  timeLabel: string;
  timeLabelLong: string;
  todayStr: string;
  dayOfMonth: number;
  monthLabel: string;
  sections: IEodSections;
  today: RangeKpis;
  wtd: RangeKpis | null;
  mtd: RangeKpis | null;
  trend7d: TrendPoint[];
  breakdown: TypeBreakdownRow[];
  performers: TopPerformer[];
  clients: TopClient[];
  pipeline: PipelineMetrics | null;
  alerts: string[];
}

/* ─────────────────────────── Formatters ──────────────────────── */
function formatINR(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Math.round(amount || 0));
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-IN").format(n || 0);
}

/* ─────────────────────────── IST date helpers ────────────────── */
function todayInIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function getMondayOfWeekIST(istDateStr: string): string {
  const [y, m, d] = istDateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - diff);
  return date.toISOString().slice(0, 10);
}

function firstOfMonthIST(istDateStr: string): string {
  const [y, m] = istDateStr.split("-");
  return `${y}-${m}-01`;
}

function shiftDateStr(istDateStr: string, deltaDays: number): string {
  const [y, m, d] = istDateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function weekdayShortFromIstStr(istDateStr: string): string {
  const [y, m, d] = istDateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" });
}

/* ─────────────────────────── KPI helpers ─────────────────────── */
async function getKpisForRange(start: Date, end: Date): Promise<RangeKpis> {
  const result = await ManualBooking.aggregate([
    {
      $match: {
        bookingDate: { $gte: start, $lte: end },
        isActive: { $ne: false },
      },
    },
    {
      $group: {
        _id: null,
        bookings: { $sum: 1 },
        totalQuoted: { $sum: { $ifNull: ["$pricing.quotedPrice", 0] } },
        totalGST: { $sum: { $ifNull: ["$pricing.gstAmount", 0] } },
        totalBaseProfit: { $sum: { $ifNull: ["$pricing.basePrice", 0] } },
      },
    },
  ]);

  if (!result.length) {
    return { bookings: 0, revenue: 0, gst: 0, netSales: 0, baseProfit: 0, margin: 0 };
  }

  const r = result[0];
  const revenue = r.totalQuoted ?? 0;
  const gst = r.totalGST ?? 0;
  const baseProfit = r.totalBaseProfit ?? 0;
  const netSales = revenue - gst;
  const margin = netSales > 0 ? parseFloat(((baseProfit / netSales) * 100).toFixed(2)) : 0;

  return { bookings: r.bookings ?? 0, revenue, gst, netSales, baseProfit, margin };
}

async function getBreakdownByType(start: Date, end: Date): Promise<TypeBreakdownRow[]> {
  const rows = await ManualBooking.aggregate([
    {
      $match: {
        bookingDate: { $gte: start, $lte: end },
        isActive: { $ne: false },
      },
    },
    {
      $group: {
        _id: "$type",
        bookings: { $sum: 1 },
        totalQuoted: { $sum: { $ifNull: ["$pricing.quotedPrice", 0] } },
        totalGST: { $sum: { $ifNull: ["$pricing.gstAmount", 0] } },
        totalBaseProfit: { $sum: { $ifNull: ["$pricing.basePrice", 0] } },
      },
    },
    { $addFields: { netSales: { $subtract: ["$totalQuoted", "$totalGST"] } } },
    {
      $addFields: {
        margin: {
          $cond: {
            if: { $gt: ["$netSales", 0] },
            then: { $multiply: [{ $divide: ["$totalBaseProfit", "$netSales"] }, 100] },
            else: 0,
          },
        },
      },
    },
    { $sort: { bookings: -1 } },
  ]);

  return rows.map((r: any) => ({
    _id: String(r._id ?? "OTHER"),
    bookings: r.bookings ?? 0,
    netSales: r.netSales ?? 0,
    baseProfit: r.totalBaseProfit ?? 0,
    margin: r.margin ?? 0,
  }));
}

async function getTopPerformers(start: Date, end: Date, limit = 3): Promise<TopPerformer[]> {
  const agg = await ManualBooking.aggregate([
    {
      $match: {
        bookingDate: { $gte: start, $lte: end },
        isActive: { $ne: false },
        bookedBy: { $ne: null },
      },
    },
    {
      $group: {
        _id: "$bookedBy",
        bookings: { $sum: 1 },
        revenue: { $sum: { $ifNull: ["$pricing.quotedPrice", 0] } },
      },
    },
    { $sort: { bookings: -1, revenue: -1 } },
    { $limit: limit },
  ]);
  if (!agg.length) return [];

  const userIds = agg.map((a: any) => a._id).filter(Boolean);
  const users = await User.find(
    { _id: { $in: userIds } },
    { name: 1, firstName: 1, email: 1 },
  ).lean();
  const map = new Map(
    users.map((u: any) => [
      String(u._id),
      u.name || u.firstName || (u.email ? String(u.email).split("@")[0] : "Unknown"),
    ]),
  );

  return agg.map((a: any) => ({
    name: map.get(String(a._id)) ?? "Unknown",
    bookings: a.bookings ?? 0,
    revenue: a.revenue ?? 0,
  }));
}

async function getTopClients(start: Date, end: Date, limit = 3): Promise<TopClient[]> {
  const agg = await ManualBooking.aggregate([
    {
      $match: {
        bookingDate: { $gte: start, $lte: end },
        isActive: { $ne: false },
        workspaceId: { $ne: null },
      },
    },
    {
      $group: {
        _id: "$workspaceId",
        bookings: { $sum: 1 },
        revenue: { $sum: { $ifNull: ["$pricing.quotedPrice", 0] } },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: limit },
  ]);
  if (!agg.length) return [];

  const wsIds = agg.map((a: any) => a._id).filter(Boolean);
  const customers = await Customer.find(
    { _id: { $in: wsIds } },
    { name: 1, legalName: 1 },
  ).lean();
  const map = new Map(
    customers.map((c: any) => [String(c._id), c.name || c.legalName || "Unknown"]),
  );

  return agg.map((a: any) => ({
    name: map.get(String(a._id)) ?? "Unknown",
    bookings: a.bookings ?? 0,
    revenue: a.revenue ?? 0,
  }));
}

async function getPipelineMetrics(todayEnd: Date): Promise<PipelineMetrics> {
  const sevenDaysAgo = new Date(todayEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  const tomorrowEnd = new Date(todayEnd.getTime() + 24 * 60 * 60 * 1000);

  const [
    awaitingPaymentAgg,
    overdueAgg,
    draftsToSendCount,
    approvalRequestsPending,
    holdsExpiring,
  ] = await Promise.all([
    Invoice.aggregate([
      { $match: { status: "SENT" } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$grandTotal" } } },
    ]),
    Invoice.aggregate([
      { $match: { status: "SENT", dueDate: { $lt: sevenDaysAgo } } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$grandTotal" } } },
    ]),
    Invoice.countDocuments({ status: "DRAFT" }),
    ApprovalRequest.countDocuments({
      status: "pending",
      adminState: { $in: ["pending", "in_progress"] },
    }),
    SBTHotelBooking.countDocuments({
      status: "HELD",
      lastVoucherDate: { $gte: todayEnd, $lte: tomorrowEnd },
    }),
  ]);

  return {
    awaitingPayment: {
      count: awaitingPaymentAgg[0]?.count ?? 0,
      total: awaitingPaymentAgg[0]?.total ?? 0,
    },
    overdue: {
      count: overdueAgg[0]?.count ?? 0,
      total: overdueAgg[0]?.total ?? 0,
    },
    draftsToSendCount,
    approvalRequestsPending,
    holdsExpiring,
  };
}

async function getAlerts(
  todayStart: Date,
  todayEnd: Date,
  toggles: IEodAlertToggles,
): Promise<string[]> {
  const tomorrowEnd = new Date(todayEnd.getTime() + 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(todayEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
  const out: string[] = [];

  if (toggles.failedBookings) {
    const failedToday = await ManualBooking.countDocuments({
      bookingDate: { $gte: todayStart, $lte: todayEnd },
      status: "FAILED",
      isActive: { $ne: false },
    });
    if (failedToday > 0) {
      out.push(
        `⚠️ ${failedToday} booking${failedToday > 1 ? "s" : ""} marked FAILED today — review & retry`,
      );
    }
  }

  if (toggles.holdsExpiring) {
    const expiringHolds = await SBTHotelBooking.find({
      status: "HELD",
      lastVoucherDate: { $gte: todayEnd, $lte: tomorrowEnd },
    })
      .select("hotelName lastVoucherDate guests")
      .sort({ lastVoucherDate: 1 })
      .limit(3)
      .lean();

    for (const h of expiringHolds) {
      const expiry = h.lastVoucherDate
        ? new Date(h.lastVoucherDate).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            day: "numeric",
            month: "short",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          })
        : "soon";
      const lead = (h.guests as any[] | undefined)?.find((g) => g?.LeadPassenger);
      const guestName = lead
        ? `${lead.FirstName ?? ""} ${lead.LastName ?? ""}`.trim()
        : "";
      const suffix = guestName ? ` · ${guestName}` : "";
      out.push(`🏨 Hold expiring ${expiry}: ${h.hotelName ?? "Unknown hotel"}${suffix}`);
    }
  }

  if (toggles.overdueInvoices) {
    const overdueAgg = await Invoice.aggregate([
      { $match: { status: "SENT", dueDate: { $lt: sevenDaysAgo } } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$grandTotal" } } },
    ]);
    const count = overdueAgg[0]?.count ?? 0;
    if (count > 0) {
      const total = overdueAgg[0]?.total ?? 0;
      out.push(`🔴 ${count} invoice${count > 1 ? "s" : ""} overdue >7d — ${formatINR(total)}`);
    }
  }

  return out;
}

async function getLast7DayTrend(todayStr: string): Promise<TrendPoint[]> {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) days.push(shiftDateStr(todayStr, -i));

  const earliest = parseISTStart(days[0]);
  const latest = parseISTEnd(days[6]);

  const agg = await ManualBooking.aggregate([
    {
      $match: {
        bookingDate: { $gte: earliest, $lte: latest },
        isActive: { $ne: false },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$bookingDate",
            timezone: "Asia/Kolkata",
          },
        },
        totalQuoted: { $sum: { $ifNull: ["$pricing.quotedPrice", 0] } },
        totalGST: { $sum: { $ifNull: ["$pricing.gstAmount", 0] } },
      },
    },
  ]);

  const map = new Map<string, number>();
  for (const r of agg as any[]) {
    map.set(String(r._id), (r.totalQuoted ?? 0) - (r.totalGST ?? 0));
  }

  return days.map((d, i) => ({
    label: i === 6 ? "Today" : weekdayShortFromIstStr(d),
    netSales: map.get(d) ?? 0,
    isToday: i === 6,
  }));
}

/* ─────────────────────────── Public: snapshot ─────────────────── */
export async function computeEodSnapshot(
  sectionsOverride?: Partial<IEodSections>,
): Promise<EodSnapshot> {
  const config = await EodReportConfig.findOne().lean();
  const baseSections = normalizeSections(config?.sections);
  const sections: IEodSections = sectionsOverride
    ? {
        ...baseSections,
        ...sectionsOverride,
        alerts: {
          ...baseSections.alerts,
          ...((sectionsOverride.alerts as Partial<IEodAlertToggles>) ?? {}),
        },
      }
    : baseSections;

  const todayStr = todayInIST();
  const wtdStartStr = getMondayOfWeekIST(todayStr);
  const mtdStartStr = firstOfMonthIST(todayStr);

  const todayStart = parseISTStart(todayStr);
  const todayEnd = parseISTEnd(todayStr);
  const wtdStart = parseISTStart(wtdStartStr);
  const mtdStart = parseISTStart(mtdStartStr);

  const generatedAt = new Date();
  const dateLabel = generatedAt.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const timeLabel = generatedAt.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const timeLabelLong = generatedAt.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const monthLabel = generatedAt.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "short",
  });
  const dayOfMonth = parseInt(todayStr.split("-")[2], 10);

  const [today, wtd, mtd, trend7d, breakdown, performers, clients, pipeline, alerts] =
    await Promise.all([
      getKpisForRange(todayStart, todayEnd),
      sections.wtdSummary ? getKpisForRange(wtdStart, todayEnd) : Promise.resolve(null),
      sections.mtdSummary ? getKpisForRange(mtdStart, todayEnd) : Promise.resolve(null),
      getLast7DayTrend(todayStr),
      sections.typeBreakdown
        ? getBreakdownByType(todayStart, todayEnd)
        : Promise.resolve([] as TypeBreakdownRow[]),
      sections.topPerformers
        ? getTopPerformers(todayStart, todayEnd)
        : Promise.resolve([] as TopPerformer[]),
      sections.topClients
        ? getTopClients(todayStart, todayEnd)
        : Promise.resolve([] as TopClient[]),
      sections.pipelineFollowups
        ? getPipelineMetrics(todayEnd)
        : Promise.resolve(null),
      getAlerts(todayStart, todayEnd, sections.alerts),
    ]);

  return {
    generatedAt,
    dateLabel,
    timeLabel,
    timeLabelLong,
    todayStr,
    dayOfMonth,
    monthLabel,
    sections,
    today,
    wtd,
    mtd,
    trend7d,
    breakdown,
    performers,
    clients,
    pipeline,
    alerts,
  };
}

/* ─────────────────────────── Text rendering (fallback) ───────── */
export function buildEodMessageFromSnapshot(snapshot: EodSnapshot): string {
  const { sections } = snapshot;
  const RULE = "━━━━━━━━━━━━━━━";
  let msg = `🌅 *PLUMTRIPS EOD SNAPSHOT*\n📅 ${snapshot.dateLabel} · ${snapshot.timeLabel} IST\n\n`;

  if (sections.todaySnapshot) {
    msg += `${RULE}\n*TODAY*\n${RULE}\n`;
    msg += `🎫 Bookings: ${formatNumber(snapshot.today.bookings)}\n`;
    msg += `💰 Sales: ${formatINR(snapshot.today.revenue)}\n`;
    msg += `📊 GST: ${formatINR(snapshot.today.gst)}\n`;
    msg += `📈 Base Profit: ${formatINR(snapshot.today.baseProfit)}\n`;
    msg += `📐 Margin*: ${snapshot.today.margin.toFixed(1)}%\n`;
    msg += `_* Margin % computed on Net Sales (Sales − GST)_\n\n`;
  }

  if (snapshot.wtd) {
    msg += `${RULE}\n*WEEK TO DATE* (Mon–Today)\n${RULE}\n`;
    msg += `🎫 Bookings: ${formatNumber(snapshot.wtd.bookings)}\n`;
    msg += `💰 Sales: ${formatINR(snapshot.wtd.revenue)}\n`;
    msg += `📈 Base Profit: ${formatINR(snapshot.wtd.baseProfit)}\n`;
    msg += `📐 Margin: ${snapshot.wtd.margin.toFixed(1)}%\n\n`;
  }

  if (snapshot.mtd) {
    msg += `${RULE}\n*MONTH TO DATE* (${snapshot.monthLabel} 1–${snapshot.dayOfMonth})\n${RULE}\n`;
    msg += `🎫 Bookings: ${formatNumber(snapshot.mtd.bookings)}\n`;
    msg += `💰 Sales: ${formatINR(snapshot.mtd.revenue)}\n`;
    msg += `📈 Base Profit: ${formatINR(snapshot.mtd.baseProfit)}\n`;
    msg += `📐 Margin: ${snapshot.mtd.margin.toFixed(1)}%\n\n`;
  }

  if (snapshot.breakdown.length > 0) {
    msg += `${RULE}\n*BREAKDOWN (TODAY)*\n${RULE}\n`;
    snapshot.breakdown.forEach((b) => {
      const emoji =
        b._id === "FLIGHT"
          ? "✈️"
          : b._id === "HOTEL"
            ? "🏨"
            : b._id === "VISA"
              ? "📑"
              : b._id === "TRANSFER" || b._id === "CAB"
                ? "🚖"
                : b._id === "TRAIN"
                  ? "🚆"
                  : "📦";
      msg += `${emoji} ${b._id}: ${b.bookings} booking${b.bookings !== 1 ? "s" : ""} · ${formatINR(b.netSales)} · ${b.margin.toFixed(1)}% margin\n`;
    });
    msg += `\n`;
  }

  if (snapshot.performers.length > 0) {
    msg += `${RULE}\n*TOP PERFORMERS (TODAY)*\n${RULE}\n`;
    const medals = ["🥇", "🥈", "🥉"];
    snapshot.performers.forEach((p, i) => {
      msg += `${medals[i] ?? "·"} ${p.name}: ${p.bookings} booking${p.bookings !== 1 ? "s" : ""} · ${formatINR(p.revenue)}\n`;
    });
    msg += `\n`;
  }

  if (snapshot.clients.length > 0) {
    msg += `${RULE}\n*TOP CLIENTS (TODAY)*\n${RULE}\n`;
    snapshot.clients.forEach((c, i) => {
      msg += `${i + 1}. ${c.name} — ${c.bookings} booking${c.bookings !== 1 ? "s" : ""} · ${formatINR(c.revenue)}\n`;
    });
    msg += `\n`;
  }

  if (snapshot.pipeline) {
    msg += `${RULE}\n*PIPELINE & FOLLOW-UPS*\n${RULE}\n`;
    msg += `⏳ Awaiting Payment: ${snapshot.pipeline.awaitingPayment.count} invoice${snapshot.pipeline.awaitingPayment.count !== 1 ? "s" : ""} · ${formatINR(snapshot.pipeline.awaitingPayment.total)}\n`;
    msg += `🔴 Overdue (>7d): ${snapshot.pipeline.overdue.count} invoice${snapshot.pipeline.overdue.count !== 1 ? "s" : ""} · ${formatINR(snapshot.pipeline.overdue.total)}\n`;
    msg += `📋 Drafts to Send: ${snapshot.pipeline.draftsToSendCount}\n`;
    msg += `✋ Approval Requests Pending: ${snapshot.pipeline.approvalRequestsPending}\n`;
    msg += `🏨 Holds Expiring in 24h: ${snapshot.pipeline.holdsExpiring}\n\n`;
  }

  if (snapshot.alerts.length > 0) {
    msg += `${RULE}\n*ALERTS*\n${RULE}\n`;
    snapshot.alerts.forEach((a) => (msg += `${a}\n`));
    msg += `\n`;
  }

  msg += `${RULE}\nView full dashboard: plumbox.plumtrips.com/admin/reports\nGenerated: ${snapshot.timeLabel} IST`;
  return msg;
}

/** Convenience wrapper — fetches snapshot then formats text. */
export async function buildEodMessage(
  sectionsOverride?: Partial<IEodSections>,
): Promise<string> {
  const snapshot = await computeEodSnapshot(sectionsOverride);
  return buildEodMessageFromSnapshot(snapshot);
}

/* ─────────────────────────── Caption ────────────────────────── */
export function buildEodCaption(snapshot: EodSnapshot): string {
  const t = snapshot.today;
  return (
    `📊 Plumtrips EOD · ${snapshot.dateLabel}\n` +
    `${formatNumber(t.bookings)} booking${t.bookings !== 1 ? "s" : ""} · ` +
    `${formatINR(t.netSales)} net sales · ${t.margin.toFixed(1)}% margin\n` +
    `View dashboard → plumbox.plumtrips.com/admin/reports`
  );
}

/* ─────────────────────────── Send pipeline ─────────────────── */
type SendResult = { sent: number; failed: number; errors: string[] };

export async function sendEodReport(opts?: {
  recipientsOverride?: IEodRecipient[];
  sectionsOverride?: Partial<IEodSections>;
  persistStatus?: boolean;
}): Promise<SendResult & { caption: string; mode: "image" | "text" }> {
  const persistStatus = opts?.persistStatus ?? true;
  const snapshot = await computeEodSnapshot(opts?.sectionsOverride);
  const caption = buildEodCaption(snapshot);

  let result: SendResult;
  let mode: "image" | "text" = "image";

  try {
    const html = buildEodHtml(snapshot);
    const imageBuffer = await renderEodImage(html);
    result = await whatsappService.sendImageToRecipients(
      imageBuffer,
      caption,
      opts?.recipientsOverride,
    );
  } catch (renderError: any) {
    logger.error("[EOD] Image render failed, falling back to text", {
      message: renderError?.message,
      stack: renderError?.stack,
      name: renderError?.name,
      cause: renderError?.cause,
    });
    mode = "text";
    const textMessage = buildEodMessageFromSnapshot(snapshot);
    result = await whatsappService.sendToRecipients(
      textMessage,
      opts?.recipientsOverride,
    );
  }

  if (persistStatus) {
    await EodReportConfig.findOneAndUpdate(
      {},
      {
        lastSentAt: new Date(),
        lastSentStatus: result.failed === 0 ? "success" : "partial",
        lastSentError: result.errors.join(", "),
      },
      { upsert: true },
    );
  }

  logger.info(`[EOD] Report sent (${mode}): ${result.sent} ok, ${result.failed} failed`);

  return { ...result, caption, mode };
}
