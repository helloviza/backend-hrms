/* ── Shared Hotel Voucher Generator ─────────────────────────────────────────
   Extracted from SBTHotelConfirmed.tsx so the post-booking confirmation page
   and any future "My Hotel Bookings" page share the same Sovereign Concierge
   voucher template without duplicating code.

   Phase 2a: relocated verbatim into @plumtrips/shared so the backend
   voucher-extract flow can render the SAME template. Behavior is unchanged;
   an optional showPrintButton flag (default true) lets non-browser callers
   suppress the print FAB later.
   ────────────────────────────────────────────────────────────────────────── */
import QRCode from "qrcode";
import { buildCancellationChips, TONE_PALETTE, parseTBODate, formatDateShort, isCancelDateValid as _isCancelDateValid, } from "./cancellationPolicy.js";
async function generateQRDataUrl(text) {
    try {
        return await QRCode.toDataURL(text, {
            width: 180,
            margin: 1,
            color: { dark: "#002a58", light: "#ffffff" },
            errorCorrectionLevel: "M",
        });
    }
    catch {
        return "";
    }
}
const BRAND_LOGO_URL = "https://plumtrips-assets.s3.amazonaws.com/email/plumtrips-email-logo.png";
export const parseCancelDate = parseTBODate;
export const isCancelDateValid = _isCancelDateValid;
export function formatCancelDate(dateStr) {
    const d = parseTBODate(dateStr || "");
    if (!d)
        return "N/A";
    return formatDateShort(d);
}
export function fmtDateShort(d) {
    if (!d)
        return "";
    const dt = new Date(d);
    if (isNaN(dt.getTime()))
        return d;
    return dt.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
export function fmtDayOfWeek(d) {
    if (!d)
        return "";
    const dt = new Date(d);
    if (isNaN(dt.getTime()))
        return "";
    return dt.toLocaleDateString("en-IN", { weekday: "long" });
}
export function extractFirstName(fullName) {
    if (!fullName || fullName.trim() === "")
        return "Valued Guest";
    const cleaned = fullName
        .replace(/^(Mr\.?|Mrs\.?|Ms\.?|Miss\.?|Dr\.?|Prof\.?)\s+/i, "")
        .trim();
    return cleaned.split(/\s+/)[0] || "Valued Guest";
}
function esc(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
export function parseHotelPolicies(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const d = raw;
    const conditions = Array.isArray(d.RateConditions) ? d.RateConditions : [];
    let checkInTime = null;
    let checkOutTime = null;
    for (const c of conditions) {
        if (typeof c !== "string")
            continue;
        const ciMatch = c.match(/CheckIn\s+Time[-–]Begin\s*:\s*(.+)/i);
        if (ciMatch && !checkInTime)
            checkInTime = ciMatch[1].trim();
        const coMatch = c.match(/CheckOut\s+Time\s*:\s*(.+)/i);
        if (coMatch && !checkOutTime)
            checkOutTime = coMatch[1].trim();
    }
    return { checkInTime, checkOutTime, minimumAge: null };
}
function decodeAndStripHtml(raw) {
    // TBO stores HTML-entity-encoded markup (e.g. &lt;li&gt;) — decode then strip tags
    return raw
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/<li[^>]*>/gi, " • ").replace(/<\/li>/gi, "")
        .replace(/<[^>]*>/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}
export function parseAdditionalConditions(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const d = raw;
    const hrd0 = (Array.isArray(d.HotelRoomsDetails) ? d.HotelRoomsDetails[0] : null);
    // TBO puts RateConditions at top-level; HRD[0] is a fallback for other response shapes
    const topRc = Array.isArray(d.RateConditions) ? d.RateConditions : [];
    const hrdRc = Array.isArray(hrd0?.RateConditions) ? hrd0.RateConditions : [];
    const rc = topRc.length > 0 ? topRc : hrdRc;
    const directFees = (d.OptionalFees || hrd0?.OptionalFees);
    let rcFees = null;
    for (const c of rc) {
        if (typeof c !== "string")
            continue;
        if (/^Optional Fees:/i.test(c)) {
            rcFees = decodeAndStripHtml(c.replace(/^Optional Fees:\s*/i, "").trim());
            break;
        }
    }
    const optionalFees = (directFees ? decodeAndStripHtml(directFees) : null) || rcFees || null;
    const directCards = (d.CardsAccepted || hrd0?.CardsAccepted);
    let rcCards = null;
    for (const c of rc) {
        if (typeof c !== "string")
            continue;
        if (/^Cards Accepted:/i.test(c)) {
            rcCards = c.replace(/^Cards Accepted:\s*/i, "").trim();
            break;
        }
    }
    const cardsAccepted = directCards || rcCards || null;
    if (!optionalFees && !cardsAccepted)
        return null;
    return {
        optionalFees,
        cardsAccepted,
        earlyCheckOutNote: "Early check-out will attract full cancellation charges unless otherwise specified.",
    };
}
export async function generateHotelVoucherHTML(params) {
    // Defensive guard — protects against direct-URL bypass where a user could load
    // the voucher page before the booking has been reconciled with the hotel.
    // The UI hides the trigger buttons during this window, but URL-level access
    // would still reach this function. Throw rather than silently render.
    if (params.reconciled !== true) {
        throw new Error("Cannot generate voucher: booking has not been reconciled with hotel. " +
            "Please wait for confirmation to complete.");
    }
    const { hotelName, hotelAddress, checkIn, checkOut, roomName, bookingId, confirmationNo, bookingRefNo, invoiceNumber, tboReferenceNo, roomDescription, rateConditions, amenities, guestFirstName, leadGuestName, inclusions, cancelPolicies, displayVoucherStatus, totalFare, logoBodyBase64, offers, hotelPolicies, additionalConditions, supportEmail = "hello@plumtrips.com", showPrintButton = true, isDemo = false, } = params;
    const demoWatermarkHtml = isDemo
        ? `<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:120px;font-weight:bold;color:rgba(208,101,73,0.15);z-index:9999;pointer-events:none;white-space:nowrap;">SAMPLE — NOT A REAL RESERVATION</div>`
        : "";
    const demoFooterDisclaimerHtml = isDemo
        ? `<div style="text-align:center;margin:24px 40px;padding:12px 16px;background:#FFF4E5;border:1px solid #D06549;color:#7A3A1E;font-size:11px;font-style:italic;">This document is a sample generated for demonstration purposes only. No booking has been made and no service has been confirmed with any airline, hotel, or supplier.</div>`
        : "";
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((hotelName || "") + " " + (hotelAddress || ""))}`;
    const qrDataUrl = await generateQRDataUrl(mapsUrl);
    const chips = buildCancellationChips(cancelPolicies, { checkOut });
    const cancelSectionHtml = cancelPolicies.length > 0
        ? `<div style="margin-bottom:20px;">
  <h2 style="font-family:'DM Sans',system-ui,sans-serif;font-size:11px;letter-spacing:1.5px;color:#0A1628;margin:0 0 16px 0;text-transform:uppercase;">Cancellation Policy</h2>
  <div style="font-family:'DM Sans',system-ui,sans-serif;font-size:10px;color:#1a1a1a;line-height:1.6;display:flex;flex-direction:column;gap:6px;">
    ${chips.length > 0
            ? chips.map((c) => {
                const palette = TONE_PALETTE[c.tone];
                return `<div style="background:${palette.background};color:${palette.color};border:1px solid ${palette.border};padding:6px 12px;border-radius:20px;font-size:11px;font-weight:600;line-height:1.4;display:inline-block;">${esc(palette.iconChar)} ${esc(c.label)}</div>`;
            }).join("")
            : `<div style="background:${TONE_PALETTE.success.background};color:${TONE_PALETTE.success.color};border:1px solid ${TONE_PALETTE.success.border};padding:6px 12px;border-radius:20px;font-size:11px;font-weight:600;line-height:1.4;display:inline-block;">${TONE_PALETTE.success.iconChar} Free cancellation available</div>`}
  </div>
</div>
<div style="height:1px;background:#e5e2db;margin-bottom:24px;"></div>`
        : "";
    void totalFare;
    const inclusionsHtml = inclusions.length > 0
        ? inclusions.map((inc) => `<li style="display:flex;align-items:flex-start;gap:8px;padding:4px 0;font-size:12px;color:#374151;"><span style="color:#065f46;flex-shrink:0;">&#10003;</span><span>${esc(inc)}</span></li>`).join("")
        : `<li style="font-size:12px;color:#6B7280;padding:4px 0;">Standard room — see hotel for amenities</li>`;
    const enabledOffers = (offers ?? []).filter((o) => o.enabled);
    const hotelOffersHtml = enabledOffers.length > 0
        ? enabledOffers.map((o) => `<div style="margin-top:20px;padding:14px 0;border-top:1px solid #e5e2db;border-bottom:1px solid #e5e2db;font-family:'DM Sans',system-ui,sans-serif;display:flex;align-items:center;justify-content:space-between;gap:16px;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:9px;font-weight:700;color:#fe6a34;text-transform:uppercase;letter-spacing:2px;margin-bottom:4px;">PARTNER EXCLUSIVE</div>
        <div style="font-size:12px;font-weight:600;color:#0A1628;line-height:1.3;margin-bottom:2px;">${esc(o.title)}</div>
        ${o.description ? `<div style="font-size:10px;color:#4a4a4a;line-height:1.4;">${esc(o.description)}</div>` : ''}
      </div>
      ${o.ctaUrl ? `<a href="${esc(o.ctaUrl)}" target="_blank" rel="noopener" style="flex-shrink:0;font-size:10px;font-weight:700;color:#0A1628;text-decoration:none;padding:6px 12px;border:1.5px solid #B89968;border-radius:4px;letter-spacing:1px;text-transform:uppercase;white-space:nowrap;">${esc(o.ctaText || 'Learn More')} →</a>` : ''}
    </div>`).join('')
        : '';
    const additionalConditionsHtml = additionalConditions ? (() => {
        const feeLine = additionalConditions.optionalFees
            ? `<div style="margin-bottom:8px;"><strong>Optional Fees:</strong> ${esc(additionalConditions.optionalFees)}</div>`
            : "";
        const cardLine = additionalConditions.cardsAccepted
            ? `<div style="margin-bottom:8px;"><strong>Cards Accepted at Hotel:</strong> ${esc(additionalConditions.cardsAccepted)}</div>`
            : "";
        const noteLine = additionalConditions.earlyCheckOutNote
            ? `<div style="margin-bottom:0;"><strong>Note:</strong> ${esc(additionalConditions.earlyCheckOutNote)}</div>`
            : "";
        return `<div style="margin-bottom:20px;padding:10px 14px;background:#FBF9F4;border-left:3px solid #B89968;border-radius:4px;">
  <h2 style="font-family:'DM Sans',system-ui,sans-serif;font-size:11px;letter-spacing:1.5px;color:#0A1628;margin:0 0 12px 0;text-transform:uppercase;">
    &#9888; Additional Fees &#8212; Payable Directly at Hotel
  </h2>
  <p style="font-family:'DM Sans',system-ui,sans-serif;font-size:10.5px;color:#4a4a4a;line-height:1.6;margin:0 0 10px 0;font-style:italic;">
    The following are NOT included in your Plumtrips booking and will be settled directly with the property:
  </p>
  <div style="font-family:'DM Sans',system-ui,sans-serif;font-size:10.5px;color:#1a1a1a;line-height:1.7;">
    ${feeLine}${cardLine}${noteLine}
  </div>
</div>`;
    })() : "";
    const hotelPoliciesHtml = hotelPolicies ? (() => {
        const ciLine = hotelPolicies.checkInTime
            ? `<div style="margin-bottom:6px;"><span style="color:#6b6b6b;">Check-in:</span> <strong>${esc(hotelPolicies.checkInTime)} onwards</strong></div>`
            : "";
        const coLine = hotelPolicies.checkOutTime
            ? `<div style="margin-bottom:6px;"><span style="color:#6b6b6b;">Check-out:</span> <strong>by ${esc(hotelPolicies.checkOutTime)}</strong></div>`
            : "";
        return `<div style="margin-bottom:20px;">
  <h2 style="font-family:'DM Sans',system-ui,sans-serif;font-size:11px;letter-spacing:1.5px;color:#0A1628;margin:0 0 16px 0;text-transform:uppercase;">Hotel Policies</h2>
  <div style="font-family:'DM Sans',system-ui,sans-serif;font-size:10px;color:#1a1a1a;line-height:1.6;">
    ${ciLine}${coLine}<div style="margin-bottom:6px;"><span style="color:#6b6b6b;">Minimum age:</span> <strong>18 years</strong> — government-issued ID required</div>
    <div style="margin-bottom:6px;"><span style="color:#6b6b6b;">At check-in:</span> Present this voucher at reception</div>
  </div>
</div>
<div style="height:1px;background:#e5e2db;margin-bottom:24px;"></div>`;
    })() : "";
    const printButtonHtml = showPrintButton
        ? `<div class="no-print" style="position:fixed;bottom:24px;right:24px;z-index:999;">
  <button onclick="window.print()" style="background:#002a58;color:#ffffff;border:none;border-radius:10px;padding:12px 24px;font-size:13px;font-weight:700;font-family:Manrope,sans-serif;cursor:pointer;box-shadow:0 4px 20px rgba(0,42,88,0.3);">&#128438; Print / Save PDF</button>
</div>`
        : "";
    const __html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Hotel Voucher — ${esc(hotelName)} | PlumTrips</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&family=Playfair+Display:ital,wght@0,700;1,700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Manrope',sans-serif;background:#f8f9fa;color:#1A1A1A;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  @media print{body{background:white;}.no-print{display:none!important;}}
</style>
</head>
<body>
${demoWatermarkHtml}

<div style="height:3px;background:linear-gradient(to right,#C5A059,#002a58,#C5A059);"></div>

${printButtonHtml}

<div style="background:#002a58;padding:20px 40px;display:flex;justify-content:space-between;align-items:center;">
  <div style="display:flex;align-items:center;">
    <img src="${BRAND_LOGO_URL}" style="height:32px;object-fit:contain;" alt="Plumtrips"/>
  </div>
  <div style="text-align:right;">
    <div style="font-size:9px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:3px;">Hotel Voucher</div>
    <div style="font-size:11px;color:#C5A059;font-weight:700;text-transform:uppercase;letter-spacing:2px;margin-top:2px;">${esc(displayVoucherStatus)}</div>
  </div>
</div>

<div style="max-width:860px;margin:0 auto;padding:20px 40px 24px;">

  <div style="margin-bottom:24px;">
    <div style="font-size:10px;font-weight:700;color:#002a58;text-transform:uppercase;letter-spacing:3px;border:1px solid rgba(0,42,88,0.2);display:inline-block;padding:3px 10px;border-radius:20px;background:rgba(0,42,88,0.05);margin-bottom:12px;">Booking Confirmed</div>
    <h1 style="font-size:30px;font-weight:900;color:#002a58;letter-spacing:-1px;line-height:1.15;margin-bottom:6px;font-family:Manrope,sans-serif;">Your Sanctuary Awaits, ${esc(guestFirstName)}.</h1>
    <h2 style="font-size:20px;color:#ab3500;margin-bottom:8px;font-family:'Playfair Display',serif;font-style:italic;font-weight:700;">Enjoy Your Stay.</h2>
    <p style="font-size:14px;color:#6B7280;">Your reservation at ${esc(hotelName)} is confirmed.</p>
  </div>

  <div style="display:flex;gap:0;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 20px 40px rgba(0,42,88,0.06);margin-bottom:20px;">
    <div style="flex:3;padding:32px;border-right:1px dashed rgba(195,198,210,0.5);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;">
        <div>
          <div style="display:flex;align-items:baseline;gap:3px;">
            ${logoBodyBase64 ? `<img src="${logoBodyBase64}" style="height:28px;object-fit:contain;" alt="Plumtrips"/>` : `<span style="font-size:18px;font-weight:900;color:#002a58;letter-spacing:-1px;">Plum</span><span style="font-size:18px;font-weight:900;color:#fe6a34;letter-spacing:-1px;">trips</span>`}
          </div>
          <div style="font-size:11px;color:#6B7280;margin-top:2px;">Hotel Voucher</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:9px;color:#6B7280;text-transform:uppercase;letter-spacing:2px;margin-bottom:4px;">Status</div>
          <span style="background:#004c02;color:#5fc150;font-size:9px;font-weight:700;padding:4px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:2px;">${esc(displayVoucherStatus.toUpperCase())}</span>
        </div>
      </div>
      <div style="position:relative;">
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-start;pointer-events:none;overflow:hidden;">
          <span style="font-size:120px;font-weight:900;color:#002a58;opacity:0.03;white-space:nowrap;font-family:'Playfair Display',serif;">&#127970;</span>
        </div>
        <div style="font-size:52px;font-weight:700;color:#002a58;margin-bottom:10px;font-family:'Playfair Display',serif;font-style:italic;line-height:1.2;position:relative;">${esc(hotelName)}</div>
      </div>
      ${hotelAddress ? `<div style="display:flex;align-items:flex-start;gap:4px;margin-bottom:24px;"><span>&#128205;</span><div style="font-size:12px;color:#6B7280;line-height:1.5;">${esc(hotelAddress)}</div></div>` : ""}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;">
        <div>
          <div style="font-size:9px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:2px;margin-bottom:6px;">Check-in</div>
          <div style="font-size:26px;font-weight:900;color:#002a58;line-height:1;">${esc(fmtDateShort(checkIn))}</div>
          <div style="font-size:12px;color:#6B7280;margin-top:3px;">${esc(fmtDayOfWeek(checkIn))}${checkIn ? ", 14:00" : ""}</div>
        </div>
        <div>
          <div style="font-size:9px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:2px;margin-bottom:6px;">Check-out</div>
          <div style="font-size:26px;font-weight:900;color:#002a58;line-height:1;">${esc(fmtDateShort(checkOut))}</div>
          <div style="font-size:12px;color:#6B7280;margin-top:3px;">${esc(fmtDayOfWeek(checkOut))}${checkOut ? ", 12:00" : ""}</div>
        </div>
      </div>
      <div style="background:#f3f4f5;border-radius:10px;padding:14px;display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
        <div>
          <div style="font-size:9px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:3px;">Booking ID</div>
          <div style="font-weight:700;color:#002a58;font-size:12px;word-break:break-all;">${esc(bookingId || "—")}</div>
        </div>
        <div>
          <div style="font-size:9px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:3px;">Room Type</div>
          <div style="font-weight:700;color:#002a58;font-size:12px;">${esc(roomName)}</div>
        </div>
        <div>
          <div style="font-size:9px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:3px;">Primary Guest</div>
          <div style="font-weight:700;color:#002a58;font-size:12px;">${esc(leadGuestName)}</div>
        </div>
      </div>
    </div>
    <div style="flex:1;background:#002a58;padding:28px;color:#ffffff;display:flex;flex-direction:column;gap:10px;min-width:170px;box-shadow:inset 0 0 30px rgba(0,64,128,0.5),0 20px 40px rgba(0,42,88,0.3);">
      <div style="font-size:9px;font-weight:700;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:3px;margin-bottom:2px;">Reservation Reference</div>
      ${tboReferenceNo ? `<div style="background:#C5A059;padding:12px;border-radius:10px;">
        <div style="font-size:9px;font-weight:700;color:rgba(0,0,0,0.6);margin-bottom:3px;text-transform:uppercase;letter-spacing:1px;">HOTEL REFERENCE — SHOW AT CHECK-IN</div>
        <div style="font-size:16px;font-weight:900;letter-spacing:2px;color:#1a1a1a;">${esc(tboReferenceNo)}</div>
      </div>` : ""}
      <div style="background:#004080;padding:12px;border-radius:10px;">
        <div style="font-size:9px;opacity:0.6;margin-bottom:3px;">PLUMTRIPS BOOKING ID — FOR SUPPORT INQUIRIES</div>
        <div style="font-size:14px;font-weight:900;letter-spacing:1px;">${esc(bookingId || "—")}</div>
      </div>
      <div style="font-size:9px;opacity:0.7;text-align:center;padding:6px 0 2px;">Need help? Email hello@plumtrips.com</div>
      <div style="background:#ffffff;padding:10px;border-radius:10px;text-align:center;margin-top:4px;">
        ${qrDataUrl ? `<img src="${qrDataUrl}" style="width:108px;height:108px;border-radius:4px;display:block;margin:0 auto;" alt="Hotel Directions QR"/>` : `<div style="width:108px;height:108px;background:#f0f0f0;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#002a58;text-align:center;margin:0 auto;">Directions</div>`}
        <div style="font-size:9px;font-weight:700;color:#002a58;text-transform:uppercase;letter-spacing:2px;margin-top:6px;">SCAN FOR DIRECTIONS</div>
      </div>
      <div style="border-top:1px solid rgba(255,255,255,0.15);padding-top:10px;margin-top:2px;text-align:center;">
        <div style="font-size:11px;opacity:0.4;font-family:'Playfair Display',serif;font-style:italic;">Plumtrips Digital Voucher</div>
      </div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
    <div style="background:#ffffff;border-radius:12px;padding:20px;box-shadow:0 4px 20px rgba(0,42,88,0.04);">
      <div style="font-size:10px;font-weight:800;color:#002a58;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px;">What&apos;s Included</div>
      <ul style="list-style:none;padding:0;margin:0;">${inclusionsHtml}</ul>
    </div>
    <div style="background:#ffffff;border-radius:12px;padding:20px;box-shadow:0 4px 20px rgba(0,42,88,0.04);">
      <div style="font-size:10px;font-weight:800;color:#002a58;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px;">Check-in Information</div>
      <ul style="list-style:none;padding:0;margin:0;">
        <li style="display:flex;gap:8px;padding:4px 0;font-size:12px;color:#374151;"><span>&#8226;</span><span>Check-in from 14:00 onwards</span></li>
        <li style="display:flex;gap:8px;padding:4px 0;font-size:12px;color:#374151;"><span>&#8226;</span><span>Early check-in subject to availability</span></li>
        <li style="display:flex;gap:8px;padding:4px 0;font-size:12px;color:#374151;"><span>&#8226;</span><span>Government ID required at check-in</span></li>
        <li style="display:flex;gap:8px;padding:4px 0;font-size:12px;color:#374151;"><span>&#8226;</span><span>Present this voucher at reception</span></li>
      </ul>
    </div>
  </div>

  ${hotelOffersHtml}

  ${roomDescription ? `<div style="background:#ffffff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 4px 20px rgba(0,42,88,0.04);">
    <div style="font-size:10px;font-weight:800;color:#002a58;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;">Room Description</div>
    <p style="font-size:12px;color:#374151;line-height:1.6;margin:0;">${esc(roomDescription)}</p>
  </div>` : ""}

  ${rateConditions && rateConditions.length > 0 ? `<div style="background:#ffffff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 4px 20px rgba(0,42,88,0.04);">
    <div style="font-size:10px;font-weight:800;color:#002a58;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;">Rate Conditions</div>
    <ul style="list-style:none;padding:0;margin:0;">${rateConditions.map((c) => `<li style="display:flex;align-items:flex-start;gap:8px;padding:4px 0;font-size:12px;color:#374151;"><span style="color:#92400e;flex-shrink:0;">&#8226;</span><span>${esc(c)}</span></li>`).join("")}</ul>
  </div>` : ""}

  ${amenities && amenities.length > 0 ? `<div style="background:#ffffff;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 4px 20px rgba(0,42,88,0.04);">
    <div style="font-size:10px;font-weight:800;color:#002a58;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;">Amenities</div>
    <p style="font-size:12px;color:#374151;margin:0;">${amenities.map((a) => esc(a)).join(" &bull; ")}</p>
  </div>` : ""}

</div>

<div style="break-before:page;page-break-before:always;max-width:860px;margin:0 auto;padding:28px 40px 48px;">

  <div style="text-align:right;font-size:9px;letter-spacing:1.5px;color:#6b6b6b;margin-bottom:24px;">
    ${esc(hotelName.toUpperCase())} &bull; TERMS &amp; CONDITIONS
  </div>

  <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:32px;color:#0A1628;margin:0 0 8px 0;">
    Important Booking Terms &amp; Conditions
  </h1>

  <p style="font-family:'DM Sans',system-ui,sans-serif;font-size:11px;color:#6b6b6b;font-style:italic;margin:0 0 28px 0;">
    Please read carefully. By proceeding with this booking, you accept these terms.
  </p>

  <div style="height:2px;background:linear-gradient(to right,#B89968,transparent);margin-bottom:24px;"></div>

  ${cancelSectionHtml}

  ${hotelPoliciesHtml}

  ${additionalConditionsHtml}

  <ol style="font-family:'DM Sans',system-ui,sans-serif;font-size:10.5px;color:#1a1a1a;line-height:1.45;padding-left:20px;margin:0;">
    <li style="margin-bottom:6px;">You must present a photo ID at the time of check-in. Hotel may ask for credit card or cash deposit for extra services at the time of check-in.</li>
    <li style="margin-bottom:6px;">All extra charges should be collected directly from clients prior to departure such as parking, phone calls, room service, city tax, etc.</li>
    <li style="margin-bottom:6px;">We don&apos;t accept any responsibility for additional expenses due to changes or delays in air, road, rail, sea or indeed of any other causes; all such expenses will have to be borne by passengers.</li>
    <li style="margin-bottom:6px;">In case of wrong residency &amp; nationality selected by user at the time of booking; the supplement charges may be applicable and need to be paid to the hotel by guest on check-in / check-out.</li>
    <li style="margin-bottom:6px;">Any special request for bed type, early check-in, late check-out, smoking rooms, etc., are not guaranteed as subject to availability at the time of check-in.</li>
    <li style="margin-bottom:6px;">Early check-out will attract full cancellation charges unless otherwise specified.</li>
    <li style="margin-bottom:6px;">In case of a late check-in by the guest, it is essential to inform Plumtrips support in advance to avoid the booking being marked as a no-show.</li>
    <li style="margin-bottom:6px;">Cancellation charges are governed by the cancellation policy specified in this voucher and will be processed as per the property&apos;s terms.</li>
    <li style="margin-bottom:6px;">Plumtrips acts as an authorised distributor and is not the owner or operator of the hotel property. Any disputes regarding the property&apos;s services should be raised with both the property and Plumtrips support concurrently.</li>
    <li style="margin-bottom:6px;">For any assistance, please contact Plumtrips support at hello@plumtrips.com or via your account dashboard.</li>
  </ol>

  <p style="font-family:'Cormorant Garamond',Georgia,serif;font-size:14px;color:#0A1628;font-style:italic;text-align:center;margin:20px 0 0 0;">
    Thank you for booking with Plumtrips. We wish you a pleasant stay.
  </p>
  ${demoFooterDisclaimerHtml}
  <div style="font-family:'DM Sans',system-ui,sans-serif;font-size:8px;color:#9ca3af;text-align:center;margin-top:16px;padding-top:12px;border-top:1px solid #e5e2db;">
    &copy; ${new Date().getFullYear()} Peachmint Trips and Planners Pvt. Ltd.
  </div>

</div>

</body>
</html>`;
    return __html;
}
