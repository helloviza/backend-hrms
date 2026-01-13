import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";

type RelationshipType = "Customer" | "Employee" | "Vendor";

export type OnboardingAgreementInput = {
  referenceId: string;
  effectiveDate: string;
  relationshipType: RelationshipType;
  counterpartyName: string;
  counterpartyEmail: string;
  counterpartyAddress?: string;
  companyName?: string;
};

// ─────────────────────────────────────────────
// ESM-safe __dirname
// ─────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────
// Assets
// ─────────────────────────────────────────────
const FONT_REGULAR = path.join(__dirname, "../assets/fonts/Roboto-Regular.ttf");
const FONT_BOLD = path.join(__dirname, "../assets/fonts/Roboto-Medium.ttf");

const LOGO_PATH = path.join(
  __dirname,
  "../assets/branding/plumtrips_logo.png"
);

const STAMP_PATH = path.join(
  __dirname,
  "../assets/branding/Peachmint_Stampt.png"
);

// Brand colors
const PRIMARY = "#d06549";
const SECONDARY = "#00477f";
const TEXT = "#111111";
const MUTED = "#666666";

export async function generateOnboardingAgreementPdf(
  input: OnboardingAgreementInput
): Promise<Buffer> {
  const {
    referenceId,
    effectiveDate,
    relationshipType,
    counterpartyName,
    counterpartyEmail,
    counterpartyAddress,
    companyName = "Plumtrips",
  } = input;

  const partyAlias =
    relationshipType === "Customer"
      ? "Customer"
      : relationshipType === "Employee"
      ? "Employee"
      : "Service Partner";

  const relationshipParagraph =
    relationshipType === "Customer"
      ? "Plumtrips shall provide travel, visa, and related services to the Customer as per agreed scope, subject to commercial terms, service availability, and compliance requirements."
      : relationshipType === "Employee"
      ? "The Employee is onboarded to perform duties assigned by Plumtrips in accordance with internal policies, role responsibilities, and applicable employment guidelines."
      : "The Service Partner shall provide services to Plumtrips on a non-exclusive basis, aligned with agreed service standards, timelines, and compliance norms.";

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 40, bottom: 50, left: 60, right: 40 },
  });

  const chunks: Buffer[] = [];

  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (b: Buffer) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    /* ───────── LEFT BRAND SPINE ───────── */
    doc
      .lineWidth(6)
      .moveTo(30, 0)
      .lineTo(30, 842)
      .stroke(SECONDARY);

    /* ───────── HEADER ───────── */

    doc.image(LOGO_PATH, 60, 40, { width: 90 });

    doc
      .font(FONT_BOLD)
      .fontSize(18)
      .fillColor(SECONDARY)
      .text("ONBOARDING CONFIRMATION", 0, 42, { align: "right" });

    doc
      .font(FONT_REGULAR)
      .fontSize(10)
      .fillColor(SECONDARY)
      .text("& AGREEMENT", { align: "right" });

    doc
      .font(FONT_REGULAR)
      .fontSize(8)
      .fillColor(MUTED)
      .text(`Reference ID: ${referenceId}`, 0, 78, { align: "right" })
      .text(`Effective Date: ${effectiveDate}`, { align: "right" });

    doc.moveDown(3);

    /* ───────── RELATIONSHIP SUMMARY (TABLE STYLE) ───────── */

    const summaryStartY = doc.y;

    doc
      .font(FONT_BOLD)
      .fontSize(10)
      .fillColor(SECONDARY)
      .text("RELATIONSHIP SUMMARY");

    doc
      .moveTo(60, summaryStartY + 14)
      .lineTo(555, summaryStartY + 14)
      .lineWidth(1)
      .stroke(PRIMARY);

    const row = (label: string, value: string) => {
      doc
        .font(FONT_BOLD)
        .fontSize(9)
        .fillColor(TEXT)
        .text(label, 60, doc.y + 6, { width: 150 });

      doc
        .font(FONT_REGULAR)
        .text(value, 220, doc.y - 12);
    };

    row("Relationship Type", relationshipType.toUpperCase());
    row("Counterparty Name", counterpartyName);
    row("Effective Date", effectiveDate);
    row("Reference ID", referenceId);

    doc.moveDown(2);

    /* ───────── SECTION HELPER ───────── */

    const section = (title: string, body: string) => {
      doc
        .font(FONT_BOLD)
        .fontSize(10)
        .fillColor(SECONDARY)
        .text(title.toUpperCase());

      const y = doc.y;
      doc
        .moveTo(60, y + 2)
        .lineTo(555, y + 2)
        .lineWidth(0.5)
        .stroke(PRIMARY);

      doc.moveDown(0.8);

      doc
        .font(FONT_REGULAR)
        .fontSize(9)
        .fillColor(TEXT)
        .text(body, { lineGap: 4 });

      doc.moveDown();
    };

    section(
      "Parties Involved",
      `Company:\n${companyName} (Peachmint Trips & Planners Pvt. Ltd.)\n\n${partyAlias}:\n${counterpartyName}\n${counterpartyAddress ?? ""}\n${counterpartyEmail}`
    );

    section("Relationship Definition", relationshipParagraph);

    section(
      "Term & Effect",
      `This relationship shall be effective from ${effectiveDate}, unless terminated earlier in accordance with applicable policies or agreements.`
    );

    section(
      "Confidentiality & Compliance",
      "Both parties agree to maintain confidentiality of proprietary, commercial, and personal information exchanged during the course of this relationship. All activities shall comply with applicable laws, internal policies, and regulatory standards."
    );

    section(
      "Non-Exclusivity & Limitation",
      "This confirmation does not create exclusivity unless explicitly agreed in writing. This document serves as an onboarding confirmation and does not override detailed contractual terms where applicable."
    );

    /* ───────── SIGNATORY BLOCK ───────── */

    doc.moveDown(2);

    doc
      .moveTo(60, doc.y)
      .lineTo(555, doc.y)
      .lineWidth(1)
      .stroke(MUTED);

    doc.moveDown();

    doc
      .font(FONT_REGULAR)
      .fontSize(9)
      .fillColor(TEXT)
      .text("For and on behalf of");

    doc
      .font(FONT_BOLD)
      .fontSize(10)
      .text("PLUMTRIPS");

    doc
      .font(FONT_REGULAR)
      .text("(Peachmint Trips & Planners Pvt. Ltd.)");

    doc.moveDown();

    doc.text("Authorized Signatory");
    doc.text("Name:");
    doc.text("Designation:");

    doc.image(STAMP_PATH, 420, doc.y - 80, {
      width: 100,
      opacity: 0.25,
    });

    /* ───────── FOOTER ───────── */

    doc.moveDown(4);
    doc
      .font(FONT_REGULAR)
      .fontSize(7)
      .fillColor(MUTED)
      .text(
        "This is a system-generated document issued via Plumtrips HRMS. No physical signature is required.\n© Plumtrips | Peachmint Trips & Planners Pvt. Ltd.",
        { align: "center" }
      );

    doc.end();
  });
}
