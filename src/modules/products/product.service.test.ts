import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import * as productService from "./product.service.js";
import type { ProductActor } from "./product.service.js";

// TDD §22.1: service-layer tests run against the real dev DB, no mocks. Each test creates and
// tears down its own throwaway branch/user/unit/category/products/idempotency keys.

let branchId: string;
let unitId: string;
let categoryId: string;
let actor: ProductActor;

const createdProductIds: string[] = [];
const createdIdempotencyKeys: string[] = [];
// branch_stock rows created for the searchBillingProducts tests below — must be deleted BEFORE
// their product (RESTRICT FK), so tracked separately from createdProductIds.
const createdBranchStockProductIds: string[] = [];

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

interface CreatedProduct {
  data: {
    id: string;
    sku: string | null;
    gstRate: number;
    taxClassification: string;
    purchasePrice: number;
    salePrice: number;
    mrp: number | null;
  };
}

beforeAll(async () => {
  const branch = await prisma.branch.create({
    data: {
      name: `Product Test Branch ${randomUUID()}`,
      code: `PTB${randomUUID().slice(0, 6)}`,
      stateCode: "24",
    },
  });
  branchId = branch.id;

  const user = await prisma.user.create({
    data: {
      username: `producttest_${randomUUID()}`,
      passwordHash: "unused",
      name: "Product Service Test User",
      role: "admin",
      isActive: true,
      mustChangePassword: false,
    },
  });
  actor = { userId: user.id, role: "admin", branchId };

  const unit = await prisma.unit.create({ data: { name: `Test Unit ${randomUUID()}`, symbol: "tu" } });
  unitId = unit.id;

  const category = await prisma.category.create({ data: { name: `Test Category ${randomUUID()}` } });
  categoryId = category.id;
});

afterEach(async () => {
  if (createdBranchStockProductIds.length) {
    await prisma.branchStock.deleteMany({ where: { branchId, productId: { in: createdBranchStockProductIds } } });
    createdBranchStockProductIds.length = 0;
  }
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
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.unit.delete({ where: { id: unitId } });
  await prisma.user.delete({ where: { id: actor.userId } });
  await prisma.branch.delete({ where: { id: branchId } });
});

describe("product.service", () => {
  it("creates a product with explicit gstRate/taxClassification, atomically", async () => {
    const key = await newIdempotencyKey("product:create");
    const name = `Test Product ${randomUUID()}`;

    const response = (await productService.createProduct(
      {
        name,
        unitId,
        categoryId,
        gstRate: 18,
        taxClassification: "taxable",
        priceIncludesGst: false,
        purchasePrice: 10_000,
        salePrice: 12_000,
        mrp: 15_000,
      },
      actor,
      key,
    )) as CreatedProduct;
    createdProductIds.push(response.data.id);

    expect(response.data.gstRate).toBe(18);
    expect(response.data.taxClassification).toBe("taxable");
    expect(response.data.purchasePrice).toBe(10_000);
    expect(response.data.salePrice).toBe(12_000);
    expect(response.data.mrp).toBe(15_000);

    const stored = await prisma.product.findUniqueOrThrow({ where: { id: response.data.id } });
    expect(stored.purchasePrice).toBe(10_000n);

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "product", entityId: response.data.id, action: "create" },
    });
    expect(auditRow.userId).toBe(actor.userId);

    const completedKey = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
    expect(completedKey.status).toBe("completed");
  });

  it("rejects create with a non-existent unitId", async () => {
    const key = await newIdempotencyKey("product:create");
    await expect(
      productService.createProduct(
        {
          name: `Test Bad Unit ${randomUUID()}`,
          unitId: randomUUID(),
          gstRate: 5,
          taxClassification: "taxable",
          priceIncludesGst: false,
          purchasePrice: 0,
          salePrice: 0,
        },
        actor,
        key,
      ),
    ).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });
  });

  it("rejects create with a non-existent categoryId", async () => {
    const key = await newIdempotencyKey("product:create");
    await expect(
      productService.createProduct(
        {
          name: `Test Bad Category ${randomUUID()}`,
          unitId,
          categoryId: randomUUID(),
          gstRate: 5,
          taxClassification: "taxable",
          priceIncludesGst: false,
          purchasePrice: 0,
          salePrice: 0,
        },
        actor,
        key,
      ),
    ).rejects.toMatchObject({ code: "CATEGORY_NOT_FOUND" });
  });

  it("rejects a duplicate sku with a clean conflict error, not a raw DB constraint violation", async () => {
    const sku = `SKU-${randomUUID().slice(0, 8)}`;
    const key1 = await newIdempotencyKey("product:create");
    const first = (await productService.createProduct(
      {
        name: `Test Sku A ${randomUUID()}`,
        unitId,
        sku,
        gstRate: 5,
        taxClassification: "taxable",
        priceIncludesGst: false,
        purchasePrice: 0,
        salePrice: 0,
      },
      actor,
      key1,
    )) as CreatedProduct;
    createdProductIds.push(first.data.id);

    const key2 = await newIdempotencyKey("product:create");
    await expect(
      productService.createProduct(
        {
          name: `Test Sku B ${randomUUID()}`,
          unitId,
          sku,
          gstRate: 5,
          taxClassification: "taxable",
          priceIncludesGst: false,
          purchasePrice: 0,
          salePrice: 0,
        },
        actor,
        key2,
      ),
    ).rejects.toMatchObject({ code: "SKU_ALREADY_EXISTS" });
  });

  it("replays the stored response instead of creating a duplicate when the idempotency key is already completed", async () => {
    const key = await newIdempotencyKey("product:create");
    const name = `Test Idempotent ${randomUUID()}`;

    const first = (await productService.createProduct(
      { name, unitId, gstRate: 0, taxClassification: "taxable", priceIncludesGst: false, purchasePrice: 0, salePrice: 0 },
      actor,
      key,
    )) as CreatedProduct;
    createdProductIds.push(first.data.id);

    const stored = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
    expect(stored.status).toBe("completed");
    expect((stored.response as unknown as CreatedProduct).data.id).toBe(first.data.id);

    const matchingProducts = await prisma.product.findMany({ where: { name } });
    expect(matchingProducts).toHaveLength(1);
  });

  it("returns 404 for a deleted/non-existent product", async () => {
    await expect(productService.getProduct(randomUUID())).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });

  it("updates commercial fields and audits the diff", async () => {
    const createKey = await newIdempotencyKey("product:create");
    const created = (await productService.createProduct(
      {
        name: `Test Update ${randomUUID()}`,
        unitId,
        gstRate: 5,
        taxClassification: "taxable",
        priceIncludesGst: false,
        purchasePrice: 1_000,
        salePrice: 1_500,
      },
      actor,
      createKey,
    )) as CreatedProduct;
    createdProductIds.push(created.data.id);

    const updateKey = await newIdempotencyKey("product:update");
    await productService.updateProduct(created.data.id, { salePrice: 1_800, gstRate: 12 }, actor, updateKey);

    const updated = await prisma.product.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(updated.salePrice).toBe(1_800n);
    expect(updated.gstRate.toNumber()).toBe(12);
    expect(updated.purchasePrice).toBe(1_000n); // untouched field stays as-is

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "product", entityId: created.data.id, action: "update" },
    });
    const after = auditRow.after as Record<string, unknown>;
    expect(after["salePrice"]).toBe(1_800);
  });

  it("rejects updating a product that does not exist", async () => {
    const key = await newIdempotencyKey("product:update");
    await expect(
      productService.updateProduct(randomUUID(), { name: "Nope" }, actor, key),
    ).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });

  it("deactivates a product (is_active = false) without soft-deleting it", async () => {
    const createKey = await newIdempotencyKey("product:create");
    const created = (await productService.createProduct(
      {
        name: `Test Deactivate ${randomUUID()}`,
        unitId,
        gstRate: 0,
        taxClassification: "taxable",
        priceIncludesGst: false,
        purchasePrice: 0,
        salePrice: 0,
      },
      actor,
      createKey,
    )) as CreatedProduct;
    createdProductIds.push(created.data.id);

    const deactivateKey = await newIdempotencyKey("product:deactivate");
    await productService.deactivateProduct(created.data.id, actor, deactivateKey);

    const after = await prisma.product.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(after.isActive).toBe(false);
    expect(after.deletedAt).toBeNull();

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "product", entityId: created.data.id, action: "deactivate" },
    });
    expect(auditRow.userId).toBe(actor.userId);
  });

  it("lists products with search and pagination, unscoped by branch", async () => {
    const uniqueTag = randomUUID().slice(0, 8);
    const names = [`Zzz Search ${uniqueTag} A`, `Zzz Search ${uniqueTag} B`, `Zzz Search ${uniqueTag} C`];
    for (const name of names) {
      const key = await newIdempotencyKey("product:create");
      const created = (await productService.createProduct(
        { name, unitId, gstRate: 0, taxClassification: "taxable", priceIncludesGst: false, purchasePrice: 0, salePrice: 0 },
        actor,
        key,
      )) as CreatedProduct;
      createdProductIds.push(created.data.id);
    }

    const page1 = await productService.listProducts({ page: 1, limit: 2, search: `Search ${uniqueTag}` });
    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);

    const page2 = await productService.listProducts({ page: 2, limit: 2, search: `Search ${uniqueTag}` });
    expect(page2.items).toHaveLength(1);
  });
});

describe("searchBillingProducts — TDD §28.5 billing screen search", () => {
  it("only returns products with a branch_stock row at the acting branch (inner-join semantics)", async () => {
    const uniqueTag = randomUUID().slice(0, 8);

    const stockedKey = await newIdempotencyKey("product:create");
    const stocked = (await productService.createProduct(
      {
        name: `Billing Search ${uniqueTag} Stocked`,
        unitId,
        gstRate: 5,
        taxClassification: "taxable",
        priceIncludesGst: false,
        purchasePrice: 0,
        salePrice: 12_000,
      },
      actor,
      stockedKey,
    )) as CreatedProduct;
    createdProductIds.push(stocked.data.id);
    await prisma.branchStock.create({ data: { branchId, productId: stocked.data.id, quantity: 25, avgCost: 8_000n } });
    createdBranchStockProductIds.push(stocked.data.id);

    const unstockedKey = await newIdempotencyKey("product:create");
    const unstocked = (await productService.createProduct(
      {
        name: `Billing Search ${uniqueTag} Unstocked`,
        unitId,
        gstRate: 5,
        taxClassification: "taxable",
        priceIncludesGst: false,
        purchasePrice: 0,
        salePrice: 12_000,
      },
      actor,
      unstockedKey,
    )) as CreatedProduct;
    createdProductIds.push(unstocked.data.id);
    // Deliberately no branch_stock row for this one — an unstocked product can't be billed.

    const results = await productService.searchBillingProducts({ q: `Billing Search ${uniqueTag}` }, actor);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(stocked.data.id);
    expect(results[0]?.quantity.toNumber()).toBe(25);
    expect(results[0]?.salePrice).toBe(12_000n);
    expect(results[0]?.gstRate.toNumber()).toBe(5);
    expect(results[0]?.taxClassification).toBe("taxable");
    expect(results[0]?.unit).toBeTruthy();
  });

  it("excludes an inactive (deactivated) product even if stocked at the branch", async () => {
    const uniqueTag = randomUUID().slice(0, 8);
    const key = await newIdempotencyKey("product:create");
    const product = (await productService.createProduct(
      {
        name: `Billing Search Inactive ${uniqueTag}`,
        unitId,
        gstRate: 5,
        taxClassification: "taxable",
        priceIncludesGst: false,
        purchasePrice: 0,
        salePrice: 5_000,
      },
      actor,
      key,
    )) as CreatedProduct;
    createdProductIds.push(product.data.id);
    await prisma.branchStock.create({ data: { branchId, productId: product.data.id, quantity: 10, avgCost: 4_000n } });
    createdBranchStockProductIds.push(product.data.id);

    await productService.deactivateProduct(product.data.id, actor, await newIdempotencyKey("product:deactivate"));

    const results = await productService.searchBillingProducts({ q: `Billing Search Inactive ${uniqueTag}` }, actor);
    expect(results).toHaveLength(0);
  });

  it("matches on hsn_code as well as name", async () => {
    const uniqueHsn = `9${Date.now().toString().slice(-7)}`; // synthetic, collision-unlikely 8-digit HSN
    const key = await newIdempotencyKey("product:create");
    const product = (await productService.createProduct(
      {
        name: `Billing Search HSN Match ${randomUUID().slice(0, 6)}`,
        hsnCode: uniqueHsn,
        unitId,
        gstRate: 5,
        taxClassification: "taxable",
        priceIncludesGst: false,
        purchasePrice: 0,
        salePrice: 5_000,
      },
      actor,
      key,
    )) as CreatedProduct;
    createdProductIds.push(product.data.id);
    await prisma.branchStock.create({ data: { branchId, productId: product.data.id, quantity: 3, avgCost: 4_000n } });
    createdBranchStockProductIds.push(product.data.id);

    const results = await productService.searchBillingProducts({ q: uniqueHsn }, actor);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(product.data.id);
  });

  it("scopes to the acting branch — a stock row at a different branch is not returned", async () => {
    const otherBranch = await prisma.branch.create({
      data: { name: `Other Search Branch ${randomUUID()}`, code: `OSB${randomUUID().slice(0, 6)}`, stateCode: "24" },
    });
    try {
      const uniqueTag = randomUUID().slice(0, 8);
      const key = await newIdempotencyKey("product:create");
      const product = (await productService.createProduct(
        {
          name: `Billing Search Other Branch ${uniqueTag}`,
          unitId,
          gstRate: 5,
          taxClassification: "taxable",
          priceIncludesGst: false,
          purchasePrice: 0,
          salePrice: 5_000,
        },
        actor,
        key,
      )) as CreatedProduct;
      createdProductIds.push(product.data.id);
      await prisma.branchStock.create({ data: { branchId: otherBranch.id, productId: product.data.id, quantity: 7, avgCost: 4_000n } });

      const results = await productService.searchBillingProducts({ q: `Billing Search Other Branch ${uniqueTag}` }, actor);
      expect(results).toHaveLength(0);
    } finally {
      await prisma.branchStock.deleteMany({ where: { branchId: otherBranch.id } });
      await prisma.branch.delete({ where: { id: otherBranch.id } });
    }
  });
});
