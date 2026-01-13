import { writeFileSync } from "fs";
import { generateOnboardingAgreementPdf } from "../utils/onboardingAgreementPdf.js";

async function run() {
  const pdfBuffer = await generateOnboardingAgreementPdf({
    referenceId: "PT-ONB-EMP-20260103-A8F3K",
    effectiveDate: "03 Jan 2026",
    relationshipType: "Employee",

    counterpartyName: "Rahul Sharma",
    counterpartyEmail: "rahul.sharma@example.com",
    counterpartyAddress: "Bengaluru, Karnataka, India",

    companyName: "Plumtrips",
  });

  writeFileSync("onboarding_test.pdf", pdfBuffer);
  console.log("✅ PDF generated: onboarding_test.pdf");
}

run().catch(console.error);
