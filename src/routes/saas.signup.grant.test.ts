// CHANGE 3 — the public signup must not self-grant platform-wide access.
//
// Both /api/saas/signup and /api/signup/* are mounted with NO requireAuth
// (server.ts says so in its own comments), and both used to create a
// UserPermission granting all 34 modules at { access: "FULL", scope: "ALL" },
// roleType "SUPERADMIN". That is the root cause behind leak 1: three of the
// six live holders of invoices:FULL were self-signed-up tenant admins.
//
// Asserts on the document handed to UserPermission.create(), which is the
// artifact that actually confers access.
//
// NO DATABASE — .env points at PROD Atlas.
import { describe, it, expect, vi, beforeEach } from "vitest";

const created: any[] = [];
vi.mock("../models/UserPermission.js", () => ({
  UserPermission: { create: (doc: any) => { created.push(doc); return Promise.resolve(doc); } },
}));

/* Models and side-effecting services the signup route touches.
 * vi.mock factories are hoisted, so each builds its stubs inline. */
vi.mock("../models/CustomerWorkspace.js", () => ({
  default: {
    findOne: () => ({ lean: () => Promise.resolve(null) }),
    getDefaultFeaturesForPlan: () => ({}),
    create: () => Promise.resolve({
      _id: "6a1111111111111111111111",
      customerId: "6a2222222222222222222222",
      save: () => Promise.resolve(),
    }),
  },
}));
vi.mock("../models/User.js", () => ({
  default: {
    exists: () => Promise.resolve(null),
    findOne: () => ({ lean: () => Promise.resolve(null) }),
    create: () => Promise.resolve({ _id: "6a3333333333333333333333", email: "founder@newco.test" }),
  },
}));
vi.mock("../models/TenantSetupProgress.js", () => ({ default: { create: () => Promise.resolve({}) } }));
vi.mock("../utils/mailer.js", () => ({ sendMail: () => Promise.resolve() }));
vi.mock("../services/tenantProvisioning.js", () => ({
  generateSlug: () => "newco",
  ensureUniqueSlug: () => Promise.resolve("newco"),
  provisionNewTenant: () => Promise.resolve(),
}));

import express from "express";
import request from "supertest";
import saasSignupRouter from "./saas.signup.js";
import { LEVEL_TEMPLATES } from "../config/levelTemplates.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/", saasSignupRouter);
  return app;
}

/** Every distinct scope present across a modules object. */
function scopesIn(modules: Record<string, any>): string[] {
  return [...new Set(Object.values(modules ?? {}).map((m: any) => m?.scope))].sort();
}

beforeEach(() => { created.length = 0; });

async function signup() {
  // Field names per SaasSignupSchema in the route: adminEmail, not email.
  const res = await request(makeApp()).post("/signup").send({
    companyName: "NewCo", adminName: "Founder",
    adminEmail: "founder@newco.test", password: "Sup3rSecret!x",
  });
  return res;
}

describe("public SaaS signup — granted permission", () => {
  it("creates exactly one permission document", async () => {
    await signup();
    expect(created).toHaveLength(1);
  });

  it("grants NO cross-tenant scope — nothing is scope ALL", async () => {
    await signup();
    const scopes = scopesIn(created[0].modules);
    expect(scopes).not.toContain("ALL");
    expect(scopes).toEqual(["NONE", "WORKSPACE"]);
  });

  it("does NOT grant invoices — the module behind the 633-invoice leak", async () => {
    await signup();
    expect(created[0].modules.invoices).toEqual({ access: "NONE", scope: "NONE" });
  });

  it("does NOT grant the other Plumtrips-internal billing/ops modules", async () => {
    await signup();
    for (const k of ["manualBookings", "adminQueue", "adminVouchers", "voucherExtract",
                     "directCustomers", "crmContacts", "crmCompanies", "leads",
                     "cstep", "visaApplication", "visaScreening", "vendorManagement"]) {
      expect(created[0].modules[k], `${k} should be NONE`).toEqual({ access: "NONE", scope: "NONE" });
    }
  });

  it("is not roleType SUPERADMIN — that value makes /permissions/me ignore the grant", async () => {
    await signup();
    // routes/permissions.ts:124-150 short-circuits on roleType === 'SUPERADMIN'
    // and answers with every module at FULL/ALL regardless of what is stored,
    // which would leave the whole grant above decorative on the client.
    expect(created[0].roleType).not.toBe("SUPERADMIN");
  });

  it("still grants the HR product they signed up for, workspace-scoped", async () => {
    await signup();
    for (const k of ["people", "leaves", "attendance", "payroll", "payrollAdmin",
                     "onboarding", "policies", "accessConsole", "workspaceSettings"]) {
      expect(created[0].modules[k], `${k} should be FULL/WORKSPACE`)
        .toEqual({ access: "FULL", scope: "WORKSPACE" });
    }
  });

  it("comes from the shared template, not a hand-rolled inline object", async () => {
    await signup();
    expect(created[0].modules).toEqual(LEVEL_TEMPLATES.TENANT_ADMIN);
    expect(created[0].level.code).toBe("TENANT_ADMIN");
  });

  it("keeps universe STAFF so the tenant admin keeps their own console + nav", async () => {
    await signup();
    // Not a loophole: isolation is carried by scope. permissions.ts derives
    // this account's nav from universe==='STAFF' (:166) and forces
    // universe:'STAFF' on /list for non-SuperAdmins (:251), so flipping it
    // would erase them from their own Access Console while closing no hole.
    expect(created[0].universe).toBe("STAFF");
  });

  it("stays instant — the account is active immediately, no approval gate", async () => {
    const res = await signup();
    expect(res.status).toBeLessThan(400);
    expect(created[0].status).toBe("active");
  });
});

describe("TENANT_ADMIN template shape", () => {
  it("is registered, and L0 aliases to it so legacy docs still resolve", () => {
    expect(LEVEL_TEMPLATES.TENANT_ADMIN).toBeTruthy();
    expect(LEVEL_TEMPLATES.L0).toBe(LEVEL_TEMPLATES.TENANT_ADMIN);
  });

  it("contains no ALL scope anywhere", () => {
    expect(scopesIn(LEVEL_TEMPLATES.TENANT_ADMIN as any)).not.toContain("ALL");
  });

  it("differs from L6 (Plumtrips Admin) exactly where it should", () => {
    // L6 is the real staff admin level and legitimately holds invoices FULL/ALL.
    expect((LEVEL_TEMPLATES.L6 as any).invoices).toEqual({ access: "FULL", scope: "ALL" });
    expect((LEVEL_TEMPLATES.TENANT_ADMIN as any).invoices).toEqual({ access: "NONE", scope: "NONE" });
  });
});
