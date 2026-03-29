import { Router, type Request, type Response, type NextFunction } from "express";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireFeature } from "../middleware/requireFeature.js";
import { requireRoles } from "../middleware/roles.js";
import ReimbursementClaim from "../models/ReimbursementClaim.js";
import SalaryStructure from "../models/SalaryStructure.js";
import User from "../models/User.js";
import { REIMBURSEMENT_HEADS } from "../services/payroll.statutory.js";

const r = Router();

r.use(requireAuth, requireWorkspace, requireFeature("payrollEnabled"));

function hasRole(req: Request, ...roles: string[]): boolean {
  const userRoles: string[] = (req as any).user?.roles || [];
  return userRoles.some(
    (r) => roles.includes(r.toUpperCase()) || r.toUpperCase() === "SUPERADMIN"
  );
}

/* ─── GET /heads — Available reimbursement heads ─── */
r.get(
  "/heads",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const heads = Object.values(REIMBURSEMENT_HEADS).map((h) => ({
        key: h.key,
        label: h.label,
        annualLimit: h.annualLimit,
        taxFreeLimit: h.taxFreeLimit,
        newRegimeTaxFree: h.newRegimeTaxFree,
        requiresBills: h.requiresBills,
        description: h.description,
      }));
      return res.json({ heads });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── POST /claim — Employee submits reimbursement claim ─── */
r.post(
  "/claim",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const userId = (req as any).user.sub;
      const { month, reimbursementKey, claimedAmount, description, attachments } = req.body;

      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: "month required in YYYY-MM format" });
      }
      if (!reimbursementKey) {
        return res.status(400).json({ error: "reimbursementKey required" });
      }
      if (!claimedAmount || claimedAmount <= 0) {
        return res.status(400).json({ error: "claimedAmount must be > 0" });
      }

      // Check month is not more than 2 months in the past
      const [yearStr, monStr] = month.split("-");
      const claimYear = parseInt(yearStr, 10);
      const claimMon = parseInt(monStr, 10);
      const now = new Date();
      const nowYear = now.getFullYear();
      const nowMon = now.getMonth() + 1;
      const monthDiff = (nowYear - claimYear) * 12 + (nowMon - claimMon);
      if (monthDiff > 2) {
        return res.status(400).json({ error: "Cannot claim for more than 2 months in the past" });
      }

      // Find active salary structure
      const structure: any = await SalaryStructure.findOne({
        workspaceId,
        userId,
        isActive: true,
      }).lean();

      if (!structure) {
        return res.status(400).json({ error: "No active salary structure found" });
      }

      // Find the reimbursement head in structure
      const head = (structure.reimbursements || []).find(
        (r: any) => r.key === reimbursementKey && r.isActive !== false
      );
      if (!head) {
        return res.status(400).json({ error: "This reimbursement head is not part of your salary structure" });
      }

      const declaredMonthlyLimit = Math.round(head.annualAmount / 12);

      if (claimedAmount > declaredMonthlyLimit) {
        return res.status(400).json({
          error: `Claimed amount exceeds monthly limit of ₹${declaredMonthlyLimit}`,
          limit: declaredMonthlyLimit,
        });
      }

      // Check for duplicate
      const existing = await ReimbursementClaim.findOne({
        workspaceId,
        userId,
        month,
        reimbursementKey,
        status: { $in: ["SUBMITTED", "APPROVED", "PAID"] },
      });
      if (existing) {
        return res.status(409).json({ error: "A claim already exists for this month and reimbursement head" });
      }

      // Delete any DRAFT or REJECTED claim for same month+key (allow re-submission)
      await ReimbursementClaim.deleteMany({
        workspaceId,
        userId,
        month,
        reimbursementKey,
        status: { $in: ["DRAFT", "REJECTED"] },
      });

      const claim = await ReimbursementClaim.create({
        workspaceId,
        userId,
        salaryStructureId: structure._id,
        month,
        year: claimYear,
        reimbursementKey,
        reimbursementLabel: head.label,
        claimedAmount,
        declaredMonthlyLimit,
        attachments: attachments || [],
        description: description || "",
        status: "SUBMITTED",
      });

      return res.status(201).json({ claim });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET /mine — Employee's own claims ─── */
r.get(
  "/mine",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const userId = (req as any).user.sub;
      const { month, status } = req.query as any;

      const filter: any = { workspaceId, userId };
      if (month) filter.month = month;
      if (status) filter.status = status;

      const claims = await ReimbursementClaim.find(filter)
        .sort({ month: -1, createdAt: -1 })
        .lean();

      return res.json({ items: claims });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET /team — HR/ADMIN views all workspace claims ─── */
r.get(
  "/team",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const { month, status, userId } = req.query as any;

      const filter: any = { workspaceId };
      if (month) filter.month = month;
      if (status) filter.status = status;
      if (userId) filter.userId = userId;

      const claims = await ReimbursementClaim.find(filter)
        .sort({ month: -1, createdAt: -1 })
        .lean();

      // Enrich with user names
      const userIds = [...new Set(claims.map((c: any) => String(c.userId)))];
      const users: any[] = await User.find({ _id: { $in: userIds } })
        .select("_id firstName lastName name email")
        .lean();
      const userMap = new Map(
        users.map((u: any) => [
          String(u._id),
          u.firstName && u.lastName ? `${u.firstName} ${u.lastName}` : u.name || u.email || "",
        ])
      );

      const enriched = claims.map((c: any) => ({
        ...c,
        userName: userMap.get(String(c.userId)) || "",
      }));

      return res.json({ items: enriched });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── PUT /:claimId/approve — HR/ADMIN approves ─── */
r.put(
  "/:claimId/approve",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const { claimId } = req.params;
      const reviewerId = (req as any).user.sub;
      const { approvedAmount } = req.body;

      const claim: any = await ReimbursementClaim.findOne({ _id: claimId, workspaceId });
      if (!claim) return res.status(404).json({ error: "Claim not found" });
      if (claim.status !== "SUBMITTED") {
        return res.status(400).json({ error: "Can only approve SUBMITTED claims" });
      }

      if (approvedAmount == null || approvedAmount < 0) {
        return res.status(400).json({ error: "approvedAmount required and must be >= 0" });
      }
      if (approvedAmount > claim.claimedAmount) {
        return res.status(400).json({ error: "approvedAmount cannot exceed claimedAmount" });
      }

      claim.approvedAmount = approvedAmount;
      claim.status = "APPROVED";
      claim.reviewedBy = reviewerId;
      claim.reviewedAt = new Date();
      await claim.save();

      return res.json({ claim });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── PUT /:claimId/reject — HR/ADMIN rejects ─── */
r.put(
  "/:claimId/reject",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const { claimId } = req.params;
      const reviewerId = (req as any).user.sub;
      const { rejectionReason } = req.body;

      const claim: any = await ReimbursementClaim.findOne({ _id: claimId, workspaceId });
      if (!claim) return res.status(404).json({ error: "Claim not found" });
      if (claim.status !== "SUBMITTED") {
        return res.status(400).json({ error: "Can only reject SUBMITTED claims" });
      }

      claim.status = "REJECTED";
      claim.rejectionReason = rejectionReason || "";
      claim.reviewedBy = reviewerId;
      claim.reviewedAt = new Date();
      await claim.save();

      return res.json({ claim });
    } catch (err) {
      return next(err);
    }
  }
);

/* ─── GET /summary/:month — Per-user reimbursement summary for payroll ─── */
r.get(
  "/summary/:month",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId;
      const { month } = req.params;

      const claims = await ReimbursementClaim.find({
        workspaceId,
        month,
      })
        .sort({ userId: 1 })
        .lean();

      // Group by user
      const userIds = [...new Set(claims.map((c: any) => String(c.userId)))];
      const users: any[] = await User.find({ _id: { $in: userIds } })
        .select("_id firstName lastName name email")
        .lean();
      const userMap = new Map(
        users.map((u: any) => [
          String(u._id),
          u.firstName && u.lastName ? `${u.firstName} ${u.lastName}` : u.name || u.email || "",
        ])
      );

      const grouped: Record<string, any> = {};
      for (const c of claims) {
        const uid = String((c as any).userId);
        if (!grouped[uid]) {
          grouped[uid] = {
            userId: uid,
            userName: userMap.get(uid) || "",
            claims: [],
            totalApproved: 0,
            totalPending: 0,
          };
        }
        grouped[uid].claims.push(c);
        if ((c as any).status === "APPROVED" || (c as any).status === "PAID") {
          grouped[uid].totalApproved += (c as any).approvedAmount || 0;
        }
        if ((c as any).status === "SUBMITTED") {
          grouped[uid].totalPending += (c as any).claimedAmount || 0;
        }
      }

      return res.json({ items: Object.values(grouped) });
    } catch (err) {
      return next(err);
    }
  }
);

export default r;
