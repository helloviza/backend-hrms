// Proof for the empty-string-on-an-enum coercion.
//
// Two halves, deliberately:
//
//   1. The plugin IN ISOLATION, against a throwaway schema defined in this
//      file (collection `enum_plugin_probe`). That is where the rules live
//      — what is coerced, what is excluded, and that non-enum paths are
//      untouched — because a probe schema can carry shapes the real model
//      does not, like a required enum and an enum that legitimately
//      contains "".
//
//   2. THE REAL ConsumerProfile, because the bug was never about a probe:
//      it was that saving a real profile 500'd. These assert the five
//      genuinely-optional enums accept "" and come back unset, and that
//      passports[].type is still excluded.
//
// Assertions about what is stored read the RAW collection through the
// driver. Reading back through Mongoose would prove a round trip and
// nothing about whether the field is absent or an empty string at rest —
// which is the entire question.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose, { Schema } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { emptyEnumToUnsetPlugin } from "./emptyEnumToUnset.plugin.js";

let mem: MongoMemoryServer;

beforeAll(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri(), { dbName: "enum_plugin_probe_db" });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mem.stop();
});

/* ── the throwaway probe schema ─────────────────────────────────────── */

const ProbeChildSchema = new Schema(
  {
    // The shape the bug lived in: optional enum, no default.
    optionalEnum: { type: String, enum: ["A", "B"] },
  },
  { _id: false },
);

const ProbeArrayItemSchema = new Schema({
  // Excluded: a default says this path always holds a value.
  defaulted: { type: String, enum: ["X", "Y"], default: "X" },
});

const ProbeSchema = new Schema({
  optionalEnum: { type: String, enum: ["A", "B"] },
  requiredEnum: { type: String, enum: ["A", "B"], required: true },
  defaultedEnum: { type: String, enum: ["A", "B"], default: "A" },
  // A schema that has declared "" a legitimate value — must be left alone.
  emptyIsValid: { type: String, enum: ["A", "B", ""], default: "" },
  freeText: { type: String, trim: true },
  child: { type: ProbeChildSchema, default: () => ({}) },
  items: { type: [ProbeArrayItemSchema], default: () => [] },
});

ProbeSchema.plugin(emptyEnumToUnsetPlugin);
const Probe = mongoose.model("EnumPluginProbe", ProbeSchema, "enum_plugin_probe");

const raw = () => mongoose.connection.collection("enum_plugin_probe");

beforeEach(async () => {
  await raw().deleteMany({});
});

/* ── 1. the plugin's rules ──────────────────────────────────────────── */

describe("empty string on an optional enum", () => {
  it("saves as UNSET rather than throwing a validation error", async () => {
    const doc = new Probe({ requiredEnum: "A" });
    doc.optionalEnum = "" as any;
    await expect(doc.save()).resolves.toBeTruthy();

    const stored: any = await raw().findOne({ _id: doc._id });
    // Absent, not "" — the whole point.
    expect("optionalEnum" in stored).toBe(false);
  });

  it("is coerced inside a single-nested sub-schema", async () => {
    const doc = new Probe({ requiredEnum: "A" });
    (doc as any).child.optionalEnum = "";
    await expect(doc.save()).resolves.toBeTruthy();

    const stored: any = await raw().findOne({ _id: doc._id });
    expect(stored.child?.optionalEnum).toBeUndefined();
  });

  it("still stores a VALID enum value untouched", async () => {
    const doc = new Probe({ requiredEnum: "A", optionalEnum: "B" });
    await doc.save();

    const stored: any = await raw().findOne({ _id: doc._id });
    expect(stored.optionalEnum).toBe("B");
  });

  it("still REJECTS a genuinely invalid value — validation is not weakened", async () => {
    const doc = new Probe({ requiredEnum: "A" });
    doc.optionalEnum = "NOPE" as any;
    await expect(doc.save()).rejects.toThrow(/not a valid enum value/);
  });
});

describe("what the plugin leaves alone", () => {
  it("does not weaken a REQUIRED enum — '' still fails, as missing", async () => {
    const doc = new Probe({ requiredEnum: "A" });
    doc.requiredEnum = "" as any;
    // Excluded from coercion, so "" reaches the enum validator as before.
    await expect(doc.save()).rejects.toThrow(/valid enum value|required/i);
  });

  it("does not strip a DEFAULTED enum to undefined", async () => {
    const doc = new Probe({ requiredEnum: "A" });
    doc.defaultedEnum = "" as any;
    await expect(doc.save()).rejects.toThrow(/not a valid enum value/);
  });

  it("does not strip a defaulted enum inside a document ARRAY (the passports[].type shape)", async () => {
    const doc = new Probe({ requiredEnum: "A" });
    (doc as any).items.push({});
    await doc.save();

    const stored: any = await raw().findOne({ _id: doc._id });
    // The default survived — it was not coerced away.
    expect(stored.items[0].defaulted).toBe("X");
  });

  it("leaves an enum that legitimately CONTAINS '' alone", async () => {
    const doc = new Probe({ requiredEnum: "A" });
    (doc as any).emptyIsValid = "";
    await expect(doc.save()).resolves.toBeTruthy();

    const stored: any = await raw().findOne({ _id: doc._id });
    // Stored AS "", not unset — the schema declared it valid.
    expect(stored.emptyIsValid).toBe("");
  });

  it("leaves NON-ENUM paths untouched — free text can still be cleared with ''", async () => {
    const doc = new Probe({ requiredEnum: "A", freeText: "something" });
    await doc.save();

    doc.freeText = "";
    await doc.save();

    const stored: any = await raw().findOne({ _id: doc._id });
    // Empty string, NOT unset: clearing a text field is a real operation
    // and this plugin must not turn it into "leave it as it was".
    expect(stored.freeText).toBe("");
  });
});

/* ── 2. the real ConsumerProfile ────────────────────────────────────── */

const { default: ConsumerProfile } = await import("../models/ConsumerProfile.js");

/** The five that were 500ing, with the section each lives in. */
const OPTIONAL_ENUMS: Array<[section: string, field: string, valid: string]> = [
  ["personal", "gender", "FEMALE"],
  ["personal", "maritalStatus", "SINGLE"],
  ["travel", "employmentType", "SALARIED"],
  ["travelPreferences", "cabinClass", "BUSINESS"],
  ["travelPreferences", "seatPreference", "WINDOW"],
];

describe("ConsumerProfile — the five optional enums that produced the 500", () => {
  const profiles = () => mongoose.connection.collection("consumerprofiles");

  beforeEach(async () => {
    await profiles().deleteMany({});
  });

  async function freshProfile() {
    return ConsumerProfile.create({
      consumerId: new mongoose.Types.ObjectId(),
      workspaceId: new mongoose.Types.ObjectId(),
    });
  }

  for (const [section, field, valid] of OPTIONAL_ENUMS) {
    it(`${section}.${field}: "" saves and is stored unset`, async () => {
      const doc: any = await freshProfile();
      doc[section][field] = "";
      await expect(doc.save()).resolves.toBeTruthy();

      const stored: any = await profiles().findOne({ _id: doc._id });
      expect(stored[section]?.[field]).toBeUndefined();
    });

    it(`${section}.${field}: a real value still round-trips`, async () => {
      const doc: any = await freshProfile();
      doc[section][field] = valid;
      await doc.save();

      const stored: any = await profiles().findOne({ _id: doc._id });
      expect(stored[section][field]).toBe(valid);
    });

    it(`${section}.${field}: an invalid value is still rejected`, async () => {
      const doc: any = await freshProfile();
      doc[section][field] = "NOT_A_REAL_VALUE";
      await expect(doc.save()).rejects.toThrow(/not a valid enum value/);
    });
  }

  it("passports[].type keeps its default and is NOT coerced", async () => {
    const doc: any = await freshProfile();
    doc.passports.push({ number: "Z1234567" });
    await doc.save();

    const stored: any = await profiles().findOne({ _id: doc._id });
    expect(stored.passports[0].type).toBe("ORDINARY");
  });

  it("personal.middleName — a free-text neighbour — can still be cleared", async () => {
    const doc: any = await freshProfile();
    doc.personal.middleName = "Kumar";
    await doc.save();

    doc.personal.middleName = "";
    await doc.save();

    const stored: any = await profiles().findOne({ _id: doc._id });
    expect(stored.personal.middleName).toBe("");
  });

  it("the whole Personal section saves with every optional enum empty — the original repro", async () => {
    // Exactly what PersonalTab submits for a profile nobody has filled in:
    // the entire draft, with "" for each untouched select.
    const doc: any = await freshProfile();
    Object.assign(doc.personal, {
      firstName: "Ananya",
      lastName: "Test",
      gender: "",
      maritalStatus: "",
    });
    await expect(doc.save()).resolves.toBeTruthy();

    const stored: any = await profiles().findOne({ _id: doc._id });
    expect(stored.personal.firstName).toBe("Ananya");
    expect(stored.personal.gender).toBeUndefined();
    expect(stored.personal.maritalStatus).toBeUndefined();
  });
});
