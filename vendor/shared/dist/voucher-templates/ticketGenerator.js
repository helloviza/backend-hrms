/* ── Shared Flight Ticket Generator ─────────────────────────────────────────
   Extracted from SBTConfirmed.tsx so both the post-booking confirmation page
   and the "My Bookings" history page can render the same Sovereign Concierge
   e-ticket template without duplicating code.

   Phase 2a: relocated verbatim into @plumtrips/shared so the backend
   voucher-extract flow can render the SAME template. The only browser-coupled
   line (import.meta.env?.VITE_LOGO_URL) is parameterized as `logoUrl`, with the
   exact current S3 default so frontend callers passing nothing are unaffected.
   ────────────────────────────────────────────────────────────────────────── */
import QRCode from "qrcode";
const DEFAULT_LOGO_URL = "https://plumtrips-assets.s3.amazonaws.com/email/plumtrips-email-logo.png";
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
export const CABIN_MAP = {
    1: "All", 2: "Economy", 3: "Prem Economy",
    4: "Business", 5: "Prem Business", 6: "First",
};
export function getWebCheckInUrl(airline, pnr) {
    const a = (airline ?? "").toLowerCase();
    if (a.includes("indigo") || a.includes("6e"))
        return `https://www.goindigo.in/web-check-in.html?pnr=${pnr}`;
    if (a.includes("spicejet") || a.includes("sg"))
        return `https://www.spicejet.com/check-in?pnr=${pnr}`;
    if (a.includes("air india") || a.includes("vistara") || a.includes(" uk") || a.includes(" ai"))
        return `https://www.airindia.in/web-check-in.aspx?pnr=${pnr}`;
    if (a.includes("go first") || a.includes("gofirst") || a.includes("g8"))
        return `https://www.flygofirst.com/check-in?pnr=${pnr}`;
    if (a.includes("airasia") || a.includes("i5"))
        return `https://www.airasia.com/check-in/en/gb?pnr=${pnr}`;
    if (a.includes("akasa") || a.includes("qp"))
        return `https://www.akasaair.com/check-in?pnr=${pnr}`;
    return `https://www.google.com/search?q=${encodeURIComponent(airline)}+web+check+in+${pnr}`;
}
function extractFirstName(name) {
    if (!name?.trim())
        return "Traveller";
    return name
        .replace(/^(Mr\.?|Mrs\.?|Ms\.?|Miss\.?|Dr\.?|Prof\.?)\s+/i, "")
        .trim()
        .split(/\s+/)[0] || "Traveller";
}
function esc(s) {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function fmtTime(dt) {
    try {
        const d = new Date(dt);
        if (isNaN(d.getTime()))
            return dt;
        return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
    }
    catch {
        return dt;
    }
}
function fmtDate(dt) {
    try {
        const d = new Date(dt);
        if (isNaN(d.getTime()))
            return dt;
        return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    }
    catch {
        return dt;
    }
}
function ticketFormatDuration(dep, arr) {
    try {
        const a = new Date(dep).getTime();
        const b = new Date(arr).getTime();
        if (isNaN(a) || isNaN(b))
            return "";
        const mins = Math.round((b - a) / 60000);
        if (mins <= 0)
            return "";
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${h}h ${m}m`;
    }
    catch {
        return "";
    }
}
function cityName(iata) {
    const map = {
        DEL: "Delhi", BOM: "Mumbai", BLR: "Bengaluru", MAA: "Chennai",
        CCU: "Kolkata", HYD: "Hyderabad", GOI: "Goa", AMD: "Ahmedabad",
        PNQ: "Pune", COK: "Kochi", JAI: "Jaipur", LKO: "Lucknow",
        GAU: "Guwahati", SXR: "Srinagar", IXC: "Chandigarh",
    };
    return map[iata.toUpperCase()] || iata;
}
function airportFullName(iata) {
    const map = {
        DEL: "Indira Gandhi International Airport",
        BOM: "Chhatrapati Shivaji Maharaj International Airport",
        BLR: "Kempegowda International Airport",
        MAA: "Chennai International Airport",
        CCU: "Netaji Subhas Chandra Bose International Airport",
        HYD: "Rajiv Gandhi International Airport",
        GOI: "Goa International Airport",
        AMD: "Sardar Vallabhbhai Patel International Airport",
        PNQ: "Pune Airport",
        COK: "Cochin International Airport",
    };
    return map[iata.toUpperCase()] || "";
}
function generateBarcodeSVG(value) {
    const bars = [];
    let x = 0;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        const w = (code % 3) + 1;
        bars.push(`<rect x="${x}" y="0" width="${w}" height="40" fill="#1A1A2E"/>`);
        x += w + 2;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="40" viewBox="0 0 ${x} 40">${bars.join("")}</svg>`;
}
export function generateFlightSection(b, segmentLabel) {
    const cabinLabel = CABIN_MAP[b.cabin] ?? "Economy";
    const depDate = fmtDate(b.departureTime);
    const arrDate = fmtDate(b.arrivalTime);
    const depTime = fmtTime(b.departureTime);
    const arrTime = fmtTime(b.arrivalTime);
    const duration = ticketFormatDuration(b.departureTime, b.arrivalTime);
    const originCity = b.origin.city || cityName(b.origin.code);
    const destCity = b.destination.city || cityName(b.destination.code);
    const originAirport = airportFullName(b.origin.code);
    const destAirport = airportFullName(b.destination.code);
    const leadPax = b.passengers?.find(p => p.isLead) || b.passengers?.[0];
    const leadName = leadPax ? `${leadPax.title || ""} ${leadPax.firstName || ""} ${leadPax.lastName || ""}`.trim() : "—";
    return `<div style="background:linear-gradient(135deg,#ffffff 0%,#f8f9ff 100%);border-radius:16px;padding:36px;box-shadow:0 20px 40px rgba(0,42,88,0.06);position:relative;overflow:hidden;margin-bottom:20px;">
  <div style="position:absolute;top:-40px;right:-40px;width:160px;height:160px;background:rgba(0,42,88,0.04);border-radius:50%;pointer-events:none;"></div>
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;">
    <div style="font-size:10px;font-weight:800;color:#C5A059;text-transform:uppercase;letter-spacing:3px;">${esc(segmentLabel)}</div>
    <div style="width:1px;height:16px;background:#E5E7EB;flex-shrink:0;"></div>
    <div style="font-size:13px;font-weight:700;color:#002a58;">${esc(b.airlineName)} ${esc(b.flightNumber)} &bull; ${esc(cabinLabel)}</div>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;">
    <div>
      <div style="font-size:72px;font-weight:900;color:#002a58;letter-spacing:-2px;line-height:1;">${esc(b.origin.code)}</div>
      <div style="font-weight:700;font-size:14px;margin-top:4px;color:#1A1A1A;">${esc(originCity)}</div>
      ${originAirport ? `<div style="color:#6B7280;font-size:11px;margin-top:2px;">${esc(originAirport)}</div>` : ""}
      <div style="font-size:26px;font-weight:300;color:#002a58;margin-top:14px;">${esc(depTime)}</div>
      <div style="font-size:9px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:2px;margin-top:4px;">${esc(depDate)}</div>
    </div>
    <div style="flex:1;text-align:center;padding:0 20px;padding-top:6px;">
      <div style="font-size:9px;font-weight:700;color:#C5A059;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px;">${esc(duration)}</div>
      <div style="height:1px;background:#E5E7EB;position:relative;">
        <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(45deg);width:7px;height:7px;background:#ffffff;border:1.5px solid #002a58;"></div>
      </div>
      <div style="font-size:22px;margin-top:10px;color:#002a58;">&#9992;</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:72px;font-weight:900;color:#002a58;letter-spacing:-2px;line-height:1;">${esc(b.destination.code)}</div>
      <div style="font-weight:700;font-size:14px;margin-top:4px;color:#1A1A1A;">${esc(destCity)}</div>
      ${destAirport ? `<div style="color:#6B7280;font-size:11px;margin-top:2px;">${esc(destAirport)}</div>` : ""}
      <div style="font-size:26px;font-weight:300;color:#002a58;margin-top:14px;">${esc(arrTime)}</div>
      <div style="font-size:9px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:2px;margin-top:4px;">${esc(arrDate)}</div>
    </div>
  </div>
  <div style="border-top:1px dashed #E5E7EB;padding-top:20px;display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">
    <div>
      <div style="font-size:9px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">Booking ID</div>
      <div style="font-weight:700;color:#002a58;font-size:12px;">${esc(b.bookingId)}</div>
    </div>
    <div>
      <div style="font-size:9px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">Passenger</div>
      <div style="font-weight:700;color:#002a58;font-size:12px;">${esc(leadName)}</div>
    </div>
    <div>
      <div style="font-size:9px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">PNR</div>
      <div style="font-weight:700;color:#002a58;font-size:12px;letter-spacing:2px;">${esc(b.pnr)}</div>
    </div>
    <div>
      <div style="font-size:9px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">Ticket #</div>
      <div style="font-weight:700;color:#002a58;font-size:12px;">${esc(b.ticketId || "—")}</div>
    </div>
  </div>
</div>`;
}
export async function generateReturnPageHTML(rb, logoUrl = DEFAULT_LOGO_URL) {
    const rbIsDemo = !!rb.isDemo;
    const rbDemoWatermarkHtml = rbIsDemo
        ? `<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:120px;font-weight:bold;color:rgba(208,101,73,0.15);z-index:9999;pointer-events:none;white-space:nowrap;">SAMPLE — NOT A REAL RESERVATION</div>`
        : "";
    const rbPaxRows = (rb.passengers ?? []).map((p) => {
        const pt = p?.paxType ?? "adult";
        const paxType = pt === "adult" || pt === "1" ? "Adult" : pt === "child" || pt === "2" ? "Child" : pt === "infant" || pt === "3" ? "Infant" : "Adult";
        return `<tr style="border-bottom:1px solid #f3f4f6;">
      <td style="padding:12px 16px;font-weight:600;color:#002a58;font-size:13px;">${esc(p?.title ?? "")} ${esc(p?.firstName ?? "")} ${esc(p?.lastName ?? "")}</td>
      <td style="padding:12px 16px;color:#6B7280;font-size:13px;">${paxType}</td>
      <td style="padding:12px 16px;font-family:monospace;font-size:11px;color:#6B7280;text-align:center;">${esc(rb.ticketId || "—")}</td>
      <td style="padding:12px 16px;font-weight:700;text-align:center;color:#002a58;">&mdash;</td>
      <td style="padding:12px 16px;color:#374151;text-align:center;font-size:12px;">15 kg</td>
      <td style="padding:12px 16px;color:#374151;text-align:center;font-size:12px;">7 kg</td>
      <td style="padding:12px 16px;color:#374151;text-align:center;font-size:12px;">&mdash;</td>
    </tr>`;
    }).join("");
    const rbBarcodesHtml = (rb.passengers ?? []).map((p, i) => {
        const ref = `${rb.pnr}-${i + 1}`;
        return `<div style="margin-bottom:12px;">
      <p style="font-size:11px;color:#9CA3AF;margin:0 0 4px;">${esc(p?.firstName ?? "")} ${esc(p?.lastName ?? "")} &mdash; Barcode:</p>
      ${generateBarcodeSVG(ref)}
      <p style="font-size:10px;color:#9CA3AF;font-family:monospace;margin:2px 0 0;letter-spacing:0.5px;">${esc(ref)}</p>
    </div>`;
    }).join("");
    const rbOriginCity = rb.origin.city || cityName(rb.origin.code);
    const rbDestCity = rb.destination.city || cityName(rb.destination.code);
    const rbLeadPax = rb.passengers?.find(p => p.isLead) || rb.passengers?.[0];
    const rbFirstName = esc(extractFirstName(rbLeadPax?.firstName || ""));
    const rbCheckInUrl = getWebCheckInUrl(rb.airlineName, rb.pnr);
    const rbQrDataUrl = await generateQRDataUrl(rbCheckInUrl);
    return `
<div style="page-break-before:always;">
  ${rbDemoWatermarkHtml}
  <div style="height:3px;background:linear-gradient(to right,#C5A059,#002a58,#C5A059);"></div>
  <div style="background:#002a58;padding:20px 40px;display:flex;justify-content:space-between;align-items:center;">
    <div style="display:flex;align-items:center;">
      <img src="${logoUrl}" style="height:36px;object-fit:contain;" alt="Plumtrips"/>
    </div>
    <div style="text-align:right;">
      <div style="font-size:9px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:3px;">Return E-Ticket</div>
      <div style="font-size:10px;color:#C5A059;font-weight:700;text-transform:uppercase;letter-spacing:2px;margin-top:2px;">CONFIRMED</div>
    </div>
  </div>

  <div style="max-width:860px;margin:0 auto;padding:28px 40px 40px;">
    <div style="margin-bottom:24px;">
      <div style="font-size:10px;font-weight:700;color:#002a58;text-transform:uppercase;letter-spacing:3px;border:1px solid rgba(0,42,88,0.2);display:inline-block;padding:3px 10px;border-radius:20px;background:rgba(0,42,88,0.05);margin-bottom:12px;">Return Journey</div>
      <h1 style="font-size:28px;font-weight:900;color:#002a58;letter-spacing:-1px;line-height:1.1;margin-bottom:6px;font-family:Manrope,sans-serif;">Welcome Back, ${rbFirstName}.</h1>
      <p style="font-size:14px;color:#6B7280;">${esc(rbOriginCity)} &rarr; ${esc(rbDestCity)} &bull; Booking ID: ${esc(rb.bookingId)}</p>
    </div>

    <div style="display:flex;gap:24px;align-items:flex-start;margin-bottom:24px;">
      <div style="flex:3;min-width:0;">
        ${generateFlightSection(rb, "Return Flight")}
      </div>
      <div style="flex:1;min-width:160px;display:flex;flex-direction:column;gap:16px;">
        <div style="background:#002a58;border-radius:12px;padding:24px;color:#ffffff;text-align:center;">
          <div style="font-size:9px;font-weight:700;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:3px;margin-bottom:12px;">PNR</div>
          <div style="background:#004080;border-radius:8px;padding:12px;margin-bottom:14px;">
            <div style="font-size:22px;font-weight:900;letter-spacing:4px;">${esc(rb.pnr)}</div>
          </div>
          <div style="background:#ffffff;border-radius:8px;padding:10px;margin-bottom:8px;display:inline-block;">
            ${rbQrDataUrl ? `<img src="${rbQrDataUrl}" style="width:120px;height:120px;border-radius:4px;display:block;" alt="Check-in QR"/>` : `<div style="width:120px;height:120px;background:#f0f0f0;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#999;">PNR: ${esc(rb.pnr)}</div>`}
          </div>
          <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:2px;">Web Check-in</div>
        </div>
        <div style="background:#ffffff;border-radius:12px;padding:18px;box-shadow:0 4px 20px rgba(0,42,88,0.04);">
          <div style="font-size:10px;font-weight:800;color:#002a58;text-transform:uppercase;letter-spacing:2px;margin-bottom:14px;border-left:3px solid #C5A059;padding-left:12px;">Travel Advisory</div>
          <div style="font-size:10px;font-weight:700;color:#002a58;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Early Arrival</div>
          <div style="font-size:11px;color:#6B7280;line-height:1.5;margin-bottom:10px;">Arrive 3hrs early for intl, 2hrs domestic.</div>
          <div style="font-size:10px;font-weight:700;color:#002a58;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px;">Verification</div>
          <div style="font-size:11px;color:#6B7280;line-height:1.5;">Govt-issued photo ID required at security.</div>
        </div>
      </div>
    </div>

    <div style="background:#ffffff;border-radius:12px;overflow:hidden;margin-bottom:20px;box-shadow:0 4px 20px rgba(0,42,88,0.04);">
      <div style="background:#002a58;color:#ffffff;padding:12px 20px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Passenger Manifest &amp; Baggage Allowance</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f8f9fa;border-bottom:1px solid #E5E7EB;">
            <th style="text-align:left;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Passenger Name</th>
            <th style="text-align:left;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Type</th>
            <th style="text-align:center;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Ticket No</th>
            <th style="text-align:center;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Seat</th>
            <th style="text-align:center;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Check-in</th>
            <th style="text-align:center;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Cabin</th>
            <th style="text-align:center;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Meal</th>
          </tr>
        </thead>
        <tbody>${rbPaxRows}</tbody>
      </table>
      <div style="padding:16px 20px;background:#f8f9fa;border-top:1px solid #E5E7EB;">${rbBarcodesHtml}</div>
    </div>

    <div style="text-align:center;padding-top:8px;margin-bottom:20px;">
      <p style="font-size:11px;color:#9CA3AF;margin:0;">Page 2 of 2 &bull; Generated via PlumTrips &bull; ${esc(new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }))}</p>
    </div>
  </div>

  <div style="background:#002a58;padding:16px 40px;display:flex;justify-content:space-between;align-items:center;">
    <div style="display:flex;align-items:center;">
      <img src="${logoUrl}" style="height:28px;object-fit:contain;" alt="Plumtrips"/>
    </div>
    <div style="font-size:9px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:2px;">&copy; ${new Date().getFullYear()} Peachmint Trips and Planners Pvt. Ltd.</div>
  </div>
</div>`;
}
export async function generateTicketHTML(b, offers = [], returnBooking, logoUrl = DEFAULT_LOGO_URL, showPrintButton = true) {
    const isDemo = !!b.isDemo;
    const demoWatermarkHtml = isDemo
        ? `<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:120px;font-weight:bold;color:rgba(208,101,73,0.15);z-index:9999;pointer-events:none;white-space:nowrap;">SAMPLE — NOT A REAL RESERVATION</div>`
        : "";
    const demoFooterDisclaimerHtml = isDemo
        ? `<div style="text-align:center;margin:24px 40px;padding:12px 16px;background:#FFF4E5;border:1px solid #D06549;color:#7A3A1E;font-size:11px;font-style:italic;">This document is a sample generated for demonstration purposes only. No booking has been made and no service has been confirmed with any airline, hotel, or supplier.</div>`
        : "";
    const isNonRefundable = b.isLCC;
    const destCity = b.destination.city || cityName(b.destination.code);
    const originCity = b.origin.city || cityName(b.origin.code);
    const leadPax = b.passengers?.find(p => p.isLead) || b.passengers?.[0];
    const passengerFirstName = esc(extractFirstName(leadPax?.firstName || ""));
    const webCheckInUrl = getWebCheckInUrl(b.airlineName, b.pnr);
    const ticketQrDataUrl = await generateQRDataUrl(webCheckInUrl);
    const paxRows = (b.passengers ?? []).map((p) => {
        const pt = p?.paxType ?? "adult";
        const paxType = pt === "adult" || pt === "1" ? "Adult" : pt === "child" || pt === "2" ? "Child" : pt === "infant" || pt === "3" ? "Infant" : "Adult";
        return `<tr style="border-bottom:1px solid #f3f4f6;">
      <td style="padding:12px 16px;font-weight:600;color:#002a58;font-size:13px;">${esc(p?.title ?? "")} ${esc(p?.firstName ?? "")} ${esc(p?.lastName ?? "")}</td>
      <td style="padding:12px 16px;color:#6B7280;font-size:13px;">${paxType}</td>
      <td style="padding:12px 16px;font-family:monospace;font-size:11px;color:#6B7280;text-align:center;">${esc(b.ticketId || "—")}</td>
      <td style="padding:12px 16px;font-weight:700;text-align:center;color:#002a58;">&mdash;</td>
      <td style="padding:12px 16px;color:#374151;text-align:center;font-size:12px;">15 kg</td>
      <td style="padding:12px 16px;color:#374151;text-align:center;font-size:12px;">7 kg</td>
      <td style="padding:12px 16px;color:#374151;text-align:center;font-size:12px;">&mdash;</td>
    </tr>`;
    }).join("");
    const barcodesHtml = (b.passengers ?? []).map((p, i) => {
        const ref = `${b.pnr}-${i + 1}`;
        return `<div style="margin-bottom:12px;">
      <p style="font-size:11px;color:#9CA3AF;margin:0 0 4px;">${esc(p?.firstName ?? "")} ${esc(p?.lastName ?? "")} &mdash; Barcode:</p>
      ${generateBarcodeSVG(ref)}
      <p style="font-size:10px;color:#9CA3AF;font-family:monospace;margin:2px 0 0;letter-spacing:0.5px;">${esc(ref)}</p>
    </div>`;
    }).join("");
    const nonRefundBadge = isNonRefundable
        ? `<span style="background:#FEE2E2;color:#B91C1C;padding:4px 12px;border-radius:20px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Non-Refundable</span>`
        : "";
    const policies = [
        "Please arrive at the airport at least 2 hours before departure (domestic) or 3 hours (international)",
        "Web check-in opens 48 hours before departure and closes 60 minutes before departure",
        "Valid government-issued photo ID is mandatory for all passengers",
        isNonRefundable
            ? "This booking is non-refundable. Date/time changes may incur penalties as per airline policy"
            : "Cancellation and change fees apply as per fare rules. Contact support for assistance",
        "Check-in baggage allowance as selected during booking. Excess baggage charged separately",
        "PlumTrips acts as a booking agent. Flight operations are the responsibility of the airline",
    ];
    const policiesHtml = policies.map((p) => `<li style="display:flex;align-items:flex-start;gap:8px;padding:5px 0;font-size:12px;color:#4B5563;">
      <span style="color:#002a58;margin-top:1px;flex-shrink:0;">&#8226;</span>
      <span>${p}</span>
    </li>`).join("");
    const enabledOffers = offers.filter((o) => o.enabled);
    const offersHtml = enabledOffers.length > 0
        ? enabledOffers.map((o) => {
            const bg = esc(o.bgColor || "#004080");
            const imgHtml = o.imageUrl
                ? `<img src="${esc(o.imageUrl)}" style="width:100%;height:100%;object-fit:cover;display:block;"/>`
                : `<div style="width:100%;height:100%;background:linear-gradient(135deg,rgba(0,0,0,0.3),transparent);min-height:160px;"></div>`;
            return `<div style="background:${bg};border-radius:12px;overflow:hidden;display:flex;margin-bottom:16px;box-shadow:0 8px 24px rgba(0,42,88,0.15);">
        <div style="flex:3;padding:28px;color:#ffffff;">
          <div style="font-size:9px;font-weight:700;color:#fe6a34;text-transform:uppercase;letter-spacing:3px;margin-bottom:8px;">PARTNER EXCLUSIVE</div>
          <div style="font-size:18px;font-weight:800;color:#ffffff;margin-bottom:8px;line-height:1.3;">${esc(o.title)}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.75);margin-bottom:16px;line-height:1.5;">${esc(o.description)}</div>
          <a href="${esc(o.ctaUrl)}" target="_blank" rel="noopener" style="font-size:10px;font-weight:700;color:#ffffff;text-decoration:underline;text-transform:uppercase;letter-spacing:2px;">${esc(o.ctaText)} &rarr;</a>
        </div>
        <div style="flex:2;overflow:hidden;min-height:160px;position:relative;">
          ${imgHtml}
          <div style="position:absolute;inset:0;background:linear-gradient(to right,${bg} 0%,transparent 70%);pointer-events:none;"></div>
        </div>
      </div>`;
        }).join("")
        : `<div style="background:#004080;border-radius:12px;overflow:hidden;display:flex;margin-bottom:16px;">
      <div style="flex:3;padding:28px;color:#ffffff;">
        <div style="font-size:9px;font-weight:700;color:#fe6a34;text-transform:uppercase;letter-spacing:3px;margin-bottom:8px;">PARTNER EXCLUSIVE</div>
        <div style="font-size:18px;font-weight:800;color:#ffffff;margin-bottom:8px;line-height:1.3;">Effortless eVisa with Helloviza</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.75);margin-bottom:16px;line-height:1.5;">20% privilege discount on all visa processing fees.</div>
        <a href="https://helloviza.com" target="_blank" rel="noopener" style="font-size:10px;font-weight:700;color:#ffffff;text-decoration:underline;text-transform:uppercase;letter-spacing:2px;">EXPLORE PRIVILEGES &rarr;</a>
      </div>
      <div style="flex:2;overflow:hidden;min-height:160px;position:relative;">
        <div style="width:100%;height:100%;background:linear-gradient(135deg,#001a38,#002a58);display:flex;align-items:center;justify-content:center;min-height:160px;"><span style="font-size:80px;opacity:0.15;">&#x1F6C2;</span></div>
        <div style="position:absolute;inset:0;background:linear-gradient(to right,#004080 0%,transparent 70%);pointer-events:none;"></div>
      </div>
    </div>`;
    const segLabel = returnBooking ? "Outbound Flight" : "Segment 1";
    const returnPageHtml = returnBooking ? await generateReturnPageHTML(returnBooking, logoUrl) : "";
    const totalPages = returnBooking ? 2 : 1;
    const printButtonHtml = showPrintButton
        ? `<div class="no-print" style="position:fixed;bottom:24px;right:24px;z-index:999;">
  <button onclick="window.print()" style="background:#002a58;color:#ffffff;border:none;border-radius:10px;padding:12px 24px;font-size:13px;font-weight:700;font-family:Manrope,sans-serif;cursor:pointer;box-shadow:0 4px 20px rgba(0,42,88,0.3);">&#128438; Print / Save PDF</button>
</div>`
        : "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>E-Ticket ${esc(b.pnr)} | PlumTrips</title>
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
    <img src="${logoUrl}" style="height:36px;object-fit:contain;" alt="Plumtrips"/>
  </div>
  <div style="text-align:right;">
    <div style="font-size:9px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:3px;">E-Ticket</div>
    <div style="font-size:11px;color:#C5A059;font-weight:700;text-transform:uppercase;letter-spacing:2px;margin-top:2px;">${esc(b.status || "CONFIRMED")}</div>
  </div>
</div>

<div style="max-width:860px;margin:0 auto;padding:28px 40px 48px;">

  <div style="margin-bottom:24px;">
    <div style="font-size:10px;font-weight:700;color:#002a58;text-transform:uppercase;letter-spacing:3px;border:1px solid rgba(0,42,88,0.2);display:inline-block;padding:3px 10px;border-radius:20px;background:rgba(0,42,88,0.05);margin-bottom:12px;">Confirmed Status</div>
    <h1 style="font-size:42px;font-weight:900;color:#002a58;letter-spacing:-1px;line-height:1.15;margin-bottom:8px;font-family:Manrope,sans-serif;text-shadow:0 2px 20px rgba(0,42,88,0.1);">The World is Waiting, ${passengerFirstName}.<br/>Let&apos;s Fly.</h1>
    <p style="font-size:14px;color:#6B7280;">Your voyage from ${esc(originCity)} to ${esc(destCity)} is confirmed for departure.</p>
  </div>

  <div style="display:flex;gap:24px;align-items:flex-start;margin-bottom:24px;">

    <div style="flex:3;min-width:0;overflow:hidden;">
      ${generateFlightSection(b, segLabel)}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
        <div style="background:#ffffff;border-radius:12px;padding:20px;display:flex;align-items:center;gap:14px;box-shadow:0 4px 20px rgba(0,42,88,0.04);">
          <div>
            <div style="font-size:9px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:2px;">Check-in Allowance</div>
            <div style="font-size:20px;font-weight:800;color:#002a58;">15 kg</div>
          </div>
        </div>
        <div style="background:#ffffff;border-radius:12px;padding:20px;display:flex;align-items:center;gap:14px;box-shadow:0 4px 20px rgba(0,42,88,0.04);">
          <div>
            <div style="font-size:9px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:2px;">Cabin Allowance</div>
            <div style="font-size:20px;font-weight:800;color:#002a58;">7 kg</div>
          </div>
        </div>
      </div>

      ${offersHtml}
    </div>

    <div style="width:220px;min-width:220px;max-width:220px;box-sizing:border-box;flex-shrink:0;display:flex;flex-direction:column;gap:18px;">
      <div style="background:#002a58;border-radius:12px;padding:22px;color:#ffffff;text-align:center;box-sizing:border-box;box-shadow:inset 0 0 30px rgba(0,64,128,0.5),0 20px 40px rgba(0,42,88,0.3);">
        <div style="font-size:9px;font-weight:700;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:3px;margin-bottom:12px;">PNR</div>
        <div style="background:#004080;border-radius:8px;padding:12px;margin-bottom:16px;">
          <div style="font-size:24px;font-weight:900;letter-spacing:4px;">${esc(b.pnr)}</div>
        </div>
        <div style="background:#ffffff;border-radius:8px;padding:12px;margin-top:16px;display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;box-sizing:border-box;">
          ${ticketQrDataUrl ? `<img src="${ticketQrDataUrl}" style="width:140px;height:140px;display:block;margin:0 auto;border-radius:4px;" alt="Web Check-in QR"/>` : `<div style="width:140px;height:140px;background:#f0f4f8;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#6B7280;text-align:center;padding:8px;">PNR: ${esc(b.pnr)}</div>`}
          <div style="font-size:9px;font-weight:700;color:#002a58;text-transform:uppercase;letter-spacing:2px;margin-top:10px;text-align:center;">WEB CHECK-IN</div>
        </div>
      </div>

      <div style="background:#ffffff;border-radius:12px;padding:18px;box-shadow:0 4px 20px rgba(0,42,88,0.04);">
        <div style="font-size:10px;font-weight:800;color:#002a58;text-transform:uppercase;letter-spacing:2px;margin-bottom:14px;">Travel Advisory</div>
        <div style="margin-bottom:10px;">
          <div style="font-size:10px;font-weight:700;color:#002a58;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Early Arrival</div>
          <div style="font-size:11px;color:#6B7280;line-height:1.5;">Arrive 3hrs early for intl, 2hrs domestic.</div>
        </div>
        <div style="margin-bottom:10px;">
          <div style="font-size:10px;font-weight:700;color:#002a58;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Verification</div>
          <div style="font-size:11px;color:#6B7280;line-height:1.5;">Govt-issued photo ID required.</div>
        </div>
        <div>
          <div style="font-size:10px;font-weight:700;color:#002a58;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Digital Check-in</div>
          <div style="font-size:11px;color:#6B7280;line-height:1.5;">Web check-in 60 mins before departure.</div>
        </div>
      </div>
    </div>
  </div>

  <div style="background:#ffffff;border-radius:12px;overflow:hidden;margin-bottom:20px;box-shadow:0 4px 20px rgba(0,42,88,0.04);">
    <div style="background:#002a58;color:#ffffff;padding:12px 20px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Passenger Manifest &amp; Baggage Allowance</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f8f9fa;border-bottom:1px solid #E5E7EB;">
          <th style="text-align:left;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Passenger Name</th>
          <th style="text-align:left;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Type</th>
          <th style="text-align:center;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Ticket No</th>
          <th style="text-align:center;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Seat</th>
          <th style="text-align:center;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Check-in</th>
          <th style="text-align:center;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Cabin</th>
          <th style="text-align:center;padding:10px 16px;font-size:10px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Meal</th>
        </tr>
      </thead>
      <tbody>${paxRows}</tbody>
    </table>
    <div style="padding:16px 20px;background:#f8f9fa;border-top:1px solid #E5E7EB;">${barcodesHtml}</div>
  </div>

  <div style="background:#ffffff;border-radius:12px;padding:24px;margin-bottom:20px;box-shadow:0 4px 20px rgba(0,42,88,0.04);">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <div style="font-size:10px;font-weight:800;color:#002a58;text-transform:uppercase;letter-spacing:3px;border-left:3px solid #C5A059;padding-left:12px;">Important Travel Information</div>
      ${nonRefundBadge}
    </div>
    <ul style="list-style:none;padding:0;margin:0;">${policiesHtml}</ul>
  </div>

  <div style="text-align:center;padding-top:8px;">
    <p style="font-size:11px;color:#9CA3AF;margin:0;">Page 1 of ${totalPages} &bull; Generated via PlumTrips &bull; ${esc(new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }))}</p>
  </div>

</div>

${demoFooterDisclaimerHtml}

<div style="background:#002a58;padding:16px 40px;display:flex;justify-content:space-between;align-items:center;">
  <div style="display:flex;align-items:center;">
    <img src="${logoUrl}" style="height:28px;object-fit:contain;" alt="Plumtrips"/>
  </div>
  <div style="font-size:9px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:2px;">&copy; ${new Date().getFullYear()} Peachmint Trips and Planners Pvt. Ltd.</div>
</div>

${returnPageHtml}
</body>
</html>`;
}
