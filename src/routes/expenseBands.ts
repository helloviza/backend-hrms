// apps/backend/src/routes/expenseBands.ts
// Expense Band Policy — define per-band fare limits and assign bands to L1 users.
// Mounted at: /api/v1/workspace
import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import ExpenseBand from "../models/ExpenseBand.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";
import User from "../models/User.js";
import logger from "../utils/logger.js";

const router = Router();

router.use(requireAuth);
router.use(requireWorkspace);

/* ── Access control helpers ─────────────────────────────────────────────── */

function isWorkspaceLeader(req: any): boolean {
  const roles: string[] = Array.isArray(req.user?.roles) ? req.user.roles : [];
  return roles.some(
    (r) => String(r).toUpperCase().replace(/[\s_-]/g, "") === "WORKSPACELEADER"
  );
}

function requireWorkspaceLeader(req: any, res: any, next: any) {
  if (isWorkspaceLeader(req)) return next();
  return res.status(403).json({ error: "WORKSPACE_LEADER access required" });
}

/* ── GET /bands/my-band ─────────────────────────────────────────────────── */
// Must be registered before /bands/:bandNumber to avoid param capture.
router.get("/bands/my-band", async (req: any, res) => {
  try {
    const workspaceId = req.workspaceObjectId;

    // Check if expense band is enabled for this workspace
    const workspace = await CustomerWorkspace.findById(workspaceId)
      .select("config.features.expenseBandEnabled customerId")
      .lean();

    const expenseBandEnabled = Boolean(
      (workspace as any)?.config?.features?.expenseBandEnabled
    );

    if (!expenseBandEnabled) {
      return res.json({ bandEnabled: false });
    }

    // Find this user's bandNumber
    const userId = String(req.user._id || req.user.id);
    const userDoc = await User.findById(userId).select("bandNumber").lean();
    const bandNumber = (userDoc as any)?.bandNumber ?? null;

    if (!bandNumber) {
      return res.json({ bandEnabled: false });
    }

    // Find the ExpenseBand record
    const band = await ExpenseBand.findOne({ workspaceId, bandNumber }).lean();

    if (!band) {
      return res.json({ bandEnabled: false });
    }

    return res.json({
      bandEnabled: true,
      bandNumber: (band as any).bandNumber,
      bandName: (band as any).bandName || `Band ${(band as any).bandNumber}`,
      maxFlightFarePerPerson: (band as any).maxFlightFarePerPerson ?? 0,
      maxHotelFarePerNight: (band as any).maxHotelFarePerNight ?? 0,
      currency: (band as any).currency || "INR",
    });
  } catch (err: any) {
    logger.error("GET /bands/my-band failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/* ── GET /bands ─────────────────────────────────────────────────────────── */
// Returns all 10 bands for the workspace (with defaults for missing ones).
router.get("/bands", requireWorkspaceLeader, async (req: any, res) => {
  try {
    const workspaceId = req.workspaceObjectId;

    const [existingBands, workspace] = await Promise.all([
      ExpenseBand.find({ workspaceId }).lean(),
      CustomerWorkspace.findById(workspaceId)
        .select("config.features.expenseBandEnabled")
        .lean(),
    ]);

    const expenseBandEnabled = Boolean(
      (workspace as any)?.config?.features?.expenseBandEnabled
    );

    const bandMap = new Map<number, any>(
      (existingBands as any[]).map((b) => [b.bandNumber, b])
    );

    const bands = Array.from({ length: 10 }, (_, i) => {
      const n = i + 1;
      const existing = bandMap.get(n);
      if (existing) {
        return { ...existing, exists: true };
      }
      return {
        bandNumber: n,
        bandName: `Band ${n}`,
        maxFlightFarePerPerson: 0,
        maxHotelFarePerNight: 0,
        currency: "INR",
        exists: false,
      };
    });

    return res.json({ bands, expenseBandEnabled });
  } catch (err: any) {
    logger.error("GET /bands failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/* ── PUT /bands/:bandNumber ──────────────────────────────────────────────── */
router.put("/bands/:bandNumber", requireWorkspaceLeader, async (req: any, res) => {
  try {
    const bandNumber = parseInt(req.params.bandNumber, 10);
    if (isNaN(bandNumber) || bandNumber < 1 || bandNumber > 10) {
      return res.status(400).json({ error: "bandNumber must be 1-10" });
    }

    const { bandName, maxFlightFarePerPerson, maxHotelFarePerNight } = req.body as {
      bandName?: string;
      maxFlightFarePerPerson?: number;
      maxHotelFarePerNight?: number;
    };

    if (
      maxFlightFarePerPerson !== undefined &&
      (typeof maxFlightFarePerPerson !== "number" || maxFlightFarePerPerson < 0)
    ) {
      return res.status(400).json({ error: "maxFlightFarePerPerson must be >= 0" });
    }
    if (
      maxHotelFarePerNight !== undefined &&
      (typeof maxHotelFarePerNight !== "number" || maxHotelFarePerNight < 0)
    ) {
      return res.status(400).json({ error: "maxHotelFarePerNight must be >= 0" });
    }

    const workspaceId = req.workspaceObjectId;

    const update: Record<string, any> = {};
    if (bandName !== undefined) update.bandName = String(bandName).trim();
    if (maxFlightFarePerPerson !== undefined) update.maxFlightFarePerPerson = maxFlightFarePerPerson;
    if (maxHotelFarePerNight !== undefined) update.maxHotelFarePerNight = maxHotelFarePerNight;

    const band = await ExpenseBand.findOneAndUpdate(
      { workspaceId, bandNumber },
      { $set: update, $setOnInsert: { workspaceId, bandNumber, currency: "INR" } },
      { upsert: true, new: true, runValidators: true },
    ).lean();

    return res.json({ band });
  } catch (err: any) {
    logger.error("PUT /bands/:bandNumber failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/* ── PATCH /members/:userId/band ─────────────────────────────────────────── */
router.patch("/members/:userId/band", requireWorkspaceLeader, async (req: any, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: "Invalid userId" });
    }

    const { bandNumber } = req.body as { bandNumber: number | null };
    if (bandNumber !== null && bandNumber !== undefined) {
      if (typeof bandNumber !== "number" || bandNumber < 1 || bandNumber > 10) {
        return res.status(400).json({ error: "bandNumber must be 1-10 or null" });
      }
    }

    const workspaceId = req.workspaceObjectId;

    // Verify the target user belongs to this workspace
    const targetUser = await User.findOne({
      _id: userId,
      workspaceId,
    }).select("email bandNumber customerId").lean();

    if (!targetUser) {
      return res.status(404).json({ error: "User not found in this workspace" });
    }

    const resolvedBand = bandNumber ?? null;

    // Update User.bandNumber
    await User.findByIdAndUpdate(userId, { $set: { bandNumber: resolvedBand } });

    // Update CustomerMember.bandNumber (find by customerId + email)
    const ws = req.workspace;
    const customerId = ws?.customerId || (targetUser as any).customerId;

    if (customerId && (targetUser as any).email) {
      await CustomerMember.findOneAndUpdate(
        { customerId, email: (targetUser as any).email },
        { $set: { bandNumber: resolvedBand } },
        { new: true },
      );
    }

    logger.info("Band assigned to user", {
      userId,
      bandNumber: resolvedBand,
      assignedBy: String(req.user._id),
      workspaceId: String(workspaceId),
    });

    return res.json({
      success: true,
      userId,
      bandNumber: resolvedBand,
    });
  } catch (err: any) {
    logger.error("PATCH /members/:userId/band failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

export default router;
