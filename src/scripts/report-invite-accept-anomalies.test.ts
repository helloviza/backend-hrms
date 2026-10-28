// The read-only anomaly report against a real mongodb-memory-server: each
// section catches its shape, the --expect-db guard refuses, nothing is written.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const { reportInviteAcceptAnomalies } = await import("./report-invite-accept-anomalies.js");

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const DB = "invite-anomaly-report-test";

const WS_A = oid();
const WS_B = oid();
const INVITER = oid();
const day = 86400_000;
const t0 = Date.now() - 30 * day;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(DB));

  await col("customerworkspaces").insertMany([
    { _id: WS_A, customerId: "custA", companyName: "Company A" },
    { _id: WS_B, customerId: "custB", companyName: "Company B" },
  ]);
  const victim = oid();
  const hrMade = oid();
  await col("users").insertMany([
    { _id: INVITER, email: "req@a.com", roles: ["CUSTOMER", "REQUESTER"], workspaceId: WS_A },
    { _id: victim, email: "victim@b.com", roles: ["CUSTOMER"], workspaceId: WS_B, customerId: "custB", createdAt: new Date(t0) },
    { _id: hrMade, email: "hire@a.com", roles: ["EMPLOYEE"], workspaceId: WS_A, createdAt: new Date(t0) },
    { _id: oid(), email: "climber@a.com", roles: ["SUPERADMIN"], workspaceId: WS_A, createdAt: new Date(t0 + 3 * day) },
    { _id: oid(), email: "other@b.com", roles: ["CUSTOMER"], workspaceId: WS_B, customerId: "custB", createdAt: new Date(t0) },
  ]);
  const inv = (email: string, extra: Record<string, any>) => ({
    _id: oid(), workspaceId: WS_A, email, role: "EMPLOYEE", invitedBy: INVITER, token: `t-${email}`,
    expiresAt: new Date(Date.now() + 7 * day), createdAt: new Date(t0 + day), ...extra,
  });
  await col("workspaceinvites").insertMany([
    inv("victim@b.com", { status: "accepted", acceptedAt: new Date(t0 + 2 * day) }),
    inv("hire@a.com", { status: "accepted", acceptedAt: new Date(t0 + 2 * day) }),
    inv("climber@a.com", { role: "SUPERADMIN", status: "accepted", acceptedAt: new Date(t0 + 3 * day) }),
    inv("other@b.com", { status: "pending" }),
  ]);
  await col("sessionlogs").insertOne({ userId: victim, event: "LOGIN", success: true, ipAddress: "203.0.113.9", createdAt: new Date(t0 + 4 * day) });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("report-invite-accept-anomalies", () => {
  it("refuses without, or with the wrong, --expect-db", async () => {
    await expect(reportInviteAcceptAnomalies({ log: () => {} })).rejects.toThrow(/REFUSING/);
    await expect(reportInviteAcceptAnomalies({ expectDb: "prod", log: () => {} })).rejects.toThrow(/REFUSING/);
  });

  it("flags each shape in its section and writes nothing", async () => {
    const before = await Promise.all(["users", "workspaceinvites", "sessionlogs", "customerworkspaces"].map((n) => col(n).countDocuments()));
    const lines: string[] = [];
    const out = await reportInviteAcceptAnomalies({ expectDb: DB, log: (l) => lines.push(l) });

    expect(out.A).toHaveLength(1);
    expect(out.A[0]).toContain("victim@b.com");
    expect(out.A[0]).toContain("NOT AN ADMIN");
    expect(out.A[0]).toContain("203.0.113.9");

    expect(out.B).toHaveLength(2);
    expect(out.B.join("\n")).toMatch(/victim@b\.com[^\n]*OTHER WORKSPACE/);
    expect(out.B.join("\n")).toMatch(/hire@a\.com[^\n]*same workspace/);

    expect(out.C).toHaveLength(1);
    expect(out.C[0]).toContain("climber@a.com");
    expect(out.C[0]).toContain("login(s) holding SUPERADMIN");

    expect(out.D).toHaveLength(1);
    expect(out.D[0]).toContain("other@b.com");

    const after = await Promise.all(["users", "workspaceinvites", "sessionlogs", "customerworkspaces"].map((n) => col(n).countDocuments()));
    expect(after).toEqual(before);
    expect(lines[0]).toMatch(/READ ONLY/);
  });
});
