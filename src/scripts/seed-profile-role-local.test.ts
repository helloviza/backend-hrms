// apps/backend/src/scripts/seed-profile-role-local.test.ts
//
// The local-only seed for the /profile/me Admin layout must never touch a
// real cluster and never delete anything.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isLocalOnly, mongoHosts } from "./seed-profile-role-local.js";

describe("seed-profile-role-local guard", () => {
  it("accepts only mongodb:// URIs whose every host is 127.0.0.1 / localhost", () => {
    expect(isLocalOnly("mongodb://127.0.0.1:27027/plumbox_profile_role")).toBe(true);
    expect(isLocalOnly("mongodb://localhost/x")).toBe(true);
    expect(isLocalOnly("mongodb+srv://u:p@cluster0.example.net/db")).toBe(false);
    expect(isLocalOnly("mongodb://u:p@10.0.0.5:27017/db")).toBe(false);
    expect(isLocalOnly("mongodb://127.0.0.1:27017,db.example.com:27017/x")).toBe(false);
    expect(isLocalOnly("mongodb://u:p@127.0.0.1@evil.example.com/x")).toBe(false);
    expect(isLocalOnly("")).toBe(false);
    expect(mongoHosts("mongodb://u:secret@127.0.0.1:27027/x")).toEqual(["127.0.0.1"]);
  });

  it("never deletes: no deleteMany / deleteOne / drop calls in the script", () => {
    const src = readFileSync(new URL("./seed-profile-role-local.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\.(deleteMany|deleteOne|drop|dropDatabase|findOneAndDelete)\s*\(/);
  });
});
