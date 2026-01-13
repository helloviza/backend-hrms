import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
export type JwtPayload = { sub: string; roles: string[] };
export const signToken = (p: JwtPayload) =>
  jwt.sign(p, env.JWT_SECRET, { expiresIn: "1d" });
export const verifyToken = (t: string) =>
  jwt.verify(t, env.JWT_SECRET) as JwtPayload;
