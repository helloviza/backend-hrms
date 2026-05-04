// apps/backend/src/routes/dashboard.ts
import { Router, Request, Response } from "express";

// Real Mongoose models
import Employee from "../models/Employee.js";
import LeaveRequest from "../models/LeaveRequest.js";
import Attendance from "../models/Attendance.js";
import Onboarding from "../models/Onboarding.js";
import User from "../models/User.js";

import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import requireRoles from "../middleware/roles.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers to parse dates & filters
// ---------------------------------------------------------------------------
function parseDate(input: any): Date | null {
  if (!input) return null;

  let value: string | undefined;

  if (Array.isArray(input)) {
    value = String(input[0]);
  } else if (typeof input === "object" && input !== null) {
    if ("value" in input && typeof (input as any).value === "string") {
      value = (input as any).value;
    } else if ("date" in input && typeof (input as any).date === "string") {
      value = (input as any).date;
    } else {
      value = JSON.stringify(input);
    }
  } else {
    value = String(input);
  }

  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function buildFiltersFromQuery(q: Request["query"]) {
  // Date range: ?from=2025-11-01&to=2025-11-30
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const defaultTo = now;

  let from = parseDate(q.from);
  let to = parseDate(q.to);

  if (!from) from = defaultFrom;
  if (!to) to = defaultTo;

  const fromDate = startOfDay(from);
  const toDate = endOfDay(to);

  // Attendance uses string dates "YYYY-MM-DD"
  const fromStr = fromDate.toISOString().slice(0, 10);
  const toStr = toDate.toISOString().slice(0, 10);

  const employeeFilter: any = {};

  // ✅ Leave filter uses `from` / `to` from LeaveRequest schema
  const leaveFilter: any = {
    $or: [
      // leave window overlaps the selected range
      { from: { $lte: toDate }, to: { $gte: fromDate } },
      // or from date inside range (handles one-day leaves / missing `to`)
      { from: { $gte: fromDate, $lte: toDate } },
    ],
  };

  const attendanceFilter: any = {
    date: { $gte: fromStr, $lte: toStr },
  };

  // Status filter for employees (e.g. ?status=active or inactive)
  const statusParam = Array.isArray(q.status) ? q.status[0] : q.status;
  if (statusParam && typeof statusParam === "string") {
    const s = statusParam.toLowerCase();
    if (s === "active") {
      employeeFilter.$or = [
        { isActive: true },
        { status: { $in: ["ACTIVE", "Active", "Working"] } },
      ];
    } else if (s === "inactive") {
      employeeFilter.$or = [
        { isActive: false },
        { status: { $in: ["INACTIVE", "Inactive", "Exited"] } },
      ];
    }
  }

  // Department / location filters (optional)
  const department = Array.isArray(q.department)
    ? q.department[0]
    : q.department;
  const location = Array.isArray(q.location) ? q.location[0] : q.location;

  if (department && typeof department === "string") {
    employeeFilter.department = department;
  }
  if (location && typeof location === "string") {
    employeeFilter.location = location;
  }

  return {
    fromDate,
    toDate,
    fromStr,
    toStr,
    employeeFilter,
    leaveFilter,
    attendanceFilter,
  };
}

// ---------------------------------------------------------------------------
// GET /api/dashboard/hr-admin
// Main HR admin summary with date range + filters
// ---------------------------------------------------------------------------
router.get(
  "/hr-admin",
  requireAuth,
  requireWorkspace,
  requireRoles("ADMIN", "SUPERADMIN", "HR", "TENANT_ADMIN"),
  async (req: any, res: Response) => {
  try {
    const {
      fromDate,
      toDate,
      fromStr,
      toStr,
      employeeFilter,
      leaveFilter,
      attendanceFilter,
    } = buildFiltersFromQuery(req.query);

    const wsFilter = { workspaceId: req.workspaceObjectId };

    // ── EMPLOYEES (master data) ──
    const totalEmployees = await Employee.countDocuments(wsFilter);
    const activeEmployees = await Employee.countDocuments({
      ...wsFilter,
      $or: [
        { isActive: true },
        { status: { $in: ["ACTIVE", "Active", "Working"] } },
      ],
    });
    const inactiveEmployees = await Employee.countDocuments({
      ...wsFilter,
      $or: [
        { isActive: false },
        { status: { $in: ["INACTIVE", "Inactive", "Exited"] } },
      ],
    });

    const employees = await Employee.find({ ...employeeFilter, ...wsFilter })
      .select(
        "fullName name employeeCode employeeId department location jobTitle status joiningDate"
      )
      .sort({ fullName: 1 })
      .limit(200)
      .lean();

    // ── LEAVES (open requests) ──
    // Open = status PENDING in LeaveRequest
    const openLeaves = await LeaveRequest.find({
      ...wsFilter,
      status: "PENDING",
    })
      .populate("userId", "fullName name employeeCode department location")
      .lean();

    const openLeaveRequests = openLeaves.length;

    // ── ONBOARDING ──
    const pendingOnboarding = await (Onboarding as any).countDocuments({
      ...wsFilter,
      status: { $in: ["started", "in-progress", "submitted"] },
    });

    // ── ATTENDANCE ──
    // date stored as "YYYY-MM-DD" string
    const todayStr = toStr; // last day of selected range
    const todaysAttendance = await Attendance.find({ ...wsFilter, date: todayStr })
      .select("punches userId")
      .lean();

    // Interpret "absent" as rows with no punches
    const todaysAbsents = todaysAttendance.filter(
      (row: any) => !row.punches || row.punches.length === 0
    ).length;

    const attendance = await Attendance.find({ ...attendanceFilter, ...wsFilter })
      .select("date userId punches")
      .limit(500)
      .lean();

    // ── HR Alerts ──
    const alerts: string[] = [];

    if (openLeaveRequests > 0) {
      alerts.push(
        `${openLeaveRequests} leave request${
          openLeaveRequests > 1 ? "s" : ""
        } pending approval.`
      );
    }
    if (todaysAbsents > 0) {
      alerts.push(
        `${todaysAbsents} employee${
          todaysAbsents > 1 ? "s are" : " is"
        } marked absent on ${todayStr}.`
      );
    }
    if (inactiveEmployees > 0) {
      alerts.push(
        `${inactiveEmployees} employees are marked as inactive / exited in master data.`
      );
    }

    const response = {
      meta: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        fromStr,
        toStr,
        filters: {
          status: req.query.status || null,
          department: req.query.department || null,
          location: req.query.location || null,
        },
      },
      counts: {
        totalEmployees,
        activeEmployees,
        inactiveEmployees,
        pendingOnboarding,
        openLeaveRequests,
        todaysAbsents,
      },
      pendingOnboarding: [], // TODO: fill from onboarding
      alerts,
      employees,
      openLeaves,
      attendance,
    };

    res.json(response);
  } catch (err) {
    console.error("[dashboard:hr-admin] error:", err);
    res.status(500).json({ message: "Failed to load HR Admin dashboard." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/manager
// Manager overview – matches Manager.tsx expectations
// ---------------------------------------------------------------------------
router.get(
  "/manager",
  requireAuth,
  requireWorkspace,
  requireRoles("MANAGER", "ADMIN", "SUPERADMIN", "HR", "TENANT_ADMIN"),
  async (req: any, res: Response) => {
  try {
    const {
      fromDate,
      toDate,
      fromStr,
      toStr,
      employeeFilter,
      leaveFilter,
      attendanceFilter,
    } = buildFiltersFromQuery(req.query);

    const wsFilter = { workspaceId: req.workspaceObjectId };

    // ── FIX 2: Resolve manager's own Employee doc to scope team ──
    const userId = String(
      (req as any).user?._id || (req as any).user?.id || (req as any).user?.sub
    );

    const managerEmployee = await Employee.findOne({
      ...wsFilter,
      $or: [
        { ownerId: userId },
        { email: (req as any).user?.email },
      ],
    }).lean();

    const managerEmpId = (managerEmployee as any)?._id;

    const teamFilter: any = { ...employeeFilter, ...wsFilter, isActive: true };
    if (managerEmpId) {
      teamFilter.managerId = managerEmpId;
    }
    // SuperAdmin sees all
    if (isSuperAdmin(req)) {
      delete teamFilter.managerId;
    }

    // ── FIX 3: Include phone + email in select ──
    const employees = await Employee.find(teamFilter)
      .select(
        "fullName name email employeeCode employeeId department location jobTitle designation hrmsAccessRole status joiningDate managerId phone email"
      )
      .sort({ fullName: 1 })
      .limit(200)
      .lean();

    const teamIds = employees
      .map((e: any) => e._id)
      .filter((id: any) => !!id);

    // ── USER JOIN: pull designation / hrmsAccessRole / department / dateOfBirth from User ──
    const emails = employees.map((e: any) => e.email).filter(Boolean);
    const userDocs = emails.length
      ? await User.find(
          { email: { $in: emails } },
          "email designation hrmsAccessRole department jobTitle _id dateOfBirth"
        ).lean()
      : [];
    const userMap = new Map(
      (userDocs as any[]).map((u: any) => [u.email, u])
    );

    const enriched = employees.map((e: any) => ({
      ...e,
      designation:
        userMap.get(e.email)?.designation || e.designation || e.jobTitle || "",
      roleTitle:
        userMap.get(e.email)?.hrmsAccessRole ||
        e.hrmsAccessRole ||
        e.jobTitle ||
        "",
      department:
        userMap.get(e.email)?.department || e.department || "",
      location: e.location || "",
    }));

    // ── FIX 4: Resolve manager name for each team member ──
    const managerIds = [...new Set(
      employees
        .map((e: any) => e.managerId?.toString())
        .filter(Boolean)
    )];

    const managers = await Employee.find(
      { _id: { $in: managerIds } },
      "fullName name email"
    ).lean();

    const managerMap = new Map(
      (managers as any[]).map((m: any) => [
        m._id.toString(),
        m.fullName || m.name || m.email,
      ])
    );

    const withManager = enriched.map((e: any) => ({
      ...e,
      managerName: managerMap.get(e.managerId?.toString()) || "—",
    }));

    // ── LEAVES for this manager's team (PENDING only) ──
    let openLeaves: any[] = [];
    if (teamIds.length > 0) {
      openLeaves = await LeaveRequest.find({
        ...wsFilter,
        status: "PENDING",
        userId: { $in: teamIds },
      })
        .populate("userId", "fullName name employeeCode department location")
        .lean();
    }

    const openLeaveRequests = openLeaves.length;

    // ── ATTENDANCE for this manager's team ──
    const todayStr = toStr;
    let todaysAttendance: any[] = [];
    if (teamIds.length > 0) {
      todaysAttendance = await Attendance.find({
        ...wsFilter,
        date: todayStr,
        userId: { $in: teamIds },
      })
        .select("punches userId")
        .lean();
    }

    const todaysAbsents = todaysAttendance.filter(
      (row: any) => !row.punches || row.punches.length === 0
    ).length;

    // ── TODAY STATUS: compute from attendance punches ──
    // Attendance.userId refs User._id (not Employee._id); use userDocs for mapping
    const userIds = (userDocs as any[]).map((u: any) => u._id).filter(Boolean);
    const todayAttendanceFull = userIds.length
      ? await Attendance.find(
          { userId: { $in: userIds }, date: todayStr },
          "userId punches"
        ).lean()
      : [];
    const attMap = new Map(
      (todayAttendanceFull as any[]).map((a: any) => [a.userId.toString(), a])
    );

    const withStatus = withManager.map((e: any) => {
      const u = userMap.get(e.email);
      const att = u ? attMap.get(u._id.toString()) : undefined;
      let todayStatus = "absent";
      if (att && Array.isArray((att as any).punches) && (att as any).punches.length > 0) {
        const hasIn = (att as any).punches.some((p: any) => p.type === "IN");
        const hasOut = (att as any).punches.some((p: any) => p.type === "OUT");
        if (hasIn && hasOut) todayStatus = "present";
        else if (hasIn) todayStatus = "active";
      }
      return { ...e, todayStatus };
    });

    // ── ATTENDANCE HEALTH: last 30 days punch rate per user ──
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];

    const recentAtt = userIds.length
      ? await Attendance.find(
          { userId: { $in: userIds }, date: { $gte: thirtyDaysAgoStr } },
          "userId punches"
        ).lean()
      : [];

    const attCountMap = new Map<string, number>();
    (recentAtt as any[]).forEach((a: any) => {
      const uid = a.userId.toString();
      if (Array.isArray(a.punches) && a.punches.length > 0) {
        attCountMap.set(uid, (attCountMap.get(uid) || 0) + 1);
      }
    });

    const withHealth = withStatus.map((e: any) => {
      const u = userMap.get(e.email);
      const uid = u ? u._id.toString() : undefined;
      const days = uid ? (attCountMap.get(uid) || 0) : 0;
      const pct = Math.round((days / 30) * 100);
      return {
        ...e,
        attendanceScore: pct,
        attendanceHealth:
          pct >= 90 ? "Excellent" :
          pct >= 75 ? "Good" :
          pct >= 50 ? "Fair" : "Low",
      };
    });

    // ── FIX 5: YTD leaves per team member ──
    const currentYear = new Date().getFullYear();
    const yearStart = new Date(currentYear, 0, 1);

    const teamUserIds = (userDocs as any[]).map((u: any) => u._id);

    const ytdLeaves = teamUserIds.length
      ? await LeaveRequest.find({
          userId: { $in: teamUserIds },
          status: "APPROVED",
          from: { $gte: yearStart },
        }, "userId from to").lean()
      : [];

    const leaveMap = new Map<string, number>();
    (ytdLeaves as any[]).forEach((l: any) => {
      const uid = l.userId.toString();
      const days =
        l.to && l.from
          ? Math.ceil(
              (new Date(l.to).getTime() - new Date(l.from).getTime()) /
                86400000
            ) + 1
          : 1;
      leaveMap.set(uid, (leaveMap.get(uid) || 0) + days);
    });

    const withLeaves = withHealth.map((e: any) => {
      const uid = userMap.get(e.email)?._id?.toString();
      return {
        ...e,
        ytdLeaves: leaveMap.get(uid) || 0,
        leaveDaysYtd: leaveMap.get(uid) || 0,
      };
    });

    // ── FIX 6: Upcoming birthdays (next 30 days, month+day only) ──
    const today = new Date();
    const in30 = new Date();
    in30.setDate(in30.getDate() + 30);

    const todayMD = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const in30MD = `${String(in30.getMonth() + 1).padStart(2, "0")}-${String(in30.getDate()).padStart(2, "0")}`;

    const upcomingBirthdays = (userDocs as any[])
      .filter((u: any) => {
        if (!u.dateOfBirth) return false;
        const md = u.dateOfBirth.slice(5); // "MM-DD"
        return md >= todayMD && md <= in30MD;
      })
      .map((u: any) => ({
        name: u.name || u.firstName || u.email,
        dateOfBirth: u.dateOfBirth,
        employeeCode: u.employeeCode,
      }));

    // ── FIX 7: Upcoming anniversaries (next 30 days) ──
    const upcomingAnniversaries = withLeaves
      .filter((e: any) => {
        if (!e.joiningDate) return false;
        const jd = new Date(e.joiningDate);
        const anniversaryMD =
          `${String(jd.getMonth() + 1).padStart(2, "0")}-${String(jd.getDate()).padStart(2, "0")}`;
        return anniversaryMD >= todayMD && anniversaryMD <= in30MD;
      })
      .map((e: any) => ({
        name: e.fullName || e.name,
        joiningDate: e.joiningDate,
        employeeCode: e.employeeCode,
        years: new Date().getFullYear() - new Date(e.joiningDate).getFullYear(),
      }));

    // ── Manager Alerts ──
    const alerts: string[] = [];
    if (openLeaveRequests > 0) {
      alerts.push(
        `${openLeaveRequests} leave request${
          openLeaveRequests > 1 ? "s" : ""
        } from your team pending approval.`
      );
    }
    if (todaysAbsents > 0) {
      alerts.push(
        `${todaysAbsents} team member${
          todaysAbsents > 1 ? "s are" : " is"
        } marked absent on ${todayStr}.`
      );
    }

    // ── FIX 8: Return all new fields ──
    const response = {
      meta: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        fromStr,
        toStr,
      },
      counts: {
        teamSize: employees.length,
        openLeaveRequests,
        todaysAbsents,
        pendingOnboarding: 0,
      },
      team: withLeaves,
      alerts,
      openLeaves,
      upcomingBirthdays,
      upcomingAnniversaries,
    };

    res.json(response);
  } catch (err) {
    console.error("[dashboard:manager] error:", err);
    res.status(500).json({ message: "Failed to load Manager dashboard." });
  }
});


export default router;
