/* eslint-disable no-console */
// apps/backend/src/scripts/send-approval-email-test.ts

import { sendMail } from "../utils/mailer.js";
import { signEmailActionToken } from "../utils/emailActionToken.js";

function env(name: string, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function normEmail(v: any) {
  return String(v ?? "").trim().toLowerCase();
}

function envBool(v: any, def = false) {
  if (v === undefined || v === null) return def;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
}

function money(n: any) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  return `₹${x.toLocaleString("en-IN")}`;
}

function publicBaseUrl() {
  return (
    env("PUBLIC_BASE_URL") ||
    env("BACKEND_PUBLIC_URL") ||
    `http://localhost:${env("PORT", "8080")}`
  ).replace(/\/+$/, "");
}

function frontendBaseUrl() {
  const fromPublic = env("FRONTEND_PUBLIC_URL");
  if (fromPublic) return fromPublic.replace(/\/+$/, "");
  const csv = env("FRONTEND_ORIGIN");
  const list = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return (list[0] || "http://localhost:5173").replace(/\/+$/, "");
}

/**
 * Backend click endpoint that triggers action server-side.
 * We'll add this route in approvals.ts (next section).
 */
function emailBackendActionPath() {
  const p = env("EMAIL_APPROVAL_BACKEND_PATH", "/api/approvals/email/action");
  return p.startsWith("/") ? p : `/${p}`;
}

function buildBackendActionUrl(token: string, action: "approved" | "declined" | "on_hold") {
  const base = publicBaseUrl();
  const path = emailBackendActionPath();
  return `${base}${path}?t=${encodeURIComponent(token)}&a=${encodeURIComponent(action)}`;
}

function buildEmailHtml(opts: {
  brand: string;
  customerName: string;
  ticketId?: string;
  requesterName: string;
  requesterEmail: string;
  items: Array<{ title: string; description?: string; qty?: number; price?: number }>;
  comments?: string;
  approveUrl: string;
  declineUrl: string;
  holdUrl: string;
  viewUrl?: string;
}) {
  const items = Array.isArray(opts.items) ? opts.items : [];
  const total = items.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 1), 0);

  const rows = items
    .map((it) => {
      const title = String(it.title || "Item");
      const desc = String(it.description || "");
      const qty = Number(it.qty || 1);
      const price = Number(it.price || 0);
      return `
        <tr>
          <td style="padding:12px 14px;border-top:1px solid #eef2ff;">
            <div style="font-size:14px;font-weight:700;color:#0b1220;">${title}</div>
            ${
              desc
                ? `<div style="margin-top:4px;font-size:12px;color:#667085;">${desc}</div>`
                : ""
            }
          </td>
          <td align="center" style="padding:12px 10px;border-top:1px solid #eef2ff;color:#111827;font-size:13px;">
            ${Number.isFinite(qty) ? qty : 1}
          </td>
          <td align="right" style="padding:12px 14px;border-top:1px solid #eef2ff;color:#111827;font-size:13px;font-weight:700;">
            ${money(price)}
          </td>
        </tr>
      `;
    })
    .join("");

  // Email-safe layout (tables + inline styles) for Gmail/Outlook
  return `
  <div style="background:#0b1220;margin:0;padding:0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b1220;padding:22px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="620" cellspacing="0" cellpadding="0" style="width:620px;max-width:620px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.25);">
            <tr>
              <td style="padding:18px 22px;background:linear-gradient(90deg,#00477f,#0b6aa7,#d06549);">
                <div style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.9);">
                  ${opts.brand}
                </div>
                <div style="font-family:Arial,sans-serif;font-size:22px;font-weight:800;color:#ffffff;margin-top:6px;">
                  Approval Required
                </div>
                <div style="font-family:Arial,sans-serif;font-size:13px;color:rgba(255,255,255,.92);margin-top:6px;">
                  Review the request and take action in one click.
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 22px;font-family:Arial,sans-serif;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;border:1px solid #eef2ff;border-radius:14px;">
                  <tr>
                    <td style="padding:14px 14px;">
                      <div style="font-size:12px;color:#667085;">Customer / Workspace</div>
                      <div style="font-size:14px;font-weight:800;color:#0b1220;margin-top:2px;">
                        ${opts.customerName || "Workspace"}
                      </div>
                    </td>
                    <td style="padding:14px 14px;">
                      <div style="font-size:12px;color:#667085;">Ticket</div>
                      <div style="font-size:14px;font-weight:800;color:#0b1220;margin-top:2px;">
                        ${opts.ticketId || "—"}
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td colspan="2" style="padding:0 14px 14px;">
                      <div style="font-size:12px;color:#667085;">Requested by</div>
                      <div style="font-size:14px;font-weight:700;color:#0b1220;margin-top:2px;">
                        ${opts.requesterName || "User"} &nbsp;
                        <span style="font-weight:600;color:#475467;">(${opts.requesterEmail})</span>
                      </div>
                      ${
                        opts.comments
                          ? `<div style="margin-top:10px;font-size:13px;color:#344054;line-height:1.45;">
                               <span style="font-weight:800;color:#0b1220;">Note:</span> ${opts.comments}
                             </div>`
                          : ""
                      }
                    </td>
                  </tr>
                </table>

                <div style="height:14px;"></div>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #eef2ff;border-radius:14px;overflow:hidden;">
                  <tr>
                    <td style="padding:12px 14px;background:#0b1220;color:#fff;font-size:13px;font-weight:800;">
                      Requested Items
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0;">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr style="background:#f8fafc;">
                          <th align="left" style="padding:10px 14px;font-size:12px;color:#667085;">Item</th>
                          <th align="center" style="padding:10px 10px;font-size:12px;color:#667085;">Qty</th>
                          <th align="right" style="padding:10px 14px;font-size:12px;color:#667085;">Price</th>
                        </tr>
                        ${rows || `<tr><td colspan="3" style="padding:14px;color:#667085;">No items</td></tr>`}
                        <tr>
                          <td colspan="2" style="padding:12px 14px;border-top:1px solid #eef2ff;color:#667085;font-size:12px;">
                            Estimated Total
                          </td>
                          <td align="right" style="padding:12px 14px;border-top:1px solid #eef2ff;color:#0b1220;font-size:14px;font-weight:900;">
                            ${money(total)}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <div style="height:16px;"></div>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td align="left">
                      <a href="${opts.approveUrl}"
                         style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:900;font-size:14px;padding:12px 16px;border-radius:12px;">
                        Approve
                      </a>
                      <span style="display:inline-block;width:10px;"></span>
                      <a href="${opts.declineUrl}"
                         style="display:inline-block;background:#ef4444;color:#ffffff;text-decoration:none;font-weight:900;font-size:14px;padding:12px 16px;border-radius:12px;">
                        Reject
                      </a>
                      <span style="display:inline-block;width:10px;"></span>
                      <a href="${opts.holdUrl}"
                         style="display:inline-block;background:#6b7280;color:#ffffff;text-decoration:none;font-weight:900;font-size:14px;padding:12px 16px;border-radius:12px;">
                        On Hold
                      </a>
                    </td>
                  </tr>
                </table>

                ${
                  opts.viewUrl
                    ? `<div style="margin-top:14px;">
                         <a href="${opts.viewUrl}" style="color:#00477f;text-decoration:none;font-weight:700;font-size:13px;">
                           View in HRMS →
                         </a>
                       </div>`
                    : ""
                }

                <div style="margin-top:18px;padding-top:14px;border-top:1px solid #eef2ff;color:#667085;font-size:12px;line-height:1.5;">
                  If the buttons don’t work, copy & paste a link into your browser:<br/>
                  <span style="color:#111827;font-weight:700;">Approve:</span> ${opts.approveUrl}<br/>
                  <span style="color:#111827;font-weight:700;">Reject:</span> ${opts.declineUrl}<br/>
                  <span style="color:#111827;font-weight:700;">On Hold:</span> ${opts.holdUrl}<br/>
                  <br/>
                  This is an action email intended only for the assigned approver.
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:14px 22px;background:#0b1220;color:rgba(255,255,255,.82);font-family:Arial,sans-serif;font-size:12px;">
                © ${new Date().getFullYear()} PlumTrips • Secure approval link • Token expires automatically
              </td>
            </tr>
          </table>

          <div style="height:14px;"></div>
          <div style="font-family:Arial,sans-serif;font-size:11px;color:rgba(255,255,255,.55);max-width:620px;">
            You’re receiving this because your email is configured as an approver for a workspace request.
          </div>
        </td>
      </tr>
    </table>
  </div>
  `;
}

async function main() {
  if (envBool(env("DISABLE_EMAILS"), false)) {
    console.warn(
      "⚠️ DISABLE_EMAILS=1 — mailer will skip sending. Set DISABLE_EMAILS=0 to send."
    );
  }

  const to = env("TEST_TO");
  if (!to) {
    console.error("❌ Missing TEST_TO. Example: $env:TEST_TO='you@gmail.com'");
    process.exit(1);
  }

  const rid = env("TEST_REQUEST_ID"); // set real ApprovalRequest _id to make action fully real
  const approverEmail = normEmail(env("TEST_APPROVER_EMAIL", to));

  const requestIdForToken = rid || "000000000000000000000000"; // preview fallback

  // ✅ include act so each token is different, and backend can enforce it
  const tokenApprove = signEmailActionToken({ rid: requestIdForToken, approverEmail, act: "approved" });
  const tokenDecline = signEmailActionToken({ rid: requestIdForToken, approverEmail, act: "declined" });
  const tokenHold = signEmailActionToken({ rid: requestIdForToken, approverEmail, act: "on_hold" });

  const approveUrl = buildBackendActionUrl(tokenApprove, "approved");
  const declineUrl = buildBackendActionUrl(tokenDecline, "declined");
  const holdUrl = buildBackendActionUrl(tokenHold, "on_hold");

  const subject = `PlumTrips HRMS — Approval Needed${rid ? "" : " (Preview)"}`;

  const html = buildEmailHtml({
    brand: "PlumTrips HRMS • Approvals",
    customerName: "Demo Workspace",
    ticketId: "PT-TEST-001",
    requesterName: "Imran",
    requesterEmail: "requests@plumtrips.com",
    comments: rid
      ? "Click Approve / Reject / On Hold — action will be recorded instantly."
      : "Preview email. Set TEST_REQUEST_ID to a real ApprovalRequest _id to make actions update DB.",
    items: [
      { title: "Flight: DEL → BOM", description: "1 Adult, Economy", qty: 1, price: 6200 },
      { title: "Hotel: Mumbai", description: "2 nights", qty: 1, price: 9800 },
    ],
    approveUrl,
    declineUrl,
    holdUrl,
    viewUrl: `${frontendBaseUrl()}/approvals`, // optional
  });

  console.log("➡️ Sending to:", to);
  console.log("➡️ BACKEND base:", publicBaseUrl());
  console.log("➡️ EMAIL_BACKEND_ACTION_PATH:", emailBackendActionPath());
  console.log("➡️ TEST_REQUEST_ID:", rid || "(not set — preview mode)");
  console.log("🔗 Approve link:", approveUrl);
  console.log("🔗 Reject link:", declineUrl);
  console.log("🔗 Hold link:", holdUrl);

  const result = await sendMail({
    to,
    subject,
    html,
    kind: "APPROVALS",
  });

  console.log("✅ Done:", result);
}

main().catch((e) => {
  console.error("❌ Script failed:", e?.message || e);
  process.exit(1);
});
