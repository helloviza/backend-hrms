import { Router, type Request, type Response, type NextFunction } from "express";
import mongoose from "mongoose";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireFeature } from "../middleware/requireFeature.js";
import { requireRoles } from "../middleware/roles.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import SalaryStructure from "../models/SalaryStructure.js";
import User from "../models/User.js";
import {
  computePF,
  computeESI,
  computePT,
  computeTDSNewRegime,
  computeTDSOldRegime,
  computeHRAExemption,
  STATUTORY,
} from "../services/payroll.statutory.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

/**
 * Resolve workspaceId — for SUPERADMIN without workspace context,
 * try query/header/first-active-workspace fallback.
 */
async function resolveWorkspaceId(req: Request): Promise<string | null> {
  if (req.workspaceId) return req.workspaceId;
  if (!isSuperAdmin(req)) return null;

  const explicit =
    (req.query as any).workspaceId ||
    (req.body as any)?.workspaceId ||
    req.headers["x-workspace-id"];
  if (explicit) return String(explicit);

  const ws = await CustomerWorkspace.findOne({ status: "ACTIVE" })
    .select("_id")
    .lean();
  if (ws) {
    console.warn(
      `[SUPERADMIN AUTO-RESOLVE] No workspaceId provided. ` +
      `Falling back to first active workspace: ${ws._id}. ` +
      `User: ${(req as any).user?.email}. Path: ${req.path}`
    );
    return String(ws._id);
  }
  return null;
}

const r = Router();

r.use(requireAuth, requireWorkspace, requireFeature("payrollEnabled"));

/* ─── POST /structure — Create or update salary structure ─── */
r.post(
  "/structure",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      console.log("[PayrollSalary] POST /structure body:", JSON.stringify(req.body, null, 2));

      const workspaceId = await resolveWorkspaceId(req);
      if (!workspaceId) {
        return res.status(400).json({ error: "workspaceId required" });
      }
      const createdBy = (req as any).user.sub;
      const { userId, effectiveFrom, ctcAnnual, earnings, reimbursements } = req.body;

      if (!userId || !effectiveFrom || !ctcAnnual || !earnings) {
        return res.status(400).json({ error: "userId, effectiveFrom, ctcAnnual, and earnings are required" });
      }

      if (ctcAnnual <= 0) {
        return res.status(400).json({ error: "ctcAnnual must be > 0" });
      }

      if ((earnings.basic || 0) < 15000) {
        return res.status(400).json({ error: "basic must be >= 15000 annually (₹1250/month minimum)" });
      }

      // Sum reimbursements
      const reimbArray: any[] = Array.isArray(reimbursements) ? reimbursements : [];
      const totalReimbursements = reimbArray
        .filter((r: any) => r.isActive !== false)
        .reduce((sum: number, r: any) => sum + (r.annualAmount || 0), 0);

      // Compute employer contributions from basic (PF employer + gratuity)
      const workspace: any = await CustomerWorkspace.findById(workspaceId)
        .select("payrollConfig")
        .lean();
      const pCfg = workspace?.payrollConfig || {};
      const basicAnnual = earnings.basic || 0;
      const basicMonthly = basicAnnual / 12;
      const pfBasis = pCfg.pfBasis === "ACTUAL" ? basicMonthly : Math.min(basicMonthly, pCfg.pfCap ?? STATUTORY.PF.DEFAULT_CAP);
      const pfEmployerAnnual = Math.round(pfBasis * STATUTORY.PF.EMPLOYER_RATE) * 12;
      const gratuityAnnual = Math.round(basicAnnual * 0.0481);

      // Validate: earnings + reimbursements + employer contributions = CTC
      const total =
        (earnings.basic || 0) +
        (earnings.hra || 0) +
        (earnings.specialAllowance || 0) +
        (earnings.lta || 0) +
        (earnings.medicalAllowance || 0) +
        (earnings.conveyanceAllowance || 0) +
        (earnings.childrenEducationAllowance || 0) +
        (earnings.otherAllowances || 0) +
        totalReimbursements +
        pfEmployerAnnual +
        gratuityAnnual;

      const diff = Math.abs(total - ctcAnnual);
      if (diff > 1) {
        console.log("[PayrollSalary] Validation failed — total:", total, "ctcAnnual:", ctcAnnual, "diff:", diff,
          "pfEmployer:", pfEmployerAnnual, "gratuity:", gratuityAnnual, "reimb:", totalReimbursements);
        return res.status(400).json({
          error: "Components do not add up to CTC",
          difference: ctcAnnual - total,
          componentsTotal: total,
          ctcAnnual,
        });
      }

      // Compute taxable vs non-taxable reimbursements
      let taxableReimb = 0;
      let nonTaxableReimb = 0;
      for (const r of reimbArray) {
        if (r.isActive === false) continue;
        const amt = r.annualAmount || 0;
        const taxFree = r.annualTaxFreeLimit || 0;
        nonTaxableReimb += Math.min(amt, taxFree);
        taxableReimb += Math.max(0, amt - taxFree);
      }

      // Warn if HRA > basic (don't block)
      const warnings: string[] = [];
      if ((earnings.hra || 0) > (earnings.basic || 0)) {
        warnings.push("HRA exceeds basic — unusual but allowed");
      }

      // Deactivate currently active structure
      const effectiveDate = new Date(effectiveFrom);
      const dayBefore = new Date(effectiveDate);
      dayBefore.setDate(dayBefore.getDate() - 1);

      await SalaryStructure.updateMany(
        { workspaceId, userId, isActive: true },
        { $set: { isActive: false, effectiveTo: dayBefore } }
      );

      // Compute monthly estimates (in-hand gross = CTC minus employer contributions)
      const inHandGrossAnnual = ctcAnnual - pfEmployerAnnual - gratuityAnnual;
      const grossMonthly = inHandGrossAnnual / 12;

      const structure = await SalaryStructure.create({
        workspaceId,
        userId,
        effectiveFrom: effectiveDate,
        isActive: true,
        ctcAnnual,
        earnings: {
          basic: earnings.basic || 0,
          hra: earnings.hra || 0,
          specialAllowance: earnings.specialAllowance || 0,
          lta: earnings.lta || 0,
          medicalAllowance: earnings.medicalAllowance || 0,
          conveyanceAllowance: earnings.conveyanceAllowance || 0,
          childrenEducationAllowance: earnings.childrenEducationAllowance || 0,
          otherAllowances: earnings.otherAllowances || 0,
          totalReimbursements,
        },
        reimbursements: reimbArray,
        employerContributions: {
          pfEmployer: pfEmployerAnnual,
          gratuity: gratuityAnnual,
        },
        monthly: {
          grossEarnings: Math.round(grossMonthly * 100) / 100,
          totalDeductions: 0,
          netPay: Math.round(grossMonthly * 100) / 100,
          totalReimbursements: Math.round(totalReimbursements / 12 * 100) / 100,
          taxableReimbursements: Math.round(taxableReimb / 12 * 100) / 100,
          nonTaxableReimbursements: Math.round(nonTaxableReimb / 12 * 100) / 100,
        },
        createdBy,
      });

      // Update user CTC and salary effective date
      await User.updateOne(
        { _id: userId, workspaceId },
        { $set: { ctc: ctcAnnual, salaryEffectiveDate: effectiveDate } }
      );

      return res.status(201).json({ structure, warnings });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET /structure/:userId — Get active salary structure ─── */
r.get(
  "/structure/:userId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;
      const workspaceId = await resolveWorkspaceId(req);
      if (!workspaceId) {
        return res.status(400).json({ error: "workspaceId required" });
      }

      const structure = await SalaryStructure.findOne({
        workspaceId,
        userId,
        isActive: true,
      }).lean();

      const history = await SalaryStructure.find({
        workspaceId,
        userId,
      })
        .sort({ effectiveFrom: -1 })
        .limit(3)
        .lean();

      return res.json({ structure, history });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET /structures — List ALL workspace users with their salary structures ─── */
r.get(
  "/structures",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = await resolveWorkspaceId(req);
      if (!workspaceId) {
        return res.status(400).json({ error: "workspaceId required" });
      }
      const { department, page = "1", limit = "50" } = req.query as any;

      // 1. Fetch ALL active users in workspace
      const userFilter: any = { workspaceId, status: { $ne: "INACTIVE" } };
      if (department) userFilter.department = department;

      const users = await User.find(userFilter)
        .select("_id firstName lastName name email employeeCode designation department ctc dateOfJoining")
        .sort({ name: 1 })
        .lean();

      // 2. Fetch active SalaryStructures for these users
      const userIds = users.map((u: any) => u._id);
      const structures = await SalaryStructure.find({
        workspaceId,
        isActive: true,
        userId: { $in: userIds },
      }).lean();

      const structureMap = new Map(structures.map((s: any) => [String(s.userId), s]));

      // 3. Paginate
      const pg = Math.max(1, parseInt(page, 10));
      const lim = Math.min(100, Math.max(1, parseInt(limit, 10)));
      const total = users.length;
      const paged = users.slice((pg - 1) * lim, pg * lim);

      // 4. Merge — every user appears, with or without a structure
      const items = paged.map((u: any) => {
        const s = structureMap.get(String(u._id));
        const name = u.firstName && u.lastName
          ? `${u.firstName} ${u.lastName}`
          : u.name || u.email || "";
        return {
          _id: s?._id || null,
          userId: u._id,
          name,
          email: u.email || "",
          employeeCode: u.employeeCode || "",
          designation: u.designation || "",
          department: u.department || "",
          ctc: u.ctc || 0,
          dateOfJoining: u.dateOfJoining || null,
          hasStructure: !!s,
          ctcAnnual: s?.ctcAnnual || 0,
          basic: s?.earnings?.basic || 0,
          grossMonthly: s?.monthly?.grossEarnings || 0,
          netMonthly: s?.monthly?.netPay || 0,
          effectiveFrom: s?.effectiveFrom || null,
        };
      });

      return res.json({ items, total, page: pg, limit: lim });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── POST /preview — Preview TDS and net pay without saving ─── */
r.post(
  "/preview",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = await resolveWorkspaceId(req);
      const { userId, ctcAnnual, earnings, regime, reimbursements } = req.body;

      if (!ctcAnnual || !earnings) {
        return res.status(400).json({ error: "ctcAnnual and earnings required" });
      }

      // Compute reimbursement tax split for preview
      const reimbArray: any[] = Array.isArray(reimbursements) ? reimbursements : [];
      let totalReimb = 0;
      let taxableReimb = 0;
      let nonTaxableReimb = 0;
      for (const r of reimbArray) {
        if (r.isActive === false) continue;
        const amt = r.annualAmount || 0;
        totalReimb += amt;
        const taxFree = r.annualTaxFreeLimit || 0;
        nonTaxableReimb += Math.min(amt, taxFree);
        taxableReimb += Math.max(0, amt - taxFree);
      }

      const workspace: any = await CustomerWorkspace.findById(workspaceId)
        .select("payrollConfig")
        .lean();
      const pCfg = workspace?.payrollConfig || {};

      const basicMonthly = (earnings.basic || 0) / 12;
      const grossMonthly = ctcAnnual / 12;

      // PF
      const pfResult = computePF(
        basicMonthly,
        pCfg.pfBasis || "CAPPED",
        pCfg.pfCap ?? 15000
      );

      // ESI
      const esiResult = computeESI(grossMonthly, pCfg.esiGrossLimit ?? 21000);

      // PT
      const ptResult = computePT(grossMonthly, pCfg.ptState || "Karnataka");

      // Taxable income = CTC minus non-taxable reimbursements + taxable reimbursements
      // i.e. annualGross for TDS = ctcAnnual - nonTaxableReimb (those are exempt)
      const annualGrossForTds = ctcAnnual - nonTaxableReimb;

      // TDS New Regime (reimbursements not tax-free under new regime)
      const tdsNew = computeTDSNewRegime({
        annualGross: ctcAnnual,
        monthNumber: 1,
        tdsPaidSoFar: 0,
      });

      // TDS Old Regime (with zero declarations for preview)
      let user: any = null;
      if (userId) {
        user = await User.findById(userId).select("investmentDeclarations").lean();
      }
      const decl = user?.investmentDeclarations || {};

      const hraExemption = computeHRAExemption({
        basicMonthly,
        hraReceived: (earnings.hra || 0) / 12,
        hraActualPaid: (decl.hra || 0) / 12,
        isMetro: true,
      });

      const tdsOld = computeTDSOldRegime({
        annualGross: annualGrossForTds,
        hraExemption,
        section80C: decl.section80C || 0,
        section80D: decl.section80D || 0,
        section80CCD1B: decl.section80CCD1B || 0,
        homeLoanInterest: decl.homeLoanInterest || 0,
        otherDeductions: decl.otherDeductions || 0,
        parentsHealthInsurance: decl.parentsHealthInsurance || 0,
        parentsAreSenior: decl.parentsAreSenior || false,
        educationLoanInterest: decl.educationLoanInterest || 0,
        savingsInterest: decl.savingsInterest || 0,
        donations: decl.donations || [],
        monthNumber: 1,
        tdsPaidSoFar: 0,
      });

      const selectedTds = regime === "OLD" ? tdsOld : tdsNew;
      const totalDeductions = pfResult.pfEmployee + esiResult.esiEmployee + ptResult.pt + selectedTds.monthlyTds;
      const netPay = grossMonthly - totalDeductions;

      return res.json({
        grossMonthly: Math.round(grossMonthly * 100) / 100,
        pf: pfResult,
        esi: esiResult,
        pt: ptResult,
        tdsNew,
        tdsOld,
        selectedRegime: regime || "NEW",
        totalDeductionsMonthly: Math.round(totalDeductions * 100) / 100,
        netPayMonthly: Math.round(netPay * 100) / 100,
        reimbursements: {
          total: totalReimb,
          taxable: taxableReimb,
          nonTaxable: nonTaxableReimb,
        },
      });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── PUT /investment-declaration — Employee updates declarations ─── */
r.put(
  "/investment-declaration",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.sub;
      const {
        section80C, section80D, section80CCD1B, hra, lta, homeLoanInterest, otherDeductions,
        parentsHealthInsurance, parentsAreSenior, educationLoanInterest, savingsInterest,
        ltaClaimedThisYear, donations,
      } = req.body;

      // Sanitize donations array (max 5)
      const cleanDonations = Array.isArray(donations)
        ? donations.slice(0, 5).map((d: any) => ({
            organizationName: String(d.organizationName || "").slice(0, 200),
            amount: Math.max(0, Number(d.amount) || 0),
            deductionPercent: [50, 100].includes(Number(d.deductionPercent)) ? Number(d.deductionPercent) : 50,
          }))
        : [];

      const capped = {
        section80C: Math.min(section80C || 0, STATUTORY.OLD_REGIME.SECTION_80C_LIMIT),
        section80D: Math.min(section80D || 0, STATUTORY.OLD_REGIME.SECTION_80D_LIMIT),
        section80CCD1B: Math.min(section80CCD1B || 0, STATUTORY.OLD_REGIME.SECTION_80CCD1B_LIMIT),
        hra: hra || 0,
        lta: lta || 0,
        homeLoanInterest: Math.min(homeLoanInterest || 0, 200000),
        otherDeductions: otherDeductions || 0,
        parentsHealthInsurance: Math.min(
          parentsHealthInsurance || 0,
          parentsAreSenior ? 50000 : 25000
        ),
        parentsAreSenior: !!parentsAreSenior,
        educationLoanInterest: Math.max(0, educationLoanInterest || 0),
        savingsInterest: Math.min(savingsInterest || 0, 10000),
        ltaClaimedThisYear: Math.max(0, ltaClaimedThisYear || 0),
        donations: cleanDonations,
      };

      await User.updateOne(
        { _id: userId },
        { $set: { investmentDeclarations: capped } }
      );

      // Estimate annual tax under old regime
      const user: any = await User.findById(userId).select("ctc taxRegimePreference").lean();
      const annualGross = user?.ctc || 0;
      let estimatedAnnualTax = 0;

      if (annualGross > 0 && user?.taxRegimePreference === "OLD") {
        const result = computeTDSOldRegime({
          annualGross,
          hraExemption: 0,
          section80C: capped.section80C,
          section80D: capped.section80D,
          section80CCD1B: capped.section80CCD1B,
          homeLoanInterest: capped.homeLoanInterest,
          otherDeductions: capped.otherDeductions,
          parentsHealthInsurance: capped.parentsHealthInsurance,
          parentsAreSenior: capped.parentsAreSenior,
          educationLoanInterest: capped.educationLoanInterest,
          savingsInterest: capped.savingsInterest,
          donations: capped.donations,
          monthNumber: 1,
          tdsPaidSoFar: 0,
        });
        estimatedAnnualTax = result.annualTax;
      }

      return res.json({ success: true, estimatedAnnualTax });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── PUT /tax-regime — Employee declares preferred tax regime ─── */
r.put(
  "/tax-regime",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.sub;
      const { regime } = req.body;

      if (!["OLD", "NEW"].includes(regime)) {
        return res.status(400).json({ error: "regime must be OLD or NEW" });
      }

      await User.updateOne({ _id: userId }, { $set: { taxRegimePreference: regime } });
      return res.json({ success: true, regime });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * GET /api/payroll/salary/structure-summary/:userId
 * Returns salary structure + last payslip summary for the compensation tab.
 * Accessible by HR/ADMIN or the employee themselves.
 */
r.get(
  "/structure-summary/:userId",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;
      const user = (req as any).user;
      const wsId = await resolveWorkspaceId(req);

      // Auth: must be own profile or HR/ADMIN/SUPERADMIN
      const isSelf = String(user._id ?? user.id ?? user.sub) === userId;
      const isAdmin = isSuperAdmin(req) ||
        (Array.isArray(user.roles) && (user.roles.includes("ADMIN") || user.roles.includes("HR")));

      if (!isSelf && !isAdmin) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const filter: any = { userId: new mongoose.Types.ObjectId(userId), isActive: true };
      if (wsId) filter.workspaceId = new mongoose.Types.ObjectId(wsId);

      const structure = await SalaryStructure.findOne(filter)
        .sort({ effectiveFrom: -1 })
        .lean();

      // Last published payslip
      const Payslip = mongoose.models.Payslip;
      let lastPayslip: any = null;
      if (Payslip) {
        const pFilter: any = { userId: new mongoose.Types.ObjectId(userId), status: "PUBLISHED" };
        if (wsId) pFilter.workspaceId = new mongoose.Types.ObjectId(wsId);
        const slip = await Payslip.findOne(pFilter).sort({ year: -1, month: -1 }).lean();
        if (slip) {
          lastPayslip = {
            month: (slip as any).month,
            year: (slip as any).year,
            gross: (slip as any).earnings?.grossEarnings ?? 0,
            netPay: (slip as any).netPay ?? 0,
            tds: (slip as any).deductions?.tds ?? 0,
            pf: (slip as any).deductions?.pfEmployee ?? 0,
          };
        }
      }

      const structureSummary = structure
        ? {
            ctcAnnual: (structure as any).ctcAnnual,
            basic: (structure as any).earnings?.basic ?? 0,
            hra: (structure as any).earnings?.hra ?? 0,
            specialAllowance: (structure as any).earnings?.specialAllowance ?? 0,
            grossMonthly: (structure as any).monthly?.grossEarnings ?? 0,
            netMonthly: (structure as any).monthly?.netPay ?? 0,
            effectiveFrom: (structure as any).effectiveFrom,
          }
        : null;

      return res.json({ structure: structureSummary, lastPayslip });
    } catch (err) {
      return next(err);
    }
  }
);

export default r;
