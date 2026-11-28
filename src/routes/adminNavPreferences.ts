// apps/backend/src/routes/adminNavPreferences.ts
//
// /api/admin/nav-preferences — set / clear / read a person's visible Header
// groups (User.visibleNavGroups). A DISPLAY preference: nothing here, and
// nothing that reads the field, is a permission check.
//
// SUPERADMIN only, via middleware/isSuperAdmin (the session's real roles;
// refused while impersonating a demo user). Every change is audit-logged by
// services/navPreference.service.ts.
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin.js";
import NavPreferenceAudit from "../models/NavPreferenceAudit.js";
import { NAV_GROUP_KEYS } from "../config/navGroups.js";
import { getVisibleNavGroups, setVisibleNavGroups } from "../services/navPreference.service.js";

const router = express.Router();
router.use(requireAuth as any, requireSuperAdmin as any);

/** The allowed keys (for a future UI). */
router.get("/keys", (_req, res) => {
  res.json({ keys: NAV_GROUP_KEYS });
});

/** Current value + the last 20 audit rows. */
router.get("/:userId", async (req: any, res: any, next: any) => {
  try {
    const cur = await getVisibleNavGroups(String(req.params.userId));
    if (!cur) return res.status(404).json({ error: "User not found" });
    const history = await NavPreferenceAudit.find({ userId: cur.userId })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("before after actorEmail via createdAt")
      .lean();
    res.json({ ...cur, history });
  } catch (err) {
    next(err);
  }
});

/** Body: { visibleNavGroups: string[] | null } — null or [] clears. */
router.put("/:userId", async (req: any, res: any, next: any) => {
  try {
    if (!req.body || !("visibleNavGroups" in req.body)) {
      return res.status(400).json({ error: "visibleNavGroups is required (an array of keys, or null to clear)" });
    }
    const r = await setVisibleNavGroups({
      userId: String(req.params.userId),
      value: req.body.visibleNavGroups,
      actor: { id: String(req.user?._id || req.user?.id || req.user?.sub || ""), email: req.user?.email },
      via: "api",
    });
    if ("error" in r) return res.status(r.status).json({ error: r.error });
    res.json({ userId: r.userId, email: r.email, changed: r.changed, before: r.before, visibleNavGroups: r.after });
  } catch (err) {
    next(err);
  }
});

export default router;
