// apps/backend/src/services/approvalItemRules.parity.test.ts
//
// The request form and the server run the same item rules: the backend copy
// (services/approvalItemRules.ts) and the frontend copy
// (apps/frontend/src/lib/approvalItemRules.ts) must stay byte-identical below
// their 3-line headers, or the server would refuse (or accept) what the form
// doesn't. Skipped where the frontend isn't checked out (the backend-only
// GitHub subtree).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendCopy = path.join(here, "approvalItemRules.ts");
const frontendCopy = path.resolve(here, "../../../frontend/src/lib/approvalItemRules.ts");
const body = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n").split("\n").slice(3).join("\n");

describe.skipIf(!fs.existsSync(frontendCopy))("approval item rules: form and server agree", () => {
  it("the two copies are identical below the header", () => {
    expect(body(backendCopy)).toBe(body(frontendCopy));
  });
});
