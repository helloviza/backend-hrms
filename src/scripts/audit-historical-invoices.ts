/**
 * Audit historical invoices to identify ones where the stored GST type
 * may differ from what would be calculated with the current detection logic.
 * Output is a CSV to stdout. Does NOT modify any invoices.
 */

import "../config/db.js";
import Invoice from "../models/Invoice.js";
import Customer from "../models/Customer.js";
import { getCompanySettings } from "../models/CompanySettings.js";
import { detectGSTType } from "../utils/gstDetection.js";

async function run() {
  const companySettings = await getCompanySettings();
  const supplierState = companySettings.supplierState || companySettings.state || "Karnataka";

  const invoices = await Invoice.find({}).lean();
  const customerCache = new Map<string, any>();

  const rows: string[] = [];
  rows.push("invoiceNo,customerName,storedGstType,computedGstType,customerState,supplierState,grandTotal,generatedAt");

  let mismatch = 0;

  for (const inv of invoices as any[]) {
    const wsId = inv.workspaceId?.toString();
    if (!wsId) continue;

    if (!customerCache.has(wsId)) {
      const cust = await Customer.findById(wsId).lean();
      customerCache.set(wsId, cust);
    }

    const cust = customerCache.get(wsId);
    const customerState =
      cust?.gstRegisteredState || cust?.address?.state || "";
    const customerCountry = cust?.address?.country || "India";

    const detection = detectGSTType({ supplierState, customerState, customerCountry });
    const storedType = inv.supplyType || "IGST";
    const computedType = detection.canCalculate ? detection.gstType : "UNKNOWN";

    if (storedType !== computedType) {
      mismatch++;
      const name = inv.clientDetails?.companyName || wsId;
      const date = inv.generatedAt ? new Date(inv.generatedAt).toLocaleDateString("en-IN") : "";
      const grand = inv.grandTotal ?? 0;
      rows.push(`"${inv.invoiceNo}","${name}","${storedType}","${computedType}","${customerState}","${supplierState}",${grand},"${date}"`);
    }
  }

  console.log(rows.join("\n"));
  console.error(`\n=== Audit complete: ${mismatch} potential mismatches out of ${invoices.length} invoices ===`);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
