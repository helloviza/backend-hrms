// apps/backend/src/scripts/diag-visa-passport-failures.ts
//
// Read-only diagnostic — lists every VisaDocument with docCode DOC-01
// (passport) and extractionStatus FAILED, showing the stored "error"
// extractedFields entry (services/visaPassportExtraction.ts's markFailed).
// No writes. No traveller PII printed (name/passport number live on
// TravellerProfile, not this document).
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaDocument from "../models/VisaDocument.js";

async function main() {
  console.log("Connecting to MongoDB...");
  try {
    await mongoose.connect(env.MONGO_URI);

    const docs = await VisaDocument.find({ docCode: "DOC-01", extractionStatus: "FAILED" })
      .select("applicationId extractionStatus extractionConfidence extractedFields version createdAt updatedAt")
      .sort({ updatedAt: -1 })
      .lean();

    if (!docs.length) {
      console.log("No FAILED passport extractions found.");
      return;
    }

    console.log(`\n${docs.length} FAILED passport extraction(s):\n`);
    for (const d of docs as any[]) {
      const errorEntry = (d.extractedFields || []).find((f: any) => f.key === "error");
      console.log("----------------------------------------");
      console.log("documentId:      ", String(d._id));
      console.log("applicationId:   ", String(d.applicationId));
      console.log("version:         ", d.version);
      console.log("createdAt:       ", d.createdAt);
      console.log("updatedAt:       ", d.updatedAt);
      console.log("stored error:    ", errorEntry ? errorEntry.value : "(none stored)");
    }
    console.log("----------------------------------------\n");
  } catch (e) {
    console.error("Error:", e);
  } finally {
    await mongoose.connection.close();
  }
}

main();
