// apps/backend/src/routes/stats.ts
import { Router, Request, Response, NextFunction } from "express";
import requireAuth from "../middleware/auth.js";
import Attendance from "../models/Attendance.js";
import LeaveRequest from "../models/LeaveRequest.js";
import dayjs from "dayjs";

const router = Router();

type AttendancePoint = {
  label: string;
  value: number;
};

type LeaveSlice = {
  type: string;
  value: number;
};

export type DashboardStats = {
  attendancePercent: string;
  leavesTaken: string;
  pendingApprovals: string;
  docsUploaded: string;
  attendance: AttendancePoint[];
  leaveMix: LeaveSlice[];
};

// 🔒 always ensure req.user.sub exists
router.use(requireAuth as any);

// ───────────────── helpers ─────────────────

function calcLeaveDays(l: any): number {
  // Prefer explicit numeric field if present
  if (typeof l.days === "number" && isFinite(l.days) && l.days > 0) {
    return l.days;
  }
  if (typeof l.noOfDays === "number" && isFinite(l.noOfDays) && l.noOfDays > 0) {
    return l.noOfDays;
  }

  const rawFrom =
    l.from || l.fromDate || l.start || l.startDate;
  const rawTo =
    l.to || l.toDate || l.end || l.endDate || rawFrom;

  if (!rawFrom || !rawTo) return 0;

  const fromDate = new Date(rawFrom);
  const toDate = new Date(rawTo);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return 0;
  }

  const diffMs = toDate.getTime() - fromDate.getTime();
  if (diffMs < 0) return 0;

  const baseDays = Math.floor(diffMs / 86400000) + 1;

  const dayLength = String(l.dayLength || "").toUpperCase();
  const halfDay = Boolean(l.halfDay);

  if (dayLength === "HALF" || halfDay) {
    if (baseDays === 1) return 0.5;
    return baseDays - 0.5;
  }

  return baseDays;
}

// ───────────────── route: /api/stats/dashboard ─────────────────

router.get(
  "/dashboard",
  async (req: Request, res: Response, _next: NextFunction) => {
    const fallback: DashboardStats = {
      attendancePercent: "—",
      leavesTaken: "0",
      pendingApprovals: "0",
      docsUploaded: "0",
      attendance: [],
      leaveMix: [],
    };

    try {
      const user = (req as any).user || {};
      const userId: string = user.sub || "";

      if (!userId) {
        console.warn("[stats] No user.sub on request – returning fallback");
        return res.json(fallback);
      }

      // ───────── Attendance (last 30 days) ─────────
      const today = dayjs().startOf("day");
      const from = today.subtract(29, "day"); // last 30 calendar days

      const attendanceDocs: any[] = await Attendance.find({
        userId,
        date: {
          $gte: from.format("YYYY-MM-DD"),
          $lte: today.format("YYYY-MM-DD"),
        },
      })
        .sort({ date: 1 })
        .lean();

      const attendance: AttendancePoint[] = [];
      let presentDays = 0;

      for (const doc of attendanceDocs) {
        const label: string = doc.date || "";
        const punches: any[] = Array.isArray(doc.punches) ? doc.punches : [];
        const hasIn = punches.some(
          (p) => p && typeof p.type === "string" && p.type.toUpperCase() === "IN"
        );

        if (hasIn) presentDays += 1;

        attendance.push({
          label,
          value: hasIn ? 1 : 0,
        });
      }

      const totalDays = attendanceDocs.length;
      const attendancePercent =
        totalDays > 0
          ? `${Math.round((presentDays / totalDays) * 100)}%`
          : "—";

      // ───────── Leaves (all time – new LeaveRequest model) ─────────
      const leavesDocs: any[] = await LeaveRequest.find({ userId }).lean();

      console.log(
        "[stats] LeaveRequest docs for user",
        userId,
        "=> count:",
        leavesDocs.length,
        leavesDocs.map((l) => ({
          id: l._id,
          status: l.status,
          type: l.type,
          from: l.from,
          to: l.to,
        }))
      );

      let leavesTakenDays = 0;
      let pendingApprovals = 0;
      const leaveMixMap = new Map<string, number>();

      for (const leave of leavesDocs) {
        if (!leave) continue;

        const status = String(leave.status || "").toUpperCase();
        const type = String(
          leave.type || leave.leaveType || leave.category || "OTHER"
        ).toUpperCase();

        if (status === "PENDING") {
          pendingApprovals += 1;
        }

        if (status !== "APPROVED") {
          // Only APPROVED leaves count as "taken"
          continue;
        }

        const days = calcLeaveDays(leave);
        if (!days || !isFinite(days)) continue;

        leavesTakenDays += days;

        const current = leaveMixMap.get(type) ?? 0;
        leaveMixMap.set(type, current + days);
      }

      const leaveMix: LeaveSlice[] = Array.from(leaveMixMap.entries()).map(
        ([type, value]) => ({ type, value })
      );

      const docsUploaded = "0"; // placeholder for now

      const payload: DashboardStats = {
        attendancePercent,
        leavesTaken: String(leavesTakenDays),
        pendingApprovals: String(pendingApprovals),
        docsUploaded,
        attendance,
        leaveMix,
      };

      console.log("[stats] dashboard payload (reduced)", {
        attendancePercent: payload.attendancePercent,
        leavesTaken: payload.leavesTaken,
        pendingApprovals: payload.pendingApprovals,
        leaveMix: payload.leaveMix,
      });

      return res.json(payload);
    } catch (err) {
      console.error("⚠️ /api/stats/dashboard error:", err);
      return res.json(fallback);
    }
  }
);

export default router;
