// Phase 1 price policy for the approval/request path (Flows 2/3 = manual
// booking): no customer-side viewer — requester, approver, Workspace Leader,
// any customer role, or an unauthenticated email-link holder — gets any price,
// fare, amount, cost or margin, at any depth, in any approval response or
// approval email. Plumtrips staff (isStaffAdmin) keep everything.
//
// Proposals (Flow 2) follow the same rule for L1/L2/L0, including the
// "Proposal Approval Needed" email and the option PDFs (supplier quotes).
//
// NO DATABASE — apps/backend/.env points MONGO_URI at PROD Atlas. Every model,
// the auth/workspace middleware, the mailer and the email token are mocked.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";

/* ── fixture ─────────────────────────────────────────────────────────────── */

const RID = "64b000000000000000000001";
const PID = "64b0000000000000000000a1";

function baseFixture(): any {
  return {
    _id: RID,
    ticketId: "TKT-1",
    workspaceId: "64b0000000000000000000ff",
    customerId: "C1",
    customerName: "Acme Corp",
    frontlinerId: "U1",
    frontlinerEmail: "req@cust.com",
    frontlinerName: "Riya Requester",
    managerEmail: "mgr@cust.com",
    managerName: "Manoj Manager",
    status: "pending",
    stage: "REQUEST_RAISED",
    comments: "Client visit. Budget ₹ 12,000 approx",
    bookingAmount: 26000,
    actualBookingPrice: 21000,
    cartItems: [
      {
        type: "flight",
        title: "DEL → BOM (One Way)",
        description: "Pre-selected from Pluto AI: IndiGo 6E-201 — ₹5,432",
        qty: 1,
        price: 5432,
        meta: {
          origin: "DEL",
          destination: "BOM",
          departDate: "2026-10-20",
          cabinClass: "Economy",
          adults: 2,
          children: 1,
          infants: 0,
          totalTravellers: 3,
          notes: "Flight: IndiGo (₹5,432)",
          fare: 5432,
          amount: 5432,
          totalFare: 5432,
          estimatedBudget: 9000,
          budgetBand: "Premium",
          selection: {
            airline: "IndiGo",
            Fare: { OfferedFare: 5100, PublishedFare: 5432, Tax: 700, _netPublishedFare: 4900, _marginAmount: 532 },
          },
          travellers: [{ firstName: "Riya", lastName: "R" }],
        },
      },
      {
        type: "hotel",
        title: "Mumbai • Business stay",
        qty: 1,
        price: 8000,
        meta: {
          city: "Mumbai",
          checkIn: "2026-10-20",
          checkOut: "2026-10-22",
          rooms: 2,
          nights: 2,
          totalNights: 2,
          starRating: "5",
          roomType: "Deluxe",
          mealPlan: "Breakfast",
          notes: "Hotel: Taj Lands End (₹8,000/nt)",
          markupAmount: 900,
          netAmount: 7100,
        },
      },
      {
        type: "forex",
        title: "USD • 2000 forex",
        qty: 1,
        price: 0,
        meta: { currency: "USD", amount: 2000, deliveryMode: "Cash", city: "Delhi", requiredBy: "2026-10-18", rate: 84.2 },
      },
    ],
    history: [
      { action: "submitted", by: "U1", comment: "Please book INR 5432 fare" },
      { action: "admin_done", by: "S1", comment: "[SERVICE:FLIGHT] [BOOKING_AMOUNT:26000] [ACTUAL_PRICE:21000] booked" },
    ],
    meta: { ccLeaders: ["wl@cust.com"], customerWorkspaceId: "64b0000000000000000000ff", travelFlow: "APPROVAL_FLOW", requireL0Approval: true },
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
  };
}

/** Every money key the fixture carries, at any depth. Independent of the sanitiser's own rules. */
const FIXTURE_PRICE_KEYS = [
  "price", "fare", "amount", "totalFare", "estimatedBudget", "bookingAmount", "actualBookingPrice",
  "OfferedFare", "PublishedFare", "Tax", "_netPublishedFare", "_marginAmount", "markupAmount", "netAmount", "rate",
  // proposal
  "unitPrice", "totalPrice", "totalAmount", "supplierCost", "margin",
];
/** The forex item's requested currency quantity is not a price (cartItems[2] is forex). */
const FOREX_AMOUNT_PATH = /\.cartItems\.2\.meta\.amount$/;
const CURRENCY_FIGURE = /(₹|&#8377;|\bINR\b|\bRs\.?)\s*\d|\d[\d,]*\s*(₹|\bINR\b)|BOOKING_AMOUNT|ACTUAL_PRICE/i;

function priceKeyPaths(v: any, path = "$"): string[] {
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  for (const k of Object.keys(v)) {
    if (FIXTURE_PRICE_KEYS.includes(k) && !FOREX_AMOUNT_PATH.test(`${path}.${k}`)) out.push(`${path}.${k}`);
    out.push(...priceKeyPaths(v[k], `${path}.${k}`));
  }
  return out;
}

function expectPriceFree(body: any) {
  expect(priceKeyPaths(body)).toEqual([]);
  expect(JSON.stringify(body)).not.toMatch(CURRENCY_FIGURE);
}

function expectHasPrices(body: any) {
  const paths = priceKeyPaths(body);
  expect(paths.some((p) => p.endsWith(".actualBookingPrice"))).toBe(true);
  expect(paths.some((p) => p.endsWith(".price"))).toBe(true);
  expect(paths.some((p) => p.endsWith("._netPublishedFare"))).toBe(true);
}

/* ── state the mocks read ────────────────────────────────────────────────── */

const state = vi.hoisted(() => ({
  overrides: {} as Record<string, any>,
  proposalOverrides: {} as Record<string, any>,
  saved: null as any,
  mails: [] as Array<{ to: any; subject: string; html: string; attachments?: any[] }>,
}));

function currentDoc(): any {
  const d: any = { ...baseFixture(), ...state.overrides };
  Object.defineProperty(d, "save", {
    value: async () => {
      state.saved = JSON.parse(JSON.stringify(d));
      return d;
    },
    enumerable: false,
  });
  Object.defineProperty(d, "toObject", { value: () => JSON.parse(JSON.stringify(d)), enumerable: false });
  Object.defineProperty(d, "markModified", { value: () => {}, enumerable: false });
  return d;
}

const OPTION_PDF = `proposals/${PID}/opt-quote.pdf`;
const BOOKING_PDF = `proposals/${PID}/booking-ticket.pdf`;
const dl = (rel: string) => `http://localhost:8080/api/proposals/attachments/download?path=${encodeURIComponent(rel)}`;

function baseProposal(): any {
  return {
    _id: PID,
    requestId: RID,
    workspaceId: "64b0000000000000000000ff",
    version: 1,
    status: "SUBMITTED",
    currency: "INR",
    totalAmount: 31000,
    margins: { flight: 10 },
    options: [
      {
        optionNo: 1,
        title: "IndiGo + Taj",
        vendor: "Supplier A",
        currency: "INR",
        totalAmount: 31000,
        supplierCost: 27000,
        margin: 4000,
        notes: "Best value. Quoted ₹31,000 all-in",
        attachments: [dl(OPTION_PDF)],
        lineItems: [
          { itemIndex: 1, category: "flight", title: "DEL → BOM", qty: 3, unitPrice: 5432, totalPrice: 16296, currency: "INR" },
          { itemIndex: 2, category: "hotel", title: "Taj Lands End", qty: 2, unitPrice: 7352, totalPrice: 14704, currency: "INR" },
        ],
      },
    ],
    approvals: { l2: { decision: "PENDING" }, l0: { decision: "PENDING" } },
    booking: { status: "NOT_STARTED", attachments: [dl(BOOKING_PDF)], bookingAmount: 31000, actualBookingPrice: 27000 },
    history: [{ action: "SUBMITTED", note: "sent at INR 31000" }],
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
  };
}

function currentProposal(): any {
  const d: any = { ...baseProposal(), ...state.proposalOverrides };
  Object.defineProperty(d, "save", { value: async () => d, enumerable: false });
  Object.defineProperty(d, "toObject", { value: () => JSON.parse(JSON.stringify(d)), enumerable: false });
  Object.defineProperty(d, "markModified", { value: () => {}, enumerable: false });
  return d;
}

/** Awaitable Mongoose-ish query chain. */
function chain(value: () => any): any {
  const node: any = {
    sort: () => node, select: () => node, populate: () => node, limit: () => node, skip: () => node,
    lean: () => node,
    exec: () => Promise.resolve(value()),
    then: (r: any, j: any) => Promise.resolve(value()).then(r, j),
  };
  return node;
}

/* ── mocks ───────────────────────────────────────────────────────────────── */

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (req: any, _res: any, next: any) => {
    req.workspaceObjectId = "64b0000000000000000000ff";
    next();
  },
}));
vi.mock("../middleware/travelModeGuard.js", () => ({
  requireTravelMode: () => (req: any, _res: any, next: any) => {
    req.workspace = { config: { travelFlow: "APPROVAL_FLOW" } };
    next();
  },
}));
vi.mock("../middleware/requireFeature.js", () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/scopedFindById.js", () => ({
  scopedFindById: async (model: any) => (model?.__isProposal ? currentProposal() : null),
}));

vi.mock("../models/ApprovalRequest.js", () => ({
  default: {
    find: () => chain(() => [currentDoc()]),
    findOne: () => chain(() => currentDoc()),
    findOneAndUpdate: () => chain(() => currentDoc()),
    create: async (data: any) => {
      const d: any = { ...baseFixture(), ...data, _id: RID };
      Object.defineProperty(d, "save", { value: async () => d, enumerable: false });
      return d;
    },
  },
}));
vi.mock("../models/User.js", () => ({
  default: {
    findOne: () => chain(() => ({ email: "mgr@cust.com", name: "Manoj Manager" })),
    findById: () => chain(() => null),
  },
}));
vi.mock("../models/CustomerMember.js", () => ({
  default: {
    find: (q: any) =>
      chain(() =>
        q?.role === "WORKSPACE_LEADER"
          ? [{ email: "wl@cust.com", customerId: "C1", role: "WORKSPACE_LEADER" }]
          : [],
      ),
  },
}));
vi.mock("../models/CustomerWorkspace.js", () => ({
  default: {
    findOne: () => chain(() => ({ _id: "64b0000000000000000000ff", customerId: "C1", name: "Acme Corp", defaultApproverEmails: ["mgr@cust.com"] })),
    findById: () => chain(() => null),
  },
}));
vi.mock("../models/MasterData.js", () => ({
  default: { findById: () => chain(() => null), findOne: () => chain(() => null) },
}));
vi.mock("../models/Proposal.js", () => ({
  default: {
    __isProposal: true,
    find: () => chain(() => [currentProposal()]),
    // approvals.ts asks for the proposal linked to a request ({ requestId }) — none there.
    findOne: (q: any) => chain(() => (q && "requestId" in q ? null : currentProposal())),
    findById: () => chain(() => currentProposal()),
    aggregate: async () => [JSON.parse(JSON.stringify(currentProposal()))],
  },
}));
vi.mock("../models/TravelBooking.js", () => ({
  default: { findOneAndUpdate: async () => null },
}));
vi.mock("../utils/mailer.js", () => ({
  sendMail: async (m: any) => {
    state.mails.push({ to: m.to, subject: m.subject, html: String(m.html || ""), attachments: m.attachments });
  },
}));
vi.mock("../utils/emailActionToken.js", () => ({
  signEmailActionToken: () => "tok",
  verifyEmailActionToken: (t: string) => ({ rid: RID, approverEmail: "mgr@cust.com", action: t === "tok-hold" ? "on_hold" : "approved" }),
}));

const { default: approvalsRouter } = await import("./approvals.js");
const { default: bookingHistoryRouter } = await import("./bookingHistory.js");
const { default: proposalsRouter } = await import("./proposals.js");
const { sanitizeApprovalForViewer, stripPriceText, isPriceKey } = await import("./approvals.security.js");

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);
app.use("/api/approvals", bookingHistoryRouter);
app.use("/api/booking-history", bookingHistoryRouter);
app.use("/api/proposals", proposalsRouter);

// Real files so the download route (and the old email-attachment code) find them.
const uploadsDir = path.join(process.cwd(), "uploads", "proposals", PID);
fs.mkdirSync(uploadsDir, { recursive: true });
fs.writeFileSync(path.join(process.cwd(), "uploads", OPTION_PDF), "%PDF-1.4 option quote");
fs.writeFileSync(path.join(process.cwd(), "uploads", BOOKING_PDF), "%PDF-1.4 ticket");
afterAll(() => fs.rmSync(uploadsDir, { recursive: true, force: true }));

/* ── viewers ─────────────────────────────────────────────────────────────── */

const REQUESTER = { sub: "U1", email: "req@cust.com", name: "Riya Requester", roles: ["EMPLOYEE"] };
const APPROVER = { sub: "U2", email: "mgr@cust.com", name: "Manoj Manager", roles: ["MANAGER"] };
const LEADER = { sub: "U3", email: "wl@cust.com", name: "Wendy Leader", roles: ["WORKSPACE_LEADER", "CUSTOMER"] };
const L1_ROLE = { sub: "U4", email: "l1@cust.com", name: "L One", roles: ["L1"] };
const STAFF = { sub: "S1", email: "ops@plumtrips.com", name: "Ops", roles: ["ADMIN"] };

const as = (u: any) => ({ "x-test-user": JSON.stringify(u) });

beforeEach(() => {
  state.overrides = {};
  state.proposalOverrides = {};
  state.saved = null;
  state.mails = [];
});

/* ── sanitiser unit ──────────────────────────────────────────────────────── */

describe("sanitizeApprovalForViewer", () => {
  it("removes every money key at any depth for a customer viewer and keeps trip fields", () => {
    const out = sanitizeApprovalForViewer(baseFixture(), REQUESTER);
    expectPriceFree(out);
    expect(out.cartItems[0].meta.origin).toBe("DEL");
    expect(out.cartItems[0].meta.budgetBand).toBe("Premium");
    expect(out.cartItems[0].meta.selection.airline).toBe("IndiGo");
    expect(out.cartItems[0].meta.notes).toBe("Flight: IndiGo");
    expect(out.cartItems[1].meta.notes).toBe("Hotel: Taj Lands End");
    expect(out.cartItems[0].description).toBe("Pre-selected from Pluto AI: IndiGo 6E-201");
    expect(out.history[1].comment).toBe("[SERVICE:FLIGHT] booked");
  });

  it("returns the document untouched for staff", () => {
    const doc = baseFixture();
    expect(sanitizeApprovalForViewer(doc, STAFF)).toBe(doc);
  });

  it("treats a missing viewer (email-link holder) as customer-side", () => {
    expectPriceFree(sanitizeApprovalForViewer(baseFixture(), null));
  });

  it("key rules: money segments and compounds go, look-alikes stay", () => {
    for (const k of ["price", "bookingAmount", "actualbookingprice", "_netPublishedFare", "TotalFare", "markupAmount",
      "commissionEarned", "Tax", "tds", "gstAmount", "netAmount", "RecommendedSellingRate", "estimatedBudget", "PGCharge", "serviceFee"]) {
      expect(isPriceKey(k), k).toBe(true);
    }
    for (const k of ["corporateName", "taxiType", "network", "starRating", "budgetBand", "origin", "travellers", "nationality", "notes"]) {
      expect(isPriceKey(k), k).toBe(false);
    }
  });

  it("strips currency figures from text", () => {
    expect(stripPriceText("Flight: IndiGo (₹5,432)")).toBe("Flight: IndiGo");
    expect(stripPriceText("Fare INR 5,432.50 confirmed")).toBe("Fare confirmed");
    expect(stripPriceText("Rs. 900 cab")).toBe("cab");
    expect(stripPriceText("Total 4,200 INR")).toBe("Total");
    expect(stripPriceText("Taj ₹8,000/nt")).toBe("Taj");
    expect(stripPriceText("[BOOKING_AMOUNT:26000] done")).toBe("done");
    expect(stripPriceText("Depart 2026-10-20, 2 adults")).toBe("Depart 2026-10-20, 2 adults");
  });
});

/* ── customer-side endpoints ─────────────────────────────────────────────── */

describe("approval endpoints — customer-side callers get no prices", () => {
  it("POST /requests (requester)", async () => {
    const res = await request(app)
      .post("/api/approvals/requests")
      .set(as(REQUESTER))
      .send({ customerId: "C1", cartItems: baseFixture().cartItems, comments: baseFixture().comments });
    expect(res.status).toBe(200);
    expectPriceFree(res.body);
  });

  it("GET /requests/mine (requester)", async () => {
    const res = await request(app).get("/api/approvals/requests/mine").set(as(REQUESTER));
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expectPriceFree(res.body);
  });

  it("GET /requests/inbox (approver and Workspace Leader)", async () => {
    for (const u of [APPROVER, LEADER]) {
      const res = await request(app).get("/api/approvals/requests/inbox").set(as(u));
      expect(res.status).toBe(200);
      expect(res.body.rows).toHaveLength(1);
      expectPriceFree(res.body);
    }
  });

  it("GET /requests/:id (requester, approver, Workspace Leader)", async () => {
    for (const u of [REQUESTER, APPROVER, LEADER]) {
      const res = await request(app).get(`/api/approvals/requests/${RID}`).set(as(u));
      expect(res.status, u.email).toBe(200);
      expectPriceFree(res.body);
    }
  });

  it("PUT /requests/:id (requester edit)", async () => {
    const res = await request(app)
      .put(`/api/approvals/requests/${RID}`)
      .set(as(REQUESTER))
      .send({ cartItems: baseFixture().cartItems, comments: "edited" });
    expect(res.status).toBe(200);
    expectPriceFree(res.body);
  });

  it("PUT /requests/:id/action — approve (approver) and resend_email (requester)", async () => {
    const approve = await request(app)
      .put(`/api/approvals/requests/${RID}/action`)
      .set(as(APPROVER))
      .send({ action: "approved" });
    expect(approve.status).toBe(200);
    expectPriceFree(approve.body);

    state.overrides = {};
    const resend = await request(app)
      .put(`/api/approvals/requests/${RID}/action`)
      .set(as(REQUESTER))
      .send({ action: "resend_email" });
    expect(resend.status).toBe(200);
    expectPriceFree(resend.body);
  });

  it("admin read endpoints for a Workspace Leader", async () => {
    for (const path of ["pending", "approved", "done", "rejected"]) {
      const res = await request(app).get(`/api/approvals/admin/${path}`).set(as(LEADER));
      expect(res.status, path).toBe(200);
      expect(res.body.rows, path).toHaveLength(1);
      expectPriceFree(res.body);
    }
    const one = await request(app).get(`/api/approvals/admin/requests/${RID}`).set(as(LEADER));
    expect(one.status).toBe(200);
    expectPriceFree(one.body);
  });

  it("PUT /requests/:id/revoke and /resubmit (requester)", async () => {
    const revoke = await request(app).put(`/api/approvals/requests/${RID}/revoke`).set(as(REQUESTER)).send({});
    expect(revoke.status).toBe(200);
    expectPriceFree(revoke.body);

    state.overrides = { status: "declined", stage: "REQUEST_DECLINED" };
    const resubmit = await request(app)
      .put(`/api/approvals/requests/${RID}/resubmit`)
      .set(as(REQUESTER))
      .send({ cartItems: baseFixture().cartItems });
    expect(resubmit.status).toBe(200);
    expectPriceFree(resubmit.body);
  });

  it("GET booking history on both mounts (requester, Workspace Leader, L1 role)", async () => {
    for (const mount of ["/api/booking-history/history", "/api/approvals/history"]) {
      for (const u of [REQUESTER, LEADER, L1_ROLE]) {
        const res = await request(app).get(mount).set(as(u));
        expect(res.status, `${mount} ${u.email}`).toBe(200);
        expect(res.body.rows.length).toBeGreaterThan(0);
        expectPriceFree(res.body);
      }
    }
  });
});

/* ── /email/consume ──────────────────────────────────────────────────────── */

describe("POST /email/consume", () => {
  it("returns only the trimmed decision shape", async () => {
    const res = await request(app).post("/api/approvals/email/consume").send({ token: "tok", action: "approved" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.request).sort()).toEqual(
      ["allowedActions", "customerName", "id", "requesterName", "stage", "status", "ticketId", "tripSummary"].sort(),
    );
    expect(res.body.request).toMatchObject({
      id: RID,
      requesterName: "Riya Requester",
      tripSummary: "DEL → BOM",
      status: "approved",
      allowedActions: [],
    });
    expectPriceFree(res.body);
    expect(JSON.stringify(res.body)).not.toMatch(/@cust\.com/);
  });

  it("on hold leaves approve/decline open", async () => {
    const res = await request(app).post("/api/approvals/email/consume").send({ token: "tok-hold", action: "on_hold" });
    expect(res.status).toBe(200);
    expect(res.body.request.allowedActions).toEqual(["approved", "declined"]);
  });
});

/* ── staff keep full visibility ──────────────────────────────────────────── */

describe("staff callers still get prices", () => {
  it("GET /requests/:id, admin lists, admin detail, booking history", async () => {
    const one = await request(app).get(`/api/approvals/requests/${RID}`).set(as(STAFF));
    expect(one.status).toBe(200);
    expectHasPrices(one.body);

    for (const path of ["pending", "approved", "done", "rejected"]) {
      const res = await request(app).get(`/api/approvals/admin/${path}`).set(as(STAFF));
      expect(res.status, path).toBe(200);
      expectHasPrices(res.body);
    }
    const detail = await request(app).get(`/api/approvals/admin/requests/${RID}`).set(as(STAFF));
    expectHasPrices(detail.body);

    const hist = await request(app).get("/api/booking-history/history").set(as(STAFF));
    expect(hist.status).toBe(200);
    expectHasPrices(hist.body);
    expect(hist.body.rows[0]._latestParsed.bookingAmount).toBe(26000);
  });
});

/* ── emails (all go to customer-side recipients) ─────────────────────────── */

describe("approval emails carry no price", () => {
  const PRICE_IN_EMAIL = /Fare<|>Fare|Booking Amount|₹|&#8377;|\bINR\b\s*\d/;

  it("approver email + leader FYI on submit", async () => {
    await request(app)
      .post("/api/approvals/requests")
      .set(as(REQUESTER))
      .send({ customerId: "C1", cartItems: baseFixture().cartItems, comments: baseFixture().comments });
    expect(state.mails.map((m) => m.to).sort()).toEqual(["mgr@cust.com", "wl@cust.com"]);
    for (const m of state.mails) {
      expect(m.html, m.subject).not.toMatch(PRICE_IN_EMAIL);
      expect(m.html).toContain("DEL");
    }
  });

  it("requester-approved email", async () => {
    await request(app).put(`/api/approvals/requests/${RID}/action`).set(as(APPROVER)).send({ action: "approved" });
    const mail = state.mails.find((m) => m.to === "req@cust.com");
    expect(mail).toBeTruthy();
    expect(mail!.html).not.toMatch(PRICE_IN_EMAIL);
    expect(mail!.html).toContain("DEL → BOM");
  });

  it("booking-processed email (staff marks done)", async () => {
    state.overrides = { status: "approved", stage: "BOOKING_IN_PROGRESS", adminState: "in_progress" };
    const res = await request(app)
      .put(`/api/approvals/admin/${RID}/done`)
      .set(as(STAFF))
      .send({ comment: "Booked, fare ₹5,432", bookingAmount: 26000 });
    expect(res.status).toBe(200);
    const mail = state.mails.find((m) => m.to === "req@cust.com");
    expect(mail).toBeTruthy();
    expect(mail!.html).not.toMatch(PRICE_IN_EMAIL);
    expect(mail!.html).toContain("DEL");
  });
});

/* ── over-stripping: counts, quantities and forex survive ────────────────── */

describe("non-price keys survive for customer callers", () => {
  it("counts, quantities, star rating, room type, meal plan", async () => {
    const res = await request(app).get(`/api/approvals/requests/${RID}`).set(as(REQUESTER));
    expect(res.status).toBe(200);
    const [flight, hotel] = res.body.request.cartItems;
    expect(flight.qty).toBe(1);
    expect(flight.meta).toMatchObject({ adults: 2, children: 1, infants: 0, totalTravellers: 3, cabinClass: "Economy" });
    expect(hotel.meta).toMatchObject({ rooms: 2, nights: 2, totalNights: 2, starRating: "5", roomType: "Deluxe", mealPlan: "Breakfast" });
  });

  it("forex: the requested currency quantity reaches the approver; its rate does not", async () => {
    const res = await request(app).get(`/api/approvals/requests/${RID}`).set(as(APPROVER));
    const forex = res.body.request.cartItems[2];
    expect(forex.meta).toMatchObject({ currency: "USD", amount: 2000, deliveryMode: "Cash" });
    expect(forex.meta.rate).toBeUndefined();
    expect(forex.price).toBeUndefined();
    expectPriceFree(res.body);
  });

  it("forex: a requester edit round-trip keeps the amount", async () => {
    const got = await request(app).get(`/api/approvals/requests/${RID}`).set(as(REQUESTER));
    const put = await request(app)
      .put(`/api/approvals/requests/${RID}`)
      .set(as(REQUESTER))
      .send({ cartItems: got.body.request.cartItems, comments: "edited" });
    expect(put.status).toBe(200);
    expect(state.saved.cartItems[2].meta).toMatchObject({ currency: "USD", amount: 2000 });
    expect(put.body.request.cartItems[2].meta.amount).toBe(2000);
  });

  it("forex: the approver email says what is requested", async () => {
    await request(app)
      .post("/api/approvals/requests")
      .set(as(REQUESTER))
      .send({ customerId: "C1", cartItems: baseFixture().cartItems, comments: "" });
    const mail = state.mails.find((m) => m.to === "mgr@cust.com");
    expect(mail!.html).toContain("USD 2,000 requested");
  });
});

/* ── proposals (Flow 2) ──────────────────────────────────────────────────── */

describe("proposal endpoints — customer-side callers get no prices", () => {
  it("GET /proposals/inbox (L2 approver, L0 leader)", async () => {
    for (const u of [APPROVER, LEADER]) {
      const res = await request(app).get("/api/proposals/inbox").set(as(u));
      expect(res.status, u.email).toBe(200);
      expect(res.body.items, u.email).toHaveLength(1);
      expectPriceFree(res.body);
      expect(res.body.items[0].options[0].attachments).toEqual([]);
      expect(res.body.items[0].options[0].lineItems[0]).toMatchObject({ title: "DEL → BOM", qty: 3 });
    }
  });

  it("GET /proposals/mine (L2 approver, L0 leader)", async () => {
    for (const u of [APPROVER, LEADER]) {
      const res = await request(app).get("/api/proposals/mine").set(as(u));
      expect(res.status, u.email).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expectPriceFree(res.body);
    }
  });

  it("GET /proposals/:id (L1 owner, L2, L0) — booking.* included, booking documents kept", async () => {
    for (const u of [REQUESTER, APPROVER, LEADER]) {
      const res = await request(app).get(`/api/proposals/${PID}`).set(as(u));
      expect(res.status, u.email).toBe(200);
      expectPriceFree(res.body);
      expect(res.body.proposal.booking.bookingAmount).toBeUndefined();
      expect(res.body.proposal.booking.attachments).toEqual([dl(BOOKING_PDF)]);
      expect(res.body.proposal.options[0].notes).toBe("Best value. Quoted all-in");
    }
  });

  it("POST /proposals/:id/decide and /:id/action responses", async () => {
    const decide = await request(app).post(`/api/proposals/${PID}/decide`).set(as(APPROVER)).send({ decision: "APPROVED", role: "L2" });
    expect(decide.status).toBe(200);
    expectPriceFree(decide.body);

    const action = await request(app).post(`/api/proposals/${PID}/action`).set(as(REQUESTER)).send({ action: "accept" });
    expect(action.status).toBe(200);
    expectPriceFree(action.body);
  });

  it("staff get the full proposal", async () => {
    const res = await request(app).get(`/api/proposals/${PID}`).set(as(STAFF));
    expect(res.status).toBe(200);
    const paths = priceKeyPaths(res.body);
    for (const k of ["totalAmount", "unitPrice", "totalPrice", "supplierCost", "bookingAmount", "actualBookingPrice"]) {
      expect(paths.some((p) => p.endsWith(`.${k}`)), k).toBe(true);
    }
    expect(res.body.proposal.options[0].attachments).toEqual([dl(OPTION_PDF)]);
  });
});

describe("proposal PDFs", () => {
  const q = (rel: string) => `/api/proposals/attachments/download?path=${encodeURIComponent(rel)}`;

  it("option PDFs are staff-only to download; booking documents stay open to viewers", async () => {
    for (const u of [REQUESTER, APPROVER, LEADER]) {
      expect((await request(app).get(q(OPTION_PDF)).set(as(u))).status, u.email).toBe(403);
      expect((await request(app).get(q(BOOKING_PDF)).set(as(u))).status, u.email).toBe(200);
    }
    expect((await request(app).get(q(OPTION_PDF)).set(as(STAFF))).status).toBe(200);
  });

  it("'Proposal Approval Needed' emails to L2/L0: no prices, no PDF attachment, itinerary kept", async () => {
    state.proposalOverrides = { status: "DRAFT" };
    const res = await request(app).post(`/api/proposals/${PID}/submit`).set(as(STAFF)).send({});
    expect(res.status).toBe(200);
    const sent = state.mails.filter((m) => /Proposal Approval Needed/.test(m.subject));
    expect(sent.map((m) => m.to).sort()).toEqual(["mgr@cust.com", "wl@cust.com"]);
    for (const m of sent) {
      expect(m.html).not.toMatch(/₹|&#8377;|Grand Total|Option Total|>Unit<|>Total</);
      expect(m.html).toContain("DEL → BOM");
      expect(m.attachments ?? []).toEqual([]);
    }
  });
});
