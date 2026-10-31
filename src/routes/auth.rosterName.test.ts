// The roster name a customer login writes (auth.ts ensureWorkspaceAndLeader)
// and the first / last split of a typed full name (customerUsers.ts
// ensureAuthUserForCustomer) — docs/audits/company-vs-person-name-audit.md
// §6.2 items 4–5. Real auth router, in-memory Mongo.
//
//   • login copies the stored PERSON name (first + last) to CustomerMember.name
//   • a login with no stored name leaves the roster name alone — it used to
//     write the session's email-local-part fallback there
//   • "Asha Rao Iyer" creates firstName "Asha", lastName "Rao Iyer"
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.hoisted(() => {
  for (const [k, v] of Object.entries({
    MONGO_URI: "mongodb://127.0.0.1:1/unused",
    JWT_SECRET: "jwt-secret-for-tests",
    JWT_REFRESH_SECRET: "refresh-secret-for-tests",
    FRONTEND_ORIGIN: "http://localhost:5173",
    AWS_REGION: "ap-south-1",
    S3_BUCKET: "test-bucket",
    GEMINI_API_KEY: "test",
    OPENAI_API_KEY: "test-key",
  })) process.env[k] ||= v;
  delete process.env.MULTI_WORKSPACE_LOGIN;
});

const sendMail = vi.hoisted(() => vi.fn(async () => ({ messageId: "test" })));
vi.mock("../utils/mailer.js", async (orig) => ({ ...(await orig<any>()), sendMail }));

const { default: authRouter } = await import("./auth.js");
const { ensureAuthUserForCustomer } = await import("./customerUsers.js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const CUST = oid();
const WS = oid();
const PW = "Correct-Horse-9";

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("auth-roster-name-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await col("customers").insertOne({ _id: CUST, name: "Peachmint", legalName: "Peachmint Foods Private Limited" });
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(CUST), companyName: "Peachmint Foods Private Limited", status: "ACTIVE" });
});

async function customerLogin(email: string, names: Record<string, string>) {
  await col("users").insertOne({
    email, passwordHash: await bcrypt.hash(PW, 4), status: "ACTIVE", workspaceId: WS, customerId: String(CUST),
    roles: ["CUSTOMER", "REQUESTER"], accountType: "CUSTOMER", ...names,
  });
  await col("customermembers").insertOne({ customerId: String(CUST), email, role: "REQUESTER", isActive: true, name: "Roster Name" });
  await col("userpermissions").insertOne({ email, status: "active", universe: "CUSTOMER", source: "manual" } as any);
  return request(app).post("/api/auth/login").send({ email, password: PW });
}
const rosterName = async (email: string) => ((await col("customermembers").findOne({ email })) as any)?.name;

describe("login → roster name", () => {
  it("copies first + last, not just the first name", async () => {
    const res = await customerLogin("asha@peachmint.test", { firstName: "Asha", lastName: "Rao" });
    expect(res.status).toBe(200);
    expect(await rosterName("asha@peachmint.test")).toBe("Asha Rao");
  });

  it("a login with no stored name leaves the roster name alone (no email-local-part)", async () => {
    const res = await customerLogin("s.iyer@peachmint.test", {});
    expect(res.status).toBe(200);
    expect(res.body.user?.name).toBe("s.iyer"); // the session still shows something
    expect(await rosterName("s.iyer@peachmint.test")).toBe("Roster Name");
  });
});

describe("ensureAuthUserForCustomer splits a typed full name", () => {
  it("new login: first word → firstName, the rest → lastName, name = both", async () => {
    const out: any = await ensureAuthUserForCustomer({
      email: "meera@peachmint.test", name: "  Meera  K Nair ", customerId: String(CUST), workspaceId: WS, memberRole: "REQUESTER" as any,
    });
    expect(out.created).toBe(true);
    const u: any = await col("users").findOne({ email: "meera@peachmint.test" });
    expect([u.firstName, u.lastName, u.name]).toEqual(["Meera", "K Nair", "Meera K Nair"]);
  });

  it("existing login: only empty fields are filled; a real name is never overwritten", async () => {
    await col("users").insertOne({ email: "ravi@peachmint.test", passwordHash: "x", workspaceId: WS, customerId: String(CUST), firstName: "Ravi", roles: ["CUSTOMER"] });
    await ensureAuthUserForCustomer({ email: "ravi@peachmint.test", name: "Somebody Else", customerId: String(CUST), workspaceId: WS, memberRole: "REQUESTER" as any });
    const u: any = await col("users").findOne({ email: "ravi@peachmint.test" });
    expect([u.firstName, u.lastName, u.name]).toEqual(["Ravi", undefined, undefined]);
  });
});
