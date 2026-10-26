// apps/backend/src/services/msaDocx.ts
//
// Fills the Plumtrips MSA Word template (assets/msa/) with a business's
// identity fields for the "Download MSA" action on /profile/businesses.
//
// Only client identity/contact placeholders are filled. Commercial terms
// (wallet_*, credit_*, tier*_, caps, interest) and the Plumtrips
// representative (sp_rep_*) are deliberately left to the nullGetter, so they
// print as a blank line for sales/legal to complete by hand.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// src/services and dist/services both sit two levels below apps/backend.
export const MSA_TEMPLATE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "assets",
  "msa",
  "Plumtrips_MSA_Template_v1.0.docx",
);

export const MSA_BLANK = "______________";
const MODE_STATUS_DEFAULT = "Activated / Not Activated";

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function first(...vals: unknown[]): string {
  for (const v of vals) {
    const s = str(v);
    if (s) return s;
  }
  return "";
}

function oneLineAddress(a: any): string {
  if (!a || typeof a !== "object") return "";
  return [a.street, a.street2, a.city, a.state, a.country, a.pincode].map(str).filter(Boolean).join(", ");
}

/**
 * Placeholder values from a Customer row plus its onboarding form payload
 * (Onboarding.formPayload, else Customer.onboardingSnapshot). The Customer
 * row wins — PATCH /api/customers/:id writes it and syncs the payload, not
 * the other way round. Empty values are omitted so the nullGetter blanks them.
 */
export function buildMsaValues(customer: any, formPayload?: any): Record<string, string> {
  const c = customer || {};
  const p = formPayload && typeof formPayload === "object" ? formPayload : {};
  const kc =
    (Array.isArray(c.keyContacts) && c.keyContacts[0]) ||
    (Array.isArray(p.keyContacts) && p.keyContacts[0]) ||
    {};

  const values: Record<string, string> = {
    client_name: first(c.legalName, p.legalName, p.companyName, c.name),
    client_cin: first(c.cin, p.cin),
    client_address: first(
      c.registeredAddress,
      oneLineAddress(c.address),
      p.registeredAddress,
      oneLineAddress({
        street: p.addressLine1,
        street2: p.addressLine2,
        city: p.city,
        state: p.state,
        country: p.country,
        pincode: p.pincode,
      }),
    ),
    client_business: first(c.industry, p.industry, p.natureOfBusiness, p.businessNature),
    client_gstin: first(c.gstNumber, p.gstNumber, p.gstin),
    client_pan: first(c.panNumber, p.panNumber, p.pan),
    client_signatory_name: first(p.signatory?.name),
    client_signatory_designation: first(p.signatory?.designation),
    client_rep_name: first(kc.name, c.contactName, p.contact?.name),
    client_rep_email: first(kc.email, c.email, p.officialEmail),
    client_rep_phone: first(kc.mobile, kc.phone, c.mobile, c.phone, p.contacts?.primaryPhone),
    wallet_mode_status: MODE_STATUS_DEFAULT,
    invoice_mode_status: MODE_STATUS_DEFAULT,
  };

  for (const k of Object.keys(values)) if (!values[k]) delete values[k];
  return values;
}

export function renderMsaDocx(values: Record<string, string>, templatePath = MSA_TEMPLATE_PATH): Buffer {
  const zip = new PizZip(fs.readFileSync(templatePath));
  const doc = new Docxtemplater(zip, {
    delimiters: { start: "{", end: "}" },
    paragraphLoop: false,
    linebreaks: false,
    nullGetter: () => MSA_BLANK,
  });
  doc.render(values);
  return doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

/** IST calendar date, YYYY-MM-DD — the API process runs in UTC. */
export function istDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
}

/** "Plumtrips_MSA_<ClientName>_<YYYY-MM-DD>.docx", ASCII letters/digits/_/- only. */
export function msaFilename(clientName: string, date = istDate()): string {
  const safe =
    str(clientName)
      .normalize("NFKD")
      .replace(/[^\x00-\x7F]/g, "")
      .replace(/[^A-Za-z0-9-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "Client";
  return `Plumtrips_MSA_${safe}_${date}.docx`;
}
