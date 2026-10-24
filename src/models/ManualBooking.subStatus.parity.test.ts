// apps/backend/src/models/ManualBooking.subStatus.parity.test.ts
//
// Sub Status lives in three places: the model enum (models/ManualBooking.ts),
// the booking form's dropdown (FE pages/admin/ManualBookingForm.tsx) and the
// list's filter (FE pages/admin/ManualBookings.tsx). They must list the same
// values, or the form offers a value the server refuses (or the filter can't
// find one it accepts). The values that existed before the partner-lead Sub
// Statuses are pinned too, so none is renamed or dropped by accident.
// Skipped where the frontend isn't checked out (the backend-only subtree).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import ManualBooking, { PENDING_SUB_STATUSES, CANCELLED_SUB_STATUSES, ALL_SUB_STATUSES } from "./ManualBooking.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const formFile = path.resolve(here, "../../../frontend/src/pages/admin/ManualBookingForm.tsx");
const listFile = path.resolve(here, "../../../frontend/src/pages/admin/ManualBookings.tsx");
const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** The string literals inside `const NAME = [ ... ];`. */
function arrayStrings(src: string, name: string, pick = /"([^"]+)"/g): string[] {
  const m = src.match(new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\s*\\];`));
  if (!m) throw new Error(`${name} not found`);
  return [...m[1].matchAll(pick)].map((x) => x[1]);
}

const OLD_PENDING = ["Pending for Customer Confirmation", "Pending for Supplier Confirmation"];
const OLD_CANCELLED = ["Fare Difference", "Price sudden increase", "Not Sure for dates", "Not Sure for Location", "Plan changed", "Travel cancelled"];
const NEW_PENDING = ["Lead Not Contactable", "NC Leads - Email Sent", "NC Leads - Multiple Follow-up Done"];
const NEW_CANCELLED = ["Lead Not Contactable"];

describe("Sub Status values", () => {
  it("the model keeps every existing value, in order, and adds the partner-lead ones after them", () => {
    expect([...PENDING_SUB_STATUSES]).toEqual([...OLD_PENDING, ...NEW_PENDING]);
    expect([...CANCELLED_SUB_STATUSES]).toEqual([...OLD_CANCELLED, ...NEW_CANCELLED]);
    expect(ALL_SUB_STATUSES).toEqual([...OLD_PENDING, ...NEW_PENDING, ...OLD_CANCELLED]);
  });

  it("the schema accepts every value, old and new, and still refuses an unknown one", () => {
    const errorFor = (subStatus: string) =>
      new ManualBooking({ workspaceId: new mongoose.Types.ObjectId(), type: "FLIGHT", subStatus }).validateSync()?.errors?.subStatus;
    for (const v of [...OLD_PENDING, ...OLD_CANCELLED, ...NEW_PENDING, ...NEW_CANCELLED, ""]) expect(errorFor(v)).toBeUndefined();
    expect(errorFor("Lead not contactable")).toBeDefined();
  });
});

describe.skipIf(!fs.existsSync(formFile) || !fs.existsSync(listFile))("Sub Status: model, form and filter agree", () => {
  it("the form's dropdown lists exactly the model's values per status", () => {
    const src = read(formFile);
    expect(arrayStrings(src, "PENDING_SUB_STATUSES")).toEqual([...PENDING_SUB_STATUSES]);
    expect(arrayStrings(src, "CANCELLED_SUB_STATUSES")).toEqual([...CANCELLED_SUB_STATUSES]);
  });

  it("the list's filter offers every model value once", () => {
    const values = arrayStrings(read(listFile), "SUB_STATUS_OPTIONS", /value:\s*"([^"]+)"/g);
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort()).toEqual([...ALL_SUB_STATUSES].sort());
  });
});
