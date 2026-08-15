// apps/backend/src/utils/consumerJwt.ts
//
// Consumer token sign/verify. Every function here resolves its secret through
// config/consumerAuth.ts's getConsumerJwtSecret(), which is fail-closed and
// refuses a value equal to JWT_SECRET — so there is no path through this file
// that can mint or accept a token the B2B side would also accept.
//
// Note what is NOT here: a `signToken`-style convenience wrapper with a
// default secret. utils/jwt.ts has exactly that (and zero callers — it is
// dead code sitting next to the codebase's most-used verifier), which is how
// a future contributor ends up adding a claim to the wrong half. One signer
// per token type, each with its secret resolved explicitly.
import jwt from "jsonwebtoken";
import {
  CONSUMER_AUDIENCE,
  CONSUMER_ACCESS_EXPIRES_IN,
  CONSUMER_REFRESH_EXPIRES_IN,
  getConsumerJwtSecret,
} from "../config/consumerAuth.js";

// `typ` separates access from refresh. B2B gets that separation for free by
// signing refresh tokens with a DIFFERENT secret (JWT_REFRESH_SECRET); the
// consumer side uses one secret for both, so the discriminator has to be an
// explicit claim. Without it a refresh token — which lives 7 days — would be
// replayable as a 30-minute access token.
export const CONSUMER_ACCESS_TYP = "access";
export const CONSUMER_REFRESH_TYP = "refresh";

export interface ConsumerTokenPayload {
  sub: string;
  tokenVersion: number;
  aud: typeof CONSUMER_AUDIENCE;
  typ: string;
  iat?: number;
  exp?: number;
}

export interface ConsumerTokenInput {
  consumerId: string;
  tokenVersion: number;
}

export function signConsumerAccessToken(input: ConsumerTokenInput): string {
  return jwt.sign(
    {
      sub: String(input.consumerId),
      tokenVersion: Number(input.tokenVersion),
      aud: CONSUMER_AUDIENCE,
      typ: CONSUMER_ACCESS_TYP,
    },
    getConsumerJwtSecret(),
    { expiresIn: CONSUMER_ACCESS_EXPIRES_IN },
  );
}

export function signConsumerRefreshToken(input: ConsumerTokenInput): string {
  return jwt.sign(
    {
      sub: String(input.consumerId),
      tokenVersion: Number(input.tokenVersion),
      aud: CONSUMER_AUDIENCE,
      typ: CONSUMER_REFRESH_TYP,
    },
    getConsumerJwtSecret(),
    { expiresIn: CONSUMER_REFRESH_EXPIRES_IN },
  );
}

/**
 * Verifies signature FIRST (this is where a B2B token dies), then asserts the
 * audience and the expected `typ`. Throws on any failure — callers translate
 * that into a 401 rather than this file knowing about HTTP.
 *
 * jsonwebtoken's own `audience` verify option is deliberately not used: it
 * would conflate "wrong audience" with "bad signature" into one
 * JsonWebTokenError, and the distinction matters when reading logs — one is a
 * misrouted token, the other is an attack or a misconfigured secret.
 */
function verifyConsumerToken(token: string, expectedTyp: string): ConsumerTokenPayload {
  const payload = jwt.verify(token, getConsumerJwtSecret()) as any;

  if (payload?.aud !== CONSUMER_AUDIENCE) {
    throw new Error(`Unexpected token audience: ${String(payload?.aud)}`);
  }
  if (payload?.typ !== expectedTyp) {
    throw new Error(`Unexpected token type: ${String(payload?.typ)}`);
  }
  if (!payload?.sub) {
    throw new Error("Token carries no subject");
  }
  if (typeof payload?.tokenVersion !== "number") {
    throw new Error("Token carries no tokenVersion");
  }

  return payload as ConsumerTokenPayload;
}

export function verifyConsumerAccessToken(token: string): ConsumerTokenPayload {
  return verifyConsumerToken(token, CONSUMER_ACCESS_TYP);
}

export function verifyConsumerRefreshToken(token: string): ConsumerTokenPayload {
  return verifyConsumerToken(token, CONSUMER_REFRESH_TYP);
}
