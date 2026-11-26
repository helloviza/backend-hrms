// apps/backend/src/services/approvalWorkflow/store.ts
//
// Reading and writing approval-workflow versions.
//
//   activeWorkflowFor(workspaceId) — THE one reader that decides whether a
//     workspace's workflow is in force: its PUBLISHED version with enabled
//     true, else null. null = today's routing, untouched.
//   saveWorkflowDraft / publishWorkflowDraft — the only write path (used by
//     the audited script now, the admin page later). Each write appends an
//     ApprovalWorkflowAudit row naming the actor.
import mongoose from "mongoose";
import ApprovalWorkflowVersion, { type WorkflowActor } from "../../models/ApprovalWorkflowVersion.js";
import ApprovalWorkflowAudit, { type ApprovalWorkflowAuditAction } from "../../models/ApprovalWorkflowAudit.js";
import CustomerWorkspace from "../../models/CustomerWorkspace.js";
import { configChanges, configOf, sanitizeWorkflowConfig, type WorkflowConfig } from "./config.js";

type AnyObj = Record<string, any>;
const oid = (v: any) => (mongoose.Types.ObjectId.isValid(String(v ?? "")) ? new mongoose.Types.ObjectId(String(v)) : null);

/** The workspace's workflow in force, or null (= today's routing). */
export async function activeWorkflowFor(workspaceId: any): Promise<(AnyObj & WorkflowConfig) | null> {
  const ws = oid(workspaceId);
  if (!ws) return null;
  const v: any = await ApprovalWorkflowVersion.findOne({ workspaceId: ws, status: "PUBLISHED" })
    .sort({ versionNumber: -1 })
    .lean()
    .exec();
  if (!v || v.enabled !== true) return null;
  return v;
}

export async function currentPublished(workspaceId: any): Promise<AnyObj | null> {
  const ws = oid(workspaceId);
  if (!ws) return null;
  return (await ApprovalWorkflowVersion.findOne({ workspaceId: ws, status: "PUBLISHED" }).lean().exec()) as AnyObj | null;
}

export async function currentDraft(workspaceId: any): Promise<AnyObj | null> {
  const ws = oid(workspaceId);
  if (!ws) return null;
  return (await ApprovalWorkflowVersion.findOne({ workspaceId: ws, status: "DRAFT" }).lean().exec()) as AnyObj | null;
}

async function workspaceName(workspaceId: mongoose.Types.ObjectId): Promise<string> {
  const ws: any = await CustomerWorkspace.findOne({ _id: workspaceId }).select("name companyName displayName").lean().exec();
  return String(ws?.companyName || ws?.name || ws?.displayName || "");
}

export async function appendWorkflowAudit(entry: {
  workspaceId: mongoose.Types.ObjectId;
  action: ApprovalWorkflowAuditAction;
  versionId?: string | null;
  versionNumber?: number | null;
  summary: string;
  changes?: { field: string; from: unknown; to: unknown }[];
  reason?: string;
  actor: WorkflowActor;
}) {
  await ApprovalWorkflowAudit.create({
    workspaceId: entry.workspaceId,
    workspaceName: await workspaceName(entry.workspaceId),
    action: entry.action,
    versionId: entry.versionId ?? null,
    versionNumber: entry.versionNumber ?? null,
    summary: entry.summary,
    changes: entry.changes || [],
    reason: entry.reason || "",
    actor: entry.actor,
  });
}

/** Create or replace the workspace's one DRAFT with this config. */
export async function saveWorkflowDraft(opts: { workspaceId: any; config: any; actor: WorkflowActor }) {
  const ws = oid(opts.workspaceId);
  if (!ws) throw new Error("workspaceId is not a valid id");
  if (!(await CustomerWorkspace.exists({ _id: ws }))) throw new Error(`No workspace ${String(ws)}`);
  const config = sanitizeWorkflowConfig(opts.config);
  const existing: any = await currentDraft(ws);
  const base = existing ? configOf(existing) : (await currentPublished(ws)) ? configOf(await currentPublished(ws)) : null;
  let draft: any;
  if (existing) {
    draft = await ApprovalWorkflowVersion.findOneAndUpdate(
      { _id: existing._id, workspaceId: ws, status: "DRAFT" },
      { $set: { ...config, updatedBy: opts.actor } },
      { new: true },
    ).lean();
  } else {
    draft = (await ApprovalWorkflowVersion.create({ workspaceId: ws, status: "DRAFT", ...config, createdBy: opts.actor })).toObject();
  }
  await appendWorkflowAudit({
    workspaceId: ws,
    action: "DRAFT_SAVED",
    versionId: String(draft._id),
    summary: existing ? "Draft updated" : "Draft created",
    changes: configChanges(base, config),
    actor: opts.actor,
  });
  return draft;
}

/**
 * Publish the workspace's DRAFT: the previous PUBLISHED version is archived
 * first, then the draft becomes PUBLISHED with the next version number. A
 * change summary is required. Requests already raised keep their snapshot.
 */
export async function publishWorkflowDraft(opts: { workspaceId: any; actor: WorkflowActor; changeSummary: string }) {
  const ws = oid(opts.workspaceId);
  if (!ws) throw new Error("workspaceId is not a valid id");
  const summary = String(opts.changeSummary || "").trim();
  if (!summary) throw new Error("A change summary is required to publish.");
  const draft: any = await currentDraft(ws);
  if (!draft) throw new Error("There is no draft to publish.");
  const config = configOf(draft); // re-validated at publish
  const prev: any = await currentPublished(ws);
  const last: any = await ApprovalWorkflowVersion.findOne({ workspaceId: ws, versionNumber: { $type: "number" } })
    .sort({ versionNumber: -1 })
    .select("versionNumber")
    .lean();
  const versionNumber = Number(last?.versionNumber || 0) + 1;

  if (prev) {
    await ApprovalWorkflowVersion.updateOne(
      { _id: prev._id, workspaceId: ws, status: "PUBLISHED" },
      { $set: { status: "ARCHIVED", archivedBy: opts.actor, archivedAt: new Date() } },
      { awInternal: true } as any,
    );
    await appendWorkflowAudit({
      workspaceId: ws,
      action: "VERSION_ARCHIVED",
      versionId: String(prev._id),
      versionNumber: prev.versionNumber,
      summary: `Version ${prev.versionNumber} replaced by version ${versionNumber}`,
      actor: opts.actor,
    });
  }
  const published: any = await ApprovalWorkflowVersion.findOneAndUpdate(
    { _id: draft._id, workspaceId: ws, status: "DRAFT" },
    {
      $set: {
        ...config,
        status: "PUBLISHED",
        versionNumber,
        changeSummary: summary,
        publishedBy: opts.actor,
        publishedAt: new Date(),
      },
    },
    { new: true },
  ).lean();
  await appendWorkflowAudit({
    workspaceId: ws,
    action: "VERSION_PUBLISHED",
    versionId: String(published._id),
    versionNumber,
    summary: `Version ${versionNumber} published${config.enabled ? "" : " (switched off)"}`,
    changes: configChanges(prev ? configOf(prev) : null, config),
    reason: summary,
    actor: opts.actor,
  });
  return published;
}

/** Same config as the one in force (or published but off)? Used for idempotent scripts. */
export async function sameAsPublished(workspaceId: any, rawConfig: any): Promise<boolean> {
  const prev = await currentPublished(workspaceId);
  if (!prev) return false;
  return JSON.stringify(configOf(prev)) === JSON.stringify(sanitizeWorkflowConfig(rawConfig));
}
