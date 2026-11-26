// apps/backend/src/routes/sbt.invoiceTo.ts
//
// GET /api/sbt/invoice-to/options — what the checkout's "Invoice to" block
// shows (services/sbtInvoiceTo.ts; docs/specs/sbt-to-manual-booking-spec.md §3.7).
// { enabled: false } while SBTConfig "global".invoiceToEnabled is off — the
// checkout then shows nothing new. The choice itself is validated by the
// checkout route, never trusted from here.
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { invoiceToOptions } from "../services/sbtInvoiceTo.js";

const router = express.Router();

router.get("/options", requireAuth, requireWorkspace, async (req: any, res: any) => {
  try {
    res.json({ ok: true, ...(await invoiceToOptions(req)) });
  } catch (err: any) {
    console.error("[SBT invoice-to options]", err.message);
    res.status(500).json({ error: "Could not load invoice options" });
  }
});

export default router;
