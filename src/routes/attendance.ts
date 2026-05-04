import { Router, Request, Response, NextFunction } from "express";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireRoles } from "../middleware/roles.js";
import Attendance from "../models/Attendance.js";
import Employee from "../models/Employee.js";
import User from "../models/User.js";
import Holiday from "../models/Holiday.js";
import LeaveRequest from "../models/LeaveRequest.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
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
r.post("/punch", requireWorkspace, audit("punch-toggle"), async (req: any, res) => {
  const userId = req.user.sub;
  const date = dayjs().format("YYYY-MM-DD");
  const geo = req.body?.geo || null;
  const workspaceId = req.workspaceObjectId;

  // Find today's record to see last punch type
  const today: any = await Attendance.findOne({ userId, date, workspaceId }).lean();

  let nextType: "IN" | "OUT" = "IN";
  if (today && Array.isArray(today.punches) && today.punches.length > 0) {
    const last = today.punches[today.punches.length - 1];
    nextType = last?.type === "IN" ? "OUT" : "IN";
  }

  const doc = await Attendance.findOneAndUpdate(
    { userId, date, workspaceId },
    { $push: { punches: { ts: new Date(), type: nextType, geo } } },
    { upsert: true, new: true }
  );

  res.json(doc);
});

r.post("/punch-in", requireWorkspace, audit("punch-in"), async (req: any, res) => {
  const userId = req.user.sub;
  const date = dayjs().format("YYYY-MM-DD");
  const geo = req.body.geo || null;
  const doc = await Attendance.findOneAndUpdate(
    { userId, date, workspaceId: req.workspaceObjectId },
    { $push: { punches: { ts: new Date(), type: "IN", geo } } },
    { upsert: true, new: true }
  );
  res.json(doc);
});

r.post("/punch-out", requireWorkspace, audit("punch-out"), async (req: any, res) => {
  const userId = req.user.sub;
  const date = dayjs().format("YYYY-MM-DD");
  const geo = req.body.geo || null;
  const doc = await Attendance.findOneAndUpdate(
    { userId, date, workspaceId: req.workspaceObjectId },
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
r.get("/reports", requireWorkspace, async (req, res) => {
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
      workspaceId: (req as any).workspaceObjectId,
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
  const authUserId2 = (req as any).user?.sub;
  const targetUserId = userIdParam || authUserId2;

  // Non-admin users can only view their own attendance
  if (userIdParam && !hasRole(req, "MANAGER", "HR", "ADMIN") && String(userIdParam) !== String(authUserId2)) {
    return res.status(403).json({ error: "Cannot view other users attendance" });
  }

  const q: any = { workspaceId: (req as any).workspaceObjectId };
  if (targetUserId) q.userId = targetUserId;
  if (from && to) q.date = { $gte: from, $lte: to };

  const items = await Attendance.find(q).lean();
  return res.json({ items });
});

// ─── Regularization helpers ────────────────────────────────────

function hasRole(req: Request, ...roles: string[]): boolean {
  const userRoles: string[] = (req as any).user?.roles || [];
  return userRoles.some(
    (r) => roles.includes(r.toUpperCase()) || r.toUpperCase() === "SUPERADMIN",
  );
}

// ───────────────── REGULARIZATION: SUBMIT ─────────────────
r.post(
  "/regularize",
  requireWorkspace,
  audit("regularize-submit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.sub;
      const workspaceId = req.workspaceId;
      const { date, reason, from, to } = req.body;

      if (!date || !reason || !from || !to) {
        return res.status(400).json({ error: "date, reason, from, and to are required" });
      }

      // Validate date is not in the future
      const today = dayjs().format("YYYY-MM-DD");
      if (date > today) {
        return res.status(400).json({ error: "Cannot regularize a future date" });
      }

      // Validate date is within last 30 days
      const cutoff = dayjs().subtract(30, "day").format("YYYY-MM-DD");
      if (date < cutoff) {
        return res.status(400).json({ error: "Regularization allowed only for last 30 days" });
      }

      // Find or create attendance doc
      let att: any = await Attendance.findOne({ workspaceId, userId, date });
      if (!att) {
        att = await Attendance.create({ workspaceId, userId, date, punches: [], odRequests: [] });
      }

      // Check no PENDING odRequest for this date
      const hasPending = (att.odRequests || []).some(
        (od: any) => od.status === "PENDING",
      );
      if (hasPending) {
        return res.status(409).json({ error: "A pending regularization request already exists for this date" });
      }

      att.odRequests.push({
        reason,
        from,
        to,
        status: "PENDING",
        requestedAt: new Date(),
      });
      await att.save();

      return res.json({ success: true, message: "Regularization request submitted" });
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── REGULARIZATION: MY REQUESTS ─────────────────
r.get(
  "/regularize/mine",
  requireWorkspace,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.sub;
      const workspaceId = req.workspaceId;
      const { status, page = "1", limit = "20" } = req.query as any;

      const docs: any[] = await Attendance.find({
        workspaceId,
        userId,
        "odRequests.0": { $exists: true },
      }).lean();

      let items: any[] = [];
      for (const doc of docs) {
        for (const od of doc.odRequests || []) {
          items.push({
            attendanceId: doc._id,
            odRequestId: od._id,
            date: doc.date,
            from: od.from,
            to: od.to,
            reason: od.reason,
            status: od.status,
            requestedAt: od.requestedAt,
            remarks: od.remarks,
          });
        }
      }

      // Filter by status
      if (status) {
        items = items.filter((i) => i.status === status.toUpperCase());
      }

      // Sort by requestedAt desc
      items.sort(
        (a, b) =>
          new Date(b.requestedAt || 0).getTime() -
          new Date(a.requestedAt || 0).getTime(),
      );

      // Paginate
      const pg = Math.max(1, parseInt(page, 10));
      const lim = Math.min(100, Math.max(1, parseInt(limit, 10)));
      const start = (pg - 1) * lim;
      const paged = items.slice(start, start + lim);

      return res.json({ items: paged, total: items.length, page: pg, limit: lim });
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── REGULARIZATION: TEAM REQUESTS ─────────────────
r.get(
  "/regularize/team",
  requireWorkspace,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRole(req, "MANAGER", "HR", "ADMIN")) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const userId = (req as any).user.sub;
      const workspaceId = req.workspaceId;
      const { status = "PENDING", page = "1", limit = "50" } = req.query as any;
      const isHrAdmin = hasRole(req, "HR", "ADMIN");

      let userFilter: any = { workspaceId };

      if (!isHrAdmin) {
        // Manager: find direct reports
        const myEmp = await Employee.findOne({ ownerId: userId, workspaceId });
        if (!myEmp) return res.json({ items: [], total: 0 });
        const reports = await Employee.find({ managerId: myEmp._id, workspaceId }).select("ownerId");
        const reportIds = reports.map((r) => r.ownerId).filter(Boolean);
        if (!reportIds.length) return res.json({ items: [], total: 0 });
        userFilter.userId = { $in: reportIds };
      }

      const docs: any[] = await Attendance.find({
        ...userFilter,
        "odRequests.0": { $exists: true },
      })
        .populate("userId", "firstName lastName email name")
        .lean();

      let items: any[] = [];
      for (const doc of docs) {
        const user = doc.userId as any;
        const userName =
          user?.firstName && user?.lastName
            ? `${user.firstName} ${user.lastName}`
            : user?.name || user?.email || String(doc.userId);

        for (const od of doc.odRequests || []) {
          items.push({
            attendanceId: doc._id,
            odRequestId: od._id,
            userId: user?._id || doc.userId,
            userName,
            date: doc.date,
            from: od.from,
            to: od.to,
            reason: od.reason,
            status: od.status,
            requestedAt: od.requestedAt,
            remarks: od.remarks,
          });
        }
      }

      // Filter by status
      if (status && status !== "ALL") {
        items = items.filter((i) => i.status === status.toUpperCase());
      }

      items.sort(
        (a, b) =>
          new Date(b.requestedAt || 0).getTime() -
          new Date(a.requestedAt || 0).getTime(),
      );

      const pg = Math.max(1, parseInt(page, 10));
      const lim = Math.min(100, Math.max(1, parseInt(limit, 10)));
      const start = (pg - 1) * lim;
      const paged = items.slice(start, start + lim);

      return res.json({ items: paged, total: items.length, page: pg, limit: lim });
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── REGULARIZATION: APPROVE ─────────────────
r.put(
  "/regularize/:attendanceId/:odRequestId/approve",
  requireWorkspace,
  audit("regularize-approve"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRole(req, "MANAGER", "HR", "ADMIN")) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const { attendanceId, odRequestId } = req.params;
      const workspaceId = req.workspaceId;
      const reviewerId = (req as any).user.sub;
      const { remarks } = req.body || {};

      const att: any = await Attendance.findOne({ _id: attendanceId, workspaceId });
      if (!att) return res.status(404).json({ error: "Attendance record not found" });

      const od = att.odRequests.id(odRequestId);
      if (!od) return res.status(404).json({ error: "Regularization request not found" });
      if (od.status !== "PENDING") {
        return res.status(400).json({ error: "Only PENDING requests can be approved" });
      }

      od.status = "APPROVED";
      od.reviewedBy = reviewerId;
      od.reviewedAt = new Date();
      if (remarks) od.remarks = remarks;

      // Reconstruct punches from approved times
      const dateStr = att.date; // YYYY-MM-DD
      att.punches.push(
        { ts: new Date(`${dateStr}T${od.from}:00`), type: "IN", reconstructed: true },
        { ts: new Date(`${dateStr}T${od.to}:00`), type: "OUT", reconstructed: true },
      );

      await att.save();
      return res.json({ success: true });
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── REGULARIZATION: REJECT ─────────────────
r.put(
  "/regularize/:attendanceId/:odRequestId/reject",
  requireWorkspace,
  audit("regularize-reject"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRole(req, "MANAGER", "HR", "ADMIN")) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const { attendanceId, odRequestId } = req.params;
      const workspaceId = req.workspaceId;
      const reviewerId = (req as any).user.sub;
      const { remarks } = req.body || {};

      if (!remarks) {
        return res.status(400).json({ error: "Remarks are required for rejection" });
      }

      const att: any = await Attendance.findOne({ _id: attendanceId, workspaceId });
      if (!att) return res.status(404).json({ error: "Attendance record not found" });

      const od = att.odRequests.id(odRequestId);
      if (!od) return res.status(404).json({ error: "Regularization request not found" });
      if (od.status !== "PENDING") {
        return res.status(400).json({ error: "Only PENDING requests can be rejected" });
      }

      od.status = "REJECTED";
      od.reviewedBy = reviewerId;
      od.reviewedAt = new Date();
      od.remarks = remarks;

      await att.save();
      return res.json({ success: true });
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── PAYROLL SUMMARY ─────────────────
r.get(
  "/payroll-summary",
  requireWorkspace,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRole(req, "HR", "ADMIN")) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const workspaceId = req.workspaceId;
      const { month, userId: singleUserId } = req.query as any;

      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: "month query param required (YYYY-MM)" });
      }

      const [yearStr, monthStr] = month.split("-");
      const year = parseInt(yearStr, 10);
      const mon = parseInt(monthStr, 10);
      const daysInMonth = new Date(year, mon, 0).getDate();

      // Build working days (Mon-Fri minus GENERAL holidays)
      const holidays = await Holiday.find({
        workspaceId,
        date: { $gte: `${month}-01`, $lte: `${month}-${daysInMonth}` },
        type: "GENERAL",
      })
        .select("date")
        .lean();
      const holidaySet = new Set(holidays.map((h: any) => h.date));

      const workingDays: string[] = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(year, mon - 1, d);
        const dow = dt.getDay();
        const dateStr = dayjs(dt).format("YYYY-MM-DD");
        if (dow !== 0 && dow !== 6 && !holidaySet.has(dateStr)) {
          workingDays.push(dateStr);
        }
      }

      // Get users in scope
      let userQuery: any = { workspaceId, status: { $ne: "INACTIVE" } };
      if (singleUserId) userQuery._id = singleUserId;
      const users = await User.find(userQuery)
        .select("_id firstName lastName email employeeCode name")
        .lean();

      const userIds = users.map((u: any) => u._id);

      // Fetch attendance for all users in this month
      const attendanceDocs: any[] = await Attendance.find({
        workspaceId,
        userId: { $in: userIds },
        date: { $gte: `${month}-01`, $lte: `${month}-${daysInMonth}` },
      }).lean();

      // Index attendance by userId+date
      const attMap: Record<string, any> = {};
      for (const att of attendanceDocs) {
        const key = `${att.userId}_${att.date}`;
        attMap[key] = att;
      }

      // Fetch approved leaves for this month
      const fromDate = new Date(`${month}-01`);
      const toDate = new Date(year, mon, 0);
      const leaveRequests: any[] = await LeaveRequest.find({
        userId: { $in: userIds },
        status: "APPROVED",
        $or: [
          { from: { $lte: toDate }, to: { $gte: fromDate } },
        ],
      }).lean();

      // Build leave days per user in this month
      const leaveDaysMap: Record<string, number> = {};
      for (const lr of leaveRequests) {
        const uid = String(lr.userId);
        const lFrom = new Date(Math.max(new Date(lr.from).getTime(), fromDate.getTime()));
        const lTo = new Date(Math.min(new Date(lr.to).getTime(), toDate.getTime()));
        let count = 0;
        const cur = new Date(lFrom);
        while (cur <= lTo) {
          const ds = dayjs(cur).format("YYYY-MM-DD");
          if (workingDays.includes(ds)) {
            count += lr.dayLength === "HALF" ? 0.5 : 1;
          }
          cur.setDate(cur.getDate() + 1);
        }
        leaveDaysMap[uid] = (leaveDaysMap[uid] || 0) + count;
      }

      // Fetch workspace attendance config
      const workspace: any = await CustomerWorkspace.findById(workspaceId).select("attendanceConfig").lean();
      const attCfg = workspace?.attendanceConfig || {};
      const shiftStartStr: string = attCfg.shiftStart || '09:30';
      const shiftEndStr: string = attCfg.shiftEnd || '18:30';
      const [ssH, ssM] = shiftStartStr.split(':').map(Number);
      const [seH, seM] = shiftEndStr.split(':').map(Number);
      const shiftStart = ssH + ssM / 60;
      const graceMinutes = attCfg.graceMinutes ?? 15;
      const shiftHours = (seH + seM / 60) - shiftStart;
      const halfDayHours = attCfg.halfDayHours ?? 4.5;
      const minHoursForPresent = attCfg.minHoursForPresent ?? 2;

      const summary = users.map((u: any) => {
        const uid = String(u._id);
        const userName =
          u.firstName && u.lastName
            ? `${u.firstName} ${u.lastName}`
            : u.name || u.email || uid;

        let present = 0;
        let halfDay = 0;
        let late = 0;
        let overtime = 0;
        let totalHours = 0;

        for (const dateStr of workingDays) {
          const att = attMap[`${uid}_${dateStr}`];
          if (!att || !att.punches || !att.punches.length) continue;

          const punches = att.punches.sort(
            (a: any, b: any) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
          );

          // Compute hours: pair IN/OUT
          let dayHrs = 0;
          const ins = punches.filter((p: any) => p.type === "IN");
          const outs = punches.filter((p: any) => p.type === "OUT");
          if (ins.length && outs.length) {
            const firstIn = new Date(ins[0].ts).getTime();
            const lastOut = new Date(outs[outs.length - 1].ts).getTime();
            if (lastOut > firstIn) {
              dayHrs = (lastOut - firstIn) / (1000 * 60 * 60);
            }
          }

          totalHours += dayHrs;

          if (dayHrs >= minHoursForPresent && dayHrs < halfDayHours) {
            halfDay++;
          } else if (dayHrs >= halfDayHours) {
            present++;
          }

          // Late check
          if (ins.length) {
            const firstInDate = new Date(ins[0].ts);
            const inHour = firstInDate.getHours();
            const inMin = firstInDate.getMinutes();
            const inMinutes = inHour * 60 + inMin;
            const graceEnd = ssH * 60 + ssM + graceMinutes;
            if (inMinutes > graceEnd) late++;
          }

          // Overtime
          if (dayHrs > shiftHours + 1) overtime++;
        }

        const leaveDays = leaveDaysMap[uid] || 0;
        const absent = Math.max(0, workingDays.length - present - halfDay - leaveDays);
        const lopDays = Math.max(0, absent);
        const avgDailyHours = present > 0 ? +(totalHours / present).toFixed(1) : 0;

        let payrollNote = "Clean";
        if (lopDays > 0) payrollNote = `${lopDays} LOP day${lopDays > 1 ? "s" : ""}`;

        return {
          userId: uid,
          userName,
          employeeId: u.employeeCode || "",
          workingDays: workingDays.length,
          present: present + halfDay * 0.5,
          absent,
          halfDay,
          late,
          overtime,
          leaveDays,
          lopDays,
          totalHours: +totalHours.toFixed(1),
          avgDailyHours,
          payrollNote,
        };
      });

      return res.json({ month, generatedAt: new Date().toISOString(), summary });
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── PAYROLL SUMMARY CSV EXPORT ─────────────────
r.get(
  "/payroll-summary/export.csv",
  requireWorkspace,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRole(req, "HR", "ADMIN")) {
        return res.status(403).json({ error: "Not authorized" });
      }

      // Reuse the payroll-summary logic by calling the same endpoint internally
      // We'll duplicate the core logic to generate CSV directly
      const workspaceId = req.workspaceId;
      const { month } = req.query as any;

      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: "month query param required (YYYY-MM)" });
      }

      // Fake a JSON response by calling the summary endpoint logic
      // Build summary data (same as above - call internal)
      const fakeRes: any = {
        json: (data: any) => data,
        status: () => fakeRes,
      };
      const origQuery = { ...req.query };
      // Forward to the handler above by making an internal call
      // Instead, we just redirect to the JSON endpoint and convert
      // Actually, let's do a lightweight approach: fetch the summary data
      const summaryUrl = `/api/attendance/payroll-summary?month=${month}`;

      // Simpler: generate inline
      const [yearStr, monthStr] = month.split("-");
      const year = parseInt(yearStr, 10);
      const mon = parseInt(monthStr, 10);
      const daysInMonth = new Date(year, mon, 0).getDate();

      const holidays = await Holiday.find({
        workspaceId,
        date: { $gte: `${month}-01`, $lte: `${month}-${daysInMonth}` },
        type: "GENERAL",
      }).select("date").lean();
      const holidaySet = new Set(holidays.map((h: any) => h.date));

      const workingDays: string[] = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(year, mon - 1, d);
        const dow = dt.getDay();
        const dateStr = dayjs(dt).format("YYYY-MM-DD");
        if (dow !== 0 && dow !== 6 && !holidaySet.has(dateStr)) {
          workingDays.push(dateStr);
        }
      }

      const users = await User.find({ workspaceId, status: { $ne: "INACTIVE" } })
        .select("_id firstName lastName email employeeCode name").lean();
      const userIds = users.map((u: any) => u._id);

      const attendanceDocs: any[] = await Attendance.find({
        workspaceId, userId: { $in: userIds },
        date: { $gte: `${month}-01`, $lte: `${month}-${daysInMonth}` },
      }).lean();

      const attMap: Record<string, any> = {};
      for (const att of attendanceDocs) attMap[`${att.userId}_${att.date}`] = att;

      const fromDate = new Date(`${month}-01`);
      const toDate = new Date(year, mon, 0);
      const leaveRequests: any[] = await LeaveRequest.find({
        userId: { $in: userIds }, status: "APPROVED",
        $or: [{ from: { $lte: toDate }, to: { $gte: fromDate } }],
      }).lean();

      const leaveDaysMap: Record<string, number> = {};
      for (const lr of leaveRequests) {
        const uid = String(lr.userId);
        const lFrom = new Date(Math.max(new Date(lr.from).getTime(), fromDate.getTime()));
        const lTo = new Date(Math.min(new Date(lr.to).getTime(), toDate.getTime()));
        let count = 0;
        const cur = new Date(lFrom);
        while (cur <= lTo) {
          if (workingDays.includes(dayjs(cur).format("YYYY-MM-DD"))) {
            count += lr.dayLength === "HALF" ? 0.5 : 1;
          }
          cur.setDate(cur.getDate() + 1);
        }
        leaveDaysMap[uid] = (leaveDaysMap[uid] || 0) + count;
      }

      // Fetch workspace attendance config for CSV export
      const wsDoc: any = await CustomerWorkspace.findById(workspaceId).select("attendanceConfig").lean();
      const csvAttCfg = wsDoc?.attendanceConfig || {};
      const csvShiftStartStr: string = csvAttCfg.shiftStart || '09:30';
      const csvShiftEndStr: string = csvAttCfg.shiftEnd || '18:30';
      const [csvSsH, csvSsM] = csvShiftStartStr.split(':').map(Number);
      const [csvSeH, csvSeM] = csvShiftEndStr.split(':').map(Number);
      const shiftStart = csvSsH + csvSsM / 60;
      const graceMinutes = csvAttCfg.graceMinutes ?? 15;
      const shiftHours = (csvSeH + csvSeM / 60) - shiftStart;
      const csvHalfDayHours = csvAttCfg.halfDayHours ?? 4.5;
      const csvMinHoursForPresent = csvAttCfg.minHoursForPresent ?? 2;

      const csvHeaders = "Employee,Employee ID,Working Days,Present,Absent,Half Day,Late,Overtime,Leave Days,LOP Days,Total Hours,Avg Daily Hours,Note";
      const csvRows = [csvHeaders];

      for (const u of users) {
        const uid = String((u as any)._id);
        const userName = (u as any).firstName && (u as any).lastName
          ? `${(u as any).firstName} ${(u as any).lastName}`
          : (u as any).name || (u as any).email || uid;

        let present = 0, halfDay = 0, late = 0, overtime = 0, totalHours = 0;

        for (const dateStr of workingDays) {
          const att = attMap[`${uid}_${dateStr}`];
          if (!att?.punches?.length) continue;
          const punches = att.punches.sort((a: any, b: any) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
          const ins = punches.filter((p: any) => p.type === "IN");
          const outs = punches.filter((p: any) => p.type === "OUT");
          let dayHrs = 0;
          if (ins.length && outs.length) {
            const fi = new Date(ins[0].ts).getTime();
            const lo = new Date(outs[outs.length - 1].ts).getTime();
            if (lo > fi) dayHrs = (lo - fi) / 3600000;
          }
          totalHours += dayHrs;
          if (dayHrs >= csvMinHoursForPresent && dayHrs < csvHalfDayHours) halfDay++;
          else if (dayHrs >= csvHalfDayHours) present++;
          if (ins.length) {
            const fd = new Date(ins[0].ts);
            if (fd.getHours() * 60 + fd.getMinutes() > csvSsH * 60 + csvSsM + graceMinutes) late++;
          }
          if (dayHrs > shiftHours + 1) overtime++;
        }

        const leaveDays = leaveDaysMap[uid] || 0;
        const absent = Math.max(0, workingDays.length - present - halfDay - leaveDays);
        const avgDailyHours = present > 0 ? (totalHours / present).toFixed(1) : "0";
        let note = "Clean";
        if (absent > 0) note = `${absent} LOP day${absent > 1 ? "s" : ""}`;

        const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
        csvRows.push(
          [esc(userName), esc((u as any).employeeCode || ""), workingDays.length,
            present + halfDay * 0.5, absent, halfDay, late, overtime,
            leaveDays, absent, totalHours.toFixed(1), avgDailyHours, esc(note)].join(","),
        );
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="payroll-summary-${month}.csv"`);
      return res.send(csvRows.join("\n"));
    } catch (err) {
      return next(err);
    }
  },
);

export default r;
