// Locked traveller fields are refused on a real CHANGE, not on presence
// (2026-10-02). A requester's My Profile set-up sent the company fields it
// renders (designationId / costCenterId / workLocation) as "", and the create
// was refused with "You cannot set designationId, costCenterId, workLocation
// on a profile" — which, since approval requests need a complete own profile,
// also blocked requesters from raising requests.
//
// Real database (mongodb-memory-server), real router; only auth/workspace
// middleware are stubbed (user, workspace and member come from the harness).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import travellerRouter from "./workspace.travellers.js";
import { loadSelfTraveller } from "../services/approvalTravellers.js";

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = new mongoose.Types.ObjectId();
const CUSTOMER_ID = String(new mongoose.Types.ObjectId());
const REQUESTER = { _id: new mongoose.Types.ObjectId(), email: "requestor@acme.test" };
const LEADER = { _id: new mongoose.Types.ObjectId(), email: "leader@acme.test" };
const DESIGNATION = new mongoose.Types.ObjectId();

function appAs(user: { _id: mongoose.Types.ObjectId; email: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(user._id), sub: String(user._id), email: user.email, roles: ["CUSTOMER"] };
    req.workspaceObjectId = WS;
    req.workspace = { _id: WS, customerId: CUSTOMER_ID };
    next();
  });
  app.use(travellerRouter);
  return app;
}

/** What MyProfileTab's "self" preset sends at set-up, before this fix. */
const selfSetupBody = (extra: Record<string, any> = {}) => ({
  title: "", firstName: "Riya", middleName: "", lastName: "Requester",
  gender: "Female", dob: "1990-04-02", nationality: "IN",
  passportNo: "Z9876543", passportExpiry: "2031-01-01", passportIssueCountry: "IN", passportIssueDate: "",
  mobile: "9800000000", mobileCountryCode: "+91", email: "",
  designationId: "", costCenterId: "", workLocation: "",
  personalEmail: "", taxResidency: "", seatPreference: "", homeAirport: "", mealPreference: "",
  frequentFlyer: [], emergencyContacts: [], loyaltyProgrammes: [], hotelPreferences: [],
  ...extra,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("travellers-locked-fields-test"));
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await col("customermembers").insertMany([
    { customerId: CUSTOMER_ID, email: REQUESTER.email, role: "REQUESTER", isActive: true },
    { customerId: CUSTOMER_ID, email: LEADER.email, role: "WORKSPACE_LEADER", isActive: true },
  ] as any[]);
  await col("designations").insertOne({ _id: DESIGNATION, workspaceId: WS, name: "Engineer", isActive: true } as any);
});

async function requesterProfile(extra: Record<string, any> = {}) {
  const r = await request(appAs(REQUESTER)).post("/").send(selfSetupBody());
  expect(r.status).toBe(201);
  const id = r.body.traveller?._id || r.body.traveller?.id;
  if (Object.keys(extra).length) {
    await col("travellerprofiles").updateOne({ _id: new mongoose.Types.ObjectId(String(id)) }, { $set: extra });
  }
  return String(id);
}

describe("requester sets up their own profile (POST /)", () => {
  it("blank locked company fields are not a change → 201, nothing set", async () => {
    const r = await request(appAs(REQUESTER)).post("/").send(selfSetupBody());
    expect(r.status).toBe(201);
    const doc: any = await col("travellerprofiles").findOne({ firstName: "Riya" });
    expect(String(doc.claimedBy)).toBe(String(REQUESTER._id));
    expect(doc.designationId ?? null).toBeNull();
    expect(doc.costCenterId).toBeUndefined();
    expect(doc.workLocation).toBeUndefined();
  });

  it("a non-empty locked field is still refused", async () => {
    const r = await request(appAs(REQUESTER)).post("/").send(selfSetupBody({ costCenterId: "CC-1" }));
    expect(r.status).toBe(403);
    expect(r.body.fields).toEqual(["costCenterId"]);
    expect(await col("travellerprofiles").countDocuments()).toBe(0);
  });
});

describe("requester edits their own profile (PUT /:id)", () => {
  it("sending the stored locked values back unchanged → 200, values kept", async () => {
    const id = await requesterProfile({ costCenterId: "CC-9", workLocation: "Pune", designationId: DESIGNATION });
    const r = await request(appAs(REQUESTER)).put(`/${id}`).send({
      mobile: "9811111111",
      costCenterId: "CC-9", workLocation: " Pune ", designationId: String(DESIGNATION),
      firstName: "Riya", lastName: "Requester",
    });
    expect(r.status).toBe(200);
    const doc: any = await col("travellerprofiles").findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(doc).toMatchObject({ mobile: "9811111111", costCenterId: "CC-9", workLocation: "Pune" });
    expect(String(doc.designationId)).toBe(String(DESIGNATION));
  });

  it("blank locked fields over empty stored values → 200", async () => {
    const id = await requesterProfile();
    const r = await request(appAs(REQUESTER)).put(`/${id}`).send({ gender: "Female", designationId: "", costCenterId: null, workLocation: "" });
    expect(r.status).toBe(200);
  });

  it("changing a locked field is refused and nothing is saved", async () => {
    const id = await requesterProfile({ workLocation: "Pune" });
    const r = await request(appAs(REQUESTER)).put(`/${id}`).send({ mobile: "9822222222", workLocation: "Delhi" });
    expect(r.status).toBe(403);
    expect(r.body.fields).toEqual(["workLocation"]);
    const doc: any = await col("travellerprofiles").findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(doc).toMatchObject({ mobile: "9800000000", workLocation: "Pune" });
  });

  it("clearing a set locked field is a change too", async () => {
    const id = await requesterProfile({ costCenterId: "CC-9" });
    const r = await request(appAs(REQUESTER)).put(`/${id}`).send({ costCenterId: "" });
    expect(r.status).toBe(403);
  });
});

describe("Workspace Leader", () => {
  it("can set and change the company fields", async () => {
    const id = await requesterProfile({ workLocation: "Pune" });
    const r = await request(appAs(LEADER)).put(`/${id}`).send({
      designationId: String(DESIGNATION), costCenterId: "CC-7", workLocation: "Delhi",
    });
    expect(r.status).toBe(200);
    const doc: any = await col("travellerprofiles").findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(doc).toMatchObject({ costCenterId: "CC-7", workLocation: "Delhi" });
    expect(String(doc.designationId)).toBe(String(DESIGNATION));
  });
});

describe("approval request 'You' card", () => {
  it("picks up the profile the requester just saved", async () => {
    const id = await requesterProfile();
    await request(appAs(REQUESTER)).put(`/${id}`).send({ passportExpiry: "2032-02-02" }).expect(200);
    const self = await loadSelfTraveller(WS, String(REQUESTER._id));
    expect(self.status).toBe("ok");
    expect(self.traveller).toMatchObject({
      kind: "self", firstName: "Riya", lastName: "Requester", dob: "1990-04-02",
      passportNumber: "Z9876543", passportExpiry: "2032-02-02", nationality: "IN",
    });
    expect(self.missing).toEqual([]);
    expect(self.missingInternational).toEqual([]);
  });
});
