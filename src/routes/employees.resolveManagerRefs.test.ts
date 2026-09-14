// resolveManagerRefs (PUT /employees/:id reporting lines) — the workspace gate
// is enforced on the resolved OWNER USER, so a legacy Employee row with a
// missing or string-typed workspaceId (the prod class that rejected
// "L2 = Wassiqa" with "managerL2Id must be a user in this workspace") resolves,
// while a genuinely cross-workspace id is still refused. Fixtures are RAW
// inserts: the Employee schema requires an ObjectId workspaceId, so the bad
// shapes can only be reproduced below the model.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/resolve-manager-test";
process.env.JWT_SECRET ||= "test-secret";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

vi.mock("../middleware/auth.js", () => ({ requireAuth: (_r: any, _s: any, n: any) => n(), default: (_r: any, _s: any, n: any) => n() }));

const { default: User } = await import("../models/User.js");
const { default: Employee } = await import("../models/Employee.js");
const { resolveManagerRefs } = await import("./employees.js");

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const OTHER = new mongoose.Types.ObjectId();
const oid = () => new mongoose.Types.ObjectId();

const u = { wassiqa: oid(), saima: oid(), utkarsh: oid(), stranger: oid(), noEmp: oid() };
const e = { wassiqa: oid(), saima: oid(), utkarsh: oid(), stranger: oid(), orphan: oid() };

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await User.collection.insertMany([
    { _id: u.wassiqa, name: "Wassiqa Nawaz Mir", email: "wassiqa@plumtrips.com", roles: ["ADMIN"], workspaceId: HOUSE, passwordHash: "x" },
    { _id: u.saima, name: "Saima", email: "saima@plumtrips.com", roles: ["SUPERADMIN"], workspaceId: HOUSE, passwordHash: "x" },
    { _id: u.utkarsh, name: "Utkarsh", email: "utkarsh@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: HOUSE, passwordHash: "x" },
    { _id: u.stranger, name: "Stranger", email: "stranger@other.test", roles: ["EMPLOYEE"], workspaceId: OTHER, passwordHash: "x" },
    { _id: u.noEmp, name: "No Employee Row", email: "noemp@plumtrips.com", roles: ["EMPLOYEE"], workspaceId: HOUSE, passwordHash: "x" },
  ] as any[]);
  await Employee.collection.insertMany([
    // the prod shape that failed: no workspaceId at all, owner in HOUSE
    { _id: e.wassiqa, fullName: "Wassiqa Nawaz Mir", email: "wassiqa@plumtrips.com", ownerId: u.wassiqa, status: "ACTIVE" },
    // healthy row
    { _id: e.saima, fullName: "Saima", email: "saima@plumtrips.com", ownerId: u.saima, workspaceId: HOUSE, status: "ACTIVE" },
    // workspaceId stored as a STRING
    { _id: e.utkarsh, fullName: "Utkarsh", email: "utkarsh@plumtrips.com", ownerId: u.utkarsh, workspaceId: String(HOUSE), status: "ACTIVE" },
    // genuinely another workspace, on both docs
    { _id: e.stranger, fullName: "Stranger", email: "stranger@other.test", ownerId: u.stranger, workspaceId: OTHER, status: "ACTIVE" },
    // unstamped row whose owner lives elsewhere — must NOT slip through
    { _id: e.orphan, fullName: "Orphan", email: "stranger@other.test", ownerId: u.stranger, status: "ACTIVE" },
  ] as any[]);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe("resolveManagerRefs — workspace gate on the owner User", () => {
  it("resolves an Employee id whose row has NO workspaceId when its owner User is in the subject's workspace", async () => {
    const r = await resolveManagerRefs(String(e.wassiqa), HOUSE);
    expect(r).toEqual({ userId: u.wassiqa, employeeId: e.wassiqa, displayName: "Wassiqa Nawaz Mir" });
  });

  it("resolves an Employee id whose workspaceId is stored as a string", async () => {
    const r = await resolveManagerRefs(String(e.utkarsh), HOUSE);
    expect(r).toEqual({ userId: u.utkarsh, employeeId: e.utkarsh, displayName: "Utkarsh" });
  });

  it("still resolves a healthy row, and a User id directly", async () => {
    expect(await resolveManagerRefs(String(e.saima), HOUSE)).toEqual({ userId: u.saima, employeeId: e.saima, displayName: "Saima" });
    expect(await resolveManagerRefs(String(u.wassiqa), HOUSE)).toEqual({ userId: u.wassiqa, employeeId: e.wassiqa, displayName: "Wassiqa Nawaz Mir" });
    expect(await resolveManagerRefs(String(u.noEmp), HOUSE)).toEqual({ userId: u.noEmp, employeeId: null, displayName: "No Employee Row" });
  });

  it("rejects a genuinely cross-workspace manager — by Employee id, by User id, and via an unstamped row whose owner is elsewhere", async () => {
    expect(await resolveManagerRefs(String(e.stranger), HOUSE)).toBeNull();
    expect(await resolveManagerRefs(String(u.stranger), HOUSE)).toBeNull();
    expect(await resolveManagerRefs(String(e.orphan), HOUSE)).toBeNull();
    // and the same ids ARE valid for a subject in the other workspace
    expect(await resolveManagerRefs(String(e.stranger), OTHER)).toMatchObject({ userId: u.stranger, employeeId: e.stranger });
    // a HOUSE row stamped HOUSE is refused for an OTHER-workspace subject, even though its owner exists
    expect(await resolveManagerRefs(String(e.saima), OTHER)).toBeNull();
  });

  it("rejects garbage and unknown ids", async () => {
    expect(await resolveManagerRefs("", HOUSE)).toBeNull();
    expect(await resolveManagerRefs("not-an-id", HOUSE)).toBeNull();
    expect(await resolveManagerRefs(String(oid()), HOUSE)).toBeNull();
  });
});
