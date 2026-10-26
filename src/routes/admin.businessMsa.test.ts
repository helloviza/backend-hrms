// apps/backend/src/routes/admin.businessMsa.test.ts
//
// "Download MSA" on /profile/businesses: the real template filled for a sample
// business, and GET /api/admin/businesses/:id/msa.docx behind the page's gate.
//
// Real: router, requireHouse/requireAdmin, models, template, docxtemplater, in-memory Mongo.
// Stubbed: requireAuth (user from a header), requireWorkspace (workspace from a header).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import fs from "fs";
import PizZip from "pizzip";
import { buildMsaValues, renderMsaDocx, msaFilename, MSA_BLANK, MSA_TEMPLATE_PATH } from "../services/msaDocx.js";

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

const { default: msaRouter } = await import("./admin.businessMsa.js");
const app = express();
app.use("/api/admin/businesses", msaRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const ACME_WS = oid();
const ACME = oid();
const ONB = oid();

type Who = { roles: string[]; ws: any };
const as = (r: request.Test, who: Who) =>
  r
    .set("x-test-user", JSON.stringify({ sub: String(oid()), email: "staff@plumtrips.test", roles: who.roles }))
    .set("x-test-ws", String(who.ws));
const HOUSE_ADMIN: Who = { roles: ["ADMIN"], ws: HOUSE };
const HOUSE_EMPLOYEE: Who = { roles: ["EMPLOYEE"], ws: HOUSE };
const TENANT_ADMIN: Who = { roles: ["ADMIN"], ws: ACME_WS };
const CUSTOMER_USER: Who = { roles: ["CUSTOMER"], ws: ACME_WS };

const SAMPLE_CUSTOMER = {
  name: "Acme",
  legalName: "Acme Industries Pvt. Ltd.",
  cin: "U12345KA2020PTC123456",
  industry: "Industrial automation",
  gstNumber: "29ABCDE1234F1Z5",
  panNumber: "ABCDE1234F",
  address: { street: "12 MG Road", city: "Bengaluru", state: "Karnataka", country: "India", pincode: "560001" },
  keyContacts: [{ name: "Riya Rao", email: "riya@acme.test", mobile: "+91 98450 00000" }],
};
const SAMPLE_PAYLOAD = { signatory: { name: "Arjun Mehta", designation: "Director" } };

/** Text of the document body, runs joined — what a reader of the .docx sees. */
function bodyText(buf: Buffer): string {
  const xml = new PizZip(buf).file("word/document.xml")!.asText();
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&");
}

describe("MSA generation", () => {
  it("fills client fields, blanks the rest, leaves no placeholders", () => {
    const buf = renderMsaDocx(buildMsaValues(SAMPLE_CUSTOMER, SAMPLE_PAYLOAD));
    // valid docx: a zip with the main document part, re-openable
    const zip = new PizZip(buf);
    expect(zip.file("[Content_Types].xml")).toBeTruthy();
    expect(zip.file("word/document.xml")).toBeTruthy();

    const text = bodyText(buf);
    expect(text).toContain("Acme Industries Pvt. Ltd.");
    expect(text).toContain("U12345KA2020PTC123456");
    expect(text).toContain("12 MG Road, Bengaluru, Karnataka, India, 560001");
    expect(text).toContain("Industrial automation");
    expect(text).toContain("29ABCDE1234F1Z5");
    expect(text).toContain("ABCDE1234F");
    expect(text).toContain("Arjun Mehta");
    expect(text).toContain("Director");
    expect(text).toContain("riya@acme.test");
    expect(text).toContain("Activated / Not Activated");
    expect(text).not.toMatch(/\{[A-Za-z0-9_]+\}/);
    expect(text).not.toContain("{");
    expect(text).not.toContain("undefined");
    // unfilled commercial / sp_rep placeholders print as the blank line
    expect(text).toContain(MSA_BLANK);
    // template's own signing blanks are untouched ("this ______ day of ____________, 20____")
    expect(text).toContain("this ______ day of ____________, 20____");
    const signingBlanks = (t: string) => (t.match(/(Date|Place): _{22}\n/g) || []).length;
    expect(signingBlanks(text)).toBeGreaterThan(0);
    expect(signingBlanks(text)).toBe(signingBlanks(bodyText(fs.readFileSync(MSA_TEMPLATE_PATH))));
  });

  it("missing client fields render as underscores", () => {
    const text = bodyText(renderMsaDocx(buildMsaValues({ name: "Bare Co" }, {})));
    expect(text).toContain("Bare Co");
    expect(text).toContain(`(CIN: ${MSA_BLANK})`);
    expect(text).not.toContain("{");
    expect(text).not.toContain("undefined");
  });

  it("filename keeps safe characters only", () => {
    expect(msaFilename("Acme Industries Pvt. Ltd.", "2026-10-27")).toBe(
      "Plumtrips_MSA_Acme_Industries_Pvt_Ltd_2026-10-27.docx",
    );
    expect(msaFilename('Mölnlycke "Health" / Care', "2026-10-27")).toBe(
      "Plumtrips_MSA_Molnlycke_Health_Care_2026-10-27.docx",
    );
    expect(msaFilename("", "2026-10-27")).toBe("Plumtrips_MSA_Client_2026-10-27.docx");
  });
});

describe("GET /api/admin/businesses/:id/msa.docx", () => {
  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri("admin-business-msa-test"));
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod?.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.db!.dropDatabase();
    await col("customerworkspaces").insertMany([
      { _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE" },
      { _id: ACME_WS, customerId: String(ACME), name: "Acme", status: "ACTIVE" },
    ] as any[]);
    await col("onboardings").insertOne({ _id: ONB, type: "business", formPayload: SAMPLE_PAYLOAD } as any);
    await col("customers").insertOne({
      _id: ACME,
      ...SAMPLE_CUSTOMER,
      workspaceId: ACME_WS,
      onboardingId: ONB,
      status: "ACTIVE",
    } as any);
  });

  const url = (id: any) => `/api/admin/businesses/${id}/msa.docx`;
  const binary = (r: request.Test) =>
    r.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });

  it("staff get the filled docx and the download is audited", async () => {
    const res = await binary(as(request(app).get(url(ACME)), HOUSE_ADMIN));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="Plumtrips_MSA_Acme_Industries_Pvt_Ltd_\d{4}-\d{2}-\d{2}\.docx"$/,
    );
    const text = bodyText(res.body as Buffer);
    expect(text).toContain("Acme Industries Pvt. Ltd.");
    expect(text).toContain("Arjun Mehta"); // signatory from the onboarding formPayload

    const audit = await col("workspaceauditlogs").findOne({ event: "MSA_DOWNLOADED" });
    expect(audit?.details?.customerId).toBe(String(ACME));
    expect(audit?.triggeredBy).toBe("staff@plumtrips.test");
  });

  it("non-staff are refused", async () => {
    for (const who of [TENANT_ADMIN, CUSTOMER_USER, HOUSE_EMPLOYEE]) {
      const res = await as(request(app).get(url(ACME)), who);
      expect([403, 404]).toContain(res.status);
    }
    expect(await col("workspaceauditlogs").countDocuments()).toBe(0);
  });

  it("unknown or malformed id is 404", async () => {
    expect((await as(request(app).get(url(oid())), HOUSE_ADMIN)).status).toBe(404);
    expect((await as(request(app).get(url("not-an-id")), HOUSE_ADMIN)).status).toBe(404);
  });
});
