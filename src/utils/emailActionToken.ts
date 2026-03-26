// apps/backend/src/utils/emailActionToken.ts
import crypto from "crypto";
import jwt, { type Secret, type SignOptions } from "jsonwebtoken";

// ✅ jsonwebtoken expects Secret
const SECRET: Secret = (process.env.EMAIL_ACTION_SECRET ||
  process.env.JWT_SECRET ||
  "dev-secret") as Secret;

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function signEmailActionToken(
  payload: Record<string, any>,
  // Default 12h — configurable per workspace
  expiresIn: NonNullable<SignOptions["expiresIn"]> = "12h"
) {
  const options: SignOptions = { expiresIn };
  return jwt.sign(payload, SECRET, options);
}

export function verifyEmailActionToken(token: string) {
  return jwt.verify(token, SECRET) as Record<string, any>;
}
