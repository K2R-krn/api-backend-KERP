import { randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import * as userService from "./user.service.js";
import type { UserActor } from "./user.service.js";

// TDD §22.1: service-layer tests run against the real dev DB, no mocks. Each test creates and
// tears down its own throwaway branches/users/idempotency keys — never the real seeded Super
// Admin (same discipline as auth.service.test.ts).

let branchAId: string;
let branchBId: string;
let actor: UserActor;

const createdUserIds: string[] = [];
const createdBranchIds: string[] = [];
const createdIdempotencyKeys: string[] = [];

async function newIdempotencyKey(scope: string): Promise<string> {
  const key = randomUUID();
  await prisma.idempotencyKey.create({
    data: {
      key,
      userId: actor.userId,
      scope,
      requestHash: "test",
      status: "in_progress",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  createdIdempotencyKeys.push(key);
  return key;
}

interface CreatedUser {
  data: {
    id: string;
    username: string;
    role: string;
    isActive: boolean;
    mustChangePassword: boolean;
    branchIds: string[];
    passwordHash?: string;
  };
}

beforeAll(async () => {
  const branchA = await prisma.branch.create({
    data: { name: `User Test Branch A ${randomUUID()}`, code: `UTA${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  branchAId = branchA.id;
  createdBranchIds.push(branchAId);

  const branchB = await prisma.branch.create({
    data: { name: `User Test Branch B ${randomUUID()}`, code: `UTB${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  branchBId = branchB.id;
  createdBranchIds.push(branchBId);

  const admin = await prisma.user.create({
    data: {
      username: `usertest_admin_${randomUUID()}`,
      passwordHash: "unused",
      name: "User Service Test Actor",
      role: "super_admin",
      isActive: true,
      mustChangePassword: false,
    },
  });
  actor = { userId: admin.id, role: "super_admin" };
  createdUserIds.push(admin.id);
});

afterEach(async () => {
  if (createdIdempotencyKeys.length) {
    await prisma.idempotencyKey.deleteMany({ where: { key: { in: createdIdempotencyKeys } } });
    createdIdempotencyKeys.length = 0;
  }
});

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.userBranch.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.branch.deleteMany({ where: { id: { in: createdBranchIds } } });
});

describe("user.service", () => {
  it("creates a user with an Argon2id hash, must_change_password=true, and branch rows, atomically", async () => {
    const key = await newIdempotencyKey("user:create");
    const username = `test_create_${randomUUID()}`;

    const response = (await userService.createUser(
      { username, name: "Test Employee", role: "employee", initialPassword: "password123", branchIds: [branchAId] },
      actor,
      key,
    )) as CreatedUser;
    createdUserIds.push(response.data.id);

    expect(response.data.mustChangePassword).toBe(true);
    expect(response.data.isActive).toBe(true);
    expect(response.data.branchIds).toEqual([branchAId]);
    // password_hash must never leave the service.
    expect(response.data.passwordHash).toBeUndefined();

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: response.data.id } });
    expect(stored.passwordHash).not.toBe("password123");
    expect(await argon2.verify(stored.passwordHash, "password123")).toBe(true);

    const branchRows = await prisma.userBranch.findMany({ where: { userId: response.data.id } });
    expect(branchRows).toHaveLength(1);
    expect(branchRows[0]?.branchId).toBe(branchAId);

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "user", entityId: response.data.id, action: "create" },
    });
    expect(auditRow.userId).toBe(actor.userId);
    // password_hash must never land in the audit trail either.
    expect(JSON.stringify(auditRow.after)).not.toContain("passwordHash");

    const completedKey = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
    expect(completedKey.status).toBe("completed");
  });

  it("rejects a duplicate username with a clean conflict error", async () => {
    const username = `test_dup_${randomUUID()}`;
    const firstKey = await newIdempotencyKey("user:create");
    const first = (await userService.createUser(
      { username, name: "First", role: "employee", initialPassword: "password123", branchIds: [branchAId] },
      actor,
      firstKey,
    )) as CreatedUser;
    createdUserIds.push(first.data.id);

    const secondKey = await newIdempotencyKey("user:create");
    await expect(
      userService.createUser(
        { username, name: "Second", role: "employee", initialPassword: "password123", branchIds: [branchAId] },
        actor,
        secondKey,
      ),
    ).rejects.toMatchObject({ code: "USERNAME_ALREADY_EXISTS" });
  });

  it("rejects a branchId that doesn't exist, with no orphaned user row", async () => {
    const key = await newIdempotencyKey("user:create");
    const username = `test_badbranch_${randomUUID()}`;

    await expect(
      userService.createUser(
        { username, name: "Test", role: "employee", initialPassword: "password123", branchIds: [randomUUID()] },
        actor,
        key,
      ),
    ).rejects.toMatchObject({ code: "BRANCH_NOT_FOUND" });

    const orphaned = await prisma.user.findFirst({ where: { username } });
    expect(orphaned).toBeNull();
  });

  it("rolls back atomically when the user_branches insert fails: no orphaned user row", async () => {
    const key = await newIdempotencyKey("user:create");
    const username = `test_rollback_${randomUUID()}`;

    // Bypasses schema-level dedup (service tests call the service directly, no Zod in front) to
    // force a genuine composite-PK violation on the SECOND write, after the FIRST (user.create)
    // has already run inside the transaction — same technique as party.service.test.ts's
    // rollback test, proving real DB-level atomicity rather than just early-validation ordering.
    await expect(
      userService.createUser(
        {
          username,
          name: "Test",
          role: "employee",
          initialPassword: "password123",
          branchIds: [branchAId, branchAId],
        },
        actor,
        key,
      ),
    ).rejects.toThrow();

    const orphaned = await prisma.user.findFirst({ where: { username } });
    expect(orphaned).toBeNull();
  });

  it("gets a user with branchIds, and 404s for a non-existent id", async () => {
    const key = await newIdempotencyKey("user:create");
    const username = `test_get_${randomUUID()}`;
    const created = (await userService.createUser(
      { username, name: "Test", role: "employee", initialPassword: "password123", branchIds: [branchAId, branchBId] },
      actor,
      key,
    )) as CreatedUser;
    createdUserIds.push(created.data.id);

    const found = await userService.getUser(created.data.id);
    expect((found as { branchIds: string[] }).branchIds.sort()).toEqual([branchAId, branchBId].sort());

    await expect(userService.getUser(randomUUID())).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });

  // The tests below all create() then update() in the same test — two DB round-trip-heavy
  // operations back to back over the real remote dev DB. Same headroom as auth.service.test.ts's
  // heaviest case (CLAUDE.md: default to generous timeouts on this connection, don't wait to be
  // bitten again).
  it("updates name/email without touching role or branches", async () => {
    const key = await newIdempotencyKey("user:create");
    const created = (await userService.createUser(
      { username: `test_update_${randomUUID()}`, name: "Old Name", role: "employee", initialPassword: "password123", branchIds: [branchAId] },
      actor,
      key,
    )) as CreatedUser;
    createdUserIds.push(created.data.id);

    const updateKey = await newIdempotencyKey("user:update");
    await userService.updateUser(created.data.id, { name: "New Name" }, actor, updateKey);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(after.name).toBe("New Name");
    expect(after.role).toBe("employee");

    const branchRows = await prisma.userBranch.findMany({ where: { userId: created.data.id } });
    expect(branchRows.map((r) => r.branchId)).toEqual([branchAId]);
  }, 30_000);

  it("deactivating a user (isActive true->false) revokes all their refresh tokens", async () => {
    const key = await newIdempotencyKey("user:create");
    const created = (await userService.createUser(
      { username: `test_deactivate_${randomUUID()}`, name: "Test", role: "employee", initialPassword: "password123", branchIds: [branchAId] },
      actor,
      key,
    )) as CreatedUser;
    createdUserIds.push(created.data.id);

    await prisma.refreshToken.create({
      data: {
        userId: created.data.id,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const updateKey = await newIdempotencyKey("user:update");
    await userService.updateUser(created.data.id, { isActive: false }, actor, updateKey);

    const tokens = await prisma.refreshToken.findMany({ where: { userId: created.data.id } });
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(after.isActive).toBe(false);
  }, 30_000);

  it("changing role revokes all refresh tokens, even without touching isActive", async () => {
    const key = await newIdempotencyKey("user:create");
    const created = (await userService.createUser(
      { username: `test_roledemote_${randomUUID()}`, name: "Test", role: "admin", initialPassword: "password123", branchIds: [branchAId] },
      actor,
      key,
    )) as CreatedUser;
    createdUserIds.push(created.data.id);

    await prisma.refreshToken.create({
      data: {
        userId: created.data.id,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const updateKey = await newIdempotencyKey("user:update");
    await userService.updateUser(created.data.id, { role: "employee" }, actor, updateKey);

    const tokens = await prisma.refreshToken.findMany({ where: { userId: created.data.id } });
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(after.role).toBe("employee");
  }, 30_000);

  it("reassigning branches alone does NOT revoke refresh tokens", async () => {
    const key = await newIdempotencyKey("user:create");
    const created = (await userService.createUser(
      { username: `test_branchmove_${randomUUID()}`, name: "Test", role: "employee", initialPassword: "password123", branchIds: [branchAId] },
      actor,
      key,
    )) as CreatedUser;
    createdUserIds.push(created.data.id);

    await prisma.refreshToken.create({
      data: {
        userId: created.data.id,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const updateKey = await newIdempotencyKey("user:update");
    await userService.updateUser(created.data.id, { branchIds: [branchBId] }, actor, updateKey);

    const tokens = await prisma.refreshToken.findMany({ where: { userId: created.data.id } });
    expect(tokens.every((t) => t.revokedAt === null)).toBe(true);

    const branchRows = await prisma.userBranch.findMany({ where: { userId: created.data.id } });
    expect(branchRows.map((r) => r.branchId)).toEqual([branchBId]);
  }, 30_000);

  it("promoting to super_admin clears existing branch rows, without branchIds in the request", async () => {
    const key = await newIdempotencyKey("user:create");
    const created = (await userService.createUser(
      { username: `test_promote_${randomUUID()}`, name: "Test", role: "admin", initialPassword: "password123", branchIds: [branchAId] },
      actor,
      key,
    )) as CreatedUser;
    createdUserIds.push(created.data.id);

    const updateKey = await newIdempotencyKey("user:update");
    await userService.updateUser(created.data.id, { role: "super_admin" }, actor, updateKey);

    const branchRows = await prisma.userBranch.findMany({ where: { userId: created.data.id } });
    expect(branchRows).toHaveLength(0);
  }, 30_000);

  it("demoting from super_admin without branchIds is rejected — nothing to fall back on", async () => {
    const key = await newIdempotencyKey("user:create");
    const created = (await userService.createUser(
      { username: `test_demote_${randomUUID()}`, name: "Test", role: "super_admin", initialPassword: "password123" },
      actor,
      key,
    )) as CreatedUser;
    createdUserIds.push(created.data.id);

    const updateKey = await newIdempotencyKey("user:update");
    await expect(
      userService.updateUser(created.data.id, { role: "admin" }, actor, updateKey),
    ).rejects.toMatchObject({ code: "BRANCH_IDS_REQUIRED" });

    // Demoting WITH branchIds supplied in the same request succeeds.
    const retryKey = await newIdempotencyKey("user:update");
    await userService.updateUser(created.data.id, { role: "admin", branchIds: [branchAId] }, actor, retryKey);
    const branchRows = await prisma.userBranch.findMany({ where: { userId: created.data.id } });
    expect(branchRows.map((r) => r.branchId)).toEqual([branchAId]);
  }, 40_000); // create + two sequential updates — heaviest test in the file.

  it("rejects assigning branches to a super_admin via update", async () => {
    const key = await newIdempotencyKey("user:create");
    const created = (await userService.createUser(
      { username: `test_sabranch_${randomUUID()}`, name: "Test", role: "super_admin", initialPassword: "password123" },
      actor,
      key,
    )) as CreatedUser;
    createdUserIds.push(created.data.id);

    const updateKey = await newIdempotencyKey("user:update");
    await expect(
      userService.updateUser(created.data.id, { branchIds: [branchAId] }, actor, updateKey),
    ).rejects.toMatchObject({ code: "SUPER_ADMIN_CANNOT_HAVE_BRANCHES" });
  }, 30_000);

  it("lists users without leaking password_hash", async () => {
    const key = await newIdempotencyKey("user:create");
    const username = `test_list_${randomUUID()}`;
    const created = (await userService.createUser(
      { username, name: "Zzz List Test", role: "employee", initialPassword: "password123", branchIds: [branchAId] },
      actor,
      key,
    )) as CreatedUser;
    createdUserIds.push(created.data.id);

    const result = await userService.listUsers({ page: 1, limit: 20, search: "Zzz List Test" });
    expect(result.total).toBeGreaterThanOrEqual(1);
    const match = result.items.find((u) => (u as { id: string }).id === created.data.id) as
      | { passwordHash?: string }
      | undefined;
    expect(match).toBeDefined();
    expect(match?.passwordHash).toBeUndefined();
  });
});