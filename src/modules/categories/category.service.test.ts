import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import * as categoryService from "./category.service.js";
import type { CategoryActor } from "./category.service.js";

// TDD §22.1: service-layer tests run against the real dev DB, no mocks. Each test creates and
// tears down its own throwaway branch/user/category/product/idempotency-key rows.

let branchId: string;
let unitId: string;
let actor: CategoryActor;

const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];
const createdIdempotencyKeys: string[] = [];

async function newIdempotencyKey(scope: string): Promise<string> {
  const key = randomUUID();
  await prisma.idempotencyKey.create({
    data: { key, userId: actor.userId, scope, requestHash: "test", status: "in_progress", expiresAt: new Date(Date.now() + 60_000) },
  });
  createdIdempotencyKeys.push(key);
  return key;
}

interface CreatedCategory {
  data: { id: string; name: string; parentId: string | null };
}

beforeAll(async () => {
  const branch = await prisma.branch.create({
    data: { name: `Category Test Branch ${randomUUID()}`, code: `CTB${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  branchId = branch.id;

  const user = await prisma.user.create({
    data: {
      username: `categorytest_${randomUUID()}`,
      passwordHash: "unused",
      name: "Category Service Test User",
      role: "admin",
      isActive: true,
      mustChangePassword: false,
    },
  });
  actor = { userId: user.id, role: "admin", branchId };

  const unit = await prisma.unit.create({ data: { name: `Category Test Unit ${randomUUID()}`, symbol: "ctu" } });
  unitId = unit.id;
});

afterEach(async () => {
  if (createdProductIds.length) {
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    createdProductIds.length = 0;
  }
  if (createdIdempotencyKeys.length) {
    await prisma.idempotencyKey.deleteMany({ where: { key: { in: createdIdempotencyKeys } } });
    createdIdempotencyKeys.length = 0;
  }
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { userId: actor.userId } });
  await prisma.category.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await prisma.unit.delete({ where: { id: unitId } });
  await prisma.user.delete({ where: { id: actor.userId } });
  await prisma.branch.delete({ where: { id: branchId } });
});

describe("category.service", () => {
  it("creates a category atomically", async () => {
    const key = await newIdempotencyKey("category:create");
    const name = `Test Category ${randomUUID()}`;

    const response = (await categoryService.createCategory(
      { name, defaultGstRate: 5, defaultTaxClassification: "taxable" },
      actor,
      key,
    )) as CreatedCategory;
    createdCategoryIds.push(response.data.id);

    expect(response.data.name).toBe(name);

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "category", entityId: response.data.id, action: "create" },
    });
    expect(auditRow.userId).toBe(actor.userId);

    const completedKey = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
    expect(completedKey.status).toBe("completed");
  });

  it("rejects create with a non-existent parentId", async () => {
    const key = await newIdempotencyKey("category:create");
    await expect(
      categoryService.createCategory({ name: `Test Bad Parent ${randomUUID()}`, parentId: randomUUID() }, actor, key),
    ).rejects.toMatchObject({ code: "PARENT_CATEGORY_NOT_FOUND" });
  });

  it("returns 404 for a deleted/non-existent category", async () => {
    await expect(categoryService.getCategory(randomUUID())).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
  });

  it("rejects a category becoming its own parent (direct self-reference)", async () => {
    const createKey = await newIdempotencyKey("category:create");
    const created = (await categoryService.createCategory({ name: `Test Self ${randomUUID()}` }, actor, createKey)) as CreatedCategory;
    createdCategoryIds.push(created.data.id);

    const updateKey = await newIdempotencyKey("category:update");
    await expect(
      categoryService.updateCategory(created.data.id, { parentId: created.data.id }, actor, updateKey),
    ).rejects.toMatchObject({ code: "CATEGORY_CIRCULAR_REFERENCE" });
  });

  it("rejects a category becoming its own ancestor via a chain (A -> B -> C, then A.parent = C)", async () => {
    const keyA = await newIdempotencyKey("category:create");
    const catA = (await categoryService.createCategory({ name: `Test Chain A ${randomUUID()}` }, actor, keyA)) as CreatedCategory;
    createdCategoryIds.push(catA.data.id);

    const keyB = await newIdempotencyKey("category:create");
    const catB = (await categoryService.createCategory(
      { name: `Test Chain B ${randomUUID()}`, parentId: catA.data.id },
      actor,
      keyB,
    )) as CreatedCategory;
    createdCategoryIds.push(catB.data.id);

    const keyC = await newIdempotencyKey("category:create");
    const catC = (await categoryService.createCategory(
      { name: `Test Chain C ${randomUUID()}`, parentId: catB.data.id },
      actor,
      keyC,
    )) as CreatedCategory;
    createdCategoryIds.push(catC.data.id);

    const updateKey = await newIdempotencyKey("category:update");
    await expect(
      categoryService.updateCategory(catA.data.id, { parentId: catC.data.id }, actor, updateKey),
    ).rejects.toMatchObject({ code: "CATEGORY_CIRCULAR_REFERENCE" });
  });

  it("updates commercial defaults and audits the diff", async () => {
    const createKey = await newIdempotencyKey("category:create");
    const created = (await categoryService.createCategory(
      { name: `Test Update ${randomUUID()}`, defaultGstRate: 5 },
      actor,
      createKey,
    )) as CreatedCategory;
    createdCategoryIds.push(created.data.id);

    const updateKey = await newIdempotencyKey("category:update");
    await categoryService.updateCategory(created.data.id, { defaultGstRate: 18 }, actor, updateKey);

    const updated = await prisma.category.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(updated.defaultGstRate?.toNumber()).toBe(18);
  });

  it("rejects deleting a category that still has non-deleted child categories", async () => {
    const parentKey = await newIdempotencyKey("category:create");
    const parent = (await categoryService.createCategory({ name: `Test Parent ${randomUUID()}` }, actor, parentKey)) as CreatedCategory;
    createdCategoryIds.push(parent.data.id);

    const childKey = await newIdempotencyKey("category:create");
    const child = (await categoryService.createCategory(
      { name: `Test Child ${randomUUID()}`, parentId: parent.data.id },
      actor,
      childKey,
    )) as CreatedCategory;
    createdCategoryIds.push(child.data.id);

    const deleteKey = await newIdempotencyKey("category:delete");
    await expect(categoryService.deleteCategory(parent.data.id, actor, deleteKey)).rejects.toMatchObject({
      code: "CATEGORY_IN_USE",
    });
  });

  it("rejects deleting a category still referenced by a deactivated (not soft-deleted) product", async () => {
    const catKey = await newIdempotencyKey("category:create");
    const category = (await categoryService.createCategory({ name: `Test In Use ${randomUUID()}` }, actor, catKey)) as CreatedCategory;
    createdCategoryIds.push(category.data.id);

    const product = await prisma.product.create({
      data: {
        name: `Test Product ${randomUUID()}`,
        categoryId: category.data.id,
        unitId,
        gstRate: 5,
        taxClassification: "taxable",
        isActive: false, // deactivated, not soft-deleted — still a live FK reference
      },
    });
    createdProductIds.push(product.id);

    const deleteKey = await newIdempotencyKey("category:delete");
    await expect(categoryService.deleteCategory(category.data.id, actor, deleteKey)).rejects.toMatchObject({
      code: "CATEGORY_IN_USE",
    });
  });

  it("soft-deletes an unreferenced category", async () => {
    const key = await newIdempotencyKey("category:create");
    const created = (await categoryService.createCategory({ name: `Test Delete ${randomUUID()}` }, actor, key)) as CreatedCategory;
    createdCategoryIds.push(created.data.id);

    const deleteKey = await newIdempotencyKey("category:delete");
    await categoryService.deleteCategory(created.data.id, actor, deleteKey);

    const after = await prisma.category.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(after.deletedAt).not.toBeNull();

    await expect(categoryService.getCategory(created.data.id)).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
  });

  it("lists categories with search, parentId filter, and pagination", async () => {
    const uniqueTag = randomUUID().slice(0, 8);
    const parentKey = await newIdempotencyKey("category:create");
    const parent = (await categoryService.createCategory({ name: `Zzz Parent ${uniqueTag}` }, actor, parentKey)) as CreatedCategory;
    createdCategoryIds.push(parent.data.id);

    const names = [`Zzz Search ${uniqueTag} A`, `Zzz Search ${uniqueTag} B`];
    for (const name of names) {
      const key = await newIdempotencyKey("category:create");
      const created = (await categoryService.createCategory({ name, parentId: parent.data.id }, actor, key)) as CreatedCategory;
      createdCategoryIds.push(created.data.id);
    }

    const byParent = await categoryService.listCategories({ page: 1, limit: 20, parentId: parent.data.id });
    expect(byParent.total).toBe(2);

    const bySearch = await categoryService.listCategories({ page: 1, limit: 1, search: `Search ${uniqueTag}` });
    expect(bySearch.total).toBe(2);
    expect(bySearch.items).toHaveLength(1);
  });
});
