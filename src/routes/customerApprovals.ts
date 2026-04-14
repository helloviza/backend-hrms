import { Router } from "express";
import mongoose from "mongoose";
import requireAuth from "../middleware/auth.js";
import { sendMail } from "../utils/mailer.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import User from "../models/User.js";
import MasterData from "../models/MasterData.js";
import CustomerApprovalRequest from "../models/CustomerApprovalRequest.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { requireCustomer, requireHrmsAdmin, resolveCustomerWorkspaceId, assertWorkspaceEmailAllowed } from "../middleware/customerApprovalGuard.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { hashToken, signEmailActionToken, verifyEmailActionToken } from "../utils/emailActionToken.js";
import { requireTravelMode } from "../middleware/travelModeGuard.js";
import { scopedFindById } from "../middleware/scopedFindById.js";

/* -------- Email template helpers -------- */

function detailRow(label: string, value: string): string {
  return `
    <tr>
      <td width="120" style="color:#9ca3af;font-size:12px;padding:2px 0;vertical-align:top;">${label}</td>
      <td style="color:#374151;font-size:12px;font-weight:500;padding:2px 0;">${value}</td>
    </tr>`;
}

function fmt(v: any): string {
  return v !== undefined && v !== null && String(v).trim() !== "" ? String(v).trim() : "";
}

function fmtFare(v: any): string {
  const n = Number(v);
  if (!v || !Number.isFinite(n)) return "";
  return `₹${n.toLocaleString("en-IN")}`;
}

function buildItemsHtml(cartItems: any[]): string {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return `<p style="color:#9ca3af;font-size:13px;">No items in cart.</p>`;
  }

  return cartItems.map((item) => {
    const type = fmt(item?.type || item?.itemType || "").toUpperCase();
    const isHotel = type === "HOTEL" || (!!(item?.hotelName || item?.propertyName) && !item?.origin);

    if (isHotel) {
      const propertyName = fmt(item?.hotelName || item?.propertyName);
      const checkIn = fmt(item?.checkIn || item?.checkInDate);
      const checkOut = fmt(item?.checkOut || item?.checkOutDate);
      const rooms = fmt(item?.rooms || item?.roomCount);
      const guests = fmt(item?.guests || item?.guestCount || item?.adults);
      const fare = fmtFare(item?.fare || item?.amount || item?.totalFare);

      return `
<table width="100%" cellpadding="0" cellspacing="0"
  style="background:#f4f5f7;border-radius:10px;margin-bottom:12px;overflow:hidden;">
  <tr>
    <td style="padding:16px 20px;">
      <div style="font-size:18px;font-weight:700;color:#111827;letter-spacing:-0.3px;margin-bottom:4px;">
        ${propertyName || "Hotel"}
      </div>
      <div style="color:#6b7280;font-size:12px;margin-bottom:12px;">
        ${[rooms ? rooms + " Room(s)" : "", guests ? guests + " Guest(s)" : ""].filter(Boolean).join(" · ")}
      </div>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${checkIn ? detailRow("Check-In", checkIn) : ""}
        ${checkOut ? detailRow("Check-Out", checkOut) : ""}
        ${fare ? detailRow("Fare", fare) : ""}
      </table>
    </td>
    <td width="80" align="right" valign="top" style="padding:16px 20px 0 0;">
      <div style="background:#fef3c7;color:#92400e;font-size:11px;font-weight:600;padding:4px 10px;border-radius:20px;display:inline-block;">
        HOTEL
      </div>
    </td>
  </tr>
</table>`;
    }

    // Default: FLIGHT
    const origin = fmt(item?.origin || item?.from);
    const destination = fmt(item?.destination || item?.to);
    const departDate = fmt(item?.departDate || item?.travelDate);
    const tripType = fmt(item?.tripType || "");
    const cabinClass = fmt(item?.cabinClass || item?.cabin || "");
    const adults = fmt(item?.adults || item?.passengers?.adults || "");

    const travellers = Array.isArray(item?.travellers)
      ? item.travellers
          .map((t: any) => [fmt(t?.firstName || t?.first_name), fmt(t?.lastName || t?.last_name)].filter(Boolean).join(" "))
          .filter(Boolean)
          .join(", ")
      : "";

    const fare = fmtFare(item?.fare || item?.amount || item?.totalFare);

    const meta = [tripType, cabinClass, adults ? adults + " Adult(s)" : ""].filter(Boolean).join(" · ");

    return `
<table width="100%" cellpadding="0" cellspacing="0"
  style="background:#f4f5f7;border-radius:10px;margin-bottom:12px;overflow:hidden;">
  <tr>
    <td style="padding:16px 20px;">
      <div style="font-size:18px;font-weight:700;color:#111827;letter-spacing:-0.3px;margin-bottom:4px;">
        ${origin || "?"} → ${destination || "?"}
      </div>
      ${meta ? `<div style="color:#6b7280;font-size:12px;margin-bottom:12px;">${meta}</div>` : ""}
      <table width="100%" cellpadding="0" cellspacing="0">
        ${departDate ? detailRow("Depart Date", departDate) : ""}
        ${travellers ? detailRow("Travellers", travellers) : ""}
        ${fare ? detailRow("Fare", fare) : ""}
      </table>
    </td>
    <td width="80" align="right" valign="top" style="padding:16px 20px 0 0;">
      <div style="background:#eef2ff;color:#4f46e5;font-size:11px;font-weight:600;padding:4px 10px;border-radius:20px;display:inline-block;">
        FLIGHT
      </div>
    </td>
  </tr>
</table>`;
  }).join("");
}

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

async function sendApprovalEmail(to: string, subject: string, html: string) {
  return sendMail({ to, subject, html, kind: "APPROVALS" });
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

    const requestId = String(doc._id);
    const itemsHtml = buildItemsHtml(cartItems);

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <title>Approval Needed</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:40px 20px;">
    <tr><td align="center">

      <table width="600" cellpadding="0" cellspacing="0"
        style="background:#ffffff;border-radius:16px;border:1px solid #e5e7eb;overflow:hidden;max-width:600px;width:100%;">

        <!-- HEADER BAND -->
        <tr>
          <td style="background:#4f46e5;padding:28px 36px;">
            <div style="color:#ffffff;font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;">
              Plumtrips · AI Travel Ops
            </div>
            <div style="color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">
              Approval Needed
            </div>
            <div style="color:#a5b4fc;font-size:13px;margin-top:6px;">
              Review the request below and take action.
            </div>
          </td>
        </tr>

        <!-- BODY -->
        <tr>
          <td style="padding:32px 36px;">

            <!-- Meta row -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
              <tr>
                <td style="background:#f4f5f7;border-radius:10px;padding:16px 20px;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td width="50%" style="padding:4px 0;">
                        <div style="color:#9ca3af;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px;">Ticket ID</div>
                        <div style="color:#111827;font-size:13px;font-weight:600;font-family:monospace;">${ticketId}</div>
                      </td>
                      <td width="50%" style="padding:4px 0;">
                        <div style="color:#9ca3af;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px;">Requested By</div>
                        <div style="color:#111827;font-size:13px;font-weight:600;">${requesterEmail}</div>
                      </td>
                    </tr>
                    ${comments ? `
                    <tr>
                      <td colspan="2" style="padding-top:12px;border-top:1px solid #e5e7eb;">
                        <div style="color:#9ca3af;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px;">Note</div>
                        <div style="color:#374151;font-size:13px;">${comments}</div>
                      </td>
                    </tr>` : ""}
                  </table>
                </td>
              </tr>
            </table>

            <!-- TRIP SNAPSHOT HEADER -->
            <div style="color:#9ca3af;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px;">
              Trip / Service Snapshot
            </div>

            ${itemsHtml}

            <!-- DIVIDER -->
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;">

            <!-- ACTION BUTTONS -->
            <div style="color:#9ca3af;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:16px;">
              Your Action
            </div>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:10px;">
                  <a href="${approveUrl}"
                    style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;">
                    &#10003; Approve
                  </a>
                </td>
                <td style="padding-right:10px;">
                  <a href="${declineUrl}"
                    style="display:inline-block;background:#ffffff;color:#dc2626;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;border:1.5px solid #fca5a5;">
                    &#10005; Reject
                  </a>
                </td>
                <td>
                  <a href="${holdUrl}"
                    style="display:inline-block;background:#ffffff;color:#92400e;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;border:1.5px solid #fcd34d;">
                    &#9646; On Hold
                  </a>
                </td>
              </tr>
            </table>

            <div style="color:#9ca3af;font-size:12px;margin-top:16px;">
              These links expire in ${tokenExpiryHours} hours. Do not forward this email.
            </div>

          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 36px;">
            <div style="color:#9ca3af;font-size:12px;">
              Request ID: ${requestId} &middot; You&rsquo;re receiving this because you&rsquo;re listed as an approver for a Plumtrips workspace.
            </div>
          </td>
        </tr>

      </table>

    </td></tr>
  </table>

</body>
</html>`;

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
    const rows = await CustomerApprovalRequest.find({ approverId, status: { $in: ["pending", "on_hold"] }, workspaceId: req.workspaceObjectId })
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
    const match: any = { status: "approved", workspaceId: req.workspaceObjectId };

    const rows = await CustomerApprovalRequest.find(match).sort({ updatedAt: -1 }).lean();
    res.json({ rows });
  } catch (e) { next(e); }
});

/* Admin actions: assign/done/on-hold/cancel */
r.put("/admin/:id/assign", requireAuth, requireWorkspace, requireHrmsAdmin, async (req: any, res, next) => {
  try {
    const { agentType, agentName, comment } = req.body || {};
    const doc: any = isSuperAdmin(req)
      ? await CustomerApprovalRequest.findById(req.params.id)
      : await scopedFindById(CustomerApprovalRequest, req.params.id, req.workspaceObjectId);
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
    const doc: any = isSuperAdmin(req)
      ? await CustomerApprovalRequest.findById(req.params.id)
      : await scopedFindById(CustomerApprovalRequest, req.params.id, req.workspaceObjectId);
    if (!doc) return res.status(404).json({ error: "Not found" });
    doc.adminState = "done";
    doc.history.push({ action: "booking_done", by: req.user?.sub, comment: String(req.body?.comment || "") });
    await doc.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.put("/admin/:id/on-hold", requireAuth, requireWorkspace, requireHrmsAdmin, async (req: any, res, next) => {
  try {
    const doc: any = isSuperAdmin(req)
      ? await CustomerApprovalRequest.findById(req.params.id)
      : await scopedFindById(CustomerApprovalRequest, req.params.id, req.workspaceObjectId);
    if (!doc) return res.status(404).json({ error: "Not found" });
    doc.adminState = "on_hold";
    doc.history.push({ action: "admin_on_hold", by: req.user?.sub, comment: String(req.body?.comment || "") });
    await doc.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.put("/admin/:id/cancel", requireAuth, requireWorkspace, requireHrmsAdmin, async (req: any, res, next) => {
  try {
    const doc: any = isSuperAdmin(req)
      ? await CustomerApprovalRequest.findById(req.params.id)
      : await scopedFindById(CustomerApprovalRequest, req.params.id, req.workspaceObjectId);
    if (!doc) return res.status(404).json({ error: "Not found" });
    doc.adminState = "cancelled";
    doc.history.push({ action: "admin_cancelled", by: req.user?.sub, comment: String(req.body?.comment || "") });
    await doc.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
