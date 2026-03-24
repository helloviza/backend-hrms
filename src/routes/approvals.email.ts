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
        <b style="color:${ink};">Requested by:</b> ${requesterName} &lt;${requesterEmail}&gt;<br/>
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
  const brand = "#00477f";
  const accent = "#d06549";
  const slate = "#94a3b8";

  const customerName = escapeHtml(opts.customerName || "Workspace");
  const ticketId = escapeHtml(opts.ticketId || "");
  const requesterEmail = escapeHtml(opts.requesterEmail || "");
  const processedByEmail = escapeHtml(opts.processedByEmail || "");
  const processedByName = escapeHtml(opts.processedByName || "");

  const safeComment = escapeHtml(sanitizeAdminCommentForEmail(opts.comment || ""));

  const items = Array.isArray(opts.items) ? opts.items : [];
  const { seg } = pickTripSummary(items);

  const totalBookingAmount =
    Number.isFinite(Number(opts.bookingAmount))
      ? Number(opts.bookingAmount)
      : sumBookingAmount(items);

  // attachments (filenames only)
  const atts = Array.isArray(opts.attachments) ? opts.attachments : [];
  const attList =
    atts.length > 0
      ? `<ul style="margin:10px 0 0 18px;color:#e2e8f0;padding-left:18px;">
          ${atts
            .map((a) => {
              const f = escapeHtml(a?.filename || "Attachment.pdf");
              return `<li style="margin:8px 0;"><span style="color:#f1f5f9;font-weight:900;">${f}</span>
                        <span style="color:#94a3b8;font-weight:700;"> • attached</span>
                      </li>`;
            })
            .join("")}
        </ul>`
      : `<div style="margin-top:10px;color:#cbd5e1;">No attachments were added for this request.</div>`;

  const itineraryRows = items
    .map((it, idx) => {
      const typeLabel = escapeHtml(serviceTypeOfItem(it).toUpperCase());
      const title = escapeHtml(String(it?.title || it?.type || "Item").trim());
      const desc = escapeHtml(firstLine(it?.description || "", 220));
      const qty = it?.qty != null ? escapeHtml(String(it.qty)) : "—";

      const bookingAmount = getItemBookingAmount(it);
      const estimateAmount = getItemEstimate(it);
      const rawPrice = Number.isFinite(Number(it?.price)) ? Number(it.price) : undefined;

      const displayAmount =
        bookingAmount != null
          ? bookingAmount
          : estimateAmount != null
            ? estimateAmount
            : rawPrice != null
              ? rawPrice
              : undefined;

      const price =
        displayAmount != null ? `₹${escapeHtml(moneyINR(displayAmount))}` : "—";

      const meta = pickMeta(it);

const itineraryText =
  meta?.itineraryText ||
  meta?.detailedItinerary ||
  meta?.itinerary ||
  meta?.routeSummary ||
  "";

const itineraryBlock = itineraryText
  ? `
    <div style="margin-top:10px;padding:12px 14px;border-radius:14px;background:#f8fafc;border:1px solid #e8eef6;">
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#64748b;font-weight:900;">
        Detailed Itinerary
      </div>
      <div style="margin-top:8px;font-size:13px;line-height:1.6;color:#0f172a;white-space:pre-line;">
        ${escapeHtml(String(itineraryText))}
      </div>
    </div>
  `
  : "";

const metaBlock =
  meta && Object.keys(meta).length ? metaTableHtml(meta) : "";

      return `
        <div style="
          margin-top:12px;
          border:1px solid rgba(148,163,184,0.18);
          border-radius:16px;
          overflow:hidden;
          background:rgba(2,6,23,0.55);
        ">
          <div style="padding:12px 14px;background:rgba(255,255,255,0.04);border-bottom:1px solid rgba(148,163,184,0.16);">
            <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#94a3b8;font-weight:900;">
              Item ${idx + 1} • ${typeLabel}
            </div>
            <div style="margin-top:8px;font-size:16px;line-height:1.25;color:#f8fafc;font-weight:950;">
              ${title}
            </div>
            ${
              desc
                ? `<div style="margin-top:8px;font-size:13px;line-height:1.6;color:#cbd5e1;">${desc}</div>`
                : ""
            }
          </div>

          <div style="padding:12px 14px;">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
              <tr>
                <td style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#94a3b8;font-weight:900;">
                  Qty
                </td>
                <td align="right" style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#94a3b8;font-weight:900;">
                  Amount
                </td>
              </tr>
              <tr>
                <td style="padding-top:6px;font-size:14px;color:#f1f5f9;font-weight:950;">
                  ${qty}
                </td>
                <td align="right" style="padding-top:6px;font-size:14px;color:#f1f5f9;font-weight:950;">
                  ${price}
                </td>
              </tr>
            </table>

            ${itineraryBlock}
${metaBlock}

          </div>
        </div>
      `;
    })
    .join("");

  const itineraryBlock =
    itineraryRows ||
    `<div style="margin-top:12px;padding:14px;border:1px dashed rgba(148,163,184,0.35);border-radius:16px;color:#cbd5e1;font-size:13px;">
      No itinerary items found for this request.
     </div>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
</head>
<body style="margin:0;background:#0b1220;padding:24px;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#0b1220;padding:28px 12px;">
    <tr>
      <td align="center">
        <table width="640" cellpadding="0" cellspacing="0" role="presentation" style="width:640px;max-width:640px;">
          <tr>
            <td style="padding:0 6px 12px 6px;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                style="border-radius:22px;overflow:hidden;
                       background: radial-gradient(900px 420px at 15% 0%, rgba(0,71,127,.55), rgba(11,18,32,0)),
                                  radial-gradient(900px 420px at 100% 10%, rgba(208,101,73,.35), rgba(11,18,32,0)),
                                  linear-gradient(135deg, ${brand} 0%, #052b57 55%, ${accent} 140%);">
                <tr>
                  <td style="padding:18px 18px 16px 18px;">
                    <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.82);font-weight:900;">
                      PlumTrips • Confirmation
                    </div>
                    <div style="margin-top:10px;font-size:26px;line-height:1.15;color:#ffffff;font-weight:950;">
                      Booking Processed ✅
                    </div>
                    <div style="margin-top:10px;font-size:13px;line-height:1.6;color:rgba(255,255,255,.9);">
                      Your request has been processed by our travel ops team. Attached documents (if any) are included with this email.
                    </div>

                    <div style="height:12px;"></div>

                    <div style="display:inline-block;padding:8px 10px;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);
                                color:#ffffff;font-size:12px;font-weight:900;">
                      Trip: ${escapeHtml(seg)}
                    </div>

                    ${
                      totalBookingAmount
                        ? `<span style="display:inline-block;margin-left:8px;padding:8px 10px;border-radius:999px;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.16);
                                color:#ffffff;font-size:12px;font-weight:900;">
                            Booking Amount: ₹${escapeHtml(moneyINR(totalBookingAmount))}
                          </span>`
                        : ""
                    }

                    ${
                      ticketId
                        ? `<span style="display:inline-block;margin-left:8px;padding:8px 10px;border-radius:999px;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.16);
                                color:#ffffff;font-size:12px;font-weight:900;">
                            Ticket: ${ticketId}
                          </span>`
                        : ""
                    }
                  </td>
                </tr>
                <tr><td style="height:4px;background:${accent};"></td></tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:0 6px;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
                style="background:#0b1220;border:1px solid rgba(148,163,184,0.18);border-radius:22px;
                       box-shadow:0 18px 60px rgba(0,0,0,.35);overflow:hidden;">
                <tr>
                  <td style="padding:18px;font-family:Arial,sans-serif;">

                    <div style="padding:14px 14px;border-radius:18px;background:rgba(255,255,255,0.04);border:1px solid rgba(148,163,184,0.16);">
                      <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#94a3b8;font-weight:900;">
                        Summary
                      </div>
                      <div style="margin-top:10px;color:#e2e8f0;font-size:13px;line-height:1.65;">
                        <b style="color:#f8fafc;">Requester:</b> ${requesterEmail}<br/>
                        <b style="color:#f8fafc;">Processed by:</b> ${processedByName || processedByEmail}
                      </div>
                    </div>

                    ${
                      safeComment
                        ? `<div style="margin-top:12px;padding:14px 14px;border-radius:18px;background:rgba(2,6,23,0.60);border:1px solid rgba(148,163,184,0.16);">
                            <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:900;color:#94a3b8;">
                              Ops note
                            </div>
                            <div style="margin-top:8px;font-size:13px;line-height:1.65;color:#e2e8f0;">
                              ${safeComment}
                            </div>
                          </div>`
                        : ""
                    }

                    <div style="margin-top:16px;">
                      <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#94a3b8;font-weight:900;">
                        Itinerary (Structured)
                      </div>
                      ${itineraryBlock}
                    </div>

                    <div style="margin-top:16px;padding:14px 14px;border-radius:18px;background:rgba(255,255,255,0.04);border:1px solid rgba(148,163,184,0.16);">
                      <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#94a3b8;font-weight:900;">
                        Documents Attached
                      </div>
                      <div style="margin-top:8px;color:#cbd5e1;font-size:13px;line-height:1.6;">
                        ${attList}
                      </div>
                    </div>

                    <div style="margin-top:16px;color:${slate};font-size:12px;line-height:1.7;">
                      If any detail looks incorrect, connect to your Relationship Manager — our concierge team will correct it quickly.
                    </div>

                  </td>
                </tr>
              </table>

              <div style="padding:14px 6px 0 6px;font-family:Arial,sans-serif;font-size:12px;color:#64748b;line-height:1.6;text-align:center;">
                © Plumtrips • Crafted for seamless journeys.
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
        <b style="color:${ink};">Requested by:</b> ${requesterName} &lt;${requesterEmail}&gt;
      </div>
    </div>
  `;

  const rows = items
    .map((it, idx) => {
      const title = escapeHtml(String(it?.title || it?.type || "Item").trim());
      const desc = escapeHtml(firstLine(it?.description || "", 240));
      const qty = it?.qty != null ? escapeHtml(String(it.qty)) : "—";
      const price = it?.price != null ? `₹${escapeHtml(moneyINR(it.price))}` : "—";

      const meta = pickMeta(it);
      const metaBlock = meta && Object.keys(meta).length ? metaTableHtml(meta) : "";

      const typeLabel = escapeHtml(serviceTypeOfItem(it).toUpperCase());

      return `
        <tr>
          <td style="padding:0 0 12px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
              style="border:1px solid #e8eef6;border-radius:16px;background:#ffffff;overflow:hidden;">
              <tr>
                <td style="padding:14px 14px 0 14px;">
                  <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#64748b;font-weight:900;">
                    Item ${idx + 1} • ${typeLabel}
                  </div>

                  <div style="margin-top:8px;font-size:16px;font-weight:900;color:${ink};line-height:1.25;">
                    ${title}
                  </div>

                  ${
                    desc
                      ? `<div style="margin-top:8px;font-size:13px;line-height:1.6;color:${slate};">${desc}</div>`
                      : ""
                  }

                  <div style="height:10px;"></div>
                  ${metaBlock}

                  <div style="height:12px;"></div>
                </td>
              </tr>

              <tr>
                <td style="padding:12px 14px;border-top:1px solid #eef2f7;background:#fbfdff;">
                  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                    <tr>
                      <td style="font-size:12px;color:#64748b;font-weight:900;letter-spacing:.08em;text-transform:uppercase;">
                        Qty
                      </td>
                      <td align="right" style="font-size:12px;color:#64748b;font-weight:900;letter-spacing:.08em;text-transform:uppercase;">
                        Amount
                      </td>
                    </tr>
                    <tr>
                      <td style="padding-top:6px;font-size:14px;color:${ink};font-weight:900;">
                        ${qty}
                      </td>
                      <td align="right" style="padding-top:6px;font-size:14px;color:${ink};font-weight:900;">
                        ${price}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      `;
    })
    .join("");

  const itemsBlock = rows
    ? `
      <div style="margin-top:14px;">
        <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#64748b;font-weight:900;margin-bottom:10px;">
          Full Itinerary (All Items)
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          ${rows}
        </table>
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
            style="display:inline-block;text-decoration:none;background:${brand};color:#ffffff;
                   padding:14px 18px;border-radius:14px;font-size:14px;font-weight:900;font-family:Arial,sans-serif;">
            ✅ Approve
          </a>

          <a href="${opts.declineUrl}"
            style="display:inline-block;text-decoration:none;background:#ffffff;color:#b42318;
                   padding:14px 18px;border-radius:14px;font-size:14px;font-weight:900;font-family:Arial,sans-serif;
                   border:1px solid #f2c3be;margin-left:10px;">
            ⛔ Reject
          </a>

          <a href="${opts.holdUrl}"
            style="display:inline-block;text-decoration:none;background:#ffffff;color:#334155;
                   padding:14px 18px;border-radius:14px;font-size:14px;font-weight:900;font-family:Arial,sans-serif;
                   border:1px solid #e2e8f0;margin-left:10px;">
            ⏳ On Hold
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
                        <b style="color:${ink};">Requested by:</b> ${requesterName} &lt;${requesterEmail}&gt;
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
