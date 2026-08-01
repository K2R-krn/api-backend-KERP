import { Prisma } from "@prisma/client";
import { prisma, runTransaction } from "../../db/client.js";
import { writeAudit } from "../../shared/audit.js";
import { completeIdempotencyKey } from "../../shared/idempotency.js";
import { assertNoCycle } from "../../shared/hierarchy.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { success } from "../../shared/envelope.js";
import { serializeBigInt } from "../../shared/serialize.js";
import type { Role } from "../../shared/types.js";
import type { CreateCategoryInput, ListCategoriesQuery, UpdateCategoryInput } from "./category.validation.js";

export interface CategoryActor {
  userId: string;
  role: Role;
  branchId: string;
}

// Categories are a single shared catalog across all branches, same as products (TDD §6.4 — no
// branch_id column). branchContext still runs on every route purely to tag audit rows with the
// acting branch, same reasoning as product.service.ts.

async function assertParentExists(tx: Prisma.TransactionClient, parentId: string): Promise<void> {
  const parent = await tx.category.findFirst({ where: { id: parentId, deletedAt: null } });
  if (!parent) throw new NotFoundError("PARENT_CATEGORY_NOT_FOUND");
}

async function getParentId(tx: Prisma.TransactionClient, id: string): Promise<string | null> {
  const row = await tx.category.findUnique({ where: { id }, select: { parentId: true } });
  return row?.parentId ?? null;
}

export async function createCategory(
  input: CreateCategoryInput,
  actor: CategoryActor,
  idempotencyKey: string,
): Promise<unknown> {
  return runTransaction(async (tx) => {
    if (input.parentId) await assertParentExists(tx, input.parentId);

    const category = await tx.category.create({
      data: {
        name: input.name,
        parentId: input.parentId ?? null,
        defaultGstRate: input.defaultGstRate,
        defaultTaxClassification: input.defaultTaxClassification,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      },
    });

    const serialized = serializeBigInt(category);

    await writeAudit(tx, actor, {
      action: "create",
      entityType: "category",
      entityId: category.id,
      after: serialized as unknown as Record<string, unknown>,
    });

    const responseBody = success(serialized);
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}

export async function getCategory(id: string) {
  const category = await prisma.category.findFirst({ where: { id, deletedAt: null } });
  if (!category) throw new NotFoundError("CATEGORY_NOT_FOUND");
  return category;
}

export async function listCategories(query: ListCategoriesQuery) {
  const where: Prisma.CategoryWhereInput = {
    deletedAt: null,
    ...(query.parentId ? { parentId: query.parentId } : {}),
    ...(query.search ? { name: { contains: query.search, mode: "insensitive" } } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.category.count({ where }),
    prisma.category.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);

  return { items, total, page: query.page, limit: query.limit };
}

export async function updateCategory(
  id: string,
  input: UpdateCategoryInput,
  actor: CategoryActor,
  idempotencyKey: string,
): Promise<unknown> {
  return runTransaction(async (tx) => {
    const before = await tx.category.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new NotFoundError("CATEGORY_NOT_FOUND");

    if (input.parentId) {
      await assertParentExists(tx, input.parentId);
      await assertNoCycle(id, input.parentId, (pid) => getParentId(tx, pid), "CATEGORY_CIRCULAR_REFERENCE");
    }

    const after = await tx.category.update({
      where: { id },
      data: { ...input, updatedBy: actor.userId },
    });

    const serializedBefore = serializeBigInt(before);
    const serializedAfter = serializeBigInt(after);

    await writeAudit(tx, actor, {
      action: "update",
      entityType: "category",
      entityId: id,
      before: serializedBefore as unknown as Record<string, unknown>,
      after: serializedAfter as unknown as Record<string, unknown>,
    });

    const responseBody = success(serializedAfter);
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}

export async function deleteCategory(id: string, actor: CategoryActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(async (tx) => {
    const before = await tx.category.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new NotFoundError("CATEGORY_NOT_FOUND");

    // Any non-deleted row still referencing this category — active or deactivated — blocks
    // deletion. A deactivated product still holds a real category_id FK; soft-deleting the
    // category out from under it would leave that reference pointing at a row invisible to every
    // default (deleted_at IS NULL) query, including if the product is ever reactivated.
    const [childCount, productCount] = await Promise.all([
      tx.category.count({ where: { parentId: id, deletedAt: null } }),
      tx.product.count({ where: { categoryId: id, deletedAt: null } }),
    ]);
    if (childCount > 0 || productCount > 0) throw new ConflictError("CATEGORY_IN_USE");

    const after = await tx.category.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: actor.userId } });

    await writeAudit(tx, actor, {
      action: "delete",
      entityType: "category",
      entityId: id,
      before: serializeBigInt(before) as unknown as Record<string, unknown>,
      after: serializeBigInt(after) as unknown as Record<string, unknown>,
    });

    const responseBody = success({ deleted: true });
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}
