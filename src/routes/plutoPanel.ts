// apps/backend/src/routes/plutoPanel.ts
//
// GET  /api/v1/pluto/panel/city — resolves "the user's city" for Pluto's
//      right panel ("For you in <city>" / "Get inspired"). See
//      services/panelCity.service.ts for the resolution order and the
//      2026-08-06 coverage investigation behind it. Reports its own source
//      rather than ever defaulting to a fixed city.
// POST /api/v1/pluto/panel/city — the inline "Where are you based?" prompt's
//      write-back, for the ~60% of users none of the other three sources
//      resolve.

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { resolvePanelCity, setUserCity } from "../services/panelCity.service.js";

const router = Router();
router.use(requireAuth);

router.get("/city", async (req: any, res) => {
  try {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) return res.json({ ok: true, city: null, source: null });

    const result = await resolvePanelCity(userId);
    return res.json({ ok: true, ...result });
  } catch {
    // Never fail the panel: city resolution is an enhancement, never a gate.
    return res.json({ ok: true, city: null, source: null });
  }
});

router.post("/city", async (req: any, res) => {
  try {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const raw = String(req.body?.city || "").trim();
    if (!raw || raw.length < 2 || raw.length > 80) {
      return res.status(400).json({ ok: false, error: "Enter a valid city name" });
    }

    const city = await setUserCity(userId, raw);
    return res.json({ ok: true, city, source: "user" });
  } catch {
    return res.status(500).json({ ok: false, error: "Could not save city" });
  }
});

export default router;
