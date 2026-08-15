// THE WALL, at token level, PROVEN BOTH WAYS.
//
// This is the load-bearing test of the whole phase. It asserts the Option D
// claim directly: consumer and B2B tokens are mutually unverifiable because
// they are signed with different secrets — not because either side inspects a
// claim.
//
// Note what the "B2B token" fixtures below are: real jwt.sign calls against
// JWT_SECRET with the exact claim shapes routes/auth.ts:149-165 and
// routes/superadmin.workspaces.ts:658 emit. They are not stand-ins.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import {
  signConsumerAccessToken,
  signConsumerRefreshToken,
  verifyConsumerAccessToken,
  verifyConsumerRefreshToken,
} from "./consumerJwt.js";

const B2B_SECRET = "b2b-jwt-secret-for-tests";
const CONSUMER_SECRET = "consumer-jwt-secret-for-tests";

// config/env.ts hard-requires these (requireEnv with no fallback) and throws
// at import time without them. utils/jwt.ts imports it, and one test below
// imports utils/jwt.ts deliberately — to prove the wall against the REAL
// verifyToken rather than a re-implementation. The worktree has no .env
// (correctly gitignored), so they are stubbed here. None is used by anything
// under test; they exist only to let the module graph load.
process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/consumer-wall-test";
process.env.FRONTEND_ORIGIN ||= "http://localhost:5173";
process.env.S3_BUCKET ||= "test-bucket";
process.env.GEMINI_API_KEY ||= "test-gemini-key";

let savedJwt: string | undefined;
let savedConsumer: string | undefined;

beforeAll(() => {
  savedJwt = process.env.JWT_SECRET;
  savedConsumer = process.env.CONSUMER_JWT_SECRET;
  process.env.JWT_SECRET = B2B_SECRET;
  process.env.CONSUMER_JWT_SECRET = CONSUMER_SECRET;
});

afterAll(() => {
  if (savedJwt === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = savedJwt;
  if (savedConsumer === undefined) delete process.env.CONSUMER_JWT_SECRET;
  else process.env.CONSUMER_JWT_SECRET = savedConsumer;
});

/** The exact claim shape routes/auth.ts's signAccessToken emits. */
function mintB2BAccessToken(): string {
  return jwt.sign(
    {
      sub: "507f1f77bcf86cd799439011",
      roles: ["SUPERADMIN"],
      email: "staff@plumtrips.com",
      workspaceId: "69679a7628330a58d29f2254",
    },
    B2B_SECRET,
    { expiresIn: "30m" },
  );
}

describe("consumer token issuance", () => {
  it("mints an access token carrying sub, tokenVersion and aud CONSUMER", () => {
    const token = signConsumerAccessToken({ consumerId: "abc123", tokenVersion: 0 });
    const decoded: any = jwt.decode(token);
    expect(decoded.sub).toBe("abc123");
    expect(decoded.tokenVersion).toBe(0);
    expect(decoded.aud).toBe("CONSUMER");
    expect(decoded.typ).toBe("access");
  });

  it("mints a refresh token distinguishable from an access token", () => {
    const access = signConsumerAccessToken({ consumerId: "abc123", tokenVersion: 0 });
    const refresh = signConsumerRefreshToken({ consumerId: "abc123", tokenVersion: 0 });
    expect(access).not.toBe(refresh);
    expect((jwt.decode(refresh) as any).typ).toBe("refresh");
  });

  it("mirrors the B2B TTLs — 30m access, 7d refresh", () => {
    const access: any = jwt.decode(signConsumerAccessToken({ consumerId: "a", tokenVersion: 0 }));
    const refresh: any = jwt.decode(signConsumerRefreshToken({ consumerId: "a", tokenVersion: 0 }));
    expect(access.exp - access.iat).toBe(30 * 60);
    expect(refresh.exp - refresh.iat).toBe(7 * 24 * 60 * 60);
  });

  it("round-trips its own tokens", () => {
    const token = signConsumerAccessToken({ consumerId: "abc123", tokenVersion: 7 });
    const payload = verifyConsumerAccessToken(token);
    expect(payload.sub).toBe("abc123");
    expect(payload.tokenVersion).toBe(7);
  });
});

describe("THE WALL — direction 1: a B2B token must NOT verify as a consumer token", () => {
  it("rejects a real B2B access token on SIGNATURE, not on a claim check", () => {
    const b2bToken = mintB2BAccessToken();
    expect(() => verifyConsumerAccessToken(b2bToken)).toThrow();
    // The specific failure matters: it is jsonwebtoken's signature error, so
    // the rejection cannot be regressed by editing an aud allow-list.
    try {
      verifyConsumerAccessToken(b2bToken);
      throw new Error("should not reach here");
    } catch (err: any) {
      expect(err.name).toBe("JsonWebTokenError");
      expect(err.message).toMatch(/invalid signature/);
    }
  });

  it("rejects a B2B token even when it is hand-crafted to carry aud CONSUMER", () => {
    // Proves the aud claim is NOT what stops it. An attacker who knows the
    // claim shape still cannot forge one without the consumer secret.
    const forged = jwt.sign(
      { sub: "attacker", tokenVersion: 0, aud: "CONSUMER", typ: "access" },
      B2B_SECRET,
      { expiresIn: "30m" },
    );
    expect(() => verifyConsumerAccessToken(forged)).toThrow(/invalid signature/);
  });

  it("rejects a superadmin impersonation token", () => {
    const impersonation = jwt.sign(
      { sub: "507f1f77bcf86cd799439011", customerId: "acme", roles: ["SUPERADMIN"], _impersonating: true },
      B2B_SECRET,
      { expiresIn: "1h" },
    );
    expect(() => verifyConsumerAccessToken(impersonation)).toThrow(/invalid signature/);
  });
});

describe("THE WALL — direction 2: a consumer token must NOT verify against JWT_SECRET", () => {
  it("fails jwt.verify against JWT_SECRET — which is what EVERY B2B verifier does", () => {
    // All six B2B verifiers resolve to this same value (design doc §0a):
    //   middleware/auth.ts (via utils/jwt.ts verifyToken)
    //   middleware/authenticate.ts
    //   middleware/blockTravelForSaas.ts (via verifyToken)
    //   routes/auth.ts verifyAccessTokenOrThrow
    //   routes/chat.ts (via verifyToken)
    //   routes/workspace.ts decodeUser
    // So this single assertion covers all of them.
    const consumerToken = signConsumerAccessToken({ consumerId: "abc123", tokenVersion: 0 });
    expect(() => jwt.verify(consumerToken, B2B_SECRET)).toThrow(/invalid signature/);
  });

  it("fails against JWT_SECRET for the refresh token too", () => {
    const refresh = signConsumerRefreshToken({ consumerId: "abc123", tokenVersion: 0 });
    expect(() => jwt.verify(refresh, B2B_SECRET)).toThrow(/invalid signature/);
  });

  it("is not verifiable by utils/jwt.ts's verifyToken", async () => {
    // The actual production function, not a re-implementation. Imported
    // lazily so it picks up the JWT_SECRET set in beforeAll.
    const { verifyToken } = await import("./jwt.js");
    const consumerToken = signConsumerAccessToken({ consumerId: "abc123", tokenVersion: 0 });
    expect(() => verifyToken(consumerToken)).toThrow();
  });
});

describe("token type separation", () => {
  it("refuses a refresh token where an access token is expected", () => {
    const refresh = signConsumerRefreshToken({ consumerId: "abc123", tokenVersion: 0 });
    expect(() => verifyConsumerAccessToken(refresh)).toThrow(/Unexpected token type/);
  });

  it("refuses an access token where a refresh token is expected", () => {
    const access = signConsumerAccessToken({ consumerId: "abc123", tokenVersion: 0 });
    expect(() => verifyConsumerRefreshToken(access)).toThrow(/Unexpected token type/);
  });

  it("refuses a consumer-signed token carrying the wrong audience", () => {
    const wrongAud = jwt.sign(
      { sub: "abc", tokenVersion: 0, aud: "B2B", typ: "access" },
      CONSUMER_SECRET,
      { expiresIn: "30m" },
    );
    expect(() => verifyConsumerAccessToken(wrongAud)).toThrow(/Unexpected token audience/);
  });

  it("refuses a consumer-signed token with no tokenVersion", () => {
    const noVersion = jwt.sign({ sub: "abc", aud: "CONSUMER", typ: "access" }, CONSUMER_SECRET, {
      expiresIn: "30m",
    });
    expect(() => verifyConsumerAccessToken(noVersion)).toThrow(/no tokenVersion/);
  });
});
