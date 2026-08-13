// apps/backend/src/config/visaDocumentTypeCatalogue.ts
//
// Phase 10a — the canonical, semantic-code document-type catalogue that
// replaces the numbered DOC-01..DOC-25 scheme (config/visaDocumentCodes.ts's
// original design). This file is the SINGLE source of truth for the
// catalogue's content; two things are derived from it, never maintained
// independently:
//   1. models/VisaDocumentType.ts's seed data, written by the migration
//      (migrations/2026-08-02-visa-checklist-model-v2.ts) into the new
//      VisaDocumentType collection.
//   2. config/visaDocumentCodes.ts's legacy VISA_DOCUMENT_CODES/
//      VISA_DOCUMENT_CODE_SET, which routes/admin.visa.rules.ts and
//      routes/visa.ts still import synchronously for validation. Those
//      routes are OUT OF SCOPE for this phase (schema/migration only) and
//      several call sites hardcode the OLD "DOC-01".."DOC-10" literals
//      directly (LINKABLE_DOC_CODE_SERVICE, CONCIERGE_ARRANGEABLE_DOC_CODES,
//      PASSPORT_DOC_CODE, VISA_SCAN_DOC_CODE — see services/
//      visaPassportExtraction.ts and routes/admin.visa.ts). Rewriting
//      already-stored VisaDocument.docCode / VisaRule.documentRequirements
//      values from old to new would silently break those comparisons. So:
//      the OLD codes stay valid and unchanged in storage and in every
//      existing route; the NEW semantic codes are additive, and
//      OLD_TO_NEW_DOC_CODE_MAP below is the resolvable bridge between them
//      (used by VisaDocumentType's resolver, never by mutating old rows).
//
// Not every real-world document type is populated here — this is a
// representative catalogue covering the nine legacy codes' equivalents plus
// the additional types the seven analysed checklists (USA, UK, Canada,
// France, China, UAE, Laos) require to express document GROUPS and
// attribute-conditional requirements (see VisaRule.ts's documentGroups).
// Adding a new type later is additive — no numeric range to run out of,
// unlike the old DOC-NN scheme.

export type VisaDocumentTypeCategory =
  | "IDENTITY"
  | "FINANCIAL"
  | "EMPLOYMENT"
  | "BUSINESS"
  | "TRAVEL"
  | "SPONSORSHIP"
  | "CIVIL_STATUS"
  | "VISA_HISTORY";

export interface VisaDocumentTypeSeed {
  code: string; // semantic, e.g. "PASSPORT_ORIGINAL" — stable, never renumbered
  name: string;
  category: VisaDocumentTypeCategory;
  defaultDescription: string;
  // Source-label aliases — the SAME document is asked for under different
  // names by different missions (task brief's own example: Employer NOC is
  // "Leave Approval Letter" in Canada, "Leave Letter From Company" in China).
  aliases: string[];
  ocrExtractable: boolean;
  // Set only for the nine codes migrated from config/visaDocumentCodes.ts's
  // original DOC-NN scheme — see OLD_TO_NEW_DOC_CODE_MAP below, which is
  // mechanically derived from this field so the two can never drift apart.
  legacyCode?: string;
}

export const VISA_DOCUMENT_TYPE_CATALOGUE: readonly VisaDocumentTypeSeed[] = [
  // ── Migrated from the original nine DOC-01..DOC-09 codes, plus DOC-10 ──
  {
    code: "PASSPORT_ORIGINAL",
    name: "Passport",
    category: "IDENTITY",
    defaultDescription: "Bio-data page; minimum 6 months' validity from travel date",
    aliases: ["Passport Copy", "Passport Bio-Data Page"],
    ocrExtractable: true,
    legacyCode: "DOC-01",
  },
  {
    code: "PHOTOGRAPH",
    name: "Photograph",
    category: "IDENTITY",
    defaultDescription: "Recent passport-size photograph per mission specification",
    aliases: ["Passport Photo", "ID Photo"],
    ocrExtractable: false,
    legacyCode: "DOC-02",
  },
  {
    code: "OLD_PASSPORT_COPY",
    name: "Old Passport Copy",
    category: "IDENTITY",
    defaultDescription: "Copy of a previous/expired passport, submitted alongside the current one for travel-history continuity",
    aliases: ["Old Passport", "Old passport", "Old passport copy", "Previous passport", "Previous Passports available", "Previous Passport"],
    ocrExtractable: false,
  },
  {
    code: "PASSPORT_LAST_PAGE",
    name: "Passport Last Page",
    category: "IDENTITY",
    defaultDescription: "Copy of the passport's last/back page, submitted alongside the bio-data page",
    aliases: ["Passport back page", "Passport Back Page", "Copy of Passport Back page"],
    ocrExtractable: false,
  },
  {
    code: "INDIAN_GOVT_ID_CARD",
    name: "Indian Government ID Card",
    category: "IDENTITY",
    defaultDescription: "Copy of an Indian government-issued ID card (PAN card or Aadhaar card), used as supplementary identity or address proof",
    aliases: ["Pan Card", "PAN Card Copy", "PAN registration", "Pan card copy of all the applicant", "Sponsor's pan card", "Aadhar card", "Aadhar card or Pan card", "National Id Card"],
    ocrExtractable: false,
  },
  {
    code: "ADDRESS_PROOF",
    name: "Address Proof",
    category: "IDENTITY",
    defaultDescription: "Proof of current residential address (rent agreement, property deed, or utility bill), typically required when the passport's issuing jurisdiction differs from the applicant's current city of residence",
    aliases: ["Rent agreement", "Rental Agreement", "Lease agreement", "Lease agreements", "Property papers", "Residence Proof", "Address Proof", "Electricity Bill", "Water Bill", "Phone Bill", "Telephone Bill"],
    ocrExtractable: false,
  },
  {
    code: "APPLICANT_BANK_STATEMENT",
    name: "Bank Statement",
    category: "FINANCIAL",
    defaultDescription: "Last 6 months, showing salary credits / closing balance",
    aliases: ["Personal Bank Statement", "Savings Account Statement", "Bank e-Statement"],
    ocrExtractable: false,
    legacyCode: "DOC-03",
  },
  {
    code: "INCOME_TAX_RETURN",
    name: "Income Tax Return",
    category: "FINANCIAL",
    defaultDescription: "ITR, last 2 assessment years",
    // Plural + the business-applicant label, both 2026-08-13 (36 rows).
    // "Income Tax Returns (sponsor)" is deliberately NOT aliased: that row
    // asks for the applicant's AND the sponsor's returns, which is two
    // documents, and folding it in here would lose the sponsor half.
    aliases: ["ITR", "Tax Return Acknowledgement", "Income Tax Returns", "ITR - Business"],
    ocrExtractable: false,
    legacyCode: "DOC-04",
  },
  {
    code: "EMPLOYER_NOC",
    name: "Employer NOC",
    category: "EMPLOYMENT",
    defaultDescription: "Confirms designation, salary and sanctioned leave, on company letterhead",
    aliases: [
      "Employment Letter",
      "Leave Approval Letter",
      "Leave Letter From Company",
      "No Objection Certificate (NOC)",
      // 2026-08-13, 18 rows — the corpus's own label for the same letter.
      "Leave letter - current company",
    ],
    ocrExtractable: false,
    legacyCode: "DOC-05",
  },
  {
    code: "INVITATION_LETTER",
    name: "Invitation Letter",
    category: "BUSINESS",
    defaultDescription: "From the host company, on letterhead, with dates and purpose",
    aliases: ["Business Invitation", "Host Company Letter", "Invitation letter - by inviting company"],
    ocrExtractable: false,
    legacyCode: "DOC-06",
  },
  {
    code: "HOTEL_BOOKING",
    name: "Hotel Booking",
    category: "TRAVEL",
    defaultDescription: "Confirmed accommodation covering the full stay",
    aliases: ["Accommodation Proof", "Hotel Confirmation"],
    ocrExtractable: false,
    legacyCode: "DOC-07",
  },
  {
    code: "FLIGHT_ITINERARY",
    name: "Flight Itinerary",
    category: "TRAVEL",
    defaultDescription: "Confirmed or refundable-hold return itinerary",
    aliases: ["Return Ticket", "Flight Reservation"],
    ocrExtractable: false,
    legacyCode: "DOC-08",
  },
  {
    code: "TRAVEL_INSURANCE",
    name: "Travel Insurance",
    category: "TRAVEL",
    defaultDescription: "Required by Schengen and several other missions",
    aliases: ["Medical Travel Insurance", "Travel Insurance Certificate"],
    ocrExtractable: false,
    legacyCode: "DOC-09",
  },
  {
    code: "ISSUED_VISA_SCAN",
    name: "Issued Visa",
    category: "IDENTITY",
    defaultDescription: "Scanned copy of the issued visa, attached by the concierge on approval",
    aliases: [],
    ocrExtractable: false,
    legacyCode: "DOC-10",
  },

  // ── New semantic-only types — needed to express document GROUPS and
  // attribute-conditional requirements seen across the seven checklists ──
  {
    code: "SALARY_SLIPS",
    name: "Salary Slips",
    category: "EMPLOYMENT",
    defaultDescription: "Most recent 3 months' salary slips",
    // Singular "Salary slip" added 2026-08-13 — the StampMyVisa corpus's
    // own label for this exact document (18 rows), which the plural
    // catalogue name missed by one character.
    aliases: ["Payslips", "Salary slip"],
    ocrExtractable: false,
  },
  {
    code: "EMPLOYMENT_CONTRACT",
    name: "Employment Contract",
    category: "EMPLOYMENT",
    // "Appointment Letter" was REMOVED from this list (Phase 10c follow-up)
    // — it collided with the unrelated VISA_APPOINTMENT_CONFIRMATION type
    // below. USA/UK/France checklists all use "Appointment letter"/
    // "Appointment slip" to mean the VISA appointment confirmation, not a
    // job appointment letter; the string matcher (utils/
    // visaChecklistCatalogueMatcher.ts) mis-mapped France's "Appointment
    // letter" row to this code via that alias during the 27-PDF pilot,
    // while the LLM correctly declined because it read the surrounding
    // checklist context. See VISA_APPOINTMENT_CONFIRMATION for where that
    // phrase now resolves instead.
    defaultDescription: "Signed contract confirming current employment",
    aliases: [],
    ocrExtractable: false,
  },
  {
    code: "VISA_APPOINTMENT_CONFIRMATION",
    name: "Visa Appointment Confirmation",
    category: "TRAVEL",
    defaultDescription: "Confirmation of the visa application appointment slot, carried on the day of the appointment",
    aliases: ["Appointment Letter", "Appointment Slip", "Visa Appointment Slip"],
    ocrExtractable: false,
  },
  {
    code: "VISA_APPLICATION_FORM",
    name: "Visa Application Form",
    category: "TRAVEL",
    defaultDescription: "The applicant's own completed visa application form for this specific destination",
    aliases: [
      "Application form",
      "Visa Application Form",
      "Visa application form",
      "Online Visa Application Form",
      "Online submitted application form",
      "Form V39A",
      "Application for Schengen Visa (No. 119031)",
      "Application Form (B1-84 FORM)",
    ],
    ocrExtractable: false,
  },
  {
    code: "FORM_16",
    name: "Form 16",
    category: "FINANCIAL",
    defaultDescription: "Annual tax-withholding certificate issued by the employer",
    aliases: [],
    ocrExtractable: false,
  },
  {
    code: "SPONSOR_BANK_STATEMENT",
    name: "Sponsor's Bank Statement",
    category: "FINANCIAL",
    defaultDescription: "Last 6 months' bank statement of the person funding the trip",
    aliases: ["Financial Sponsor's Bank Statement"],
    ocrExtractable: false,
  },
  {
    code: "COMPANY_BANK_STATEMENT",
    name: "Company Bank Statement",
    category: "FINANCIAL",
    defaultDescription: "Bank statement for the applicant's own registered business, distinct from a personal or sponsor's statement",
    aliases: ["Company Bank Statement", "Company bank statement", "Last 3 months Company Bank Statement", "Company 3 months bank statement"],
    ocrExtractable: false,
  },
  {
    code: "INCOME_FROM_PROPERTY_OR_BUSINESS",
    name: "Income From Property or Business",
    category: "FINANCIAL",
    defaultDescription: "Proof of regular income generated by ownership of property or a business, for applicants without salaried employment",
    aliases: [
      "Proof of regular income generated by ownership of property or business",
      "Proof of regular income generated by ownership of property or business.",
      "Proof of regular income generated by ownership of property or busines",
      "Proof of income generated by ownership of property or business",
    ],
    ocrExtractable: false,
  },
  {
    code: "SPONSORSHIP_LETTER",
    name: "Sponsorship Letter",
    category: "SPONSORSHIP",
    defaultDescription: "Letter from the sponsor confirming financial support for the trip",
    aliases: ["Affidavit of Support", "Letter of Financial Sponsorship", "Sponsorship proof"],
    ocrExtractable: false,
  },
  {
    code: "MARRIAGE_CERTIFICATE",
    name: "Marriage Certificate",
    category: "CIVIL_STATUS",
    defaultDescription: "Proof of marriage, required when travelling with or sponsored by a spouse",
    aliases: [],
    ocrExtractable: false,
  },
  {
    code: "BIRTH_CERTIFICATE",
    name: "Birth Certificate",
    category: "CIVIL_STATUS",
    defaultDescription: "Proof of parentage/age for a minor applicant",
    aliases: [],
    ocrExtractable: false,
  },
  {
    code: "PARENTAL_CONSENT_LETTER",
    name: "Parental Consent Letter",
    category: "CIVIL_STATUS",
    defaultDescription: "Notarised consent from both parents/guardians for a minor travelling without them",
    aliases: ["Minor Consent Letter"],
    ocrExtractable: false,
  },
  {
    code: "DIVORCE_CERTIFICATE",
    name: "Divorce Certificate",
    category: "CIVIL_STATUS",
    defaultDescription: "Divorce decree or certificate evidencing the applicant's marital status",
    aliases: ["Divorce papers", "Divorce paper", "Divorce decree", "Divorce decree/ custody decree"],
    ocrExtractable: false,
  },
  {
    code: "PRIOR_VISA_COPY",
    name: "Prior Visa Copy",
    category: "VISA_HISTORY",
    defaultDescription: "Copy of a previously issued visa relevant to this application's eligibility",
    aliases: ["Copy of Valid US Visa", "Copy of Valid Schengen Visa"],
    ocrExtractable: false,
  },
  {
    code: "PASSPORT_VISA_STAMP_PAGES",
    name: "Passport Visa/Stamp Pages",
    category: "VISA_HISTORY",
    defaultDescription: "Copy of every passport page bearing a visa, entry, or exit stamp, evidencing prior international travel",
    // Deliberately NOT aliasing generic phrases like "Passport photocopied" or
    // "Copy of passport pages" — those exact words appeared in this corpus
    // meaning this concept, but they're generic enough to mean something else
    // (a plain passport copy) in a different checklist. Same collision class
    // as EMPLOYMENT_CONTRACT's now-removed "Appointment Letter" alias above;
    // the LLM can still map them here via context once this type exists.
    aliases: [
      "All pages of your travel document containing visas, entry and exit stamps",
      "entry and exit stamps",
      "Enter Exit Stamp pages on passport",
    ],
    ocrExtractable: false,
  },
  {
    code: "BUSINESS_REGISTRATION",
    name: "Business Registration",
    category: "BUSINESS",
    defaultDescription: "Proof of business ownership/registration for a self-employed applicant",
    aliases: ["Company Registration Certificate", "Business Registration Certificate"],
    ocrExtractable: false,
  },
  {
    code: "PENSION_OR_RETIREMENT_PROOF",
    name: "Pension / Retirement Proof",
    category: "FINANCIAL",
    defaultDescription: "Pension statement or retirement order for a retired applicant",
    aliases: ["Retirement Order", "pension proof", "Retirement Proof"],
    ocrExtractable: false,
  },
  {
    code: "STUDENT_ENROLLMENT_LETTER",
    name: "Student Enrollment Letter",
    category: "EMPLOYMENT",
    defaultDescription: "Institution letter confirming current enrollment, for a student applicant",
    // "School NOC" added 2026-08-13: the StampMyVisa corpus uses it for the
    // same document this type already covers ("Bonafide certificate (or)
    // Leave letter from educational institution"), 14 rows.
    aliases: ["Bonafide Certificate", "School NOC"],
    ocrExtractable: false,
  },
  {
    code: "COVER_LETTER",
    name: "Cover Letter",
    category: "TRAVEL",
    defaultDescription: "Applicant's own letter explaining the purpose and itinerary of the trip",
    aliases: ["Purpose of Visit Letter"],
    ocrExtractable: false,
  },

  // ── 2026-08-13 — types the StampMyVisa catalogue asks for by name
  // (docs/visa/visa-rules-stampmyvisa.FIXED.json, 273 requirement rows
  // across the five). Without these the codes would be written onto
  // VisaRule.documentGroups[].docTypeCodes — which the model does NOT
  // validate — and render as unresolvable rows in the checklist UI.
  //
  // Three of the five overlap an existing type without being the same
  // thing; each is documented at its entry rather than silently merged,
  // and the ALIASES ARE DELIBERATELY SPARSE. Aliases are live matching
  // input for utils/visaChecklistCatalogueMatcher.ts, so a broad phrase
  // added here would start stealing matches from the older, more specific
  // type in every FUTURE checklist extraction — exactly the collision
  // EMPLOYMENT_CONTRACT's removed "Appointment Letter" alias caused.
  {
    code: "PASSPORT_FRONT",
    name: "Passport Front Page",
    category: "IDENTITY",
    // Distinct from PASSPORT_ORIGINAL, which is the physical passport
    // submitted to the mission. This is the SCAN of the bio-data page an
    // e-visa portal uploads, and it travels as a pair with PASSPORT_BACK.
    defaultDescription: "Scan of the passport's front/bio-data page, as uploaded to an e-visa portal",
    aliases: ["Passport Front Page", "Front page of passport"],
    ocrExtractable: false,
  },
  {
    code: "PASSPORT_BACK",
    name: "Passport Back Page",
    category: "IDENTITY",
    // Overlaps PASSPORT_LAST_PAGE, which already means the back-page copy
    // submitted alongside a physical application (and already aliases
    // "Passport back page"). Kept separate because this one is the e-visa
    // upload half of the FRONT/BACK pair above, not a supporting copy —
    // but the two are worth consolidating once ops decides which one the
    // checklist UI should show. Flagged, not silently merged.
    defaultDescription: "Scan of the passport's back/address page, as uploaded to an e-visa portal",
    aliases: [],
    ocrExtractable: false,
  },
  {
    code: "NATIONAL_ID",
    name: "National ID",
    category: "IDENTITY",
    // Deliberately NOT folded into INDIAN_GOVT_ID_CARD: that type is
    // specifically PAN/Aadhaar, and this one appears on destinations that
    // accept any national identity card, including for non-Indian
    // co-applicants.
    defaultDescription: "Government-issued national identity card",
    aliases: [],
    ocrExtractable: false,
  },
  {
    code: "BUSINESS_PROOF",
    name: "Business Proof",
    category: "BUSINESS",
    // Broader than BUSINESS_REGISTRATION (an incorporation/registration
    // certificate): the source uses this for whatever evidences the
    // business — GST certificate, trade licence, partnership deed.
    defaultDescription: "Evidence of the applicant's business — registration certificate, GST certificate, trade licence or partnership deed",
    // "partnership deed" added 2026-08-13 (20 rows in the StampMyVisa
    // corpus) — specific enough that it cannot steal a match from
    // BUSINESS_REGISTRATION, which is the incorporation certificate.
    aliases: ["partnership deed", "GST Certificate"],
    ocrExtractable: false,
  },
  // ── 2026-08-13 (second pass) — the genuinely-missing document types
  // behind the seeded catalogue's "needs mapping" backlog. NINE of the
  // types this pass was asked for already existed and are deliberately NOT
  // duplicated here — Business Registration (BUSINESS_REGISTRATION),
  // Rental Agreement (ADDRESS_PROOF, which already aliases "Rent
  // agreement"), Pension/Retirement Proof (PENSION_OR_RETIREMENT_PROOF),
  // Marriage/Divorce Certificate, Leave Letter (EMPLOYER_NOC's own
  // aliases), Bonafide Certificate (STUDENT_ENROLLMENT_LETTER). A second
  // code for a document that already has one would split its checklist
  // rows across two types forever.
  {
    code: "HIGHER_EDUCATION_DEGREE",
    name: "Higher Education Degree",
    category: "EMPLOYMENT",
    defaultDescription: "Degree certificate or marksheet evidencing the applicant's highest completed qualification",
    aliases: ["Higher Education Degree", "Education certificate"],
    ocrExtractable: false,
  },
  {
    code: "NAME_CHANGE_AFFIDAVIT",
    name: "Name Change Affidavit",
    category: "CIVIL_STATUS",
    defaultDescription: "Notarised affidavit or gazette notification evidencing a change of name, where the passport and supporting documents differ",
    aliases: ["Name Change Affidavit", "Name change"],
    ocrExtractable: false,
  },
  {
    code: "VISITING_CARD",
    name: "Visiting Card",
    category: "EMPLOYMENT",
    defaultDescription: "The applicant's business/visiting card, asked for by several missions as supplementary proof of designation",
    aliases: ["Visiting Card", "Business Card"],
    ocrExtractable: false,
  },
  {
    code: "RESUME",
    name: "Resume",
    category: "EMPLOYMENT",
    defaultDescription: "The applicant's curriculum vitae",
    aliases: ["Resume", "Curriculum Vitae", "CV"],
    ocrExtractable: false,
  },
  {
    code: "LETTER_OF_ENGAGEMENT",
    name: "Letter of Engagement",
    category: "EMPLOYMENT",
    // A freelancer's equivalent of EMPLOYER_NOC — issued by the CLIENT, not
    // an employer, so it is not that type and must not alias into it.
    defaultDescription: "Client's letter of engagement for a freelance or contract applicant, in place of an employer letter",
    aliases: ["Letter of Engagement"],
    ocrExtractable: false,
  },
  {
    code: "FREELANCE_PAYMENT_PROOF",
    name: "Freelance Payment Proof",
    category: "FINANCIAL",
    defaultDescription: "Invoices or payment receipts evidencing freelance income",
    aliases: ["Payment Proof - Freelance"],
    ocrExtractable: false,
  },
  {
    code: "INVESTMENT_PROOF",
    name: "Investment Proofs",
    category: "FINANCIAL",
    defaultDescription: "Statements for fixed deposits, mutual funds, shares or other investments, offered as evidence of funds",
    aliases: ["Investment Proofs", "Investment Proof"],
    ocrExtractable: false,
  },
  {
    code: "PROPERTY_OWNERSHIP_PROOF",
    name: "Property Ownership Proof",
    category: "FINANCIAL",
    // Distinct from INCOME_FROM_PROPERTY_OR_BUSINESS, which evidences the
    // INCOME a property generates. This one evidences owning it.
    defaultDescription: "Title deed, sale deed or property tax receipt evidencing ownership of immovable property",
    aliases: ["Property Ownership Proof", "Property Papers"],
    ocrExtractable: false,
  },
  {
    code: "POLICE_CLEARANCE_CERTIFICATE",
    name: "Police Clearance Certificate",
    category: "IDENTITY",
    defaultDescription: "Police clearance certificate (PCC) issued by the applicant's local authority",
    aliases: ["Police Clearance Certificate", "PCC"],
    ocrExtractable: false,
  },
  {
    code: "JOB_OFFER_LETTER",
    name: "Job Offer Letter",
    category: "EMPLOYMENT",
    // Deliberately separate from EMPLOYMENT_CONTRACT (a signed contract of
    // CURRENT employment): an offer letter evidences employment not yet
    // started, which is a different thing to a consulate.
    defaultDescription: "Offer of employment, for an applicant who has accepted a role not yet commenced",
    aliases: ["Job Offer Letter", "Offer Letter"],
    ocrExtractable: false,
  },
  {
    code: "DS_160_CONFIRMATION",
    name: "DS-160 Confirmation",
    category: "TRAVEL",
    // US-specific counterpart of VISA_APPLICATION_FORM. Kept separate
    // because the DS-160 confirmation PAGE (with its barcode) is what the
    // consulate actually demands, not the form itself.
    defaultDescription: "DS-160 confirmation page with barcode, for a United States visa application",
    aliases: ["DS-160 Form", "DS-160", "DS160 Confirmation"],
    ocrExtractable: false,
  },
  {
    code: "FOREIGN_COMPANY_REGISTRATION",
    name: "Foreign Company Registration",
    category: "BUSINESS",
    // The registration papers of the DESTINATION-country company hosting
    // the applicant — not the applicant's own business
    // (BUSINESS_REGISTRATION), which is why it is its own type.
    defaultDescription: "Registration papers of the inviting company in the destination country",
    aliases: ["Destination company's registration papers"],
    ocrExtractable: false,
  },
  // ── 2026-08-13 (third pass) — three types the seeded corpus asks for
  // that had no home at all. Each was verified against the STORED labels
  // before being written: matchDocumentType indexes [code, name,
  // ...aliases] and compares the WHOLE normalised string, so a type only
  // clears a flag if one of those three forms equals the stored label
  // exactly once normalised.
  {
    code: "OCCUPATION_PROOF",
    name: "Occupation Proof",
    category: "EMPLOYMENT",
    // No alias needed: the stored labels are "OCCUPATION_PROOF" and
    // "Occupation proof", both of which normalise to "occupation proof" —
    // which is this entry's own CODE, and the code is in the match index.
    //
    // "Sponsor's Occupation Proof" (16 rules) is deliberately NOT aliased
    // here: that is the SPONSOR's occupation, a different person's
    // document, and folding it in would silently answer a question about
    // the applicant with evidence about someone else.
    defaultDescription: "Proof of the applicant's current occupation — an employment letter, company ID card, or business registration, whichever fits",
    aliases: [],
    ocrExtractable: false,
  },
  {
    code: "STUDENT_ID_CARD",
    name: "Student ID Card",
    category: "IDENTITY",
    // Its own type, NOT an alias of STUDENT_ENROLLMENT_LETTER: an ID card
    // is a physical identity document, the bonafide/enrollment letter is
    // an institution's written confirmation. They sit side by side in the
    // source ("Bonafide certificate (or) ... (or) Student identity card").
    //
    // "Student ID" IS required as an alias — the stored label normalises
    // to "student id", which equals neither the code ("student id card")
    // nor the name. Without it this entry would clear nothing.
    defaultDescription: "Institution-issued student identity card",
    aliases: ["Student ID", "Student identity card"],
    ocrExtractable: false,
  },
  {
    code: "VISA_FEE_PAYMENT_RECEIPT",
    name: "Visa Fee Payment Receipt",
    category: "FINANCIAL",
    // "Payment receipt" is required for the same reason as above (the
    // stored label is "Payment receipt", not the code or the name). It is
    // safe despite being generic: no other type claims a payment receipt,
    // and FREELANCE_PAYMENT_PROOF's own alias is the distinct string
    // "Payment Proof - Freelance", so neither can steal from the other.
    defaultDescription: "Copy of the receipt for the visa fee paid to the mission or visa centre",
    aliases: ["Payment receipt"],
    ocrExtractable: false,
  },

  {
    code: "TRAVEL_AGENCY_CERTIFICATE",
    name: "Travel Agency Certificate",
    category: "TRAVEL",
    defaultDescription: "Certificate or covering letter issued by the booking travel agency, signed and stamped by an authorised representative",
    aliases: ["Travel agency certificate"],
    ocrExtractable: false,
  },

  {
    code: "TRAVEL_ITINERARY",
    name: "Travel Itinerary",
    category: "TRAVEL",
    // Not FLIGHT_ITINERARY (the confirmed/held air booking): this is the
    // day-by-day plan of the trip, which several missions ask for in
    // ADDITION to the flight booking.
    defaultDescription: "Day-by-day plan of the trip, covering destinations and dates for the full stay",
    aliases: ["Day-wise itinerary", "Detailed itinerary"],
    ocrExtractable: false,
  },
] as const;

// Mechanically derived from legacyCode above — the "old to new" mapping
// this phase's task brief asks to be reported. Never hand-maintained
// separately from the catalogue entries themselves.
export const OLD_TO_NEW_DOC_CODE_MAP: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    VISA_DOCUMENT_TYPE_CATALOGUE.filter((d) => d.legacyCode).map((d) => [d.legacyCode as string, d.code]),
  ),
);

/**
 * Given EITHER an old DOC-NN code or a new semantic code, returns the
 * canonical (new) semantic code. Codes with no legacy mapping (already
 * semantic, or unknown) pass through unchanged — this never throws, since
 * callers use it to normalise a value for lookup/reporting, not to validate.
 */
export function canonicalizeVisaDocumentCode(code: string): string {
  return OLD_TO_NEW_DOC_CODE_MAP[code] ?? code;
}

export function getVisaDocumentTypeSeed(code: string): VisaDocumentTypeSeed | undefined {
  const canonical = canonicalizeVisaDocumentCode(code);
  return VISA_DOCUMENT_TYPE_CATALOGUE.find((d) => d.code === canonical);
}

/** The passport's canonical code. Its legacy twin ("DOC-01") resolves here. */
export const PASSPORT_CANONICAL_DOC_CODE = "PASSPORT_ORIGINAL";

/**
 * The ONLY passport-identity test in the system. Every consumer — the OCR
 * trigger, the confirm/write-back gate, the checklist row's isPassport flag,
 * the document summary's — goes through this, so "DOC-01" and
 * "PASSPORT_ORIGINAL" are one thing everywhere and a third alias added to the
 * catalogue later is picked up by all of them at once.
 *
 * WHY THIS EXISTS (2026-08-08): the OCR trigger, the confirm gate and the
 * frontend's own mirrored copy of the code all compared raw-equal to the
 * LEGACY "DOC-01". Applications built from documentGroups carry the catalogue
 * code, so every passport uploaded from 2026-08-03 onward silently skipped
 * extraction (5 documents stuck PENDING with no fields) AND read as
 * "no passport uploaded" at the review gate. Note this file's own
 * OLD_TO_NEW_DOC_CODE_MAP and visaChecklistHydration.ts's withCanonicalAliases
 * had already solved exactly this hazard for DOC-07/08/09 — the passport was
 * simply never given the same treatment.
 *
 * Deliberately NOT driven off the catalogue's `ocrExtractable` flag, even
 * though that is true for this one entry and nothing else today: extraction
 * runs a TD3-passport-specific MRZ parser (utils/mrz.ts), so a future
 * OCR-able non-passport type must not start firing it by inheriting a flag.
 */
export function isPassportDocCode(code: string | null | undefined): boolean {
  return matchesCanonicalDocCode(code, PASSPORT_CANONICAL_DOC_CODE);
}

/** The photograph's canonical code. Its legacy twin ("DOC-02") resolves here. */
export const PHOTOGRAPH_CANONICAL_DOC_CODE = "PHOTOGRAPH";

/**
 * Same contract as isPassportDocCode, for the applicant photograph — used by
 * the review screen to find the photo to display. Routed through the alias
 * map for the same reason: a rule built from documentGroups carries
 * "PHOTOGRAPH" while a legacy one carries "DOC-02", and a raw equality
 * against either silently misses the other. That was the 2026-08-08 passport
 * bug; it is not repeated here.
 */
export function isPhotographDocCode(code: string | null | undefined): boolean {
  return matchesCanonicalDocCode(code, PHOTOGRAPH_CANONICAL_DOC_CODE);
}

/**
 * Shared body for the per-type predicates above. Extracted at the second one
 * rather than the third: two hand-copied canonicalise-and-compare bodies is
 * exactly how the first alias bug got missed on one of its call sites.
 */
function matchesCanonicalDocCode(code: string | null | undefined, canonical: string): boolean {
  if (!code) return false;
  return canonicalizeVisaDocumentCode(String(code)) === canonical;
}
