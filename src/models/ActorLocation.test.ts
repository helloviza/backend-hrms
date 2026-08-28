// Coverage for the ActorLocation schema and its upsert helper.
//
// ActorLocation is the real Model object with `updateOne` spied — the same
// approach as models/VisaRequest.test.ts, and no DB connection is needed for
// either. The schema assertions matter as much as the helper: the unique
// compound index is the ONLY thing that makes upsertCurrentLocation an
// overwrite rather than an append, and the TTL index is the only thing that
// stops inferred location outliving its own accuracy.

import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

import ActorLocation, {
  upsertCurrentLocation,
  actorLocationExpiryFor,
  ACTOR_LOCATION_TTL_DAYS,
  type ActorLocationFacts,
} from "./ActorLocation.js";

const schema = ActorLocation.schema;

const facts: ActorLocationFacts = {
  city: "Bengaluru",
  rawCity: "Bengaluru",
  region: "Karnataka",
  country: "IN",
  source: "ip",
  confidence: 0.9,
  accuracyRadiusKm: 10,
};

describe("schema", () => {
  it("keys one row per actor per workspace, uniquely", () => {
    const idx = schema.indexes().find(([fields]: any) => fields.actorId && fields.actorType && "workspaceId" in fields);
    expect(idx).toBeTruthy();
    expect(idx![1].unique).toBe(true);
  });

  it("expires rows via a TTL index on expiresAt", () => {
    const idx = schema.indexes().find(([fields]: any) => "expiresAt" in fields);
    expect(idx).toBeTruthy();
    expect(idx![1].expireAfterSeconds).toBe(0);
  });

  it("allows a null workspaceId", () => {
    // Internal staff and HOUSE-tenant actors have no CustomerWorkspace. This
    // is why workspaceScopePlugin (which declares workspaceId required) is
    // deliberately NOT applied to this model.
    expect(schema.path("workspaceId").isRequired).toBeFalsy();
    expect(new ActorLocation({}).workspaceId).toBeNull();
  });

  it("has no field capable of holding a raw IP", () => {
    const paths = Object.keys(schema.paths);
    expect(paths).toContain("ipHash");
    expect(paths.filter((p) => /(^|[^a-z])ip($|[^a-z])/i.test(p))).toEqual([]);
  });

  it("constrains actorType and source to the known sets", () => {
    /* CONSUMER added when the helloviza.ai D2C population was wired in — it
     * is a SEPARATE identity namespace from `users`, so it needs its own
     * discriminator rather than being folded into CUSTOMER (see the type's
     * own note in ActorLocation.ts). This assertion is an exact-set guard on
     * purpose: extending it should be a deliberate edit, which is what this
     * line is. */
    expect((schema.path("actorType") as any).enumValues).toEqual([
      "EMPLOYEE",
      "CUSTOMER",
      "VENDOR",
      "CONSUMER",
    ]);
    expect((schema.path("source") as any).enumValues).toEqual([
      "ip",
      "private-ip",
      "unresolved",
      "unavailable-non-http",
    ]);
  });

  it("rejects an unknown source at validation time", () => {
    const bad = new ActorLocation({
      actorId: new mongoose.Types.ObjectId(),
      actorType: "CUSTOMER",
      source: "gps",
      expiresAt: new Date(),
    });
    expect(bad.validateSync()?.errors?.source).toBeTruthy();
  });
});

describe("actorLocationExpiryFor", () => {
  it("is TTL days out from the given instant", () => {
    const now = Date.UTC(2026, 0, 1);
    const expiry = actorLocationExpiryFor(now);
    expect(expiry.getTime() - now).toBe(ACTOR_LOCATION_TTL_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe("upsertCurrentLocation", () => {
  let updateOne: any;

  beforeEach(() => {
    updateOne = vi.spyOn(ActorLocation, "updateOne").mockResolvedValue({} as any);
  });

  it("upserts on the unique key so the row is overwritten, not appended", async () => {
    const actorId = new mongoose.Types.ObjectId();
    const workspaceId = new mongoose.Types.ObjectId();

    const ok = await upsertCurrentLocation({ actorId, actorType: "CUSTOMER", workspaceId }, facts, "a".repeat(64));
    expect(ok).toBe(true);

    const [filter, update, opts] = updateOne.mock.calls[0];
    expect(filter).toEqual({ actorId, actorType: "CUSTOMER", workspaceId });
    expect(opts).toEqual({ upsert: true });
    expect(update.$set).toMatchObject({ ...facts, ipHash: "a".repeat(64) });
    expect(update.$set.expiresAt).toBeInstanceOf(Date);
    // No $push, no $addToSet — this collection is a position, not a history.
    expect(Object.keys(update)).toEqual(["$set"]);
  });

  it("casts string ids so a token-derived id and an ObjectId hit the same row", async () => {
    const actorId = new mongoose.Types.ObjectId();
    await upsertCurrentLocation({ actorId: String(actorId), actorType: "EMPLOYEE", workspaceId: null }, facts, null);
    const [filter] = updateOne.mock.calls[0];
    expect(filter.actorId).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(filter.actorId)).toBe(String(actorId));
    expect(filter.workspaceId).toBeNull();
  });

  it("writes a null ipHash rather than inventing one", async () => {
    await upsertCurrentLocation(
      { actorId: new mongoose.Types.ObjectId(), actorType: "VENDOR", workspaceId: null },
      facts,
      null,
    );
    expect(updateOne.mock.calls[0][1].$set.ipHash).toBeNull();
  });

  it("refuses an unusable actorId without writing anything", async () => {
    expect(await upsertCurrentLocation({ actorId: "not-an-id", actorType: "CUSTOMER", workspaceId: null }, facts, null)).toBe(false);
    expect(await upsertCurrentLocation({ actorId: "", actorType: "CUSTOMER", workspaceId: null }, facts, null)).toBe(false);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("returns false instead of throwing when the write fails", async () => {
    // Recording where someone appears to be must never fail a booking.
    updateOne.mockRejectedValueOnce(new Error("replica set unavailable"));
    const ok = await upsertCurrentLocation(
      { actorId: new mongoose.Types.ObjectId(), actorType: "CUSTOMER", workspaceId: null },
      facts,
      null,
    );
    expect(ok).toBe(false);
  });
});
