// apps/backend/src/routes/users.mySpaceAccent.test.ts
//
// My Space accent: "orange" is allowed and is the default for a user who never
// picked one; the route allowlist and the User model enum must agree.
import { describe, it, expect } from "vitest";

process.env.NODE_ENV = "test";

const { MY_SPACE_ACCENTS, DEFAULT_MY_SPACE_ACCENT } = await import("./users.js");
const { default: User } = await import("../models/User.js");

describe("mySpaceAccent", () => {
  it("allows orange and defaults to it", () => {
    expect(MY_SPACE_ACCENTS.has("orange")).toBe(true);
    expect(DEFAULT_MY_SPACE_ACCENT).toBe("orange");
    expect((User.schema.path("mySpaceAccent") as any).defaultValue).toBe("orange");
    expect(new User({ email: "x@example.test" }).get("mySpaceAccent")).toBe("orange");
  });

  it("the route allowlist and the model enum are the same set", () => {
    const enumValues = [...(User.schema.path("mySpaceAccent") as any).enumValues].sort();
    expect([...MY_SPACE_ACCENTS].sort()).toEqual(enumValues);
    expect(enumValues).toEqual(["black", "emerald", "navy", "orange", "plum", "terracotta"]);
  });
});
