// apps/backend/src/routes/partner.cases.ts
//
// The partner's tracker of the leads it sent through its partner links,
// mounted at /api/partner/cases behind requireAuth + requireWorkspace
// (server.ts).
//
//   GET /                the session workspace's partner cases + counts
//   GET /:caseNumber     one of them
//
// Gate: the workspace's own config.features.partnerCasesEnabled (default
// off, Workspace Manager toggle only), then the client billing rule
// (requireInvoiceAccess: Workspace Leader, or canViewBilling).
//
// Scope: the SESSION workspace only, in both id spaces, and partner cases
// only — { workspaceId: CW._id, customerId: ws.customerId, meta.source:
// PARTNER_LINK }; bookings by { workspaceId: that Customer._id, ADMIN_QUEUE,
// sourceBookingId ∈ those cases }. A case outside it is the same 404 as one
// that doesn't exist. Rows are built by services/partnerLeadTracker.ts
// (partnerCaseRow: the tracker row + its done / dropped outcome) from an
// allowlist; nothing is spread from a document, and staff admins get the same
// shape as anyone else.
import { Router, type Request, type Response, type NextFunction } from "express";
import ApprovalRequest from "../models/ApprovalRequest.js";
import { requireInvoiceAccess } from "../middleware/requireInvoiceAccess.js";
import { bookingsOfCases } from "../services/partnerLeadBooking.js";
import { PARTNER_LINK_SOURCE } from "../services/partnerLeadCase.js";
import { TRACKER_CASE_FIELDS, partnerCaseRow, trackerCounts } from "../services/partnerLeadTracker.js";

const router = Router();

function requirePartnerCasesView(req: Request, res: Response, next: NextFunction) {
  const ws = (req as any).workspace;
  if (!ws || String(ws.status || "ACTIVE") !== "ACTIVE" || ws.config?.features?.partnerCasesEnabled !== true) {
    res.status(403).json({ error: "Feature 'partnerCasesEnabled' not enabled for this workspace" });
    return;
  }
  next();
}

router.use(requirePartnerCasesView);
router.use(requireInvoiceAccess);

function scope(req: any) {
  return {
    workspaceId: req.workspaceObjectId || req.workspace?._id,
    customerId: String(req.workspace?.customerId || ""),
    "meta.source": PARTNER_LINK_SOURCE,
  };
}

async function rowsFor(req: any, cases: any[]) {
  const customerId = String(req.workspace?.customerId || "");
  const bookings = await bookingsOfCases(customerId, cases.map((c) => c._id));
  const byCase = new Map<string, any[]>();
  for (const b of bookings) {
    const k = String(b.sourceBookingId);
    byCase.set(k, [...(byCase.get(k) || []), b]);
  }
  return cases.map((c) => partnerCaseRow(c, byCase.get(String(c._id)) || []));
}

router.get("/", async (req: any, res) => {
  try {
    const s = scope(req);
    if (!s.workspaceId || !s.customerId) return res.json({ ok: true, counts: trackerCounts([]), cases: [] });
    const cases: any[] = await ApprovalRequest.find(s).select(TRACKER_CASE_FIELDS).sort({ createdAt: -1 }).limit(2000).lean();
    const rows = await rowsFor(req, cases);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, counts: trackerCounts(rows), cases: rows });
  } catch (err: any) {
    console.error("[partner.cases] list failed", err?.message || err);
    res.status(500).json({ error: "Failed to load cases" });
  }
});

router.get("/:caseNumber", async (req: any, res) => {
  try {
    const caseNumber = String(req.params.caseNumber || "").trim().toUpperCase();
    const s = scope(req);
    if (!/^PL-[A-Z0-9]{6}$/.test(caseNumber) || !s.workspaceId || !s.customerId) return res.status(404).json({ error: "Case not found" });
    const c: any = await ApprovalRequest.findOne({ ...s, "meta.partnerLead.caseNumber": caseNumber }).select(TRACKER_CASE_FIELDS).lean();
    if (!c) return res.status(404).json({ error: "Case not found" });
    const [row] = await rowsFor(req, [c]);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, case: row });
  } catch (err: any) {
    console.error("[partner.cases] detail failed", err?.message || err);
    res.status(500).json({ error: "Failed to load the case" });
  }
});

export default router;
