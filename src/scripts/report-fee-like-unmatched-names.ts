// apps/backend/src/scripts/report-fee-like-unmatched-names.ts
//
// 2026-08-03 — "Non-Refundable Visa fee" and "Non-Refundable VFS Service fee"
// (South Africa) appear 4x each among the live unmatchedDocumentNames flagged
// by migrations/2026-08-03-recover-unmatched-documents.ts and
// migrations/2026-08-03-recover-dropped-requirement-groups.ts. They aren't
// documents an applicant submits — the source PDF's own checklist row was a
// FEE AMOUNT/PAYMENT INSTRUCTION ("of USD 36...", "USD 80 to be charged in
// UGX, collected based on daily forex rate") that the extractor read as if
// it were a document line, the same way every other checklist row is. There
// is no VisaDocumentType for "pay this fee" and there never should be one —
// fees belong to the fee master (routes/admin.visa.rules.ts), not the
// document catalogue.
//
// Report-only. Never writes anything, never clears needsCatalogueMapping —
// deciding whether a specific flagged row is genuinely a fee line (dismiss
// it) or a real, oddly-worded document (map it) is an ops call each pass
// makes reviewing this report, not something this script should guess at
// per task brief's own "never invent" posture. Cross-references the frozen
// extraction JSON for sourceDescription (currently NOT stored on the live
// VisaRule at all — audit finding F4) so a name whose amount/context lives
// in that field, not the name itself (e.g. "Non-Refundable Visa fee" /
// "of USD 36..."), still gets caught and shown with its full context.
//
// Usage (run from apps/backend):
//   pnpm exec tsx src/scripts/report-fee-like-unmatched-names.ts
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRule from "../models/VisaRule.js";
import type { ExtractedVisaChecklistFile } from "./extract-visa-checklists.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EXTRACTED_DIR = path.join(REPO_ROOT, "docs", "data", "visa-checklists", "extracted");

// Deliberately broad (over-report, never under-report — this is a report
// for a human to triage, not an auto-dismiss) — matches on:
//   - "non-refundable" (every confirmed fee line found so far has this)
//   - the standalone word "fee" (word-boundaried, so "coffee" never matches)
//   - a currency code/symbol immediately followed by digits (an amount)
//   - phrases describing HOW a payment is handled, not what to submit
export const FEE_OR_PAYMENT_PATTERN =
  /(non[- ]?refundable|\bfees?\b|\b(usd|inr|gbp|eur|aed|sar|rs\.?)\s?\d|[₹$]\s?\d|forex rate|exchange rate|to be charged|collected based on|payment receipt|proof of payment)/i;

export interface FeeLikeMatch {
  name: string; // the sourceName as it appears in unmatchedDocumentNames
  matchedOn: string; // which part of the pattern actually matched, for a quick "why did this get flagged" read
  occurrences: number; // how many live documentGroups currently carry this exact name
  sourceDescriptions: string[]; // distinct sourceDescription text found in the extraction JSON for this name, if any
  sourceFiles: string[]; // which extraction files this name was seen in
}

function findMatchReason(name: string, description: string | null): string | null {
  const combined = `${name} ${description ?? ""}`;
  const m = combined.match(FEE_OR_PAYMENT_PATTERN);
  return m ? m[0] : null;
}

function loadExtractedFiles(): ExtractedVisaChecklistFile[] {
  return readdirSync(EXTRACTED_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(EXTRACTED_DIR, f), "utf8")));
}

/**
 * Pure — no DB access. Builds a name -> {sourceDescriptions, sourceFiles}
 * lookup from the extraction JSON alone, for context only (the JSON is not
 * itself the source of truth for what's CURRENTLY flagged — the live DB is).
 */
function buildExtractionContext(files: ExtractedVisaChecklistFile[]): Map<string, { descriptions: Set<string>; sourceFiles: Set<string> }> {
  const context = new Map<string, { descriptions: Set<string>; sourceFiles: Set<string> }>();
  for (const file of files) {
    for (const checklist of file.checklists) {
      for (const group of checklist.requirementGroups) {
        for (const doc of group.documents) {
          const entry = context.get(doc.sourceName) || { descriptions: new Set<string>(), sourceFiles: new Set<string>() };
          if (doc.sourceDescription) entry.descriptions.add(doc.sourceDescription);
          entry.sourceFiles.add(file.sourceFile);
          context.set(doc.sourceName, entry);
        }
      }
    }
  }
  return context;
}

export function findFeeLikeUnmatchedNames(
  liveNameCounts: Map<string, number>,
  extractionContext: Map<string, { descriptions: Set<string>; sourceFiles: Set<string> }>,
): FeeLikeMatch[] {
  const matches: FeeLikeMatch[] = [];
  for (const [name, occurrences] of liveNameCounts) {
    const context = extractionContext.get(name);
    const descriptions = [...(context?.descriptions ?? [])];
    const reason = findMatchReason(name, null) ?? descriptions.map((d) => findMatchReason(name, d)).find(Boolean);
    if (!reason) continue;

    matches.push({
      name,
      matchedOn: reason,
      occurrences,
      sourceDescriptions: descriptions,
      sourceFiles: [...(context?.sourceFiles ?? [])],
    });
  }
  return matches.sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name));
}

async function main() {
  const files = loadExtractedFiles();
  const extractionContext = buildExtractionContext(files);

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    const rules = await VisaRule.find({}).lean();
    const liveNameCounts = new Map<string, number>();
    for (const rule of rules as any[]) {
      for (const g of rule.documentGroups || []) {
        for (const n of g.unmatchedDocumentNames || []) {
          liveNameCounts.set(n, (liveNameCounts.get(n) || 0) + 1);
        }
      }
    }

    const matches = findFeeLikeUnmatchedNames(liveNameCounts, extractionContext);

    console.log(`Distinct unmatchedDocumentNames currently live: ${liveNameCounts.size}`);
    console.log(`Looking like a fee or payment instruction rather than a document: ${matches.length}`);
    console.log("(report only — nothing dismissed, no catalogue types created)\n");
    for (const m of matches) {
      console.log(`"${m.name}" — ${m.occurrences} occurrence(s), matched on "${m.matchedOn}"`);
      if (m.sourceDescriptions.length) {
        for (const d of m.sourceDescriptions) console.log(`    context: "${d}"`);
      }
      console.log(`    seen in: ${m.sourceFiles.join(", ")}`);
    }
  } finally {
    await mongoose.connection.close();
  }
}

const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Report fee-like unmatched names failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
