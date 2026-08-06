import { Prisma } from "@prisma/client";
import { prisma, runTransaction } from "../../db/client.js";
import { writeAudit } from "../../shared/audit.js";
import { completeIdempotencyKey } from "../../shared/idempotency.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { success } from "../../shared/envelope.js";
import { serializeBigInt } from "../../shared/serialize.js";
import type { Role } from "../../shared/types.js";
import type { BillingProductSearchQuery, CreateProductInput, ListProductsQuery, UpdateProductInput } from "./product.validation.js";

export interface ProductActor {
  userId: string;
  role: Role;
  branchId: string;
}

// Products are a single shared catalog across all branches (TDD §6.5 — no branch_id column;
// unlike Parties, reads/writes are never filtered by owning branch). branchContext still runs on
// every route (TDD §7.2 "every request resolves an acting branch") purely so audit rows carry
// which branch the actor was working from — it plays no role in scoping product rows themselves.

async function assertUnitExists(tx: Prisma.TransactionClient, unitId: string): Promise<void> {
  const unit = await tx.unit.findFirst({ where: { id: unitId, deletedAt: null } });
  if (!unit) throw new NotFoundError("UNIT_NOT_FOUND");
}

async function assertCategoryExists(tx: Prisma.TransactionClient, categoryId: string): Promise<void> {
  const category = await tx.category.findFirst({ where: { id: categoryId, deletedAt: null } });
  if (!category) throw new NotFoundError("CATEGORY_NOT_FOUND");
}

// sku's uniqueness is enforced by the partial index ux_products_sku_active (soft-delete-safe);
// surface the violation as a clean conflict instead of a raw DB constraint error.
function rethrowSkuConflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    throw new ConflictError("SKU_ALREADY_EXISTS");
  }
  throw err;
}

export async function createProduct(
  input: CreateProductInput,
  actor: ProductActor,
  idempotencyKey: string,
): Promise<unknown> {
  return runTransaction(async (tx) => {
    await assertUnitExists(tx, input.unitId);
    if (input.categoryId) await assertCategoryExists(tx, input.categoryId);

    const product = await tx.product
      .create({
        data: {
          name: input.name,
          hsnCode: input.hsnCode ?? null,
          sku: input.sku ?? null,
          categoryId: input.categoryId ?? null,
          unitId: input.unitId,
          gstRate: input.gstRate,
          priceIncludesGst: input.priceIncludesGst,
          taxClassification: input.taxClassification,
          purchasePrice: BigInt(input.purchasePrice),
          salePrice: BigInt(input.salePrice),
          mrp: input.mrp !== undefined ? BigInt(input.mrp) : null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
      })
      .catch(rethrowSkuConflict);

    // purchasePrice/salePrice/mrp are bigint — serialize before the value hits an audit Json
    // column or an HTTP response, both of which choke on raw BigInt (bug #2, JSON.stringify has
    // no BigInt support).
    const serialized = serializeBigInt(product);

    await writeAudit(tx, actor, {
      action: "create",
      entityType: "product",
      entityId: product.id,
      after: serialized as unknown as Record<string, unknown>,
    });

    const responseBody = success(serialized);
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}

export async function getProduct(id: string) {
  const product = await prisma.product.findFirst({ where: { id, deletedAt: null } });
  if (!product) throw new NotFoundError("PRODUCT_NOT_FOUND");
  return product;
}

export async function listProducts(query: ListProductsQuery) {
  const where: Prisma.ProductWhereInput = {
    deletedAt: null,
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: "insensitive" } },
            { hsnCode: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(query.createdFrom || query.createdTo
      ? {
          createdAt: {
            ...(query.createdFrom ? { gte: query.createdFrom } : {}),
            ...(query.createdTo ? { lte: query.createdTo } : {}),
          },
        }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);

  return { items, total, page: query.page, limit: query.limit };
}

// TDD §28.5 — billing screen product search. Querying FROM branch_stock (rather than product with
// an included/filtered relation) is what gives the inner-join semantics: only products that have
// an actual stock row for this branch can appear at all, matching "unstocked items can't be
// billed." Searches products(name)/products(hsn_code) only — TDD names those two indexes and no
// third (sku isn't mentioned), so sku is returned for display but not searched.
export async function searchBillingProducts(query: BillingProductSearchQuery, actor: { branchId: string }) {
  const rows = await prisma.branchStock.findMany({
    where: {
      branchId: actor.branchId,
      product: {
        deletedAt: null,
        isActive: true,
        OR: [
          { name: { contains: query.q, mode: "insensitive" } },
          { hsnCode: { contains: query.q, mode: "insensitive" } },
        ],
      },
    },
    include: { product: { include: { unit: true } } },
    orderBy: { product: { name: "asc" } },
    take: 20,
  });

  return rows.map((row) => ({
    id: row.product.id,
    name: row.product.name,
    hsnCode: row.product.hsnCode,
    sku: row.product.sku,
    unit: row.product.unit.symbol,
    salePrice: row.product.salePrice,
    gstRate: row.product.gstRate,
    taxClassification: row.product.taxClassification,
    quantity: row.quantity,
  }));
}

export async function updateProduct(
  id: string,
  input: UpdateProductInput,
  actor: ProductActor,
  idempotencyKey: string,
): Promise<unknown> {
  return runTransaction(async (tx) => {
    const before = await tx.product.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new NotFoundError("PRODUCT_NOT_FOUND");

    if (input.unitId) await assertUnitExists(tx, input.unitId);
    if (input.categoryId) await assertCategoryExists(tx, input.categoryId);

    const after = await tx.product
      .update({
        where: { id },
        data: {
          ...input,
          purchasePrice: input.purchasePrice !== undefined ? BigInt(input.purchasePrice) : undefined,
          salePrice: input.salePrice !== undefined ? BigInt(input.salePrice) : undefined,
          mrp: input.mrp !== undefined ? BigInt(input.mrp) : undefined,
          updatedBy: actor.userId,
        },
      })
      .catch(rethrowSkuConflict);

    const serializedBefore = serializeBigInt(before);
    const serializedAfter = serializeBigInt(after);

    await writeAudit(tx, actor, {
      action: "update",
      entityType: "product",
      entityId: id,
      before: serializedBefore as unknown as Record<string, unknown>,
      after: serializedAfter as unknown as Record<string, unknown>,
    });

    const responseBody = success(serializedAfter);
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}

export async function deactivateProduct(id: string, actor: ProductActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(async (tx) => {
    const before = await tx.product.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new NotFoundError("PRODUCT_NOT_FOUND");

    const after = await tx.product.update({ where: { id }, data: { isActive: false, updatedBy: actor.userId } });

    await writeAudit(tx, actor, {
      action: "deactivate",
      entityType: "product",
      entityId: id,
      before: serializeBigInt(before) as unknown as Record<string, unknown>,
      after: serializeBigInt(after) as unknown as Record<string, unknown>,
    });

    const responseBody = success({ deactivated: true });
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}
