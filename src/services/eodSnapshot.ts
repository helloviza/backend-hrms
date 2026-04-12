// apps/backend/src/services/eodSnapshot.ts
import { EodReportConfig } from "../models/EodReportConfig.js";
import { whatsappService } from "./whatsappService.js";
import ManualBooking from "../models/ManualBooking.js";
import Invoice from "../models/Invoice.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import logger from "../utils/logger.js";

export async function buildEodMessage(): Promise<string> {
  // IST offset: UTC+5:30 = 330 minutes
  const IST = 330 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST);

  // Start of today in IST → back to UTC for DB queries
  const todayIST = new Date(nowIST);
  todayIST.setUTCHours(0, 0, 0, 0);
  const today = new Date(todayIST.getTime() - IST);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

  // Start of current month in IST → back to UTC
  const monthIST = new Date(nowIST);
  monthIST.setUTCDate(1);
  monthIST.setUTCHours(0, 0, 0, 0);
  const currentMonth = new Date(monthIST.getTime() - IST);

  // Week-to-date: Monday as week start, IST-aware
  const weekStartIST = new Date(nowIST);
  const dayOfWeek = weekStartIST.getUTCDay();
  const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  weekStartIST.setUTCDate(weekStartIST.getUTCDate() + diff);
  weekStartIST.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(weekStartIST.getTime() - IST);

  // Today's bookings — check both createdAt and bookingDate
  const todayBookings = await ManualBooking.find({
    $or: [
      { createdAt: { $gte: today, $lt: tomorrow } },
      { bookingDate: { $gte: today, $lt: tomorrow } },
    ],
    status: { $ne: "CANCELLED" },
  }).lean();

  // WTD bookings
  const wtdBookings = await ManualBooking.find({
    $or: [
      { createdAt: { $gte: weekStart } },
      { bookingDate: { $gte: weekStart } },
    ],
    status: { $ne: "CANCELLED" },
  }).lean();

  // MTD bookings
  const mtdBookings = await ManualBooking.find({
    $or: [
      { createdAt: { $gte: currentMonth } },
      { bookingDate: { $gte: currentMonth } },
    ],
    status: { $ne: "CANCELLED" },
  }).lean();

  // Pending invoices (DRAFT = not yet sent, SENT = awaiting payment)
  const pendingInvoices = await Invoice.countDocuments({
    status: { $in: ["DRAFT", "SENT"] },
  });

  // Admin queue — requests pending / in-progress
  const pendingQueue = await ApprovalRequest.countDocuments({
    status: { $in: ["pending", "approved"] },
    adminState: { $in: ["pending", "in_progress"] },
  });

  // Team activity — group by creator email prefix
  const teamMap = new Map<string, { bookings: number; revenue: number }>();
  for (const b of todayBookings) {
    const email = (b as any).createdByEmail || "Unknown";
    const name = email.split("@")[0];
    const existing = teamMap.get(name) ?? { bookings: 0, revenue: 0 };
    teamMap.set(name, {
      bookings: existing.bookings + 1,
      revenue: existing.revenue + ((b as any).pricing?.quotedPrice || 0),
    });
  }

  // Today totals
  const todayRevenue = todayBookings.reduce(
    (s, b) => s + ((b as any).pricing?.quotedPrice || 0),
    0,
  );
  const todayProfit = todayBookings.reduce(
    (s, b) => s + ((b as any).pricing?.diff || 0),
    0,
  );
  const todayFlights = todayBookings.filter(
    (b) => (b as any).type === "FLIGHT",
  ).length;
  const todayHotels = todayBookings.filter(
    (b) => (b as any).type === "HOTEL",
  ).length;
  const avgMargin =
    todayRevenue > 0
      ? ((todayProfit / todayRevenue) * 100).toFixed(1)
      : "0.0";

  // WTD totals
  const wtdRevenue = wtdBookings.reduce(
    (s, b) => s + ((b as any).pricing?.quotedPrice || 0),
    0,
  );
  const wtdProfit = wtdBookings.reduce(
    (s, b) => s + ((b as any).pricing?.diff || 0),
    0,
  );

  // MTD totals
  const mtdRevenue = mtdBookings.reduce(
    (s, b) => s + ((b as any).pricing?.quotedPrice || 0),
    0,
  );
  const mtdProfit = mtdBookings.reduce(
    (s, b) => s + ((b as any).pricing?.diff || 0),
    0,
  );

  const fmt = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

  const dateStr = todayIST.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC", // todayIST is already shifted; use UTC to read correct date
  });

  // Load config — check which sections to include
  const config = await EodReportConfig.findOne().lean();
  const s: Partial<NonNullable<typeof config>["sections"]> =
    config?.sections ?? {};

  let msg = `📊 *Plumtrips Daily Sales Report*\n`;
  msg += `📅 ${dateStr}\n\n`;

  if (s.bookingsToday !== false) {
    msg += `\n`;
    msg += `💼 *BOOKINGS TODAY*\n`;
    msg += `Total: ${todayBookings.length} bookings\n`;
    msg += `✈️ Flights: ${todayFlights}  🏨 Hotels: ${todayHotels}\n\n`;
  }

  if (s.revenueToday !== false) {
    msg += `\n`;
    msg += `💰 *REVENUE TODAY*\n`;
    msg += `Gross:   ${fmt(todayRevenue)}\n`;
    msg += `Profit:  ${fmt(todayProfit)}\n`;
    msg += `Margin:  ${avgMargin}%\n\n`;
  }

  if (s.wtdSummary !== false) {
    msg += `\n`;
    msg += `📊 *THIS WEEK (WTD)*\n`;
    msg += `Bookings: ${wtdBookings.length}\n`;
    msg += `Revenue:  ${fmt(wtdRevenue)}\n`;
    msg += `Profit:   ${fmt(wtdProfit)}\n\n`;
  }

  if (s.mtdSummary !== false) {
    msg += `\n`;
    msg += `📈 *THIS MONTH (MTD)*\n`;
    msg += `Bookings: ${mtdBookings.length}\n`;
    msg += `Revenue:  ${fmt(mtdRevenue)}\n`;
    msg += `Profit:   ${fmt(mtdProfit)}\n\n`;
  }

  if (s.teamActivity !== false) {
    msg += `\n`;
    msg += `👥 *TEAM TODAY*\n`;
    if (teamMap.size === 0) {
      msg += `No bookings recorded today\n\n`;
    } else {
      teamMap.forEach((v, name) => {
        msg += `${name}: ${v.bookings} booking${v.bookings !== 1 ? "s" : ""}  ${fmt(v.revenue)}\n`;
      });
      msg += `\n`;
    }
  }

  if (s.pipeline !== false) {
    msg += `\n`;
    msg += `📋 *PIPELINE*\n`;
    msg += `Pending Invoices: ${pendingInvoices}\n`;
    msg += `Admin Queue:      ${pendingQueue} requests\n\n`;
  }

  msg += `_Sent automatically · Plumbox by Plumtrips 🪐_`;

  return msg;
}

export async function sendEodReport(): Promise<{
  sent: number;
  failed: number;
  errors: string[];
  message: string;
}> {
  const message = await buildEodMessage();
  const result = await whatsappService.sendToAllRecipients(message);

  await EodReportConfig.findOneAndUpdate(
    {},
    {
      lastSentAt: new Date(),
      lastSentStatus: result.failed === 0 ? "success" : "partial",
      lastSentError: result.errors.join(", "),
    },
    { upsert: true },
  );

  logger.info(`[EOD] Report sent: ${result.sent} ok, ${result.failed} failed`);

  return { ...result, message };
}
