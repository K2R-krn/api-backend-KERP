import { Prisma } from "@prisma/client";
import { prisma, runTransaction } from "../../db/client.js";
import { writeAudit } from "../../shared/audit.js";
import { completeIdempotencyKey } from "../../shared/idempotency.js";
import { assertNoCycle } from "../../shared/hierarchy.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { success } from "../../shared/envelope.js";
import { serializeBigInt } from "../../shared/serialize.js";
import type { Role } from "../../shared/types.js";
import type { CreateUnitInput, ListUnitsQuery, UpdateUnitInput } from "./unit.validation.js";

export interface UnitActor {
  userId: string;
  role: Role;
  branchId: string;
}

// Units are a single shared catalog across all branches, same as products (TDD §6.3 — no
// branch_id column). branchContext still runs on every route purely to tag audit rows with the
// acting branch, same reasoning as product.service.ts.

async function assertBaseUnitExists(tx: Prisma.TransactionClient, baseUnitId: string): Promise<void> {
  const base = await tx.unit.findFirst({ where: { id: baseUnitId, deletedAt: null } });
  if (!base) throw new NotFoundError("BASE_UNIT_NOT_FOUND");
}

async function getBaseUnitId(tx: Prisma.TransactionClient, id: string): Promise<string | null> {
  const row = await tx.unit.findUnique({ where: { id }, select: { baseUnitId: true } });
  return row?.baseUnitId ?? null;
}

export async function createUnit(input: CreateUnitInput, actor: UnitActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(async (tx) => {
    if (input.baseUnitId) await assertBaseUnitExists(tx, input.baseUnitId);

    const unit = await tx.unit.create({
      data: {
        name: input.name,
        symbol: input.symbol,
        baseUnitId: input.baseUnitId ?? null,
        conversionFactor: input.conversionFactor,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      },
    });

    const serialized = serializeBigInt(unit);

    await writeAudit(tx, actor, {
      action: "create",
      entityType: "unit",
      entityId: unit.id,
      after: serialized as unknown as Record<string, unknown>,
    });

    const responseBody = success(serialized);
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}

export async function getUnit(id: string) {
  const unit = await prisma.unit.findFirst({ where: { id, deletedAt: null } });
  if (!unit) throw new NotFoundError("UNIT_NOT_FOUND");
  return unit;
}

export async function listUnits(query: ListUnitsQuery) {
  const where: Prisma.UnitWhereInput = {
    deletedAt: null,
    ...(query.search ? { name: { contains: query.search, mode: "insensitive" } } : {}),
  };

  const [total, items] = await Promise.all([
    prisma.unit.count({ where }),
    prisma.unit.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);

  return { items, total, page: query.page, limit: query.limit };
}

export async function updateUnit(
  id: string,
  input: UpdateUnitInput,
  actor: UnitActor,
  idempotencyKey: string,
): Promise<unknown> {
  return runTransaction(async (tx) => {
    const before = await tx.unit.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new NotFoundError("UNIT_NOT_FOUND");

    if (input.baseUnitId) {
      await assertBaseUnitExists(tx, input.baseUnitId);
      await assertNoCycle(id, input.baseUnitId, (bid) => getBaseUnitId(tx, bid), "UNIT_CIRCULAR_REFERENCE");
    }

    const after = await tx.unit.update({
      where: { id },
      data: { ...input, updatedBy: actor.userId },
    });

    const serializedBefore = serializeBigInt(before);
    const serializedAfter = serializeBigInt(after);

    await writeAudit(tx, actor, {
      action: "update",
      entityType: "unit",
      entityId: id,
      before: serializedBefore as unknown as Record<string, unknown>,
      after: serializedAfter as unknown as Record<string, unknown>,
    });

    const responseBody = success(serializedAfter);
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}

export async function deleteUnit(id: string, actor: UnitActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(async (tx) => {
    const before = await tx.unit.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new NotFoundError("UNIT_NOT_FOUND");

    // Any non-deleted row still referencing this unit — active or deactivated — blocks deletion.
    // Same reasoning as category.service.ts's deleteCategory guard.
    const [variantCount, productCount] = await Promise.all([
      tx.unit.count({ where: { baseUnitId: id, deletedAt: null } }),
      tx.product.count({ where: { unitId: id, deletedAt: null } }),
    ]);
    if (variantCount > 0 || productCount > 0) throw new ConflictError("UNIT_IN_USE");

    const after = await tx.unit.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: actor.userId } });

    await writeAudit(tx, actor, {
      action: "delete",
      entityType: "unit",
      entityId: id,
      before: serializeBigInt(before) as unknown as Record<string, unknown>,
      after: serializeBigInt(after) as unknown as Record<string, unknown>,
    });

    const responseBody = success({ deleted: true });
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}
