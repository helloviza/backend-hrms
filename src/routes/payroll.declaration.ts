import { Router, type Request, type Response, type NextFunction } from "express";
import mongoose from "mongoose";
import multer from "multer";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireFeature } from "../middleware/requireFeature.js";
import { requireRoles } from "../middleware/roles.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import DeclarationWindow from "../models/DeclarationWindow.js";
import EmployeeDeclaration from "../models/EmployeeDeclaration.js";
import ProofDocument from "../models/ProofDocument.js";
import User from "../models/User.js";
import { env } from "../config/env.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import {
  computeTDSOldRegime,
  computeHRAExemption,
  STATUTORY,
} from "../services/payroll.statutory.js";

const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : undefined,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/pdf", "image/jpeg", "image/png", "image/jpg"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only PDF, JPG, and PNG files are allowed"));
  },
});

const r = Router();

r.use(requireAuth, requireWorkspace, requireFeature("payrollEnabled"), (req: Request, res: Response, next: NextFunction) => {
  if (!req.workspaceObjectId) return res.status(400).json({ error: "workspaceId query param required for SUPERADMIN" });
  next();
});

/* ────────────────────────────────────────────────────────────
 * HELPERS
 * ──────────────────────────────────────────────────────────── */

function getCurrentFY(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return m >= 4 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function getWindowStatus(w: any): string {
  if (!w) return "NO_WINDOW";
  if (!w.declarationOpen) return "CLOSED";
  if (w.declarationOpen && !w.declarationFrozenAt) {
    if (w.declarationDeadline && new Date() > new Date(w.declarationDeadline)) return "DECLARATION_OVERDUE";
    return "DECLARATION_OPEN";
  }
  if (w.declarationFrozenAt && !w.proofSubmissionOpen) return "DECLARATION_FROZEN";
  if (w.proofSubmissionOpen && !w.proofSubmissionClosedAt) {
    if (w.proofSubmissionDeadline && new Date() > new Date(w.proofSubmissionDeadline)) return "PROOF_OVERDUE";
    return "PROOF_OPEN";
  }
  return "PROOF_CLOSED";
}

function isHrOrAdmin(req: Request): boolean {
  const roles: string[] = (req as any).user?.roles || [];
  return roles.some(
    (r) => ["HR", "ADMIN", "SUPERADMIN"].includes(r.toUpperCase()),
  );
}

/* ────────────────────────────────────────────────────────────
 * B4 — WINDOW MANAGEMENT
 * ──────────────────────────────────────────────────────────── */

/** GET /window — current declaration window */
r.get("/window", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const fy = (req.query as any).financialYear || getCurrentFY();
    const window = await DeclarationWindow.findOne({ workspaceId: req.workspaceObjectId, financialYear: fy }).lean();
    return res.json({ window, status: getWindowStatus(window) });
  } catch (err) { return next(err); }
});

/** POST /window — create or update declaration window (HR/ADMIN) */
r.post(
  "/window",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { financialYear, declarationDeadline, proofSubmissionDeadline, notes } = req.body;
      if (!financialYear || !declarationDeadline) {
        return res.status(400).json({ error: "financialYear and declarationDeadline required" });
      }

      const userId = (req as any).user.sub;
      const window = await DeclarationWindow.findOneAndUpdate(
        { workspaceId: req.workspaceObjectId, financialYear },
        {
          $set: {
            workspaceId: req.workspaceObjectId,
            financialYear,
            declarationOpen: true,
            declarationOpenedAt: new Date(),
            declarationOpenedBy: userId,
            declarationDeadline: new Date(declarationDeadline),
            proofSubmissionDeadline: proofSubmissionDeadline ? new Date(proofSubmissionDeadline) : undefined,
            notes,
            createdBy: userId,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      return res.status(201).json({ window, status: getWindowStatus(window) });
    } catch (err) { return next(err); }
  },
);

/** PUT /window/freeze — freeze declaration phase */
r.put(
  "/window/freeze",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fy = (req.body as any).financialYear || getCurrentFY();
      const userId = (req as any).user.sub;

      const window = await DeclarationWindow.findOneAndUpdate(
        { workspaceId: req.workspaceObjectId, financialYear: fy, declarationOpen: true },
        { $set: { declarationFrozenAt: new Date(), declarationFrozenBy: userId } },
        { new: true },
      );
      if (!window) return res.status(404).json({ error: "No open declaration window found" });

      const result = await EmployeeDeclaration.updateMany(
        { workspaceId: req.workspaceObjectId, declarationWindowId: window._id, declarationStatus: "SUBMITTED" },
        { $set: { declarationStatus: "FROZEN", frozenAt: new Date() } },
      );

      return res.json({ frozen: result.modifiedCount, status: getWindowStatus(window) });
    } catch (err) { return next(err); }
  },
);

/** PUT /window/open-proof — open proof submission phase */
r.put(
  "/window/open-proof",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fy = (req.body as any).financialYear || getCurrentFY();
      const userId = (req as any).user.sub;

      // Read-only check first (lean for speed)
      const existing = await DeclarationWindow.findOne({ workspaceId: req.workspaceObjectId, financialYear: fy }).lean();
      if (!existing) return res.status(404).json({ error: "No declaration window found" });

      // Allow if declarationFrozenAt is set OR computed status is DECLARATION_FROZEN
      const wStatus = getWindowStatus(existing);
      if (!existing.declarationFrozenAt && wStatus !== "DECLARATION_FROZEN") {
        return res.status(400).json({ error: "Must freeze declarations first" });
      }

      if (existing.proofSubmissionOpen) {
        return res.status(400).json({ error: "Proof submission is already open" });
      }

      // Use findOneAndUpdate to avoid full-document validation on .save()
      const window = await DeclarationWindow.findOneAndUpdate(
        { workspaceId: req.workspaceObjectId, financialYear: fy },
        {
          $set: {
            proofSubmissionOpen: true,
            proofSubmissionOpenedAt: new Date(),
            proofSubmissionOpenedBy: userId,
          },
        },
        { new: true, runValidators: false },
      );

      return res.json({ success: true, status: getWindowStatus(window!) });
    } catch (err) { return next(err); }
  },
);

/** PUT /window/close-proof — close proof submission */
r.put(
  "/window/close-proof",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fy = (req.body as any).financialYear || getCurrentFY();
      const userId = (req as any).user.sub;

      const window = await DeclarationWindow.findOneAndUpdate(
        { workspaceId: req.workspaceObjectId, financialYear: fy, proofSubmissionOpen: true },
        { $set: { proofSubmissionClosedAt: new Date(), proofSubmissionClosedBy: userId } },
        { new: true },
      );
      if (!window) return res.status(404).json({ error: "No open proof submission window found" });

      return res.json({ success: true, status: getWindowStatus(window) });
    } catch (err) { return next(err); }
  },
);

/** PUT /employee/:userId/unlock — HR unlocks a frozen employee */
r.put(
  "/employee/:userId/unlock",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;
      const { reason } = req.body;
      const hrUserId = (req as any).user.sub;

      const decl = await EmployeeDeclaration.findOneAndUpdate(
        { workspaceId: req.workspaceObjectId, userId, declarationStatus: "FROZEN" },
        {
          $set: {
            declarationStatus: "HR_UNLOCKED",
            unlockedBy: hrUserId,
            unlockedAt: new Date(),
            unlockReason: reason || "",
          },
        },
        { new: true },
      );
      if (!decl) return res.status(404).json({ error: "No frozen declaration found for this employee" });

      return res.json({ success: true });
    } catch (err) { return next(err); }
  },
);

/** PUT /employee/:userId/relock — re-freeze a previously unlocked employee */
r.put(
  "/employee/:userId/relock",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;

      const decl = await EmployeeDeclaration.findOneAndUpdate(
        { workspaceId: req.workspaceObjectId, userId, declarationStatus: "HR_UNLOCKED" },
        { $set: { declarationStatus: "FROZEN", frozenAt: new Date() } },
        { new: true },
      );
      if (!decl) return res.status(404).json({ error: "No unlocked declaration found" });

      return res.json({ success: true });
    } catch (err) { return next(err); }
  },
);

/** POST /window/send-reminder — manually trigger reminder emails */
r.post(
  "/window/send-reminder",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fy = (req.body as any).financialYear || getCurrentFY();

      const window: any = await DeclarationWindow.findOne({
        workspaceId: req.workspaceObjectId,
        financialYear: fy,
      });
      if (!window) return res.status(404).json({ error: "No declaration window found" });

      const status = getWindowStatus(window);
      const isDeclarationPhase = status === "DECLARATION_OPEN" || status === "DECLARATION_OVERDUE";
      const isProofPhase = status === "PROOF_OPEN" || status === "PROOF_OVERDUE";

      if (!isDeclarationPhase && !isProofPhase) {
        return res.status(400).json({ error: "Window is not in an active phase" });
      }

      // Find employees who haven't submitted
      let filter: any = { workspaceId: req.workspaceObjectId };
      if (isDeclarationPhase) {
        // Employees who don't have SUBMITTED/FROZEN declarations
        const submitted = await EmployeeDeclaration.find({
          workspaceId: req.workspaceObjectId,
          declarationWindowId: window._id,
          declarationStatus: { $in: ["SUBMITTED", "FROZEN"] },
        }).select("userId").lean();
        const submittedIds = submitted.map((d: any) => d.userId);
        filter = { workspaceId: req.workspaceObjectId, status: { $ne: "INACTIVE" }, _id: { $nin: submittedIds } };
      } else {
        // Proof phase — employees who have FROZEN declaration but no proofs
        const pending = await EmployeeDeclaration.find({
          workspaceId: req.workspaceObjectId,
          declarationWindowId: window._id,
          proofStatus: { $in: ["NOT_STARTED", "PARTIAL"] },
        }).select("userId").lean();
        const pendingIds = pending.map((d: any) => d.userId);
        filter = { workspaceId: req.workspaceObjectId, _id: { $in: pendingIds } };
      }

      const employees = await User.find(filter).select("email name firstName lastName").lean();

      // Send emails (best-effort, don't fail on SMTP issues)
      let sentCount = 0;
      try {
        const { sendMail } = await import("../utils/mailer.js");
        const deadline = isDeclarationPhase
          ? window.declarationDeadline?.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
          : window.proofSubmissionDeadline?.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

        for (const emp of employees) {
          try {
            const empName = emp.firstName || (emp as any).name || "Employee";
            const subject = isDeclarationPhase
              ? "Action required: Investment declaration closes soon"
              : "Action required: Submit investment proof documents";

            await sendMail({
              to: (emp as any).email,
              subject,
              html: `<p>Hi ${empName},</p><p>Please ${isDeclarationPhase ? "submit your investment declarations" : "upload your proof documents"} before <strong>${deadline}</strong>.</p><p>Visit your HRMS portal: <a href="${env.FRONTEND_ORIGIN}/payroll/investments">Investment Declarations</a></p>`,
              kind: "DEFAULT",
            });
            sentCount++;
          } catch {
            // Skip individual send failures
          }
        }
      } catch {
        // SMTP not configured
      }

      await DeclarationWindow.findOneAndUpdate(
        { _id: window._id },
        {
          $set: { reminderSentAt: new Date() },
          $inc: { reminderSentCount: 1 },
        },
        { runValidators: false },
      );

      return res.json({ sent: sentCount, total: employees.length });
    } catch (err) { return next(err); }
  },
);

/* ────────────────────────────────────────────────────────────
 * B5 — EMPLOYEE DECLARATION SUBMISSION
 * ──────────────────────────────────────────────────────────── */

/** POST /submit — employee submits or updates their declaration */
r.post("/submit", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.sub;
    const fy = (req.body as any).financialYear || getCurrentFY();

    const window: any = await DeclarationWindow.findOne({
      workspaceId: req.workspaceObjectId,
      financialYear: fy,
    }).lean();

    const status = getWindowStatus(window);
    if (!window || (status !== "DECLARATION_OPEN" && status !== "DECLARATION_OVERDUE")) {
      return res.status(400).json({ error: "Declaration window is not open" });
    }

    // Check existing declaration status
    const existing = await EmployeeDeclaration.findOne({
      workspaceId: req.workspaceObjectId,
      userId,
      financialYear: fy,
    });

    if (existing?.declarationStatus === "FROZEN") {
      return res.status(403).json({ error: "Declaration window is frozen" });
    }

    const { taxRegime, declarations, isDraft } = req.body;

    const decl = await EmployeeDeclaration.findOneAndUpdate(
      { workspaceId: req.workspaceObjectId, userId, financialYear: fy },
      {
        $set: {
          workspaceId: req.workspaceObjectId,
          userId,
          financialYear: fy,
          declarationWindowId: window._id,
          taxRegime: taxRegime || "OLD",
          declarations: declarations || {},
          declarationStatus: isDraft ? "DRAFT" : "SUBMITTED",
          ...(isDraft ? {} : { submittedAt: new Date() }),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // Sync to User.investmentDeclarations for backward compatibility
    if (!isDraft && declarations) {
      const d = declarations;
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            "investmentDeclarations.section80C": d.section80C || 0,
            "investmentDeclarations.section80D": d.selfHealthInsurance || 0,
            "investmentDeclarations.section80CCD1B": d.section80CCD1B || 0,
            "investmentDeclarations.hra": d.hraRentPaidAnnual || 0,
            "investmentDeclarations.homeLoanInterest": d.homeLoanInterest || 0,
            "investmentDeclarations.otherDeductions": d.otherDeductions || 0,
            "investmentDeclarations.parentsHealthInsurance": d.parentsHealthInsurance || 0,
            "investmentDeclarations.parentsAreSenior": d.parentsAreSenior || false,
            "investmentDeclarations.educationLoanInterest": d.educationLoanInterest || 0,
            "investmentDeclarations.savingsInterest": d.savingsInterest || 0,
            "investmentDeclarations.ltaClaimedThisYear": d.ltaClaimedThisYear || 0,
            "investmentDeclarations.donations": d.donations || [],
            taxRegimePreference: taxRegime || "OLD",
          },
        },
      );
    }

    return res.json({ success: true, declaration: decl });
  } catch (err) { return next(err); }
});

/** GET /mine — employee views their own declaration */
r.get("/mine", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.sub;
    const fy = (req.query as any).financialYear || getCurrentFY();

    const window: any = await DeclarationWindow.findOne({
      workspaceId: req.workspaceObjectId,
      financialYear: fy,
    }).lean();

    const declaration = await EmployeeDeclaration.findOne({
      workspaceId: req.workspaceObjectId,
      userId,
      financialYear: fy,
    }).lean();

    return res.json({
      declaration,
      window: window
        ? {
            status: getWindowStatus(window),
            declarationDeadline: window.declarationDeadline,
            proofSubmissionDeadline: window.proofSubmissionDeadline,
            financialYear: window.financialYear,
          }
        : null,
    });
  } catch (err) { return next(err); }
});

/** PUT /employee/:userId/hr-override — HR overrides employee declarations */
r.put(
  "/employee/:userId/hr-override",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;
      const hrUserId = (req as any).user.sub;
      const { declarations, reason } = req.body;
      const fy = (req.body as any).financialYear || getCurrentFY();

      const existing = await EmployeeDeclaration.findOne({
        workspaceId: req.workspaceObjectId,
        userId,
        financialYear: fy,
      }).lean();
      if (!existing) return res.status(404).json({ error: "No declaration found" });

      const updated = await EmployeeDeclaration.findOneAndUpdate(
        { workspaceId: req.workspaceObjectId, userId, financialYear: fy },
        {
          $set: {
            hrOverride: {
              overriddenBy: hrUserId,
              overriddenAt: new Date(),
              reason: reason || "",
              originalDeclarations: existing.declarations,
            },
            declarations,
          },
        },
        { new: true, runValidators: false },
      );

      return res.json({ success: true, declaration: updated });
    } catch (err) { return next(err); }
  },
);

/* ────────────────────────────────────────────────────────────
 * B6 — PROOF DOCUMENT API
 * ──────────────────────────────────────────────────────────── */

/** POST /proof/upload — employee uploads proof */
r.post(
  "/proof/upload",
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.sub;
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) return res.status(400).json({ error: "File is required" });

      const fy = req.body.financialYear || getCurrentFY();

      // Validate window
      const window: any = await DeclarationWindow.findOne({
        workspaceId: req.workspaceObjectId,
        financialYear: fy,
      }).lean();

      const status = getWindowStatus(window);
      if (status !== "PROOF_OPEN" && status !== "PROOF_OVERDUE") {
        return res.status(400).json({ error: "Proof submission window is not open" });
      }

      // Get employee declaration
      const decl = await EmployeeDeclaration.findOne({
        workspaceId: req.workspaceObjectId,
        userId,
        financialYear: fy,
      });
      if (!decl) return res.status(400).json({ error: "No declaration found. Submit declaration first." });

      // Upload to S3
      const ext = (file.originalname.split(".").pop() || "bin").toLowerCase();
      const rand = crypto.randomBytes(8).toString("hex");
      const s3Key = `proofs/${req.workspaceObjectId}/${userId}/${fy}/${req.body.declarationSection}_${Date.now()}_${rand}.${ext}`;

      await s3.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: s3Key,
          Body: file.buffer,
          ContentType: file.mimetype,
          Metadata: {
            originalName: file.originalname,
            userId,
            financialYear: fy,
            section: req.body.declarationSection || "",
          },
        }),
      );

      const proof = await ProofDocument.create({
        workspaceId: req.workspaceObjectId,
        employeeDeclarationId: decl._id,
        userId,
        financialYear: fy,
        declarationSection: req.body.declarationSection,
        declarationLabel: req.body.declarationLabel || "",
        declaredAmount: Number(req.body.declaredAmount) || 0,
        fileName: file.originalname,
        fileSize: file.size,
        mimeType: file.mimetype,
        s3Key,
        submittedAt: new Date(),
        description: req.body.description || "",
      });

      // Update proof status
      if (decl.proofStatus === "NOT_STARTED") {
        await EmployeeDeclaration.updateOne(
          { _id: decl._id },
          { $set: { proofStatus: "PARTIAL" } },
        );
      }

      return res.status(201).json({ proofId: proof._id, fileName: file.originalname, section: req.body.declarationSection });
    } catch (err) { return next(err); }
  },
);

/** GET /proof/mine — employee views their proofs */
r.get("/proof/mine", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.sub;
    const fy = (req.query as any).financialYear || getCurrentFY();

    const proofs: any[] = await ProofDocument.find({
      workspaceId: req.workspaceObjectId,
      userId,
      financialYear: fy,
    }).lean();

    // Generate presigned URLs
    for (const proof of proofs) {
      if (proof.s3Key) {
        proof.s3Url = await presignGetObject({
          bucket: env.S3_BUCKET,
          key: proof.s3Key,
          filename: proof.fileName,
          expiresInSeconds: 3600,
        });
      }
    }

    return res.json({ proofs });
  } catch (err) { return next(err); }
});

/** GET /proof/:proofId/url — get presigned URL */
r.get("/proof/:proofId/url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { proofId } = req.params;
    const userId = (req as any).user.sub;

    const proof: any = await ProofDocument.findOne({
      _id: proofId,
      workspaceId: req.workspaceObjectId,
    }).lean();
    if (!proof) return res.status(404).json({ error: "Proof not found" });

    // Employees can only view their own proofs
    if (!isHrOrAdmin(req) && String(proof.userId) !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const url = await presignGetObject({
      bucket: env.S3_BUCKET,
      key: proof.s3Key,
      filename: proof.fileName,
      expiresInSeconds: 3600,
    });

    return res.json({ url, expiresIn: 3600 });
  } catch (err) { return next(err); }
});

/** DELETE /proof/:proofId — employee deletes a proof */
r.delete("/proof/:proofId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { proofId } = req.params;
    const userId = (req as any).user.sub;

    const proof = await ProofDocument.findOne({
      _id: proofId,
      workspaceId: req.workspaceObjectId,
      userId,
      verificationStatus: "PENDING",
    });
    if (!proof) return res.status(404).json({ error: "Proof not found or already verified" });

    // Check window is still open
    const fy = proof.financialYear;
    const window: any = await DeclarationWindow.findOne({
      workspaceId: req.workspaceObjectId,
      financialYear: fy,
    }).lean();
    const status = getWindowStatus(window);
    if (status !== "PROOF_OPEN" && status !== "PROOF_OVERDUE") {
      return res.status(400).json({ error: "Proof submission window is closed" });
    }

    await proof.deleteOne();
    return res.json({ success: true });
  } catch (err) { return next(err); }
});

/** GET /team — HR views all employee declarations */
r.get(
  "/team",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fy = (req.query as any).financialYear || getCurrentFY();
      const { declarationStatus, proofStatus } = req.query as any;

      const filter: any = { workspaceId: req.workspaceObjectId, financialYear: fy };
      if (declarationStatus) filter.declarationStatus = declarationStatus;
      if (proofStatus) filter.proofStatus = proofStatus;

      const declarations: any[] = await EmployeeDeclaration.find(filter)
        .populate("userId", "firstName lastName name email employeeCode designation department")
        .lean();

      const items = declarations.map((d: any) => {
        const user = d.userId || {};
        const decls = d.declarations || {};
        const totalDeclared =
          (decls.section80C || 0) + (decls.section80CCD1B || 0) +
          (decls.selfHealthInsurance || 0) + (decls.parentsHealthInsurance || 0) +
          (decls.hraRentPaidAnnual || 0) + (decls.homeLoanInterest || 0) +
          (decls.educationLoanInterest || 0) + (decls.savingsInterest || 0) +
          (decls.ltaClaimedThisYear || 0) + (decls.otherDeductions || 0);

        const approved = d.approvedDeclarations || {};
        const totalApproved =
          (approved.section80C || 0) + (approved.section80CCD1B || 0) +
          (approved.selfHealthInsurance || 0) + (approved.parentsHealthInsurance || 0) +
          (approved.hraRentPaidAnnual || 0) + (approved.homeLoanInterest || 0) +
          (approved.educationLoanInterest || 0) + (approved.savingsInterest || 0) +
          (approved.ltaClaimedThisYear || 0) + (approved.otherDeductions || 0);

        return {
          _id: d._id,
          userId: user._id || d.userId,
          name: user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.name || user.email || "",
          email: user.email || "",
          employeeCode: user.employeeCode || "",
          department: user.department || "",
          taxRegime: d.taxRegime,
          declarationStatus: d.declarationStatus,
          proofStatus: d.proofStatus,
          totalDeclared,
          totalApproved,
          submittedAt: d.submittedAt,
        };
      });

      return res.json({ items });
    } catch (err) { return next(err); }
  },
);

/** PUT /proof/:proofId/verify — HR verifies a proof document */
r.put(
  "/proof/:proofId/verify",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { proofId } = req.params;
      const hrUserId = (req as any).user.sub;
      const { status: verifyStatus, approvedAmount, verifierNotes, rejectionReason } = req.body;

      if (!["APPROVED", "REJECTED", "PARTIAL"].includes(verifyStatus)) {
        return res.status(400).json({ error: "status must be APPROVED, REJECTED, or PARTIAL" });
      }

      const proof = await ProofDocument.findOneAndUpdate(
        { _id: proofId, workspaceId: req.workspaceObjectId },
        {
          $set: {
            verificationStatus: verifyStatus,
            approvedAmount: approvedAmount ?? 0,
            verifierNotes: verifierNotes || "",
            rejectionReason: rejectionReason || "",
            verifiedBy: hrUserId,
            verifiedAt: new Date(),
          },
        },
        { new: true },
      );
      if (!proof) return res.status(404).json({ error: "Proof not found" });

      // Check if all proofs for this employee declaration are verified
      const allProofs = await ProofDocument.find({
        employeeDeclarationId: proof.employeeDeclarationId,
        workspaceId: req.workspaceObjectId,
      }).lean();

      const allVerified = allProofs.every((p: any) => p.verificationStatus !== "PENDING");
      const anyRejected = allProofs.some((p: any) => p.verificationStatus === "REJECTED");

      if (allVerified) {
        const decl = await EmployeeDeclaration.findById(proof.employeeDeclarationId).lean();
        if (decl) {
          const updateSet: Record<string, any> = {
            proofStatus: anyRejected ? "REJECTED" : "VERIFIED",
            verifiedBy: hrUserId,
            verifiedAt: new Date(),
          };

          // Build approved declarations from proof approved amounts
          if (!anyRejected) {
            const sectionTotals: Record<string, number> = {};
            for (const p of allProofs) {
              const sec = (p as any).declarationSection;
              const amt = (p as any).verificationStatus === "APPROVED" || (p as any).verificationStatus === "PARTIAL"
                ? (p as any).approvedAmount || 0
                : 0;
              sectionTotals[sec] = (sectionTotals[sec] || 0) + amt;
            }

            const approvedDeclarations = {
              section80C: sectionTotals["80C"] || 0,
              section80CCD1B: sectionTotals["80CCD1B"] || 0,
              selfHealthInsurance: sectionTotals["80D_SELF"] || 0,
              parentsHealthInsurance: sectionTotals["80D_PARENTS"] || 0,
              parentsAreSenior: (decl.declarations as any)?.parentsAreSenior || false,
              hraRentPaidAnnual: sectionTotals["HRA"] || 0,
              homeLoanInterest: sectionTotals["HOME_LOAN"] || 0,
              educationLoanInterest: sectionTotals["80E"] || 0,
              savingsInterest: sectionTotals["80TTA"] || 0,
              ltaClaimedThisYear: sectionTotals["LTA"] || 0,
              otherDeductions: sectionTotals["OTHER"] || 0,
              donations: (decl.declarations as any)?.donations || [],
            };
            updateSet.approvedDeclarations = approvedDeclarations;

            // Recalculate TDS
            try {
              const user: any = await User.findById(decl.userId).select("ctc").lean();
              const annualGross = user?.ctc || 0;
              if (annualGross > 0) {
                const ad = approvedDeclarations;
                const hraExemption = computeHRAExemption({
                  basicMonthly: annualGross * 0.4 / 12, // rough estimate
                  hraReceived: annualGross * 0.2 / 12,
                  hraActualPaid: (ad.hraRentPaidAnnual || 0) / 12,
                  isMetro: true,
                });

                const tdsResult = computeTDSOldRegime({
                  annualGross,
                  hraExemption,
                  section80C: ad.section80C || 0,
                  section80D: ad.selfHealthInsurance || 0,
                  section80CCD1B: ad.section80CCD1B || 0,
                  homeLoanInterest: ad.homeLoanInterest || 0,
                  otherDeductions: ad.otherDeductions || 0,
                  parentsHealthInsurance: ad.parentsHealthInsurance || 0,
                  parentsAreSenior: ad.parentsAreSenior || false,
                  educationLoanInterest: ad.educationLoanInterest || 0,
                  savingsInterest: ad.savingsInterest || 0,
                  donations: ad.donations || [],
                  monthNumber: 1,
                  tdsPaidSoFar: 0,
                });

                updateSet.estimatedAnnualTax = tdsResult.annualTax;
                updateSet.monthlyTdsFromNextMonth = tdsResult.monthlyTds;
                updateSet.tdsRecalculatedAt = new Date();
              }
            } catch {
              // TDS calculation not critical
            }

            // Sync approved amounts to User.investmentDeclarations
            const ad = approvedDeclarations;
            await User.updateOne(
              { _id: decl.userId },
              {
                $set: {
                  "investmentDeclarations.section80C": ad.section80C || 0,
                  "investmentDeclarations.section80D": ad.selfHealthInsurance || 0,
                  "investmentDeclarations.section80CCD1B": ad.section80CCD1B || 0,
                  "investmentDeclarations.hra": ad.hraRentPaidAnnual || 0,
                  "investmentDeclarations.homeLoanInterest": ad.homeLoanInterest || 0,
                  "investmentDeclarations.otherDeductions": ad.otherDeductions || 0,
                  "investmentDeclarations.parentsHealthInsurance": ad.parentsHealthInsurance || 0,
                  "investmentDeclarations.parentsAreSenior": ad.parentsAreSenior || false,
                  "investmentDeclarations.educationLoanInterest": ad.educationLoanInterest || 0,
                  "investmentDeclarations.savingsInterest": ad.savingsInterest || 0,
                  "investmentDeclarations.ltaClaimedThisYear": ad.ltaClaimedThisYear || 0,
                  "investmentDeclarations.donations": ad.donations || [],
                },
              },
            );
          }

          await EmployeeDeclaration.findOneAndUpdate(
            { _id: decl._id },
            { $set: updateSet },
            { runValidators: false },
          );
        }
      }

      return res.json({ success: true, proof });
    } catch (err) { return next(err); }
  },
);

/** GET /proof/:proofId/verify-batch — HR views all proofs for one employee */
r.get(
  "/proof/batch/:userId",
  requireRoles("HR", "ADMIN"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;
      const fy = (req.query as any).financialYear || getCurrentFY();

      const user: any = await User.findOne({
        _id: userId,
        workspaceId: req.workspaceObjectId,
      }).select("firstName lastName name email employeeCode designation department").lean();
      if (!user) return res.status(404).json({ error: "Employee not found" });

      const declaration = await EmployeeDeclaration.findOne({
        workspaceId: req.workspaceObjectId,
        userId,
        financialYear: fy,
      }).lean();

      const proofs: any[] = await ProofDocument.find({
        workspaceId: req.workspaceObjectId,
        userId,
        financialYear: fy,
      }).lean();

      // Generate presigned URLs
      for (const proof of proofs) {
        if (proof.s3Key) {
          proof.s3Url = await presignGetObject({
            bucket: env.S3_BUCKET,
            key: proof.s3Key,
            filename: proof.fileName,
            expiresInSeconds: 3600,
          });
        }
      }

      return res.json({ employee: user, declaration, proofs });
    } catch (err) { return next(err); }
  },
);

export default r;
