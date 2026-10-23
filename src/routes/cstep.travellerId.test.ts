// apps/backend/src/routes/cstep.travellerId.test.ts
//
// CSTEP: Traveller ID = Employee ID. A cstepEnabled workspace never mints a
// <CODE>-NNN id: single create requires the employee id (stored as
// travelerId, mirrored into employeeId, trimmed + uppercased, 409 on a
// duplicate), the bulk import reads an "Employee ID" column, and booking
// auto-capture leaves the id blank — and that traveller still approves.
// CustomerMember.travelerId (unique across every tenant) never receives an
// employee id. A non-CSTEP workspace still mints exactly as before. The
// partial unique index takes any number of blanks but no duplicate
// non-blank; the deploy migration moves the old full index onto it; the
// re-map script dry-runs, refuses bad files, and applies a reviewed plan
// including a swap.
//
// Real: workspace.travellers + cstep routers, models, in-memory Mongo
//   REPLICA SET (approve and the re-map run in transactions) on a fresh
//   database, cstep_qc_travid.
// Stubbed: auth/workspace middleware (x-test-user / x-test-ws headers), S3,
//   mail, the CSTEP PDF helpers.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/cstep_qc_travid";
process.env.JWT_SECRET ||= "qc";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET ||= "qc-unused";
process.env.GEMINI_API_KEY ||= "qc-unused";
delete process.env.CSTEP_NOTIFICATIONS_ENABLED;

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return {};
    }
  },
  PutObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
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

const { default: travellerRouter } = await import("./workspace.travellers.js");
const { default: cstepRouter } = await import("./cstep.js");
const { default: TravellerProfile } = await import("../models/TravellerProfile.js");
const { cstepMMYY } = await import("../utils/cstepSequence.js");
const { migrateTravelerIdIndex, TRAVELER_ID_INDEX_NAME } = await import("../services/cstepTravellerIds.js");
const { runRemap } = await import("../scripts/cstep-remap-traveller-ids.js");

const DB = "cstep_qc_travid";
const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);

// C = CSTEP workspace, N = ordinary workspace, R = CSTEP workspace for the re-map.
const WS = { C: oid(), N: oid(), R: oid() };
const QC_PROJECT_C = oid();
const CUST = { C: oid(), N: oid(), R: oid() };
const WS_CUSTOMER: Record<string, string> = {
  [String(WS.C)]: String(CUST.C),
  [String(WS.N)]: String(CUST.N),
  [String(WS.R)]: String(CUST.R),
};
const U = { leaderC: oid(), leaderN: oid(), requesterC: oid(), captured: oid(), approver: oid() };
const MEMBER_C_LINKED = oid();
const MEMBER_N_LINKED = oid();

const app = express();
app.use(express.json());
app.use((req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  const ws = String(req.headers["x-test-ws"] || WS.C);
  req.workspaceObjectId = new mongoose.Types.ObjectId(ws);
  req.workspaceId = ws;
  req.workspace = { _id: req.workspaceObjectId, customerId: WS_CUSTOMER[ws], status: "ACTIVE" };
  next();
});
app.use("/api/travellers", travellerRouter);
app.use("/api/cstep", cstepRouter);

const who = (id: mongoose.Types.ObjectId, ws: mongoose.Types.ObjectId, roles = ["CUSTOMER"]) => ({
  _id: String(id), id: String(id), sub: String(id), email: `${id}@qc.local`, roles, workspaceId: String(ws),
});
const ACT = {
  leaderC: who(U.leaderC, WS.C),
  leaderN: who(U.leaderN, WS.N),
  requesterC: who(U.requesterC, WS.C),
  captured: who(U.captured, WS.C),
  approver: who(U.approver, WS.C, ["APPROVER"]),
};
const call = (method: "get" | "post" | "put", as: any, ws: mongoose.Types.ObjectId, path: string) =>
  request(app)[method](path).set("x-test-user", JSON.stringify(as)).set("x-test-ws", String(ws));
const ok = (r: request.Response) => {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const csvFile = (lines: string[]) => Buffer.from(lines.join("\n") + "\n");
const bulk = (as: any, ws: mongoose.Types.ObjectId, step: "preview" | "commit", lines: string[]) =>
  call("post", as, ws, `/api/travellers/bulk/${step}`).attach("file", csvFile(lines), { filename: "t.csv", contentType: "text/csv" });
const profiles = (filter: any) => col("travellerprofiles").find(filter).toArray();
const waitFor = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("waitFor timed out");
};

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
  // Project Master — a request needs a project; one for workspace C.
  await col("cstepprojects").insertOne({ _id: QC_PROJECT_C, workspaceId: WS.C, projectCode: "PRJ-QC", projectName: "QC Project", isActive: true } as any);

  await col("customerworkspaces").insertMany([
    { _id: WS.C, customerId: String(CUST.C), companyName: "QC CSTEP", status: "ACTIVE", config: { features: { cstepEnabled: true } } },
    { _id: WS.N, customerId: String(CUST.N), companyName: "Northwind", status: "ACTIVE", config: { features: { cstepEnabled: false } } },
    { _id: WS.R, customerId: String(CUST.R), companyName: "QC CSTEP Remap", status: "ACTIVE", config: { features: { cstepEnabled: true } } },
  ] as any[]);
  await col("customers").insertMany([
    { _id: CUST.C, name: "Centre Study Labs", legalName: "Centre Study Labs" },
    { _id: CUST.N, name: "Northwind Traders", legalName: "Northwind Traders" },
    { _id: CUST.R, name: "Remap Labs", legalName: "Remap Labs" },
  ] as any[]);
  await col("customermembers").insertMany([
    { customerId: String(CUST.C), email: ACT.leaderC.email, role: "WORKSPACE_LEADER", isActive: true, travelerId: "" },
    { customerId: String(CUST.C), email: ACT.requesterC.email, role: "REQUESTER", isActive: true, travelerId: "" },
    { _id: MEMBER_C_LINKED, customerId: String(CUST.C), email: "linked.c@qc.local", role: "REQUESTER", isActive: true, travelerId: "CSL-007" },
    { customerId: String(CUST.N), email: ACT.leaderN.email, role: "WORKSPACE_LEADER", isActive: true, travelerId: "" },
    { _id: MEMBER_N_LINKED, customerId: String(CUST.N), email: "linked.n@qc.local", role: "REQUESTER", isActive: true, travelerId: "NT-050" },
  ] as any[]);
  await col("users").insertMany(
    (Object.keys(U) as Array<keyof typeof U>).map((k) => ({
      _id: U[k], email: `${U[k]}@qc.local`, roles: k === "approver" ? ["APPROVER"] : ["CUSTOMER"], workspaceId: k === "leaderN" ? WS.N : WS.C,
      customerId: k === "leaderN" ? String(CUST.N) : String(CUST.C),
    })) as any[],
  );
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

/* ── index ───────────────────────────────────────────────────────────── */

describe("the {workspaceId, travelerId} index", () => {
  it("is partial: many blank ids coexist, a duplicate non-blank is refused, other workspaces are separate", async () => {
    const idx: any = (await col("travellerprofiles").indexes()).find((i: any) => i.name === TRAVELER_ID_INDEX_NAME);
    expect(idx).toMatchObject({ unique: true, partialFilterExpression: { travelerId: { $gt: "" } } });

    const ws = oid();
    const base = { workspaceId: ws, firstName: "Ix", lastName: "Test", isActive: true };
    await col("travellerprofiles").insertMany([
      { ...base, travelerId: "" }, { ...base, travelerId: "" }, { ...base, travelerId: "" }, { ...base },
    ] as any[]);
    await col("travellerprofiles").insertOne({ ...base, travelerId: "IX-1" } as any);
    await expect(col("travellerprofiles").insertOne({ ...base, travelerId: "IX-1" } as any)).rejects.toMatchObject({ code: 11000 });
    await col("travellerprofiles").insertOne({ ...base, workspaceId: oid(), travelerId: "IX-1" } as any);
    expect(await col("travellerprofiles").countDocuments({ workspaceId: ws })).toBe(5);
    // And through the model, with the schema's own default.
    const req = { source: "MANUAL", createdBy: String(U.leaderC) };
    await TravellerProfile.create({ workspaceId: ws, firstName: "Ix", lastName: "Model", ...req } as any);
    await TravellerProfile.create({ workspaceId: ws, firstName: "Ix", lastName: "Model2", travelerId: "", ...req } as any);
    expect(((await col("travellerprofiles").findOne({ lastName: "Model" })) as any).travelerId).toBe("");
    await col("travellerprofiles").deleteMany({ firstName: "Ix" });
  });

  it("the deploy migration moves the old full unique index onto the partial one (dry-run, apply, idempotent)", async () => {
    const c = col("travellerprofiles");
    expect(await c.countDocuments()).toBe(0);
    await c.dropIndex(TRAVELER_ID_INDEX_NAME);
    await c.createIndex({ workspaceId: 1, travelerId: 1 }, { name: TRAVELER_ID_INDEX_NAME, unique: true });
    const ws = oid();
    await c.insertOne({ workspaceId: ws, firstName: "Mg", lastName: "A", travelerId: "" } as any);
    // The old index is the problem: a second blank collides.
    await expect(c.insertOne({ workspaceId: ws, firstName: "Mg", lastName: "B", travelerId: "" } as any)).rejects.toMatchObject({ code: 11000 });

    const dry = await migrateTravelerIdIndex(true);
    expect(dry.state).toBe("would-migrate");
    expect(dry.before.partialFilterExpression).toBeUndefined();
    expect((await c.indexes()).find((i: any) => i.name === TRAVELER_ID_INDEX_NAME)?.partialFilterExpression).toBeUndefined();

    const applied = await migrateTravelerIdIndex(false);
    expect(applied.state).toBe("migrated");
    expect(applied.after).toMatchObject({ unique: true, partialFilterExpression: { travelerId: { $gt: "" } } });
    await c.insertOne({ workspaceId: ws, firstName: "Mg", lastName: "B", travelerId: "" } as any);
    expect((await migrateTravelerIdIndex(false)).state).toBe("already-partial");
    await c.deleteMany({ firstName: "Mg" });
  });
});

/* ── CSTEP single create + edit ──────────────────────────────────────── */

describe("CSTEP single create — the employee id is the traveller id", () => {
  const add = (body: any, as = ACT.leaderC) => call("post", as, WS.C, "/api/travellers").send(body);

  it("refuses a create without an employee id (400) and stores nothing", async () => {
    const r = await add({ firstName: "No", lastName: "Id" });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: "Employee ID is required", field: "employeeId" });
    expect(await col("travellerprofiles").countDocuments({ workspaceId: WS.C })).toBe(0);
  });

  it("stores travelerId = employeeId, trimmed and uppercased, and mints nothing", async () => {
    const r = ok(await add({ firstName: "Asha", lastName: "Rao", employeeId: "  e-101 " }));
    expect(r.body.traveller).toMatchObject({ travelerId: "E-101", employeeId: "E-101" });
    const [doc]: any[] = await profiles({ workspaceId: WS.C, firstName: "Asha" });
    expect(doc).toMatchObject({ travelerId: "E-101", employeeId: "E-101" });
  });

  it("a duplicate id is 409 — exact and case/space variants alike", async () => {
    for (const employeeId of ["E-101", " e-101"]) {
      const r = await add({ firstName: "Dup", lastName: "X", employeeId });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("Employee ID E-101 is already used by Asha Rao in this workspace");
    }
    expect(await col("travellerprofiles").countDocuments({ workspaceId: WS.C, firstName: "Dup" })).toBe(0);
  });

  it("linking a member never reuses the member's id, and never writes the employee id onto CustomerMember", async () => {
    const r = ok(await add({ firstName: "Lin", lastName: "Ked", employeeId: "E-102", linkedMemberId: String(MEMBER_C_LINKED) }));
    expect(r.body.traveller.travelerId).toBe("E-102");
    const m: any = await col("customermembers").findOne({ _id: MEMBER_C_LINKED });
    expect(m.travelerId).toBe("CSL-007");
  });

  it("a create with an email provisions the member + login, and the member's travelerId stays blank", async () => {
    ok(await add({ firstName: "Mail", lastName: "Ed", employeeId: "E-103", email: "mail.ed@qc.local" }));
    const m: any = await col("customermembers").findOne({ customerId: String(CUST.C), email: "mail.ed@qc.local" });
    expect(m).toBeTruthy();
    expect(m.travelerId ?? "").toBe("");
    const [doc]: any[] = await profiles({ workspaceId: WS.C, firstName: "Mail" });
    expect(doc.travelerId).toBe("E-103");
    expect(doc.claimedBy).toBeTruthy();
  });

  it("a REQUESTER's own self-create (who may not state an employee number) starts blank", async () => {
    const r = ok(await add({ firstName: "Self", lastName: "Made" }, ACT.requesterC));
    expect(r.body.traveller.travelerId).toBe("");
    expect(r.body.traveller.employeeId).toBeUndefined();
  });

  it("edit: an admin fills a blank id; resending it unchanged is a no-op; changing a set id or a duplicate is 409", async () => {
    const [self]: any[] = await profiles({ workspaceId: WS.C, firstName: "Self" });
    const put = (body: any) => call("put", ACT.leaderC, WS.C, `/api/travellers/${self._id}`).send(body);

    expect((await put({ employeeId: "E-101" })).status).toBe(409); // Asha holds it
    ok(await put({ employeeId: " e-104 " }));
    let doc: any = await col("travellerprofiles").findOne({ _id: self._id });
    expect(doc).toMatchObject({ travelerId: "E-104", employeeId: "E-104" });

    ok(await put({ employeeId: "e-104", mobile: "9800000001" })); // the full form resends it
    doc = await col("travellerprofiles").findOne({ _id: self._id });
    expect(doc).toMatchObject({ travelerId: "E-104", employeeId: "E-104", mobile: "9800000001" });

    const change = await put({ employeeId: "E-999" });
    expect(change.status).toBe(409);
    expect(change.body.error).toMatch(/re-map/);
    doc = await col("travellerprofiles").findOne({ _id: self._id });
    expect(doc.travelerId).toBe("E-104");
  });
});

/* ── CSTEP bulk import ───────────────────────────────────────────────── */

describe("CSTEP bulk import — the Employee ID column", () => {
  const HEAD = "Employee ID,First Name,Last Name,Email";

  it("the CSTEP template leads with Employee ID; an ordinary workspace's template is unchanged", async () => {
    // CSV downloads are UTF-8 with a BOM (sendSheet) so Excel reads them as
    // UTF-8; the header row starts after it.
    const BOM = String.fromCharCode(0xfeff);
    const head = (t: string) => (t.startsWith(BOM) ? t.slice(1) : t).split("\n")[0];
    const c = ok(await call("get", ACT.leaderC, WS.C, "/api/travellers/template/download"));
    expect(c.text.startsWith(BOM)).toBe(true);
    expect(head(c.text).split(",").slice(0, 3)).toEqual(["Employee ID", "Title", "First Name"]);
    const n = ok(await call("get", ACT.leaderN, WS.N, "/api/travellers/template/download"));
    expect(head(n.text)).not.toMatch(/Employee ID/);
    expect(head(n.text).split(",")[0]).toBe("Title");
  });

  const FILE = [
    HEAD,
    "b-201,Bulk,One,bulk.one@qc.local", //   create B-201
    ",Bulk,Two,", //                          no id → skip
    "B-201,Bulk,Three,", //                   repeats row 2's id → skip
    "E-101,Bulk,Four,", //                    Asha holds it → skip
    "B-205,Asha,Rao,", //                     same name as E-101 but no DOB → no match → a new B-205
    "E-777,Mail,Ed,mail.ed@qc.local", //      matches E-103 by email, different id → skip
    "E-103,Mail,Ed,mail.ed@qc.local", //      matches E-103, same id → update
  ];

  it("preview refuses exactly the bad rows, before any write", async () => {
    const r = ok(await bulk(ACT.leaderC, WS.C, "preview", FILE));
    const by = (n: number) => r.body.results.find((x: any) => x.rowNumber === n);
    expect(by(2)).toMatchObject({ action: "create", travelerId: "B-201" });
    expect(by(3)).toMatchObject({ action: "skip", reason: "Employee ID is required" });
    expect(by(4)).toMatchObject({ action: "skip", reason: "Employee ID B-201 is also used on row 2 of this file" });
    expect(by(5)).toMatchObject({ action: "skip", reason: "Employee ID E-101 is already used by Asha Rao in this workspace" });
    expect(by(6)).toMatchObject({ action: "create", travelerId: "B-205" });
    expect(by(7).action).toBe("skip");
    expect(by(7).reason).toMatch(/employee id is E-103 — an import can't change it/);
    expect(by(8)).toMatchObject({ action: "update", travelerId: "E-103" });
    expect(await col("travellerprofiles").countDocuments({ workspaceId: WS.C, firstName: "Bulk" })).toBe(0);
  });

  it("commit creates with travelerId = employeeId and never writes CustomerMember.travelerId", async () => {
    const r = ok(await bulk(ACT.leaderC, WS.C, "commit", FILE));
    expect(r.body).toMatchObject({ skipped: 4 });
    const [one]: any[] = await profiles({ workspaceId: WS.C, firstName: "Bulk", lastName: "One" });
    expect(one).toMatchObject({ travelerId: "B-201", employeeId: "B-201", source: "BULK_IMPORT" });
    expect(await col("travellerprofiles").countDocuments({ workspaceId: WS.C, firstName: "Bulk" })).toBe(1);
    const m: any = await col("customermembers").findOne({ email: "bulk.one@qc.local" });
    expect(m.travelerId ?? "").toBe("");
    const [mail]: any[] = await profiles({ workspaceId: WS.C, firstName: "Mail" });
    expect(mail.travelerId).toBe("E-103");
  });

  it("an import fills a blank id on a matched traveller", async () => {
    await col("travellerprofiles").insertOne({ workspaceId: WS.C, firstName: "Blank", lastName: "Fill", email: "blank.fill@qc.local", travelerId: "", isActive: true, source: "MANUAL", createdBy: String(U.leaderC) } as any);
    const r = ok(await bulk(ACT.leaderC, WS.C, "commit", [HEAD, "f-300,Blank,Fill,blank.fill@qc.local"]));
    expect(r.body.results[0]).toMatchObject({ action: "update", travelerId: "F-300" });
    const [doc]: any[] = await profiles({ workspaceId: WS.C, firstName: "Blank" });
    expect(doc).toMatchObject({ travelerId: "F-300", employeeId: "F-300" });
  });
});

/* ── CSTEP auto-capture → approve ────────────────────────────────────── */

describe("CSTEP booking auto-capture", () => {
  const pax = (first: string) => ({ FirstName: first, LastName: "Captured", DateOfBirth: "1991-02-03T00:00:00", SaveToTravellers: true });

  it("creates travellers with a BLANK id (no CODE-NNN), several of them side by side", async () => {
    ok(await call("post", ACT.leaderC, WS.C, "/api/travellers/auto-capture").send({ passengers: [pax("Cap1"), pax("Cap2")] }));
    await waitFor(async () => (await col("travellerprofiles").countDocuments({ workspaceId: WS.C, lastName: "Captured" })) === 2);
    const docs: any[] = await profiles({ workspaceId: WS.C, lastName: "Captured" });
    expect(docs.map((d) => d.travelerId)).toEqual(["", ""]);
    expect(docs.every((d) => d.source === "BOOKING_AUTOCAPTURE")).toBe(true);
    expect(await col("travellerprofiles").countDocuments({ workspaceId: WS.C, travelerId: /^CSL-|^CSTEP-/ })).toBe(0);
  });

  it("and that blank-id traveller files and approves fine", async () => {
    const [cap]: any = await profiles({ workspaceId: WS.C, firstName: "Cap1" });
    await col("travellerprofiles").updateOne(
      { _id: cap._id },
      { $set: { claimedBy: U.captured, email: ACT.captured.email, tourApproverId: U.approver } },
    );
    const created = ok(
      await call("post", ACT.captured, WS.C, "/api/cstep/requests").send({
        type: "DOMESTIC", purpose: "Captured traveller tour", departureDate: "2026-11-10", returnDate: "2026-11-11",
        stations: [{ from: "Bengaluru", to: "Pune" }], projectId: String(QC_PROJECT_C),
      }),
    );
    const id = String(created.body.request._id);
    const approved = ok(await call("post", ACT.approver, WS.C, `/api/cstep/requests/${id}/approve`));
    expect(approved.body.claimReference).toBe(`0001/${cstepMMYY()}`);
    const doc: any = await col("csteptravelrequests").findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(doc.status).toBe("APPROVED");
    expect(((await col("travellerprofiles").findOne({ _id: cap._id })) as any).travelerId).toBe("");
  });
});

/* ── non-CSTEP: unchanged ────────────────────────────────────────────── */

describe("an ordinary workspace still auto-mints exactly as before", () => {
  it("single create mints NT-001 and keeps employeeId as typed (no uniqueness, no uppercasing)", async () => {
    const add = (body: any) => call("post", ACT.leaderN, WS.N, "/api/travellers").send(body);
    const a = ok(await add({ firstName: "Nora", lastName: "One", employeeId: " e-1 " }));
    expect(a.body.traveller).toMatchObject({ travelerId: "NT-001", employeeId: "e-1" });
    const b = ok(await add({ firstName: "Nora", lastName: "Two", employeeId: "e-1" }));
    expect(b.body.traveller).toMatchObject({ travelerId: "NT-002", employeeId: "e-1" });
    expect((await add({ firstName: "Nora", lastName: "Three" })).status).toBe(201); // no id needed
  });

  it("the linked member's id is still reused there", async () => {
    const r = ok(await call("post", ACT.leaderN, WS.N, "/api/travellers").send({ firstName: "Link", lastName: "N", linkedMemberId: String(MEMBER_N_LINKED) }));
    expect(r.body.traveller.travelerId).toBe("NT-050");
  });

  it("bulk import mints and ignores an Employee ID column", async () => {
    const r = ok(await bulk(ACT.leaderN, WS.N, "commit", ["Employee ID,First Name,Last Name", "X-1,Bulk,North"]));
    expect(r.body.results[0]).toMatchObject({ action: "create", travelerId: "NT-051" });
    const [doc]: any[] = await profiles({ workspaceId: WS.N, firstName: "Bulk" });
    expect(doc.employeeId).toBeUndefined();
  });

  it("auto-capture mints too", async () => {
    ok(await call("post", ACT.leaderN, WS.N, "/api/travellers/auto-capture").send({
      passengers: [{ FirstName: "Cap", LastName: "North", DateOfBirth: "1990-01-01T00:00:00", SaveToTravellers: true }],
    }));
    await waitFor(async () => (await col("travellerprofiles").countDocuments({ workspaceId: WS.N, lastName: "North", firstName: "Cap" })) === 1);
    const [doc]: any[] = await profiles({ workspaceId: WS.N, firstName: "Cap" });
    expect(doc.travelerId).toBe("NT-052");
  });
});

/* ── re-map script ───────────────────────────────────────────────────── */

describe("re-map script — existing CSTEP travellers onto employee ids", () => {
  const T = { a: oid(), b: oid(), c: oid(), d: oid(), e: oid(), f1: oid(), f2: oid() };
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);
  const remap = (csv: string[], extra: Partial<Parameters<typeof runRemap>[0]> = {}) =>
    runRemap({ workspaceId: String(WS.R), csv: csv.join("\n"), apply: false, expectDb: DB, ...extra }, log);
  const ids = async () =>
    Object.fromEntries(
      ((await profiles({ workspaceId: WS.R })) as any[]).map((t) => [t.firstName, `${t.travelerId}|${t.employeeId ?? ""}`]),
    );

  const GOOD = [
    "Email,Current ID,Employee ID",
    "a@r.qc,,CSTEP-002", //       A takes B's id …
    ",CSTEP-002,cstep-001", //    … while B takes A's: a swap
    ",CSTEP-003,e-300",
    "d@r.qc,,E-400", //            D has a blank id today
  ];

  beforeAll(async () => {
    const t = (id: any, firstName: string, travelerId: string | undefined, email?: string, employeeId?: string) => ({
      _id: id, workspaceId: WS.R, firstName, lastName: "R", isActive: true, source: "MANUAL", createdBy: "qc",
      ...(travelerId !== undefined ? { travelerId } : {}), ...(email ? { email } : {}), ...(employeeId ? { employeeId } : {}),
    });
    await col("travellerprofiles").insertMany([
      t(T.a, "A", "CSTEP-001", "a@r.qc"),
      t(T.b, "B", "CSTEP-002", "b@r.qc", "OLD-B"),
      t(T.c, "C", "CSTEP-003"),
      t(T.d, "D", "", "d@r.qc"),
      t(T.e, "E", "CSTEP-005", "e@r.qc"),
      t(T.f1, "F1", "CSTEP-006", "same@r.qc"),
      t(T.f2, "F2", "CSTEP-007", "same@r.qc"),
    ] as any[]);
    await col("customermembers").insertOne({ customerId: String(CUST.R), email: "a@r.qc", role: "REQUESTER", isActive: true, travelerId: "RL-001" } as any);
  });

  it("refuses the wrong database, a bad file, and a non-CSTEP workspace", async () => {
    expect((await remap(GOOD, { expectDb: "plumtrips_prod" })).error).toMatch(/connected database is "cstep_qc_travid"/);
    expect((await remap(GOOD, { expectDb: "" })).error).toMatch(/--expect-db/);
    expect((await remap(["Email,Name", "a@r.qc,x"])).error).toBe('The file needs an "Employee ID" column');
    expect((await runRemap({ workspaceId: String(WS.N), csv: GOOD.join("\n"), apply: false, expectDb: DB }, log)).error).toMatch(/not cstepEnabled/);
  });

  it("validates the whole file: blank id, unknown, ambiguous, listed twice, duplicate in file, held by someone not moved", async () => {
    const r = await remap([
      "Email,Current ID,Employee ID",
      "a@r.qc,,", //                  2 blank
      "nobody@r.qc,,X-1", //          3 unknown email
      "same@r.qc,,X-2", //            4 two travellers share it
      ",CSTEP-404,X-3", //            5 unknown id
      "b@r.qc,CSTEP-001,X-4", //      6 id and email disagree
      ",CSTEP-003,X-5",
      "c@r.qc,CSTEP-003,X-6", //      8 C again (no email on C → mismatch) — use id-only below
      ",CSTEP-001,X-5", //            9 X-5 already given on row 7
      ",CSTEP-002,CSTEP-005", //      10 E keeps CSTEP-005
    ]);
    const msg = Object.fromEntries(r.plan!.errors.map((e) => [e.row, e.message]));
    expect(msg[2]).toBe("Employee ID is required");
    expect(msg[3]).toBe("No traveller with email nobody@r.qc");
    expect(msg[4]).toMatch(/2 travellers share same@r.qc/);
    expect(msg[5]).toBe("No traveller with current id CSTEP-404");
    expect(msg[6]).toBe("Current id CSTEP-001 belongs to A R, not b@r.qc");
    expect(msg[8]).toBe("Current id CSTEP-003 belongs to C R, not c@r.qc");
    expect(msg[9]).toBe("Employee ID X-5 is also given on row 7");
    expect(msg[10]).toBe("Employee ID CSTEP-005 is held by E R, who is not moved by this file");
    const before = await ids();
    expect((await remap(GOOD.slice(0, 1).concat([",CSTEP-002,CSTEP-005"]), { apply: true, confirm: r.plan!.planId })).applied).toBe(false);
    expect(await ids()).toEqual(before);

    const twice = await remap(["Email,Current ID,Employee ID", "a@r.qc,,Y-1", ",CSTEP-001,Y-2"]);
    expect(twice.plan!.errors).toEqual([{ row: 3, message: "A R is already listed on row 2" }]);
  });

  it("dry-run prints the full plan (swap flagged) and writes nothing", async () => {
    const before = await ids();
    lines.length = 0;
    const r = await remap(GOOD);
    expect(r.applied).toBe(false);
    expect(r.plan!.errors).toEqual([]);
    expect(r.plan!.changes.map((c) => [c.name, c.from, c.to, c.swap])).toEqual([
      ["A R", "CSTEP-001", "CSTEP-002", true],
      ["B R", "CSTEP-002", "CSTEP-001", true],
      ["C R", "CSTEP-003", "E-300", false],
      ["D R", "", "E-400", false],
    ]);
    expect(lines.join("\n")).toMatch(/row 4: C R .*CSTEP-003 → E-300/);
    expect(lines.join("\n")).toMatch(/\(blank\) → E-400/);
    expect(lines.join("\n")).toMatch(/\[employeeId was OLD-B\]/);
    expect(lines.join("\n")).toMatch(/DRY RUN — nothing written/);
    expect(await ids()).toEqual(before);
  });

  it("apply needs the reviewed plan id: none or a stale one is refused", async () => {
    const before = await ids();
    expect((await remap(GOOD, { apply: true })).error).toMatch(/does not match plan id/);
    expect((await remap(GOOD, { apply: true, confirm: "000000000000" })).error).toMatch(/does not match plan id/);
    expect(await ids()).toEqual(before);
  });

  it("applies the plan — the swap included — mirrors employeeId, and leaves CustomerMember alone", async () => {
    const { plan } = await remap(GOOD);
    const r = await remap(GOOD, { apply: true, confirm: plan!.planId });
    expect(r.applied).toBe(true);
    expect(await ids()).toMatchObject({
      A: "CSTEP-002|CSTEP-002",
      B: "CSTEP-001|CSTEP-001",
      C: "E-300|E-300",
      D: "E-400|E-400",
      E: "CSTEP-005|",
    });
    const m: any = await col("customermembers").findOne({ customerId: String(CUST.R), email: "a@r.qc" });
    expect(m.travelerId).toBe("RL-001");
    expect(await col("customermembers").countDocuments({ travelerId: { $in: ["CSTEP-001", "CSTEP-002", "E-300", "E-400"] } })).toBe(0);
    expect(await col("travellerprofiles").countDocuments({ travelerId: /^__REMAP__/ })).toBe(0);
  });

  it("re-running the same file is a no-op, and a changed database changes the plan id", async () => {
    const again = await remap(GOOD.slice(0, 1).concat(["a@r.qc,,CSTEP-002", ",E-300,E-300"]));
    expect(again.plan!.changes).toEqual([]);
    expect(again.plan!.unchanged.map((u) => u.travelerId)).toEqual(["CSTEP-002", "E-300"]);

    const file = ["Email,Current ID,Employee ID", ",E-300,E-301"];
    const p1 = (await remap(file)).plan!.planId;
    await col("travellerprofiles").updateOne({ _id: T.c }, { $set: { employeeId: "TOUCHED" } });
    const p2 = (await remap(file)).plan!.planId;
    expect(p2).not.toBe(p1);
    expect((await remap(file, { apply: true, confirm: p1 })).error).toMatch(/does not match plan id/);
  });
});
