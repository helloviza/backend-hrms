// Pure rules of services/personNames.ts: company comparison, the full-name
// split, the promote suggestion order, and what a typed name may be.
import { describe, it, expect } from "vitest";
import {
  normaliseCompany,
  sameAsCompany,
  splitPersonName,
  suggestLoginPersonName,
  promotePersonName,
  validateNameInput,
} from "./personNames.js";

const COMPANY = ["Peachmint Foods Private Limited"];

describe("company comparison", () => {
  it("ignores case, punctuation and the legal-form suffix", () => {
    expect(normaliseCompany("Peachmint Foods Pvt. Ltd.")).toBe("peachmint foods");
    expect(sameAsCompany("PEACHMINT FOODS", COMPANY)).toBe(true);
    expect(sameAsCompany("Asha Rao", COMPANY)).toBe(false);
    expect(sameAsCompany("", COMPANY)).toBe(false);
  });
});

describe("splitPersonName", () => {
  it("first word / the rest; emails and placeholders are not names", () => {
    expect(splitPersonName(" Asha  Rao Iyer ")).toEqual({ firstName: "Asha", lastName: "Rao Iyer", name: "Asha Rao Iyer" });
    expect(splitPersonName("Asha")).toEqual({ firstName: "Asha", lastName: "", name: "Asha" });
    expect(splitPersonName("asha@x.test").name).toBe("");
    expect(splitPersonName("Workspace User").name).toBe("");
  });
});

describe("suggestLoginPersonName", () => {
  const form = {
    keyContacts: [{ name: "Ravi Menon", email: "ravi@x.test" }, { name: "Asha Rao", email: "ASHA@x.test" }],
    signatory: { name: "Sig Nat" },
  };
  it("customer: matching key contact → first key contact → signatory → invitee", () => {
    const s = (f: any, email = "asha@x.test", inviteeName?: string) =>
      suggestLoginPersonName({ kind: "customer", onboarding: { inviteeName }, form: f, email, companyNames: COMPANY });
    expect(s(form)).toEqual({ name: "Asha Rao", source: "keyContactEmail" });
    expect(s(form, "nobody@x.test")).toEqual({ name: "Ravi Menon", source: "keyContact" });
    expect(s({ signatory: form.signatory })).toEqual({ name: "Sig Nat", source: "signatory" });
    expect(s({}, "a@x.test", "Invitee Person")).toEqual({ name: "Invitee Person", source: "invitee" });
  });
  it("skips any candidate that is the company; nothing left → none", () => {
    const s = suggestLoginPersonName({
      kind: "customer",
      onboarding: { inviteeName: "Peachmint Foods" },
      form: { keyContacts: [{ name: "PEACHMINT FOODS PVT LTD" }] },
      companyNames: COMPANY,
    });
    expect(s).toEqual({ name: "", source: "none" });
  });
  it("vendor: contact person → invitee", () => {
    const v = (f: any, inviteeName?: string) =>
      suggestLoginPersonName({ kind: "vendor", onboarding: { inviteeName }, form: f, companyNames: ["Acme Travels LLP"] });
    expect(v({ contactPerson: { name: "Kiran Mehta" } })).toEqual({ name: "Kiran Mehta", source: "contactPerson" });
    expect(v({}, "Acme Travels")).toEqual({ name: "", source: "none" });
  });
});

describe("promotePersonName", () => {
  const params = { kind: "customer" as const, onboarding: {}, form: { signatory: { name: "Sig Nat" } }, companyNames: COMPANY };
  it("the typed value wins; '' is unknown; the company is dropped; absent → suggestion", () => {
    expect(promotePersonName({ personName: "Meera Nair" }, params).name).toBe("Meera Nair");
    expect(promotePersonName({ personName: "" }, params).name).toBe("");
    expect(promotePersonName({ personName: "Peachmint Foods" }, params).name).toBe("");
    expect(promotePersonName({}, params)).toEqual({ firstName: "Sig", lastName: "Nat", name: "Sig Nat" });
  });
});

describe("validateNameInput", () => {
  it("accepts a first name alone; trims and collapses spaces", () => {
    expect(validateNameInput({ firstName: " Asha ", lastName: "" })).toEqual({ firstName: "Asha", lastName: "", name: "Asha" });
    expect(validateNameInput({ firstName: "Asha", lastName: "Rao  Iyer" })).toEqual({ firstName: "Asha", lastName: "Rao Iyer", name: "Asha Rao Iyer" });
  });
  it("refuses empty first name, emails, markup, placeholders, over-long parts", () => {
    for (const input of [
      { firstName: "", lastName: "Rao" },
      { firstName: "a@b.test", lastName: "" },
      { firstName: "<b>Asha</b>", lastName: "" },
      { firstName: "Workspace", lastName: "User" },
      { firstName: "A".repeat(61), lastName: "" },
    ]) {
      expect("error" in validateNameInput(input)).toBe(true);
    }
  });
});
