import { Router } from "express";
import requireAuth from "../middleware/auth.js"; // <- default import now ok
import Attendance from "../models/Attendance.js";
import { audit } from "../middleware/audit.js";
import dayjs from "dayjs";

const r = Router();

r.use(requireAuth);

/**
 * Legacy toggle route used by existing frontend:
 * POST /api/attendance/punch
 *
 * - If last punch was IN  → next is OUT
 * - If last punch was OUT → next is IN
 * - If no punches yet     → start with IN
 */
r.post("/punch", audit("punch-toggle"), async (req, res) => {
  const userId = (req as any).user.sub;
  const date = dayjs().format("YYYY-MM-DD");
  const geo = req.body?.geo || null;

  // Find today's record to see last punch type
  const today: any = await Attendance.findOne({ userId, date }).lean();

  let nextType: "IN" | "OUT" = "IN";
  if (today && Array.isArray(today.punches) && today.punches.length > 0) {
    const last = today.punches[today.punches.length - 1];
    nextType = last?.type === "IN" ? "OUT" : "IN";
  }

  const doc = await Attendance.findOneAndUpdate(
    { userId, date },
    { $push: { punches: { ts: new Date(), type: nextType, geo } } },
    { upsert: true, new: true }
  );

  res.json(doc);
});

r.post("/punch-in", audit("punch-in"), async (req, res) => {
  const userId = (req as any).user.sub;
  const date = dayjs().format("YYYY-MM-DD");
  const geo = req.body.geo || null;
  const doc = await Attendance.findOneAndUpdate(
    { userId, date },
    { $push: { punches: { ts: new Date(), type: "IN", geo } } },
    { upsert: true, new: true }
  );
  res.json(doc);
});

r.post("/punch-out", audit("punch-out"), async (req, res) => {
  const userId = (req as any).user.sub;
  const date = dayjs().format("YYYY-MM-DD");
  const geo = req.body.geo || null;
  const doc = await Attendance.findOneAndUpdate(
    { userId, date },
    { $push: { punches: { ts: new Date(), type: "OUT", geo } } },
    { upsert: true, new: true }
  );
  res.json(doc);
});

/**
 * GET /api/attendance/reports
 *
 * Two modes:
 * 1) range=month (no from/to) → aggregated view for the **logged-in user**
 *    used by /api/stats/dashboard
 * 2) from/to/userId           → legacy mode, returns { items }
 */
r.get("/reports", async (req, res) => {
  const { from, to, userId: userIdParam, range } = req.query as any;

  // ───────────────── monthly summary for current user (used by stats.ts) ─────────────────
  if (range === "month" && !from && !to) {
    const authUserId = (req as any).user?.sub;
    if (!authUserId) {
      return res.status(401).json({ message: "Unauthorised" });
    }

    const today = dayjs();
    const start = today.startOf("month");
    const end = today; // up to today

    const fromStr = start.format("YYYY-MM-DD");
    const toStr = end.format("YYYY-MM-DD");

    const records: any[] = await Attendance.find({
      userId: authUserId,
      date: { $gte: fromStr, $lte: toStr },
    }).lean();

    // Consider a day "present" if there is at least one punch
    const presentDates = new Set<string>();
    for (const rec of records) {
      if (Array.isArray(rec.punches) && rec.punches.length > 0 && rec.date) {
        presentDates.add(rec.date);
      }
    }

    const totalDays = end.diff(start, "day") + 1;
    const presentCount = presentDates.size;
    const thisMonthPercent =
      totalDays > 0 ? Math.round((presentCount / totalDays) * 100) : 0;

    // Build simple daily chart: 100 = present, 0 = absent
    const points: { label: string; value: number }[] = [];
    for (let i = 0; i < totalDays; i++) {
      const d = start.add(i, "day");
      const dateStr = d.format("YYYY-MM-DD");
      const label = d.format("DD");
      const value = presentDates.has(dateStr) ? 100 : 0;
      points.push({ label, value });
    }

    return res.json({
      thisMonthPercent,
      attendancePercent: thisMonthPercent, // extra alias if any caller expects it
      chart: { points },
    });
  }

  // ───────────────── legacy list mode (admin reports etc.) ─────────────────
  const q: any = {};
  if (userIdParam) q.userId = userIdParam;
  if (from && to) q.date = { $gte: from, $lte: to };

  const items = await Attendance.find(q).lean();
  return res.json({ items });
});

export default r;
