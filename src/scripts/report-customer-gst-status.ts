// apps/backend/src/scripts/report-customer-gst-status.ts
//
// READ-ONLY. Three lists, so staff can tidy GST data in Business Master:
//   (a) companies whose GSTIN differs between the places it is kept —
//       Customer.gstNumber (invoices), CustomerWorkspace.gstNumber (SBT → TBO),
//       the onboarding form, and the onboarding snapshot (client portal).
//       CONFLICT = two different GSTINs; PARTIAL = some places blank.
//   (b) companies whose GST status is NOT_SET (or not set at all) — name,
//       created date, booking and invoice counts — to mark REGISTERED or
//       UNREGISTERED.
//   (c) REGISTERED companies whose GSTIN fails validation (format, check
//       digit, PAN match) — their next Business Master save will ask for a fix.
// Prints to the console and writes one CSV locally. Nothing in the database is
// written. Run it after migrate-customer-gst-status.ts.
//
//   npx tsx src/scripts/report-customer-gst-status.ts --expect-db=<db> [--out=<file.csv>]
import "dotenv/config";
import fs from "node:fs";
import mongoose from "mongoose";
import { normalizeGstStatus, validateRegisteredGstin } from "../utils/customerGst.js";

const norm = (v: unknown) => String(v ?? "").trim().toUpperCase();
const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function countBy(coll: string, field: string): Promise<Map<string, number>> {
  const rows = await mongoose.connection
    .collection(coll)
    .aggregate([{ $match: { [field]: { $ne: null } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }])
    .toArray();
  return new Map(rows.map((r: any) => [String(r._id), r.n]));
}

async function main() {
  const args = process.argv.slice(2);
  const expectDb = args.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const out = args.find((a) => a.startsWith("--out="))?.slice(6) || `customer-gst-status-${new Date().toISOString().slice(0, 10)}.csv`;
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  // Read-only: no index builds either.
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);

  const c = mongoose.connection;
  const customers = await c.collection("customers").find({}, {
    projection: { name: 1, legalName: 1, gstNumber: 1, gstin: 1, panNumber: 1, gstStatus: 1, createdAt: 1, onboardingId: 1, onboardingSnapshot: 1, customerType: 1 },
  }).toArray();
  const workspaces = await c.collection("customerworkspaces").find({}, { projection: { customerId: 1, gstNumber: 1 } }).toArray();
  const wsByCustomer = new Map(workspaces.map((w: any) => [String(w.customerId), w]));
  const onboardingIds = customers.map((x: any) => x.onboardingId).filter(Boolean);
  const onboardings = await c.collection("onboardings").find({ _id: { $in: onboardingIds } }, { projection: { formPayload: 1 } }).toArray();
  const obById = new Map(onboardings.map((o: any) => [String(o._id), o]));

  // ManualBooking.workspaceId = Customer._id; SBT bookings = CustomerWorkspace._id;
  // invoices = CustomerWorkspace._id (legacy rows: Customer._id).
  const [manual, sbtFlight, sbtHotel, invoices] = await Promise.all([
    countBy("manualbookings", "workspaceId"),
    countBy("sbtbookings", "workspaceId"),
    countBy("sbthotelbookings", "workspaceId"),
    countBy("invoices", "workspaceId"),
  ]);

  type Row = { list: string; detail: string; name: string; id: string; created: string; status: string; customerGstin: string; workspaceGstin: string; formGstin: string; snapshotGstin: string; manual: number; sbt: number; invoices: number };
  const rows: Row[] = [];

  for (const x of customers as any[]) {
    const id = String(x._id);
    const ws: any = wsByCustomer.get(id);
    const wsId = ws ? String(ws._id) : "";
    const fp = (obById.get(String(x.onboardingId || "")) as any)?.formPayload || {};
    const stores = {
      customerGstin: norm(x.gstNumber || x.gstin),
      workspaceGstin: norm(ws?.gstNumber),
      formGstin: x.onboardingId ? norm(fp.gstNumber || fp.gstin) : "",
      snapshotGstin: norm(x.onboardingSnapshot?.gstNumber || x.onboardingSnapshot?.gstin),
    };
    const base = {
      name: x.legalName || x.name || "(no name)",
      id,
      created: x.createdAt ? new Date(x.createdAt).toISOString().slice(0, 10) : "",
      status: normalizeGstStatus(x.gstStatus),
      ...stores,
      manual: manual.get(id) || 0,
      sbt: (sbtFlight.get(wsId) || 0) + (sbtHotel.get(wsId) || 0),
      invoices: (invoices.get(wsId) || 0) + (invoices.get(id) || 0),
    };

    // (a) disagreement — only stores that exist for this company are compared
    // (no workspace / no onboarding record = nothing to disagree with).
    const present = [stores.customerGstin, ws ? stores.workspaceGstin : null, x.onboardingId ? stores.formGstin : null, x.onboardingSnapshot ? stores.snapshotGstin : null]
      .filter((v) => v !== null) as string[];
    const distinct = new Set(present.filter(Boolean));
    if (distinct.size > 1) rows.push({ list: "a", detail: "CONFLICT", ...base });
    else if (distinct.size === 1 && present.some((v) => !v)) rows.push({ list: "a", detail: "PARTIAL", ...base });

    // (b) NOT_SET
    if (base.status === "NOT_SET") rows.push({ list: "b", detail: x.gstStatus ? "NOT_SET" : "no status yet", ...base });

    // (c) REGISTERED with an invalid GSTIN
    if (base.status === "REGISTERED") {
      const err = validateRegisteredGstin(stores.customerGstin, x.panNumber);
      if (err) rows.push({ list: "c", detail: err, ...base });
    }
  }

  const titles: Record<string, string> = {
    a: "(a) GSTIN differs between stores (Customer · Workspace · Onboarding form · Snapshot)",
    b: "(b) GST status NOT_SET — mark REGISTERED or UNREGISTERED in Business Master",
    c: "(c) REGISTERED but the GSTIN fails validation",
  };
  console.log(`db ${db} · companies ${customers.length}\n`);
  for (const list of ["a", "b", "c"]) {
    const part = rows.filter((r) => r.list === list).sort((p, q) => (p.detail < q.detail ? -1 : p.detail > q.detail ? 1 : q.manual + q.invoices - (p.manual + p.invoices)));
    console.log(`── ${titles[list]}: ${part.length}`);
    for (const r of part) {
      console.log([
        `  ${r.detail}`,
        r.name.padEnd(40).slice(0, 40),
        `created ${r.created || "?"}`,
        list === "a" ? `Customer ${r.customerGstin || "-"} · Workspace ${r.workspaceGstin || "-"} · Form ${r.formGstin || "-"} · Snapshot ${r.snapshotGstin || "-"}` : `GSTIN ${r.customerGstin || "-"}`,
        `bookings: manual ${r.manual} · SBT ${r.sbt} · invoices ${r.invoices}`,
        r.id,
      ].join(" · "));
    }
    console.log("");
  }

  const header = ["List", "Detail", "Company", "Customer id", "Created", "GST status", "Customer GSTIN", "Workspace GSTIN", "Onboarding form GSTIN", "Snapshot GSTIN", "Manual bookings", "SBT bookings", "Invoices"];
  const lines = [header.join(",")].concat(
    rows.map((r) => [r.list, r.detail, r.name, r.id, r.created, r.status, r.customerGstin, r.workspaceGstin, r.formGstin, r.snapshotGstin, r.manual, r.sbt, r.invoices].map(csvCell).join(",")),
  );
  fs.writeFileSync(out, "﻿" + lines.join("\n"));
  console.log(`CSV: ${out}`);
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
