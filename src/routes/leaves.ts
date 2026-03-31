// apps/backend/src/routes/leaves.ts
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import Leave from "../models/LeaveRequest.js";
import LeaveBalance from "../models/LeaveBalance.js";
import LeavePolicy from "../models/LeavePolicy.js";
import Employee from "../models/Employee.js";
import User from "../models/User.js";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireRoles } from "../middleware/roles.js";
import { audit } from "../middleware/audit.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import {
  validateLeaveApplication,
  initializeLeaveBalance,
  calculateLeaveDays,
} from "../services/leavePolicy.service.js";
import { executeLeaveAccrual } from "../workers/leaveAccrual.worker.js";

const r = Router();

r.use(requireAuth);
r.use(requireWorkspace);

// ─── Helpers ────────────────────────────────────────────────

/** Normalise legacy type keys to new canonical keys */
function normalizeLeaveType(raw: string): string {
  const map: Record<string, string> = {
    CASUAL: "CL",
    SICK: "SL",
    PAID: "EL",
  };
  const upper = raw.toUpperCase();
  return map[upper] || upper;
}

function hasRole(req: Request, ...roles: string[]): boolean {
  const userRoles: string[] = (req as any).user?.roles || [];
  return userRoles.some(
    (r) =>
      roles.includes(r.toUpperCase()) || r.toUpperCase() === "SUPERADMIN",
  );
}

function computeDays(from: Date, to: Date, dayLength?: string): number {
  const diffMs = to.getTime() - from.getTime();
  const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1;
  if (dayLength === "HALF") {
    return days === 1 ? 0.5 : days - 0.5;
  }
  return days;
}

// ─── Schemas ────────────────────────────────────────────────

const LEAVE_TYPES = [
  "CL", "SL", "EL",
  "BEREAVEMENT", "PATERNITY", "MATERNITY", "COMPOFF", "UNPAID",
  // legacy aliases accepted on input
  "CASUAL", "SICK", "PAID",
] as const;

const applySchema = z.object({
  type: z.enum(LEAVE_TYPES),
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().min(1).max(500),
  dayLength: z.enum(["FULL", "HALF"]).optional(),
  halfDay: z.boolean().optional(),
  halfSession: z.enum(["FIRST", "SECOND"]).optional(),
  halfDayDate: z.string().optional(),
  attachmentName: z.string().optional(),
});

const approveSchema = z.object({
  remarks: z.string().max(500).optional(),
});

const rejectSchema = z.object({
  remarks: z.string().min(1).max(500),
});

const cancelSchema = z.object({
  reason: z.string().max(500).optional(),
});

// ───────────────── APPLY LEAVE ─────────────────
r.post(
  "/apply",
  audit("leave-apply"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = applySchema.safeParse(req.body);
      if (!result.success)
        return res.status(400).json({
          error: "Validation failed",
          fields: result.error.flatten().fieldErrors,
        });

      const userId = (req as any).user.sub;
      const data = result.data;
      const leaveType = normalizeLeaveType(data.type);

      const from = new Date(data.from);
      const to = new Date(data.to);
      const wsId = (req as any).workspaceObjectId as string;
      const days = await calculateLeaveDays(from, to, data.dayLength, wsId);

      if (days <= 0) {
        return res.status(400).json({
          error: "Selected dates fall entirely on holidays or weekends",
        });
      }

      // Load policy and validate
      const policy = await LeavePolicy.getOrCreate();
      const validation = await validateLeaveApplication(
        userId,
        (req as any).workspaceObjectId as string,
        { type: leaveType, from, to, days, dayLength: data.dayLength },
        policy,
      );

      if (!validation.valid) {
        return res.status(400).json({ error: validation.reason });
      }

      // Increment pending in balance
      const year = new Date().getFullYear();
      const balance = await LeaveBalance.findOne({ userId, year });
      if (balance) {
        if (leaveType === "CL" || leaveType === "SL" || leaveType === "EL") {
          balance.balances[leaveType].pending += days;
          await balance.save();
        }
      }

      const lr = await Leave.create({
        userId,
        type: leaveType,
        from,
        to,
        days,
        reason: data.reason,
        dayLength: data.dayLength || "FULL",
        halfDay: data.dayLength === "HALF",
        halfSession: data.halfSession,
        halfDayDate: data.halfDayDate ? new Date(data.halfDayDate) : undefined,
        attachmentName: data.attachmentName,
        status: "PENDING",
        history: [{ at: new Date(), by: userId, action: "APPLIED" }],
      });

      return res.json(lr);
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── APPROVE ─────────────────
r.post(
  "/:id/approve",
  audit("leave-approve"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = approveSchema.safeParse(req.body);
      if (!result.success)
        return res.status(400).json({
          error: "Validation failed",
          fields: result.error.flatten().fieldErrors,
        });

      if (!hasRole(req, "MANAGER", "HR", "ADMIN"))
        return res.status(403).json({ error: "Not authorized" });

      const approverId = (req as any).user.sub;
      const lr = await scopedFindById(Leave, req.params.id, (req as any).workspaceObjectId);
      if (!lr) return res.status(404).json({ error: "Leave request not found" });
      if (lr.status !== "PENDING")
        return res.status(400).json({ error: "Only PENDING leaves can be approved" });

      lr.status = "APPROVED";
      lr.approverId = approverId;
      lr.history.push({
        at: new Date(),
        by: approverId,
        action: "APPROVED",
        note: result.data.remarks,
      });
      await lr.save();

      // Move days from pending to used in balance
      const year = new Date().getFullYear();
      const balance = await LeaveBalance.findOne({
        userId: lr.userId,
        year,
      });
      if (balance) {
        const type = lr.type as string;
        if (type === "CL" || type === "SL" || type === "EL") {
          const days = lr.days || 0;
          balance.balances[type].pending = Math.max(
            0,
            balance.balances[type].pending - days,
          );
          balance.balances[type].used += days;
          await balance.save();
        }
        if (type === "BEREAVEMENT") {
          balance.eventLeaves.BEREAVEMENT.occurrences += 1;
          balance.eventLeaves.BEREAVEMENT.daysUsed += lr.days || 0;
          await balance.save();
        }
        if (type === "PATERNITY") {
          balance.eventLeaves.PATERNITY.occurrences += 1;
          balance.eventLeaves.PATERNITY.daysUsed += lr.days || 0;
          await balance.save();
        }
      }

      return res.json(lr);
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── REJECT ─────────────────
r.post(
  "/:id/reject",
  audit("leave-reject"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = rejectSchema.safeParse(req.body);
      if (!result.success)
        return res.status(400).json({
          error: "Validation failed",
          fields: result.error.flatten().fieldErrors,
        });

      if (!hasRole(req, "MANAGER", "HR", "ADMIN"))
        return res.status(403).json({ error: "Not authorized" });

      const approverId = (req as any).user.sub;
      const lr = await scopedFindById(Leave, req.params.id, (req as any).workspaceObjectId);
      if (!lr) return res.status(404).json({ error: "Leave request not found" });
      if (lr.status !== "PENDING")
        return res.status(400).json({ error: "Only PENDING leaves can be rejected" });

      lr.status = "REJECTED";
      lr.approverId = approverId;
      lr.history.push({
        at: new Date(),
        by: approverId,
        action: "REJECTED",
        note: result.data.remarks,
      });
      await lr.save();

      // Restore pending days
      const year = new Date().getFullYear();
      const balance = await LeaveBalance.findOne({
        userId: lr.userId,
        year,
      });
      if (balance) {
        const type = lr.type as string;
        if (type === "CL" || type === "SL" || type === "EL") {
          const days = lr.days || 0;
          balance.balances[type].pending = Math.max(
            0,
            balance.balances[type].pending - days,
          );
          await balance.save();
        }
      }

      return res.json(lr);
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── CANCEL ─────────────────
r.post(
  "/:id/cancel",
  audit("leave-cancel"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = cancelSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: "Validation failed" });

      const userId = (req as any).user.sub;
      const lr = await scopedFindById(Leave, req.params.id, (req as any).workspaceObjectId);
      if (!lr) return res.status(404).json({ error: "Leave request not found" });

      const isOwner = String(lr.userId) === userId;
      const isAdmin = hasRole(req, "MANAGER", "HR", "ADMIN");

      // Owner can cancel PENDING; admin can cancel PENDING or APPROVED
      if (isOwner && lr.status !== "PENDING") {
        return res.status(400).json({
          error: "You can only cancel your own PENDING leave requests.",
        });
      }
      if (!isOwner && !isAdmin) {
        return res.status(403).json({ error: "Not authorized to cancel this leave." });
      }
      if (!["PENDING", "APPROVED"].includes(lr.status as string)) {
        return res.status(400).json({
          error: "Only PENDING or APPROVED leaves can be cancelled.",
        });
      }

      const previousStatus = lr.status;
      const days = lr.days || 0;

      lr.status = "CANCELLED";
      lr.cancelledAt = new Date();
      lr.cancelReason = parsed.data.reason || "";
      lr.cancelledBy = userId;
      lr.history.push({
        at: new Date(),
        by: userId,
        action: "CANCELLED",
        note: parsed.data.reason,
      });
      await lr.save();

      // Restore balance
      const year = new Date().getFullYear();
      const balance = await LeaveBalance.findOne({
        userId: lr.userId,
        year,
      });
      if (balance) {
        const type = lr.type as string;
        if (type === "CL" || type === "SL" || type === "EL") {
          if (previousStatus === "PENDING") {
            balance.balances[type].pending = Math.max(
              0,
              balance.balances[type].pending - days,
            );
          } else if (previousStatus === "APPROVED") {
            balance.balances[type].used = Math.max(
              0,
              balance.balances[type].used - days,
            );
          }
          await balance.save();
        }
      }

      return res.json(lr);
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── MY LEAVES ─────────────────
async function handleMyLeaves(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const userId = (req as any).user.sub;
    const items = await Leave.find({ userId }).sort({ createdAt: -1 });
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
}

r.get("/mine", handleMyLeaves);
r.get("/my", handleMyLeaves);

// ───────────────── BALANCE ─────────────────
r.get(
  "/balance",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.sub;
      const year = new Date().getFullYear();

      let balance: any = await LeaveBalance.findOne({ userId, year });
      if (!balance) {
        const policy = await LeavePolicy.getOrCreate();
        const user = await scopedFindById(User, userId, (req as any).workspaceObjectId);
        const joinDate = user?.dateOfJoining
          ? new Date(user.dateOfJoining as string)
          : new Date();
        balance = await initializeLeaveBalance(userId, joinDate, year, policy);
      }

      const b = balance.balances;
      const ev = balance.eventLeaves;

      return res.json({
        year,
        isConfirmed: balance.isConfirmed,
        probationEndDate: balance.probationEndDate,
        joinDate: balance.joinDate,
        balances: {
          CL: {
            entitled: b.CL.entitled,
            accrued: b.CL.accrued,
            used: b.CL.used,
            pending: b.CL.pending,
            adjusted: b.CL.adjusted,
            available: +(
              b.CL.accrued - b.CL.used - b.CL.pending + b.CL.adjusted
            ).toFixed(2),
          },
          SL: {
            entitled: b.SL.entitled,
            accrued: b.SL.accrued,
            used: b.SL.used,
            pending: b.SL.pending,
            adjusted: b.SL.adjusted,
            available: +(
              b.SL.accrued - b.SL.used - b.SL.pending + b.SL.adjusted
            ).toFixed(2),
          },
          EL: {
            entitled: b.EL.entitled,
            accrued: b.EL.accrued,
            used: b.EL.used,
            pending: b.EL.pending,
            adjusted: b.EL.adjusted,
            carriedForward: b.EL.carriedForward,
            available: +(
              b.EL.accrued +
              b.EL.carriedForward -
              b.EL.used -
              b.EL.pending +
              b.EL.adjusted
            ).toFixed(2),
          },
          BEREAVEMENT: {
            occurrences: ev.BEREAVEMENT.occurrences,
            daysUsed: ev.BEREAVEMENT.daysUsed,
          },
          PATERNITY: {
            occurrences: ev.PATERNITY.occurrences,
            daysUsed: ev.PATERNITY.daysUsed,
          },
        },
      });
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── TEAM APPROVALS ─────────────────
r.get(
  "/team",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.sub;
      const isHrAdmin = hasRole(req, "HR", "ADMIN");

      let teamUserIds: string[] = [];

      if (isHrAdmin) {
        // HR/Admin sees all pending leaves
        const items = await Leave.find({ status: "PENDING" })
          .populate("userId", "firstName lastName email name")
          .sort({ createdAt: -1 });
        return res.json(
          items.map((lr) => ({
            ...lr.toObject(),
            employee: lr.userId, // populated user doc
          })),
        );
      }

      // Manager: find employees where this user is the manager
      const myEmployee = await Employee.findOne({ ownerId: userId });
      if (myEmployee) {
        const directReports = await Employee.find({
          managerId: myEmployee._id,
        }).select("ownerId");
        teamUserIds = directReports
          .map((e) => String(e.ownerId))
          .filter(Boolean);
      }

      if (teamUserIds.length === 0) {
        return res.json([]);
      }

      const items = await Leave.find({
        userId: { $in: teamUserIds },
        status: "PENDING",
      })
        .populate("userId", "firstName lastName email name")
        .sort({ createdAt: -1 });

      return res.json(
        items.map((lr) => ({
          ...lr.toObject(),
          employee: lr.userId,
        })),
      );
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── TEAM LEAVE CALENDAR ─────────────────
r.get(
  "/calendar",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.sub;
      const wsId = (req as any).workspaceObjectId as string;
      const { month } = req.query as any;

      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: "month query param required (YYYY-MM)" });
      }

      const [yearStr, monthStr] = month.split("-");
      const year = parseInt(yearStr, 10);
      const mon = parseInt(monthStr, 10);
      const daysInMonth = new Date(year, mon, 0).getDate();

      const monthStart = new Date(`${month}-01`);
      const monthEnd = new Date(year, mon, 0);

      // Fetch holidays
      const Holiday = (await import("../models/Holiday.js")).default;
      const holidays = await Holiday.find({
        ...(wsId ? { workspaceId: wsId } : {}),
        date: { $gte: `${month}-01`, $lte: `${month}-${String(daysInMonth).padStart(2, "0")}` },
        type: "GENERAL",
      })
        .select("date name")
        .lean();

      // Determine user scope
      const isHrAdmin = hasRole(req, "HR", "ADMIN");
      let userFilter: any = {};

      if (!isHrAdmin && hasRole(req, "MANAGER")) {
        const myEmp = await Employee.findOne({ ownerId: userId });
        if (myEmp) {
          const reports = await Employee.find({ managerId: myEmp._id }).select("ownerId");
          const reportIds = reports.map((r) => r.ownerId).filter(Boolean);
          reportIds.push(userId); // include self
          userFilter = { userId: { $in: reportIds } };
        } else {
          userFilter = { userId };
        }
      } else if (!isHrAdmin) {
        // Employee: self + workspace-mates (all approved leaves visible)
        // Keep it simple: return all workspace leaves
      }

      const leaveQuery: any = {
        status: "APPROVED",
        $or: [{ from: { $lte: monthEnd }, to: { $gte: monthStart } }],
        ...userFilter,
      };

      const leaves = await Leave.find(leaveQuery)
        .populate("userId", "firstName lastName email name avatar")
        .lean();

      const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
      const result = leaves.map((lr: any) => {
        const u = lr.userId as any;
        const userName =
          u?.firstName && u?.lastName
            ? `${u.firstName} ${u.lastName}`
            : u?.name || u?.email || String(lr.userId);

        const fromDate = new Date(lr.from);
        const toDate = new Date(lr.to);

        return {
          userId: u?._id || lr.userId,
          userName,
          avatar: u?.avatar,
          from: `${fromDate.getFullYear()}-${pad(fromDate.getMonth() + 1)}-${pad(fromDate.getDate())}`,
          to: `${toDate.getFullYear()}-${pad(toDate.getMonth() + 1)}-${pad(toDate.getDate())}`,
          type: lr.type,
          dayLength: lr.dayLength || "FULL",
          days: lr.days || 0,
        };
      });

      return res.json({
        month,
        holidays: holidays.map((h: any) => ({ date: h.date, name: h.name })),
        leaves: result,
      });
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── ADMIN: LEAVE POLICY ─────────────────
r.get(
  "/admin/policy",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRole(req, "HR", "ADMIN"))
        return res.status(403).json({ error: "Not authorized" });

      const policy = await LeavePolicy.getOrCreate();
      return res.json(policy);
    } catch (err) {
      return next(err);
    }
  },
);

r.put(
  "/admin/policy",
  audit("leave-policy-update"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRole(req, "HR", "ADMIN"))
        return res.status(403).json({ error: "Not authorized" });

      const policy = await LeavePolicy.getOrCreate();

      // Whitelist updatable fields
      const allowed = [
        "probationDays",
        "leaveYearStart",
        "slCreditMode",
        "elCarryForwardCap",
        "allowNegativeSL",
        "negativeSLLimit",
        "entitlements",
        "prorateELForNewJoiners",
        "prorateCLForNewJoiners",
        "prorateSLForNewJoiners",
        "restrictCLInNoticePeriod",
        "allowELInNoticePeriod",
      ];

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          (policy as any)[key] = req.body[key];
        }
      }

      await policy.save();
      return res.json(policy);
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── ADMIN: RUN ACCRUAL ─────────────────
r.post(
  "/admin/run-accrual",
  audit("leave-accrual-manual"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRole(req, "ADMIN"))
        return res.status(403).json({ error: "Not authorized" });

      const result = await executeLeaveAccrual();
      return res.json({ ok: true, ...result });
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── ADMIN: INITIALIZE BALANCES ─────────────────
r.post(
  "/admin/initialize-balances",
  audit("leave-init-balances"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRole(req, "ADMIN"))
        return res.status(403).json({ error: "Not authorized" });

      const year = new Date().getFullYear();
      const policy = await LeavePolicy.getOrCreate();
      const users = await User.find({ status: { $ne: "INACTIVE" } })
        .select("_id dateOfJoining")
        .lean();

      let created = 0;
      let skipped = 0;

      for (const user of users) {
        const existing = await LeaveBalance.findOne({
          userId: user._id,
          year,
        });
        if (existing) {
          skipped++;
          continue;
        }

        const joinDate = user.dateOfJoining
          ? new Date(user.dateOfJoining as string)
          : new Date();
        await initializeLeaveBalance(String(user._id), joinDate, year, policy);
        created++;
      }

      return res.json({ ok: true, year, created, skipped });
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── ADMIN: BULK ADJUST ─────────────────
r.post(
  "/admin/adjust",
  audit("leave-adjust"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRole(req, "HR", "ADMIN"))
        return res.status(403).json({ error: "Not authorized" });

      const { adjustments } = req.body;
      if (!Array.isArray(adjustments) || !adjustments.length) {
        return res.status(400).json({ error: "adjustments array is required" });
      }
      if (adjustments.length > 100) {
        return res.status(400).json({ error: "Max 100 adjustments per request" });
      }

      const adminId = (req as any).user.sub;
      const wsId = (req as any).workspaceObjectId as string;
      const year = new Date().getFullYear();
      const policy = await LeavePolicy.getOrCreate();
      let processed = 0;
      const failed: { userId: string; reason: string }[] = [];

      for (const adj of adjustments) {
        try {
          const { userId: uid, leaveType, days, reason } = adj;
          const adjYear = adj.year || year;

          if (!uid || !leaveType || days === undefined || !reason) {
            failed.push({ userId: uid || "unknown", reason: "Missing required fields" });
            continue;
          }

          if (!["CL", "SL", "EL", "COMPOFF"].includes(leaveType)) {
            failed.push({ userId: uid, reason: `Invalid leave type: ${leaveType}` });
            continue;
          }

          let balance: any = await LeaveBalance.findOne({
            userId: uid,
            year: adjYear,
            ...(wsId ? { workspaceId: wsId } : {}),
          });

          if (!balance) {
            const user = await User.findById(uid).select("dateOfJoining").lean();
            const joinDate = user?.dateOfJoining
              ? new Date(user.dateOfJoining as string)
              : new Date();
            balance = await initializeLeaveBalance(uid, joinDate, adjYear, policy, wsId);
          }

          if (leaveType === "COMPOFF") {
            // COMPOFF doesn't have a standard balance entry, skip
            // For now, adjust CL as a workaround or create custom handling
            failed.push({ userId: uid, reason: "COMPOFF adjustment not yet supported in balance" });
            continue;
          }

          balance.balances[leaveType].adjusted += days;
          balance.balances[leaveType].entitled += days;

          // Add to adjustmentLog
          if (!balance.adjustmentLog) balance.adjustmentLog = [];
          balance.adjustmentLog.push({
            adjustedBy: adminId,
            days,
            reason,
            leaveType,
            adjustedAt: new Date(),
          });

          await balance.save();
          processed++;
        } catch (e: any) {
          failed.push({ userId: adj.userId || "unknown", reason: e.message });
        }
      }

      return res.json({ success: true, processed, failed });
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── ADMIN: BALANCE OVERVIEW ─────────────────
r.get(
  "/admin/balances",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRole(req, "HR", "ADMIN"))
        return res.status(403).json({ error: "Not authorized" });

      const wsId = (req as any).workspaceObjectId as string;
      const year = parseInt((req.query.year as string) || String(new Date().getFullYear()), 10);

      const balances = await LeaveBalance.find({
        ...(wsId ? { workspaceId: wsId } : {}),
        year,
      })
        .populate("userId", "firstName lastName email name employeeCode")
        .lean();

      const items = balances.map((b: any) => {
        const u = b.userId as any;
        const userName =
          u?.firstName && u?.lastName
            ? `${u.firstName} ${u.lastName}`
            : u?.name || u?.email || String(b.userId);

        return {
          userId: u?._id || b.userId,
          userName,
          employeeCode: u?.employeeCode || "",
          email: u?.email || "",
          year: b.year,
          CL: {
            entitled: b.balances.CL.entitled,
            used: b.balances.CL.used,
            pending: b.balances.CL.pending,
            adjusted: b.balances.CL.adjusted,
            available: +(b.balances.CL.accrued - b.balances.CL.used - b.balances.CL.pending + b.balances.CL.adjusted).toFixed(2),
          },
          SL: {
            entitled: b.balances.SL.entitled,
            used: b.balances.SL.used,
            pending: b.balances.SL.pending,
            adjusted: b.balances.SL.adjusted,
            available: +(b.balances.SL.accrued - b.balances.SL.used - b.balances.SL.pending + b.balances.SL.adjusted).toFixed(2),
          },
          EL: {
            entitled: b.balances.EL.entitled,
            used: b.balances.EL.used,
            pending: b.balances.EL.pending,
            adjusted: b.balances.EL.adjusted,
            carriedForward: b.balances.EL.carriedForward || 0,
            available: +(b.balances.EL.accrued + (b.balances.EL.carriedForward || 0) - b.balances.EL.used - b.balances.EL.pending + b.balances.EL.adjusted).toFixed(2),
          },
          updatedAt: b.updatedAt,
        };
      });

      return res.json({ year, items });
    } catch (err) {
      return next(err);
    }
  },
);

// ───────────────── ADMIN: RUN YEAR-END CARRY-FORWARD ─────────────────
r.post(
  "/admin/run-year-end",
  audit("leave-year-end"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!hasRole(req, "ADMIN"))
        return res.status(403).json({ error: "Not authorized" });

      const wsId = (req as any).workspaceObjectId as string;
      const { runYearEndCarryForward } = await import("../services/leavePolicy.service.js");

      const fromYear = new Date().getFullYear() - 1;
      const toYear = new Date().getFullYear();
      const policy = await LeavePolicy.getOrCreate();

      // Find all users in workspace
      const users = await User.find({
        ...(wsId ? { workspaceId: wsId } : {}),
        status: { $ne: "INACTIVE" },
      }).select("_id").lean();

      let processed = 0;
      let errors = 0;

      for (const u of users) {
        try {
          await runYearEndCarryForward(String(u._id), fromYear, toYear, policy);
          processed++;
        } catch {
          errors++;
        }
      }

      // Log to WorkspaceAuditLog
      try {
        const { default: mongoose } = await import("mongoose");
        const auditLogCollection = mongoose.connection.collection("workspaceauditlogs");
        await auditLogCollection.insertOne({
          workspaceId: wsId,
          event: "YEAR_END_CARRY_FORWARD",
          runAt: new Date(),
          triggeredBy: (req as any).user.sub,
          status: errors > 0 ? "PARTIAL" : "SUCCESS",
          details: `Processed ${processed} users, ${errors} errors`,
        });
      } catch {
        // Non-fatal: audit log write failure
      }

      return res.json({
        success: true,
        message: "Year-end carry-forward complete",
        processed,
        errors,
      });
    } catch (err) {
      return next(err);
    }
  },
);

export default r;
