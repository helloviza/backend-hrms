// PHASE 2 PILOT — the location service's first real consumer.
//
// What this pins is the WIRING, not the resolver (location.service.test.ts
// already covers classification, confidence and the strict city lookup): that
// POST /api/admin/manual-bookings stamps bookedFromCity onto the row, that it
// upserts the actor's ActorLocation alongside, and — the one that actually
// matters in production — that NONE of it can cost us a booking.
//
// The IP comes through Express's real trust-proxy machinery (X-Forwarded-For
// with `trust proxy` set on the test app), not by poking req.ip, because that
// chain IS the thing Phase 1's header block warns about. Poking req.ip
// directly would test a fiction.
//
// ManualBooking / ActorLocation are backed by small in-memory stores with real
// semantics — the house convention for this feature area (see
// location.service.test.ts). That convention is a choice, not a constraint:
// mongodb-memory-server does start here (see
// utils/visaPredicatePersistence.test.ts), so real persistence is available
// if this test ever needs schema defaults or casting to be real.
// The location service itself is NOT mocked away: tests 1 and 2
// run the real resolver end to end. Only test 3 swaps in a throw, because the
// service's contract is that it never throws, so the route's last-resort catch
// has no other way to be exercised.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

const { bookingStore, locationStore, geo } = vi.hoisted(() => {
  const bookings: any[] = [];
  const locations = new Map<string, any>();
  const key = (f: any) => `${f.actorId}|${f.actorType}|${f.workspaceId ?? "null"}`;
  return {
    bookingStore: {
      created: bookings,
      last: () => bookings[bookings.length - 1],
      clear: () => bookings.splice(0, bookings.length),
    },
    locationStore: {
      // Real upsert-on-unique-key semantics: same actor overwrites, never appends.
      upsert(filter: any, facts: any) {
        const k = key(filter);
        locations.set(k, { ...(locations.get(k) ?? filter), ...facts });
      },
      all: () => Array.from(locations.values()),
      clear: () => locations.clear(),
    },
    // Flipped by the failure test only; every other test runs the real service.
    geo: { throwOnResolve: false },
  };
});

vi.mock("../models/ManualBooking.js", () => ({
  default: {
    create: async (doc: any) => {
      bookingStore.created.push(doc);
      return doc;
    },
  },
}));

vi.mock("../models/ActorLocation.js", () => ({
  default: {},
  upsertCurrentLocation: async (actor: any, facts: any, ipHash: string | null) => {
    locationStore.upsert(
      { actorId: String(actor.actorId), actorType: actor.actorType, workspaceId: actor.workspaceId },
      { ...facts, ipHash },
    );
    return true;
  },
}));

vi.mock("../services/location.service.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    resolveActorFromRequest: async (req: any) => {
      if (geo.throwOnResolve) throw new Error("geo subsystem exploded");
      return actual.resolveActorFromRequest(req);
    },
  };
});

import express from "express";
import request from "supertest";
import router from "./manualBookings.js";
import { isGeoipDatabasePresent } from "../services/geoipProvision.js";
import { __resetLocationServiceState } from "../services/location.service.js";

const CALLER_ID = "507f1f77bcf86cd799439011";
const WORKSPACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

const app = express();
app.use(express.json());
// EXACTLY what server.ts sets. Without it Express ignores X-Forwarded-For and
// req.ip is the loopback socket address — which is also precisely how a
// misconfigured deploy would behave, so the setting has to be real here.
app.set("trust proxy", 1);
app.use((req: any, _res, next) => {
  req.user = { _id: CALLER_ID, sub: CALLER_ID, email: "ops@plumtrips.com", accountType: "EMPLOYEE" };
  req.workspaceObjectId = WORKSPACE_ID;
  req.permissionScope = "ALL";
  next();
});
app.use("/", router);

// Minimum that clears validateBookingRequired().
const validBooking = {
  workspaceId: WORKSPACE_ID,
  type: "FLIGHT",
  supplierName: "Test Supplier",
  givenBy: "Ops Desk",
  travelDate: "2026-09-01",
};

// 49.36.0.0/14 is Reliance Jio, allocated to India — a real, routable, public
// address, so the resolver takes the genuine geo path rather than a special case.
const PUBLIC_CLIENT_IP = "49.36.1.1";

function createBooking(clientIp?: string) {
  const req = request(app).post("/").send(validBooking);
  return clientIp ? req.set("X-Forwarded-For", clientIp) : req;
}

beforeEach(() => {
  bookingStore.clear();
  locationStore.clear();
  __resetLocationServiceState();
  geo.throwOnResolve = false;
});

describe("POST / — bookedFromCity stamping", () => {
  it("stamps a resolution and upserts the actor's current location", async () => {
    const res = await createBooking(PUBLIC_CLIENT_IP);
    expect(res.status).toBe(201);

    const stamp = bookingStore.last().bookedFromCity;
    expect(stamp).toBeTruthy();
    expect(stamp.resolvedAt).toBeInstanceOf(Date);
    expect(typeof stamp.reason).toBe("string");
    expect(stamp.reason).not.toBe("");
    // Never a raw uncanonicalised name in the canonical field: city is either
    // a lookup hit or an honest null with rawCity carrying the original.
    expect(stamp.city === null || typeof stamp.city === "string").toBe(true);

    // The same resolution reached ActorLocation — one row, this actor.
    const rows = locationStore.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: CALLER_ID, actorType: "EMPLOYEE", source: stamp.source });
    // Importing the router pulls in config/env.js, which loads .env — so
    // LOCATION_IP_HASH_SALT may or may not be set depending on the machine.
    // Both outcomes are correct and BOTH are asserted, because the invariant
    // is not "there is a hash", it is "there is never a raw address": with a
    // salt, a salted HMAC; without one, null rather than a weaker digest.
    expect(rows[0].ipHash === null || /^[0-9a-f]{64}$/.test(rows[0].ipHash)).toBe(true);
    expect(JSON.stringify(rows[0])).not.toContain(PUBLIC_CLIENT_IP);
  });

  it("resolves a real city with a usable confidence from a public IP", async () => {
    // Gated: the geo database is a 70 MB non-redistributable download, so CI
    // legitimately runs without one. When it is absent the route still stamps —
    // that is the `unresolved` path, covered by the failure test below.
    if (!isGeoipDatabasePresent()) return;

    const res = await createBooking(PUBLIC_CLIENT_IP);
    expect(res.status).toBe(201);

    const stamp = bookingStore.last().bookedFromCity;
    expect(stamp.source).toBe("ip");
    expect(stamp.confidence).toBeGreaterThan(0);
    expect(stamp.confidence).toBeLessThanOrEqual(1);
    // A canonical city OR an honest null with the raw name kept — the second is
    // a gap in destinationLookup's ~150-key table, NOT a resolution failure,
    // and rawCity is what keeps that distinction measurable.
    if (stamp.city !== null) {
      expect(stamp.reason).toBe("ok");
    } else {
      expect(stamp.reason).toBe("city_not_in_lookup");
      expect(stamp.rawCity).toBeTruthy();
    }
  });

  it("stamps private-ip — not a city, not a miss — for a loopback client", async () => {
    // No X-Forwarded-For, so req.ip is the loopback socket. 62 of 400
    // production rows look like this (local dev against the prod database);
    // they must never be counted against resolution coverage.
    const res = await createBooking();
    expect(res.status).toBe(201);

    const stamp = bookingStore.last().bookedFromCity;
    expect(stamp.source).toBe("private-ip");
    expect(stamp.city).toBeNull();
    expect(stamp.rawCity).toBeNull();
    expect(stamp.confidence).toBe(0);
    expect(stamp.reason).toBe("loopback");
  });

  it("creates the booking anyway when the resolver throws", async () => {
    geo.throwOnResolve = true;

    const res = await createBooking(PUBLIC_CLIENT_IP);
    // THE POINT OF THE WHOLE EXERCISE: geo is an observability nicety and it
    // must never be the reason a booking fails.
    expect(res.status).toBe(201);
    expect(bookingStore.created).toHaveLength(1);

    const stamp = bookingStore.last().bookedFromCity;
    expect(stamp.source).toBe("unresolved");
    expect(stamp.city).toBeNull();
    expect(stamp.confidence).toBe(0);
    // A distinct reason from "the database had nothing" — different fix.
    expect(stamp.reason).toBe("resolver_error");
  });

  it("ignores a client-supplied bookedFromCity", async () => {
    // The route spreads req.body; the stamp is applied after it. Anyone could
    // otherwise pin their booking's origin to any city on earth.
    const res = await request(app)
      .post("/")
      .set("X-Forwarded-For", PUBLIC_CLIENT_IP)
      .send({
        ...validBooking,
        bookedFromCity: { city: "Paris", rawCity: "Paris", source: "ip", confidence: 1, reason: "ok" },
      });

    expect(res.status).toBe(201);
    expect(bookingStore.last().bookedFromCity.city).not.toBe("Paris");
  });
});
