// apps/backend/src/services/pdfService.ts
import PDFDocument from 'pdfkit';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { PlumtripsVoucher } from '../types/voucher.js';

// --- Helpers ---
function safe(val: string | number | null | undefined, fallback = 'N/A'): string {
  if (val === null || val === undefined) return fallback;
  const str = String(val).trim();
  if (str === '' || str.toLowerCase() === 'null' || str.toLowerCase() === 'n/a') return fallback;
  return str;
}

function formatTerminal(t?: string | null): string {
  if (!t || t.trim() === '' || t.toLowerCase() === 'null') return '';
  const clean = t.replace(/terminal/ig, '').trim();
  if (clean.toUpperCase().startsWith('T')) return `(${clean.toUpperCase()})`;
  return `(T${clean})`;
}

// Optional: Fetch custom logo over network (if tenant has their own logo URL)
async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  if (!url || !url.startsWith('http')) return null;
  return new Promise((resolve) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return resolve(null);
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', () => resolve(null));
  });
}

/**
 * Generates a Premium, Branded PDF for Flight or Hotel Vouchers.
 * Uses native text flow to ensure dynamic, accurate pagination (1 to N pages).
 */
export const generateTravelPDF = async (data: PlumtripsVoucher): Promise<Buffer> => {
  return new Promise(async (resolve, reject) => {
    // bufferPages: true allows us to add the footer to all pages at the very end
    const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const isFlight = data.type === 'flight';
    const isHotel = data.type === 'hotel';
    
    // Brand Colors
    const primaryColor = '#004A8C';
    const accentColor = '#E86B43';
    const textDark = '#1E293B';
    const textMuted = '#64748B';
    const bgLight = '#F8FAFC';

    // ==========================================
    // 1. TOP HEADER BANNER (Page 1 Only)
    // ==========================================
    doc.rect(0, 0, doc.page.width, 100).fill(primaryColor);
    
    // Logo Placement Logic
    const localLogoPath = path.join(process.cwd(), 'assets', 'logo.png');
    let logoRendered = false;

    // Step A: Custom network logo (if defined in JSON)
    if (data.booking_info.custom_logo && data.booking_info.custom_logo.startsWith('http')) {
      const logoBuf = await fetchImageBuffer(data.booking_info.custom_logo);
      if (logoBuf) {
        try {
          doc.image(logoBuf, 40, 30, { height: 40 });
          logoRendered = true;
        } catch (e) { /* ignore corrupt images */ }
      }
    }

    // Step B: Fallback to Local System Logo (/assets/logo.png)
    if (!logoRendered) {
      try {
        if (fs.existsSync(localLogoPath)) {
          doc.image(localLogoPath, 40, 30, { height: 40 });
          logoRendered = true;
        }
      } catch (err) { /* ignore fs errors */ }
    }

    // Step C: Absolute Text Fallback if no images found
    if (!logoRendered) {
      doc.fillColor('#FFFFFF').fontSize(24).font('Helvetica-Bold').text('PlumTrips', 40, 40);
    }

    // Document Title
    doc.fillColor('#FFFFFF').fontSize(18).font('Helvetica-Bold')
       .text(`${data.type.toUpperCase()} E-VOUCHER`, 40, 40, { align: 'right', width: 515 });
    
    doc.fontSize(9).font('Helvetica').fillColor('#CBD5E1')
       .text('CONFIRMED DIGITAL TICKET', 40, 65, { align: 'right', width: 515 });

    doc.y = 120; // Move cursor safely below the header banner

    // --- Helper: Dynamic Section Banner ---
    // This creates a premium section title without breaking pagination natively.
    const drawSectionHeader = (title: string) => {
      doc.moveDown(1.5);
      // Prevent orphaned headers at the bottom of the page
      if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();
      
      const currentY = doc.y;
      doc.rect(40, currentY, doc.page.width - 80, 24).fill(bgLight);
      doc.rect(40, currentY, 4, 24).fill(primaryColor); // Left accent bar
      
      doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold')
         .text(title.toUpperCase(), 55, currentY + 8, { tracking: 1 });
      doc.y = currentY + 35; // Move cursor down for content
    };

    // ==========================================
    // 2. BOOKING SUMMARY
    // ==========================================
    drawSectionHeader('Booking Summary');
    
    const summaryY = doc.y;
    doc.fontSize(9).font('Helvetica-Bold').fillColor(textMuted).text('BOOKING ID', 40, summaryY);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(textDark).text(safe(data.booking_info.booking_id), 40, summaryY + 12);

    doc.fontSize(9).font('Helvetica-Bold').fillColor(textMuted).text('ISSUE DATE', 220, summaryY);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(textDark).text(safe(data.booking_info.booking_date), 220, summaryY + 12);

    if (isFlight) {
      doc.fontSize(9).font('Helvetica-Bold').fillColor(accentColor).text('PNR / RECORD LOCATOR', 400, summaryY);
      doc.fontSize(14).font('Helvetica-Bold').fillColor(textDark).text(safe(data.booking_info.pnr), 400, summaryY + 12);
    } else {
      doc.fontSize(9).font('Helvetica-Bold').fillColor(accentColor).text('VOUCHER NO', 400, summaryY);
      doc.fontSize(12).font('Helvetica-Bold').fillColor(textDark).text(safe(data.booking_info.voucher_no), 400, summaryY + 12);
    }
    doc.y = summaryY + 40;

    // ==========================================
    // 3. FLIGHT ITINERARY
    // ==========================================
    if (isFlight && data.flight_details && Array.isArray(data.flight_details.segments)) {
      drawSectionHeader('Flight Itinerary');

      data.flight_details.segments.forEach((seg, i) => {
        // Prevent orphaned segments
        if (doc.y > doc.page.height - doc.page.margins.bottom - 100) doc.addPage();

        const segY = doc.y;
        
        // Airline & Flight No
        doc.fontSize(11).font('Helvetica-Bold').fillColor(primaryColor)
           .text(`${safe(seg.airline)}  •  ${safe(seg.flight_no)}`, 40, segY);
        doc.fontSize(9).font('Helvetica').fillColor(textMuted)
           .text(`Class: ${safe(seg.class)}`, 40, segY + 14);

        // Origin
        doc.fontSize(16).font('Helvetica-Bold').fillColor(textDark).text(safe(seg.origin.code), 200, segY);
        doc.fontSize(9).font('Helvetica-Bold').fillColor(textMuted).text(safe(seg.origin.city), 200, segY + 18);
        doc.fontSize(9).font('Helvetica').text(`${safe(seg.origin.date)} • ${safe(seg.origin.time)}`, 200, segY + 30);
        const origTerm = formatTerminal(seg.origin.terminal);
        if (origTerm) doc.fillColor(accentColor).font('Helvetica-Bold').text(`Terminal ${origTerm}`, 200, segY + 42);

        // Arrow 
        doc.fontSize(12).font('Helvetica').fillColor(textMuted).text('→', 315, segY + 2, { width: 30, align: 'center' });
        doc.fontSize(8).text(safe(seg.duration, 'Flight Time'), 315, segY + 18, { width: 30, align: 'center' });

        // Destination
        doc.fontSize(16).font('Helvetica-Bold').fillColor(textDark).text(safe(seg.destination.code), 360, segY);
        doc.fontSize(9).font('Helvetica-Bold').fillColor(textMuted).text(safe(seg.destination.city), 360, segY + 18);
        doc.fontSize(9).font('Helvetica').text(`${safe(seg.destination.date)} • ${safe(seg.destination.time)}`, 360, segY + 30);
        const destTerm = formatTerminal(seg.destination.terminal);
        if (destTerm) doc.fillColor(accentColor).font('Helvetica-Bold').text(`Terminal ${destTerm}`, 360, segY + 42);

        // Baggage
        doc.fontSize(8).font('Helvetica-Bold').fillColor(textMuted).text('BAGGAGE:', 480, segY);
        doc.fontSize(8).font('Helvetica').fillColor(textDark)
           .text(`Check-in: ${safe(seg.ancillaries?.checkin_bag, 'N/A')}`, 480, segY + 12)
           .text(`Cabin: ${safe(seg.ancillaries?.cabin_bag, 'N/A')}`, 480, segY + 24);

        doc.y = segY + 70;
        doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).lineWidth(0.5).strokeColor('#E2E8F0').stroke();
        doc.y += 15;
      });

      // Passengers
      if (Array.isArray(data.passengers) && data.passengers.length > 0) {
        drawSectionHeader('Passenger Manifest');
        
        // Native text flow allows passengers to break safely across pages
        data.passengers.forEach((p, idx) => {
          doc.fontSize(10).font('Helvetica-Bold').fillColor(textDark)
             .text(`${idx + 1}. ${safe(p.name, 'Unnamed Passenger')} (${safe(p.type, 'Adult')})`, { continued: true })
             .font('Helvetica').fillColor(textMuted)
             .text(`   |   Ticket: ${safe(p.ticket_no)}   |   Seat: ${safe(p.seat, 'Unassigned')}`);
          
          doc.moveDown(0.5);
        });
      }
    }

    // ==========================================
    // 4. HOTEL DETAILS
    // ==========================================
    if (isHotel && data.hotel_details && data.stay_details && data.room_details) {
      drawSectionHeader('Accommodation Details');
      
      const hotelY = doc.y;
      doc.fontSize(14).font('Helvetica-Bold').fillColor(textDark).text(safe(data.hotel_details.name), 40, hotelY);
      doc.fontSize(10).font('Helvetica').fillColor(textMuted).text(safe(data.hotel_details.address), 40, hotelY + 18);
      doc.text(`${safe(data.hotel_details.city)}, ${safe(data.hotel_details.country)}`, 40, hotelY + 32);
      
      doc.fontSize(9).font('Helvetica-Bold').fillColor(textMuted).text('PRIMARY GUEST', 350, hotelY);
      doc.fontSize(11).fillColor(textDark).text(safe(data.guest_details?.primary_guest), 350, hotelY + 12);
      
      doc.fontSize(9).font('Helvetica-Bold').fillColor(textMuted).text('ROOM TYPE', 350, hotelY + 35);
      doc.fontSize(10).fillColor(textDark).text(safe(data.room_details.room_type), 350, hotelY + 47);
      
      doc.y = hotelY + 80;

      // Stay Grid
      drawSectionHeader('Stay Schedule');
      const stayY = doc.y;
      
      doc.fontSize(9).font('Helvetica-Bold').fillColor(textMuted).text('CHECK-IN', 40, stayY);
      doc.fontSize(14).font('Helvetica-Bold').fillColor(textDark).text(safe(data.stay_details.check_in_date), 40, stayY + 12);
      doc.fontSize(10).font('Helvetica').fillColor(accentColor).text(`After ${safe(data.stay_details.check_in_time)}`, 40, stayY + 30);

      doc.fontSize(9).font('Helvetica-Bold').fillColor(textMuted).text('CHECK-OUT', 250, stayY);
      doc.fontSize(14).font('Helvetica-Bold').fillColor(textDark).text(safe(data.stay_details.check_out_date), 250, stayY + 12);
      doc.fontSize(10).font('Helvetica').fillColor(accentColor).text(`Before ${safe(data.stay_details.check_out_time)}`, 250, stayY + 30);

      doc.fontSize(9).font('Helvetica-Bold').fillColor(textMuted).text('DURATION', 450, stayY);
      doc.fontSize(14).font('Helvetica-Bold').fillColor(primaryColor).text(`${safe(data.stay_details.total_nights)} Nights`, 450, stayY + 12);
      
      doc.y = stayY + 60;

      // Inclusions (Auto-wraps)
      if (Array.isArray(data.room_details.inclusions) && data.room_details.inclusions.length > 0) {
        drawSectionHeader('Package Inclusions');
        doc.fontSize(10).font('Helvetica').fillColor(textDark).text(data.room_details.inclusions.join('  •  '), { lineGap: 4 });
      }
    }

    // ==========================================
    // 5. POLICIES & IMPORTANT NOTES
    // ==========================================
    const hasNotes = Array.isArray(data.policies?.important_notes) && data.policies.important_notes.length > 0;
    if (hasNotes || data.policies?.is_non_refundable) {
      drawSectionHeader('Important Information');
      
      if (data.policies?.is_non_refundable) {
         doc.fontSize(10).font('Helvetica-Bold').fillColor('#DC2626').text('• This booking is strictly NON-REFUNDABLE.', { lineGap: 6 });
      }
      
      if (hasNotes) {
        doc.fontSize(9).font('Helvetica').fillColor(textMuted);
        data.policies.important_notes.forEach(note => {
          // Native text flow automatically wraps text and pushes to new pages seamlessly!
          doc.text(`• ${note}`, { lineGap: 4 }); 
          doc.moveDown(0.5);
        });
      }
    }

    // ==========================================
    // 6. FOOTER (Applied to all generated pages)
    // ==========================================
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.height - 40;
      
      // Top border for footer
      doc.moveTo(40, bottom - 15).lineTo(doc.page.width - 40, bottom - 15).lineWidth(1).strokeColor('#E2E8F0').stroke();
      
      // AI Badge
      doc.rect(40, bottom - 5, 14, 14).fill(primaryColor);
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#FFFFFF').text('AI', 43, bottom - 2);
      
      doc.fontSize(8).font('Helvetica-Bold').fillColor(textMuted)
         .text('Generated by Plumtrips AI Engine', 60, bottom - 2);
         
      doc.font('Helvetica').fillColor('#94A3B8')
         .text(`Page ${i + 1} of ${range.count} • Authentic Digital Record`, 0, bottom - 2, { align: 'right', width: doc.page.width - 40 });
    }

    doc.end();
  });
};