import { Prisma, type User } from "@prisma/client";
import { prisma, runTransaction } from "../../db/client.js";
import { writeAudit } from "../../shared/audit.js";
import { completeIdempotencyKey } from "../../shared/idempotency.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../shared/errors.js";
import { hashPassword } from "../../shared/password.js";
import { revokeAllRefreshTokens } from "../../shared/tokens.js";
import { success } from "../../shared/envelope.js";
import { serializeBigInt } from "../../shared/serialize.js";
import type { Role } from "../../shared/types.js";
import type { CreateUserInput, ListUsersQuery, UpdateUserInput } from "./user.validation.js";

export interface UserActor {
  userId: string;
  role: Role;
  branchId?: string;
}

// Users is the root capability that creates every other account (user:manage, super_admin-only,
// TDD §7.2) — same "no acting branch to resolve" shape as branch:manage, so no branchContext
// middleware runs on these routes either (see branch.service.ts for the identical reasoning).

/**
 * Never let password_hash leave this module — not in responses, not in audit rows. An explicit
 * allowlist rather than an omit/destructure: a new sensitive column added to `users` later stays
 * excluded by default instead of leaking until someone remembers to add it to a blocklist.
 */
function toPublicUser(user: User): Omit<User, "passwordHash"> {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    email: user.email,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    deletedAt: user.deletedAt,
    createdBy: user.createdBy,
    updatedBy: user.updatedBy,
  };
}

// username's uniqueness is enforced by the partial index ux_users_username_active (soft-delete-
// safe); surface the violation as a clean conflict instead of a raw DB constraint error.
function rethrowUsernameConflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    throw new ConflictError("USERNAME_ALREADY_EXISTS");
  }
  throw err;
}

async function assertBranchesExist(tx: Prisma.TransactionClient, branchIds: string[]): Promise<void> {
  const count = await tx.branch.count({ where: { id: { in: branchIds }, deletedAt: null } });
  if (count !== branchIds.length) throw new NotFoundError("BRANCH_NOT_FOUND");
}

async function getBranchIds(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
  const rows = await tx.userBranch.findMany({ where: { userId }, select: { branchId: true } });
  return rows.map((r) => r.branchId);
}

export async function createUser(
  input: CreateUserInput,
  actor: UserActor,
  idempotencyKey: string,
): Promise<unknown> {
  // Argon2id hashing is deliberately done before opening the transaction (~50-100ms of pure CPU
  // work with no DB dependency) — same reasoning as auth.service.ts's changePassword: keep the
  // DB transaction, which shares a contended pool on this remote dev DB, as short as possible.
  const passwordHash = await hashPassword(input.initialPassword);

  return runTransaction(async (tx) => {
    if (input.branchIds?.length) await assertBranchesExist(tx, input.branchIds);

    const user = await tx.user
      .create({
        data: {
          username: input.username,
          passwordHash,
          name: input.name,
          role: input.role,
          email: input.email ?? null,
          isActive: true,
          mustChangePassword: true,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
      })
      .catch(rethrowUsernameConflict);

    if (input.branchIds?.length) {
      await tx.userBranch.createMany({
        data: input.branchIds.map((branchId) => ({ userId: user.id, branchId })),
      });
    }

    const serialized = { ...serializeBigInt(toPublicUser(user)), branchIds: input.branchIds ?? [] };

    await writeAudit(tx, actor, {
      action: "create",
      entityType: "user",
      entityId: user.id,
      after: serialized as unknown as Record<string, unknown>,
    });

    const responseBody = success(serialized);
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}

export async function getUser(id: string) {
  const user = await prisma.user.findFirst({ where: { id, deletedAt: null } });
  if (!user) throw new NotFoundError("USER_NOT_FOUND");
  const branchIds = await getBranchIds(prisma, id);
  return { ...serializeBigInt(toPublicUser(user)), branchIds };
}

export async function listUsers(query: ListUsersQuery) {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(query.role ? { role: query.role } : {}),
    ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: "insensitive" } },
            { username: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);

  // branchIds aren't embedded here (would be an N+1 join per row) — same choice party.controller.ts
  // makes for the ledger relation on listParties; the detail view (getUser) carries branchIds.
  return { items: items.map((u) => serializeBigInt(toPublicUser(u))), total, page: query.page, limit: query.limit };
}

export async function updateUser(
  id: string,
  input: UpdateUserInput,
  actor: UserActor,
  idempotencyKey: string,
): Promise<unknown> {
  return runTransaction(async (tx) => {
    // Branch membership fetched in the same query as the user row (one round trip, not two) —
    // this remote-DB connection makes every extra round trip expensive (CLAUDE.md), and it's
    // needed below regardless of which branch of the if/else this update takes.
    const before = await tx.user.findFirst({
      where: { id, deletedAt: null },
      include: { userBranches: { select: { branchId: true } } },
    });
    if (!before) throw new NotFoundError("USER_NOT_FOUND");
    const branchIdsBefore = before.userBranches.map((b) => b.branchId);

    const effectiveRole = (input.role ?? before.role) as Role;
    const roleChanged = input.role !== undefined && input.role !== before.role;
    const deactivating = input.isActive === false && before.isActive === true;

    // Resolve the user_branches outcome for this update. branchIds explicitly present in the
    // request is a full-replace instruction; role changing alone (branchIds omitted) is resolved
    // against the existing rows — see user.validation.ts's comment on why this can't be a pure
    // schema-level check.
    let branchIdsAfter: string[];
    if (input.branchIds !== undefined) {
      if (effectiveRole === "super_admin" && input.branchIds.length > 0) {
        throw new BadRequestError("SUPER_ADMIN_CANNOT_HAVE_BRANCHES");
      }
      if (effectiveRole !== "super_admin" && input.branchIds.length === 0) {
        throw new BadRequestError("BRANCH_IDS_REQUIRED");
      }
      if (input.branchIds.length > 0) await assertBranchesExist(tx, input.branchIds);

      await tx.userBranch.deleteMany({ where: { userId: id } });
      if (input.branchIds.length > 0) {
        await tx.userBranch.createMany({ data: input.branchIds.map((branchId) => ({ userId: id, branchId })) });
      }
      branchIdsAfter = input.branchIds;
    } else if (roleChanged && effectiveRole === "super_admin") {
      // Crossing into super_admin without branchIds in this request: clear stale membership
      // rows rather than leave them behind unconsulted (super_admin bypasses the list, §7.2).
      await tx.userBranch.deleteMany({ where: { userId: id } });
      branchIdsAfter = [];
    } else {
      if (roleChanged && effectiveRole !== "super_admin" && branchIdsBefore.length === 0) {
        // Crossing out of super_admin into a scoped role without supplying branchIds: there's
        // nothing to fall back on, the caller must say which branches explicitly.
        throw new BadRequestError("BRANCH_IDS_REQUIRED");
      }
      branchIdsAfter = branchIdsBefore;
    }

    const after = await tx.user.update({
      where: { id },
      data: {
        name: input.name,
        email: input.email,
        role: input.role,
        isActive: input.isActive,
        updatedBy: actor.userId,
      },
    });

    // Role is baked into the stateless access token (verified by signature only, TDD §11.2) and
    // is_active is the deactivation flow (§11.4) — both force re-login everywhere. Branch access
    // alone is checked fresh from the DB on every request (branch-context.ts), so a branch-only
    // reassignment needs no revocation to take effect immediately.
    if (roleChanged || deactivating) {
      await revokeAllRefreshTokens(tx, id);
    }

    const serializedBefore = { ...serializeBigInt(toPublicUser(before)), branchIds: branchIdsBefore };
    const serializedAfter = { ...serializeBigInt(toPublicUser(after)), branchIds: branchIdsAfter };

    await writeAudit(tx, actor, {
      action: "update",
      entityType: "user",
      entityId: id,
      before: serializedBefore as unknown as Record<string, unknown>,
      after: serializedAfter as unknown as Record<string, unknown>,
    });

    const responseBody = success(serializedAfter);
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}