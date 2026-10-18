// apps/backend/src/routes/cstep.projects.test.ts
//
// CSTEP Project Master — routes/cstep.projects.ts, the project pick on all
// four intake forms (routes/cstep.ts applyProjectSelection + validatePayload)
// and the Tally export's Project CC (routes/cstep.tally.ts). Access (manage =
// Admin; read/export = Admin + Finance; the options search = any requester),
// CRUD with a manual unique code, import preview → commit, every form
// refusing a missing / free-text / inactive project and storing the
// snapshot, a pre-master free-text request still rendering and editing, and
// Project CC = the project's tallyProjectCC (else its code).
//
// Real: cstep + projects + tally routers, models, sheetImport, in-memory
//   Mongo REPLICA SET on a fresh database, cstep_qc_project.
// Stubbed: S3, mail, PDF helpers, auth (x-test-user) and the workspace
//   resolver (x-test-ws).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// config/env.ts requires these at import; none of them is ever used here.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_project";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return {};
    }
  },
  PutObjectCommand: class {
    constructor(public input: any) {}
  },
  GetObjectCommand: class {
    constructor(public input: any) {}
  },
}));
vi.mock("../utils/mailer.js", () => ({ sendMail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: vi.fn(async (args: any) => ({ key: `${args.keyPrefix}/qc` })),
  getObjectBuffer: vi.fn(async () => Buffer.from("")),
}));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: vi.fn(async () => "http://qc/presigned") }));
vi.mock("../utils/cstepEventRequestPdf.js", () => ({ uploadCstepEventRequestPdf: vi.fn(async () => ({ key: "qc-event" })) }));
vi.mock("../utils/cstepPacketPdf.js", () => ({ uploadCstepPacketPdf: vi.fn(async () => ({ key: "qc-packet" })) }));

const { default: cstepRouter } = await import("./cstep.js");
const { default: projectsRouter } = await import("./cstep.projects.js");
const { default: tallyRouter } = await import("./cstep.tally.js");

const DB = "cstep_qc_project";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const U = { traveller: oid(), approver: oid(), finance: oid(), admin: oid() };
const TP = oid();
const LEGACY = oid();

const fakeAuth = (req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.workspaceObjectId = new mongoose.Types.ObjectId(String(req.headers["x-test-ws"] || WS));
  next();
};
const app = express();
app.use(express.json());
app.use("/api/cstep/projects", fakeAuth, projectsRouter);
app.use("/api/cstep/tally", fakeAuth, tallyRouter);
app.use("/api/cstep", fakeAuth, cstepRouter);

const who = (id: mongoose.Types.ObjectId, roles = ["REQUESTER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(WS),
});
const ACT = { traveller: who(U.traveller), approver: who(U.approver, ["APPROVER"]), finance: who(U.finance), admin: who(U.admin, ["ADMIN"]) };
const send = (method: "get" | "post" | "put" | "patch" | "delete", as: any, path: string, body?: any) => {
  const r = request(app)[method](`/api/cstep${path}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS));
  return body === undefined ? r : r.send(body);
};
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
const upload = (step: "preview" | "commit", as: any, buf: Buffer, name = "projects.csv") =>
  request(app).post(`/api/cstep/projects/import/${step}`).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(WS)).attach("file", buf, name);
const stage = async () =>
  String(
    ok(
      await request(app)
        .post("/api/cstep/attachments/staging")
        .set("x-test-user", JSON.stringify(ACT.traveller))
        .set("x-test-ws", String(WS))
        .field("documentType", "TAX_INVOICE")
        .attach("file", Buffer.from("%PDF-1.4 qc"), { filename: "inv.pdf", contentType: "application/pdf" }),
    ).body.attachment._id,
  );

const P: Record<string, string> = {};

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri(DB);

  // Step 0 gate: a local server and an empty database, or nothing is seeded.
  const host = new URL(uri.replace(/^mongodb:\/\//, "http://")).hostname;
  if (host !== "127.0.0.1") throw new Error(`Step 0: refusing to seed — host is ${host}, not 127.0.0.1`);
  await mongoose.connect(uri, { autoIndex: false });
  if (mongoose.connection.db!.databaseName !== DB) throw new Error("Step 0: wrong database");
  const existing = await mongoose.connection.db!.listCollections().toArray();
  if (existing.length) throw new Error(`Step 0: refusing to seed — ${DB} is not empty (${existing.length} collections)`);

  await mongoose.connection.syncIndexes();

  const now = new Date();
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(oid()), companyName: "QC CSTEP", config: { features: { cstepEnabled: true } } } as any);
  await col("users").insertMany((Object.keys(U) as Array<keyof typeof U>).map((k) => ({ _id: U[k], email: `${U[k]}@qc.local`, roles: ["REQUESTER"], workspaceId: WS })) as any[]);
  await col("travellerprofiles").insertOne({
    _id: TP, workspaceId: WS, travelerId: "E-001", firstName: "Asha", lastName: "Rao", isActive: true,
    email: `${U.traveller}@qc.local`, claimedBy: U.traveller, tourApproverId: U.approver, financeUserId: U.finance,
  } as any);
  // A request from before the Project Master — free-text project, no projectId.
  await col("csteptravelrequests").insertOne({
    _id: LEGACY, workspaceId: WS, travelerProfileId: TP, createdBy: U.traveller, formType: "TOUR_PROPOSAL", type: "DOMESTIC",
    purpose: "Old tour", project: "Solar rooftops (old text)", departureDate: "2026-11-10", returnDate: "2026-11-11",
    stations: [{ from: "A", to: "B" }], status: "DRAFT", createdAt: now, updatedAt: now,
  } as any);
}, 240_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

describe("Project Master — access and CRUD", () => {
  it("manage is Admin only; read is Admin + Finance; the Requester and the Approver get 403", async () => {
    for (const as of [ACT.traveller, ACT.approver]) {
      expect((await send("get", as, "/projects")).status).toBe(403);
      expect((await send("get", as, "/projects/export")).status).toBe(403);
      expect((await send("post", as, "/projects", { projectCode: "X", projectName: "X" })).status).toBe(403);
    }
    // Finance is a mapping (TravellerProfile.financeUserId), not a role.
    expect(ok(await send("get", ACT.finance, "/projects")).body).toMatchObject({ ok: true, canEdit: false, projects: [] });
    expect((await send("post", ACT.finance, "/projects", { projectCode: "X", projectName: "X" })).status).toBe(403);
    expect((await send("get", ACT.finance, "/projects/template")).status).toBe(403);
  });

  it("creates with a manual code — trimmed, uppercased, unique — and validates", async () => {
    const r = ok(await send("post", ACT.admin, "/projects", { projectCode: " prj-solar ", projectName: "Rooftop Solar", tallyProjectCC: "130 OAK 06" })).body.project;
    expect(r).toMatchObject({ projectCode: "PRJ-SOLAR", projectName: "Rooftop Solar", tallyProjectCC: "130 OAK 06", isActive: true });
    P.solar = String(r._id);
    P.grid = String(ok(await send("post", ACT.admin, "/projects", { projectCode: "PRJ-GRID", projectName: "Grid Integration" })).body.project._id);

    expect((await send("post", ACT.admin, "/projects", { projectCode: "prj-solar", projectName: "Dup" })).status).toBe(409);
    expect((await send("post", ACT.admin, "/projects", { projectCode: "", projectName: "No code" })).body.error).toBe("Project code is required");
    expect((await send("post", ACT.admin, "/projects", { projectCode: "BAD*CODE", projectName: "X" })).status).toBe(400);
    expect((await send("post", ACT.admin, "/projects", { projectCode: "PRJ-X" })).body.error).toBe("Project name is required");
  });

  it("edits name / cost centre / active; the code is fixed", async () => {
    const r = ok(await send("put", ACT.admin, `/projects/${P.grid}`, { tallyProjectCC: "140 GRD 01" })).body.project;
    expect(r).toMatchObject({ projectCode: "PRJ-GRID", tallyProjectCC: "140 GRD 01" });
    expect((await send("put", ACT.admin, `/projects/${P.grid}`, { projectCode: "PRJ-NEW" })).status).toBe(400);
    expect((await send("put", ACT.finance, `/projects/${P.grid}`, { projectName: "X" })).status).toBe(403);
  });

  it("import: preview writes nothing; commit creates and updates by code, skipping bad rows", async () => {
    const csv = Buffer.from(
      [
        "Project Code,Project Name,Tally Project CC,Active",
        "PRJ-EMOB,E-mobility,150 EMB 02,Yes", //          create
        "prj-solar,,131 OAK 07,", //                      update (code matches; blank name kept)
        ",Nameless,,", //                                 no code
        "PRJ-NEW,,,", //                                  new without a name
        "PRJ-EMOB,Again,,", //                            same code twice
        "PRJ-OLD,Old Programme,,maybe", //                bad Active
        "PRJ-OLD2,Retired Programme,,No", //              create, inactive
      ].join("\n") + "\n",
    );
    const pv = ok(await upload("preview", ACT.admin, csv)).body;
    expect(pv).toMatchObject({ created: 2, updated: 1, skipped: 4 });
    expect(pv.results.filter((r: any) => r.action === "skip").map((r: any) => r.reason)).toEqual([
      "Project code is required",
      "Project Name is required for a new project",
      "Project Code PRJ-EMOB is also on row 2 of this file",
      'Active must be Yes or No, not "maybe"',
    ]);
    expect(await col("cstepprojects").countDocuments({})).toBe(2);
    expect((await upload("preview", ACT.finance, csv)).status).toBe(403);

    ok(await upload("commit", ACT.admin, csv));
    const all = await col("cstepprojects").find({}).sort({ projectCode: 1 }).toArray();
    expect(all.map((p: any) => [p.projectCode, p.projectName, p.tallyProjectCC ?? "", p.isActive])).toEqual([
      ["PRJ-EMOB", "E-mobility", "150 EMB 02", true],
      ["PRJ-GRID", "Grid Integration", "140 GRD 01", true],
      ["PRJ-OLD2", "Retired Programme", "", false],
      ["PRJ-SOLAR", "Rooftop Solar", "131 OAK 07", true],
    ]);
    P.retired = String(all[2]._id);
  });

  it("export (Admin / Finance) has the template columns with the codes as text", async () => {
    const r = await binary(request(app).get("/api/cstep/projects/export").set("x-test-user", JSON.stringify(ACT.finance)).set("x-test-ws", String(WS)));
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as any);
    const ws = wb.worksheets[0];
    expect((ws.getRow(1).values as any[]).slice(1)).toEqual(["Project Code", "Project Name", "Tally Project CC", "Active"]);
    expect(ws.actualRowCount).toBe(5);
    expect(ws.getColumn(1).numFmt).toBe("@");
    expect(ws.getColumn(3).numFmt).toBe("@");
  });

  it("the options search is open to a Requester: active projects only, by code or name, code prefix first", async () => {
    const all = ok(await send("get", ACT.traveller, "/projects/options")).body.projects;
    expect(all.map((p: any) => p.projectCode)).toEqual(["PRJ-EMOB", "PRJ-GRID", "PRJ-SOLAR"]); // PRJ-OLD2 is inactive
    expect(Object.keys(all[0]).sort()).toEqual(["_id", "projectCode", "projectName"]);
    expect(ok(await send("get", ACT.approver, "/projects/options?q=grid")).body.projects.map((p: any) => p.projectCode)).toEqual(["PRJ-GRID"]);
    expect(ok(await send("get", ACT.traveller, "/projects/options?q=solar")).body.projects.map((p: any) => p.projectName)).toEqual(["Rooftop Solar"]);
  });
});

describe("intake forms — a project picked from the master, snapshotted", () => {
  const bodies = async (): Promise<Record<string, any>> => ({
    TOUR_PROPOSAL: { type: "DOMESTIC", purpose: "QC tour", departureDate: "2026-11-10", returnDate: "2026-11-11", stations: [{ from: "Bengaluru", to: "Pune" }] },
    EVENT_REQUEST: {
      formType: "EVENT_REQUEST", purpose: "QC workshop", departureDate: "2026-11-02", returnDate: "2026-11-04",
      hostInstitution: "QC Institute", eventNature: "WORKSHOP", eventLocation: "Bengaluru", eventParticipants: [{ organisation: "CSTEP" }],
    },
    LOCAL_TRAVEL_CLAIM: {
      formType: "LOCAL_TRAVEL_CLAIM", purpose: "City meetings", departureDate: "2026-10-05", returnDate: "2026-10-09",
      travelLines: [], foodLines: [], otherExpenses: 80,
    },
    EXPENSE_CLAIM: {
      formType: "EXPENSE_CLAIM", purpose: "Workshop materials", departureDate: "2026-10-12", returnDate: "2026-10-16",
      expenseLines: [{ date: "2026-10-12", description: "Stationery", amount: 300 }], invoiceAttachmentIds: [await stage()],
    },
  });

  it("every form refuses a missing project, a free-text one, an unknown and an inactive one", async () => {
    for (const [formType, body] of Object.entries(await bodies())) {
      const missing = await send("post", ACT.traveller, "/requests", body);
      expect([formType, missing.status, missing.body.error]).toEqual([formType, 400, "Choose a project"]);
      expect((await send("post", ACT.traveller, "/requests", { ...body, project: "Free text" })).body.error).toBe("Choose a project");
      expect((await send("post", ACT.traveller, "/requests", { ...body, projectId: String(oid()) })).body.error).toBe("Unknown project");
      expect((await send("post", ACT.traveller, "/requests", { ...body, projectId: P.retired })).body.error).toBe("Project PRJ-OLD2 is inactive — choose another");
    }
    expect(await col("csteptravelrequests").countDocuments({})).toBe(1); // only the legacy one
  });

  it("every form stores the picked project's snapshot", async () => {
    for (const [formType, body] of Object.entries(await bodies())) {
      const doc = ok(await send("post", ACT.traveller, "/requests", { ...body, projectId: P.solar })).body.request;
      expect([formType, doc.projectId, doc.projectCode, doc.projectName, doc.projectTallyCC, doc.project]).toEqual([
        formType, P.solar, "PRJ-SOLAR", "Rooftop Solar", "131 OAK 07", "PRJ-SOLAR — Rooftop Solar",
      ]);
      P[formType] = String(doc._id);
    }
  });

  it("editing re-snapshots; a later rename in the master leaves the request alone", async () => {
    // Back to the traveller as RETURNED so it is editable.
    await col("csteptravelrequests").updateOne({ _id: new mongoose.Types.ObjectId(P.TOUR_PROPOSAL) }, { $set: { status: "RETURNED" } });
    const r = ok(await send("patch", ACT.traveller, `/requests/${P.TOUR_PROPOSAL}`, { projectId: P.grid })).body.request;
    expect(r).toMatchObject({ projectCode: "PRJ-GRID", projectName: "Grid Integration", projectTallyCC: "140 GRD 01", project: "PRJ-GRID — Grid Integration" });
    ok(await send("put", ACT.admin, `/projects/${P.grid}`, { projectName: "Grid Integration Phase 2" }));
    const after: any = await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(P.TOUR_PROPOSAL) });
    expect(after.projectName).toBe("Grid Integration");
    // An approver can't amend the project raw.
    expect((await send("post", ACT.approver, `/requests/${P.EVENT_REQUEST}/amend`, { field: "projectId", newValue: P.grid, reason: "x" })).status).toBe(400);
  });

  it("a project a request uses can't be deleted (deactivate instead); an unused one can", async () => {
    expect((await send("delete", ACT.admin, `/projects/${P.solar}`)).status).toBe(409);
    expect(ok(await send("delete", ACT.admin, `/projects/${P.retired}`)).body.ok).toBe(true);
  });

  it("a pre-master free-text request still renders and edits; its project text is untouched", async () => {
    const g = ok(await send("get", ACT.traveller, `/requests/${LEGACY}`)).body.request;
    expect(g.project).toBe("Solar rooftops (old text)");
    expect(g.projectId).toBeUndefined();
    const e = ok(await send("patch", ACT.traveller, `/requests/${LEGACY}`, { purpose: "Old tour, edited", project: "ignored" })).body.request;
    expect(e).toMatchObject({ purpose: "Old tour, edited", project: "Solar rooftops (old text)" });
    ok(await send("post", ACT.traveller, `/requests/${LEGACY}/submit`));
  });
});

describe("Tally export — Project CC from the project", () => {
  it("is the project's tallyProjectCC, else its code; a legacy request keeps its text", async () => {
    // EMOB has a cost centre; a project without one, and the legacy tour.
    const noCc = String(ok(await send("post", ACT.admin, "/projects", { projectCode: "PRJ-NOCC", projectName: "No cost centre" })).body.project._id);
    const emob = String((await col("cstepprojects").findOne({ projectCode: "PRJ-EMOB" }))!._id);
    const tour = async (projectId: string) =>
      String(ok(await send("post", ACT.traveller, "/requests", {
        type: "DOMESTIC", purpose: `Tally ${projectId}`, departureDate: "2026-11-10", returnDate: "2026-11-11", stations: [{ from: "A", to: "B" }], projectId,
      })).body.request._id);
    const ids = { emob: await tour(emob), noCc: await tour(noCc), legacy: String(LEGACY) };

    ok(await send("put", ACT.admin, "/tally/settings", { companyName: "CSTEP", defaultLedger: "Travel Expenses" }));
    const vendor = oid();
    await col("cstepvendors").insertOne({ _id: vendor, workspaceId: WS, vendorCode: "CSTEPVEN0001", name: "Skyline", vendorTypeId: oid(), isActive: true } as any);
    const paidAt = new Date("2026-10-15T06:30:00Z");
    await col("csteparrangements").insertMany(
      Object.values(ids).map((rid, i) => ({
        workspaceId: WS, requestId: new mongoose.Types.ObjectId(rid), source: "ADDED", arrangedType: "FLIGHT", status: "ARRANGED",
        currency: "INR", amount: 1000 + i, amountInr: 1000 + i, vendorId: vendor, vendorCode: "CSTEPVEN0001", vendorName: "Skyline",
        paymentStatus: "PAID", paidAt, paymentRef: `UTR${i}`, createdBy: U.admin, createdAt: paidAt, updatedAt: paidAt,
      })) as any[],
    );

    const r = await binary(request(app).get("/api/cstep/tally/export?from=2026-10-15&to=2026-10-15").set("x-test-user", JSON.stringify(ACT.finance)).set("x-test-ws", String(WS)));
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as any);
    const cc = new Map<number, string>();
    wb.worksheets[0].eachRow((row, n) => {
      if (n > 1) cc.set(Number(row.getCell(15).value), String(row.getCell(8).value ?? ""));
    });
    expect(cc.get(1000)).toBe("150 EMB 02"); // tallyProjectCC
    expect(cc.get(1001)).toBe("PRJ-NOCC"); //   no cost centre → the code
    expect(cc.get(1002)).toBe("Solar rooftops (old text)"); // legacy free text
  });
});
