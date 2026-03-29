import { Router, Request, Response } from "express";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const router = Router();

const VALID_PLANS = ["trial", "starter", "growth", "enterprise"] as const;
type Plan = (typeof VALID_PLANS)[number];

/* ── PUT /plan ───────────────────────────────────────────────────── */
router.put(
  "/plan",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      const { plan } = req.body as { plan: Plan };

      if (!plan || !VALID_PLANS.includes(plan)) {
        res.status(400).json({
          error: `Invalid plan. Must be one of: ${VALID_PLANS.join(", ")}`,
        });
        return;
      }

      const workspace = await CustomerWorkspace.findById(req.workspaceId);
      if (!workspace) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }

      workspace.plan = plan;

      const defaultFeatures = CustomerWorkspace.getDefaultFeaturesForPlan(plan);
      workspace.config.features = {
        ...workspace.config.features,
        ...defaultFeatures,
      };

      if (workspace.onboardingStep === "registered") {
        workspace.onboardingStep = "plan_selected";
      }

      await workspace.save();

      res.json({ workspace });
    } catch (err) {
      console.error("[workspace.onboarding] PUT /plan error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/* ── PUT /configure ─────────────────────────────────────────────── */
router.put(
  "/configure",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      const {
        companyLogo,
        gstNumber,
        pan,
        address,
        leavePolicy,
        attendanceConfig,
        payrollConfig,
      } = req.body;

      const workspace = await CustomerWorkspace.findById(req.workspaceId);
      if (!workspace) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }

      if (companyLogo !== undefined) workspace.companyLogo = companyLogo;
      if (gstNumber !== undefined) workspace.gstNumber = gstNumber;
      if (pan !== undefined) workspace.pan = pan;
      if (address !== undefined) workspace.address = address;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws = workspace as any;
      if (leavePolicy !== undefined) ws.leavePolicy = leavePolicy;
      if (attendanceConfig !== undefined) ws.attendanceConfig = attendanceConfig;
      if (payrollConfig !== undefined) ws.payrollConfig = payrollConfig;

      if (
        workspace.onboardingStep === "registered" ||
        workspace.onboardingStep === "plan_selected"
      ) {
        workspace.onboardingStep = "workspace_configured";
      }

      await workspace.save();

      res.json({ success: true });
    } catch (err) {
      console.error("[workspace.onboarding] PUT /configure error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/* ── PUT /complete ──────────────────────────────────────────────── */
router.put(
  "/complete",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      const workspace = await CustomerWorkspace.findById(req.workspaceId);
      if (!workspace) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }

      workspace.onboardingStep = "complete";
      workspace.onboardingCompletedAt = new Date();

      await workspace.save();

      res.json({ success: true });
    } catch (err) {
      console.error("[workspace.onboarding] PUT /complete error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/* ── GET /status ────────────────────────────────────────────────── */
router.get(
  "/status",
  requireAuth,
  requireWorkspace,
  async (req: Request, res: Response) => {
    try {
      const workspace = await CustomerWorkspace.findById(
        req.workspaceId
      ).select("onboardingStep plan isEmailVerified config");

      if (!workspace) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }

      res.json({
        onboardingStep: workspace.onboardingStep,
        plan: workspace.plan,
        isEmailVerified: workspace.isEmailVerified,
        features: workspace.config.features,
      });
    } catch (err) {
      console.error("[workspace.onboarding] GET /status error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
