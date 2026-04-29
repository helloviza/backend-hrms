// PLUMBOX-005: Hourly cron that emails HELD booking holders 24h and 1h before lastVoucherDate.
import cron from "node-cron";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import User from "../models/User.js";
import { sendMail } from "../utils/mailer.js";
import logger from "../utils/logger.js";

type ReminderType = "24h" | "1h";

async function sendReminderEmail(booking: any, user: any, type: ReminderType) {
  const deadline = new Date(booking.lastVoucherDate).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  await sendMail({
    to: user.email,
    subject: `${type === "24h" ? "24-hour" : "1-hour"} reminder: Hotel voucher deadline approaching`,
    kind: "CONFIRMATIONS",
    html: `
      <div style="font-family:DM Sans,sans-serif;max-width:600px;margin:auto;padding:32px;background:#fff;color:#1c1c1c;">
        <h2 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;font-weight:600;color:#1c1c1c;margin:0 0 16px;">
          Hotel Voucher Deadline — ${type === "24h" ? "24 Hours" : "1 Hour"} Remaining
        </h2>
        <p style="margin:0 0 12px;">Dear ${user.name || user.firstName || "Guest"},</p>
        <p style="margin:0 0 20px;">
          Your held booking at <strong>${booking.hotelName}</strong> requires a voucher to be generated
          by <strong>${deadline} IST</strong>. After this deadline, the booking may be auto-cancelled by the supplier.
        </p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
          <tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Hotel</td>
              <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;font-weight:500;">${booking.hotelName}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">City</td>
              <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;">${booking.cityName}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Check-in</td>
              <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;">${booking.checkIn}</td></tr>
          <tr><td style="padding:8px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Check-out</td>
              <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;">${booking.checkOut}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;font-size:14px;">Voucher Deadline</td>
              <td style="padding:8px 0;color:#d97706;font-weight:600;">${deadline} IST</td></tr>
        </table>
        <a href="${process.env.FRONTEND_ORIGIN || "https://hrms.plumtrips.com"}/sbt/hotels/bookings"
           style="display:inline-block;background:#1c1c1c;color:#fff;text-decoration:none;padding:12px 28px;border-radius:4px;font-size:14px;font-weight:500;">
          Generate Voucher Now
        </a>
        <p style="margin:24px 0 0;font-size:12px;color:#9ca3af;">
          Booking Ref: ${booking.bookingRefNo || booking.bookingId} &middot; Confirmation: ${booking.confirmationNo || "–"}
        </p>
      </div>
    `,
  });
}

async function runHoldReminders() {
  const now = new Date();

  // Windows: [now+23h, now+25h] for 24h reminder, [now-1m, now+61m] for 1h reminder
  const in24hFrom = new Date(now.getTime() + 23 * 3600 * 1000);
  const in24hTo = new Date(now.getTime() + 25 * 3600 * 1000);
  const in1hFrom = new Date(now.getTime() + 1 * 60 * 1000);
  const in1hTo = new Date(now.getTime() + 61 * 60 * 1000);

  const candidates = await SBTHotelBooking.find({
    status: "HELD",
    lastVoucherDate: { $gte: in1hFrom, $lte: in24hTo },
  }).lean();

  for (const booking of candidates) {
    const vd = new Date(booking.lastVoucherDate!);
    const existingTypes = (booking.reminders || []).map((r: any) => r.type);

    const needsCheck: ReminderType[] = [];
    if (vd <= in24hTo && vd >= in24hFrom && !existingTypes.includes("24h")) needsCheck.push("24h");
    if (vd <= in1hTo && vd >= in1hFrom && !existingTypes.includes("1h")) needsCheck.push("1h");

    if (needsCheck.length === 0) continue;

    try {
      const user = await User.findById(booking.userId).lean();
      if (!user?.email) continue;

      for (const type of needsCheck) {
        await sendReminderEmail(booking, user, type);
        await SBTHotelBooking.findByIdAndUpdate(booking._id, {
          $push: { reminders: { type, sentAt: new Date() } },
        });
        logger.info("[HoldReminder] Email sent", { bookingId: booking._id, type, userId: booking.userId });
      }
    } catch (e: any) {
      logger.error("[HoldReminder] Failed to send reminder", { bookingId: booking._id, error: e?.message });
    }
  }
}

export function startHoldBookingReminderCron(): void {
  // Run every hour at :00
  cron.schedule("0 * * * *", async () => {
    logger.info("[HoldReminder] Cron triggered");
    try {
      await runHoldReminders();
    } catch (e: any) {
      logger.error("[HoldReminder] Cron run failed", { error: e?.message });
    }
  });
  logger.info("[HoldReminder] Cron scheduled — hourly at :00");
}
