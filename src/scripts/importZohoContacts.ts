// apps/backend/src/scripts/importZohoContacts.ts
//
// Imports Zoho CRM contacts from an xlsx export into MongoDB.
// BUSINESS contacts → Customer + CustomerWorkspace (trial plan, all features off)
// INDIVIDUAL contacts → Customer only (segment: 'individual')
//
// Idempotent: if record exists → UPDATE with full data. If not → CREATE.
//
// Usage:
//   npx tsx src/scripts/importZohoContacts.ts src/scripts/contacts.xlsx

import { createRequire } from "module";
import path from "path";
import { connectDb } from "../config/db.js";
import Customer from "../models/Customer.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

// ─── Row interface ───────────────────────────────────────────────────────────

interface ZohoRow {
  "Created Time"?: string;
  "Last Modified Time"?: string;
  "Display Name"?: string;
  "Company Name"?: string;
  Salutation?: string;
  "First Name"?: string;
  "Last Name"?: string;
  Phone?: string;
  "Currency Code"?: string;
  Notes?: string;
  Website?: string;
  Status?: string;
  "Created By"?: string;
  "Opening Balance"?: string;
  "Bank Account Payment"?: string;
  "Portal Enabled"?: string;
  "Credit Limit"?: string;
  "Customer Sub Type"?: string;
  "Billing Attention"?: string;
  "Billing Address"?: string;
  "Billing Street2"?: string;
  "Billing City"?: string;
  "Billing State"?: string;
  "Billing Country"?: string;
  "Billing County"?: string;
  "Billing Code"?: string;
  "Billing Phone"?: string;
  "Billing Fax"?: string;
  "Billing Latitude"?: string;
  "Billing Longitude"?: string;
  "Shipping Attention"?: string;
  "Shipping Address"?: string;
  "Shipping Street2"?: string;
  "Shipping City"?: string;
  "Shipping State"?: string;
  "Shipping Country"?: string;
  "Shipping County"?: string;
  "Shipping Code"?: string;
  "Shipping Phone"?: string;
  "Shipping Fax"?: string;
  "Shipping Latitude"?: string;
  "Shipping Longitude"?: string;
  "Skype Identity"?: string;
  Facebook?: string;
  Twitter?: string;
  Department?: string;
  Designation?: string;
  "Price List"?: string;
  "Payment Terms"?: string;
  "Payment Terms Label"?: string;
  "GST Treatment"?: string;
  "GST Identification Number (GSTIN)"?: string;
  "Owner Name"?: string;
  "Primary Contact ID"?: string;
  EmailID?: string;
  MobilePhone?: string;
  "Contact ID"?: string;
  "Contact Name"?: string;
  "Contact Type"?: string;
  "Place Of Contact"?: string;
  "Place of Contact(With State Code)"?: string;
  Taxable?: string;
  TaxID?: string;
  "Tax Name"?: string;
  "Tax Percentage"?: string;
  "Exemption Reason"?: string;
  "Contact Address ID"?: string;
  Source?: string;
  [key: string]: string | undefined;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function str(v: string | undefined): string {
  return (v ?? "").toString().trim();
}

function opt(v: string | undefined): string | undefined {
  const s = str(v);
  return s !== "" ? s : undefined;
}

function parseBool(v: string | undefined): boolean | undefined {
  const s = str(v).toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return undefined;
}

function parseNum(v: string | undefined): number | undefined {
  const s = str(v);
  if (s === "") return undefined;
  const n = parseFloat(s);
  return isNaN(n) ? undefined : n;
}

function parseDate(v: string | undefined): Date | undefined {
  const s = str(v);
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

function isBusiness(row: ZohoRow): boolean {
  const sub = str(row["Customer Sub Type"]).toLowerCase();
  const company = str(row["Company Name"]);
  return sub === "business_gst" || sub === "business_none" || company !== "";
}

function statusFromZoho(raw: string | undefined): "ACTIVE" | "INACTIVE" {
  return str(raw).toLowerCase() === "inactive" ? "INACTIVE" : "ACTIVE";
}

// ─── Build full Customer payload from a row ──────────────────────────────────

function buildCustomerData(row: ZohoRow, isBusinessType: boolean) {
  const name = str(row["Display Name"]);
  const companyName = str(row["Company Name"]);

  return {
    name,
    legalName: companyName || name || undefined,
    companyName: opt(row["Company Name"]),
    salutation: opt(row["Salutation"]),
    firstName: opt(row["First Name"]),
    lastName: opt(row["Last Name"]),
    email: opt(row["EmailID"])?.toLowerCase(),
    phone: opt(row["Phone"]) || opt(row["MobilePhone"]),
    mobile: opt(row["MobilePhone"]) || opt(row["Phone"]),
    website: opt(row["Website"]),
    type: "CUSTOMER",
    status: statusFromZoho(row["Status"]),
    ...(isBusinessType ? {} : { segment: "individual" }),
    gstNumber: opt(row["GST Identification Number (GSTIN)"]),
    gstTreatment: opt(row["GST Treatment"]),
    subType: opt(row["Customer Sub Type"]),
    zohoContactId: opt(row["Contact ID"]),
    source: "zoho_import",
    importedAt: new Date(),

    // Billing address
    address: {
      street: opt(row["Billing Address"]),
      street2: opt(row["Billing Street2"]),
      city: opt(row["Billing City"]),
      state: opt(row["Billing State"]),
      country: opt(row["Billing Country"]),
      pincode: opt(row["Billing Code"]),
    },

    // Billing extras
    billingAttention: opt(row["Billing Attention"]),
    billingPhone: opt(row["Billing Phone"]),
    billingFax: opt(row["Billing Fax"]),
    billingLatitude: opt(row["Billing Latitude"]),
    billingLongitude: opt(row["Billing Longitude"]),
    billingCounty: opt(row["Billing County"]),

    // Shipping address
    shippingAddress: {
      attention: opt(row["Shipping Attention"]),
      street: opt(row["Shipping Address"]),
      street2: opt(row["Shipping Street2"]),
      city: opt(row["Shipping City"]),
      state: opt(row["Shipping State"]),
      country: opt(row["Shipping Country"]),
      county: opt(row["Shipping County"]),
      pincode: opt(row["Shipping Code"]),
      phone: opt(row["Shipping Phone"]),
      fax: opt(row["Shipping Fax"]),
      latitude: opt(row["Shipping Latitude"]),
      longitude: opt(row["Shipping Longitude"]),
    },

    // Zoho metadata
    createdTime: parseDate(row["Created Time"]),
    lastModifiedTime: parseDate(row["Last Modified Time"]),
    zohoCurrency: opt(row["Currency Code"]),
    zohoNotes: opt(row["Notes"]),
    zohoCreatedBy: opt(row["Created By"]),
    openingBalance: parseNum(row["Opening Balance"]),
    creditLimit: parseNum(row["Credit Limit"]),
    portalEnabled: parseBool(row["Portal Enabled"]),
    bankAccountPayment: parseBool(row["Bank Account Payment"]),
    priceList: opt(row["Price List"]),
    paymentTerms: opt(row["Payment Terms"]),
    paymentTermsLabel: opt(row["Payment Terms Label"]),
    ownerName: opt(row["Owner Name"]),
    primaryContactId: opt(row["Primary Contact ID"]),
    contactAddressId: opt(row["Contact Address ID"]),
    zohoSource: opt(row["Source"]),

    // Tax
    taxable: parseBool(row["Taxable"]),
    taxId: opt(row["TaxID"]),
    taxName: opt(row["Tax Name"]),
    taxPercentage: parseNum(row["Tax Percentage"]),
    exemptionReason: opt(row["Exemption Reason"]),
    placeOfContact: opt(row["Place Of Contact"]),
    placeOfContactWithStateCode: opt(row["Place of Contact(With State Code)"]),

    // Social
    skype: opt(row["Skype Identity"]),
    facebook: opt(row["Facebook"]),
    twitter: opt(row["Twitter"]),

    // Professional
    department: opt(row["Department"]),
    designation: opt(row["Designation"]),

    // Contact details
    contactName: opt(row["Contact Name"]),
    contactType: opt(row["Contact Type"]),

    // Key contacts — built from the contact-level name/email/mobile fields
    keyContacts: (opt(row["First Name"]) || opt(row["Last Name"]))
      ? [
          {
            name: [opt(row["Salutation"]), opt(row["First Name"]), opt(row["Last Name"])]
              .filter(Boolean)
              .join(" ")
              .trim(),
            designation: opt(row["Designation"]) || "",
            email: opt(row["EmailID"])?.toLowerCase() || "",
            mobile: opt(row["MobilePhone"]) || opt(row["Phone"]) || "",
          },
        ]
      : [],

    workspaceId: "69679a7628330a58d29f2254",
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("❌ Usage: npx tsx src/scripts/importZohoContacts.ts <path-to-xlsx>");
    process.exit(1);
  }

  const resolved = path.resolve(filePath);
  console.log(`📂 Reading: ${resolved}`);

  await connectDb();
  console.log("✅ Connected to MongoDB\n");

  const workbook = XLSX.readFile(resolved);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows: ZohoRow[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  console.log(`📋 Total rows: ${rows.length}\n`);

  const stats = {
    business: { created: 0, updated: 0, errors: 0 },
    individual: { created: 0, updated: 0, errors: 0 },
  };

  for (const row of rows) {
    const name = str(row["Display Name"]);
    const companyName = str(row["Company Name"]);
    const email = opt(row["EmailID"])?.toLowerCase();
    const gstNumber = opt(row["GST Identification Number (GSTIN)"]);
    const zohoContactId = opt(row["Contact ID"]);

    const label = isBusiness(row) ? "BUSINESS" : "INDIVIDUAL";
    const displayLabel = label === "BUSINESS" ? (companyName || name) : name;

    try {
      const data = buildCustomerData(row, label === "BUSINESS");

      if (label === "BUSINESS") {
        // ── BUSINESS ──────────────────────────────────────────────────────
        const orClauses: object[] = [];
        if (gstNumber) orClauses.push({ gstNumber });
        if (email) orClauses.push({ email });
        if (zohoContactId) orClauses.push({ zohoContactId });
        if (name) orClauses.push({ name });

        const exists = orClauses.length
          ? await Customer.findOne({ $or: orClauses }).lean()
          : null;

        if (exists) {
          await Customer.findByIdAndUpdate(exists._id, { $set: data });
          console.log(`🔄 UPDATED  [BUSINESS] ${displayLabel}`);
          stats.business.updated++;

          // Also update CustomerWorkspace
          await CustomerWorkspace.findOneAndUpdate(
            { customerId: exists._id.toString() },
            {
              $set: {
                companyName: companyName || name || undefined,
                gstNumber,
                website: opt(row["Website"]),
                phone: opt(row["Phone"]),
                email,
                address: {
                  line1: opt(row["Billing Address"]),
                  line2: opt(row["Billing Street2"]),
                  city: opt(row["Billing City"]),
                  state: opt(row["Billing State"]),
                  country: opt(row["Billing Country"]),
                  pincode: opt(row["Billing Code"]),
                },
              },
            }
          );
          continue;
        }

        const customer = await Customer.create(data);

        await CustomerWorkspace.create({
          customerId: customer._id.toString(),
          companyName: companyName || name,
          gstNumber,
          website: opt(row["Website"]),
          phone: opt(row["Phone"]),
          email,
          address: {
            line1: opt(row["Billing Address"]),
            line2: opt(row["Billing Street2"]),
            city: opt(row["Billing City"]),
            state: opt(row["Billing State"]),
            country: opt(row["Billing Country"]),
            pincode: opt(row["Billing Code"]),
          },
          plan: "trial",
          travelMode: "APPROVAL_FLOW",
          config: {
            travelFlow: "APPROVAL_FLOW",
            approval: {
              requireL2: true,
              requireL0: false,
              requireProposal: true,
            },
            tokenExpiryHours: 12,
            features: {
              sbtEnabled: false,
              approvalFlowEnabled: false,
              approvalDirectEnabled: false,
              flightBookingEnabled: false,
              hotelBookingEnabled: false,
              visaEnabled: false,
              miceEnabled: false,
              forexEnabled: false,
              esimEnabled: false,
              payrollEnabled: false,
              performanceEnabled: false,
              attendanceEnabled: false,
              leaveEnabled: false,
              onboardingEnabled: false,
              analyticsEnabled: false,
            },
          },
          status: "ACTIVE",
        });

        console.log(`✅ CREATED  [BUSINESS] ${displayLabel}`);
        stats.business.created++;

      } else {
        // ── INDIVIDUAL ────────────────────────────────────────────────────
        const orClauses: object[] = [];
        if (email) orClauses.push({ email });
        if (zohoContactId) orClauses.push({ zohoContactId });
        if (name) orClauses.push({ name });

        const exists = orClauses.length
          ? await Customer.findOne({ $or: orClauses }).lean()
          : null;

        if (exists) {
          await Customer.findByIdAndUpdate(exists._id, { $set: data });
          console.log(`🔄 UPDATED  [INDIVIDUAL] ${displayLabel}`);
          stats.individual.updated++;
          continue;
        }

        await Customer.create(data);
        console.log(`✅ CREATED  [INDIVIDUAL] ${displayLabel}`);
        stats.individual.created++;
      }
    } catch (err: any) {
      console.error(`❌ ERROR    [${label}] ${displayLabel} → ${err.message}`);
      if (label === "BUSINESS") stats.business.errors++;
      else stats.individual.errors++;
    }
  }

  // Backfill workspaceId on all Zoho-imported docs that were created before this fix
  const backfill = await Customer.updateMany(
    { source: "zoho_import", workspaceId: { $exists: false } },
    { $set: { workspaceId: "69679a7628330a58d29f2254" } }
  );
  console.log(`✅ Backfilled workspaceId on ${backfill.modifiedCount} imported records`);

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Final Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Business   — created: ${stats.business.created}, updated: ${stats.business.updated}, errors: ${stats.business.errors}
Individual — created: ${stats.individual.created}, updated: ${stats.individual.updated}, errors: ${stats.individual.errors}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Import failed:", err);
  process.exit(1);
});
