// apps/backend/src/routes/admin.businessMsa.ts
//
// GET /api/admin/businesses/:id/msa.docx — the MSA Word template pre-filled
// with the business's identity fields (services/msaDocx.ts). :id is the
// Customer._id that /profile/businesses lists (GET /api/customers).
//
// Same gate as that page: Plumtrips staff (HOUSE workspace) or SUPERADMIN,
// with an admin/HR role. Staff see every customer, wherever the row is stored.
import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { requireHouse } from "../middleware/requireHouse.js";
import { requireAdmin } from "../middleware/rbac.js";
import Customer from "../models/Customer.js";
import Onboarding from "../models/Onboarding.js";
import { buildMsaValues, renderMsaDocx, msaFilename } from "../services/msaDocx.js";

const router = Router();

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function nonEmpty(v: any): any {
  return v && typeof v === "object" && Object.keys(v).length > 0 ? v : null;
}

router.get(
  "/:id/msa.docx",
  requireAuth,
  requireWorkspace,
  requireHouse,
  requireAdmin,
  async (req: any, res, next) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(404).json({ error: "Business not found" });
      }
      const customer: any = await Customer.findOne({ _id: id }).lean().exec();
      if (!customer) return res.status(404).json({ error: "Business not found" });

      let formPayload: any = null;
      if (customer.onboardingId) {
        const ob: any = await Onboarding.findOne({ _id: customer.onboardingId })
          .select("formPayload extras_json")
          .lean()
          .exec();
        formPayload = nonEmpty(ob?.formPayload) || nonEmpty(ob?.extras_json);
      }
      formPayload ||= nonEmpty(customer.onboardingSnapshot) || {};

      const values = buildMsaValues(customer, formPayload);
      const buf = renderMsaDocx(values);
      const filename = msaFilename(values.client_name || customer.name || "");

      const actorId = String(req.user?.sub || req.user?._id || req.user?.id || "");
      const actorEmail = String(req.user?.email || "");
      try {
        await mongoose.connection.collection("workspaceauditlogs").insertOne({
          workspaceId: String(req.workspaceId || ""),
          event: "MSA_DOWNLOADED",
          runAt: new Date(),
          triggeredBy: actorEmail || actorId,
          status: "SUCCESS",
          details: { actorId, actorEmail: actorEmail || null, customerId: String(customer._id), filename },
        });
      } catch (err) {
        // Never block the download on the audit write, but make it loud.
        console.error("[msa] failed to write download audit record", err);
      }
      console.log(`[msa] ${actorEmail || actorId} downloaded MSA for customer ${customer._id}`);

      res.setHeader("Content-Type", DOCX_MIME);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Cache-Control", "no-store");
      return res.send(buf);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
