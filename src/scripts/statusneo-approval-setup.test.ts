// apps/backend/src/scripts/statusneo-approval-setup.test.ts
//
// S7 / D10: the StatusNeo setup script — dry run by default, --apply,
// --expect-db, idempotent, people matched by employee ID then email (never by
// name), demo and non-Flow-3 workspaces refused, problems block --apply, and
// the result routes a request to the department head with the manager watching.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { runStatusNeoSetup, readSheet, toDeptRows, toPersonRows, DEFAULT_CONFIG } = await import("./statusneo-approval-setup.js");
const { activeWorkflowFor } = await import("../services/approvalWorkflow/store.js");
const { buildWorkflowSnapshot } = await import("../services/approvalWorkflow/engine.js");

const DB = "statusneo-setup-test";
let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const WS = oid();
const DEMO = oid();
const FLOW2 = oid();
const ENG = oid(); // existing department

const u = (n: string, employeeCode: string, email: string, ws: any = WS) => ({
  _id: oid(), workspaceId: ws, email, employeeCode, firstName: n.split(" ")[0], lastName: n.split(" ")[1], status: "ACTIVE", roles: ["EMPLOYEE"],
});
const ASHA = u("Asha Rao", "SN001", "asha@statusneo.test");
const HARI = u("Hari Head", "SN002", "hari@statusneo.test");
const MIRA = u("Mira Manager", "SN003", "mira@statusneo.test");
const SALES_HEAD = u("Sana Sales", "SN004", "sana@statusneo.test");
const RAVI = u("Ravi Sales", "SN005", "ravi@statusneo.test");
// Same name as Asha, different person: a name is never used to match.
const ASHA2 = u("Asha Rao", "SN099", "asha.r@statusneo.test");
const CFG = JSON.parse(fs.readFileSync(DEFAULT_CONFIG, "utf8"));

const prof = (user: any, employeeId: string, over: any = {}) => ({
  workspaceId: WS, firstName: user.firstName, lastName: user.lastName, email: user.email, employeeId, isActive: true, travelerId: `SN-${employeeId}`, ...over,
});

const departments = [
  { department: "Engineering", headEmployeeId: "SN002", headEmail: "" },
  { department: "Sales", headEmployeeId: "", headEmail: "sana@statusneo.test" },
];
const people = [
  { employeeId: "SN001", email: "", department: "Engineering", managerEmployeeId: "SN003", managerEmail: "" },
  { employeeId: "", email: "ravi@statusneo.test", department: "Sales", managerEmployeeId: "", managerEmail: "mira@statusneo.test" },
  { employeeId: "SN099", email: "", department: "Engineering", managerEmployeeId: "SN003", managerEmail: "" },
];
const base = () => ({ workspaceId: String(WS), expectDb: DB, actor: "Imran", departments, people, config: CFG, travelAdmins: ["travel@statusneo.test"], replyTo: "travel@statusneo.test", log: () => {} });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(DB));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    { _id: WS, customerId: "SN", name: "StatusNeo", companyName: "StatusNeo", status: "ACTIVE", defaultApproverEmails: ["travel@statusneo.test"], config: { travelFlow: "APPROVAL_DIRECT" } },
    { _id: DEMO, customerId: "SND", name: "StatusNeo Demo", companyName: "StatusNeo Demo", isDemo: true, config: { travelFlow: "APPROVAL_DIRECT" } },
    { _id: FLOW2, customerId: "F2", name: "Other Co", companyName: "Other Co", config: { travelFlow: "APPROVAL_FLOW" } },
  ] as any[]);
  await col("users").insertMany([ASHA, HARI, MIRA, SALES_HEAD, RAVI, ASHA2] as any[]);
  await col("departments").insertOne({ _id: ENG, workspaceId: WS, name: "Engineering", isActive: true } as any);
  await col("travellerprofiles").insertMany([
    prof(ASHA, "SN001"),
    prof(RAVI, "", {}),
    prof(ASHA2, "SN099"),
  ] as any[]);
});

describe("refusals", () => {
  it("needs --expect-db (and the right one) and --actor; refuses a demo or a non-Flow-3 workspace", async () => {
    await expect(runStatusNeoSetup({ ...base(), expectDb: undefined })).rejects.toThrow(/--expect-db=<name> is required/);
    await expect(runStatusNeoSetup({ ...base(), expectDb: "Plumtrips_hrms" })).rejects.toThrow(/but connected db is/);
    await expect(runStatusNeoSetup({ ...base(), actor: "" })).rejects.toThrow(/--actor/);
    await expect(runStatusNeoSetup({ ...base(), workspaceId: String(DEMO), apply: true })).rejects.toThrow(/demo workspace/);
    await expect(runStatusNeoSetup({ ...base(), workspaceId: String(FLOW2), apply: true })).rejects.toThrow(/Flow 3/);
    expect(await col("approvalworkflowversions").countDocuments()).toBe(0);
  });
});

describe("dry run, apply, idempotent", () => {
  it("a dry run reports the plan and writes nothing", async () => {
    const lines: string[] = [];
    const r = await runStatusNeoSetup({ ...base(), log: (s) => lines.push(s) });
    expect(r).toMatchObject({ written: false, publish: "dry-run", problems: [] });
    expect(r.departmentsCreated).toEqual(["Sales"]);
    expect(r.headsSet).toEqual(["Engineering → Hari Head <hari@statusneo.test>", "Sales → Sana Sales <sana@statusneo.test>"]);
    expect(r.profilesLinked).toHaveLength(3);
    expect(r.managersSet).toHaveLength(3);
    expect(lines.join("\n")).toMatch(/Dry run — nothing written/);
    expect(await col("departments").countDocuments()).toBe(1);
    expect(await col("travellerprofiles").countDocuments({ claimedBy: { $exists: true } })).toBe(0);
    expect(await col("approvalworkflowversions").countDocuments()).toBe(0);
  });

  it("--apply writes it all, by employee ID then email; a second --apply writes nothing", async () => {
    const r = await runStatusNeoSetup({ ...base(), apply: true });
    expect(r).toMatchObject({ written: true, publish: "published", problems: [] });
    const sales: any = await col("departments").findOne({ workspaceId: WS, name: "Sales" });
    expect(String(sales.managerId)).toBe(String(SALES_HEAD._id));
    expect(String((await col("departments").findOne({ _id: ENG }) as any).managerId)).toBe(String(HARI._id));

    const asha: any = await col("travellerprofiles").findOne({ employeeId: "SN001" });
    expect(asha).toMatchObject({ claimedBy: ASHA._id, departmentId: ENG, reportingManagerId: MIRA._id });
    // Same name, other employee ID: linked to its OWN login, never Asha's.
    const asha2: any = await col("travellerprofiles").findOne({ employeeId: "SN099" });
    expect(String(asha2.claimedBy)).toBe(String(ASHA2._id));
    const ravi: any = await col("travellerprofiles").findOne({ email: "ravi@statusneo.test" });
    expect(ravi).toMatchObject({ claimedBy: RAVI._id, departmentId: sales._id, reportingManagerId: MIRA._id });

    const wf: any = await activeWorkflowFor(WS);
    expect(wf).toMatchObject({ versionNumber: 1, leadersMayDecide: "OVERRIDE_WITH_REASON", completion: "ALL_SERVICES_BOOKED", requestOnlyMode: true });
    expect(wf.email).toMatchObject({ travelAdminEmails: ["travel@statusneo.test"], sender: { replyTo: "travel@statusneo.test" } });
    const audit = await col("approvalworkflowaudits").find({ workspaceId: WS }).toArray();
    expect(audit.map((a: any) => a.action)).toEqual(["ORG_DATA_SET", "DRAFT_SAVED", "VERSION_PUBLISHED"]);
    expect(audit[0].actor).toMatchObject({ name: "Imran", kind: "SCRIPT" });

    const again = await runStatusNeoSetup({ ...base(), apply: true });
    expect(again).toMatchObject({ written: false, publish: "unchanged", departmentsCreated: [], headsSet: [], profilesLinked: [], managersSet: [] });
    expect(await col("departments").countDocuments()).toBe(2);
    expect(await col("approvalworkflowaudits").countDocuments()).toBe(3);
  });

  it("the result routes Asha's request to her head, with her manager watching", async () => {
    await runStatusNeoSetup({ ...base(), apply: true });
    const wf: any = await activeWorkflowFor(WS);
    const ws: any = await col("customerworkspaces").findOne({ _id: WS });
    const built = await buildWorkflowSnapshot({ version: wf, ws, workspaceId: WS, requester: { id: String(ASHA._id), email: ASHA.email }, leaderEmails: [], actorIsLeader: false });
    expect(built.approver).toMatchObject({ email: HARI.email });
    expect(built.workflow.watcherEmails).toEqual([MIRA.email]);
  });
});

describe("problems block --apply", () => {
  it("unknown people, a profile claimed by another login, a department not in the sheet", async () => {
    await col("travellerprofiles").updateOne({ email: "ravi@statusneo.test" }, { $set: { claimedBy: HARI._id } });
    const bad = [
      ...people,
      { employeeId: "SN777", email: "", department: "Engineering", managerEmployeeId: "", managerEmail: "" },
      { employeeId: "SN001", email: "", department: "Finance", managerEmployeeId: "", managerEmail: "" },
    ];
    const r = await runStatusNeoSetup({ ...base(), people: bad });
    const text = r.problems.join("\n");
    expect(text).toContain("employee SN777: no login with employee ID SN777");
    expect(text).toContain("already linked to another login");
    expect(text).toContain("employee SN001 is listed twice");
    await expect(runStatusNeoSetup({ ...base(), people: bad, apply: true })).rejects.toThrow(/REFUSING --apply: \d+ problem/);
    expect(await col("travellerprofiles").countDocuments({ employeeId: "SN001", claimedBy: { $exists: true } })).toBe(0);

    // --allow-partial writes only the rows that matched, and never re-links Ravi's profile.
    const p = await runStatusNeoSetup({ ...base(), people: bad, apply: true, allowPartial: true });
    expect(p.written).toBe(true);
    expect(String(((await col("travellerprofiles").findOne({ email: "ravi@statusneo.test" })) as any).claimedBy)).toBe(String(HARI._id));
    expect(((await col("travellerprofiles").findOne({ employeeId: "SN001" })) as any).claimedBy).toEqual(ASHA._id);
  });

  it("two logins with the same email are ambiguous — nothing is guessed", async () => {
    await col("users").insertOne(u("Sana Again", "", "sana@statusneo.test") as any);
    const r = await runStatusNeoSetup({ ...base() });
    expect(r.problems.join("\n")).toContain('head of "Sales": 2 logins match');
  });
});

describe("reading the sheets", () => {
  it("reads a CSV with loose headers; rows with only a name are dropped (never matched by name)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-setup-"));
    const deptsCsv = path.join(dir, "departments.csv");
    const peopleCsv = path.join(dir, "people.csv");
    fs.writeFileSync(deptsCsv, "Department,Head Employee ID,Head Email\nEngineering,SN002,\nSales,,Sana@StatusNeo.test\n");
    fs.writeFileSync(peopleCsv, "Employee ID,Email,Department,Reporting Manager Employee ID,Reporting Manager Email,Name\nSN001,,Engineering,SN003,,Asha Rao\n,,Engineering,,,Only A Name\n");
    expect(toDeptRows(readSheet(deptsCsv))).toEqual([
      { department: "Engineering", headEmployeeId: "SN002", headEmail: "" },
      { department: "Sales", headEmployeeId: "", headEmail: "sana@statusneo.test" },
    ]);
    expect(toPersonRows(readSheet(peopleCsv))).toEqual([
      { employeeId: "SN001", email: "", department: "Engineering", managerEmployeeId: "SN003", managerEmail: "" },
    ]);
  });
});
