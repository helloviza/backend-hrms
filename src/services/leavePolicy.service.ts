// apps/backend/src/services/leavePolicy.service.ts
import type { ILeavePolicy } from "../models/LeavePolicy.js";
import LeaveBalance from "../models/LeaveBalance.js";
import LeaveRequest from "../models/LeaveRequest.js";
import User from "../models/User.js";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function monthsRemainingInYear(joinDate: Date, policy: ILeavePolicy): number {
  // Determine leave year start month (0-indexed)
  const [mmStr] = policy.leaveYearStart.split("-");
  const leaveYearStartMonth = parseInt(mmStr, 10) - 1; // 0-indexed

  const joinMonth = joinDate.getMonth(); // 0-indexed
  let remaining: number;

  if (joinMonth >= leaveYearStartMonth) {
    remaining = 12 - (joinMonth - leaveYearStartMonth);
  } else {
    remaining = leaveYearStartMonth - joinMonth;
  }
  return Math.max(0, Math.min(12, remaining));
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// ─────────────────────────────────────────────────────────────
// 2.1 Pro-rata entitlement
// ─────────────────────────────────────────────────────────────

export function computeProRataEntitlement(
  joinDate: Date,
  leaveType: string,
  policy: ILeavePolicy,
): number {
  const ent = policy.entitlements;
  const months = monthsRemainingInYear(joinDate, policy);

  switch (leaveType) {
    case "CL":
      return policy.prorateCLForNewJoiners
        ? Math.floor(months * (ent.CL / 12))
        : ent.CL;
    case "EL":
      return policy.prorateELForNewJoiners
        ? Math.floor(months * (ent.EL / 12))
        : ent.EL;
    case "SL":
      return policy.prorateSLForNewJoiners
        ? Math.floor(months * (ent.SL / 12))
        : ent.SL;
    case "BEREAVEMENT":
      return ent.BEREAVEMENT;
    case "PATERNITY":
      return ent.PATERNITY;
    case "MATERNITY":
      return ent.MATERNITY;
    case "COMPOFF":
      return ent.COMPOFF;
    case "UNPAID":
      return ent.UNPAID;
    default:
      return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// 2.2 Monthly accrual
// ─────────────────────────────────────────────────────────────

export async function runMonthlyAccrual(
  userId: string,
  month: number,
  year: number,
  policy: ILeavePolicy,
): Promise<any> {
  const balance = await LeaveBalance.findOne({ userId, year });
  if (!balance) return null;

  // Idempotent: skip if already processed this month
  if (balance.lastAccrualMonth >= month) return balance;

  const now = new Date();
  const onProbation =
    balance.probationEndDate && balance.probationEndDate > now;

  // CL accrual: skip if on probation
  if (!onProbation) {
    const clAccrual = policy.entitlements.CL / 12;
    balance.balances.CL.accrued = Math.min(
      balance.balances.CL.entitled,
      +(balance.balances.CL.accrued + clAccrual).toFixed(2),
    );
  }

  // EL accrual: always (even during probation)
  const elAccrual = policy.entitlements.EL / 12;
  balance.balances.EL.accrued = Math.min(
    balance.balances.EL.entitled,
    +(balance.balances.EL.accrued + elAccrual).toFixed(2),
  );

  // SL accrual: only if MONTHLY mode
  if (policy.slCreditMode === "MONTHLY") {
    const slAccrual = policy.entitlements.SL / 12;
    balance.balances.SL.accrued = Math.min(
      balance.balances.SL.entitled,
      +(balance.balances.SL.accrued + slAccrual).toFixed(2),
    );
  }

  balance.lastAccrualMonth = month;
  await balance.save();
  return balance;
}

// ─────────────────────────────────────────────────────────────
// 2.3 Initialize leave balance
// ─────────────────────────────────────────────────────────────

export async function initializeLeaveBalance(
  userId: string,
  joinDate: Date,
  year: number,
  policy: ILeavePolicy,
): Promise<any> {
  const clEntitled = computeProRataEntitlement(joinDate, "CL", policy);
  const slEntitled = computeProRataEntitlement(joinDate, "SL", policy);
  const elEntitled = computeProRataEntitlement(joinDate, "EL", policy);

  const probationEndDate = addDays(joinDate, policy.probationDays);
  const isConfirmed = probationEndDate <= new Date();

  const slAccrued = policy.slCreditMode === "UPFRONT" ? slEntitled : 0;

  const balance = await LeaveBalance.create({
    userId,
    year,
    balances: {
      CL: { entitled: clEntitled, accrued: 0, used: 0, pending: 0, adjusted: 0 },
      SL: { entitled: slEntitled, accrued: slAccrued, used: 0, pending: 0, adjusted: 0 },
      EL: { entitled: elEntitled, accrued: 0, used: 0, pending: 0, adjusted: 0, carriedForward: 0 },
    },
    eventLeaves: {
      BEREAVEMENT: { occurrences: 0, daysUsed: 0 },
      PATERNITY: { occurrences: 0, daysUsed: 0 },
    },
    lastAccrualMonth: Math.max(0, joinDate.getMonth()), // month before join month (0-indexed)
    probationEndDate,
    isConfirmed,
    joinDate,
  });

  return balance;
}

// ─────────────────────────────────────────────────────────────
// 2.4 Validate leave application
// ─────────────────────────────────────────────────────────────

export async function validateLeaveApplication(
  userId: string,
  leaveRequest: {
    type: string;
    from: Date;
    to: Date;
    days: number;
    dayLength?: string;
  },
  policy: ILeavePolicy,
): Promise<{ valid: boolean; reason?: string }> {
  const { type, from, to, days } = leaveRequest;
  const year = new Date().getFullYear();

  // 1. Overlap check
  const overlap = await LeaveRequest.findOne({
    userId,
    status: { $in: ["PENDING", "APPROVED"] },
    $or: [
      { from: { $lte: to }, to: { $gte: from } },
    ],
  });
  if (overlap) {
    return { valid: false, reason: "You already have a pending or approved leave overlapping these dates." };
  }

  // Load balance
  let balance: any = await LeaveBalance.findOne({ userId, year });
  if (!balance) {
    // Try to initialize
    const user = await User.findById(userId);
    const joinDate = user?.dateOfJoining
      ? new Date(user.dateOfJoining)
      : new Date();
    balance = await initializeLeaveBalance(userId, joinDate, year, policy);
  }

  const onProbation =
    balance.probationEndDate && balance.probationEndDate > new Date();

  // 2. Probation restrictions
  if (onProbation) {
    if (type === "CL")
      return { valid: false, reason: "Casual Leave is not available during probation." };
    if (type === "EL")
      return { valid: false, reason: "Earned Leave is not usable during probation." };
    if (type === "PATERNITY")
      return { valid: false, reason: "Paternity Leave is not available during probation." };
  }

  // 3. Balance checks
  if (type === "CL") {
    const avail =
      balance.balances.CL.accrued -
      balance.balances.CL.used -
      balance.balances.CL.pending +
      balance.balances.CL.adjusted;
    if (days > avail) {
      return { valid: false, reason: `Insufficient CL balance. Available: ${avail.toFixed(1)} days.` };
    }
  }

  if (type === "EL") {
    const avail =
      balance.balances.EL.accrued +
      balance.balances.EL.carriedForward -
      balance.balances.EL.used -
      balance.balances.EL.pending +
      balance.balances.EL.adjusted;
    if (days > avail) {
      return { valid: false, reason: `Insufficient EL balance. Available: ${avail.toFixed(1)} days.` };
    }
  }

  if (type === "SL") {
    const avail =
      balance.balances.SL.accrued -
      balance.balances.SL.used -
      balance.balances.SL.pending +
      balance.balances.SL.adjusted;
    if (policy.allowNegativeSL) {
      if (days > avail + policy.negativeSLLimit) {
        return {
          valid: false,
          reason: `Insufficient SL balance. Available: ${avail.toFixed(1)} days (negative limit: ${policy.negativeSLLimit}).`,
        };
      }
    } else {
      if (days > avail) {
        return { valid: false, reason: `Insufficient SL balance. Available: ${avail.toFixed(1)} days.` };
      }
    }
  }

  if (type === "BEREAVEMENT") {
    if (days > policy.entitlements.BEREAVEMENT) {
      return { valid: false, reason: `Bereavement leave is capped at ${policy.entitlements.BEREAVEMENT} days per occurrence.` };
    }
  }

  if (type === "PATERNITY") {
    if (balance.eventLeaves.PATERNITY.occurrences > 0) {
      return { valid: false, reason: "Paternity leave can only be availed once." };
    }
  }

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────
// 2.5 Year-end carry forward
// ─────────────────────────────────────────────────────────────

export async function runYearEndCarryForward(
  userId: string,
  fromYear: number,
  toYear: number,
  policy: ILeavePolicy,
): Promise<void> {
  const oldBalance = await LeaveBalance.findOne({ userId, year: fromYear });
  if (!oldBalance) return;

  const elAvail =
    oldBalance.balances.EL.accrued +
    oldBalance.balances.EL.carriedForward -
    oldBalance.balances.EL.used -
    oldBalance.balances.EL.pending;

  const carryForward = Math.min(Math.max(0, elAvail), policy.elCarryForwardCap);

  // Ensure next year balance exists
  let newBalance: any = await LeaveBalance.findOne({ userId, year: toYear });
  if (!newBalance) {
    const joinDate = oldBalance.joinDate || new Date();
    newBalance = await initializeLeaveBalance(userId, joinDate, toYear, policy);
  }

  newBalance.balances.EL.carriedForward = carryForward;
  await newBalance.save();
}

// ─────────────────────────────────────────────────────────────
// 2.6 Unlock post probation
// ─────────────────────────────────────────────────────────────

export async function unlockPostProbation(userId: string): Promise<void> {
  const year = new Date().getFullYear();
  const balance = await LeaveBalance.findOne({ userId, year });
  if (!balance) return;

  balance.isConfirmed = true;
  await balance.save();
}
