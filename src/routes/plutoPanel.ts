// apps/backend/src/routes/plutoPanel.ts
//
// GET /api/v1/pluto/panel/city — resolves "the user's city" for Pluto's right
// panel ("For you in <city>" / "Get inspired"). Reports its own source rather
// than ever defaulting to a fixed city: most users — especially internal
// staff — have neither field populated, and a silent Bengaluru fallback would
// show every one of them someone else's city.
//
// Resolution order:
//   1. User.address.city       — set on some accounts via the old address
//                                 block (HRMS employee profile).
//   2. CustomerWorkspace.address.city — the company's registered address,
//                                 for customer/business accounts without
//                                 their own address.city.
//   3. null — reported as such; the caller must not render the two
//      city-scoped sections rather than guess.

import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const router = Router();
router.use(requireAuth);

router.get("/city", async (req: any, res) => {
  try {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) return res.json({ ok: true, city: null, source: null });

    const user = await User.findById(userId).select("address workspaceId").lean();
    const userCity = (user as any)?.address?.city?.trim();
    if (userCity) return res.json({ ok: true, city: userCity, source: "user" });

    const workspaceId = (user as any)?.workspaceId;
    if (workspaceId) {
      const ws = await CustomerWorkspace.findById(workspaceId).select("address").lean();
      const wsCity = (ws as any)?.address?.city?.trim();
      if (wsCity) return res.json({ ok: true, city: wsCity, source: "workspace" });
    }

    return res.json({ ok: true, city: null, source: null });
  } catch {
    // Never fail the panel: city resolution is an enhancement, never a gate.
    return res.json({ ok: true, city: null, source: null });
  }
});

export default router;
