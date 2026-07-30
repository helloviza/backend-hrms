// apps/backend/src/config/visaDocumentCodes.ts
//
// Canonical visa document-type registry. VisaRule.documentRequirements[].docCode
// and VisaDocument.docCode both reference these codes — single source of truth
// so a rule can't require a document type the upload step doesn't know how to
// render/label, and vice versa.
//
// Range is DOC-01..DOC-25. Only DOC-01..DOC-09 are populated here — this is
// the starting subset explicitly given for this build pass (passport,
// photograph, bank statement, ITR, employment letter, invitation letter,
// hotel booking, flight itinerary, travel insurance). DOC-10..DOC-25 are
// intentionally NOT stubbed with invented names — they're reserved slots
// pending the full list.

export type VisaDocumentCategory =
  | "IDENTITY"
  | "FINANCIAL"
  | "EMPLOYMENT"
  | "BUSINESS"
  | "TRAVEL";

export interface VisaDocumentCodeDef {
  code: string; // "DOC-01".."DOC-25"
  name: string;
  category: VisaDocumentCategory;
  notes?: string;
}

export const VISA_DOCUMENT_CODES: readonly VisaDocumentCodeDef[] = [
  { code: "DOC-01", name: "Passport", category: "IDENTITY", notes: "Bio-data page; minimum 6 months' validity from travel date" },
  { code: "DOC-02", name: "Photograph", category: "IDENTITY", notes: "Recent passport-size photograph per mission specification" },
  { code: "DOC-03", name: "Bank Statement", category: "FINANCIAL", notes: "Last 6 months, showing salary credits / closing balance" },
  { code: "DOC-04", name: "ITR", category: "FINANCIAL", notes: "Income Tax Return, last 2 assessment years" },
  { code: "DOC-05", name: "Employment Letter", category: "EMPLOYMENT", notes: "Confirms designation, salary and sanctioned leave" },
  { code: "DOC-06", name: "Invitation Letter", category: "BUSINESS", notes: "From the host company, on letterhead, with dates and purpose" },
  { code: "DOC-07", name: "Hotel Booking", category: "TRAVEL", notes: "Confirmed accommodation covering the full stay" },
  { code: "DOC-08", name: "Flight Itinerary", category: "TRAVEL", notes: "Confirmed or refundable-hold return itinerary" },
  { code: "DOC-09", name: "Travel Insurance", category: "TRAVEL", notes: "Required by Schengen and several other missions" },
  // First of the reserved DOC-10..DOC-25 range to be populated — not an
  // applicant-supplied checklist item (never appears in a VisaRule's
  // documentRequirements), but the concierge console's outcome-capture
  // route (routes/admin.visa.ts) reuses the SAME upload path/docCode
  // validation as every applicant upload, so the issued visa scan needs a
  // real registry entry rather than an unchecked one-off code.
  { code: "DOC-10", name: "Issued Visa", category: "IDENTITY", notes: "Scanned copy of the issued visa, attached by the concierge on approval" },
] as const;

export const VISA_DOCUMENT_CODE_SET: ReadonlySet<string> = new Set(
  VISA_DOCUMENT_CODES.map((d) => d.code),
);

export function getVisaDocumentCodeDef(code: string): VisaDocumentCodeDef | undefined {
  return VISA_DOCUMENT_CODES.find((d) => d.code === code);
}
