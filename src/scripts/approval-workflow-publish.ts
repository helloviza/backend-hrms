// apps/backend/src/scripts/approval-workflow-publish.ts
//
// Publish an approval-workflow config for ONE workspace (the S1 write path;
// there is no admin page yet). Dry run by default: it prints the target, the
// validated config and what would change, and writes nothing.
//
//   npx tsx src/scripts/approval-workflow-publish.ts \
//     --workspace=<CustomerWorkspace _id> --config=<file.json> \
//     --actor="<your name>" --summary="<why>" --expect-db=<db> [--apply]
//
// - --expect-db must name the connected database (refuses otherwise).
// - Idempotent: a config equal to the published one is reported and skipped.
// - Demo workspaces (isDemo) are refused unless --allow-demo is given.
// - Every write is an ApprovalWorkflowAudit row naming --actor (kind SCRIPT).
// - Requests already raised keep their snapshot; only new requests use it.
import fs from "fs";
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import ApprovalWorkflowVersion from "../models/ApprovalWorkflowVersion.js";
import ApprovalWorkflowAudit from "../models/ApprovalWorkflowAudit.js";
import ApprovalRequest from "../models/ApprovalRequest.js";
import { sanitizeWorkflowConfig, configChanges, configOf } from "../services/approvalWorkflow/config.js";
import { currentPublished, publishWorkflowDraft, sameAsPublished, saveWorkflowDraft } from "../services/approvalWorkflow/store.js";

export type PublishOpts = {
  workspaceId: string;
  config: any;
  actor: string;
  summary: string;
  expectDb?: string;
  apply?: boolean;
  allowDemo?: boolean;
  log?: (s: string) => void;
};

export type PublishReport = { outcome: "dry-run" | "unchanged" | "published"; versionNumber?: number; changes: string[] };

export async function runWorkflowPublish(opts: PublishOpts): Promise<PublishReport> {
  const log = opts.log || ((s: string) => console.log(s));
  const db = mongoose.connection.name;
  if (!opts.expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (opts.expectDb !== db) throw new Error(`REFUSING: --expect-db="${opts.expectDb}" but connected db is "${db}".`);
  const actor = String(opts.actor || "").trim();
  if (!actor) throw new Error('REFUSING: --actor="<your name>" is required (it is written to the audit).');
  if (!String(opts.summary || "").trim()) throw new Error('REFUSING: --summary="<why>" is required.');
  if (!mongoose.Types.ObjectId.isValid(String(opts.workspaceId || ""))) throw new Error("REFUSING: --workspace must be a CustomerWorkspace _id.");

  const ws: any = await CustomerWorkspace.findOne({ _id: opts.workspaceId }).lean();
  if (!ws) throw new Error(`REFUSING: no workspace ${opts.workspaceId} in "${db}".`);
  const name = String(ws.companyName || ws.name || "");
  if (ws.isDemo && !opts.allowDemo) throw new Error(`REFUSING: "${name}" is a demo workspace (isDemo). Pass --allow-demo to touch it.`);

  const config = sanitizeWorkflowConfig(opts.config); // throws listing every problem
  log(`Workspace: ${name} (${String(ws._id)}) — travelFlow ${ws?.config?.travelFlow || "(unset)"}`);
  log(`Config: ${config.steps.map((s) => `${s.key}=${s.type}/${s.role}`).join(" → ")}; enabled=${config.enabled}; leadersMayDecide=${config.leadersMayDecide}; completion=${config.completion}; requestOnlyMode=${config.requestOnlyMode}`);

  if (await sameAsPublished(ws._id, config)) {
    const prev: any = await currentPublished(ws._id);
    log(`Unchanged — version ${prev?.versionNumber} already has this config. Nothing written.`);
    return { outcome: "unchanged", versionNumber: prev?.versionNumber, changes: [] };
  }
  const prev = await currentPublished(ws._id);
  const changes = configChanges(prev ? configOf(prev) : null, config).map((c) => c.field);
  log(`Changes vs ${prev ? `version ${prev.versionNumber}` : "nothing published"}: ${changes.join(", ") || "(none)"}`);
  if (ws?.config?.travelFlow !== "APPROVAL_DIRECT" && ws?.config?.travelFlow !== "APPROVAL_FLOW") {
    log(`WARNING: travelFlow is ${ws?.config?.travelFlow || "(unset)"} — the workflow applies only to Flow 2 / Flow 3 requests.`);
  }

  if (!opts.apply) {
    log("Dry run — nothing written. Re-run with --apply to publish.");
    return { outcome: "dry-run", changes };
  }
  await Promise.all([ApprovalWorkflowVersion.createIndexes(), ApprovalWorkflowAudit.createIndexes(), ApprovalRequest.createIndexes()]);
  const who = { id: "", name: actor, email: "", kind: "SCRIPT" as const, roles: ["SCRIPT"] };
  await saveWorkflowDraft({ workspaceId: ws._id, config, actor: who });
  const published: any = await publishWorkflowDraft({ workspaceId: ws._id, actor: who, changeSummary: opts.summary });
  log(`Published version ${published.versionNumber} for ${name}.`);
  return { outcome: "published", versionNumber: published.versionNumber, changes };
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  const host = uri.replace(/^mongodb(\+srv)?:\/\/([^@/]*@)?/, "").split(/[/?]/)[0];
  console.log(`Target: ${host}`);
  const file = arg("config");
  if (!file) throw new Error("--config=<file.json> is required");
  await mongoose.connect(uri);
  try {
    console.log(`Database: ${mongoose.connection.name}`);
    await runWorkflowPublish({
      workspaceId: String(arg("workspace") || ""),
      config: JSON.parse(fs.readFileSync(file, "utf8")),
      actor: String(arg("actor") || ""),
      summary: String(arg("summary") || ""),
      expectDb: arg("expect-db"),
      apply: process.argv.includes("--apply"),
      allowDemo: process.argv.includes("--allow-demo"),
    });
  } finally {
    await mongoose.disconnect();
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/approval-workflow-publish.ts");
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err?.message || err);
      process.exit(1);
    });
}
