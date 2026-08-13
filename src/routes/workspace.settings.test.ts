// Coverage for GET /workspace/settings — specifically the HOUSE guard on
// the company-info prefill fields (pan/gstNumber/companyName/address/
// companyEmail/companyPhone) used by the flight/hotel GST and Corporate PAN
// prefill. requireAuth/requireWorkspace are mocked as passthroughs — the
// harness injects req.user/req.workspaceId directly, same approach as
// workspace.travellers.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  default: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
  // Mirrors requireWorkspace.ts's real CUSTOMER_ROLES/STAFF_OVERRIDE_ROLES
  // split closely enough for this test: any STAFF_OVERRIDE role wins over
  // a customer role, otherwise a recognized customer role makes it true.
  isCustomerUser: (user: any) => {
    const roles: string[] = Array.isArray(user?.roles) ? user.roles.map((r: string) => String(r).toUpperCase()) : [];
    const STAFF = new Set(["ADMIN", "SUPERADMIN", "HR", "TENANT_ADMIN", "MANAGER", "EMPLOYEE"]);
    if (roles.some((r) => STAFF.has(r))) return false;
    const CUSTOMER = new Set(["CUSTOMER", "WORKSPACE_LEADER", "REQUESTER", "APPROVER", "BUSINESS"]);
    return roles.some((r) => CUSTOMER.has(r));
  },
}));

const cwFindByIdMock = vi.fn();
vi.mock("../models/CustomerWorkspace.js", () => ({
  default: {
    findById: (...args: any[]) => ({ select: () => ({ lean: () => Promise.resolve(cwFindByIdMock(...args)) }) }),
  },
}));

const custFindOneMock = vi.fn();
vi.mock("../models/Customer.js", () => ({
  default: {
    findOne: (...args: any[]) => ({ select: () => ({ lean: () => Promise.resolve(custFindOneMock(...args)) }) }),
  },
}));

import express from "express";
import request from "supertest";
import settingsRouter from "./workspace.settings.js";

const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";
const WORKSPACE_ID = "workspace0000000000000001";
const CUSTOMER_ID = "customer0000000000000001";

const REAL_WS_DOC = {
  pan: "AACCC6485E",
  gstNumber: "29AACCC6485E1ZH",
  companyName: "CSTEP Pvt Ltd",
  address: { line1: "123 MG Road", city: "Bengaluru", state: "KA", country: "India", pincode: "560001" },
  customerId: CUSTOMER_ID,
  payrollConfig: {},
  attendanceConfig: {},
};

const REAL_CUSTOMER_DOC = {
  email: "lalitha@cstep.in",
  phone: "+91 9880159470",
  billingPhone: "",
};

function makeApp(user: any, workspaceId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    req.workspaceId = workspaceId;
    next();
  });
  app.use("/", settingsRouter);
  return app;
}

beforeEach(() => {
  cwFindByIdMock.mockReset().mockReturnValue(REAL_WS_DOC);
  custFindOneMock.mockReset().mockReturnValue(REAL_CUSTOMER_DOC);
});

describe("GET /workspace/settings — company-info prefill", () => {
  it("returns PAN/GST/company/contact fields for a normal customer workspace", async () => {
    const app = makeApp({ sub: "u1", roles: ["CUSTOMER"] }, WORKSPACE_ID);
    const res = await request(app).get("/");

    expect(res.status).toBe(200);
    expect(res.body.pan).toBe("AACCC6485E");
    expect(res.body.gstNumber).toBe("29AACCC6485E1ZH");
    expect(res.body.companyName).toBe("CSTEP Pvt Ltd");
    expect(res.body.companyEmail).toBe("lalitha@cstep.in");
    expect(res.body.companyPhone).toBe("+91 9880159470");
  });

  it("prefers Customer.billingPhone over Customer.phone when both are set", async () => {
    custFindOneMock.mockReturnValue({ email: "a@b.com", phone: "+91111", billingPhone: "+91222" });
    const app = makeApp({ sub: "u1", roles: ["CUSTOMER"] }, WORKSPACE_ID);
    const res = await request(app).get("/");
    expect(res.body.companyPhone).toBe("+91222");
  });

  it("blanks every company-info field when a customer session resolves to HOUSE", async () => {
    // Even though the DB record has real Plumtrips data, none of it should
    // reach a customer session — this is the exact leak class the guard
    // exists to prevent.
    const app = makeApp({ sub: "u1", roles: ["CUSTOMER"] }, HOUSE_WORKSPACE_ID);
    const res = await request(app).get("/");

    expect(res.status).toBe(200);
    expect(res.body.pan).toBe("");
    expect(res.body.gstNumber).toBe("");
    expect(res.body.companyName).toBe("");
    expect(res.body.address).toBeNull();
    expect(res.body.companyEmail).toBe("");
    expect(res.body.companyPhone).toBe("");
  });

  it("never queries Customer for contact info when a customer session resolves to HOUSE", async () => {
    const app = makeApp({ sub: "u1", roles: ["CUSTOMER"] }, HOUSE_WORKSPACE_ID);
    await request(app).get("/");
    expect(custFindOneMock).not.toHaveBeenCalled();
  });

  it("does NOT blank HOUSE's own data for a staff/SUPERADMIN session", async () => {
    const app = makeApp({ sub: "admin1", roles: ["SUPERADMIN"] }, HOUSE_WORKSPACE_ID);
    const res = await request(app).get("/");

    expect(res.body.pan).toBe("AACCC6485E");
    expect(res.body.companyName).toBe("CSTEP Pvt Ltd");
  });

  it("blanks company-info fields when there is no resolved workspace at all", async () => {
    const app = makeApp({ sub: "u1", roles: ["CUSTOMER"] }, "");
    const res = await request(app).get("/");

    expect(res.status).toBe(200);
    expect(res.body.pan).toBe("");
    expect(res.body.companyEmail).toBe("");
    expect(res.body.companyPhone).toBe("");
  });
});
