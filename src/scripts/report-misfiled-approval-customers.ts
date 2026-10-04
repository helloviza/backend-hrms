// apps/backend/src/scripts/report-misfiled-approval-customers.ts
//
// ══════════════════════════════════════════════════════════════════════
// READ-ONLY report: approval requests whose customerId does not match their
// own workspace's customer — requests misfiled before the tenant fix
// (8c73b158: submit used to take customerId from the request body, so a
// request could name another company and pick up its approver, leaders and
// name while staying in the submitter's workspace).
//
// For every ApprovalRequest:
//   workspace   CustomerWorkspace by the request's workspaceId (the tenant the
//               request lives in — every list and guard scopes by it)
//   expected    that workspace's customerId, or its _id when it has none
//               (exactly what submit stores today)
//   MISFILED    request.customerId is neither the workspace's customerId nor
//               its _id
//   NO WORKSPACE  workspaceId missing or pointing at no workspace
// Each misfiled row says which company its customerId actually belongs to
// (the workspace whose customerId or _id it is) — the approver/leaders it
// was routed to came from there.
//
// --expect-db=<name> is REQUIRED and must equal the database the URI
// connects to, or the script refuses before reading a row. It never writes.
//
// USAGE
//   npx tsx --env-file=.env src/scripts/report-misfiled-approval-customers.ts --expect-db=plumbox_dev
//
// Emails are printed masked: "***@domain".
// ══════════════════════════════════════════════════════════════════════

import "dotenv/config";
import mongoose from "mongoose";
import ApprovalRequest from "../models/ApprovalRequest.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

export type Options = {
  expectDb: string | undefined;
  log?: (line: string) => void;
};

export type MisfiledRow = {
  id: string;
  code: string;
  createdAt: string;
  status: string;
  stage: string;
  workspaceId: string;
  workspaceName: string;
  expectedCustomerId: string;
  requestCustomerId: string;
  requestCustomerName: string;
  /** The company the stored customerId belongs to, if any workspace has it. */
  belongsTo: string;
  requester: string;
  approver: string;
};

export type Report = {
  db: string;
  scanned: number;
  misfiled: MisfiledRow[];
  noWorkspace: MisfiledRow[];
};

const str = (v: any) => String(v ?? "").trim();

export function maskEmail(email: string): string {
  const e = String(email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  return at >= 0 ? `***@${e.slice(at + 1)}` : e ? "***" : "—";
}

const wsName = (w: any) => str(w?.companyName) || str(w?.name) || str(w?.displayName) || `(unnamed ${w?._id})`;

export async function reportMisfiledApprovalCustomers(opts: Options): Promise<Report> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const db = mongoose.connection.name;

  if (!opts.expectDb) {
    throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  }
  if (opts.expectDb !== db) {
    throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  }

  log(`[misfiled-report] db=${db}  READ-ONLY`);

  const workspaces: any[] = await CustomerWorkspace.find({}).select("_id customerId companyName name displayName").lean();
  const byId = new Map(workspaces.map((w) => [String(w._id), w]));
  // Which workspace a stored customerId points at: by customerId first, then by _id.
  const byCustomerId = new Map<string, any>();
  for (const w of workspaces) if (str(w.customerId)) byCustomerId.set(str(w.customerId), w);

  const requests: any[] = await ApprovalRequest.find({})
    .select("_id ticketId createdAt status stage workspaceId customerId customerName frontlinerEmail managerEmail")
    .sort({ createdAt: 1 })
    .lean();

  const misfiled: MisfiledRow[] = [];
  const noWorkspace: MisfiledRow[] = [];
  for (const r of requests) {
    const ws = r.workspaceId ? byId.get(String(r.workspaceId)) : null;
    const stored = str(r.customerId);
    const owner = byCustomerId.get(stored) || byId.get(stored) || null;
    const row: MisfiledRow = {
      id: String(r._id),
      code: str(r.ticketId) || `REQ-${String(r._id).slice(-6).toUpperCase()}`,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : "—",
      status: str(r.status) || "—",
      stage: str(r.stage) || "—",
      workspaceId: r.workspaceId ? String(r.workspaceId) : "—",
      workspaceName: ws ? wsName(ws) : "—",
      expectedCustomerId: ws ? str(ws.customerId) || String(ws._id) : "—",
      requestCustomerId: stored || "—",
      requestCustomerName: str(r.customerName) || "—",
      belongsTo: owner ? wsName(owner) : "(no workspace has it)",
      requester: maskEmail(r.frontlinerEmail),
      approver: maskEmail(r.managerEmail),
    };
    if (!ws) {
      noWorkspace.push(row);
      continue;
    }
    if (stored !== str(ws.customerId) && stored !== String(ws._id)) misfiled.push(row);
  }

  log(`[misfiled-report] ${requests.length} requests scanned; misfiled ${misfiled.length}; no workspace ${noWorkspace.length}`);
  log("");
  log(`a. MISFILED — customerId is not the request's own workspace's customer (${misfiled.length})`);
  log("  id | code | created | status/stage | lives in (workspace) | expected customerId | stored customerId → belongs to | stored name | requester | approver");
  for (const m of misfiled) {
    log(
      `  ${m.id} | ${m.code} | ${m.createdAt} | ${m.status}/${m.stage} | ${m.workspaceName} | ${m.expectedCustomerId} | ` +
        `${m.requestCustomerId} → ${m.belongsTo} | ${m.requestCustomerName} | ${m.requester} | ${m.approver}`,
    );
  }
  log("");
  log(`b. NO WORKSPACE — workspaceId missing or unknown (${noWorkspace.length})`);
  log("  id | code | created | status/stage | workspaceId | stored customerId → belongs to | requester");
  for (const m of noWorkspace) {
    log(`  ${m.id} | ${m.code} | ${m.createdAt} | ${m.status}/${m.stage} | ${m.workspaceId} | ${m.requestCustomerId} → ${m.belongsTo} | ${m.requester}`);
  }
  log("");
  log("[misfiled-report] read-only — nothing written.");
  return { db, scanned: requests.length, misfiled, noWorkspace };
}

function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  try {
    await reportMisfiledApprovalCustomers({ expectDb: argValue("expect-db") });
  } finally {
    await mongoose.connection.close();
  }
}

// Run only when executed directly — importing it (the test) must not
// connect to anything.
const invokedDirectly = process.argv[1]
  ?.replace(/\\/g, "/")
  .endsWith("scripts/report-misfiled-approval-customers.ts");

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
