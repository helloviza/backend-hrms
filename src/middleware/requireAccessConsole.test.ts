// apps/backend/src/middleware/requireAccessConsole.test.ts
//
// The Access Console door. Four ways in, and the tier that separates
// looking from changing.
//
// The grant-path tests below deliberately give the caller roles ["HR"],
// not ["ADMIN"]: ADMIN is now admitted by role at path 3, so an ADMIN
// caller would never reach the database lookup and those tests would be
// asserting nothing. HR is the nearest staff role with no door of its own.
import { describe, it, expect, vi, beforeEach } from "vitest";

const findOne = vi.fn();
vi.mock("../models/UserPermission.js", () => ({
  UserPermission: {
    findOne: (...args: any[]) => findOne(...args),
  },
}));

const { requireAccessConsole, requireAccessConsoleWrite } = await import("./requireAccessConsole.js");

function ctx(user: any) {
  const req: any = { user };
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: any) {
      this.body = b;
      return this;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

/** UserPermission.findOne(...).select(...).lean() */
function perm(doc: any) {
  findOne.mockReturnValue({ select: () => ({ lean: async () => doc }) });
}

beforeEach(() => {
  findOne.mockReset();
  perm(null);
});

describe("requireAccessConsole — the role doors", () => {
  it("401s with no session at all", async () => {
    const { req, res, next } = ctx(undefined);
    await requireAccessConsole(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("admits a platform SUPERADMIN and marks it as one", async () => {
    const { req, res, next } = ctx({ _id: "u1", roles: ["SUPERADMIN"] });
    await requireAccessConsole(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.isPlatformSuperAdmin).toBe(true);
    expect(req.accessConsoleAccess).toBe("FULL");
    // The superadmin path must not need the database at all.
    expect(findOne).not.toHaveBeenCalled();
  });

  it("admits a TENANT_ADMIN but does NOT mark it a platform superadmin", async () => {
    const { req, res, next } = ctx({ _id: "u2", roles: ["TENANT_ADMIN"] });
    await requireAccessConsole(req, res, next);
    expect(next).toHaveBeenCalled();
    // This is what keeps every downstream workspace-scoping branch active.
    expect(req.isPlatformSuperAdmin).toBe(false);
    expect(req.accessConsoleAccess).toBe("FULL");
  });

  it("admits an ADMIN on the role alone — no grant needed, no DB read", async () => {
    const { req, res, next } = ctx({ _id: "69c698fcf7deb366cb39f332", roles: ["ADMIN"] });
    await requireAccessConsole(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.accessConsoleAccess).toBe("FULL");
    expect(findOne).not.toHaveBeenCalled();
  });

  it("an ADMIN is workspace-scoped, NEVER a platform superadmin", async () => {
    const { req, res, next } = ctx({ _id: "u3", roles: ["ADMIN"] });
    await requireAccessConsole(req, res, next);
    // The single most important assertion in this file: false here is what
    // keeps /list, /grant and /update confined to the caller's own workspace.
    expect(req.isPlatformSuperAdmin).toBe(false);
  });

  it("does not admit a plain EMPLOYEE", async () => {
    perm(null);
    const { req, res, next } = ctx({ _id: "u4", roles: ["EMPLOYEE"] });
    await requireAccessConsole(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not admit an HR user who holds no grant", async () => {
    perm(null);
    const { req, res, next } = ctx({ _id: "u5", roles: ["HR"] });
    await requireAccessConsole(req, res, next);
    expect(res.statusCode).toBe(403);
  });
});

describe("requireAccessConsole — the permission door", () => {
  it("admits a non-role holder carrying a FULL grant", async () => {
    perm({ status: "active", modules: { accessConsole: { access: "FULL", scope: "WORKSPACE" } } });
    const { req, res, next } = ctx({ _id: "u6", roles: ["HR"] });
    await requireAccessConsole(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.isPlatformSuperAdmin).toBe(false);
    expect(req.accessConsoleAccess).toBe("FULL");
  });

  it("passes a READ grant through, carrying the tier", async () => {
    perm({ status: "active", modules: { accessConsole: { access: "READ", scope: "WORKSPACE" } } });
    const { req, res, next } = ctx({ _id: "u7", roles: ["HR"] });
    await requireAccessConsole(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.accessConsoleAccess).toBe("READ");
  });

  it("403s when accessConsole is NONE", async () => {
    perm({ status: "active", modules: { accessConsole: { access: "NONE", scope: "NONE" } } });
    const { req, res, next } = ctx({ _id: "u8", roles: ["HR"] });
    await requireAccessConsole(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s a SUSPENDED grant — a suspended grant is not a grant", async () => {
    perm({ status: "suspended", modules: { accessConsole: { access: "FULL", scope: "WORKSPACE" } } });
    const { req, res, next } = ctx({ _id: "u9", roles: ["HR"] });
    await requireAccessConsole(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("500s rather than admitting anyone when the lookup throws", async () => {
    findOne.mockReturnValue({
      select: () => ({
        lean: async () => {
          throw new Error("mongo down");
        },
      }),
    });
    const { req, res, next } = ctx({ _id: "u10", roles: ["HR"] });
    await requireAccessConsole(req, res, next);
    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("requireAccessConsoleWrite", () => {
  it("lets FULL and WRITE through", () => {
    for (const tier of ["FULL", "WRITE"]) {
      const { req, res, next } = ctx({});
      req.accessConsoleAccess = tier;
      requireAccessConsoleWrite(req, res, next);
      expect(next).toHaveBeenCalled();
    }
  });

  it("403s a READ-only holder — they may look, not re-grant", () => {
    const { req, res, next } = ctx({});
    req.accessConsoleAccess = "READ";
    requireAccessConsoleWrite(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("403s when no tier was set at all", () => {
    const { req, res, next } = ctx({});
    requireAccessConsoleWrite(req, res, next);
    expect(res.statusCode).toBe(403);
  });
});
