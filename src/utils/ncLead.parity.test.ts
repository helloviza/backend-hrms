// apps/backend/src/utils/ncLead.parity.test.ts
//
// The NC lead pairs are listed twice — here (the API's rule) and in the
// booking form (frontend pages/admin/ncLeadRule.ts). They must match, or the
// form and the API disagree about what an NC lead needs. Every NC value must
// also be a real Sub Status of its status group in the model. Skipped where
// the frontend isn't checked out (the backend-only subtree).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { NC_LEAD_SUB_STATUSES } from "./ncLead.js";
import { CANCELLED_SUB_STATUSES, PENDING_SUB_STATUSES } from "../models/ManualBooking.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const formRule = path.resolve(here, "../../../frontend/src/pages/admin/ncLeadRule.ts");
const block = (src: string) => src.replace(/\r\n/g, "\n").match(/NC_LEAD_SUB_STATUSES[^=]*=\s*(\{[\s\S]*?\n\});/)?.[1] || "";

describe("NC lead pairs", () => {
  it("are real Sub Status values of their group", () => {
    for (const v of NC_LEAD_SUB_STATUSES.PENDING) expect(PENDING_SUB_STATUSES as readonly string[]).toContain(v);
    for (const v of NC_LEAD_SUB_STATUSES.CANCELLED) expect(CANCELLED_SUB_STATUSES as readonly string[]).toContain(v);
  });
});

describe.skipIf(!fs.existsSync(formRule))("NC lead pairs: API and form agree", () => {
  it("the form lists the same pairs", () => {
    const backend = block(fs.readFileSync(fileURLToPath(new URL("./ncLead.ts", import.meta.url)), "utf8"));
    const frontend = block(fs.readFileSync(formRule, "utf8"));
    expect(backend).not.toBe("");
    expect(frontend).toBe(backend);
  });
});
