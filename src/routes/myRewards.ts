// apps/backend/src/routes/myRewards.ts
//
// Plumtrips Rewards — the client's view of its loyalty points (loyalty Phase 2,
// PRD v1.1 §13). Mounted in server.ts as
//   app.use("/api/my-rewards", requireAuth, requireWorkspace,
//           requireFeature("loyaltyRewardsEnabled"), requireInvoiceAccess, myRewardsRouter)
//
//   GET /summary            balances, threshold progress, enrolment, linked entities
//   GET /pending-invoices   invoices whose points are on the way
//   GET /history?page&limit points history, newest first, client labels only
//
// The workspace switch (CustomerWorkspace config.features.loyaltyRewardsEnabled)
// controls VISIBILITY only — earning never reads it. Access is the client
// invoice pages' rule (middleware/requireInvoiceAccess.ts). Every handler is
// scoped by req.workspace.customerId alone; no route takes an account,
// customer or workspace id from the request. Logic: services/loyaltyClient.ts.
import { Router, type Request, type Response } from "express";
import { rewardsSummary, pendingInvoices, rewardsHistory } from "../services/loyaltyClient.js";
import logger from "../utils/logger.js";

const router = Router();

const customerIdOf = (req: Request) => String((req as any).workspace?.customerId ?? "");
const workspaceIdOf = (req: Request) => String((req as any).workspace?._id ?? (req as any).workspaceId ?? "");

function fail(res: Response, err: any, label: string) {
  logger.error(`[MyRewards ${label}]`, { message: err?.message });
  return res.status(500).json({ error: "Could not load your rewards" });
}

router.get("/summary", async (req, res) => {
  try {
    res.json({ ok: true, ...(await rewardsSummary(customerIdOf(req))) });
  } catch (err) { fail(res, err, "summary"); }
});

router.get("/pending-invoices", async (req, res) => {
  try {
    res.json({ ok: true, invoices: await pendingInvoices(customerIdOf(req), workspaceIdOf(req)) });
  } catch (err) { fail(res, err, "pending-invoices"); }
});

router.get("/history", async (req, res) => {
  try {
    res.json({ ok: true, ...(await rewardsHistory(customerIdOf(req), { page: Number(req.query.page), limit: Number(req.query.limit) })) });
  } catch (err) { fail(res, err, "history"); }
});

export default router;
