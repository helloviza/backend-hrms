// apps/backend/src/routes/approvals.serviceForms.test.ts
//
// POST / PUT /api/approvals/requests hold every cart item to the request
// form's per-service rules (services/approvalItemRules.ts), so a client that
// skips the form is refused the same way:
//   - required fields per service; dates not in the past and in order
//   - Domestic / International per item (a domestic flight + an international
//     visa on one request is fine; only the visa needs passports)
//   - forex: one traveller + PAN; eSIM: phone or email; holiday / MICE: a
//     lead contact + head count, no traveller list
//   - head counts are the server's, from the traveller list
//   - PAN: last 4 for the requester, restored from the stored request on edit
//   - GET /request-context: company name + approver name, never an email or id
//   - nothing customer-facing carries a price
//
// Real: approvals router, guards, models, in-memory Mongo. Stubbed: requireAuth
// (user from a header), requireWorkspace (workspace from a header), mail, TBO.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { addDays, todayIST, validateItem } from "../services/approvalItemRules.js";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

const sent: Array<{ to: string; subject: string; html: string }> = [];

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", () => ({
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
  resolveWorkspaceForUser: async () => null,
}));
vi.mock("../utils/mailer.js", () => ({
  sendMail: async (m: any) => {
    sent.push({ to: String(m.to), subject: String(m.subject), html: String(m.html || "") });
    return { messageId: "test" };
  },
}));
vi.mock("../services/tbo.flight.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchFlights: v.fn() };
});
vi.mock("../services/tbo.hotel.search.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchHotels: v.fn() };
});
vi.mock("../utils/emailActionToken.js", () => ({
  signEmailActionToken: () => "tok",
  verifyEmailActionToken: () => null,
  hashToken: () => "hash",
}));

const { default: approvalsRouter } = await import("./approvals.js");

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const WS = oid();
const APPROVER = "approver@acme.test";
type Who = { sub: string; email: string; roles?: string[] };
const REQUESTER: Who = { sub: String(oid()), email: "requester@acme.test" };

const as = (r: request.Test, who: Who = REQUESTER) =>
  r
    .set("x-test-user", JSON.stringify({ sub: who.sub, email: who.email, name: "Riya", roles: who.roles || ["EMPLOYEE"] }))
    .set("x-test-ws", String(WS));

const D = (n: number) => addDays(todayIST(), n);
const SELF = { kind: "self", firstName: "x", lastName: "y" };
const ASHA = { kind: "manual", travellerId: "m-0123456789abcdef", firstName: "Asha", lastName: "Guest", dob: "1988-01-01", nationality: "Indian", passportNumber: "K1234567", passportExpiry: "2034-05-05" };
const CHILD = { kind: "manual", firstName: "Kabir", lastName: "Guest", dob: addDays(todayIST(), -365 * 6) };

const VALID: Record<string, any> = {
  flight: { type: "flight", meta: { tripType: "oneway", origin: "BLR", destination: "DEL", departDate: D(20), travelScope: "domestic", travellers: [SELF] } },
  hotel: { type: "hotel", meta: { city: "Mumbai", checkIn: D(20), checkOut: D(22), rooms: "1", travelScope: "domestic", travellers: [SELF] } },
  visa: { type: "visa", meta: { destinationCountryCode: "AE", visaType: "eVisa", purpose: "Business", travelDate: D(30), travellers: [SELF] } },
  cab: { type: "cab", meta: { city: "Mumbai", tripType: "oneway", pickup: "T2", drop: "BKC", pickupDate: D(20), pickupTime: "10:30", travellers: [SELF] } },
  forex: { type: "forex", meta: { currency: "USD", amount: "500", deliveryMode: "Cash", city: "Delhi", requiredBy: D(10), pan: "ABCDE1234F", travellers: [SELF] } },
  esim: { type: "esim", meta: { countryCode: "AE", startDate: D(30), days: "7", dataPack: "5 GB", travellers: [SELF] } },
  holiday: { type: "holiday", meta: { destination: "Bali", startDate: D(40), days: "5", people: "4", leadName: "Riya", leadPhone: "+91 98000 00000", inclusions: ["Hotel", "Breakfast"] } },
  mice: { type: "mice", meta: { mode: "Offsite", location: "Goa", startDate: D(50), endDate: D(52), attendees: "40", leadName: "Riya", leadEmail: "riya@acme.test", addOns: ["AV setup"] } },
};
const item = (svc: string, patch: Record<string, any> = {}) => ({ ...VALID[svc], meta: { ...VALID[svc].meta, ...patch } });
const post = (cartItems: any[]) => as(request(app).post("/api/approvals/requests")).send({ cartItems, comments: "Client visit" });
const stored = async (id: any) => (await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(id)) })) as any;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-service-forms-test"));
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertOne({
    _id: WS, customerId: "ACME", name: "Acme Industries", status: "ACTIVE", tenantType: "CORPORATE",
    defaultApproverEmails: [APPROVER],
    config: { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } },
  } as any);
  await col("users").insertOne({ email: APPROVER, name: "Manoj Approver", roles: ["EMPLOYEE"] } as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  sent.length = 0;
  await col("approvalrequests").deleteMany({});
  await col("travellerprofiles").deleteMany({});
  await col("travellerprofiles").insertOne({
    workspaceId: WS, travelerId: "T-1", claimedBy: new mongoose.Types.ObjectId(REQUESTER.sub),
    firstName: "Riya", lastName: "Profile", dob: "1990-04-02", nationality: "Indian",
    passportNo: "Z9876543", passportExpiry: "2033-01-01", email: REQUESTER.email, mobile: "9800000000",
    isActive: true, source: "MANUAL", createdBy: new mongoose.Types.ObjectId(REQUESTER.sub),
  } as any);
});

describe("every service: a complete item is accepted, a missing required field is refused", () => {
  const REQUIRED: Record<string, string[]> = {
    flight: ["origin", "destination", "departDate"],
    hotel: ["city", "checkIn", "checkOut", "rooms"],
    visa: ["destinationCountryCode", "visaType", "purpose", "travelDate"],
    cab: ["city", "pickup", "drop", "pickupDate", "pickupTime"],
    forex: ["currency", "amount", "deliveryMode", "city", "requiredBy", "pan"],
    esim: ["countryCode", "startDate", "days", "dataPack"],
    holiday: ["destination", "startDate", "days", "people", "leadName"],
    mice: ["mode", "location", "startDate", "endDate", "attendees", "leadName"],
  };

  it("all 8 valid items in one request are stored", async () => {
    const r = await post(Object.keys(VALID).map((k) => item(k)));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await stored(r.body.request._id)).cartItems).toHaveLength(8);
  });

  for (const [svc, fields] of Object.entries(REQUIRED)) {
    it(`${svc}: ${fields.join(", ")} are required`, async () => {
      for (const f of fields) {
        const r = await post([item(svc, { [f]: "" })]);
        expect([r.status, r.body.field], `${svc}.${f}`).toEqual([400, f]);
        expect(r.body.itemIndex).toBe(0);
      }
    });
  }

  it("cab: hourly needs hours (1–24), not a drop; round trip needs a return date", async () => {
    expect((await post([item("cab", { tripType: "hourly", drop: "" })])).body.field).toBe("hours");
    expect((await post([item("cab", { tripType: "hourly", drop: "", hours: "30" })])).body.field).toBe("hours");
    expect((await post([item("cab", { tripType: "hourly", drop: "", hours: "8" })])).status).toBe(200);
    expect((await post([item("cab", { tripType: "roundtrip" })])).body.field).toBe("returnDate");
  });

  it("dropdown fields only take listed values: visa country, forex currency (ISO), eSIM country", async () => {
    expect((await post([item("visa", { destinationCountryCode: "XX" })])).body.field).toBe("destinationCountryCode");
    expect((await post([item("forex", { currency: "DOLLAR" })])).body.field).toBe("currency");
    expect((await post([item("forex", { currency: "INR" })])).body.field).toBe("currency");
    expect((await post([item("esim", { countryCode: "ZZ" })])).body.field).toBe("countryCode");
  });

  it("the visa's country name is the server's, from the code", async () => {
    const r = await post([item("visa", { destinationCountryCode: "ae", destinationCountry: "Fake" })]);
    expect((await stored(r.body.request._id)).cartItems[0].meta).toMatchObject({ destinationCountryCode: "AE", destinationCountry: "United Arab Emirates" });
  });

  it("passport validity months is never stored (computed from expiry)", async () => {
    const r = await post([item("visa", { passportValidityMonths: 6 })]);
    expect((await stored(r.body.request._id)).cartItems[0].meta.passportValidityMonths).toBeUndefined();
  });
});

describe("dates", () => {
  it("no past dates", async () => {
    const r = await post([item("flight", { departDate: D(-1) })]);
    expect([r.status, r.body.code, r.body.field]).toEqual([400, "DATE_IN_PAST", "departDate"]);
  });

  it("return after depart, check-out after check-in, end after start, visa return after travel", async () => {
    expect((await post([item("flight", { tripType: "roundtrip", returnDate: D(19) })])).body).toMatchObject({ code: "DATE_ORDER", field: "returnDate" });
    expect((await post([item("hotel", { checkOut: D(20) })])).body).toMatchObject({ code: "DATE_ORDER", field: "checkOut" });
    expect((await post([item("mice", { endDate: D(49) })])).body).toMatchObject({ code: "DATE_ORDER", field: "endDate" });
    expect((await post([item("visa", { returnDate: D(29) })])).body).toMatchObject({ code: "DATE_ORDER", field: "returnDate" });
  });

  it("need-by can't be after the travel date or in the past", async () => {
    expect((await post([item("flight", { needBy: D(21) })])).body).toMatchObject({ code: "DATE_ORDER", field: "needBy" });
    expect((await post([item("flight", { needBy: D(-1) })])).body).toMatchObject({ code: "DATE_IN_PAST", field: "needBy" });
    expect((await post([item("flight", { needBy: D(5), priority: "Urgent" })])).status).toBe(200);
  });

  it("multi-city: 2+ flights, airports from the list, dates in order; the first leg feeds origin / date", async () => {
    const legs = [
      { origin: "DEL", destination: "BOM", date: D(10) },
      { origin: "BOM", destination: "BLR", date: D(12) },
    ];
    expect((await post([item("flight", { tripType: "multicity", legs: legs.slice(0, 1) })])).body.field).toBe("legs");
    expect((await post([item("flight", { tripType: "multicity", legs: [legs[0], { ...legs[1], date: D(9) }] })])).body.field).toBe("legs.1.date");
    const ok = await post([item("flight", { tripType: "multicity", legs, returnDate: D(30) })]);
    expect(ok.status).toBe(200);
    const m = (await stored(ok.body.request._id)).cartItems[0].meta;
    expect(m).toMatchObject({ origin: "DEL", destination: "BLR", departDate: D(10) });
    expect(m.returnDate).toBeUndefined();
    expect((await stored(ok.body.request._id)).cartItems[0].title).toBe("DEL → BOM → BLR");
  });
});

describe("domestic / international per item", () => {
  it("a domestic flight with a name-only traveller + an international visa: only the visa asks for a passport", async () => {
    const nameOnly = { kind: "manual", firstName: "Dev", lastName: "Rao" };
    const flight = item("flight", { travellers: [nameOnly] });
    const visa = item("visa", { travellers: [nameOnly] });
    const r = await post([flight, visa]);
    expect([r.status, r.body.code, r.body.itemIndex]).toEqual([400, "TRAVELLER_INCOMPLETE", 1]);
    expect(r.body.issues.every((i: any) => i.itemIndex === 1)).toBe(true);

    const ok = await post([flight, item("visa", { travellers: [ASHA] })]);
    expect(ok.status).toBe(200);
    const doc = await stored(ok.body.request._id);
    expect(doc.cartItems.map((c: any) => c.meta.travelScope)).toEqual(["domestic", "international"]);
  });

  it("visa, forex and eSIM are always international, whatever the client says", async () => {
    const r = await post([item("visa", { travelScope: "domestic" }), item("forex", { travelScope: "domestic" }), item("esim", { travelScope: "domestic" })]);
    expect((await stored(r.body.request._id)).cartItems.map((c: any) => c.meta.travelScope)).toEqual(["international", "international", "international"]);
  });

  it("an international trip refuses a passport that expires before the trip ends", async () => {
    const r = await post([item("flight", { travelScope: "international", destination: "DXB", tripType: "roundtrip", returnDate: D(25), travellers: [{ ...ASHA, passportExpiry: D(22) }] })]);
    expect([r.status, r.body.code]).toEqual([400, "PASSPORT_EXPIRES_DURING_TRIP"]);
  });
});

describe("travellers per service", () => {
  it("forex: PAN required and valid; one traveller only; name is enough (no DOB / passport)", async () => {
    expect((await post([item("forex", { pan: "" })])).body).toMatchObject({ field: "pan", code: "REQUIRED" });
    expect((await post([item("forex", { pan: "12345" })])).body.field).toBe("pan");
    expect((await post([item("forex", { travellers: [SELF, ASHA] })])).body.code).toBe("FOREX_ONE_TRAVELLER");
    expect((await post([item("forex", { travellers: [{ kind: "manual", firstName: "Dev", lastName: "Rao" }] })])).status).toBe(200);
  });

  it("eSIM: every traveller needs a phone or an email", async () => {
    const noContact = { kind: "manual", firstName: "Dev", lastName: "Rao" };
    const r = await post([item("esim", { travellers: [noContact] })]);
    expect([r.status, r.body.code, r.body.missing]).toEqual([400, "TRAVELLER_INCOMPLETE", ["contact"]]);
    expect((await post([item("esim", { travellers: [{ ...noContact, email: "dev@acme.test" }] })])).status).toBe(200);
  });

  it("holiday / MICE: no traveller check; a lead contact with phone or email; travellers are not stored", async () => {
    expect((await post([item("holiday", { leadPhone: "", leadEmail: "" })])).body.field).toBe("leadPhone");
    expect((await post([item("mice", { leadEmail: "not-an-email" })])).body.field).toBe("leadEmail");
    const r = await post([item("holiday", { travellers: [{ kind: "manual", firstName: "" }] }), item("mice")]);
    expect(r.status).toBe(200);
    const doc = await stored(r.body.request._id);
    expect(doc.cartItems.map((c: any) => c.meta.travellers)).toEqual([[], []]);
    expect(doc.cartItems[0].meta).toMatchObject({ days: 5, people: 4 });
    expect(doc.cartItems[1].meta.attendees).toBe(40);
  });

  it("flight / hotel / visa / cab need at least one traveller", async () => {
    for (const svc of ["flight", "hotel", "visa", "cab"]) {
      expect((await post([item(svc, { travellers: [] })])).body.code, svc).toBe("NO_TRAVELLERS");
    }
  });

  it("head counts are derived from the traveller list, not taken from the client", async () => {
    const r = await post([
      item("flight", { adults: 9, children: 9, infants: 9, travellers: [SELF, ASHA, CHILD] }),
      item("hotel", { adults: 7, rooms: "2", travellers: [SELF, ASHA, CHILD] }),
      item("visa", { travelers: 12, travellers: [SELF, ASHA] }),
      item("cab", { passengers: 8, travellers: [SELF] }),
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [f, h, v, c] = (await stored(r.body.request._id)).cartItems;
    expect([f.meta.adults, f.meta.children, f.meta.infants, f.qty]).toEqual([2, 1, 0, 3]);
    expect([h.meta.adults, h.meta.children, h.meta.rooms]).toEqual([2, 1, 2]);
    expect(v.meta.travelers).toBe(2);
    expect(c.meta.passengers).toBe(1);
  });

  it("the same manual traveller sent without an id gets ONE id across all items of a request", async () => {
    const guest = { kind: "manual", firstName: "Arjun", lastName: "Mehta" };
    const r = await post([item("flight", { travellers: [guest] }), item("cab", { travellers: [guest] })]);
    const ids = (await stored(r.body.request._id)).cartItems.map((c: any) => c.meta.travellers[0].travellerId);
    expect(ids[0]).toMatch(/^m-[a-f0-9]{16}$/);
    expect(ids[1]).toBe(ids[0]);
  });

  it("hotel: rooms can't outnumber guests", async () => {
    expect((await post([item("hotel", { rooms: "3" })])).body.field).toBe("rooms");
  });
});

describe("PAN privacy and the edit round-trip", () => {
  it("the requester gets the PAN back as last 4; saving it unchanged keeps the real PAN", async () => {
    const r = await post([item("forex")]);
    const id = r.body.request._id;
    const got = await as(request(app).get(`/api/approvals/requests/${id}`));
    expect(got.body.request.cartItems[0].meta.pan).toBe("******234F");
    const put = await as(request(app).put(`/api/approvals/requests/${id}`)).send({ cartItems: got.body.request.cartItems, comments: "edited" });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await stored(id)).cartItems[0].meta.pan).toBe("ABCDE1234F");
    const forged = await as(request(app).put(`/api/approvals/requests/${id}`)).send({ cartItems: [item("forex", { pan: "******999Z" })] });
    expect([forged.status, forged.body.code]).toEqual([400, "PAN_REENTER"]);
  });

  it("PUT runs the same rules as POST", async () => {
    const r = await post([item("flight")]);
    const bad = await as(request(app).put(`/api/approvals/requests/${r.body.request._id}`)).send({ cartItems: [item("flight", { departDate: D(-3) })] });
    expect([bad.status, bad.body.code]).toEqual([400, "DATE_IN_PAST"]);
  });
});

describe("request context and no prices", () => {
  it("GET /request-context: company name and the approver's name, never an email or a workspace id", async () => {
    const r = await as(request(app).get("/api/approvals/request-context"));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ companyName: "Acme Industries", approver: { status: "ok", name: "Manoj Approver" } });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("@");
    expect(text).not.toContain(String(WS));
  });

  it("customer responses for a full 8-service request carry no price or rupee figure", async () => {
    const r = await post(Object.keys(VALID).map((k) => item(k)));
    const got = await as(request(app).get(`/api/approvals/requests/${r.body.request._id}`));
    const text = JSON.stringify([r.body, got.body]);
    expect(text).not.toMatch(/₹|\bINR\b|"price"|"fare"|estimatedBudget/i);
    expect(got.body.request.cartItems.find((c: any) => c.type === "forex").meta).toMatchObject({ currency: "USD", amount: 500 });
  });

  it("the shared rules module agrees with the route (a direct call flags the same field)", () => {
    expect(validateItem(item("cab", { pickupTime: "" }), { today: todayIST() })[0].field).toBe("pickupTime");
  });
});
