import * as argon2 from "argon2";
import { env } from "../../config/env.js";
import { prisma, runTransaction } from "../../db/client.js";
import { writeAudit } from "../../shared/audit.js";
import { REFRESH_GRACE_WINDOW_MS } from "../../shared/constants.js";
import { parseDurationToMs } from "../../shared/duration.js";
import { UnauthorizedError } from "../../shared/errors.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  signMustChangePasswordToken,
} from "../../shared/tokens.js";
import type { Role } from "../../shared/types.js";
import type { ChangePasswordInput, LoginInput, LogoutInput, RefreshInput } from "./auth.validation.js";

export interface RequestMeta {
  userAgent?: string;
}

export type LoginResult =
  | { mustChangePassword: true; changePasswordToken: string }
  | { mustChangePassword: false; accessToken: string; refreshToken: string };

export async function login(input: LoginInput, meta: RequestMeta): Promise<LoginResult> {
  const user = await prisma.user.findFirst({ where: { username: input.username, deletedAt: null } });
  if (!user || !user.isActive) throw new UnauthorizedError("INVALID_CREDENTIALS");

  const passwordValid = await argon2.verify(user.passwordHash, input.password);
  if (!passwordValid) throw new UnauthorizedError("INVALID_CREDENTIALS");

  if (user.mustChangePassword) {
    return { mustChangePassword: true, changePasswordToken: signMustChangePasswordToken(user.id) };
  }

  const role = user.role as Role;
  const accessToken = signAccessToken({ userId: user.id, role });
  const { token: refreshToken, hash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + parseDurationToMs(env.REFRESH_TOKEN_TTL));

  await runTransaction(async (tx) => {
    await tx.refreshToken.create({
      data: { userId: user.id, tokenHash: hash, expiresAt, userAgent: meta.userAgent ?? null },
    });
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await writeAudit(tx, { userId: user.id, role }, { action: "login", entityType: "user", entityId: user.id });
  });

  return { mustChangePassword: false, accessToken, refreshToken };
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
}

export async function refresh(input: RefreshInput, meta: RequestMeta): Promise<RefreshResult> {
  const presentedHash = hashRefreshToken(input.refreshToken);
  const row = await prisma.refreshToken.findFirst({ where: { tokenHash: presentedHash } });
  if (!row) throw new UnauthorizedError("INVALID_REFRESH_TOKEN");
  if (row.expiresAt.getTime() <= Date.now()) throw new UnauthorizedError("REFRESH_TOKEN_EXPIRED");

  const user = await prisma.user.findFirst({ where: { id: row.userId, deletedAt: null } });
  if (!user || !user.isActive) throw new UnauthorizedError("USER_INACTIVE");
  const role = user.role as Role;

  if (row.revokedAt) {
    const ageMs = Date.now() - row.revokedAt.getTime();
    if (ageMs >= REFRESH_GRACE_WINDOW_MS) {
      // Reuse of an already-rotated token outside the grace window — theft detection (TDD §11.4,
      // corrected wording): revoke every refresh token for this user, not just this lineage.
      await runTransaction(async (tx) => {
        await tx.refreshToken.updateMany({
          where: { userId: row.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await writeAudit(tx, { userId: row.userId, role }, {
          action: "token_reuse_detected",
          entityType: "user",
          entityId: row.userId,
        });
      });
      throw new UnauthorizedError("REFRESH_TOKEN_REUSED");
    }
    // Within the 30s grace window: a legitimate concurrent rotation (e.g. two open tabs racing).
    // Mint this caller their own independent pair below and leave any sibling pair untouched —
    // we deliberately do NOT attempt to replay byte-identical tokens (see TDD §11.4).
  }

  const accessToken = signAccessToken({ userId: user.id, role });
  const { token: newRefreshToken, hash: newHash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + parseDurationToMs(env.REFRESH_TOKEN_TTL));

  await runTransaction(async (tx) => {
    if (!row.revokedAt) {
      await tx.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    }
    await tx.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: newHash,
        expiresAt,
        userAgent: meta.userAgent ?? null,
        rotatedFromId: row.id,
      },
    });
  });

  return { accessToken, refreshToken: newRefreshToken };
}

export interface ChangePasswordActor {
  userId: string;
}

export async function changePassword(input: ChangePasswordInput, actor: ChangePasswordActor): Promise<void> {
  const user = await prisma.user.findFirst({ where: { id: actor.userId, deletedAt: null } });
  if (!user || !user.isActive) throw new UnauthorizedError("USER_INACTIVE");

  if (!user.mustChangePassword) {
    if (!input.currentPassword) throw new UnauthorizedError("CURRENT_PASSWORD_REQUIRED");
    const valid = await argon2.verify(user.passwordHash, input.currentPassword);
    if (!valid) throw new UnauthorizedError("INVALID_CREDENTIALS");
  }

  const newHash = await argon2.hash(input.newPassword, { type: argon2.argon2id });
  const role = user.role as Role;

  await runTransaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash, mustChangePassword: false },
    });
    // Force re-login everywhere (TDD §11.4).
    await tx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await writeAudit(tx, { userId: user.id, role }, {
      action: "change_password",
      entityType: "user",
      entityId: user.id,
    });
  });
}

export async function logout(input: LogoutInput): Promise<void> {
  const tokenHash = hashRefreshToken(input.refreshToken);
  const row = await prisma.refreshToken.findFirst({ where: { tokenHash, revokedAt: null } });
  if (!row) return; // Already revoked/unknown — logout is idempotent, nothing to do.

  const user = await prisma.user.findFirst({ where: { id: row.userId, deletedAt: null } });

  await runTransaction(async (tx) => {
    await tx.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    if (user) {
      await writeAudit(tx, { userId: user.id, role: user.role as Role }, {
        action: "logout",
        entityType: "user",
        entityId: user.id,
      });
    }
  });
}
