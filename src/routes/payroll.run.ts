import { Router, type Request, type Response, type NextFunction } from "express";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireFeature } from "../middleware/requireFeature.js";
import { requireRoles } from "../middleware/roles.js";
import PayrollRun from "../models/PayrollRun.js";
import Payslip from "../models/Payslip.js";
import SalaryStructure from "../models/SalaryStructure.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Holiday from "../models/Holiday.js";
import Attendance from "../models/Attendance.js";
import LeaveRequest from "../models/LeaveRequest.js";
import ReimbursementClaim from "../models/ReimbursementClaim.js";
import dayjs from "dayjs";
import {
  computePF,
  computeESI,
  computePT,
  computeLOP,
  computeTDSNewRegime,
  computeTDSOldRegime,
  computeHRAExemption,
  REIMBURSEMENT_HEADS,
} from "../services/payroll.statutory.js";
import EmployeeDeclaration from "../models/EmployeeDeclaration.js";

const r = Router();

r.use(requireAuth, requireWorkspace, requireFeature("payrollEnabled"), (req: Request, res: Response, next: NextFunction) => {
  if (!req.workspaceId) return res.status(400).json({ error: "workspaceId query param required for SUPERADMIN" });
  next();
});

function hasRole(req: Request, ...roles: string[]): boolean {
  const userRoles: string[] = (req as any).user?.roles || [];
  return userRoles.some(
    (r) => roles.includes(r.toUpperCase()) || r.toUpperCase() === "SUPERADMIN"
  );
}

/* ─── POST / — Create new payroll run ─── */
r.post(
  "/",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const createdBy = (req as any).user.sub;
      const { month } = req.body;

      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: "month required in YYYY-MM format" });
      }

      // Check for existing non-DRAFT run
      const existing = await PayrollRun.findOne({
        workspaceId,
        month,
        status: { $in: ["PROCESSED", "APPROVED", "DISBURSED"] },
      });
      if (existing) {
        return res.status(409).json({ error: "Payroll run already exists for this month", existingStatus: existing.status });
      }

      // Delete any existing DRAFT for this month (allow re-creation)
      await PayrollRun.deleteMany({ workspaceId, month, status: "DRAFT" });
      await Payslip.deleteMany({ workspaceId, month, status: "DRAFT" });

      const [yearStr] = month.split("-");
      const run = await PayrollRun.create({
        workspaceId,
        month,
        year: parseInt(yearStr, 10),
        status: "DRAFT",
        createdBy,
      });

      return res.status(201).json({ runId: run._id, month, status: "DRAFT" });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── POST /:runId/process — Process all employee payslips ─── */
r.post(
  "/:runId/process",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const { runId } = req.params;

      const run: any = await PayrollRun.findOne({ _id: runId, workspaceId });
      if (!run) return res.status(404).json({ error: "Payroll run not found" });
      if (run.status !== "DRAFT") {
        return res.status(400).json({ error: "Can only process DRAFT runs" });
      }

      run.status = "PROCESSING";
      await run.save();

      const workspace: any = await CustomerWorkspace.findById(workspaceId)
        .select("payrollConfig companyName")
        .lean();
      const pCfg = workspace?.payrollConfig || {};

      const [yearStr, monthStr] = run.month.split("-");
      const year = parseInt(yearStr, 10);
      const mon = parseInt(monthStr, 10);
      const daysInMonth = new Date(year, mon, 0).getDate();

      // Determine FY month number (April=1 ... March=12)
      const fyMonthNumber = mon >= 4 ? mon - 3 : mon + 9;

      // Build working days (Mon-Fri minus holidays)
      const holidays = await Holiday.find({
        workspaceId,
        date: { $gte: `${run.month}-01`, $lte: `${run.month}-${daysInMonth}` },
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

      // Get all active salary structures in workspace
      const structures: any[] = await SalaryStructure.find({
        workspaceId,
        isActive: true,
      }).lean();

      if (!structures.length) {
        run.status = "DRAFT";
        await run.save();
        return res.status(400).json({ error: "No active salary structures found" });
      }

      const structureMap = new Map(structures.map((s: any) => [String(s.userId), s]));
      const userIds = structures.map((s: any) => s.userId);

      // Fetch users
      const users: any[] = await User.find({ _id: { $in: userIds }, workspaceId }).lean();

      // Fetch attendance
      const attendanceDocs: any[] = await Attendance.find({
        workspaceId,
        userId: { $in: userIds },
        date: { $gte: `${run.month}-01`, $lte: `${run.month}-${daysInMonth}` },
      }).lean();

      const attMap: Record<string, any[]> = {};
      for (const att of attendanceDocs) {
        const uid = String(att.userId);
        if (!attMap[uid]) attMap[uid] = [];
        attMap[uid].push(att);
      }

      // Fetch approved leaves
      const fromDate = new Date(`${run.month}-01`);
      const toDate = new Date(year, mon, 0);
      const leaveRequests: any[] = await LeaveRequest.find({
        userId: { $in: userIds },
        status: "APPROVED",
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

      // Fetch cumulative TDS for FY (April to current month-1)
      const fyStart = mon >= 4 ? `${year}-04` : `${year - 1}-04`;
      const prevMonth = mon === 1
        ? `${year - 1}-12`
        : `${year}-${String(mon - 1).padStart(2, "0")}`;

      const tdsPaidMap: Record<string, number> = {};
      if (fyStart <= prevMonth) {
        const priorPayslips: any[] = await Payslip.find({
          workspaceId,
          userId: { $in: userIds },
          month: { $gte: fyStart, $lte: prevMonth },
          status: { $in: ["FINAL", "PUBLISHED"] },
        }).select("userId deductions.tds").lean();

        for (const ps of priorPayslips) {
          const uid = String(ps.userId);
          tdsPaidMap[uid] = (tdsPaidMap[uid] || 0) + (ps.deductions?.tds || 0);
        }
      }

      const errors: Array<{ userId: string; error: string }> = [];
      const payslips: any[] = [];

      // Summary accumulators
      const summary = {
        totalEmployees: 0,
        totalGross: 0,
        totalNetPay: 0,
        totalPfEmployee: 0,
        totalPfEmployer: 0,
        totalEsiEmployee: 0,
        totalEsiEmployer: 0,
        totalPt: 0,
        totalTds: 0,
        totalLopDeductions: 0,
      };

      for (const user of users) {
        try {
          const uid = String(user._id);
          const structure = structureMap.get(uid);
          if (!structure) continue;

          // Compute attendance
          const userAtt = attMap[uid] || [];
          let present = 0;
          let halfDay = 0;
          let late = 0;

          for (const dateStr of workingDays) {
            const att = userAtt.find((a: any) => a.date === dateStr);
            if (!att?.punches?.length) continue;
            const punches = att.punches.sort(
              (a: any, b: any) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
            );
            const ins = punches.filter((p: any) => p.type === "IN");
            const outs = punches.filter((p: any) => p.type === "OUT");
            let dayHrs = 0;
            if (ins.length && outs.length) {
              const fi = new Date(ins[0].ts).getTime();
              const lo = new Date(outs[outs.length - 1].ts).getTime();
              if (lo > fi) dayHrs = (lo - fi) / 3600000;
            }
            if (dayHrs >= 2 && dayHrs < 4.5) halfDay++;
            else if (dayHrs >= 4.5) present++;
          }

          const leaveDays = leaveDaysMap[uid] || 0;
          const absent = Math.max(0, workingDays.length - present - halfDay - leaveDays);
          const lopDays = absent;

          // Monthly earnings
          const basicMonthly = (structure.earnings?.basic || 0) / 12;
          const hraMonthly = (structure.earnings?.hra || 0) / 12;
          const specialMonthly = (structure.earnings?.specialAllowance || 0) / 12;
          const ltaMonthly = (structure.earnings?.lta || 0) / 12;
          const medicalMonthly = (structure.earnings?.medicalAllowance || 0) / 12;
          const conveyanceMonthly = (structure.earnings?.conveyanceAllowance || 0) / 12;
          const ceaMonthly = (structure.earnings?.childrenEducationAllowance || 0) / 12;
          const otherMonthly = (structure.earnings?.otherAllowances || 0) / 12;

          const grossMonthly =
            basicMonthly + hraMonthly + specialMonthly + ltaMonthly +
            medicalMonthly + conveyanceMonthly + ceaMonthly + otherMonthly;

          // LOP
          const { lopDeduction, effectiveGross } = computeLOP(grossMonthly, workingDays.length, lopDays);

          // Reimbursements
          const reimbClaims: any[] = await ReimbursementClaim.find({
            workspaceId,
            userId: user._id,
            month: run.month,
            status: "APPROVED",
          }).lean();

          let totalReimb = 0;
          let taxableReimb = 0;
          let nonTaxableReimb = 0;
          const reimbDetails: Array<{
            key: string;
            label: string;
            claimedAmount: number;
            approvedAmount: number;
            taxFreeAmount: number;
            taxableAmount: number;
          }> = [];

          // Build a lookup of statutory tax-free limits by key
          const statutoryLimits: Record<string, number | null> = {};
          for (const h of Object.values(REIMBURSEMENT_HEADS)) {
            statutoryLimits[h.key] = h.taxFreeLimit;
          }

          // Also check structure reimbursements for custom heads
          const structReimbs = (structure.reimbursements || []) as any[];
          for (const sr of structReimbs) {
            if (sr.isCustom && sr.key) {
              statutoryLimits[sr.key] = sr.annualTaxFreeLimit || 0;
            }
          }

          for (const claim of reimbClaims) {
            const approved = claim.approvedAmount || 0;
            totalReimb += approved;

            const annualTaxFree = statutoryLimits[claim.reimbursementKey];
            const monthlyTaxFree = annualTaxFree != null ? Math.round(annualTaxFree / 12) : approved;
            const taxFreeAmt = Math.min(approved, monthlyTaxFree);
            const taxableAmt = Math.max(0, approved - monthlyTaxFree);

            nonTaxableReimb += taxFreeAmt;
            taxableReimb += taxableAmt;

            reimbDetails.push({
              key: claim.reimbursementKey,
              label: claim.reimbursementLabel || claim.reimbursementKey,
              claimedAmount: claim.claimedAmount,
              approvedAmount: approved,
              taxFreeAmount: taxFreeAmt,
              taxableAmount: taxableAmt,
            });
          }

          // PF
          const pfResult = computePF(
            basicMonthly,
            pCfg.pfBasis || "CAPPED",
            pCfg.pfCap ?? 15000
          );

          // ESI
          const esiResult = computeESI(effectiveGross, pCfg.esiGrossLimit ?? 21000);

          // PT
          const ptResult = computePT(effectiveGross, pCfg.ptState || "Karnataka");

          // TDS — include taxable reimbursements in gross
          const regime = user.taxRegimePreference || "NEW";
          const annualGross = effectiveGross * 12 + taxableReimb * 12;
          const tdsPaidSoFar = tdsPaidMap[uid] || 0;

          // Determine FY string for EmployeeDeclaration lookup
          const fyStr = mon >= 4 ? `${year}-${String(year + 1).slice(2)}` : `${year - 1}-${String(year).slice(2)}`;

          // Priority: 1) APPROVED EmployeeDeclaration, 2) SUBMITTED/FROZEN, 3) Legacy User.investmentDeclarations
          let declarationSource: "APPROVED" | "DECLARED" | "LEGACY" | "NONE" = "NONE";
          let empDecl: any = null;
          try {
            empDecl = await EmployeeDeclaration.findOne({
              workspaceId,
              userId: user._id,
              financialYear: fyStr,
            }).lean();
          } catch { /* ignore */ }

          let declForTds: any = {};
          if (empDecl?.proofStatus === "VERIFIED" && empDecl.approvedDeclarations) {
            declarationSource = "APPROVED";
            const ad = empDecl.approvedDeclarations;
            declForTds = {
              section80C: ad.section80C || 0,
              section80D: ad.selfHealthInsurance || 0,
              section80CCD1B: ad.section80CCD1B || 0,
              hra: ad.hraRentPaidAnnual || 0,
              homeLoanInterest: ad.homeLoanInterest || 0,
              otherDeductions: ad.otherDeductions || 0,
              parentsHealthInsurance: ad.parentsHealthInsurance || 0,
              parentsAreSenior: ad.parentsAreSenior || false,
              educationLoanInterest: ad.educationLoanInterest || 0,
              savingsInterest: ad.savingsInterest || 0,
              donations: ad.donations || [],
            };
          } else if (empDecl && ["SUBMITTED", "FROZEN"].includes(empDecl.declarationStatus) && empDecl.declarations) {
            declarationSource = "DECLARED";
            const dd = empDecl.declarations;
            declForTds = {
              section80C: dd.section80C || 0,
              section80D: dd.selfHealthInsurance || 0,
              section80CCD1B: dd.section80CCD1B || 0,
              hra: dd.hraRentPaidAnnual || 0,
              homeLoanInterest: dd.homeLoanInterest || 0,
              otherDeductions: dd.otherDeductions || 0,
              parentsHealthInsurance: dd.parentsHealthInsurance || 0,
              parentsAreSenior: dd.parentsAreSenior || false,
              educationLoanInterest: dd.educationLoanInterest || 0,
              savingsInterest: dd.savingsInterest || 0,
              donations: dd.donations || [],
            };
          } else if (user.investmentDeclarations) {
            declarationSource = "LEGACY";
            declForTds = user.investmentDeclarations;
          }

          // ── Section 10 exemptions for TDS ──
          const hraExemption = computeHRAExemption({
            basicMonthly,
            hraReceived: hraMonthly,
            hraActualPaid: (declForTds.hra || 0) / 12,
            isMetro: true,
          });

          // Section 10(14)(i) — sum of approved bill-based reimbursements this month
          const section10_14i_monthly = reimbClaims
            .filter((c: any) => {
              const head = Object.values(REIMBURSEMENT_HEADS).find(h => h.key === c.reimbursementKey);
              return head?.section === "10(14)(i)";
            })
            .reduce((sum: number, c: any) => sum + (c.approvedAmount || 0), 0);

          // Section 10(14)(ii) — statutory-capped allowances from salary structure
          const section10_14ii_monthly = (structReimbs as any[])
            .filter((sr: any) => {
              const head = Object.values(REIMBURSEMENT_HEADS).find(h => h.key === sr.key);
              return sr.isActive !== false && head?.section === "10(14)(ii)";
            })
            .reduce((sum: number, sr: any) => sum + ((sr.annualAmount || 0) / 12), 0);

          // LTA from investment declaration
          const ltaAnnual = declForTds.ltaClaimedThisYear || declForTds.lta || 0;

          const section10Exemptions = {
            hra: hraExemption,
            lta: ltaAnnual,
            section10_14i: section10_14i_monthly * 12,
            section10_14ii: section10_14ii_monthly * 12,
            other: 0,
          };

          let tdsResult;
          if (regime === "OLD") {
            tdsResult = computeTDSOldRegime({
              annualGross,
              hraExemption,
              section10Exemptions,
              section80C: declForTds.section80C || 0,
              section80D: declForTds.section80D || 0,
              section80CCD1B: declForTds.section80CCD1B || 0,
              homeLoanInterest: declForTds.homeLoanInterest || 0,
              otherDeductions: declForTds.otherDeductions || 0,
              parentsHealthInsurance: declForTds.parentsHealthInsurance || 0,
              parentsAreSenior: declForTds.parentsAreSenior || false,
              educationLoanInterest: declForTds.educationLoanInterest || 0,
              savingsInterest: declForTds.savingsInterest || 0,
              donations: declForTds.donations || [],
              monthNumber: fyMonthNumber,
              tdsPaidSoFar,
            });
          } else {
            tdsResult = computeTDSNewRegime({
              annualGross,
              section10Exemptions,
              monthNumber: fyMonthNumber,
              tdsPaidSoFar,
            });
          }

          const totalDeductions =
            pfResult.pfEmployee + esiResult.esiEmployee + ptResult.pt + tdsResult.monthlyTds;
          const netPay = Math.round((effectiveGross + totalReimb - totalDeductions) * 100) / 100;

          // Mask bank account
          const fullAcct = user.bankAccountNumber || "";
          const maskedAcct = fullAcct.length > 4
            ? "XXXX" + fullAcct.slice(-4)
            : fullAcct;

          const payslip = {
            workspaceId,
            payrollRunId: run._id,
            userId: user._id,
            month: run.month,
            year,
            employeeSnapshot: {
              name: user.firstName && user.lastName
                ? `${user.firstName} ${user.lastName}`
                : user.name || user.email || "",
              employeeCode: user.employeeCode || "",
              designation: user.designation || "",
              department: user.department || "",
              dateOfJoining: user.dateOfJoining || "",
              pan: user.taxPan || user.pan || "",
              uanNumber: user.uanNumber || "",
              bankName: user.bankName || "",
              bankAccountNumber: maskedAcct,
              bankIfsc: user.bankIfsc || "",
              pfNumber: user.pfNumber || "",
              esiNumber: user.esiNumber || "",
              taxRegimePreference: regime,
            },
            attendance: {
              workingDays: workingDays.length,
              present: present + halfDay * 0.5,
              absent,
              halfDay,
              leaveDays,
              lopDays,
              late,
            },
            earnings: {
              basic: Math.round(basicMonthly * 100) / 100,
              hra: Math.round(hraMonthly * 100) / 100,
              specialAllowance: Math.round(specialMonthly * 100) / 100,
              lta: Math.round(ltaMonthly * 100) / 100,
              medicalAllowance: Math.round(medicalMonthly * 100) / 100,
              conveyanceAllowance: Math.round(conveyanceMonthly * 100) / 100,
              childrenEducationAllowance: Math.round(ceaMonthly * 100) / 100,
              otherAllowances: Math.round(otherMonthly * 100) / 100,
              lopDeduction: -Math.abs(lopDeduction),
              grossEarnings: Math.round((effectiveGross + totalReimb) * 100) / 100,
              reimbursements: Math.round(totalReimb * 100) / 100,
              taxableReimbursements: Math.round(taxableReimb * 100) / 100,
              nonTaxableReimbursements: Math.round(nonTaxableReimb * 100) / 100,
            },
            reimbursementDetails: reimbDetails,
            deductions: {
              pfEmployee: pfResult.pfEmployee,
              esiEmployee: esiResult.esiEmployee,
              pt: ptResult.pt,
              tds: tdsResult.monthlyTds,
              otherDeductions: 0,
              totalDeductions: Math.round(totalDeductions * 100) / 100,
            },
            employerContributions: {
              pfEmployer: pfResult.pfEmployer,
              esiEmployer: esiResult.esiEmployer,
            },
            netPay,
            declarationSource,
            section10Summary: {
              hra: Math.round(section10Exemptions.hra),
              lta: Math.round(section10Exemptions.lta),
              section10_14i: Math.round(section10Exemptions.section10_14i),
              section10_14ii: Math.round(section10Exemptions.section10_14ii),
              total: Math.round(
                section10Exemptions.hra + section10Exemptions.lta +
                section10Exemptions.section10_14i + section10Exemptions.section10_14ii +
                section10Exemptions.other
              ),
            },
            tdsWorkings: {
              regime: tdsResult.regime,
              annualizedGross: tdsResult.annualizedGross,
              section10Total: tdsResult.section10Total,
              standardDeduction: regime === "OLD" ? 50000 : 75000,
              totalDeductionsAllowed: tdsResult.totalDeductionsAllowed,
              taxableIncome: tdsResult.taxableIncome,
              taxBeforeRebate: tdsResult.taxBeforeRebate,
              rebate87A: tdsResult.rebate87A,
              surcharge: tdsResult.surcharge,
              cess: tdsResult.cess,
              annualTax: tdsResult.annualTax,
              monthlyTds: tdsResult.monthlyTds,
              tdsPaidSoFar,
              tdsBalanceForYear: Math.max(0, tdsResult.annualTax - tdsPaidSoFar),
            },
            status: "DRAFT",
          };

          payslips.push(payslip);

          // Accumulate summary
          summary.totalEmployees++;
          summary.totalGross += effectiveGross;
          summary.totalNetPay += netPay;
          summary.totalPfEmployee += pfResult.pfEmployee;
          summary.totalPfEmployer += pfResult.pfEmployer;
          summary.totalEsiEmployee += esiResult.esiEmployee;
          summary.totalEsiEmployer += esiResult.esiEmployer;
          summary.totalPt += ptResult.pt;
          summary.totalTds += tdsResult.monthlyTds;
          summary.totalLopDeductions += lopDeduction;
        } catch (err: any) {
          errors.push({ userId: String(user._id), error: err.message });
        }
      }

      // Bulk insert payslips
      if (payslips.length > 0) {
        await Payslip.insertMany(payslips);
      }

      // Mark all APPROVED reimbursement claims for this month as PAID
      await ReimbursementClaim.updateMany(
        { workspaceId, month: run.month, status: "APPROVED" },
        { $set: { status: "PAID", payrollRunId: run._id } }
      );

      // Round summary values
      for (const key of Object.keys(summary) as (keyof typeof summary)[]) {
        if (key !== "totalEmployees") {
          (summary as any)[key] = Math.round((summary as any)[key] * 100) / 100;
        }
      }

      run.summary = summary;
      run.status = "PROCESSED";
      run.processedAt = new Date();
      await run.save();

      return res.json({ processed: payslips.length, errors, summary });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET / — List all payroll runs ─── */
r.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const { status, year } = req.query as any;

      const filter: any = { workspaceId };
      if (status) filter.status = status;
      if (year) filter.year = parseInt(year, 10);

      const runs = await PayrollRun.find(filter)
        .sort({ month: -1 })
        .lean();

      return res.json({ items: runs });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET /:runId — Get run details ─── */
r.get(
  "/:runId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { runId } = req.params;
      const workspaceId = req.workspaceId;

      const run = await PayrollRun.findOne({ _id: runId, workspaceId }).lean();
      if (!run) return res.status(404).json({ error: "Payroll run not found" });

      return res.json(run);
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET /:runId/payslips — List payslips in this run ─── */
r.get(
  "/:runId/payslips",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { runId } = req.params;
      const workspaceId = req.workspaceId;
      const userId = (req as any).user.sub;
      const { page = "1", limit = "50" } = req.query as any;

      const filter: any = { workspaceId, payrollRunId: runId };

      // Non-HR/ADMIN can only see their own
      if (!hasRole(req, "HR", "ADMIN")) {
        filter.userId = userId;
      }

      const pg = Math.max(1, parseInt(page, 10));
      const lim = Math.min(100, Math.max(1, parseInt(limit, 10)));

      const [items, total] = await Promise.all([
        Payslip.find(filter)
          .sort({ "employeeSnapshot.name": 1 })
          .skip((pg - 1) * lim)
          .limit(lim)
          .lean(),
        Payslip.countDocuments(filter),
      ]);

      return res.json({ items, total, page: pg, limit: lim });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── PUT /:runId/approve ─── */
r.put(
  "/:runId/approve",
  requireRoles("ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { runId } = req.params;
      const workspaceId = req.workspaceId;
      const approverId = (req as any).user.sub;

      const run: any = await PayrollRun.findOne({ _id: runId, workspaceId });
      if (!run) return res.status(404).json({ error: "Payroll run not found" });
      if (run.status !== "PROCESSED") {
        return res.status(400).json({ error: "Can only approve PROCESSED runs" });
      }

      run.status = "APPROVED";
      run.approvedBy = approverId;
      run.approvedAt = new Date();
      await run.save();

      // Set all DRAFT payslips to FINAL
      await Payslip.updateMany(
        { payrollRunId: runId, workspaceId, status: "DRAFT" },
        { $set: { status: "FINAL" } }
      );

      return res.json({ success: true, status: "APPROVED" });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── PUT /:runId/publish ─── */
r.put(
  "/:runId/publish",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { runId } = req.params;
      const workspaceId = req.workspaceId;

      const run: any = await PayrollRun.findOne({ _id: runId, workspaceId });
      if (!run) return res.status(404).json({ error: "Payroll run not found" });
      if (run.status !== "APPROVED") {
        return res.status(400).json({ error: "Can only publish APPROVED runs" });
      }

      await Payslip.updateMany(
        { payrollRunId: runId, workspaceId, status: "FINAL" },
        { $set: { status: "PUBLISHED", publishedAt: new Date() } }
      );

      return res.json({ success: true, status: "PUBLISHED" });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── PUT /:runId/disburse ─── */
r.put(
  "/:runId/disburse",
  requireRoles("ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { runId } = req.params;
      const workspaceId = req.workspaceId;
      const disburserId = (req as any).user.sub;

      const run: any = await PayrollRun.findOne({ _id: runId, workspaceId });
      if (!run) return res.status(404).json({ error: "Payroll run not found" });
      if (run.status !== "APPROVED" && run.status !== "DISBURSED") {
        return res.status(400).json({ error: "Can only disburse APPROVED runs" });
      }

      run.status = "DISBURSED";
      run.disbursedBy = disburserId;
      run.disbursedAt = new Date();
      await run.save();

      return res.json({ success: true, status: "DISBURSED" });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── DELETE /:runId — Delete DRAFT run ─── */
r.delete(
  "/:runId",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { runId } = req.params;
      const workspaceId = req.workspaceId;

      const run = await PayrollRun.findOne({ _id: runId, workspaceId });
      if (!run) return res.status(404).json({ error: "Payroll run not found" });
      if ((run as any).status !== "DRAFT") {
        return res.status(400).json({ error: "Can only delete DRAFT runs" });
      }

      await Payslip.deleteMany({ payrollRunId: runId, workspaceId });
      await PayrollRun.deleteOne({ _id: runId });

      return res.json({ success: true });
    } catch (err) {
      return next(err);
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
 * TASK B7 — Payroll Reports
 * ═══════════════════════════════════════════════════════════════ */

/* ─── GET /reports/pf-ecr/:month — PF ECR CSV ─── */
r.get(
  "/reports/pf-ecr/:month",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { month } = req.params;
      const workspaceId = req.workspaceId;

      const payslips: any[] = await Payslip.find({
        workspaceId,
        month,
        status: { $in: ["FINAL", "PUBLISHED"] },
      }).lean();

      const rows = ["UAN,MemberName,GrossWages,EPFWages,ETHWages,EEShare,ERShare,NCP_Days,Refund_Of_Advances"];
      for (const ps of payslips) {
        const uan = ps.employeeSnapshot?.uanNumber || "";
        const name = ps.employeeSnapshot?.name || "";
        const gross = ps.earnings?.grossEarnings || 0;
        const epfWages = ps.earnings?.basic || 0;
        const ee = ps.deductions?.pfEmployee || 0;
        const er = ps.employerContributions?.pfEmployer || 0;
        const ncp = ps.attendance?.lopDays || 0;
        rows.push(`${uan},"${name}",${gross},${epfWages},${epfWages},${ee},${er},${ncp},0`);
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="pf-ecr-${month}.csv"`);
      return res.send(rows.join("\n"));
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET /reports/esi/:month — ESI monthly report CSV ─── */
r.get(
  "/reports/esi/:month",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { month } = req.params;
      const workspaceId = req.workspaceId;

      const payslips: any[] = await Payslip.find({
        workspaceId,
        month,
        status: { $in: ["FINAL", "PUBLISHED"] },
        "deductions.esiEmployee": { $gt: 0 },
      }).lean();

      const rows = ["ESI_IP_No,EmployeeName,GrossWages,ESI_Employee,ESI_Employer"];
      for (const ps of payslips) {
        const esiNo = ps.employeeSnapshot?.esiNumber || "";
        const name = ps.employeeSnapshot?.name || "";
        const gross = ps.earnings?.grossEarnings || 0;
        const esiEe = ps.deductions?.esiEmployee || 0;
        const esiEr = ps.employerContributions?.esiEmployer || 0;
        rows.push(`${esiNo},"${name}",${gross},${esiEe},${esiEr}`);
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="esi-${month}.csv"`);
      return res.send(rows.join("\n"));
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET /reports/bank-transfer/:month — Bank transfer CSV ─── */
r.get(
  "/reports/bank-transfer/:month",
  requireRoles("ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { month } = req.params;
      const workspaceId = req.workspaceId;

      const payslips: any[] = await Payslip.find({
        workspaceId,
        month,
        status: { $in: ["FINAL", "PUBLISHED"] },
      }).lean();

      // For bank transfer, need full account numbers — fetch from User
      const userIds = payslips.map((ps: any) => ps.userId);
      const users: any[] = await User.find({ _id: { $in: userIds } })
        .select("_id bankName bankAccountNumber bankIfsc")
        .lean();
      const userMap = new Map(users.map((u: any) => [String(u._id), u]));

      const rows = ["EmployeeName,BankName,AccountNumber,IFSC,NetPay,Remarks"];
      for (const ps of payslips) {
        const user = userMap.get(String(ps.userId));
        const name = ps.employeeSnapshot?.name || "";
        const bank = user?.bankName || ps.employeeSnapshot?.bankName || "";
        const acct = user?.bankAccountNumber || "";
        const ifsc = user?.bankIfsc || ps.employeeSnapshot?.bankIfsc || "";
        rows.push(`"${name}","${bank}","${acct}","${ifsc}",${ps.netPay},""`);
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="bank-transfer-${month}.csv"`);
      return res.send(rows.join("\n"));
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET /reports/tds-summary/:year — Annual TDS summary ─── */
r.get(
  "/reports/tds-summary/:year",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { year: yearParam } = req.params;
      const workspaceId = req.workspaceId;
      const fy = parseInt(yearParam, 10);

      // FY runs April-fy to March-(fy+1)
      const fyStart = `${fy}-04`;
      const fyEnd = `${fy + 1}-03`;

      const payslips: any[] = await Payslip.find({
        workspaceId,
        month: { $gte: fyStart, $lte: fyEnd },
        status: { $in: ["FINAL", "PUBLISHED"] },
      }).lean();

      // Aggregate by userId
      const map: Record<string, { name: string; pan: string; gross: number; taxable: number; tds: number; regime: string }> = {};
      for (const ps of payslips) {
        const uid = String(ps.userId);
        if (!map[uid]) {
          map[uid] = {
            name: ps.employeeSnapshot?.name || "",
            pan: ps.employeeSnapshot?.pan || "",
            gross: 0,
            taxable: ps.tdsWorkings?.taxableIncome || 0,
            tds: 0,
            regime: ps.tdsWorkings?.regime || "NEW",
          };
        }
        map[uid].gross += ps.earnings?.grossEarnings || 0;
        map[uid].tds += ps.deductions?.tds || 0;
      }

      const rows = ["EmployeeName,PAN,GrossEarnings,TaxableIncome,TotalTDS,Regime"];
      for (const [, val] of Object.entries(map)) {
        rows.push(
          `"${val.name}","${val.pan}",${Math.round(val.gross * 100) / 100},${val.taxable},${Math.round(val.tds * 100) / 100},"${val.regime}"`
        );
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="tds-summary-FY${fy}-${fy + 1}.csv"`);
      return res.send(rows.join("\n"));
    } catch (err) {
      return next(err);
    }
  }
);

export default r;
