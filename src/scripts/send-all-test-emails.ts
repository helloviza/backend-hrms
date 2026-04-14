// apps/backend/src/scripts/send-all-test-emails.ts
// Sends all 4 email types to a test recipient, using real docs from DB.

import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { sendMail } from "../utils/mailer.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import CustomerApprovalRequest from "../models/CustomerApprovalRequest.js";
import Proposal from "../models/Proposal.js";
import User from "../models/User.js";
import {
  buildApproverEmailHtml,
  buildAdminProcessedEmailHtml,
  buildEmailShell,
  eBtn,
  escapeHtml,
  moneyINR,
} from "../routes/approvals.email.js";

const TEST_RECIPIENT = "salescynosurechannel@gmail.com";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureArray<T = any>(v: any): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v == null) return [];
  return [v] as T[];
}

/* ── 1. SBT Request email (inline HTML from customerApprovals.ts) ─────────── */
async function sendSbtRequestEmail(doc: any) {
  const ticketId = String(doc.ticketId || doc._id);
  const requesterEmail = String(doc.requesterEmail || "");
  const cartItems = Array.isArray(doc.cartItems) ? doc.cartItems : [];
  const comments = String(doc.comments || "");
  const requestId = String(doc._id);

  // Minimal item cards
  function detailRow(label: string, value: string): string {
    return `<tr>
      <td width="120" style="color:#9ca3af;font-size:12px;padding:2px 0;vertical-align:top;">${label}</td>
      <td style="color:#374151;font-size:12px;font-weight:500;padding:2px 0;">${value}</td>
    </tr>`;
  }

  function buildItemsHtml(items: any[]): string {
    if (!items.length) return `<p style="color:#9ca3af;font-size:13px;">No items in cart.</p>`;
    return items
      .map((item) => {
        const type = String(item?.type || item?.itemType || "").toUpperCase();
        const isHotel =
          type === "HOTEL" || (!!(item?.hotelName || item?.propertyName) && !item?.origin);
        if (isHotel) {
          const name = String(item?.hotelName || item?.propertyName || "Hotel");
          return `<table width="100%" cellpadding="0" cellspacing="0"
            style="background:#f4f5f7;border-radius:10px;margin-bottom:12px;">
            <tr><td style="padding:16px 20px;">
              <div style="font-size:16px;font-weight:700;color:#111827;">${name}</div>
              <table width="100%" cellpadding="0" cellspacing="0">
                ${item?.checkIn ? detailRow("Check-In", String(item.checkIn)) : ""}
                ${item?.checkOut ? detailRow("Check-Out", String(item.checkOut)) : ""}
              </table>
            </td></tr>
          </table>`;
        }
        const origin = String(item?.origin || item?.from || "?");
        const dest = String(item?.destination || item?.to || "?");
        return `<table width="100%" cellpadding="0" cellspacing="0"
          style="background:#f4f5f7;border-radius:10px;margin-bottom:12px;">
          <tr><td style="padding:16px 20px;">
            <div style="font-size:18px;font-weight:700;color:#111827;">${origin} → ${dest}</div>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${item?.departDate ? detailRow("Depart Date", String(item.departDate)) : ""}
            </table>
          </td></tr>
        </table>`;
      })
      .join("");
  }

  const approveUrl = "https://api.hrms.plumtrips.com/api/customer-approvals/email/TEST_TOKEN_APPROVE";
  const declineUrl = "https://api.hrms.plumtrips.com/api/customer-approvals/email/TEST_TOKEN_DECLINE";
  const holdUrl = "https://api.hrms.plumtrips.com/api/customer-approvals/email/TEST_TOKEN_HOLD";
  const tokenExpiryHours = 12;
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
        <tr>
          <td style="padding:32px 36px;">
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
                    ${comments ? `<tr><td colspan="2" style="padding-top:12px;border-top:1px solid #e5e7eb;">
                      <div style="color:#9ca3af;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px;">Note</div>
                      <div style="color:#374151;font-size:13px;">${comments}</div>
                    </td></tr>` : ""}
                  </table>
                </td>
              </tr>
            </table>
            <div style="color:#9ca3af;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px;">
              Trip / Service Snapshot
            </div>
            ${itemsHtml}
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;">
            <div style="color:#9ca3af;font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:16px;">
              Your Action
            </div>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:10px;">
                  <a href="${approveUrl}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;">&#10003; Approve</a>
                </td>
                <td style="padding-right:10px;">
                  <a href="${declineUrl}" style="display:inline-block;background:#ffffff;color:#dc2626;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;border:1.5px solid #fca5a5;">&#10005; Reject</a>
                </td>
                <td>
                  <a href="${holdUrl}" style="display:inline-block;background:#ffffff;color:#92400e;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;border:1.5px solid #fcd34d;">&#9646; On Hold</a>
                </td>
              </tr>
            </table>
            <div style="color:#9ca3af;font-size:12px;margin-top:16px;">
              These links expire in ${tokenExpiryHours} hours. Do not forward this email.
            </div>
          </td>
        </tr>
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

  return sendMail({
    kind: "APPROVALS",
    to: TEST_RECIPIENT,
    subject: `[TEST] SBT Request — ${ticketId}`,
    html,
  });
}

/* ── resolve frontliner display name — mirrors approvals.ts live lookup ─────── */
async function resolveFrontlinerName(doc: any): Promise<string> {
  let name = String(doc.frontlinerName || "").trim();
  if (!name || name === "User") {
    const dbUser: any = doc.frontlinerId
      ? await User.findById(doc.frontlinerId).select("name firstName lastName").lean()
      : doc.frontlinerEmail
        ? await User.findOne({ email: new RegExp(`^${String(doc.frontlinerEmail).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }).select("name firstName lastName").lean()
        : null;
    if (dbUser) {
      name = String(
        dbUser.name ||
        [dbUser.firstName || "", dbUser.lastName || ""].filter(Boolean).join(" ")
      ).trim();
    }
  }
  if (!name) name = String(doc.frontlinerEmail || "").split("@")[0] || "User";
  return name;
}

/* ── 2. Approval Needed email (ApprovalRequest → buildApproverEmailHtml) ──── */
async function sendApprovalNeededEmail(doc: any) {
  const requesterDisplayName = await resolveFrontlinerName(doc);
  const html = buildApproverEmailHtml({
    requestId: String(doc._id),
    requesterName: requesterDisplayName,
    requesterEmail: doc.frontlinerEmail || "",
    customerName: doc.customerName || "Workspace",
    ticketId: doc.ticketId,
    items: Array.isArray(doc.cartItems) ? doc.cartItems : [],
    comments: doc.comments,
    approveUrl: "https://example.com/approve",
    declineUrl: "https://example.com/decline",
    holdUrl: "https://example.com/hold",
  });

  return sendMail({
    kind: "REQUESTS",
    to: TEST_RECIPIENT,
    subject: `[TEST] Approval Needed — ${doc.ticketId || doc._id}`,
    html,
  });
}

/* ── 3. Booking Confirmation email (ApprovalRequest → buildAdminProcessedEmailHtml) */
async function sendBookingConfirmationEmail(doc: any) {
  const html = buildAdminProcessedEmailHtml({
    customerName: doc.customerName || "Workspace",
    ticketId: doc.ticketId,
    requesterEmail: doc.frontlinerEmail || "",
    processedByEmail: doc.managerEmail || "admin@plumtrips.com",
    processedByName: doc.managerName,
    comment: doc.adminComment || doc.comments,
    items: Array.isArray(doc.cartItems) ? doc.cartItems : [],
    bookingAmount: doc.bookingAmount,
    attachments: Array.isArray(doc.attachments) ? doc.attachments : [],
  });

  return sendMail({
    kind: "REQUESTS",
    to: TEST_RECIPIENT,
    subject: `[TEST] Booking Confirmation — ${doc.ticketId || doc._id}`,
    html,
  });
}

/* ── item label helper — mirrors proposals.ts ───────────────────────────────── */
function itemLabel(li: any): string {
  const origin = String(li?.meta?.origin || li?.from || li?.origin || "").trim();
  const dest   = String(li?.meta?.destination || li?.to || li?.destination || "").trim();
  const raw    = String(li?.meta?.tripType || li?.tripType || "").trim();
  const trip   = raw.toLowerCase() === "oneway" ? "One Way"
               : raw.toLowerCase() === "roundtrip" ? "Round Trip"
               : raw || "";
  if (origin && dest) return `${origin} → ${dest}${trip ? ` (${trip})` : ""}`;
  return String(li?.description || li?.title || li?.name || li?.category || "Travel Service");
}

/* ── 4. Proposal Approval email (Proposal → buildEmailShell + summary) ─────── */
function buildProposalSummaryHtml(p: any): string {
  const options = ensureArray(p?.options)
    .slice()
    .sort((a: any, b: any) => Number(a?.optionNo || 0) - Number(b?.optionNo || 0));

  const optBlocks = options
    .map((opt: any) => {
      const lines = ensureArray(opt?.lineItems);
      const rows = lines
        .map((li: any) => {
          const title = itemLabel(li);
          const qty = Number(li?.qty || 1);
          const unit = Number(li?.unitPrice || 0);
          const total = Number(li?.totalPrice || qty * unit || 0);
          return `<tr>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;">${title}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${qty}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${moneyINR(unit)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${moneyINR(total)}</td>
          </tr>`;
        })
        .join("");

      const attachments = ensureArray(opt?.attachments);
      const attHtml = attachments.length
        ? `<div style="color:#666;margin-top:6px;">${attachments.length} PDF attachment(s) included.</div>`
        : `<div style="color:#666;margin-top:6px;">No attachments</div>`;

      return `
        <div style="border:1px solid #eee;border-radius:10px;padding:14px;margin-top:12px;">
          <div style="font-weight:800;margin-bottom:6px;">
            Option ${String(opt?.optionNo || "")} — ${String(opt?.title || "Option")}
          </div>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr>
                <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #eee;">Item</th>
                <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #eee;">Qty</th>
                <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #eee;">Unit</th>
                <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #eee;">Total</th>
              </tr>
            </thead>
            <tbody>${rows || ""}</tbody>
          </table>
          <div style="display:flex;justify-content:space-between;margin-top:10px;">
            <div style="color:#666;">Option Total</div>
            <div style="font-weight:900;">${moneyINR(opt?.totalAmount)}</div>
          </div>
          <div style="margin-top:10px;">
            <div style="font-weight:700;">Attachments</div>
            ${attHtml}
          </div>
        </div>`;
    })
    .join("");

  return `
    <div style="font-family:Arial,sans-serif;max-width:720px;">
      <h2 style="margin:0 0 8px;">Proposal submitted for approval</h2>
      <div style="color:#666;margin-bottom:10px;">Proposal ID: <b>${String(p?._id || "")}</b></div>
      <div style="display:flex;justify-content:space-between;margin:8px 0 6px;">
        <div style="color:#666;">Grand Total</div>
        <div style="font-weight:900;">${moneyINR(p?.totalAmount)}</div>
      </div>
      ${optBlocks || `<div style="color:#666;">No options</div>`}
    </div>`;
}

async function sendProposalApprovalEmail(doc: any) {
  const approveUrl = "https://api.hrms.plumtrips.com/api/proposals/email/TEST_TOKEN_APPROVE";
  const declineUrl = "https://api.hrms.plumtrips.com/api/proposals/email/TEST_TOKEN_DECLINE";
  const holdUrl = "https://api.hrms.plumtrips.com/api/proposals/email/TEST_TOKEN_HOLD";

  const summaryHtml = buildProposalSummaryHtml(doc);

  const proposalEmailBody = `
    <div style="font-size:12px;color:#64748b;margin-bottom:14px;">
      Proposal ID: <b style="color:#0f172a;">${escapeHtml(String(doc._id || ""))}</b>
    </div>

    ${summaryHtml}

    <div style="margin-top:20px;">
      ${eBtn("✓ Approve", approveUrl, "#4f46e5", "#ffffff")}
      ${eBtn("✕ Reject", declineUrl, "#ffffff", "#dc2626", "#fca5a5")}
      ${eBtn("▮ On Hold", holdUrl, "#ffffff", "#92400e", "#fcd34d")}
    </div>

    <div style="margin-top:20px;padding:12px 14px;border-radius:14px;background:#0b1220;color:#e2e8f0;">
      <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:900;color:#94a3b8;">Security</div>
      <div style="margin-top:6px;font-size:13px;line-height:1.55;">
        Do not forward this email. Action links are intended for the assigned approver only.
      </div>
    </div>
  `;

  const html = buildEmailShell(proposalEmailBody, {
    title: "Proposal Approval Needed",
    subtitle: "Review the proposal and take action",
    badgeText: "AWAITING APPROVAL",
    badgeColor: "#f59e0b",
  });

  return sendMail({
    kind: "APPROVALS" as any,
    to: TEST_RECIPIENT,
    subject: `[TEST] Proposal Approval — ${doc._id}`,
    html,
  });
}

/* ── main ──────────────────────────────────────────────────────────────────── */
async function main() {
  await mongoose.connect(env.MONGO_URI);
  console.log("MongoDB connected\n");

  // Fetch most recent documents
  const [approvalDoc, customerApprovalDoc, proposalDoc] = await Promise.all([
    ApprovalRequest.findOne().sort({ createdAt: -1 }).lean(),
    CustomerApprovalRequest.findOne().sort({ createdAt: -1 }).lean(),
    Proposal.findOne({ 'options.0': { $exists: true }, totalAmount: { $gt: 0 } }).sort({ createdAt: -1 }).lean(),
  ]);

  if (!customerApprovalDoc) {
    console.warn("[WARN] No CustomerApprovalRequest found — skipping Email 1");
  }
  if (!approvalDoc) {
    console.warn("[WARN] No ApprovalRequest found — skipping Emails 2 & 3");
  }
  if (!proposalDoc) {
    console.warn("[WARN] No Proposal found — skipping Email 4");
  }

  // Email 1: SBT Request notification
  if (customerApprovalDoc) {
    const r1 = await sendSbtRequestEmail(customerApprovalDoc);
    console.log(`[✓] SBT Request email sent → ${TEST_RECIPIENT}  (messageId: ${(r1 as any)?.messageId || "n/a"})`);
    await sleep(2000);
  }

  // Email 2: Approval Needed (approver email)
  if (approvalDoc) {
    const r2 = await sendApprovalNeededEmail(approvalDoc);
    console.log(`[✓] Approval email sent → ${TEST_RECIPIENT}  (messageId: ${(r2 as any)?.messageId || "n/a"})`);
    await sleep(2000);
  }

  // Email 3: Booking Confirmation (admin processed email)
  if (approvalDoc) {
    const r3 = await sendBookingConfirmationEmail(approvalDoc);
    console.log(`[✓] Booking Confirmation sent → ${TEST_RECIPIENT}  (messageId: ${(r3 as any)?.messageId || "n/a"})`);
    await sleep(2000);
  }

  // Email 4: Proposal Approval
  if (proposalDoc) {
    const proposalCreator = (proposalDoc as any).createdBy
      ? await User.findById((proposalDoc as any).createdBy).select("firstName lastName name email").lean()
      : null;
    const proposalRequesterName =
      (proposalCreator as any)?.name ||
      [(proposalCreator as any)?.firstName, (proposalCreator as any)?.lastName].filter(Boolean).join(" ") ||
      (proposalDoc as any).requesterName ||
      "Unknown";
    console.log("[PROPOSAL REQUESTER]", proposalRequesterName);

    const r4 = await sendProposalApprovalEmail(proposalDoc);
    console.log(`[✓] Proposal Approval sent → ${TEST_RECIPIENT}  (messageId: ${(r4 as any)?.messageId || "n/a"})`);
  }

  await mongoose.disconnect();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
