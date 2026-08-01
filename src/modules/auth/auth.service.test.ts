import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import { hashRefreshToken, verifyAccessToken, verifyMustChangePasswordToken } from "../../shared/tokens.js";
import * as authService from "./auth.service.js";

// TDD §22.1: service-layer tests run against a real database, no mocks — the transactions and
// rotation/theft-detection logic are the thing under test. Each test creates and tears down its
// own throwaway user; it never touches the real seeded Super Admin or other app data.

const TEST_PASSWORD = "correct-horse-battery-staple";

async function createTestUser(overrides: { mustChangePassword?: boolean } = {}) {
  const passwordHash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });
  const user = await prisma.user.create({
    data: {
      username: `authtest_${randomUUID()}`,
      passwordHash,
      name: "Auth Service Test User",
      role: "employee",
      isActive: true,
      mustChangePassword: overrides.mustChangePassword ?? false,
    },
  });
  return user;
}

async function deleteTestUser(userId: string) {
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.auditLog.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

describe("auth.service", () => {
  let userId: string | undefined;

  afterEach(async () => {
    if (userId) await deleteTestUser(userId);
    userId = undefined;
  });

  it("logs in with correct credentials and issues an access+refresh pair", async () => {
    const user = await createTestUser();
    userId = user.id;

    const result = await authService.login({ username: user.username, password: TEST_PASSWORD }, {});
    if (result.mustChangePassword) throw new Error("expected a normal login");

    const decoded = verifyAccessToken(result.accessToken);
    expect(decoded).toEqual({ userId: user.id, role: "employee" });

    const row = await prisma.refreshToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).toBe(hashRefreshToken(result.refreshToken));
    expect(row.revokedAt).toBeNull();

    const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updatedUser.lastLoginAt).not.toBeNull();
  });

  it("rejects an incorrect password without revealing which field was wrong", async () => {
    const user = await createTestUser();
    userId = user.id;

    await expect(
      authService.login({ username: user.username, password: "wrong-password" }, {}),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  // Heaviest test in this file: 2 argon2id hashes + 2 verifies + several DB round-trips, all
  // against the real remote dev DB. The global 15s testTimeout has been observed to fail this
  // one specifically under full-suite load (network/DB jitter, not a bug) — give it real headroom.
  it(
    "gives a limited token when must_change_password is set; change-password clears it",
    async () => {
      const user = await createTestUser({ mustChangePassword: true });
      userId = user.id;

      const first = await authService.login({ username: user.username, password: TEST_PASSWORD }, {});
      if (!first.mustChangePassword) throw new Error("expected the must-change-password path");

      const { userId: decodedUserId } = verifyMustChangePasswordToken(first.changePasswordToken);
      expect(decodedUserId).toBe(user.id);

      await authService.changePassword({ newPassword: "brand-new-password-123" }, { userId: decodedUserId });

      const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updatedUser.mustChangePassword).toBe(false);

      const second = await authService.login(
        { username: user.username, password: "brand-new-password-123" },
        {},
      );
      expect(second.mustChangePassword).toBe(false);
    },
    30_000,
  );

  it("rotates the refresh token on use, linking the new row back to the old one", async () => {
    const user = await createTestUser();
    userId = user.id;

    const first = await authService.login({ username: user.username, password: TEST_PASSWORD }, {});
    if (first.mustChangePassword) throw new Error("expected a normal login");

    const oldRow = await prisma.refreshToken.findFirstOrThrow({ where: { userId: user.id } });
    const second = await authService.refresh({ refreshToken: first.refreshToken }, {});
    expect(second.refreshToken).not.toBe(first.refreshToken);

    const oldRowAfter = await prisma.refreshToken.findUniqueOrThrow({ where: { id: oldRow.id } });
    expect(oldRowAfter.revokedAt).not.toBeNull();

    const newRow = await prisma.refreshToken.findFirstOrThrow({
      where: { tokenHash: hashRefreshToken(second.refreshToken) },
    });
    expect(newRow.rotatedFromId).toBe(oldRow.id);
  });

  it("grace window: racing the same just-revoked token gives an independent pair, not an error", async () => {
    const user = await createTestUser();
    userId = user.id;

    const first = await authService.login({ username: user.username, password: TEST_PASSWORD }, {});
    if (first.mustChangePassword) throw new Error("expected a normal login");

    const second = await authService.refresh({ refreshToken: first.refreshToken }, {});
    // Simulates a second tab presenting the same old token moments after the first tab rotated it.
    const third = await authService.refresh({ refreshToken: first.refreshToken }, {});

    expect(third.refreshToken).not.toBe(second.refreshToken);

    const secondRow = await prisma.refreshToken.findFirstOrThrow({
      where: { tokenHash: hashRefreshToken(second.refreshToken) },
    });
    const thirdRow = await prisma.refreshToken.findFirstOrThrow({
      where: { tokenHash: hashRefreshToken(third.refreshToken) },
    });
    expect(secondRow.revokedAt).toBeNull();
    expect(thirdRow.revokedAt).toBeNull();
  });

  it("reuse after the grace window revokes every refresh token for that user", async () => {
    const user = await createTestUser();
    userId = user.id;

    const first = await authService.login({ username: user.username, password: TEST_PASSWORD }, {});
    if (first.mustChangePassword) throw new Error("expected a normal login");

    const oldRow = await prisma.refreshToken.findFirstOrThrow({ where: { userId: user.id } });
    await authService.refresh({ refreshToken: first.refreshToken }, {});

    // Back-date the revocation instead of sleeping the test for 30s.
    await prisma.refreshToken.update({
      where: { id: oldRow.id },
      data: { revokedAt: new Date(Date.now() - 31_000) },
    });

    await expect(authService.refresh({ refreshToken: first.refreshToken }, {})).rejects.toMatchObject({
      code: "REFRESH_TOKEN_REUSED",
    });

    const stillValid = await prisma.refreshToken.findMany({ where: { userId: user.id, revokedAt: null } });
    expect(stillValid).toHaveLength(0);
  });

  it("logout revokes the presented token and is idempotent on retry", async () => {
    const user = await createTestUser();
    userId = user.id;

    const first = await authService.login({ username: user.username, password: TEST_PASSWORD }, {});
    if (first.mustChangePassword) throw new Error("expected a normal login");

    await authService.logout({ refreshToken: first.refreshToken });

    const row = await prisma.refreshToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.revokedAt).not.toBeNull();

    await expect(authService.logout({ refreshToken: first.refreshToken })).resolves.toBeUndefined();
  });
});
