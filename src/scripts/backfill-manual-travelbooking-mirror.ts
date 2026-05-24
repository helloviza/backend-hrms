// Backfill existing ManualBooking rows into the TravelBooking mirror so they
// surface in the customer Bookings tab (/api/my-bookings), symmetric with the
// new ManualBooking post-save hook.
//
//   DRY RUN (default):  pnpm -C apps/backend tsx src/scripts/backfill-manual-travelbooking-mirror.ts
//   WRITE:              ... backfill-manual-travelbooking-mirror.ts --write
//   SCOPE TO 1 TENANT:  ... --write --tenant 6a1034c597dad02284373ac2
//   EXCLUDE ORPHANS:    ... --exclude-no-workspace   (skip tenants with no CustomerWorkspace)
//
// Dry run performs ZERO writes — only find / countDocuments. The --write path
// backs up affected mirror state to a JSON file, then upserts, then verifies.
//
// COST NEVER ENTERS THE MIRROR: amount = pricing.grandTotal (customer billed
// total), never actualPrice/supplierCost/markupAmount/profitMargin.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";

const WRITE = process.argv.includes("--write");
const EXCLUDE_NO_WS = process.argv.includes("--exclude-no-workspace");
const TENANT_ARG: string | null = (() => {
  const i = process.argv.indexOf("--tenant");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith("--tenant="));
  return eq ? eq.split("=")[1] : null;
})();

function manualTypeToService(t: string): string {
  switch (t) {
    case "FLIGHT":
    case "DUMMY_FLIGHT": return "FLIGHT";
    case "HOTEL":
    case "DUMMY_HOTEL":  return "HOTEL";
    case "VISA":         return "VISA";
    case "CAB":          return "CAB";
    case "TRANSFER":     return "TRANSFER";
    case "FOREX":        return "FOREX";
    case "ESIM":         return "ESIM";
    case "HOLIDAYS":     return "HOLIDAY";
    case "EVENTS":       return "MICE";
    case "TRAIN":        return "TRAIN";
    case "OTHER":        return "OTHER";
    default:             return "OTHER";
  }
}
function manualStatusToTravel(s: string): "CONFIRMED" | "CANCELLED" | "PENDING" | "FAILED" {
  if (s === "INVOICED") return "CONFIRMED";
  if (s === "WIP") return "PENDING";
  if (s === "CONFIRMED") return "CONFIRMED";
  if (s === "CANCELLED") return "CANCELLED";
  return "PENDING";
}
function formatTravellerName(passengers: any): string {
  if (!Array.isArray(passengers) || passengers.length === 0) return "";
  const leadName = String(passengers[0]?.name || "").trim();
  const extra = passengers.length - 1;
  return extra > 0 ? `${leadName} +${extra}` : leadName;
}

function buildMirrorRow(doc: any, workspaceId: any) {
  const type = String(doc.type || "");
  const isHotel = type === "HOTEL" || type === "DUMMY_HOTEL";
  const origin = doc.itinerary?.origin || "";
  // CITY only — never the hotel name (caused Top-Destinations contamination).
  // For hotels the city is in itinerary.destination or `sector`; else empty.
  const destination = doc.itinerary?.destination || (isHotel ? doc.sector : "") || "";
  const amount = doc.pricing?.grandTotal ?? doc.pricing?.totalWithGST ?? doc.pricing?.quotedPrice ?? 0;
  const lead = Array.isArray(doc.passengers) ? doc.passengers[0] : undefined;
  const row: any = {
    tenantId: String(doc.workspaceId),
    service: manualTypeToService(type),
    amount,
    userId: doc.bookedBy,
    status: manualStatusToTravel(String(doc.status || "")),
    paymentMode: "OFFICIAL",
    source: "CONCIERGE",
    reference: doc._id,
    referenceModel: "ManualBooking",
    destination,
    origin,
    travellerName: formatTravellerName(doc.passengers),
    travellerEmail: lead?.email || "",
    bookedAt: doc.bookingDate || doc.createdAt,
    travelDate: doc.travelDate ? new Date(doc.travelDate) : null,
    travelDateEnd: doc.returnDate ? new Date(doc.returnDate) : null,
    metadata: {
      bookingRef: doc.bookingRef,
      manualType: type,
      hotelName: doc.itinerary?.hotelName || "",
      airline: doc.itinerary?.airline || "",
      sector: doc.sector || "",
    },
  };
  if (workspaceId) row.workspaceId = workspaceId;
  return row;
}

// Keys that must NEVER appear in a mirror row (cost / margin).
const FORBIDDEN_COST_KEYS = ["actualPrice", "supplierCost", "markupAmount", "profitMargin", "basePrice", "diff", "gstAmount", "totalWithGST", "grandTotal", "quotedPrice", "sellingPrice"];

async function main() {
  await mongoose.connect(process.env.MONGO_URI!);
  const db = mongoose.connection.db!;
  const MB = db.collection("manualbookings");
  const TB = db.collection("travelbookings");
  const WS = db.collection("customerworkspaces");

  console.log(`\n===== Backfill ManualBooking → TravelBooking mirror  [${WRITE ? "WRITE" : "DRY RUN"}] =====`);
  console.log(`  scope: ${TENANT_ARG ? `tenantId=${TENANT_ARG}` : "ALL tenants"}${EXCLUDE_NO_WS ? "  (excluding no-workspace tenants)" : ""}`);

  const all = await MB.find({}).toArray();
  console.log(`  total manualbookings: ${all.length}`);

  // Partition.
  const eligibleAll: any[] = [];
  let skippedSbt = 0;
  for (const d of all as any[]) {
    if (d.source === "SBT" || d.source === "SBT_AUTO" || d.sourceBookingId) { skippedSbt++; continue; }
    eligibleAll.push(d);
  }
  console.log(`  skipped (SBT-origin: source SBT/SBT_AUTO or sourceBookingId set): ${skippedSbt}`);

  // Apply tenant scope filter (if any).
  const eligible = TENANT_ARG
    ? eligibleAll.filter((d) => String(d.workspaceId) === TENANT_ARG)
    : eligibleAll;
  console.log(`  eligible to mirror${TENANT_ARG ? " (this tenant)" : ""}: ${eligible.length}${TENANT_ARG ? `  (of ${eligibleAll.length} across all tenants)` : ""}`);

  // Resolve workspaceId per tenant (cache).
  const wsCache = new Map<string, any>();
  async function resolveWs(tenantId: string) {
    if (wsCache.has(tenantId)) return wsCache.get(tenantId);
    const ws: any = await WS.findOne({ customerId: tenantId }, { projection: { _id: 1, companyName: 1 } });
    wsCache.set(tenantId, ws || null);
    return ws || null;
  }

  // Per-tenant rollup + already-mirrored detection + cost-safety check.
  const perTenant = new Map<string, { total: number; alreadyMirrored: number; netNew: number; noWorkspace: boolean; company: string; sumAmount: number }>();
  const serviceDist = new Map<string, number>();
  let costLeakRows = 0;
  let amountEqualsCostRows = 0; // flag rows where grandTotal coincidentally == supplierCost (informational)
  let excludedNoWs = 0;
  const toWrite: any[] = []; // every in-scope row (existing → update, new → insert) — upserted by reference

  for (const d of eligible) {
    const tenantId = String(d.workspaceId);
    const ws = await resolveWs(tenantId);
    const row = buildMirrorRow(d, ws?._id);

    // Cost-safety: assert no forbidden cost key is present on the mirror row.
    for (const k of Object.keys(row)) {
      if (FORBIDDEN_COST_KEYS.includes(k)) costLeakRows++;
    }
    for (const k of Object.keys(row.metadata || {})) {
      if (FORBIDDEN_COST_KEYS.includes(k)) costLeakRows++;
    }
    // Confirm amount is the customer total, not supplier cost.
    const supplierCost = d.pricing?.actualPrice ?? d.pricing?.supplierCost ?? null;
    if (supplierCost != null && row.amount === supplierCost && (d.pricing?.grandTotal == null && d.pricing?.totalWithGST == null && d.pricing?.quotedPrice == null)) {
      amountEqualsCostRows++; // only flagged if NO customer-facing price existed (would be a fallback-to-0 case anyway)
    }

    serviceDist.set(row.service, (serviceDist.get(row.service) || 0) + 1);

    const existing = await TB.countDocuments({ reference: d._id });
    const rec = perTenant.get(tenantId) || { total: 0, alreadyMirrored: 0, netNew: 0, noWorkspace: !ws, company: ws?.companyName || "(no workspace)", sumAmount: 0 };
    rec.total++;
    rec.sumAmount += Number(row.amount) || 0;
    if (EXCLUDE_NO_WS && !ws) {
      excludedNoWs++; // orphan tenant — skip per --exclude-no-workspace
    } else {
      // Upsert keyed by reference — existing rows are UPDATED (e.g. corrected
      // traveller), never duplicated; brand-new rows are inserted.
      toWrite.push(row);
      if (existing > 0) rec.alreadyMirrored++; else rec.netNew++;
    }
    perTenant.set(tenantId, rec);
  }

  console.log("\n  ── Per-tenant plan (tenantId = Customer._id) ──");
  console.log("  tenantId                          company                         total  mirrored  net-new  sumAmount(₹)");
  for (const [tid, r] of [...perTenant.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `  ${tid.padEnd(34)}${String(r.company).slice(0, 30).padEnd(32)}${String(r.total).padStart(5)}${String(r.alreadyMirrored).padStart(10)}${String(r.netNew).padStart(9)}  ${r.sumAmount.toLocaleString("en-IN").padStart(14)}${r.noWorkspace ? "   [!] no CustomerWorkspace" : ""}`,
    );
  }

  console.log("\n  ── Service mapping distribution (manual type → mirror service) ──");
  for (const [svc, n] of [...serviceDist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${svc.padEnd(10)} ${n}`);
  }

  console.log("\n  ── Cost-safety ──");
  console.log(`    mirror rows containing a forbidden cost/margin key: ${costLeakRows}  (MUST be 0)`);
  console.log(`    rows where amount fell back with no customer price : ${amountEqualsCostRows}`);
  console.log(`    (amount source = pricing.grandTotal → totalWithGST → quotedPrice → 0; never actualPrice/supplierCost)`);

  const insertTotal = [...perTenant.values()].reduce((s, r) => s + r.netNew, 0);
  const updateTotal = [...perTenant.values()].reduce((s, r) => s + r.alreadyMirrored, 0);
  console.log("\n  ── Totals ──");
  console.log(`    eligible:                 ${eligible.length}`);
  console.log(`    existing (will UPDATE):   ${updateTotal}`);
  if (EXCLUDE_NO_WS) console.log(`    excluded (no workspace):  ${excludedNoWs}`);
  console.log(`    new (will INSERT):        ${insertTotal}`);
  console.log(`    total to upsert:          ${toWrite.length}`);

  if (!WRITE) {
    console.log("\n[DRY RUN — no writes performed. Re-run with --write after approval.]");
    await mongoose.disconnect();
    return;
  }

  // ── WRITE PATH (only with --write) ──
  if (costLeakRows > 0) {
    console.error("\n[ABORT] cost key detected in a mirror row — refusing to write.");
    await mongoose.disconnect();
    process.exit(1);
  }
  // Backup: dump existing mirror rows for affected tenants + the planned writes.
  const affectedTenants = [...perTenant.keys()];
  const existingForTenants = await TB.find({ tenantId: { $in: affectedTenants } }).toArray();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.resolve(process.cwd(), "merge-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `manual-mirror-backfill-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ affectedTenants, existingMirrorRows: existingForTenants, plannedWrites: toWrite }, null, 2));
  console.log(`\n  backup written: ${backupFile} (existing mirror rows for affected tenants: ${existingForTenants.length})`);

  if (toWrite.length === 0) {
    console.log("  nothing to write.");
    await mongoose.disconnect();
    return;
  }
  const beforeCount = await TB.countDocuments({ referenceModel: "ManualBooking" });
  // Idempotent upsert keyed by reference: existing rows are updated in place, new ones inserted.
  const ops = toWrite.map((r) => ({
    updateOne: { filter: { reference: r.reference }, update: { $set: r }, upsert: true },
  }));
  const result: any = await TB.bulkWrite(ops, { ordered: false });
  const afterCount = await TB.countDocuments({ referenceModel: "ManualBooking" });
  console.log(`\n  matched=${result.matchedCount}  modified=${result.modifiedCount}  upserted(new)=${result.upsertedCount}`);
  console.log(`  TravelBooking(referenceModel=ManualBooking)  before=${beforeCount}  after=${afterCount}  delta=${afterCount - beforeCount}`);

  await mongoose.disconnect();
  console.log("\n[WRITE complete]");
}
main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
