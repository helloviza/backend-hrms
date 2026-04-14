// apps/backend/src/routes/approvals.email.ts
import fs from "fs";
import path from "path";

export type AnyObj = Record<string, any>;

export function escapeHtml(v: any) {
  const s = String(v ?? "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function moneyINR(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  try {
    return n.toLocaleString("en-IN");
  } catch {
    return String(n);
  }
}

/* ────────────────────────────────────────────────────────────────
 * Pricing helpers
 * ──────────────────────────────────────────────────────────────── */

function numOrUndef(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function pickAnyNumber(obj: any, keys: string[]): number | undefined {
  for (const k of keys) {
    const n = numOrUndef(obj?.[k]);
    if (n != null) return n;
  }
  return undefined;
}

export function getItemBookingAmount(it: any): number | undefined {
  return (
    pickAnyNumber(it, ["bookingAmount", "booking_amount", "amount", "finalAmount"]) ??
    pickAnyNumber(it?.meta, ["bookingAmount", "booking_amount", "booking_total", "finalAmount"]) ??
    pickAnyNumber(it?.details, ["bookingAmount", "booking_amount"]) ??
    pickAnyNumber(it?.data, ["bookingAmount", "booking_amount"])
  );
}

export function getItemActualPrice(it: any): number | undefined {
  return (
    pickAnyNumber(it, ["actualPrice", "actual_price", "actualAmount", "actual_amount"]) ??
    pickAnyNumber(it?.meta, ["actualPrice", "actual_price", "actualAmount", "actual_amount"]) ??
    pickAnyNumber(it?.details, ["actualPrice", "actual_price"]) ??
    pickAnyNumber(it?.data, ["actualPrice", "actual_price"])
  );
}

export function getItemEstimate(it: any): number | undefined {
  const price = numOrUndef(it?.price);
  const qty = numOrUndef(it?.qty) ?? 1;
  if (price == null) return undefined;
  return price * qty;
}

export function sumBookingAmount(items: any[]): number {
  const list = Array.isArray(items) ? items : [];
  return list.reduce((sum, it) => {
    const ba = getItemBookingAmount(it);
    if (ba != null) return sum + ba;

    const est = getItemEstimate(it);
    return sum + (est ?? 0);
  }, 0);
}

export function firstLine(v: any, max = 180) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function sanitizeAdminCommentForEmail(input: any) {
  let s = String(input ?? "").trim();
  if (!s) return "";

  // 1) Remove "Attachment: <url>" patterns
  s = s.replace(/\bAttachment\s*:\s*https?:\/\/\S+/gi, "").trim();

  // 2) Remove raw localhost URLs
  s = s.replace(/https?:\/\/localhost:\d+\/\S+/gi, "").trim();

  // 3) Remove bracket tags like [MODE:DONE]
  s = s.replace(/\[[^\]]{1,80}\]/g, " ").trim();

  // 4) Remove "[:26000]" style tokens
  s = s.replace(/\[\s*:\s*[^\]]{1,40}\]/g, " ").trim();

  // 5) Remove standalone tag-like segments
  s = s.replace(/\b(MODE|SERVICE|REASON)\s*:\s*[A-Z0-9_ -]{1,40}\b/gi, " ").trim();

  // 7) Keep only the last segment after dash/emdash
  const parts = s
    .split(/\s[—-]\s/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    s = parts[parts.length - 1];
  }

  // 8) Final cleanup
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return s;
}

/* ────────────────────────────────────────────────────────────────
 * Itinerary helpers (used by email templates)
 * ──────────────────────────────────────────────────────────────── */

function fmtKey(k: string) {
  return k
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function isPrimitive(v: any) {
  return (
    v == null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

function shorten(v: any, max = 120) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function pickMeta(it: any) {
  return (it?.meta || it?.details || it?.data || it?.payload || {}) as AnyObj;
}

export function serviceTypeOfItem(it: any): string {
  const t = String(it?.type || it?.service || it?.category || "")
    .trim()
    .toLowerCase();
  if (!t) return "other";
  if (t.includes("flight") || t.includes("air")) return "flight";
  if (t.includes("hotel") || t.includes("stay")) return "hotel";
  if (t.includes("visa")) return "visa";
  if (t.includes("cab") || t.includes("taxi") || t.includes("transfer")) return "cab";
  if (t.includes("rail") || t.includes("train")) return "rail";
  if (t.includes("holiday") || t.includes("package")) return "holiday";
  if (t.includes("mice") || t.includes("event") || t.includes("conference")) return "mice";
  return "other";
}

export function pickTripSummary(items: any[]) {
  const list = Array.isArray(items) ? items : [];
  const primary =
    list.find((x) => serviceTypeOfItem(x) === "flight") ||
    list.find((x) => serviceTypeOfItem(x) === "hotel") ||
    list[0];

  const m = pickMeta(primary);

  const origin =
    m?.origin ||
    m?.from ||
    m?.source ||
    m?.src ||
    m?.fromCity ||
    m?.fromAirport ||
    m?.pickup ||
    m?.pickupCity;

  const destination =
    m?.destination ||
    m?.to ||
    m?.target ||
    m?.dst ||
    m?.toCity ||
    m?.toAirport ||
    m?.drop ||
    m?.dropCity;

  const countryFrom = m?.nationality || m?.fromCountry;
  const countryTo = m?.country || m?.toCountry || m?.destinationCountry;

  const seg =
    origin && destination
      ? `${origin} → ${destination}`
      : countryFrom && countryTo
        ? `${countryFrom} → ${countryTo}`
        : String(primary?.title || primary?.type || primary?.service || "Travel request").trim();

  return { seg: String(seg || "Travel request") };
}

function flattenMeta(meta: AnyObj, depth = 2) {
  const rows: Array<{ k: string; v: string }> = [];
  const skipKeys = new Set([
    "_id",
    "id",
    "rid",
    "requestId",
    "customerId",
    "customerWorkspaceId",
    "token",
    "signature",
    "hash",
    "jwt",
    "session",
    "cookies",
    "raw",
    "html",
  ]);

  function walk(obj: any, prefix = "", d = 0) {
    if (!obj || typeof obj !== "object") return;
    const keys = Object.keys(obj);

    for (const key of keys) {
      if (!key) continue;
      const lk = key.toLowerCase();
      if (skipKeys.has(key) || skipKeys.has(lk)) continue;

      const val = (obj as any)[key];
      if (val === undefined || val === null || val === "") continue;

      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (isPrimitive(val)) {
        const str = typeof val === "boolean" ? (val ? "Yes" : "No") : String(val);
        const clean = shorten(str, 180);
        if (clean) rows.push({ k: fullKey, v: clean });
        continue;
      }

      if (Array.isArray(val)) {
        if (!val.length) continue;

        if (val.every(isPrimitive)) {
          const joined = val.map(String).filter(Boolean).slice(0, 12).join(", ");
          rows.push({ k: fullKey, v: shorten(joined, 200) });
          continue;
        }

        const sample = val.slice(0, 2).map((x) => {
          if (!x || typeof x !== "object") return String(x);
          const keys2 = Object.keys(x).slice(0, 6);
          const mini = keys2
            .map((kk) => {
              const vv = (x as any)[kk];
              if (vv == null) return "";
              if (typeof vv === "object") return "";
              return `${kk}:${String(vv)}`;
            })
            .filter(Boolean)
            .join(" | ");
          return mini || "…";
        });

        rows.push({
          k: fullKey,
          v:
            shorten(sample.join("  ||  "), 220) +
            (val.length > 2 ? `  (+${val.length - 2} more)` : ""),
        });
        continue;
      }

      if (d < depth) {
        walk(val, fullKey, d + 1);
      } else {
        rows.push({ k: fullKey, v: "… (details)" });
      }
    }
  }

  walk(meta, "", 0);
  rows.sort((a, b) => a.k.localeCompare(b.k));
  return rows.slice(0, 80);
}

function metaTableHtml(meta: AnyObj) {
  const rows = flattenMeta(meta, 2);
  if (!rows.length) return "";

  const trs = rows
    .map((r) => {
      return `
        <tr>
          <td style="padding:8px 10px;border-top:1px solid #eef2f7;color:#475569;font-size:12px;width:42%;">
            <b style="color:#0f172a;">${escapeHtml(fmtKey(r.k))}</b>
          </td>
          <td style="padding:8px 10px;border-top:1px solid #eef2f7;color:#0f172a;font-size:12px;">
            ${escapeHtml(String(r.v))}
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
      style="border:1px solid #eef2f7;border-radius:12px;overflow:hidden;margin-top:10px;">
      <tr>
        <th align="left" colspan="2"
          style="padding:10px 10px;background:#f8fafc;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#64748b;">
          Full details
        </th>
      </tr>
      ${trs}
    </table>
  `;
}

function metaTableHtmlCompact(meta: AnyObj) {
  const rows = flattenMeta(meta, 1)
    .filter((r) => {
      const k = String(r.k || "").toLowerCase();
      const v = String(r.v || "").toLowerCase();

      // ✅ Allow booking amounts, block internal actual/vendor/admin hints
      if (k.includes("actual_price")) return false;
      if (k.includes("actualprice")) return false;
      if (k.includes("actualbookingprice")) return false;
      if (k.includes("vendor_price")) return false;
      if (k.includes("vendorprice")) return false;
      if (k.includes("internal")) return false;
      if (k.includes("admin")) return false;

      if (/\[[a-z0-9_\- ]+\]/i.test(v)) return false;
      return true;
    })
    .slice(0, 18);

  if (!rows.length) return "";

  const trs = rows
    .map((r) => {
      return `
        <tr>
          <td style="padding:8px 10px;border-top:1px solid rgba(148,163,184,0.22);color:#94a3b8;font-size:12px;width:42%;">
            <b style="color:#e2e8f0;">${escapeHtml(fmtKey(r.k))}</b>
          </td>
          <td style="padding:8px 10px;border-top:1px solid rgba(148,163,184,0.22);color:#e2e8f0;font-size:12px;">
            ${escapeHtml(String(r.v))}
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
      style="border:1px solid rgba(148,163,184,0.18);border-radius:14px;overflow:hidden;margin-top:10px;background:rgba(2,6,23,0.55);">
      <tr>
        <th align="left" colspan="2"
          style="padding:10px 10px;background:rgba(255,255,255,0.04);font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#94a3b8;">
          Key details
        </th>
      </tr>
      ${trs}
    </table>
  `;
}

/* ────────────────────────────────────────────────────────────────
 * Templates
 * ──────────────────────────────────────────────────────────────── */

export function buildRequesterApprovedHtml(opts: {
  customerName: string;
  ticketId?: string;
  requesterName?: string;
  requesterEmail: string;
  approverName?: string;
  approverEmail?: string;
  items: any[];
}) {
  const accent = "#d06549";
  const ink = "#0f172a";
  const slate = "#475569";

  const customerName = escapeHtml(opts.customerName || "Workspace");
  const ticketId = escapeHtml(opts.ticketId || "");
  const requesterName = escapeHtml(opts.requesterName || "User");
  const requesterEmail = escapeHtml(opts.requesterEmail || "");
  const approverName = escapeHtml(opts.approverName || "");
  const approverEmail = escapeHtml(opts.approverEmail || "");

  const items = Array.isArray(opts.items) ? opts.items : [];
  const { seg } = pickTripSummary(items);
  const totalBookingAmount = sumBookingAmount(items);

    return `<!doctype html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;background:#f5f7fb;padding:22px;font-family:Arial,sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e8eef6;border-radius:18px;padding:18px;">
    <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#64748b;font-weight:900;">
      PlumTrips • Approval Update
    </div>
    <div style="margin-top:8px;font-size:20px;font-weight:900;color:${ink};">
      Approved ✅ (Moved to Admin Queue)
    </div>

    <div style="margin-top:10px;padding:12px 14px;border-radius:14px;background:#f8fafc;border:1px solid #e8eef6;">
      <div style="font-size:14px;font-weight:900;color:${ink};">
        ${customerName}${ticketId ? ` <span style="color:${accent};">(${ticketId})</span>` : ""}
      </div>
      <div style="margin-top:6px;color:${slate};font-size:13px;line-height:1.55;">
        <b style="color:${ink};">Trip:</b> ${escapeHtml(seg)}<br/>
        <b style="color:${ink};">Requested by:</b> ${requesterName}<br/>
        ${
          approverEmail
            ? `<b style="color:${ink};">Approved by:</b> ${approverName || approverEmail} <br/>`
            : ""
        }
                ${
          totalBookingAmount
            ? `<span style="display:inline-block;margin-left:8px;padding:8px 10px;border-radius:999px;
                    background:#eef2ff;border:1px solid #c7d2fe;color:#1e293b;font-size:12px;font-weight:900;">
                Booking Amount: ₹${escapeHtml(moneyINR(totalBookingAmount))}
              </span>`
            : ""
        }
      </div>
    </div>

    <div style="margin-top:14px;color:${slate};font-size:13px;line-height:1.6;">
      Admin team will now process this request. Once processed, you will receive a confirmation email with itinerary details and the attached PDF (if uploaded).
    </div>

    <div style="margin-top:16px;color:#94a3b8;font-size:12px;line-height:1.6;">
      If you have questions, reply to this email.
    </div>
  </div>
</body>
</html>`;
}

export function buildAdminProcessedEmailHtml(opts: {
  customerName: string;
  ticketId?: string;
  requesterEmail: string;
  processedByEmail: string;
  processedByName?: string;
  comment?: string;
  items: any[];
  bookingAmount?: number;
  attachments?: Array<{ url?: string; filename?: string }>;
}) {
  const ticketId = escapeHtml(opts.ticketId || "");
  const requesterEmail = escapeHtml(opts.requesterEmail || "");
  const processedByEmail = escapeHtml(opts.processedByEmail || "");
  const processedByName = escapeHtml(opts.processedByName || "");

  const safeComment = escapeHtml(sanitizeAdminCommentForEmail(opts.comment || ""));

  const items = Array.isArray(opts.items) ? opts.items : [];

  const totalBookingAmount =
    Number.isFinite(Number(opts.bookingAmount))
      ? Number(opts.bookingAmount)
      : sumBookingAmount(items);

  // attachments (filenames only)
  const atts = Array.isArray(opts.attachments) ? opts.attachments : [];
  const attList =
    atts.length > 0
      ? `<ul style="margin:8px 0 0 18px;padding-left:18px;">
          ${atts
            .map((a) => {
              const f = escapeHtml(a?.filename || "Attachment.pdf");
              return `<li style="margin:6px 0;color:#0f172a;font-weight:600;">${f} <span style="color:#64748b;font-weight:400;">— attached</span></li>`;
            })
            .join("")}
        </ul>`
      : `<div style="color:#64748b;">No attachments were added for this request.</div>`;

  const uniqueItems = items.filter((item, index, arr) =>
    arr.findIndex(i =>
      (i.meta?.origin || i.origin) === (item.meta?.origin || item.origin) &&
      (i.meta?.destination || i.destination) === (item.meta?.destination || item.destination) &&
      (i.meta?.departDate || i.departDate) === (item.meta?.departDate || item.departDate)
    ) === index
  );
  const itineraryRows = uniqueItems.map((it) => buildCleanItemHtml(it)).join("");

  const itineraryBlock =
    itineraryRows ||
    `<div style="margin-top:12px;padding:14px;border:1px dashed #e2e8f0;border-radius:14px;color:#64748b;font-size:13px;">
      No itinerary items found for this request.
     </div>`;

  const bodyContent = `
    ${eCard(`
      ${eLabel("Summary")}
      <div style="font-size:13px;line-height:1.65;color:#334155;">
        <b style="color:#0f172a;">Requester:</b> ${requesterEmail}<br/>
        <b style="color:#0f172a;">Processed by:</b> ${processedByName || processedByEmail}
        ${ticketId ? `<br/><b style="color:#0f172a;">Ticket:</b> ${ticketId}` : ""}
        ${totalBookingAmount ? `<br/><b style="color:#0f172a;">Booking Amount:</b> &#8377;${escapeHtml(moneyINR(totalBookingAmount))}` : ""}
      </div>
    `)}

    ${safeComment ? eCard(`
      ${eLabel("Ops Note")}
      <div style="font-size:13px;line-height:1.65;color:#334155;">${safeComment}</div>
    `) : ""}

    <div style="margin-top:16px;">
      ${eLabel("Itinerary")}
      ${itineraryBlock}
    </div>

    ${eCard(`
      ${eLabel("Documents Attached")}
      <div style="font-size:13px;line-height:1.6;color:#334155;">${attList}</div>
    `)}

    <div style="margin-top:16px;color:#64748b;font-size:12px;line-height:1.7;">
      If any detail looks incorrect, connect to your Relationship Manager — our concierge team will correct it quickly.
    </div>
  `;

  return buildEmailShell(bodyContent, {
    title: "Booking Confirmed",
    subtitle: "Your travel has been processed by our ops team. Attached documents (if any) are included.",
    badgeText: "CONFIRMED",
    badgeColor: "#10b981",
  });
}

/* ────────────────────────────────────────────────────────────────
 * Shared email design system
 * ──────────────────────────────────────────────────────────────── */

export function buildEmailShell(
  content: string,
  opts: { title: string; subtitle?: string; badgeText?: string; badgeColor?: string },
): string {
  const brand = "#00477f";
  const accent = "#d06549";
  const badge = opts.badgeColor || "#4f46e5";
  const badgeText = opts.badgeText || "";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
</head>
<body style="margin:0;background:#f5f7fb;padding:24px;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" bgcolor="#f5f7fb" style="background:#f5f7fb;padding:28px 12px;">
    <tr>
      <td align="center">
        <table width="620" cellpadding="0" cellspacing="0" role="presentation" style="width:620px;max-width:620px;">
          <tr>
            <td style="padding:0 6px 12px 6px;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                bgcolor="${brand}"
                style="border-radius:20px;overflow:hidden;
                       background:linear-gradient(135deg,${brand} 0%,#052b57 55%,${accent} 140%);">
                <tr>
                  <td bgcolor="${brand}" style="background:linear-gradient(135deg,${brand} 0%,#052b57 55%,${accent} 140%);padding:20px 20px 18px 20px;">
                    <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.75);font-weight:900;">
                      PlumTrips
                    </div>
                    ${badgeText ? `<div style="margin-top:10px;display:inline-block;padding:5px 12px;border-radius:999px;background:${badge};color:#fff;font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;">${escapeHtml(badgeText)}</div>` : ""}
                    <div style="margin-top:10px;font-size:24px;line-height:1.2;color:#ffffff;font-weight:900;">
                      ${escapeHtml(opts.title)}
                    </div>
                    ${opts.subtitle ? `<div style="margin-top:8px;font-size:13px;line-height:1.55;color:rgba(255,255,255,.85);">${escapeHtml(opts.subtitle)}</div>` : ""}
                  </td>
                </tr>
                <tr><td bgcolor="${accent}" style="height:4px;background:${accent};"></td></tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 6px;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                bgcolor="#ffffff"
                style="background:#ffffff;border:1px solid #e8eef6;border-radius:20px;
                       box-shadow:0 10px 28px rgba(15,23,42,.08);overflow:hidden;">
                <tr>
                  <td bgcolor="#ffffff" style="background:#ffffff;padding:20px;font-family:Arial,sans-serif;">
                    ${content}
                  </td>
                </tr>
              </table>
              <div style="padding:14px 6px 0 6px;font-size:12px;color:#94a3b8;line-height:1.6;text-align:center;">
                &copy; Plumtrips &bull; Crafted for seamless journeys.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function eRow(label: string, value: string): string {
  if (!value) return "";
  return `<tr>
    <td style="color:#64748b;font-size:12px;width:140px;padding:4px 0;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="color:#0f172a;font-size:12px;font-weight:600;padding:4px 0;">${value}</td>
  </tr>`;
}

export function eLabel(text: string): string {
  return `<div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#64748b;font-weight:900;margin-bottom:8px;">${escapeHtml(text)}</div>`;
}

export function eCard(content: string): string {
  return `<div style="margin-top:12px;padding:14px;border:1px solid #e8eef6;border-radius:14px;background:#f8fafc;">${content}</div>`;
}

export function eBtn(
  label: string,
  url: string,
  bg: string,
  color: string,
  border?: string,
): string {
  const borderStyle = border ? `border:1.5px solid ${border};` : "";
  return `<a href="${url}" style="display:inline-block;background:${bg};color:${color};text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;${borderStyle}margin-right:10px;">${escapeHtml(label)}</a>`;
}

export function eFlightCard(it: any): string {
  return buildCleanItemHtml(it);
}

export function eHotelCard(it: any): string {
  return buildCleanItemHtml(it);
}

export function eItemsHtml(items: any[]): string {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return `<div style="padding:14px;border:1px dashed #e2e8f0;border-radius:14px;color:#64748b;font-size:13px;">No items found in this request.</div>`;
  }
  return list.map((it) => buildCleanItemHtml(it)).join("");
}

/* ────────────────────────────────────────────────────────────────
 * Clean item card helpers (used by buildApproverEmailHtml)
 * ──────────────────────────────────────────────────────────────── */

function approverDetailRow(label: string, value: string): string {
  return (
    "<tr>" +
    '<td style="color:#9ca3af;font-size:12px;width:130px;padding:3px 0;vertical-align:top;">' + label + "</td>" +
    '<td style="color:#374151;font-size:12px;font-weight:500;padding:3px 0;">' + value + "</td>" +
    "</tr>"
  );
}

function safeStr(v: any): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function buildCleanItemHtml(it: any): string {
  const svcType = serviceTypeOfItem(it);
  const isHotel = svcType === "hotel";
  // meta is the primary source; direct item fields are fallbacks
  const m = pickMeta(it);

  if (isHotel) {
    const propertyName = safeStr(m?.hotelName || m?.propertyName || it?.hotelName || it?.propertyName || it?.title);
    const checkIn      = safeStr(m?.checkIn || m?.checkInDate || it?.checkIn || it?.checkInDate);
    const checkOut     = safeStr(m?.checkOut || m?.checkOutDate || it?.checkOut || it?.checkOutDate);
    const rooms        = safeStr(m?.rooms || m?.roomCount || it?.rooms || it?.roomCount);
    const guests       = safeStr(m?.guests || m?.guestCount || m?.adults || it?.guests || it?.adults);
    const fareNum      = Number(m?.fare || m?.amount || it?.fare || it?.amount || it?.totalFare || it?.price);
    const fare         = Number.isFinite(fareNum) && fareNum > 0 ? "&#8377;" + fareNum.toLocaleString("en-IN") : "";
    const subline      = [rooms ? rooms + " Room(s)" : "", guests ? guests + " Guest(s)" : ""].filter(Boolean).join(" · ");

    return `
<table width="100%" cellpadding="0" cellspacing="0"
  bgcolor="#f4f5f7" style="background:#f4f5f7;border-radius:10px;margin-bottom:12px;">
  <tr>
    <td bgcolor="#f4f5f7" style="background:#f4f5f7;padding:20px;">
      <div style="font-size:19px;font-weight:700;color:#111827;letter-spacing:-0.3px;margin-bottom:3px;">
        ${escapeHtml(propertyName || "Hotel")}
      </div>
      ${subline ? `<div style="color:#6b7280;font-size:12px;margin-bottom:14px;">${escapeHtml(subline)}</div>` : ""}
      <table cellpadding="0" cellspacing="0">
        ${checkIn  ? approverDetailRow("Check-In",  escapeHtml(checkIn))  : ""}
        ${checkOut ? approverDetailRow("Check-Out", escapeHtml(checkOut)) : ""}
        ${fare     ? approverDetailRow("Fare",      fare)                 : ""}
      </table>
    </td>
    <td width="70" valign="top" align="right">
      <span style="background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px 10px;border-radius:20px;text-transform:uppercase;display:inline-block;">
        Hotel
      </span>
    </td>
  </tr>
</table>`;
  }

  // Default: Flight
  // Read meta.* first, fall back to direct item fields
  const origin      = safeStr(m?.origin || m?.from || m?.src || m?.fromCity || it?.origin || it?.from);
  const destination = safeStr(m?.destination || m?.to || m?.dst || m?.toCity || it?.destination || it?.to);

  // If still empty, try to extract from item.title (e.g. "DEL → MAA (One Way)")
  const routeHeadline = (origin && destination)
    ? `${escapeHtml(origin)} &#x2192; ${escapeHtml(destination)}`
    : escapeHtml(safeStr(it?.title || it?.description) || "Flight");

  const departDate    = safeStr(m?.departDate || m?.travelDate || m?.departureDate || it?.departDate || it?.travelDate);
  const returnDate    = safeStr(m?.returnDate || it?.returnDate);

  const tripTypeRaw   = safeStr(m?.tripType || it?.tripType || it?.TripType);
  const tripType      = tripTypeRaw.toLowerCase() === "oneway"    ? "One Way"
                      : tripTypeRaw.toLowerCase() === "roundtrip" ? "Return"
                      : tripTypeRaw.toLowerCase() === "return"    ? "Return"
                      : tripTypeRaw || "One Way";

  const cabinClass    = safeStr(m?.cabinClass || m?.cabin || it?.cabinClass || it?.cabin) || "Economy";
  const adults        = safeStr(m?.adults ?? it?.adults ?? it?.passengers?.adults) || "1";
  const preferredTime = safeStr(m?.preferredTime || m?.preferredFlightTime || it?.preferredTime);
  const priority      = safeStr(m?.priority || it?.priority);
  const notes         = safeStr(m?.notes || it?.notes || it?.description);

  // Travellers array: meta.travellers is primary, then item.travellers
  const travellersArr = Array.isArray(m?.travellers) ? m.travellers
                      : Array.isArray(it?.travellers) ? it.travellers
                      : [];
  const travellers = travellersArr
    .map((t: any) => {
      const fn = safeStr(t?.firstName || t?.first_name || t?.FirstName);
      const ln = safeStr(t?.lastName  || t?.last_name  || t?.LastName);
      return [fn, ln].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join(", ");

  const fareNum = Number(m?.fare || m?.amount || it?.fare || it?.amount || it?.totalFare || it?.price);
  const fare    = Number.isFinite(fareNum) && fareNum > 0 ? "&#8377;" + fareNum.toLocaleString("en-IN") : "";

  const subline = [tripType, cabinClass, adults ? adults + " Adult(s)" : ""].filter(Boolean).join(" &nbsp;&middot;&nbsp; ");

  return `
<table width="100%" cellpadding="0" cellspacing="0"
  bgcolor="#f4f5f7" style="background:#f4f5f7;border-radius:10px;margin-bottom:12px;">
  <tr>
    <td bgcolor="#f4f5f7" style="background:#f4f5f7;padding:20px;">
      <div style="font-size:19px;font-weight:700;color:#111827;letter-spacing:-0.3px;margin-bottom:3px;">
        ${routeHeadline}
      </div>
      ${subline ? `<div style="color:#6b7280;font-size:12px;margin-bottom:14px;">${subline}</div>` : ""}
      <table cellpadding="0" cellspacing="0">
        ${departDate    ? approverDetailRow("Depart Date",    escapeHtml(departDate))    : ""}
        ${returnDate    ? approverDetailRow("Return Date",    escapeHtml(returnDate))    : ""}
        ${preferredTime ? approverDetailRow("Preferred Time", escapeHtml(preferredTime)) : ""}
        ${priority      ? approverDetailRow("Priority",       escapeHtml(priority))      : ""}
        ${notes         ? approverDetailRow("Notes",          escapeHtml(notes))         : ""}
        ${travellers    ? approverDetailRow("Travellers",     escapeHtml(travellers))    : ""}
        ${fare          ? approverDetailRow("Fare",           fare)                      : ""}
      </table>
    </td>
    <td width="70" valign="top" align="right" style="padding:20px 20px 0 0;">
      <span style="background:#eef2ff;color:#4f46e5;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px 10px;border-radius:20px;text-transform:uppercase;display:inline-block;">
        Flight
      </span>
    </td>
  </tr>
</table>`;
}

/* ────────────────────────────────────────────────────────────────
 * Premium Approver + Leader templates
 * ──────────────────────────────────────────────────────────────── */

export function buildApproverEmailHtml(opts: {
  requestId: string;
  requesterName: string;
  requesterEmail: string;
  customerName: string;
  ticketId?: string;
  items: any[];
  comments?: string;
  approveUrl: string;
  declineUrl: string;
  holdUrl: string;
}) {
  const brand = "#00477f";
  const accent = "#d06549";
  const ink = "#0f172a";
  const slate = "#475569";

  const requesterName = escapeHtml(opts.requesterName || "User");
  const requesterEmail = escapeHtml(opts.requesterEmail || "");
  const customerName = escapeHtml(opts.customerName || "Workspace");
  const ticketId = escapeHtml(opts.ticketId || "");
  const comments = escapeHtml(opts.comments || "");
  const requestId = escapeHtml(opts.requestId || "");

  const items = Array.isArray(opts.items) ? opts.items : [];
  const { seg } = pickTripSummary(items);

  
  function chip(
    label: string,
    value: string,
    tone: "brand" | "accent" | "neutral" = "neutral",
  ) {
    const bg =
      tone === "brand" ? "#eff6ff" : tone === "accent" ? "#fff7f4" : "#f8fafc";
    const col = tone === "brand" ? brand : tone === "accent" ? accent : "#334155";
    const br =
      tone === "brand" ? "#dbeafe" : tone === "accent" ? "#fde6df" : "#e2e8f0";

    return `
      <span style="display:inline-block;margin:0 8px 8px 0;padding:8px 10px;border-radius:999px;
                   background:${bg};border:1px solid ${br};color:${col};font-size:12px;font-weight:900;">
        ${escapeHtml(label)}${
          value
            ? `: <span style="color:${ink};font-weight:900;">${escapeHtml(value)}</span>`
            : ""
        }
      </span>
    `;
  }

  const headerBadges = `
    ${chip("Workspace", opts.customerName || "Workspace", "brand")}
    ${ticketId ? chip("Ticket", opts.ticketId || "", "accent") : ""}
    ${chip("Items", String(items.length), "neutral")}
   
    `;

  const commentBlock = comments
    ? `
      <div style="margin-top:14px;padding:14px 14px;border:1px solid #fde6df;background:#fff7f4;border-radius:16px;">
        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${accent};font-weight:900;">
          Request note
        </div>
        <div style="margin-top:8px;font-size:14px;line-height:1.6;color:${ink};">
          ${comments}
        </div>
      </div>
    `
    : "";

  const summaryBlock = `
    <div style="margin-top:12px;padding:14px 14px;border:1px solid #e8eef6;background:#f8fafc;border-radius:16px;">
      <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#64748b;font-weight:900;">
        Trip / Service Snapshot
      </div>
      <div style="margin-top:8px;font-size:18px;color:${ink};font-weight:900;line-height:1.25;">
        ${escapeHtml(seg)}
      </div>
      <div style="margin-top:8px;font-size:13px;line-height:1.55;color:${slate};">
        <b style="color:${ink};">Requested by:</b> ${requesterName}
      </div>
    </div>
  `;

  const uniqueItems = items.filter((item, index, arr) =>
    arr.findIndex(i =>
      (i.meta?.origin || i.origin) === (item.meta?.origin || item.origin) &&
      (i.meta?.destination || i.destination) === (item.meta?.destination || item.destination) &&
      (i.meta?.departDate || i.departDate) === (item.meta?.departDate || item.departDate)
    ) === index
  );
  const itemCards = uniqueItems.map((it) => buildCleanItemHtml(it)).join("");

  const itemsBlock = itemCards
    ? `
      <div style="margin-top:14px;">
        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#64748b;font-weight:900;margin-bottom:10px;">
          Full Itinerary (All Items)
        </div>
        ${itemCards}
      </div>
    `
    : `
      <div style="margin-top:14px;padding:14px;border:1px dashed #e2e8f0;border-radius:16px;color:#64748b;font-size:13px;">
        No items found in this request.
      </div>
    `;

  const ctas = `
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:18px;">
      <tr>
        <td align="left" style="padding:0;">
          <a href="${opts.approveUrl}"
            style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;margin-right:10px;">
            &#10003; Approve
          </a>
          <a href="${opts.declineUrl}"
            style="display:inline-block;background:#ffffff;color:#dc2626;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;border:1.5px solid #fca5a5;margin-right:10px;">
            &#10005; Reject
          </a>
          <a href="${opts.holdUrl}"
            style="display:inline-block;background:#ffffff;color:#92400e;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;border:1.5px solid #fcd34d;">
            &#9646; On Hold
          </a>
        </td>
      </tr>
    </table>
  `;

  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>Approval Needed</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f7fb;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f5f7fb;padding:28px 12px;">
      <tr>
        <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="width:600px;max-width:600px;">
            <tr>
              <td style="padding:0 6px 12px 6px;">
                <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                  style="border-radius:20px;overflow:hidden;
                         background: linear-gradient(135deg, ${brand} 0%, #052b57 55%, ${accent} 140%);">
                  <tr>
                    <td style="padding:18px 18px 16px 18px;">
                      <div style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.82);font-weight:900;">
                        PlumTrips • AI Travel Ops
                      </div>
                      <div style="font-family:Arial,sans-serif;font-size:24px;line-height:1.2;color:#ffffff;font-weight:900;margin-top:8px;">
                        Approval Needed
                      </div>
                      <div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.55;color:rgba(255,255,255,.9);margin-top:8px;">
                        Review the complete itinerary below. Your action routes the request to Admin for fulfilment.
                      </div>
                      <div style="height:12px;"></div>
                      <div style="font-family:Arial,sans-serif;">
                        ${headerBadges}
                      </div>
                    </td>
                  </tr>
                  <tr><td style="height:4px;background:${accent};"></td></tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 6px;">
                <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                  style="background:#ffffff;border:1px solid #e8eef6;border-radius:20px;
                         box-shadow:0 10px 28px rgba(15,23,42,.08);overflow:hidden;">
                  <tr>
                    <td style="padding:18px;font-family:Arial,sans-serif;">

                      ${summaryBlock}
                      ${commentBlock}
                      ${itemsBlock}

                      ${ctas}

                      <div style="height:16px;"></div>

                      <div style="padding:12px 14px;border-radius:16px;background:#0b1220;color:#e2e8f0;">
                        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:900;color:#94a3b8;">
                          Security
                        </div>
                        <div style="margin-top:6px;font-size:13px;line-height:1.55;">
                          Do not forward this email. Action links are intended for the assigned approver only.
                        </div>
                        <div style="margin-top:8px;font-size:12px;color:#94a3b8;">
                          Request ID: <span style="color:#ffffff;font-weight:900;">${requestId}</span>
                        </div>
                      </div>

                      <div style="height:8px;"></div>
                    </td>
                  </tr>
                </table>

                <div style="padding:14px 6px 0 6px;font-family:Arial,sans-serif;font-size:12px;color:#94a3b8;line-height:1.6;text-align:center;">
                  You’re receiving this because you’re listed as an approver for a PlumTrips request.
                </div>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

export function buildLeaderFyiHtml(opts: {
  requesterName: string;
  requesterEmail: string;
  customerName: string;
  ticketId?: string;
  items: any[];
  comments?: string;
}) {
  const brand = "#00477f";
  const accent = "#d06549";
  const ink = "#0f172a";
  const slate = "#475569";

  const requesterName = escapeHtml(opts.requesterName || "User");
  const requesterEmail = escapeHtml(opts.requesterEmail || "");
  const customerName = escapeHtml(opts.customerName || "Workspace");
  const ticketId = escapeHtml(opts.ticketId || "");
  const comments = escapeHtml(opts.comments || "");

  const items = Array.isArray(opts.items) ? opts.items : [];
  const { seg } = pickTripSummary(items);

  const bullets = items
    .slice(0, 8)
    .map((it, idx) => {
      const title = escapeHtml(String(it?.title || it?.type || "Item").trim());
      const desc = escapeHtml(firstLine(it?.description || "", 110));
      const typeLabel = escapeHtml(serviceTypeOfItem(it).toUpperCase());
      return `
        <tr>
          <td style="padding:10px 0;border-top:${idx === 0 ? "none" : "1px solid #eef2f7"};">
            <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#64748b;font-weight:900;">
              ${typeLabel}
            </div>
            <div style="margin-top:6px;font-size:14px;color:${ink};font-weight:900;line-height:1.25;">
              ${title}
            </div>
            ${
              desc
                ? `<div style="margin-top:6px;font-size:13px;line-height:1.55;color:${slate};">${desc}</div>`
                : ""
            }
          </td>
        </tr>
      `;
    })
    .join("");

  const commentBlock = comments
    ? `
      <div style="margin-top:12px;padding:12px 14px;border:1px solid #fde6df;background:#fff7f4;border-radius:16px;">
        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${accent};font-weight:900;">
          Request note
        </div>
        <div style="margin-top:8px;font-size:13px;line-height:1.6;color:${ink};">
          ${comments}
        </div>
      </div>
    `
    : "";

  return `
  <!doctype html>
  <html>
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="x-apple-disable-message-reformatting" /></head>
  <body style="margin:0;padding:0;background:#f5f7fb;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f5f7fb;padding:28px 12px;">
      <tr><td align="center">
        <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="width:600px;max-width:600px;">

          <tr>
            <td style="padding:0 6px 12px 6px;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                style="border-radius:20px;overflow:hidden;background: linear-gradient(135deg, ${brand} 0%, #052b57 55%, ${accent} 140%);">
                <tr>
                  <td style="padding:18px;">
                    <div style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.82);font-weight:900;">
                      PlumTrips • AI Travel Ops
                    </div>
                    <div style="font-family:Arial,sans-serif;font-size:22px;line-height:1.2;color:#fff;font-weight:900;margin-top:8px;">
                      FYI: New Request Submitted
                    </div>
                    <div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.55;color:rgba(255,255,255,.9);margin-top:8px;">
                      Action buttons are sent only to the assigned approver.
                    </div>
                  </td>
                </tr>
                <tr><td style="height:4px;background:${accent};"></td></tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:0 6px;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                style="background:#fff;border:1px solid #e8eef6;border-radius:20px;box-shadow:0 10px 28px rgba(15,23,42,.08);">
                <tr>
                  <td style="padding:18px;font-family:Arial,sans-serif;">
                    <div style="display:inline-block;padding:8px 10px;border-radius:999px;background:#eff6ff;border:1px solid #dbeafe;color:${brand};font-size:12px;font-weight:900;">
                      ${customerName}
                    </div>
                    ${
                      ticketId
                        ? `<span style="display:inline-block;margin-left:8px;padding:8px 10px;border-radius:999px;background:#fff7f4;border:1px solid #fde6df;color:${accent};font-size:12px;font-weight:900;">
                            Ticket: ${ticketId}
                          </span>`
                        : ""
                    }

                    <div style="margin-top:12px;padding:14px;border-radius:16px;background:#f8fafc;border:1px solid #e8eef6;">
                      <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#64748b;font-weight:900;">
                        Trip / Service Snapshot
                      </div>
                      <div style="margin-top:8px;font-size:16px;color:${ink};font-weight:900;line-height:1.25;">
                        ${escapeHtml(seg)}
                      </div>
                      <div style="margin-top:8px;font-size:13px;color:${slate};line-height:1.55;">
                        <b style="color:${ink};">Requested by:</b> ${requesterName}
                      </div>
                    </div>

                    ${commentBlock}

                    <div style="height:14px;"></div>

                    <div style="font-size:12px;color:#64748b;letter-spacing:.12em;text-transform:uppercase;font-weight:900;">
                      Items (preview)
                    </div>

                    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:8px;">
                      ${
                        bullets ||
                        `<tr><td style="padding:10px 0;color:#64748b;font-size:13px;">No items</td></tr>`
                      }
                    </table>

                    <div style="margin-top:16px;font-size:12px;color:#64748b;line-height:1.55;">
                      This is an FYI notification for workspace leaders.
                    </div>
                  </td>
                </tr>
              </table>

              <div style="padding:14px 6px 0 6px;font-family:Arial,sans-serif;font-size:12px;color:#94a3b8;line-height:1.6;text-align:center;">
                You’re receiving this because you’re listed as a workspace leader for PlumTrips approvals.
              </div>
            </td>
          </tr>

        </table>
      </td></tr>
    </table>
  </body>
  </html>
  `;
}

/* ────────────────────────────────────────────────────────────────
 * Attachment helper (used by approvals.ts)
 * ──────────────────────────────────────────────────────────────── */

export function buildEmailAttachmentsFromMeta(doc: any) {
  const list = Array.isArray(doc?.meta?.attachments) ? doc.meta.attachments : [];
  const out: Array<{ filename: string; path: string; contentType?: string }> = [];

  for (const a of list) {
    const rel = String(a?.path || "").trim();
    if (!rel) continue;

    const abs = path.join(process.cwd(), rel.replace(/^\//, ""));
    if (!fs.existsSync(abs)) continue;

    out.push({
      filename: String(a?.filename || path.basename(abs) || "attachment.pdf"),
      path: abs,
      contentType: a?.mime ? String(a.mime) : "application/pdf",
    });
  }

  return out;
}
