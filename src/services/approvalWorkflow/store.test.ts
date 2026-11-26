// apps/backend/src/services/approvalWorkflow/store.test.ts
//
// S1: approval-workflow versions, audit, the "in force?" resolver and the
// audited publish script.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { default: ApprovalWorkflowVersion, AW_FROZEN_MESSAGE } = await import("../../models/ApprovalWorkflowVersion.js");
const { default: ApprovalWorkflowAudit, AW_AUDIT_APPEND_ONLY } = await import("../../models/ApprovalWorkflowAudit.js");
const { sanitizeWorkflowConfig, WorkflowConfigError, checkPurpose } = await import("./config.js");
const { activeWorkflowFor, saveWorkflowDraft, publishWorkflowDraft } = await import("./store.js");
const { runWorkflowPublish } = await import("../../scripts/approval-workflow-publish.js");

const DB = "approval-workflow-store-test";
let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const WS = new mongoose.Types.ObjectId();
const DEMO = new mongoose.Types.ObjectId();
const actor = { id: "u1", name: "Imran", email: "imran@plumtrips.test", kind: "PLUMTRIPS_STAFF" as const, roles: ["SUPERADMIN"] };

const STATUSNEO = {
  template: "DEPT_HEAD_WATCHER",
  enabled: true,
  raisedBy: "EMPLOYEE",
  requestOnlyMode: true,
  purpose: { required: true, options: ["Client meeting", "Project-delivery", "Training", "Internal meeting", "Conference-event", "Other"] },
  completion: "ALL_SERVICES_BOOKED",
  leadersMayDecide: "OVERRIDE_WITH_REASON",
  steps: [
    { key: "head", label: "Department head approval", type: "DEPARTMENT_HEAD", role: "APPROVER", fallback: "DEFAULT_APPROVER", selfRule: "NEXT_IN_LINE", reminders: { afterHours: [48, 24] } },
    { key: "rm", label: "Reporting manager (FYI)", type: "REPORTING_MANAGER", role: "WATCHER", fallback: "SKIP", watcherEvents: ["submitted", "approved", "declined", "booking_done"] },
  ],
  groups: [],
  email: { travelAdminEmails: ["Travel@StatusNeo.test"], sender: { level: "A", displayName: "StatusNeo Travel via Plumtrips", replyTo: "travel@statusneo.test" } },
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(DB));
  await mongoose.connection.db!.dropDatabase();
  await ApprovalWorkflowVersion.createIndexes();
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await col("approvalworkflowversions").deleteMany({});
  await col("approvalworkflowaudits").deleteMany({});
  await col("customerworkspaces").deleteMany({});
  await col("customerworkspaces").insertMany([
    { _id: WS, customerId: "SN", name: "StatusNeo", companyName: "StatusNeo", config: { travelFlow: "APPROVAL_DIRECT" } },
    { _id: DEMO, customerId: "SND", name: "StatusNeo Demo", isDemo: true, config: { travelFlow: "APPROVAL_FLOW" } },
  ] as any[]);
});

describe("sanitizeWorkflowConfig", () => {
  it("accepts the StatusNeo config and normalises it", () => {
    const c = sanitizeWorkflowConfig(STATUSNEO);
    expect(c.leadersMayDecide).toBe("OVERRIDE_WITH_REASON");
    expect(c.email.travelAdminEmails).toEqual(["travel@statusneo.test"]);
    expect(c.steps[0]).toMatchObject({ key: "head", phase: "REQUEST", decisionRule: "ANY", samePersonRule: "AUTO_PASS", reminders: { afterHours: [24, 48] } });
    expect(c.steps[1].watcherEvents).toEqual(["submitted", "approved", "declined", "booking_done"]);
  });

  it("maps the old boolean leadersMayDecide to ALLOW / DENY", () => {
    expect(sanitizeWorkflowConfig({ ...STATUSNEO, leadersMayDecide: true }).leadersMayDecide).toBe("ALLOW");
    expect(sanitizeWorkflowConfig({ ...STATUSNEO, leadersMayDecide: false }).leadersMayDecide).toBe("DENY");
  });

  it("lists every problem, and refuses SidVin-only features rather than ignoring them", () => {
    let err: any;
    try {
      sanitizeWorkflowConfig({
        raisedBy: "DESK",
        leadersMayDecide: "SOMETIMES",
        steps: [
          { key: "Bad Key", label: "", type: "PROJECT_SPOC", role: "APPROVER" },
          { key: "rm", label: "RM", type: "REPORTING_MANAGER", role: "WATCHER", fallback: "DEFAULT_APPROVER", watcherEvents: ["everything"] },
          { key: "rm", label: "RM again", type: "COST_APPROVAL", role: "APPROVER", phase: "COST", decisionRule: "ALL" },
        ],
        groups: [{ key: "HR" }],
        email: { travelAdminEmails: ["not-an-email"], sender: { replyTo: "nope" } },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkflowConfigError);
    const text = err.problems.join("\n");
    for (const bit of [
      "raisedBy: DESK is not supported",
      'leadersMayDecide: "SOMETIMES"',
      "steps[0].key",
      "steps[0].label: required",
      "PROJECT_SPOC is not supported",
      "steps[1].fallback: a WATCHER step can only SKIP",
      'watcherEvents: "everything"',
      'key "rm" is used twice',
      "COST steps are not supported",
      "ALL is not supported",
      "groups: approver groups are not supported",
      '"not-an-email" is not an email',
      'replyTo: "nope"',
    ]) expect(text).toContain(bit);
  });

  it("needs at least one APPROVER step", () => {
    expect(() => sanitizeWorkflowConfig({ steps: [{ key: "rm", label: "RM", type: "REPORTING_MANAGER", role: "WATCHER" }] })).toThrow(/at least one APPROVER/);
  });

  it("purpose: required, from the list, Other needs text (D8)", () => {
    const c = sanitizeWorkflowConfig(STATUSNEO);
    expect(checkPurpose(c, undefined)).toEqual({ ok: false, error: "Choose the purpose of travel." });
    expect(checkPurpose(c, { code: "Holiday" })).toMatchObject({ ok: false });
    expect(checkPurpose(c, { code: "training" })).toEqual({ ok: true, purpose: { code: "Training", text: "" } });
    expect(checkPurpose(c, { code: "Other" })).toEqual({ ok: false, error: "Say what the purpose of travel is." });
    expect(checkPurpose(c, { code: "Other", text: "Visa interview" })).toEqual({ ok: true, purpose: { code: "Other", text: "Visa interview" } });
    expect(checkPurpose({ purpose: { required: false, options: [] } }, undefined)).toEqual({ ok: true, purpose: null });
  });
});

describe("versions: draft, publish, freeze, audit", () => {
  it("is off until a version is published and enabled", async () => {
    expect(await activeWorkflowFor(WS)).toBeNull();
    await saveWorkflowDraft({ workspaceId: WS, config: STATUSNEO, actor });
    expect(await activeWorkflowFor(WS)).toBeNull(); // a draft is never in force
    await publishWorkflowDraft({ workspaceId: WS, actor, changeSummary: "StatusNeo go-live" });
    const v: any = await activeWorkflowFor(WS);
    expect(v).toMatchObject({ status: "PUBLISHED", versionNumber: 1, enabled: true });

    await saveWorkflowDraft({ workspaceId: WS, config: { ...STATUSNEO, enabled: false }, actor });
    await publishWorkflowDraft({ workspaceId: WS, actor, changeSummary: "Switch off" });
    expect(await activeWorkflowFor(WS)).toBeNull(); // published but off = today's routing
    const rows = await ApprovalWorkflowVersion.find({ workspaceId: WS }).sort({ versionNumber: 1 }).lean();
    expect(rows.map((r: any) => [r.versionNumber, r.status])).toEqual([[1, "ARCHIVED"], [2, "PUBLISHED"]]);
  });

  it("publishing needs a draft and a change summary", async () => {
    await expect(publishWorkflowDraft({ workspaceId: WS, actor, changeSummary: "x" })).rejects.toThrow(/no draft/);
    await saveWorkflowDraft({ workspaceId: WS, config: STATUSNEO, actor });
    await expect(publishWorkflowDraft({ workspaceId: WS, actor, changeSummary: " " })).rejects.toThrow(/change summary/);
  });

  it("keeps one draft per workspace (a second save replaces it)", async () => {
    await saveWorkflowDraft({ workspaceId: WS, config: STATUSNEO, actor });
    await saveWorkflowDraft({ workspaceId: WS, config: { ...STATUSNEO, requestOnlyMode: false }, actor });
    const drafts = await ApprovalWorkflowVersion.find({ workspaceId: WS, status: "DRAFT" }).lean();
    expect(drafts).toHaveLength(1);
    expect((drafts[0] as any).requestOnlyMode).toBe(false);
    await expect(col("approvalworkflowversions").insertOne({ workspaceId: WS, status: "DRAFT" } as any)).rejects.toThrow(/duplicate key/);
  });

  it("a published version is frozen", async () => {
    await saveWorkflowDraft({ workspaceId: WS, config: STATUSNEO, actor });
    const v: any = await publishWorkflowDraft({ workspaceId: WS, actor, changeSummary: "go" });
    await expect(ApprovalWorkflowVersion.updateOne({ _id: v._id }, { $set: { enabled: false } })).rejects.toThrow(AW_FROZEN_MESSAGE);
    await expect(ApprovalWorkflowVersion.deleteOne({ _id: v._id })).rejects.toThrow(AW_FROZEN_MESSAGE);
    const doc: any = await ApprovalWorkflowVersion.findById(v._id);
    doc.enabled = false;
    await expect(doc.save()).rejects.toThrow(AW_FROZEN_MESSAGE);
    await expect(col("approvalworkflowversions").insertOne({ workspaceId: WS, status: "PUBLISHED", versionNumber: 9 } as any)).rejects.toThrow(/duplicate key/);
  });

  it("every write is audited, and the audit is append-only", async () => {
    await saveWorkflowDraft({ workspaceId: WS, config: STATUSNEO, actor });
    await publishWorkflowDraft({ workspaceId: WS, actor, changeSummary: "go" });
    await saveWorkflowDraft({ workspaceId: WS, config: { ...STATUSNEO, requestOnlyMode: false }, actor });
    await publishWorkflowDraft({ workspaceId: WS, actor, changeSummary: "show search" });
    const audit: any[] = await ApprovalWorkflowAudit.find({ workspaceId: WS }).sort({ createdAt: 1, _id: 1 }).lean();
    expect(audit.map((a) => a.action)).toEqual(["DRAFT_SAVED", "VERSION_PUBLISHED", "DRAFT_SAVED", "VERSION_ARCHIVED", "VERSION_PUBLISHED"]);
    expect(audit[0]).toMatchObject({ workspaceName: "StatusNeo", actor: { name: "Imran", kind: "PLUMTRIPS_STAFF" } });
    expect(audit[4].changes.map((c: any) => c.field)).toEqual(["requestOnlyMode"]);
    expect(audit[4].reason).toBe("show search");
    await expect(ApprovalWorkflowAudit.updateOne({ _id: audit[0]._id }, { $set: { summary: "x" } })).rejects.toThrow(AW_AUDIT_APPEND_ONLY);
    await expect(ApprovalWorkflowAudit.deleteMany({})).rejects.toThrow(AW_AUDIT_APPEND_ONLY);
  });
});

describe("the publish script", () => {
  const base = { workspaceId: String(WS), config: STATUSNEO, actor: "Imran", summary: "StatusNeo go-live", log: () => {} };

  it("refuses without --expect-db, on the wrong db, without --actor, and on a demo workspace", async () => {
    await expect(runWorkflowPublish({ ...base })).rejects.toThrow(/--expect-db=<name> is required/);
    await expect(runWorkflowPublish({ ...base, expectDb: "prod" })).rejects.toThrow(/but connected db is/);
    await expect(runWorkflowPublish({ ...base, expectDb: DB, actor: "" })).rejects.toThrow(/--actor/);
    await expect(runWorkflowPublish({ ...base, expectDb: DB, workspaceId: String(DEMO), apply: true })).rejects.toThrow(/demo workspace/);
    expect(await col("approvalworkflowversions").countDocuments()).toBe(0);
  });

  it("dry run by default writes nothing; --apply publishes; a second --apply is a no-op", async () => {
    const lines: string[] = [];
    expect(await runWorkflowPublish({ ...base, expectDb: DB, log: (s) => lines.push(s) })).toMatchObject({ outcome: "dry-run" });
    expect(lines.join("\n")).toMatch(/Dry run — nothing written/);
    expect(await col("approvalworkflowversions").countDocuments()).toBe(0);
    expect(await col("approvalworkflowaudits").countDocuments()).toBe(0);

    expect(await runWorkflowPublish({ ...base, expectDb: DB, apply: true })).toMatchObject({ outcome: "published", versionNumber: 1 });
    expect(await runWorkflowPublish({ ...base, expectDb: DB, apply: true })).toMatchObject({ outcome: "unchanged", versionNumber: 1 });
    expect(await col("approvalworkflowversions").countDocuments()).toBe(1);
    const audit: any[] = await ApprovalWorkflowAudit.find({ workspaceId: WS }).lean();
    expect(audit.every((a) => a.actor.kind === "SCRIPT" && a.actor.name === "Imran")).toBe(true);
  });

  it("an invalid config is refused before anything is written", async () => {
    await expect(runWorkflowPublish({ ...base, expectDb: DB, apply: true, config: { ...STATUSNEO, steps: [] } })).rejects.toThrow(/at least one APPROVER/);
    expect(await col("approvalworkflowversions").countDocuments()).toBe(0);
  });
});
