// apps/backend/src/routes/approvals.dateFilter.test.ts
//
// ?from&to&by on the list endpoints — My Requests, approver inbox (view=all),
// Admin Queue lists, Booking History — against a real database:
//   - IST day boundaries: 23:30 IST on the 5th is the 5th, 00:00 IST on the
//     6th is the 6th (the server converts IST days to UTC)
//   - custom range inclusive of both days
//   - by=travel uses the EARLIEST item travel date; no travel date → excluded
//   - inbox tab counts respect the range
//   - malformed input → 400 on every endpoint
//   - scope unchanged: an OWN agent still sees only their cases, a customer
//     only their company, with a range applied
//
// Rows are raw-inserted so createdAt is exact. Stubbed: requireAuth (user
// from a header), requireWorkspace (workspace from a header), mail, TBO.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: async (req: any, res: any, next: any) => {
    const { default: mg } = await import("mongoose");
    const id = String(req.headers["x-test-ws"] || "");
    const ws = await mg.connection.db!.collection("customerworkspaces").findOne({ _id: new mg.Types.ObjectId(id) });
    if (!ws) return res.status(403).json({ error: "no workspace" });
    req.workspace = ws;
    req.workspaceObjectId = ws._id;
    req.workspaceId = String(ws._id);
    next();
  },
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: async () => ({ messageId: "test" }) }));
vi.mock("../services/tbo.flight.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchFlights: v.fn() };
});
vi.mock("../services/tbo.hotel.search.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchHotels: v.fn() };
});

const { default: approvalsRouter } = await import("./approvals.js");
const { default: bookingHistoryRouter } = await import("./bookingHistory.js");
const { parseDateRange, travelDateOf, DateRangeError, travelDateExpr } = await import("../utils/dateRange.js");

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const WS = oid();
const WS2 = oid();
// Customer ids as in prod (ObjectId hex). A non-hex one hangs Booking History's
// customer branch (pre-existing CastError on workspaceId) — not in scope here.
const C1 = String(oid());
const C2 = String(oid());
const APPROVER = "approver@cust.test";

type Who = { sub: string; email: string; name: string; roles: string[]; ws: any; customerId?: string };
const person = (name: string, roles: string[], ws: any, extra: Partial<Who> = {}): Who => ({
  sub: String(oid()), email: `${name.toLowerCase()}@x.test`, name, roles, ws, ...extra,
});
const REQ = person("Asha", ["EMPLOYEE"], WS);
const APPR: Who = { ...person("Kunal", ["EMPLOYEE"], WS), email: APPROVER };
const OWN = person("Chirag", ["EMPLOYEE"], HOUSE);
const ALL = person("Second", ["EMPLOYEE"], HOUSE);
const CUST = person("Leader", ["CUSTOMER"], WS, { customerId: C1 });

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);
// Booking History resolves the caller's workspace itself; the test hands it over.
app.use("/api/booking-history", async (req: any, _res, next) => {
  const ws = String(req.headers["x-test-ws"] || "");
  if (ws) {
    req.workspaceId = ws;
    req.workspaceObjectId = new mongoose.Types.ObjectId(ws);
  }
  next();
}, bookingHistoryRouter);

const as = (r: request.Test, who: Who) =>
  r
    .set("x-test-user", JSON.stringify({ sub: who.sub, email: who.email, name: who.name, roles: who.roles, customerId: who.customerId }))
    .set("x-test-ws", String(who.ws));

const grant = (who: Who, scope: string) =>
  col("userpermissions").insertOne({
    userId: who.sub, email: who.email, workspaceId: String(HOUSE), universe: "STAFF", status: "active", source: "manual",
    level: { code: "L1", name: "Employee", designation: "" }, modules: { adminQueue: { access: "FULL", scope } },
  } as any);

const flight = (departDate?: string) => ({ type: "flight", meta: { origin: "DEL", destination: "BOM", tripType: "oneway", ...(departDate ? { departDate } : {}) } });
const hotel = (checkIn: string) => ({ type: "hotel", meta: { city: "Goa", checkIn } });

/** One raw request. createdAt is exact; stage/status as given. */
async function row(tag: string, createdAt: string, over: any = {}) {
  const _id = oid();
  await col("approvalrequests").insertOne({
    _id, ticketId: tag, workspaceId: WS, customerId: C1, customerName: "Cust",
    frontlinerId: REQ.sub, frontlinerEmail: REQ.email, frontlinerName: "Asha",
    managerEmail: APPROVER, managerName: "Kunal",
    status: "pending", stage: "REQUEST_RAISED",
    cartItems: [flight("2026-11-20")], history: [], clarifications: [], meta: { travelFlow: "APPROVAL_FLOW", ccLeaders: [] },
    createdAt: new Date(createdAt), updatedAt: new Date(createdAt),
    ...over,
  } as any);
  return tag;
}

const tags = (body: any) => (body.rows as any[]).map((r) => r.ticketId).sort();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-date-filter-test"));
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  for (const [_id, customerId] of [[WS, C1], [WS2, C2]] as const) {
    await col("customerworkspaces").insertOne({
      _id, customerId, name: `WS ${customerId}`, status: "ACTIVE", tenantType: "CORPORATE",
      defaultApproverEmails: [APPROVER], config: { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } },
    } as any);
  }
  await col("customerworkspaces").insertOne({ _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE", config: { features: {} } } as any);
  await grant(OWN, "OWN");
  await grant(ALL, "ALL");
});

describe("parseDateRange", () => {
  it("no from/to → no filter; good input parses; by defaults to submitted", () => {
    expect(parseDateRange({})).toBeNull();
    expect(parseDateRange({ from: "2026-10-01", to: "2026-10-04" })).toEqual({ from: "2026-10-01", to: "2026-10-04", by: "submitted" });
    expect(parseDateRange({ from: "2026-10-01", to: "2026-10-01", by: "travel" })?.by).toBe("travel");
  });

  it("rejects one-sided, malformed, impossible, reversed, over a year, unknown by", () => {
    for (const q of [
      { from: "2026-10-01" },
      { to: "2026-10-01" },
      { from: "01-10-2026", to: "2026-10-04" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "2026-10-05", to: "2026-10-04" },
      { from: "2025-10-01", to: "2026-10-02" },
      { from: "2026-10-01", to: "2026-10-02", by: "updated" },
      { by: "nope" },
    ]) {
      expect(() => parseDateRange(q), JSON.stringify(q)).toThrow(DateRangeError);
    }
    // exactly one year (366 days incl. a leap day) is allowed
    expect(parseDateRange({ from: "2027-03-01", to: "2028-02-29" })).not.toBeNull();
  });
});

describe("submitted date — IST day boundaries", () => {
  it("23:30 IST on the 5th is the 5th; 00:00 IST on the 6th is the 6th; ranges include both ends", async () => {
    await row("D4", "2026-10-04T10:00:00Z");
    await row("D5-2330IST", "2026-10-05T18:00:00Z"); // 23:30 IST, 5 Oct (still 5 Oct in UTC too)
    await row("D6-0000IST", "2026-10-05T18:30:00Z"); // 00:00 IST, 6 Oct (5 Oct in UTC)
    await row("D6-0500IST", "2026-10-05T23:30:00Z"); // 05:00 IST, 6 Oct
    await row("D7", "2026-10-07T10:00:00Z");

    const mine = async (qs: string) => {
      const r = await as(request(app).get(`/api/approvals/requests/mine${qs}`), REQ);
      expect(r.status).toBe(200);
      return tags(r.body);
    };
    expect(await mine("?from=2026-10-05&to=2026-10-05")).toEqual(["D5-2330IST"]);
    expect(await mine("?from=2026-10-06&to=2026-10-06")).toEqual(["D6-0000IST", "D6-0500IST"]);
    expect(await mine("?from=2026-10-04&to=2026-10-06&by=submitted")).toEqual(["D4", "D5-2330IST", "D6-0000IST", "D6-0500IST"]);
    expect(await mine("")).toHaveLength(5);
  });
});

describe("travel date", () => {
  it("uses the earliest item date; a request with no travel date is excluded", async () => {
    await row("EARLY-HOTEL", "2026-10-01T10:00:00Z", { cartItems: [flight("2026-11-20"), hotel("2026-11-12")] });
    await row("FLIGHT-20", "2026-10-01T10:00:00Z", { cartItems: [flight("2026-11-20")] });
    await row("MULTI-LEG", "2026-10-01T10:00:00Z", { cartItems: [{ type: "flight", meta: { tripType: "multicity", legs: [{ origin: "DEL", destination: "BOM", date: "2026-11-13" }] } }] });
    await row("NO-DATE", "2026-10-01T10:00:00Z", { cartItems: [flight()] });

    const r = await as(request(app).get("/api/approvals/requests/mine?from=2026-11-10&to=2026-11-14&by=travel"), REQ);
    expect(r.status).toBe(200);
    expect(tags(r.body)).toEqual(["EARLY-HOTEL", "MULTI-LEG"]);

    const r2 = await as(request(app).get("/api/approvals/requests/mine?from=2026-11-20&to=2026-11-20&by=travel"), REQ);
    expect(tags(r2.body)).toEqual(["FLIGHT-20"]); // EARLY-HOTEL's earliest is the 12th, not the 20th

    // The JS twin agrees with the Mongo expression on every row.
    const docs: any[] = await col("approvalrequests").aggregate([{ $project: { ticketId: 1, cartItems: 1, d: travelDateExpr } }]).toArray();
    for (const d of docs) expect(d.d ?? "", d.ticketId).toBe(travelDateOf(d));
  });
});

describe("inbox tab counts respect the range", () => {
  it("only rows inside the range are returned, in every tab", async () => {
    await row("P-IN", "2026-10-05T06:00:00Z");
    await row("P-OUT", "2026-09-20T06:00:00Z");
    await row("C-IN", "2026-10-05T06:00:00Z", { stage: "REQUEST_NEEDS_CLARIFICATION" });
    await row("A-IN", "2026-10-06T06:00:00Z", { status: "approved", stage: "PROPOSAL_PENDING", approvedByEmail: APPROVER });
    await row("A-OUT", "2026-08-01T06:00:00Z", { status: "approved", stage: "PROPOSAL_PENDING", approvedByEmail: APPROVER });
    await row("X-OUT", "2026-09-01T06:00:00Z", { status: "declined", stage: "REQUEST_DECLINED", approvedByEmail: APPROVER });

    const count = async (qs: string) => {
      const r = await as(request(app).get(`/api/approvals/requests/inbox?view=all${qs}`), APPR);
      expect(r.status).toBe(200);
      const out: Record<string, number> = {};
      for (const x of r.body.rows) out[x._bucket] = (out[x._bucket] || 0) + 1;
      return out;
    };
    expect(await count("")).toEqual({ pending: 2, clarification: 1, approved: 2, declined: 1 });
    expect(await count("&from=2026-10-01&to=2026-10-07")).toEqual({ pending: 1, clarification: 1, approved: 1 });
  });
});

describe("bad dates → 400 on every list endpoint", () => {
  it("My Requests, inbox, Admin Queue lists, Booking History", async () => {
    const bad = "from=2026-13-01&to=2026-13-02";
    const calls: Array<[string, request.Test]> = [
      ["mine", as(request(app).get(`/api/approvals/requests/mine?${bad}`), REQ)],
      ["inbox", as(request(app).get(`/api/approvals/requests/inbox?view=all&${bad}`), APPR)],
      ["admin pending", as(request(app).get(`/api/approvals/admin/pending?${bad}`), ALL)],
      ["admin approved", as(request(app).get(`/api/approvals/admin/approved?${bad}`), ALL)],
      ["admin done", as(request(app).get(`/api/approvals/admin/done?${bad}`), ALL)],
      ["admin rejected", as(request(app).get(`/api/approvals/admin/rejected?${bad}`), ALL)],
      ["booking history", as(request(app).get(`/api/booking-history/history?${bad}`), CUST)],
      ["booking history admin", as(request(app).get(`/api/booking-history/admin/history?${bad}`), ALL)],
    ];
    for (const [label, call] of calls) {
      const r = await call;
      expect([label, r.status, r.body.code]).toEqual([label, 400, "BAD_DATE_RANGE"]);
    }
  });
});

describe("scope is unchanged with a date filter", () => {
  it("an OWN agent sees only their own case in range; ALL sees every case in range", async () => {
    const approved = { status: "approved", stage: "PROPOSAL_PENDING", adminState: "pending", approvedByEmail: APPROVER };
    await row("MINE-IN", "2026-10-05T06:00:00Z", { ...approved, meta: { travelFlow: "APPROVAL_FLOW", adminAssigned: { userId: OWN.sub } } });
    await row("MINE-OUT", "2026-09-05T06:00:00Z", { ...approved, meta: { travelFlow: "APPROVAL_FLOW", adminAssigned: { userId: OWN.sub } } });
    await row("OTHER-IN", "2026-10-05T06:00:00Z", { ...approved, meta: { travelFlow: "APPROVAL_FLOW", adminAssigned: { userId: ALL.sub } } });

    const q = "?from=2026-10-01&to=2026-10-07";
    for (const path of ["/api/approvals/admin/approved", "/api/approvals/admin/pending"]) {
      const own = await as(request(app).get(path + q), OWN);
      expect([path, own.status, tags(own.body)]).toEqual([path, 200, ["MINE-IN"]]);
      const all = await as(request(app).get(path + q), ALL);
      expect([path, tags(all.body)]).toEqual([path, ["MINE-IN", "OTHER-IN"]]);
    }
  });

  it("Booking History: a customer sees only their company's rows in range; the OWN agent only their own", async () => {
    const done = { status: "approved", stage: "BOOKING_DONE", adminState: "done" };
    await row("C1-IN", "2026-10-05T06:00:00Z", { ...done, meta: { adminAssigned: { userId: OWN.sub } } });
    await row("C1-OUT", "2026-08-05T06:00:00Z", { ...done });
    await row("C2-IN", "2026-10-05T06:00:00Z", {
      ...done, workspaceId: WS2, customerId: C2, frontlinerEmail: "someone@other.test", frontlinerId: "x", meta: { adminAssigned: { userId: ALL.sub } },
    });

    // CUST is this company's Workspace Leader: Booking History shows the
    // company's bookings (a plain requester sees only their own).
    await col("customermembers").insertOne({ email: CUST.email, customerId: C1, role: "WORKSPACE_LEADER", isActive: true } as any);

    const q = "?from=2026-10-01&to=2026-10-07";
    const cust = await as(request(app).get(`/api/booking-history/history${q}`), CUST);
    expect([cust.status, tags(cust.body)]).toEqual([200, ["C1-IN"]]);
    const own = await as(request(app).get(`/api/booking-history/admin/history${q}`), OWN);
    expect([own.status, tags(own.body)]).toEqual([200, ["C1-IN"]]);
    const all = await as(request(app).get(`/api/booking-history/admin/history${q}`), ALL);
    expect(tags(all.body)).toEqual(["C1-IN", "C2-IN"]);
    // No range: the customer still never sees the other company.
    const custAll = await as(request(app).get("/api/booking-history/history"), CUST);
    expect(tags(custAll.body)).toEqual(["C1-IN", "C1-OUT"]);
  });
});
