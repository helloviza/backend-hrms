import { Router } from "express";
import mongoose from "mongoose";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import User from "../models/User.js";
import MasterData from "../models/MasterData.js";
import CustomerApprovalRequest from "../models/CustomerApprovalRequest.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { requireCustomer, requireHrmsAdmin, resolveCustomerWorkspaceId, assertWorkspaceEmailAllowed } from "../middleware/customerApprovalGuard.js";
import { hashToken, signEmailActionToken, verifyEmailActionToken } from "../utils/emailActionToken.js";
import { requireTravelMode } from "../middleware/travelModeGuard.js";
import { scopedFindById } from "../middleware/scopedFindById.js";

const r = Router();

function normalizeEmail(e: string) { return String(e || "").trim().toLowerCase(); }

function hasRole(user: any, role: string) {
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  const r0 = user?.role ? [user.role] : [];
  return [...roles, ...r0].map((x) => String(x).toUpperCase()).includes(role.toUpperCase());
}

function htmlResult(title: string, msg: string) {
  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title></head><body style="font-family:system-ui;padding:24px;max-width:720px;margin:0 auto">
  <h2>${title}</h2><p>${msg}</p></body></html>`;
}

// ✅ replace with your real mailer (Nodemailer / SES / etc.)
async function sendApprovalEmail(to: string, subject: string, html: string) {
  console.log("[email] to:", to, "subject:", subject);
  // TODO: integrate your existing mailer util here
  return true;
}

/** Generate PTS-like ticket id */
function generateTicketId(prefix = "PTS") {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${y}${m}${day}-${rand}`;
}

/* ---------------- L1: submit request ----------------
POST /api/customer-approvals/submit
body: { cartItems:[], comments?:string, approverUserId?:string }
*/
r.post("/submit", requireAuth, requireWorkspace, requireCustomer, requireTravelMode("APPROVAL_FLOW", "APPROVAL_DIRECT"), async (req: any, res, next) => {
  try {
    const cartItems = Array.isArray(req.body?.cartItems) ? req.body.cartItems : [];
    const comments = String(req.body?.comments || "").trim();
    const requestedApprover = String(req.body?.approverUserId || "").trim();

    if (!cartItems.length) return res.status(400).json({ error: "cartItems[] required" });

    const workspaceId = await resolveCustomerWorkspaceId(req.user);
    if (!workspaceId) return res.status(400).json({ error: "Workspace not found for this user" });

    // enforce whitelist for requester
    const requesterEmail = normalizeEmail(req.user?.email || "");
    await assertWorkspaceEmailAllowed(workspaceId, requesterEmail);

    // determine approver:
    let approverId: string | null = null;

    if (mongoose.isValidObjectId(requestedApprover)) {
      approverId = requestedApprover;
    } else {
      const ws = await MasterData.findOne({ _id: workspaceId, type: "Business" }).lean();
      approverId = ws?.payload?.approverUserId || null;
    }

    if (!approverId || !mongoose.isValidObjectId(approverId)) {
      return res.status(400).json({ error: "No approver (L2) configured for this workspace" });
    }

    const approver: any = await User.findOne({ _id: approverId, workspaceId: req.workspaceObjectId }).lean();
    if (!approver) return res.status(404).json({ error: "Approver user not found" });

    // ensure approver belongs to same workspace
    if (String(approver.customerWorkspaceId || "") !== String(workspaceId)) {
      return res.status(400).json({ error: "Approver is not mapped to this workspace" });
    }

    const ticketId = generateTicketId("PTS");
    const doc: any = await CustomerApprovalRequest.create({
      workspaceId,
      requesterId: req.user?.sub || req.user?.id,
      approverId,
      ticketId,
      cartItems,
      comments,
      status: "pending",
      adminState: "pending",
      history: [
        {
          action: "created",
          by: req.user?.sub || req.user?.id,
          comment: comments || "",
          meta: { via: "console" },
          cartSnapshot: cartItems,
        },
      ],
    });

    // create email action tokens (separate per action)
    const basePayload = {
      rid: String(doc._id),
      aid: String(approverId),
      wid: String(workspaceId),
    };

    const wsDoc: any = await CustomerWorkspace.findOne({ customerId: String(workspaceId) }).select("config").lean();
    const tokenExpiryHours: number = wsDoc?.config?.tokenExpiryHours ?? 12;
    const tokenExpiry = `${tokenExpiryHours}h` as const;

    const approveToken = signEmailActionToken({ ...basePayload, act: "approved" }, tokenExpiry);
    const declineToken = signEmailActionToken({ ...basePayload, act: "declined" }, tokenExpiry);
    const holdToken = signEmailActionToken({ ...basePayload, act: "on_hold" }, tokenExpiry);

    const expiresAt = new Date(Date.now() + tokenExpiryHours * 60 * 60 * 1000);

    await CustomerApprovalRequest.updateOne(
      { _id: doc._id },
      {
        $set: {
          "emailActions.approveHash": hashToken(approveToken),
          "emailActions.declineHash": hashToken(declineToken),
          "emailActions.holdHash": hashToken(holdToken),
          "emailActions.expiresAt": expiresAt,
        },
      }
    );

    // email links hit backend directly (no console needed)
    const base = process.env.PUBLIC_API_BASE || "https://api.hrms.plumtrips.com/api";
    const approveUrl = `${base}/customer-approvals/email/${encodeURIComponent(approveToken)}`;
    const declineUrl = `${base}/customer-approvals/email/${encodeURIComponent(declineToken)}`;
    const holdUrl = `${base}/customer-approvals/email/${encodeURIComponent(holdToken)}`;

    const html = `
      <div style="font-family:system-ui;max-width:720px;margin:0 auto;padding:12px">
        <h2>Approval Needed: ${ticketId}</h2>
        <p>A new request is waiting for your action.</p>
        <p><b>Requester:</b> ${requesterEmail}</p>
        <p><b>Comments:</b> ${comments || "-"}</p>
        <pre style="background:#f8fafc;padding:12px;border-radius:10px;white-space:pre-wrap">${JSON.stringify(cartItems, null, 2)}</pre>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
          <a href="${approveUrl}" style="padding:10px 14px;border-radius:10px;background:#16a34a;color:#fff;text-decoration:none;font-weight:700">Approve</a>
          <a href="${holdUrl}" style="padding:10px 14px;border-radius:10px;background:#f59e0b;color:#111;text-decoration:none;font-weight:700">Put On Hold</a>
          <a href="${declineUrl}" style="padding:10px 14px;border-radius:10px;background:#dc2626;color:#fff;text-decoration:none;font-weight:700">Decline</a>
        </div>
        <p style="color:#64748b;margin-top:12px">Links expire in ${tokenExpiryHours} hours.</p>
      </div>
    `;

    await sendApprovalEmail(normalizeEmail(approver.email), `Approval Needed: ${ticketId}`, html);

    res.status(201).json({ ok: true, requestId: doc._id, ticketId });
  } catch (e) { next(e); }
});

/* ---------------- L2: inbox (console) ----------------
GET /api/customer-approvals/approver/inbox
*/
r.get("/approver/inbox", requireAuth, requireWorkspace, requireCustomer, async (req: any, res, next) => {
  try {
    if (!hasRole(req.user, "CUSTOMER_APPROVER")) {
      return res.status(403).json({ error: "Approver access required" });
    }

    const approverId = String(req.user?.sub || req.user?.id);
    const rows = await CustomerApprovalRequest.find({ approverId, status: { $in: ["pending", "on_hold"] } })
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ rows });
  } catch (e) { next(e); }
});

/* ---------------- L2: action (console) ----------------
PUT /api/customer-approvals/:id/approver/action
body: { action: "approved"|"declined"|"on_hold", comment? }
*/
r.put("/:id/approver/action", requireAuth, requireWorkspace, requireCustomer, requireTravelMode("APPROVAL_FLOW", "APPROVAL_DIRECT"), async (req: any, res, next) => {
  try {
    if (!hasRole(req.user, "CUSTOMER_APPROVER")) {
      return res.status(403).json({ error: "Approver access required" });
    }

    const action = String(req.body?.action || "").toLowerCase();
    const comment = String(req.body?.comment || "").trim();
    if (!["approved", "declined", "on_hold"].includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }

    const doc: any = await scopedFindById(CustomerApprovalRequest, req.params.id, req.workspaceObjectId);
    if (!doc) return res.status(404).json({ error: "Not found" });

    const approverId = String(req.user?.sub || req.user?.id);
    if (String(doc.approverId) !== approverId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // state rules
    const canAct =
      (doc.status === "pending" && ["approved", "declined", "on_hold"].includes(action)) ||
      (doc.status === "on_hold" && ["approved", "declined"].includes(action));

    if (!canAct) return res.status(400).json({ error: "Invalid state for action" });

    doc.status = action;
    if (action === "approved") doc.adminState = "pending";
    doc.history.push({
      action,
      by: approverId,
      comment,
      meta: { via: "console" },
      cartSnapshot: doc.cartItems,
    });

    doc.emailActions.usedVia = "console";
    await doc.save();

    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------------- EMAIL BUTTON ACTION ----------------
GET /api/customer-approvals/email/:token
*/
r.get("/email/:token", async (req: any, res, next) => {
  try {
    const token = String(req.params.token || "");
    const payload = verifyEmailActionToken(token); // { rid, aid, wid, act }

    const rid = String(payload?.rid || "");
    const aid = String(payload?.aid || "");
    const act = String(payload?.act || "");

    if (!mongoose.isValidObjectId(rid) || !mongoose.isValidObjectId(aid)) {
      return res.status(400).send(htmlResult("Invalid Link", "This approval link is invalid."));
    }

    const wid = String(payload?.wid || "");
    const doc: any = await CustomerApprovalRequest.findOne({ _id: rid, workspaceId: wid });
    if (!doc) return res.status(404).send(htmlResult("Not Found", "Request not found."));

    // single-use / anti-tamper: token hash must match one of stored hashes
    const h = hashToken(token);
    const okHash =
      h === doc.emailActions?.approveHash ||
      h === doc.emailActions?.declineHash ||
      h === doc.emailActions?.holdHash;

    if (!okHash) return res.status(400).send(htmlResult("Invalid Link", "This approval link is not recognized."));

    if (doc.emailActions?.usedAt) {
      return res.send(htmlResult("Already Processed", "This request was already acted upon."));
    }

    if (doc.emailActions?.expiresAt && new Date(doc.emailActions.expiresAt).getTime() < Date.now()) {
      return res.send(htmlResult("Link Expired", "This approval link has expired. Please approve from console."));
    }

    // ensure correct approver + correct action
    if (String(doc.approverId) !== aid) {
      return res.status(403).send(htmlResult("Forbidden", "This link is not for you."));
    }

    if (!["approved", "declined", "on_hold"].includes(act)) {
      return res.status(400).send(htmlResult("Invalid Action", "Invalid action."));
    }

    // same state rules
    const canAct =
      (doc.status === "pending" && ["approved", "declined", "on_hold"].includes(act)) ||
      (doc.status === "on_hold" && ["approved", "declined"].includes(act));

    if (!canAct) return res.send(htmlResult("Not Allowed", "This request is not in a state that can be updated."));

    doc.status = act;
    if (act === "approved") doc.adminState = "pending";

    doc.history.push({
      action: act,
      by: aid,
      comment: "Actioned via email",
      meta: { via: "email" },
      cartSnapshot: doc.cartItems,
    });

    doc.emailActions.usedAt = new Date();
    doc.emailActions.usedBy = new mongoose.Types.ObjectId(aid);
    doc.emailActions.usedVia = "email";

    await doc.save();

    const title = act === "approved" ? "Approved ✅" : act === "declined" ? "Declined ❌" : "Put On Hold ⏸️";
    return res.send(htmlResult(title, "Done. You may close this page."));
  } catch (e) {
    return res.status(400).send(htmlResult("Invalid Link", "This approval link is invalid or expired."));
  }
});

/* ---------------- ADMIN QUEUE (internal HRMS admin) ----------------
GET /api/customer-approvals/admin/approved
*/
r.get("/admin/approved", requireAuth, requireWorkspace, requireHrmsAdmin, async (req: any, res, next) => {
  try {
    const workspaceId = String(req.query.workspaceId || "").trim();
    const match: any = { status: "approved" };
    if (mongoose.isValidObjectId(workspaceId)) match.workspaceId = new mongoose.Types.ObjectId(workspaceId);

    const rows = await CustomerApprovalRequest.find(match).sort({ updatedAt: -1 }).lean();
    res.json({ rows });
  } catch (e) { next(e); }
});

/* Admin actions: assign/done/on-hold/cancel */
r.put("/admin/:id/assign", requireAuth, requireWorkspace, requireHrmsAdmin, async (req: any, res, next) => {
  try {
    const { agentType, agentName, comment } = req.body || {};
    const doc: any = await scopedFindById(CustomerApprovalRequest, req.params.id, req.workspaceObjectId);
    if (!doc) return res.status(404).json({ error: "Not found" });
    if (doc.status !== "approved") return res.status(400).json({ error: "Only approved can be assigned" });

    doc.assignedAgent = { type: agentType, name: agentName };
    doc.adminState = "assigned";
    doc.history.push({ action: "admin_assigned", by: req.user?.sub, comment: comment || "", meta: { agentType, agentName } });
    await doc.save();

    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.put("/admin/:id/done", requireAuth, requireWorkspace, requireHrmsAdmin, async (req: any, res, next) => {
  try {
    const doc: any = await scopedFindById(CustomerApprovalRequest, req.params.id, req.workspaceObjectId);
    if (!doc) return res.status(404).json({ error: "Not found" });
    doc.adminState = "done";
    doc.history.push({ action: "booking_done", by: req.user?.sub, comment: String(req.body?.comment || "") });
    await doc.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.put("/admin/:id/on-hold", requireAuth, requireWorkspace, requireHrmsAdmin, async (req: any, res, next) => {
  try {
    const doc: any = await scopedFindById(CustomerApprovalRequest, req.params.id, req.workspaceObjectId);
    if (!doc) return res.status(404).json({ error: "Not found" });
    doc.adminState = "on_hold";
    doc.history.push({ action: "admin_on_hold", by: req.user?.sub, comment: String(req.body?.comment || "") });
    await doc.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.put("/admin/:id/cancel", requireAuth, requireWorkspace, requireHrmsAdmin, async (req: any, res, next) => {
  try {
    const doc: any = await scopedFindById(CustomerApprovalRequest, req.params.id, req.workspaceObjectId);
    if (!doc) return res.status(404).json({ error: "Not found" });
    doc.adminState = "cancelled";
    doc.history.push({ action: "admin_cancelled", by: req.user?.sub, comment: String(req.body?.comment || "") });
    await doc.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
