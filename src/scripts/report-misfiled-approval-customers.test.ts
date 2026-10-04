// apps/backend/src/scripts/report-misfiled-approval-customers.test.ts
//
// Real Mongo (in-memory), raw-insert fixtures (fields absent the way old prod
// rows have them). Guards: misfiled rows are found and say which company the
// stored customerId belongs to; a request filed by the workspace's _id (no
// customerId on the workspace) is NOT misfiled; requests with no workspace
// are listed separately; emails are masked; nothing is written; a missing or
// wrong --expect-db refuses before reading.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/misfiled-report-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

const { reportMisfiledApprovalCustomers, maskEmail } = await import("./report-misfiled-approval-customers.js");

const DB = "misfiled-report-test";
let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const id = () => new mongoose.Types.ObjectId();

const WS_A = id();
const WS_B = id();
const WS_NOCID = id(); // a workspace without customerId: requests store its _id
const R = { ok: id(), misfiled: id(), byWsId: id(), noWs: id(), unknownWs: id(), strayId: id() };

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
    { _id: WS_A, customerId: "CUST-A", companyName: "Acme Corp" },
    { _id: WS_B, customerId: "CUST-B", companyName: "Beta Ltd" },
    { _id: WS_NOCID, companyName: "No-Cid Co" },
  ]);
  await col("approvalrequests").insertMany([
    { _id: R.ok, workspaceId: WS_A, customerId: "CUST-A", customerName: "Acme Corp", frontlinerEmail: "a1@acme.test", status: "pending" },
    // filed under A, but the body named B: routed to B's approver
    { _id: R.misfiled, workspaceId: WS_A, customerId: "CUST-B", customerName: "Beta Ltd", ticketId: "TKT-9", frontlinerEmail: "a2@acme.test", managerEmail: "boss@beta.test", status: "approved", stage: "COMPLETED" },
    { _id: R.byWsId, workspaceId: WS_NOCID, customerId: String(WS_NOCID), customerName: "No-Cid Co", frontlinerEmail: "n@nocid.test" },
    { _id: R.noWs, customerId: "CUST-A", frontlinerEmail: "x@acme.test" },
    { _id: R.unknownWs, workspaceId: id(), customerId: "CUST-A", frontlinerEmail: "y@acme.test" },
    // customerId that no workspace has
    { _id: R.strayId, workspaceId: WS_B, customerId: "GHOST", frontlinerEmail: "b@beta.test" },
  ]);
});

describe("report-misfiled-approval-customers", () => {
  it("finds the misfiled requests, says whose customerId they carry, and lists missing workspaces apart", async () => {
    const lines: string[] = [];
    const r = await reportMisfiledApprovalCustomers({ expectDb: DB, log: (l) => lines.push(l) });

    expect(r.scanned).toBe(6);
    expect(r.misfiled.map((m) => m.id).sort()).toEqual([String(R.misfiled), String(R.strayId)].sort());
    const m = r.misfiled.find((x) => x.id === String(R.misfiled))!;
    expect(m).toMatchObject({
      code: "TKT-9",
      workspaceName: "Acme Corp",
      expectedCustomerId: "CUST-A",
      requestCustomerId: "CUST-B",
      belongsTo: "Beta Ltd",
      requester: "***@acme.test",
      approver: "***@beta.test",
    });
    expect(r.misfiled.find((x) => x.id === String(R.strayId))!.belongsTo).toBe("(no workspace has it)");
    expect(r.noWorkspace.map((x) => x.id).sort()).toEqual([String(R.noWs), String(R.unknownWs)].sort());

    const out = lines.join("\n");
    expect(out).toContain("READ-ONLY");
    expect(out).not.toMatch(/a2@acme\.test|boss@beta\.test|x@acme\.test/);
    expect(out).toContain("CUST-B → Beta Ltd");
  });

  it("writes nothing", async () => {
    const before = JSON.stringify(await col("approvalrequests").find({}).sort({ _id: 1 }).toArray());
    await reportMisfiledApprovalCustomers({ expectDb: DB, log: () => {} });
    expect(JSON.stringify(await col("approvalrequests").find({}).sort({ _id: 1 }).toArray())).toBe(before);
    expect((await mongoose.connection.db!.listCollections().toArray()).map((c) => c.name).sort()).toEqual(["approvalrequests", "customerworkspaces"]);
  });

  it("refuses without --expect-db, or with the wrong one, before reading", async () => {
    await expect(reportMisfiledApprovalCustomers({ expectDb: undefined, log: () => {} })).rejects.toThrow(/--expect-db=<name> is required/);
    await expect(reportMisfiledApprovalCustomers({ expectDb: "plumbox_prod", log: () => {} })).rejects.toThrow(/but connected db is "misfiled-report-test"/);
  });

  it("masks emails", () => {
    expect([maskEmail("Asha@Acme.test"), maskEmail(""), maskEmail("nodomain")]).toEqual(["***@acme.test", "—", "***"]);
  });
});
