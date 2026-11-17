// apps/backend/src/routes/invoices.internalCopy.test.ts
//
// "Download internal copy" (GET /api/admin/invoices/:id/internal-copy):
//   • an ALL_INCLUSIVE invoice rendered in the Separate layout, stamped
//     INTERNAL COPY – NOT A TAX INVOICE – NOT FOR CUSTOMER on every page;
//   • never stored: no S3 write, invoice.pdfUrl untouched;
//   • customer paths (workspace PDF route, default render, bulk zip) stay
//     All-inclusive and carry no stamp;
//   • Plumtrips staff only: same invoices READ grant as viewing; a tenant
//     user who can view the invoice still gets 403; Separate invoices 400.
//
// Real: invoices routers, generation service, PDF, models, in-memory Mongo.
// Stubbed: requireAuth / requireWorkspace (headers), the S3 client (records
// writes). The PDF checks spy on PDFKit's text() — calls go through unchanged.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const s3Puts: string[] = [];
vi.mock("@aws-sdk/client-s3", async (orig) => {
  const real = await orig<any>();
  class S3Client {
    async send(cmd: any) {
      s3Puts.push(String(cmd?.input?.Key ?? ""));
      return {};
    }
  }
  return { ...real, S3Client };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (_c: any, cmd: any) => `https://signed.test/${cmd?.input?.Key}`,
}));
vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: (req: any, _res: any, next: any) => {
    const id = String(req.headers["x-test-ws"] || "");
    req.workspaceId = id;
    req.workspaceObjectId = new mongoose.Types.ObjectId(id);
    const cust = req.headers["x-test-customer"];
    if (cust) req.workspace = { customerId: String(cust) };
    next();
  },
}));

const { default: invoicesRouter, workspaceRouter } = await import("./invoices.js");
// server.ts mounts requireWorkspace in front of the admin router (not inside it).
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { generateInvoicePdf, INTERNAL_COPY_LABEL } = await import("../utils/invoicePdf.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { UserPermission } = await import("../models/UserPermission.js");
const PDFDocument = (await import("pdfkit")).default;

const app = express();
app.use(express.json());
app.use("/api/admin/invoices", requireWorkspace, invoicesRouter);
app.use("/api/invoices/workspace", workspaceRouter);

let mongod: MongoMemoryReplSet;
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const SUPER = new mongoose.Types.ObjectId();
const HOUSE_STAFF = new mongoose.Types.ObjectId();
const HOUSE_NO_GRANT = new mongoose.Types.ObjectId();
const TENANT_USER = new mongoose.Types.ObjectId();
const userHdr = (id: any, roles: string[] = []) => JSON.stringify({ _id: String(id), id: String(id), sub: String(id), roles });
const asSuper = (r: request.Test) => r.set("x-test-user", userHdr(SUPER, ["SUPERADMIN"])).set("x-test-ws", String(HOUSE));
const asHouse = (r: request.Test, id = HOUSE_STAFF) => r.set("x-test-user", userHdr(id, ["ADMIN"])).set("x-test-ws", String(HOUSE));
const col = (n: string) => mongoose.connection.db!.collection(n);

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("invoice-internal-copy-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  s3Puts.length = 0;
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await col("companysettings").insertOne({
    companyName: "Plumtrips", invoiceSeriesCadence: "annual", supplierState: "Karnataka",
    gstProfiles: [{ gstin: "29ABCDE1234F1Z5", state: "Karnataka", stateCode: "29", legalName: "Plumtrips KA", addressLine1: "", addressLine2: "", city: "Bengaluru", pincode: "560001", isDefault: true, active: true, invoiceSeriesPrefix: "" }],
  } as any);
  const grant = (userId: any, workspaceId: string, universe: "STAFF" | "CUSTOMER") => UserPermission.create({
    userId: String(userId), email: `${userId}@test.local`, workspaceId, universe,
    level: { code: "L4", name: "Test" }, modules: { invoices: { access: "READ", scope: "ALL" } }, grantedBy: String(SUPER),
  });
  await grant(HOUSE_STAFF, "house", "STAFF");
});

let seq = 0;
async function b2cInvoice(layout: "ALL_INCLUSIVE" | "SEPARATE" = "ALL_INCLUSIVE") {
  const c: any = await Customer.create({ name: "B2C", legalName: "B2C Traveller", gstStatus: "UNREGISTERED", gstRegisteredState: "Karnataka" });
  const ws: any = await CustomerWorkspace.create({ customerId: String(c._id), companyName: c.legalName });
  seq += 1;
  const b: any = await ManualBooking.create({
    workspaceId: c._id, bookedBy: SUPER, type: "FLIGHT", supplierName: "TBO", givenBy: "Ops",
    status: "CONFIRMED", bookingRef: `MB-IC-${seq}`,
    travelDate: new Date("2026-11-20T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
    itinerary: { origin: "BLR", destination: "DEL", airline: "6E", flightNo: "6E-123" },
    pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 9600, quotedPrice: 10000 },
  });
  const r = await asSuper(request(app).post("/api/admin/invoices/generate"))
    .send({ bookingIds: [String(b._id)], invoiceDate: "2026-11-17", invoiceFormat: layout });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { invoice: r.body.invoice, customer: c, workspace: ws };
}

async function textOf(run: () => Promise<unknown>): Promise<string[]> {
  const spy = vi.spyOn(PDFDocument.prototype as any, "text");
  try {
    await run();
    return spy.mock.calls.map((a: any[]) => String(a[0]));
  } finally {
    spy.mockRestore();
  }
}
const binary = (r: request.Test) => r.buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
});

describe("internal copy: watermark + Separate layout", () => {
  it("streams the Separate breakdown stamped INTERNAL COPY, and stores nothing", async () => {
    const { invoice } = await b2cInvoice();
    let res: any;
    const t = await textOf(async () => { res = await binary(asSuper(request(app).get(`/api/admin/invoices/${invoice._id}/internal-copy`))); });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toContain(`${invoice.invoiceNo}-INTERNAL-COPY.pdf`);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.subarray(0, 5).toString()).toBe("%PDF-");

    // Stamp: top + bottom band on the page, diagonal watermark, title.
    expect(t.filter((s) => s === INTERNAL_COPY_LABEL).length).toBeGreaterThanOrEqual(2);
    expect(t).toContain("INTERNAL COPY");
    expect(t).toContain("NOT A TAX INVOICE – NOT FOR CUSTOMER");
    expect(t).not.toContain("TAX INVOICE");
    // Separate layout: itemised tax rows, no All-inclusive note.
    expect(t.some((s) => /Sub Total/i.test(s))).toBe(true);
    expect(t.some((s) => /^CGST/.test(s))).toBe(true);
    expect(t.some((s) => /Amount inclusive of all taxes/i.test(s))).toBe(false);

    // Never stored as the invoice's PDF.
    expect(s3Puts).toEqual([]);
    const raw: any = await col("invoices").findOne({ _id: new mongoose.Types.ObjectId(invoice._id) });
    expect(raw.pdfUrl ?? null).toBeNull();
    expect(raw.invoiceLayout).toBe("ALL_INCLUSIVE");
  });

  it("HOUSE staff with the invoices READ grant (the viewing permission) can download it", async () => {
    const { invoice } = await b2cInvoice();
    const r = await binary(asHouse(request(app).get(`/api/admin/invoices/${invoice._id}/internal-copy`)));
    expect(r.status).toBe(200);
  });

  it("a Separate invoice has no internal copy (400)", async () => {
    const { invoice } = await b2cInvoice("SEPARATE");
    const r = await asSuper(request(app).get(`/api/admin/invoices/${invoice._id}/internal-copy`));
    expect(r.status).toBe(400);
  });
});

describe("customer paths unaffected", () => {
  it("workspace PDF route (the customer's download) stays All-inclusive, no stamp", async () => {
    const { invoice, workspace, customer } = await b2cInvoice();
    let r: any;
    const t = await textOf(async () => {
      r = await request(app).post(`/api/invoices/workspace/${invoice._id}/pdf`)
        .set("x-test-user", userHdr(TENANT_USER, ["WORKSPACE_LEADER"]))
        .set("x-test-ws", String(workspace._id)).set("x-test-customer", String(customer._id));
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(t).toContain("TAX INVOICE");
    expect(t.some((s) => s.includes("INTERNAL COPY"))).toBe(false);
    expect(t.some((s) => /Amount inclusive of all taxes/i.test(s))).toBe(true);
    expect(t.some((s) => /Sub Total/i.test(s))).toBe(false);
    expect(s3Puts).toEqual([`invoices/${invoice.invoiceNo}.pdf`]);
  });

  it("the default render and the bulk zip carry no stamp", async () => {
    const { invoice } = await b2cInvoice();
    const raw: any = await col("invoices").findOne({ _id: new mongoose.Types.ObjectId(invoice._id) });
    const t1 = await textOf(() => generateInvoicePdf(raw));
    const t2 = await textOf(() => binary(asSuper(request(app).get("/api/admin/invoices/bulk-pdf"))));
    for (const t of [t1, t2]) {
      expect(t).toContain("TAX INVOICE");
      expect(t.some((s) => s.includes("INTERNAL COPY"))).toBe(false);
      expect(t.some((s) => /Amount inclusive of all taxes/i.test(s))).toBe(true);
    }
  });

  it("only the internal-copy route asks for an internal copy (no mailer, portal or storage path)", () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
          const n = (fs.readFileSync(p, "utf8").match(/internalCopy:\s*true/g) || []).length;
          if (n) hits.push(`${path.relative(srcRoot, p).replace(/\\/g, "/")}:${n}`);
        }
      }
    };
    walk(srcRoot);
    expect(hits).toEqual(["routes/invoices.ts:1"]);
  });
});

describe("403 for customers", () => {
  it("a tenant user who can view the invoice in admin still gets 403 for the internal copy", async () => {
    const { invoice, workspace, customer } = await b2cInvoice();
    await UserPermission.create({
      userId: String(TENANT_USER), email: "tenant@test.local", workspaceId: String(workspace._id), universe: "CUSTOMER",
      level: { code: "L2", name: "Tenant" }, modules: { invoices: { access: "READ", scope: "ALL" } }, grantedBy: String(SUPER),
    });
    // A customer company's own admin: requireBillingStaff admits it (read-only).
    const asTenant = (r: request.Test) => r.set("x-test-user", userHdr(TENANT_USER, ["ADMIN"]))
      .set("x-test-ws", String(workspace._id)).set("x-test-customer", String(customer._id));

    // Same grant, same invoice: viewing works…
    expect((await asTenant(request(app).get(`/api/admin/invoices/${invoice._id}`))).status).toBe(200);
    // …the internal copy does not.
    const r = await asTenant(request(app).get(`/api/admin/invoices/${invoice._id}/internal-copy`));
    expect(r.status).toBe(403);
    expect(s3Puts).toEqual([]);
  });

  it("no invoices grant → 403 (HOUSE staff too)", async () => {
    const { invoice } = await b2cInvoice();
    const r = await asHouse(request(app).get(`/api/admin/invoices/${invoice._id}/internal-copy`), HOUSE_NO_GRANT);
    expect(r.status).toBe(403);
  });
});
