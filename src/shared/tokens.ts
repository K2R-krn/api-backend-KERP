import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Prisma } from "@prisma/client";
import { env } from "../config/env.js";
import { MUST_CHANGE_PASSWORD_TOKEN_TTL_MS } from "./constants.js";
import { parseDurationToMs } from "./duration.js";
import { UnauthorizedError } from "./errors.js";
import { ROLES, type Role } from "./types.js";

export interface AccessTokenPayload {
  userId: string;
  role: Role;
}

export interface MustChangePasswordTokenPayload {
  userId: string;
  scope: "must_change_password";
}

function toSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: toSeconds(parseDurationToMs(env.ACCESS_TOKEN_TTL)),
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = verifyJwt(token, env.JWT_ACCESS_SECRET);
  // A must-change-password token must never be accepted as a normal access token.
  if ("scope" in decoded) throw new UnauthorizedError("INVALID_TOKEN");
  const { userId, role } = decoded;
  if (typeof userId !== "string" || !ROLES.includes(role as Role)) {
    throw new UnauthorizedError("INVALID_TOKEN");
  }
  return { userId, role: role as Role };
}

export function signMustChangePasswordToken(userId: string): string {
  const payload: MustChangePasswordTokenPayload = { userId, scope: "must_change_password" };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: toSeconds(MUST_CHANGE_PASSWORD_TOKEN_TTL_MS),
  });
}

export function verifyMustChangePasswordToken(token: string): MustChangePasswordTokenPayload {
  const decoded = verifyJwt(token, env.JWT_ACCESS_SECRET);
  if (decoded["scope"] !== "must_change_password" || typeof decoded["userId"] !== "string") {
    throw new UnauthorizedError("INVALID_TOKEN");
  }
  return { userId: decoded["userId"], scope: "must_change_password" };
}

function verifyJwt(token: string, secret: string): Record<string, unknown> {
  let decoded: jwt.JwtPayload | string;
  try {
    decoded = jwt.verify(token, secret);
  } catch {
    throw new UnauthorizedError("INVALID_TOKEN");
  }
  if (typeof decoded === "string") throw new UnauthorizedError("INVALID_TOKEN");
  return decoded as Record<string, unknown>;
}

/** Refresh tokens are opaque random values — only their hash is ever persisted (TDD §11.3). */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Revokes every still-active refresh token for a user — the shared "force re-login everywhere"
 * primitive used by change-password, refresh-token-reuse detection (TDD §11.4), and now user
 * deactivation/role-change (users module). Always call inside the caller's own transaction.
 */
export async function revokeAllRefreshTokens(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}