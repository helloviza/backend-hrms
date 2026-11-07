// apps/backend/src/scripts/migrate-gst-registrations.ts
//
// P2 — create each client company's GST registration from the GSTIN copies it
// has today (docs/audits/client-multi-gst-audit.md §9.3, step 1 only; the
// booking backfill ships with P3 / R3).
//
// DRY RUN BY DEFAULT: classifies every Customer, writes one CSV row each and a
// summary, and writes nothing to the database. --apply creates registrations
// for the CREATE_DEFAULT rows only, through services/gstRegistrations.ts (same
// validation, mirrors and audit as a staff edit). Idempotent: a company that
// already has registrations is ALREADY and is never touched.
//
//   MONGO_URI=... npx tsx src/scripts/migrate-gst-registrations.ts --expect-db=<db>
//       [--apply] [--out=<file.csv>] [--counts=<counts.csv>] [--hold=<customerId,customerId,...>]
//
// --hold: companies that would be CREATE_DEFAULT but must not be migrated yet
// (e.g. their past invoices were billed with a different place of supply than
// the GSTIN's state). They are reported as HELD and never written. Every id
// must be a Customer in this database, or the run refuses (a typo must not
// silently migrate the company it meant to hold).
//
// --counts: a CSV of customerId,invoices,manualBookings,sbtBookings (from
// report-gst-migration-counts.ts, read-only on prod) joined into the output.
//
// Candidates per company (normalised, deduplicated):
//   Customer.gstNumber (|| legacy gstin), CustomerWorkspace.gstNumber,
//   Onboarding.formPayload.gstNumber/gstin, Customer.onboardingSnapshot.gstNumber/gstin
//
// Actions:
//   ALREADY                 has registrations — skipped
//   CREATE_DEFAULT          one valid GSTIN → default registration      (applied)
//   NO_GSTIN                no candidate — nothing to do
//   UNREGISTERED_WITH_GSTIN company is Unregistered but a copy holds a GSTIN — reconcile
//   CONFLICT                two or more different GSTINs — reconcile
//   BAD_GSTIN               format / check digit — reconcile
//   STATE_CODE_UNKNOWN      prefix is not a current GST state — reconcile
//   PAN_MISMATCH            company PAN ≠ GSTIN PAN — reconcile
//   TAX_STATE_DIFFERS       the company's effective invoice state ≠ the GSTIN's state —
//                           reconcile (applying would silently change its tax type)
//   CROSS_COMPANY_DUP       the same GSTIN is a candidate on another company — P5 merge
//   HELD                    would be CREATE_DEFAULT, but named in --hold — not applied
// Plus a WORKSPACE_ONLY row per CustomerWorkspace GSTIN with no Customer (SaaS signup).
import "dotenv/config";
import fs from "node:fs";
import mongoose from "mongoose";
import { normalizeGstStatus, validateRegisteredGstin } from "../utils/customerGst.js";
import { normalizeGstin, panFromGstin, stateFromGstin } from "../utils/gstinState.js";
import { resolveCustomerState } from "../utils/invoiceClient.js";

type Row = Record<string, string | number>;

const COLUMNS = [
  "action", "customerId", "name", "gstStatus", "candidates", "sources", "chosenGstin", "gstinState",
  "effectiveStateBefore", "panBefore", "panAfter", "gstStatusAfter", "customerGstNumberBefore",
  "customerGstRegisteredStateBefore", "workspaceGstNumberBefore", "otherCompanies", "notes",
  "invoices", "manualBookings", "sbtBookings",
] as const;

const RECONCILE = new Set([
  "UNREGISTERED_WITH_GSTIN", "CONFLICT", "BAD_GSTIN", "STATE_CODE_UNKNOWN", "PAN_MISMATCH", "TAX_STATE_DIFFERS", "CROSS_COMPANY_DUP", "HELD",
]);

/** Parse --hold=<ids>: comma/space separated, deduplicated, each a 24-hex ObjectId. */
export function parseHoldIds(raw: string | undefined): Set<string> {
  const ids = String(raw ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const bad = ids.filter((s) => !/^[0-9a-f]{24}$/i.test(s));
  if (bad.length) throw new Error(`REFUSING: --hold has ids that are not ObjectIds: ${bad.join(", ")}`);
  return new Set(ids.map((s) => s.toLowerCase()));
}

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const sameState = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function readCounts(file?: string): Map<string, { invoices: number; manualBookings: number; sbtBookings: number }> {
  const out = new Map();
  if (!file) return out;
  const [head, ...lines] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const cols = head.split(",");
  for (const line of lines) {
    const v = line.split(",");
    const rec: any = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    out.set(rec.customerId, { invoices: +rec.invoices || 0, manualBookings: +rec.manualBookings || 0, sbtBookings: +rec.sbtBookings || 0 });
  }
  return out;
}

export function classify(
  c: any,
  ws: any | null,
  formPayload: any | null,
): { action: string; gstin: string; candidates: string[]; sources: string[]; notes: string[]; gstinState: string; effectiveBefore: string } {
  const found: Array<[string, string]> = [];
  const add = (src: string, v: unknown) => {
    const g = normalizeGstin(v);
    if (g) found.push([src, g]);
  };
  add("customer", c.gstNumber || c.gstin);
  add("workspace", ws?.gstNumber);
  add("onboardingForm", formPayload?.gstNumber || formPayload?.gstin);
  add("onboardingSnapshot", c.onboardingSnapshot?.gstNumber || c.onboardingSnapshot?.gstin);
  const candidates = [...new Set(found.map(([, g]) => g))];
  const sources = found.map(([s, g]) => `${s}:${g}`);
  const notes: string[] = [];
  const eff = resolveCustomerState(c).state || ws?.address?.state || "";
  const base = { candidates, sources, notes, gstin: "", gstinState: "", effectiveBefore: eff };

  if (c.gstRegistrations?.length) return { ...base, action: "ALREADY" };
  if (!candidates.length) return { ...base, action: "NO_GSTIN" };
  if (normalizeGstStatus(c.gstStatus) === "UNREGISTERED") return { ...base, action: "UNREGISTERED_WITH_GSTIN" };
  if (candidates.length > 1) return { ...base, action: "CONFLICT" };

  const gstin = candidates[0];
  const st = stateFromGstin(gstin);
  const formatErr = validateRegisteredGstin(gstin); // format + check digit (PAN below)
  if (formatErr) return { ...base, gstin, action: "BAD_GSTIN", notes: [formatErr] };
  if (!st) return { ...base, gstin, action: "STATE_CODE_UNKNOWN" };
  const pan = String(c.panNumber || "").trim().toUpperCase();
  if (pan && pan !== panFromGstin(gstin)) return { ...base, gstin, gstinState: st.state, action: "PAN_MISMATCH" };
  if (eff && !sameState(eff, st.state)) return { ...base, gstin, gstinState: st.state, action: "TAX_STATE_DIFFERS" };
  if (!pan) notes.push("PAN_DERIVED");
  if (!eff) notes.push("STATE_FILLED");
  if (normalizeGstStatus(c.gstStatus) !== "REGISTERED") notes.push("STATUS_SET_REGISTERED");
  if (found.length < 4) notes.push("PARTIAL_COPIES");
  return { ...base, gstin, gstinState: st.state, action: "CREATE_DEFAULT", notes };
}

export type MigrationResult = { rows: Row[]; applied: number; applyErrors: number; companies: number; workspaces: number };

/** Classify (and with apply, migrate) every company on the current connection. */
export async function runMigration(opts: {
  apply: boolean;
  hold?: Set<string>;
  counts?: Map<string, { invoices: number; manualBookings: number; sbtBookings: number }>;
}): Promise<MigrationResult> {
  const { apply } = opts;
  const hold = opts.hold ?? new Set<string>();
  const counts = opts.counts ?? new Map();
  const conn = mongoose.connection;
  const customers = await conn.collection("customers").find({}, {
    projection: {
      name: 1, legalName: 1, gstNumber: 1, gstin: 1, panNumber: 1, gstStatus: 1, gstRegisteredState: 1,
      address: 1, shippingAddress: 1, onboardingId: 1, onboardingSnapshot: 1, gstRegistrations: 1,
    },
  }).toArray();
  const workspaces = await conn.collection("customerworkspaces").find({}, { projection: { customerId: 1, gstNumber: 1, address: 1, companyName: 1 } }).toArray();
  const onboardings = await conn.collection("onboardings").find({ type: { $in: ["business", "customer"] } }, { projection: { formPayload: 1 } }).toArray();
  const wsByCustomer = new Map(workspaces.map((w: any) => [String(w.customerId), w]));
  const obById = new Map(onboardings.map((o: any) => [String(o._id), o.formPayload || {}]));
  const customerIds = new Set(customers.map((c: any) => String(c._id)));
  const unknownHolds = [...hold].filter((id) => !customerIds.has(id));
  if (unknownHolds.length) throw new Error(`REFUSING: --hold names companies that are not in this database: ${unknownHolds.join(", ")}`);

  const rows: Row[] = [];
  const results = customers.map((c: any) => {
    const ws = wsByCustomer.get(String(c._id)) || null;
    const fp = c.onboardingId ? obById.get(String(c.onboardingId)) || null : null;
    return { c, ws, r: classify(c, ws, fp) };
  });

  // Same GSTIN as a candidate on more than one company → P5, not here.
  const byGstin = new Map<string, string[]>();
  for (const { c, r } of results) for (const g of r.candidates) byGstin.set(g, [...(byGstin.get(g) || []), String(c._id)]);
  for (const x of results) {
    if (x.r.action !== "CREATE_DEFAULT") continue;
    const others = (byGstin.get(x.r.gstin) || []).filter((id) => id !== String(x.c._id));
    if (others.length) x.r.action = "CROSS_COMPANY_DUP";
  }
  // Held by decision: reported, never written. A held id whose row is not
  // CREATE_DEFAULT keeps its own action (it would not be applied anyway).
  for (const x of results) {
    if (!hold.has(String(x.c._id))) continue;
    if (x.r.action === "CREATE_DEFAULT") x.r.action = "HELD";
    else x.r.notes.push("HOLD_REQUESTED");
  }

  let applied = 0;
  let applyErrors = 0;
  const svc = apply ? await import("../services/gstRegistrations.js") : null;
  for (const { c, ws, r } of results) {
    const id = String(c._id);
    const k = counts.get(id);
    const others = (byGstin.get(r.gstin) || []).filter((x) => x !== id);
    const create = r.action === "CREATE_DEFAULT";
    const notes = [...r.notes];
    if (apply && create && svc) {
      try {
        await svc.addRegistration(id, { gstin: r.gstin, makeDefault: true }, { source: "migrate-gst-registrations", actorId: "script" }, "MIGRATED");
        applied++;
        notes.push("APPLIED");
      } catch (e: any) {
        applyErrors++;
        notes.push(`APPLY_FAILED:${e?.code || e?.message}`);
      }
    }
    rows.push({
      action: r.action,
      customerId: id,
      name: c.legalName || c.name || "",
      gstStatus: normalizeGstStatus(c.gstStatus),
      candidates: r.candidates.join(" "),
      sources: r.sources.join(" "),
      chosenGstin: create || r.action === "HELD" ? r.gstin : "",
      gstinState: r.gstinState,
      effectiveStateBefore: r.effectiveBefore,
      panBefore: c.panNumber || "",
      panAfter: create ? c.panNumber || panFromGstin(r.gstin) : c.panNumber || "",
      gstStatusAfter: create ? "REGISTERED" : normalizeGstStatus(c.gstStatus),
      customerGstNumberBefore: c.gstNumber || c.gstin || "",
      customerGstRegisteredStateBefore: c.gstRegisteredState || "",
      workspaceGstNumberBefore: ws?.gstNumber || "",
      otherCompanies: others.join(" "),
      notes: notes.join(" "),
      invoices: k?.invoices ?? "",
      manualBookings: k?.manualBookings ?? "",
      sbtBookings: k?.sbtBookings ?? "",
    });
  }
  for (const w of workspaces as any[]) {
    if (customerIds.has(String(w.customerId)) || !normalizeGstin(w.gstNumber)) continue;
    rows.push({ action: "WORKSPACE_ONLY", customerId: "", name: w.companyName || "", workspaceGstNumberBefore: w.gstNumber, notes: `workspace ${w._id} (no Customer)` });
  }
  return { rows, applied, applyErrors, companies: customers.length, workspaces: workspaces.length };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const expectDb = arg("expect-db");
  const apply = args.includes("--apply");
  const out = arg("out") || `gst-registrations-${apply ? "apply" : "dryrun"}-${new Date().toISOString().slice(0, 10)}.csv`;
  const counts = readCounts(arg("counts"));
  const hold = parseHoldIds(arg("hold"));
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);
  console.log(`[gst-registrations] db=${db} mode=${apply ? "APPLY" : "dry run (no writes)"}${hold.size ? ` hold=${hold.size}` : ""}`);

  const { rows, applied, applyErrors, companies, workspaces } = await runMigration({ apply, hold, counts });
  const tally = new Map<string, number>();
  for (const r of rows) tally.set(String(r.action), (tally.get(String(r.action)) || 0) + 1);
  fs.writeFileSync(out, [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(","))].join("\n"));
  console.log(`\nCompanies: ${companies}   Workspaces: ${workspaces}`);
  for (const [a, n] of [...tally.entries()].sort()) console.log(`  ${a.padEnd(24)} ${n}${RECONCILE.has(a) ? "   ← reconcile" : ""}`);
  const notesTally = new Map<string, number>();
  for (const r of rows) if (r.action === "CREATE_DEFAULT") for (const n of String(r.notes).split(" ").filter(Boolean)) notesTally.set(n.split(":")[0], (notesTally.get(n.split(":")[0]) || 0) + 1);
  if (notesTally.size) console.log(`  CREATE_DEFAULT notes: ${[...notesTally.entries()].map(([n, v]) => `${n} ${v}`).join(" · ")}`);
  if (apply) console.log(`\nApplied ${applied}, failed ${applyErrors}.`);
  console.log(`CSV: ${out}`);
  await mongoose.disconnect();
}

const isMain = process.argv[1] && /migrate-gst-registrations\.ts$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  main().catch(async (e) => {
    console.error(e);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
