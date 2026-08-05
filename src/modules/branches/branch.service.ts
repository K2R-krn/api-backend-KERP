import { Prisma } from "@prisma/client";
import { prisma, runTransaction } from "../../db/client.js";
import { writeAudit } from "../../shared/audit.js";
import { completeIdempotencyKey } from "../../shared/idempotency.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { success } from "../../shared/envelope.js";
import { serializeBigInt } from "../../shared/serialize.js";
import type { Role } from "../../shared/types.js";
import type { CreateBranchInput, ListBranchesQuery, UpdateBranchInput } from "./branch.validation.js";

export interface BranchActor {
  userId: string;
  role: Role;
  branchId?: string;
}

// Branches are the root of multi-branch config (TDD §5.2) — CRUD here isn't scoped to an acting
// branch the way Parties/Products are (there's no branch to resolve before the first branch
// exists), so branchContext never runs on these routes. Audit rows simply carry a null branch_id
// for these actions — the column is nullable exactly for cases like this (TDD §5.4).

const CASH_LEDGER_GROUP = "Cash-in-Hand";

// code's uniqueness is enforced by the partial index ux_branches_code_active (soft-delete-safe);
// surface the violation as a clean conflict instead of a raw DB constraint error.
function rethrowCodeConflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    throw new ConflictError("BRANCH_CODE_ALREADY_EXISTS");
  }
  throw err;
}

export async function createBranch(
  input: CreateBranchInput,
  actor: BranchActor,
  idempotencyKey: string,
): Promise<unknown> {
  return runTransaction(async (tx) => {
    const branch = await tx.branch
      .create({
        data: {
          name: input.name,
          code: input.code,
          gstin: input.gstin ?? null,
          stateCode: input.stateCode,
          address: input.address ?? null,
          phone: input.phone ?? null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
      })
      .catch(rethrowCodeConflict);

    // Every branch needs its own Cash ledger for the Sale/Purchase services' ledger_postings
    // (TDD §26 step 10, §18.3). Created here, in the same transaction as the branch — same
    // "ledger owned by its entity" pattern as party.service.ts's createParty, just sequenced
    // branch-first-then-ledger-then-link-back, because branches.cash_ledger_id and
    // ledgers.branch_id point at each other (unlike the deliberately one-directional party/ledger
    // link, TDD §6.2) — there's no single insert that can satisfy both sides at once.
    const cashGroup = await tx.accountGroup.findFirstOrThrow({
      where: { name: CASH_LEDGER_GROUP, deletedAt: null },
    });
    const cashLedger = await tx.ledger.create({
      data: {
        name: `Cash - ${branch.code}`,
        accountGroupId: cashGroup.id,
        branchId: branch.id,
        openingBalance: 0n,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      },
    });
    const linkedBranch = await tx.branch.update({
      where: { id: branch.id },
      data: { cashLedgerId: cashLedger.id },
    });

    const serialized = serializeBigInt({ ...linkedBranch, cashLedger });

    await writeAudit(tx, actor, {
      action: "create",
      entityType: "branch",
      entityId: branch.id,
      after: serialized as unknown as Record<string, unknown>,
    });

    const responseBody = success(serialized);
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}

export async function getBranch(id: string, actor: BranchActor) {
  const branch = await prisma.branch.findFirst({ where: { id, deletedAt: null } });
  if (!branch) throw new NotFoundError("BRANCH_NOT_FOUND");

  if (actor.role !== "super_admin") {
    const membership = await prisma.userBranch.findUnique({
      where: { userId_branchId: { userId: actor.userId, branchId: id } },
    });
    if (!membership) throw new ForbiddenError("BRANCH_NOT_ALLOWED");
  }

  return branch;
}

export async function listBranches(query: ListBranchesQuery, actor: BranchActor) {
  const where: Prisma.BranchWhereInput = {
    deletedAt: null,
    ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: "insensitive" } },
            { code: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  // Non-super-admins only see branches they're a member of (TDD §5.3) — super admins bypass
  // user_branches entirely and see everything.
  if (actor.role !== "super_admin") {
    const memberships = await prisma.userBranch.findMany({
      where: { userId: actor.userId },
      select: { branchId: true },
    });
    where.id = { in: memberships.map((m) => m.branchId) };
  }

  const [total, items] = await Promise.all([
    prisma.branch.count({ where }),
    prisma.branch.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);

  return { items, total, page: query.page, limit: query.limit };
}

export async function updateBranch(
  id: string,
  input: UpdateBranchInput,
  actor: BranchActor,
  idempotencyKey: string,
): Promise<unknown> {
  return runTransaction(async (tx) => {
    const before = await tx.branch.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new NotFoundError("BRANCH_NOT_FOUND");

    const after = await tx.branch
      .update({ where: { id }, data: { ...input, updatedBy: actor.userId } })
      .catch(rethrowCodeConflict);

    const serializedBefore = serializeBigInt(before);
    const serializedAfter = serializeBigInt(after);

    await writeAudit(tx, actor, {
      action: "update",
      entityType: "branch",
      entityId: id,
      before: serializedBefore as unknown as Record<string, unknown>,
      after: serializedAfter as unknown as Record<string, unknown>,
    });

    const responseBody = success(serializedAfter);
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}

export async function deactivateBranch(id: string, actor: BranchActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(async (tx) => {
    const before = await tx.branch.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new NotFoundError("BRANCH_NOT_FOUND");

    const after = await tx.branch.update({ where: { id }, data: { isActive: false, updatedBy: actor.userId } });

    await writeAudit(tx, actor, {
      action: "deactivate",
      entityType: "branch",
      entityId: id,
      before: serializeBigInt(before) as unknown as Record<string, unknown>,
      after: serializeBigInt(after) as unknown as Record<string, unknown>,
    });

    const responseBody = success({ deactivated: true });
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}
