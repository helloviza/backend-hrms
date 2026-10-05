// apps/backend/src/routes/auth.realNames.test.ts
//
// The login session's display name (header greeting, chat "Hi …!") is the
// user's real name, resolved like Slice 4: profile first/last → claimed
// traveller profile → email local part — never the "Workspace User"
// placeholder. Runs the real auth router (refresh + /me) on in-memory Mongo.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.NODE_ENV = "test";
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  JWT_SECRET: "jwt-secret-for-tests",
  JWT_REFRESH_SECRET: "refresh-secret-for-tests",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
})) process.env[k] ||= v;

const { default: authRouter } = await import("./auth.js");
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const WS = oid();
const CUSTOMER = oid();

const U = {
  asha: oid(), // placeholder; claimed traveller profile "Asha Rao"
  ravi: oid(), // placeholder firstName, real `name`
  noname: oid(), // placeholder, nothing better → email local part
  meera: oid(), // real first/last
  staff: oid(), // HOUSE staff with a placeholder name and a claimed profile
};

async function session(id: mongoose.Types.ObjectId) {
  const refresh = jwt.sign({ sub: String(id) }, process.env.JWT_REFRESH_SECRET!, { expiresIn: "1h" });
  const res = await request(app).post("/api/auth/refresh").set("Cookie", [`refreshToken=${refresh}`]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("auth-real-names-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await col("customers").insertOne({ _id: CUSTOMER, name: "Peachmint Advisors", legalName: "Peachmint Advisors" } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(CUSTOMER), name: "Peachmint Advisors", status: "ACTIVE" } as any);
  const customer = { roles: ["CUSTOMER"], workspaceId: WS, customerId: String(CUSTOMER), status: "ACTIVE", passwordHash: "x" };
  await col("users").insertMany([
    { _id: U.asha, email: "asha.rao@peachmint.test", firstName: "Workspace User", lastName: "", ...customer },
    { _id: U.ravi, email: "ravi@peachmint.test", firstName: "Workspace User", name: "Ravi Kumar", ...customer },
    { _id: U.noname, email: "s.iyer@peachmint.test", firstName: "Workspace User", ...customer },
    { _id: U.meera, email: "meera@peachmint.test", firstName: "Meera", lastName: "Iyer", name: "Workspace User", ...customer },
    {
      _id: U.staff, email: "neel@plumtrips.com", firstName: "Workspace User", roles: ["ADMIN"], status: "ACTIVE", passwordHash: "x",
      workspaceId: new mongoose.Types.ObjectId("69679a7628330a58d29f2254"),
    },
  ] as any[]);
  await col("travellerprofiles").insertMany([
    { workspaceId: WS, travelerId: "PEA-001", firstName: "Asha", lastName: "Rao", claimedBy: U.asha },
    { workspaceId: WS, travelerId: "PLU-001", firstName: "Neel", lastName: "Bhatia", claimedBy: U.staff },
  ] as any[]);
});

describe("session display name", () => {
  it("never 'Workspace User': claimed traveller profile → profile name → email local part", async () => {
    const cases: Array<[mongoose.Types.ObjectId, string, string]> = [
      [U.asha, "Asha Rao", "Asha"],
      [U.ravi, "Ravi Kumar", "Ravi"],
      [U.noname, "s.iyer", "s.iyer"],
      [U.meera, "Meera Iyer", "Meera"],
      [U.staff, "Neel Bhatia", "Neel"],
    ];
    for (const [id, name, first] of cases) {
      const body = await session(id);
      expect([body.user.name, body.user.firstName], name).toEqual([name, first]);
      expect(JSON.stringify(body.user)).not.toContain("Workspace User");
    }
  });

  it("/me returns the same name, and nothing is written to the account", async () => {
    const { accessToken } = await session(U.asha);
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    const user = me.body.user || me.body;
    expect([user.name, user.firstName, user.lastName]).toEqual(["Asha Rao", "Asha", "Rao"]);
    const stored: any = await col("users").findOne({ _id: U.asha });
    expect(stored.firstName).toBe("Workspace User");
  });
});
