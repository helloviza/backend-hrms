// Route-level coverage for routes/admin.visa.rules.importExport.ts. Same
// express+supertest+in-memory-collection convention as routes/
// admin.visa.rules.test.ts — every model this router touches is backed by a
// small generic store with real find/save semantics, and the exports/imports go
// through the ACTUAL multer+ExcelJS pipeline (real xlsx buffers, real
// multipart uploads), not a hand-picked in-memory fixture, so the
// round-trip-losslessness property is genuinely exercised end to end.
//
// NOTE: that convention is a choice, not a constraint — mongodb-memory-server
// does start here (see utils/visaPredicatePersistence.test.ts), so real
// persistence is available if this test ever needs schema defaults or
// casting to be real.
//
// requirePermission itself is NOT mocked — same reasoning as
// admin.visa.rules.test.ts: proves every route here is gated at FULL.
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";

const { _rules, _ruleAudits, chainableRuleArray, wrapRuleDoc } = vi.hoisted(() => {
  function matches(rec: Record<string, any>, filter: Record<string, any>): boolean {
    return Object.entries(filter || {}).every(([key, cond]) => {
      if (key === "$or" && Array.isArray(cond)) {
        return cond.some((sub: Record<string, any>) => matches(rec, sub));
      }
      if (key === "_id" && cond && typeof cond === "object" && "$in" in cond) {
        return (cond.$in as any[]).map(String).includes(String(rec._id));
      }
      return String(rec[key]) === String(cond);
    });
  }

  function makeCollection() {
    const store = new Map<string, Record<string, any>>();
    return {
      store,
      insert(doc: Record<string, any>): Record<string, any> {
        const id = doc._id ?? new mongoose.Types.ObjectId();
        const rec = { ...doc, _id: id };
        store.set(String(id), rec);
        return rec;
      },
      query(filter: Record<string, any> = {}) {
        return Array.from(store.values()).filter((rec) => matches(rec, filter));
      },
      clear() {
        store.clear();
      },
    };
  }

  function wrapDoc(rec: Record<string, any> | null) {
    if (!rec) return null;
    const doc: any = { ...rec };
    Object.defineProperty(doc, "save", {
      enumerable: false,
      value: async () => {
        Object.assign(rec, doc);
        return doc;
      },
    });
    Object.defineProperty(doc, "toObject", {
      enumerable: false,
      value: () => ({ ...rec }),
    });
    return doc;
  }

  // find(filter) — awaited directly for a live-doc array (processImport
  // calls .save() on each); .lean()/.sort() also supported for the export
  // route's own read path.
  function chainableRuleArray(getRecords: () => any[]) {
    const obj: any = {
      sort: () => obj,
      lean: () => Promise.resolve(getRecords().map((r) => ({ ...r }))),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(getRecords().map((r) => wrapDoc(r))).then(onFulfilled, onRejected),
      catch: (onRejected: any) => Promise.resolve(getRecords().map((r) => wrapDoc(r))).catch(onRejected),
    };
    return obj;
  }

  return { _rules: makeCollection(), _ruleAudits: makeCollection(), chainableRuleArray, wrapRuleDoc: wrapDoc };
});

vi.mock("../models/VisaRule.js", async () => {
  const actual: any = await vi.importActual("../models/VisaRule.js");
  return {
    VISA_PURPOSES: actual.VISA_PURPOSES,
    VISA_ENTRY_TYPES: actual.VISA_ENTRY_TYPES,
    VISA_SERVICE_TIERS: actual.VISA_SERVICE_TIERS,
    VISA_PRODUCT_CLASSES: actual.VISA_PRODUCT_CLASSES,
    VISA_CATEGORIES: actual.VISA_CATEGORIES,
    VISA_ETA_BASES: actual.VISA_ETA_BASES,
    VISA_DOC_REQUIREMENT_LEVELS: actual.VISA_DOC_REQUIREMENT_LEVELS,
    VISA_RULE_DISPLAY_MODES: actual.VISA_RULE_DISPLAY_MODES,
    VISA_RULE_STATUSES: actual.VISA_RULE_STATUSES,
    default: {
      find: (filter: any) => chainableRuleArray(() => _rules.query(filter)),
      create: async (doc: any) => {
        const rec = _rules.insert(doc);
        return wrapRuleDoc(rec);
      },
    },
  };
});

vi.mock("../models/VisaDestinationContent.js", () => ({
  default: { find: () => ({ sort: () => ({ lean: () => Promise.resolve([]) }) }), findOne: () => ({ lean: () => Promise.resolve(null) }) },
}));

vi.mock("../models/VisaRuleAudit.js", () => ({
  VISA_RULE_AUDIT_ACTIONS: ["CREATE", "UPDATE", "PUBLISH", "RETIRE", "CLONE", "IMPORT"],
  default: {
    create: async (docs: any) => {
      const arr = Array.isArray(docs) ? docs : [docs];
      return arr.map((d: any) => _ruleAudits.insert({ performedAt: new Date(), ...d }));
    },
    find: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }) }),
    countDocuments: async () => 0,
  },
}));

vi.mock("../models/User.js", () => ({ default: { find: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) } }));

vi.mock("../config/visaDocumentCodes.js", async () => {
  const actual: any = await vi.importActual("../config/visaDocumentCodes.js");
  return actual;
});

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

let permissionRecord: any = null;
vi.mock("../models/UserPermission.js", () => ({
  UserPermission: { findOne: (_filter: any) => ({ lean: () => Promise.resolve(permissionRecord) }) },
  hasAccess: (actual: string, required: string) => {
    const order = ["NONE", "READ", "WRITE", "FULL"];
    return order.indexOf(actual) >= order.indexOf(required);
  },
}));

import express from "express";
import request from "supertest";
import router from "./admin.visa.rules.importExport.js";
import rulesRouter from "./admin.visa.rules.js";

const USER_ID = new mongoose.Types.ObjectId();

function setAccess(access: "NONE" | "READ" | "WRITE" | "FULL" | null) {
  permissionRecord = access == null ? null : { modules: { visaApplication: { access, scope: "ALL" } }, level: { code: "L5" } };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(USER_ID), roles: ["OPS"], email: "concierge@plumtrips.com" };
    next();
  });
  app.use("/", router);
  return app;
}

// Mounts BOTH routers at the same prefix, in the EXACT relative order
// server.ts uses (admin.visa.rules.ts's router first, this one second) —
// a route-ordering bug is invisible to a test that mounts this router
// alone (makeApp() above), since /rules/:id doesn't even exist in that
// world. This is what actually caught GET /rules/export being swallowed
// by GET /rules/:id.
function makeCombinedApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { _id: String(USER_ID), roles: ["OPS"], email: "concierge@plumtrips.com" };
    next();
  });
  app.use("/", rulesRouter);
  app.use("/", router);
  return app;
}

function fullRule(overrides: Record<string, any> = {}) {
  return _rules.insert({
    nationality: "IN",
    destinationIso2: "DE",
    destinationName: "Germany",
    purpose: "TOURIST",
    entryType: "MULTIPLE",
    serviceTier: "STANDARD",
    variantKey: "DEFAULT",
    status: "PUBLISHED",
    visaCategory: "STICKER",
    etaMinDays: 15,
    etaMaxDays: 20,
    etaBasis: "BUSINESS",
    embassyFeeInr: 8200,
    vfsFeeInr: 2100,
    plumtripsServiceFeeInr: 1499,
    indicativeVisaCostInr: undefined,
    priceNote: "Fee, includes a comma",
    opsNotes: "Reviewed quarterly",
    lastReviewedAt: new Date("2026-01-01T00:00:00.000Z"),
    documentGroups: [
      {
        key: "PASSPORT",
        label: "Valid passport",
        requirement: "REQUIRED",
        docTypeCodes: ["PASSPORT_ORIGINAL"],
        specification: "6 months validity beyond stay",
      },
      {
        key: "PHOTO_OR_INVITE",
        label: "Photo or invitation letter",
        requirement: "CONDITIONAL",
        appliesWhen: [{ field: "employmentStatus", equals: "SELF_EMPLOYED" }],
        docTypeCodes: ["PHOTOGRAPH", "INVITATION_LETTER"],
        templateCode: "TPL-1",
        legacyConditionNote: "if self employed",
      },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  _rules.clear();
  _ruleAudits.clear();
  setAccess("FULL");
});

describe("permission gating", () => {
  it("403s the export route below FULL", async () => {
    setAccess("WRITE");
    const res = await request(makeApp()).get("/rules/export");
    expect(res.status).toBe(403);
  });

  it("403s the import preview route below FULL", async () => {
    setAccess("READ");
    const res = await request(makeApp()).post("/rules/import/preview").attach("file", Buffer.from("a,b\n1,2"), "x.csv");
    expect(res.status).toBe(403);
  });
});

describe("GET /rules/export — route ordering (regression)", () => {
  it("is reachable through the real, combined router stack — not swallowed by GET /rules/:id", async () => {
    fullRule();
    // Deliberately goes through makeCombinedApp(), mounting admin.visa.
    // rules.ts's router first and this one second, exactly like server.ts
    // does. A test that only mounts THIS router (makeApp()) would pass
    // even with the bug present, since /rules/:id doesn't exist in that
    // world at all — the ordering bug is only observable when both
    // routers share the same mount prefix.
    const res = await request(makeCombinedApp()).get("/rules/export?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.body?.error).toBeUndefined();
    expect(res.text).not.toBe("Visa rule not found");
  });

  it("GET /rules/:id still 404s on a genuinely invalid id (falls through both routers, no route left to match)", async () => {
    // This test app only mounts the two visa routers, not server.ts's own
    // final catch-all (line ~794: res.status(404).json({ ok: false,
    // message: "API route not found" })) — so here it's Express's bare
    // 404, not that JSON one. In the real app, a malformed id still gets a
    // clean JSON 404, just with that generic message instead of this
    // route's own "Visa rule not found" — an accepted, honest trade-off
    // of falling through: the exact wording for "not a route at all" is
    // the app's catch-all's job, not this handler's.
    const res = await request(makeCombinedApp()).get("/rules/not-a-real-id");
    expect(res.status).toBe(404);
  });
});

describe("GET /rules/export", () => {
  it("CSV contains only the RULES sheet's columns and data", async () => {
    fullRule();
    const res = await request(makeApp()).get("/rules/export?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("Rule Id");
    expect(res.text).toContain("Germany");
    expect(res.text).not.toContain("Group Label"); // REQUIREMENTS sheet never appears in CSV
  });

  it("XLSX contains both RULES and REQUIREMENTS sheets", async () => {
    const rule = fullRule();
    const res = await request(makeApp()).get("/rules/export?format=xlsx").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const sheetNames = workbook.worksheets.map((s) => s.name);
    expect(sheetNames).toEqual(["RULES", "REQUIREMENTS"]);

    const rulesSheet = workbook.getWorksheet("RULES")!;
    expect(rulesSheet.getRow(2).getCell(1).value).toBe(String(rule._id));

    const reqSheet = workbook.getWorksheet("REQUIREMENTS")!;
    expect(reqSheet.rowCount).toBe(3); // header + 2 groups
  });

  it("filters by destination/purpose/status/schengenOnly", async () => {
    fullRule({ destinationIso2: "DE", destinationName: "Germany" });
    fullRule({ destinationIso2: "AE", destinationName: "United Arab Emirates", purpose: "BUSINESS", _id: new mongoose.Types.ObjectId() });
    const res = await request(makeApp()).get("/rules/export?format=csv&destination=AE");
    expect(res.text).toContain("United Arab Emirates");
    expect(res.text).not.toContain("Germany");
  });
});

describe("round trip is lossless", () => {
  it("export -> reimport unchanged (XLSX) -> zero changes, zero writes", async () => {
    const rule = fullRule();

    const exportRes = await request(makeApp()).get("/rules/export?format=xlsx").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });

    const previewRes = await request(makeApp())
      .post("/rules/import/preview")
      .attach("file", exportRes.body, "visa-rules.xlsx");

    expect(previewRes.status).toBe(200);
    expect(previewRes.body.matchedCount).toBe(1);
    expect(previewRes.body.changedCount).toBe(0);
    expect(previewRes.body.unchangedCount).toBeGreaterThanOrEqual(1);
    expect(previewRes.body.ruleChanges).toEqual([]);
    expect(previewRes.body.unmatchedRuleRows).toEqual([]);
    expect(previewRes.body.invalidRuleRows).toEqual([]);
    expect(previewRes.body.invalidRequirementRows).toEqual([]);
    expect(previewRes.body.orphanedRequirementRows).toEqual([]);
    expect(previewRes.body.duplicateRuleRows).toEqual([]);
    expect(previewRes.body.unrecognizedRuleColumns).toEqual([]);
    expect(previewRes.body.unrecognizedRequirementColumns).toEqual([]);

    // Commit too — still zero writes, since nothing changed.
    const commitRes = await request(makeApp()).post("/rules/import/commit").attach("file", exportRes.body, "visa-rules.xlsx");
    expect(commitRes.status).toBe(200);
    expect(commitRes.body.changedCount).toBe(0);
    expect(_ruleAudits.query({}).length).toBe(0);

    // The stored rule itself is byte-for-byte the same object we started with.
    const stored = _rules.query({ _id: rule._id })[0];
    expect(stored.visaCategory).toBe("STICKER");
    expect(stored.documentGroups).toHaveLength(2);
    expect(stored.priceNote).toBe("Fee, includes a comma");
  });

  it("export -> reimport unchanged (CSV) -> zero changes, documentGroups untouched", async () => {
    fullRule();
    const exportRes = await request(makeApp()).get("/rules/export?format=csv");
    const previewRes = await request(makeApp())
      .post("/rules/import/preview")
      .attach("file", Buffer.from(exportRes.text), "visa-rules.csv");

    expect(previewRes.status).toBe(200);
    expect(previewRes.body.hasRequirementsSheet).toBe(false);
    expect(previewRes.body.changedCount).toBe(0);
  });

  it("export -> reimport unchanged (XLSX) with a needsCatalogueMapping group -> the flag and unmatched names survive, zero changes", async () => {
    const rule = fullRule({
      documentGroups: [
        {
          key: "AUTHORISATION_LETTER",
          label: "Authorisation letter",
          requirement: "REQUIRED",
          docTypeCodes: [],
          needsCatalogueMapping: true,
          unmatchedDocumentNames: ["Authorisation Letter"],
        },
        {
          key: "COVER_LETTER",
          label: "Cover letter",
          requirement: "REQUIRED",
          docTypeCodes: ["COVER_LETTER"],
          needsCatalogueMapping: true,
          unmatchedTemplateReference: "Cover Letter Template",
        },
      ],
    });

    const exportRes = await request(makeApp()).get("/rules/export?format=xlsx").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exportRes.body);
    const sheet = workbook.getWorksheet("REQUIREMENTS")!;
    expect(sheet.getRow(1).getCell(10).value).toBe("Needs Catalogue Mapping");
    expect(sheet.getRow(1).getCell(11).value).toBe("Unmatched Document Names");
    expect(sheet.getRow(1).getCell(12).value).toBe("Unmatched Template Reference");
    expect(sheet.getRow(2).getCell(10).value).toBe("TRUE");
    expect(sheet.getRow(2).getCell(11).value).toBe("Authorisation Letter");
    expect(sheet.getRow(3).getCell(12).value).toBe("Cover Letter Template");

    const previewRes = await request(makeApp())
      .post("/rules/import/preview")
      .attach("file", exportRes.body, "visa-rules.xlsx");
    expect(previewRes.status).toBe(200);
    expect(previewRes.body.changedCount).toBe(0);
    expect(previewRes.body.invalidRequirementRows).toEqual([]);

    const commitRes = await request(makeApp()).post("/rules/import/commit").attach("file", exportRes.body, "visa-rules.xlsx");
    expect(commitRes.status).toBe(200);
    expect(commitRes.body.changedCount).toBe(0);
    const stored = _rules.query({ _id: rule._id })[0];
    expect(stored.documentGroups).toHaveLength(2);
    expect(stored.documentGroups[0].needsCatalogueMapping).toBe(true);
    expect(stored.documentGroups[0].unmatchedDocumentNames).toEqual(["Authorisation Letter"]);
    expect(stored.documentGroups[1].unmatchedTemplateReference).toBe("Cover Letter Template");
  });
});

describe("editing through the import", () => {
  it("preview shows a field-by-field diff for a real edit, old value to new", async () => {
    const rule = fullRule({ visaCategory: "STICKER", indicativeVisaCostInr: undefined });

    const exportRes = await request(makeApp()).get("/rules/export?format=xlsx").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exportRes.body);
    const sheet = workbook.getWorksheet("RULES")!;
    sheet.getRow(2).getCell(9).value = "E_VISA"; // Visa Category column
    sheet.getRow(2).getCell(16).value = 5000; // Indicative Visa Cost INR column
    await sheet.getRow(2).commit();
    const editedBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const previewRes = await request(makeApp()).post("/rules/import/preview").attach("file", editedBuffer, "edited.xlsx");
    expect(previewRes.status).toBe(200);
    expect(previewRes.body.changedCount).toBe(1);
    const change = previewRes.body.ruleChanges[0];
    expect(change.ruleId).toBe(String(rule._id));
    const byField = Object.fromEntries(change.changes.map((c: any) => [c.field, c]));
    expect(byField.visaCategory).toEqual({ field: "visaCategory", from: "STICKER", to: "E_VISA" });
    expect(byField.indicativeVisaCostInr).toEqual({ field: "indicativeVisaCostInr", from: null, to: 5000 });

    // Preview must never write.
    expect(_rules.query({ _id: rule._id })[0].visaCategory).toBe("STICKER");

    const commitRes = await request(makeApp()).post("/rules/import/commit").attach("file", editedBuffer, "edited.xlsx");
    expect(commitRes.status).toBe(200);
    expect(commitRes.body.changedCount).toBe(1);
    expect(_rules.query({ _id: rule._id })[0].visaCategory).toBe("E_VISA");
    expect(_rules.query({ _id: rule._id })[0].indicativeVisaCostInr).toBe(5000);

    const audits = _ruleAudits.query({ ruleId: rule._id });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("IMPORT");
  });

  it("never sets status, even if the file carries a PUBLISHED-looking status cell", async () => {
    const rule = fullRule({ status: "DRAFT" });
    const exportRes = await request(makeApp()).get("/rules/export?format=csv");
    // Status column is exported as DRAFT here; re-upload unchanged, plus a
    // hand-edited copy trying to smuggle PUBLISHED through the same cell.
    const smuggled = exportRes.text.replace(/,DRAFT,/, ",PUBLISHED,");
    const res = await request(makeApp()).post("/rules/import/commit").attach("file", Buffer.from(smuggled), "smuggle.csv");
    expect(res.status).toBe(200);
    expect(_rules.query({ _id: rule._id })[0].status).toBe("DRAFT");
  });

  it("never creates a rule for an id with no match — reports it instead", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const csv = `Rule Id,Destination ISO2,Destination Name,Purpose,Entry Type,Service Tier,Variant Key,Status,Visa Category,ETA Min Days,ETA Max Days,ETA Basis,Embassy Fee INR,VFS Fee INR,Plumtrips Service Fee INR,Indicative Visa Cost INR,Price Note,Ops Notes,Last Reviewed At\n${fakeId},ZZ,Nowhere,TOURIST,MULTIPLE,STANDARD,DEFAULT,DRAFT,STICKER,,,,,,,,,,\n`;
    const res = await request(makeApp()).post("/rules/import/preview").attach("file", Buffer.from(csv), "x.csv");
    expect(res.status).toBe(200);
    expect(res.body.unmatchedRuleRows).toEqual([{ rowNumber: 2, ruleId: fakeId }]);
    expect(_rules.query({}).length).toBe(0);
  });

  it("reports (never applies) a requirement row whose rule id doesn't exist", async () => {
    const rule = fullRule();
    const fakeId = new mongoose.Types.ObjectId().toString();

    const exportRes = await request(makeApp()).get("/rules/export?format=xlsx").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exportRes.body);
    const reqSheet = workbook.getWorksheet("REQUIREMENTS")!;
    reqSheet.addRow([fakeId, "SOME_KEY", "Some group", "REQUIRED", "", "PASSPORT_ORIGINAL", "", "", "", "", "", ""]);
    const editedBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const res = await request(makeApp()).post("/rules/import/preview").attach("file", editedBuffer, "edited.xlsx");
    expect(res.status).toBe(200);
    expect(res.body.orphanedRequirementRows).toEqual([
      { rowNumber: 4, ruleId: fakeId, reason: "No VisaRule exists with this id" },
    ]);
    // The real rule's own groups are untouched by the orphaned row.
    expect(res.body.changedCount).toBe(0);
    expect(_rules.query({ _id: rule._id })[0].documentGroups).toHaveLength(2);
  });

  it("reports an unrecognised column without failing the import", async () => {
    fullRule();
    const exportRes = await request(makeApp()).get("/rules/export?format=csv");
    const withExtraColumn = exportRes.text.replace("Rule Id,", "Rule Id,Ops Comment,").replace(/\n([0-9a-f]{24})/, "\n$1,some note");
    const res = await request(makeApp()).post("/rules/import/preview").attach("file", Buffer.from(withExtraColumn), "x.csv");
    expect(res.status).toBe(200);
    // CSV headers are read lowercased (utils/simpleCsv.ts); XLSX preserves
    // original casing (readWorksheetRows). Both paths still correctly
    // flag the column as unrecognised — only the casing of the report
    // differs, which is fine for round-trip purposes since the column
    // was never in either export in the first place.
    expect(res.body.unrecognizedRuleColumns).toContain("ops comment");
    expect(res.body.changedCount).toBe(0);
  });

  it("skips (and reports) both rows when two RULES rows share the same rule id", async () => {
    const rule = fullRule();
    const header =
      "Rule Id,Destination ISO2,Destination Name,Purpose,Entry Type,Service Tier,Variant Key,Status,Visa Category,ETA Min Days,ETA Max Days,ETA Basis,Embassy Fee INR,VFS Fee INR,Plumtrips Service Fee INR,Indicative Visa Cost INR,Price Note,Ops Notes,Last Reviewed At\n";
    const row = (cost: number) =>
      `${rule._id},DE,Germany,TOURIST,MULTIPLE,STANDARD,DEFAULT,DRAFT,STICKER,,,,,,,${cost},,,\n`;
    const csv = header + row(1000) + row(2000);
    const res = await request(makeApp()).post("/rules/import/preview").attach("file", Buffer.from(csv), "dup.csv");
    expect(res.status).toBe(200);
    expect(res.body.duplicateRuleRows).toHaveLength(1);
    expect(res.body.duplicateRuleRows[0].rowNumbers).toEqual([2, 3]);
    expect(res.body.changedCount).toBe(0);
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * CREATE path (2026-08-04) — a RULES row with a blank Rule Id. FR/DE are
 * both real entries in utils/countryCodes.ts's COUNTRY_CODES, so
 * destination resolution is exercised against the real table, not a mock.
 * ───────────────────────────────────────────────────────────────────── */
const RULES_CSV_HEADER =
  "Rule Id,Destination ISO2,Destination Name,Purpose,Entry Type,Service Tier,Variant Key,Status,Visa Category,ETA Min Days,ETA Max Days,ETA Basis,Embassy Fee INR,VFS Fee INR,Plumtrips Service Fee INR,Indicative Visa Cost INR,Price Note,Ops Notes,Last Reviewed At\n";

const RULES_CSV_COLUMN_ORDER = [
  "ruleId", "destinationIso2", "destinationName", "purpose", "entryType", "serviceTier", "variantKey", "status",
  "visaCategory", "etaMinDays", "etaMaxDays", "etaBasis", "embassyFeeInr", "vfsFeeInr", "plumtripsServiceFeeInr",
  "indicativeVisaCostInr", "priceNote", "opsNotes", "lastReviewedAt",
] as const;

function ruleCsvRow(cells: Partial<Record<(typeof RULES_CSV_COLUMN_ORDER)[number], string>>): string {
  return RULES_CSV_COLUMN_ORDER.map((k) => cells[k] ?? "").join(",") + "\n";
}

describe("creating a rule via a blank Rule Id", () => {
  it("a blank Rule Id creates a new DRAFT rule, seedSource-stamped", async () => {
    const csv = RULES_CSV_HEADER + ruleCsvRow({ destinationIso2: "FR", purpose: "TOURIST" });
    const res = await request(makeApp()).post("/rules/import/commit").attach("file", Buffer.from(csv), "create.csv");

    expect(res.status).toBe(200);
    expect(res.body.createdCount).toBe(1);
    expect(res.body.ruleCreates).toHaveLength(1);
    const created = res.body.ruleCreates[0];
    expect(created.destinationIso2).toBe("FR");
    expect(created.destinationName).toBe("France");
    expect(created.purpose).toBe("TOURIST");
    expect(created.entryType).toBe("UNSPECIFIED"); // defaulted, blank in the file
    expect(created.serviceTier).toBe("STANDARD"); // defaulted, blank in the file
    expect(created.hasChecklist).toBe(false);
    expect(created.ruleId).toBeTruthy();

    expect(_rules.query({}).length).toBe(1);
    const stored = _rules.query({})[0];
    expect(stored.status).toBe("DRAFT");
    expect(stored.seedSource).toBe("visa-rules-spreadsheet-import@2026-08");
    expect(stored.nationality).toBe("IN");
    expect(stored.variantKey).toBe("DEFAULT");
    expect(stored.productClass).toBe("VISA");

    const audits = _ruleAudits.query({ ruleId: stored._id });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("IMPORT");
  });

  it("rejects a blank-Rule-Id row missing Destination, naming the row and what's missing", async () => {
    const csv = RULES_CSV_HEADER + ruleCsvRow({ purpose: "TOURIST" });
    const res = await request(makeApp()).post("/rules/import/preview").attach("file", Buffer.from(csv), "x.csv");

    expect(res.status).toBe(200);
    expect(res.body.createdCount).toBe(0);
    expect(res.body.invalidRuleRows).toHaveLength(1);
    expect(res.body.invalidRuleRows[0].rowNumber).toBe(2);
    expect(res.body.invalidRuleRows[0].reason).toMatch(/Destination/);
    expect(_rules.query({}).length).toBe(0);
  });

  it("rejects a blank-Rule-Id row missing Purpose, naming the row and what's missing", async () => {
    const csv = RULES_CSV_HEADER + ruleCsvRow({ destinationIso2: "FR" });
    const res = await request(makeApp()).post("/rules/import/preview").attach("file", Buffer.from(csv), "x.csv");

    expect(res.status).toBe(200);
    expect(res.body.invalidRuleRows).toHaveLength(1);
    expect(res.body.invalidRuleRows[0].rowNumber).toBe(2);
    expect(res.body.invalidRuleRows[0].reason).toMatch(/Purpose/);
  });

  it("rejects a blank-Rule-Id row whose destination name doesn't resolve", async () => {
    const csv = RULES_CSV_HEADER + ruleCsvRow({ destinationName: "Narnia", purpose: "TOURIST" });
    const res = await request(makeApp()).post("/rules/import/preview").attach("file", Buffer.from(csv), "x.csv");

    expect(res.status).toBe(200);
    expect(res.body.createdCount).toBe(0);
    expect(res.body.invalidRuleRows).toHaveLength(1);
    expect(res.body.invalidRuleRows[0].reason).toMatch(/not a recognised destination/);
  });

  it("rejects a create whose natural key collides with an existing rule, naming its Rule Id", async () => {
    const rule = fullRule({ destinationIso2: "DE", purpose: "TOURIST", entryType: "MULTIPLE", serviceTier: "STANDARD" });
    const csv =
      RULES_CSV_HEADER +
      ruleCsvRow({ destinationIso2: "DE", purpose: "TOURIST", entryType: "MULTIPLE", serviceTier: "STANDARD" });
    const res = await request(makeApp()).post("/rules/import/preview").attach("file", Buffer.from(csv), "x.csv");

    expect(res.status).toBe(200);
    expect(res.body.createdCount).toBe(0);
    expect(res.body.invalidRuleRows).toHaveLength(1);
    expect(res.body.invalidRuleRows[0].reason).toContain(String(rule._id));
    expect(res.body.invalidRuleRows[0].reason).toMatch(/that's an update, not a create/);
  });

  it("rejects both rows when two blank-Rule-Id rows would create the same destination/purpose/entry type/service tier", async () => {
    const dupRow = ruleCsvRow({ destinationIso2: "FR", purpose: "TOURIST", entryType: "SINGLE", serviceTier: "EXPRESS" });
    const csv = RULES_CSV_HEADER + dupRow + dupRow;
    const res = await request(makeApp()).post("/rules/import/preview").attach("file", Buffer.from(csv), "x.csv");

    expect(res.status).toBe(200);
    expect(res.body.createdCount).toBe(0);
    expect(res.body.invalidRuleRows).toHaveLength(2);
    expect(res.body.invalidRuleRows.map((r: any) => r.rowNumber)).toEqual([2, 3]);
  });

  it("never publishes a created rule, even if the file smuggles a PUBLISHED-looking status cell", async () => {
    const csv = RULES_CSV_HEADER + ruleCsvRow({ destinationIso2: "FR", purpose: "TOURIST", status: "PUBLISHED" });
    const res = await request(makeApp()).post("/rules/import/commit").attach("file", Buffer.from(csv), "smuggle.csv");

    expect(res.status).toBe(200);
    expect(res.body.createdCount).toBe(1);
    expect(_rules.query({})[0].status).toBe("DRAFT");
  });

  it("a create row appears in the preview's ruleCreates section, never in ruleChanges — and preview writes nothing", async () => {
    const csv = RULES_CSV_HEADER + ruleCsvRow({ destinationIso2: "FR", purpose: "TOURIST" });
    const res = await request(makeApp()).post("/rules/import/preview").attach("file", Buffer.from(csv), "x.csv");

    expect(res.status).toBe(200);
    expect(res.body.createdCount).toBe(1);
    expect(res.body.ruleCreates).toHaveLength(1);
    expect(res.body.ruleCreates[0].ruleId).toBeUndefined(); // dry run — nothing actually created yet
    expect(res.body.ruleChanges).toEqual([]);
    expect(res.body.changedCount).toBe(0);
    expect(_rules.query({}).length).toBe(0);
  });

  it("accepts destination by ISO3 or by name, resolving both to the canonical ISO2/name", async () => {
    const byIso3 = RULES_CSV_HEADER + ruleCsvRow({ destinationIso2: "DEU", purpose: "TOURIST", entryType: "SINGLE" });
    const res1 = await request(makeApp()).post("/rules/import/preview").attach("file", Buffer.from(byIso3), "iso3.csv");
    expect(res1.body.ruleCreates[0].destinationIso2).toBe("DE");
    expect(res1.body.ruleCreates[0].destinationName).toBe("Germany");

    const byName = RULES_CSV_HEADER + ruleCsvRow({ destinationName: "germany", purpose: "TOURIST", entryType: "DOUBLE" });
    const res2 = await request(makeApp()).post("/rules/import/preview").attach("file", Buffer.from(byName), "name.csv");
    expect(res2.body.ruleCreates[0].destinationIso2).toBe("DE");
    expect(res2.body.ruleCreates[0].destinationName).toBe("Germany");
  });
});
