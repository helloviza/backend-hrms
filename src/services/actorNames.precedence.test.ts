// apps/backend/src/services/actorNames.precedence.test.ts
//
// Which stored field is a person's name. The profile page (GET /users/profile)
// shows `name`, else firstName — and My Profile edits only `name` — so the
// shared resolver puts `name` first: an account whose firstName is still
// "Test" but whose profile says "Plumtrips Admin" reads "Plumtrips Admin" on
// every screen using the resolver (margins page, approvals / Travel Desk
// activity, booking history, CRM / ticket notes, the login session).
// Exception: a `name` that is only the first name loses to first + last.
//
// Real: services/actorNames, User + TravellerProfile models, in-memory Mongo.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { personName, resolveRealName, userNames, resolveActors } from "./actorNames.js";

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const ADMIN = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("actor-names-precedence-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await col("users").deleteMany({});
  await col("travellerprofiles").deleteMany({});
  await col("users").insertOne({
    _id: ADMIN, email: "admin@plumtrips.com", firstName: "Test", lastName: "", name: "Plumtrips Admin",
    workspaceId: new mongoose.Types.ObjectId("69679a7628330a58d29f2254"),
  } as any);
});

describe("personName — the profile page's name wins", () => {
  it("name over a stale firstName", () => {
    expect(personName({ firstName: "Test", name: "Plumtrips Admin" })).toBe("Plumtrips Admin");
    expect(personName({ firstName: "Test", lastName: "User", name: "Plumtrips Admin" })).toBe("Plumtrips Admin");
  });
  it("a name that is only the first name gives way to first + last", () => {
    expect(personName({ firstName: "Asha", lastName: "Rao", name: "Asha" })).toBe("Asha Rao");
    expect(personName({ firstName: "asha", lastName: "Rao", name: "Asha" })).toBe("asha Rao"); // same name, any case
  });
  it("unchanged where only one source exists, and placeholders never win", () => {
    expect(personName({ firstName: "Asha", lastName: "Rao" })).toBe("Asha Rao");
    expect(personName({ name: "Asha Rao" })).toBe("Asha Rao");
    expect(personName({ firstName: "Asha", lastName: "Rao", name: "Asha Rao" })).toBe("Asha Rao");
    expect(personName({ firstName: "Asha", lastName: "Rao", name: "Workspace User" })).toBe("Asha Rao");
    expect(personName({ firstName: "Workspace User", name: "Asha Rao" })).toBe("Asha Rao");
    expect(personName({ fullName: "Asha Rao" })).toBe("Asha Rao");
    // An account created with name = its email: the email is not a name.
    expect(personName({ firstName: "Asha", lastName: "Rao", name: "asha@acme.test" })).toBe("Asha Rao");
    expect(personName({ name: "asha@acme.test" })).toBe("");
    expect(personName({})).toBe("");
  });
});

describe("every resolver entry point reads the same name", () => {
  it("userNames (margins page, booking history, manual bookings): by id and by email", async () => {
    const m = await userNames([String(ADMIN), "admin@plumtrips.com"]);
    expect(m.get(String(ADMIN))).toBe("Plumtrips Admin");
    expect(m.get("admin@plumtrips.com")).toBe("Plumtrips Admin");
  });

  it("resolveActors (approvals, Travel Desk activity): a stored 'Test' row reads the current name", async () => {
    const rows: any[] = [
      { action: "approved", actorId: String(ADMIN), actorName: "Test" },
      { action: "comment", by: "admin@plumtrips.com", userName: "Test" },
    ];
    await resolveActors(rows);
    expect(rows.map((r) => r.actorName)).toEqual(["Plumtrips Admin", "Plumtrips Admin"]);
    expect(rows[0].actorKind).toBe("staff");
  });

  it("resolveRealName (login session): the profile name, split into first / last", async () => {
    const u = await col("users").findOne({ _id: ADMIN });
    expect(await resolveRealName(u)).toEqual({ firstName: "Plumtrips", lastName: "Admin", name: "Plumtrips Admin", source: "profile" });
    expect(await resolveRealName({ firstName: "Asha", lastName: "Rao", name: "Asha" })).toEqual({
      firstName: "Asha", lastName: "Rao", name: "Asha Rao", source: "profile",
    });
  });

  it("no name on the account: the claimed traveller profile still fills in", async () => {
    await col("users").updateOne({ _id: ADMIN }, { $set: { firstName: "", name: "" } });
    await col("travellerprofiles").insertOne({ claimedBy: ADMIN, firstName: "Plumtrips", lastName: "Admin" } as any);
    expect((await userNames([String(ADMIN)])).get(String(ADMIN))).toBe("Plumtrips Admin");
  });
});
