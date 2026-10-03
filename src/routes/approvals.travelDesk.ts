// apps/backend/src/routes/approvals.travelDesk.ts
//
// Travel Desk team settings + the agent list for the Assign picker. Mounted
// at /api/approvals/travel-desk; Admin Queue WRITE+ only
// (requireApprovalsAdminWrite) — customers and Workspace Leaders get 403.
//
// Desk settings (team, mode, Account Manager first, anyone else's
// Available/Away) also need a queue scope wider than OWN — TEAM / WORKSPACE /
// ALL, or SUPERADMIN / HOUSE ADMIN oversight (canManageDesk). An OWN agent
// keeps the Assign picker and may set their OWN Available/Away.
import { Router } from "express";
import mongoose from "mongoose";
import TravelDeskSettings, { ALLOCATION_MODES, type AllocationMode } from "../models/TravelDeskSettings.js";
import { requireApprovalsAdminWrite, setNoStore, normEmail, adminQueueAccess } from "./approvals.security.js";
import { candidatePool, getSettings, teamView } from "../services/travelDesk.js";

type AnyObj = Record<string, any>;
const router = Router();
router.use(requireApprovalsAdminWrite);

/** May this caller change the desk? Queue work with a scope wider than OWN (oversight counts). */
async function canManageDesk(req: AnyObj): Promise<boolean> {
  const a = await adminQueueAccess(req);
  return a.work && a.scope === "all";
}

function refuseDesk(res: any) {
  return res.status(403).json({ error: "Travel Desk settings need Admin Queue with Team or All scope", code: "DESK_SCOPE_REQUIRED" });
}

async function requireDeskManager(req: AnyObj, res: any, next: any) {
  try {
    if (await canManageDesk(req)) return next();
    return refuseDesk(res);
  } catch (err) {
    next(err);
  }
}

async function settingsPayload() {
  const settings = await getSettings();
  const [agents, candidates] = await Promise.all([teamView(settings), candidatePool()]);
  return { mode: settings.mode, rmFirst: settings.rmFirst, agents, candidates };
}

/** Settings page: mode, RM-first, the team (with load + eligibility) and who can be added. */
router.get("/settings", requireDeskManager, async (_req, res, next) => {
  try {
    setNoStore(res);
    res.json({ ok: true, ...(await settingsPayload()) });
  } catch (err) {
    next(err);
  }
});

/** Replace mode / RM-first / the team. Every agent must be in the candidate pool. */
router.put("/settings", requireDeskManager, async (req: AnyObj, res, next) => {
  try {
    const body = req.body || {};
    const set: AnyObj = { updatedByEmail: normEmail(req.user?.email) };

    if (body.mode !== undefined) {
      if (!ALLOCATION_MODES.includes(body.mode)) return res.status(400).json({ error: "Invalid allocation mode", code: "INVALID_MODE" });
      set.mode = body.mode as AllocationMode;
    }
    if (body.rmFirst !== undefined) set.rmFirst = body.rmFirst === true;

    if (body.agents !== undefined) {
      if (!Array.isArray(body.agents)) return res.status(400).json({ error: "agents must be a list", code: "INVALID_AGENTS" });
      const pool = new Set((await candidatePool()).map((p) => p.userId));
      const seen = new Set<string>();
      const agents: AnyObj[] = [];
      for (const a of body.agents) {
        const id = String(a?.userId || "");
        if (!mongoose.isValidObjectId(id) || !pool.has(id)) {
          return res.status(400).json({ error: "Only Plumtrips ops staff can be Travel Desk agents", code: "NOT_ELIGIBLE", userId: id });
        }
        if (seen.has(id)) continue;
        seen.add(id);
        agents.push({ userId: new mongoose.Types.ObjectId(id), available: a?.available !== false });
      }
      set.agents = agents;
    }

    await TravelDeskSettings.updateOne({ key: "default" }, { $set: set, $setOnInsert: { key: "default" } }, { upsert: true });
    setNoStore(res);
    res.json({ ok: true, ...(await settingsPayload()) });
  } catch (err) {
    next(err);
  }
});

/** Quick Available / Away toggle for one agent already on the team. */
router.patch("/agents/:userId", async (req: AnyObj, res, next) => {
  try {
    const id = String(req.params.userId || "");
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid user id" });
    if (typeof req.body?.available !== "boolean") return res.status(400).json({ error: "available must be true or false" });
    // Their own toggle is always allowed; anyone else's is a desk setting.
    const self = String(req.user?.sub || req.user?._id || req.user?.id || "");
    if (id !== self && !(await canManageDesk(req))) return refuseDesk(res);
    const r = await TravelDeskSettings.updateOne(
      { key: "default", "agents.userId": new mongoose.Types.ObjectId(id) },
      { $set: { "agents.$.available": req.body.available, updatedByEmail: normEmail(req.user?.email) } },
    );
    if (!r.matchedCount) return res.status(404).json({ error: "Not a Travel Desk agent", code: "NOT_TEAM_AGENT" });
    setNoStore(res);
    res.json({ ok: true, agents: await teamView() });
  } catch (err) {
    next(err);
  }
});

/** The Assign picker: team agents only (eligible ones), with open-case count and Away flag. */
router.get("/agents", async (_req, res, next) => {
  try {
    setNoStore(res);
    res.json({ ok: true, agents: (await teamView()).filter((a) => a.eligible) });
  } catch (err) {
    next(err);
  }
});

export default router;
