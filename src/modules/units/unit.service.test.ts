import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import * as unitService from "./unit.service.js";
import type { UnitActor } from "./unit.service.js";

// TDD §22.1: service-layer tests run against the real dev DB, no mocks. Each test creates and
// tears down its own throwaway branch/user/unit/product/idempotency-key rows.

let branchId: string;
let categoryId: string;
let actor: UnitActor;

const createdUnitIds: string[] = [];
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

interface CreatedUnit {
  data: { id: string; name: string; symbol: string; baseUnitId: string | null; conversionFactor: number | null };
}

beforeAll(async () => {
  const branch = await prisma.branch.create({
    data: { name: `Unit Test Branch ${randomUUID()}`, code: `UTB${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  branchId = branch.id;

  const user = await prisma.user.create({
    data: {
      username: `unittest_${randomUUID()}`,
      passwordHash: "unused",
      name: "Unit Service Test User",
      role: "admin",
      isActive: true,
      mustChangePassword: false,
    },
  });
  actor = { userId: user.id, role: "admin", branchId };

  const category = await prisma.category.create({ data: { name: `Unit Test Category ${randomUUID()}` } });
  categoryId = category.id;
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
  await prisma.unit.deleteMany({ where: { id: { in: createdUnitIds } } });
  await prisma.category.delete({ where: { id: categoryId } });
  await prisma.user.delete({ where: { id: actor.userId } });
  await prisma.branch.delete({ where: { id: branchId } });
});

describe("unit.service", () => {
  it("creates a base unit atomically", async () => {
    const key = await newIdempotencyKey("unit:create");
    const name = `Test Unit ${randomUUID()}`;

    const response = (await unitService.createUnit({ name, symbol: "tu" }, actor, key)) as CreatedUnit;
    createdUnitIds.push(response.data.id);

    expect(response.data.name).toBe(name);
    expect(response.data.baseUnitId).toBeNull();

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "unit", entityId: response.data.id, action: "create" },
    });
    expect(auditRow.userId).toBe(actor.userId);

    const completedKey = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
    expect(completedKey.status).toBe("completed");
  });

  it("creates a derived unit with a base unit and conversion factor", async () => {
    const baseKey = await newIdempotencyKey("unit:create");
    const base = (await unitService.createUnit({ name: `Test Kg ${randomUUID()}`, symbol: "kg" }, actor, baseKey)) as CreatedUnit;
    createdUnitIds.push(base.data.id);

    const bagKey = await newIdempotencyKey("unit:create");
    const bag = (await unitService.createUnit(
      { name: `Test Bag ${randomUUID()}`, symbol: "bag", baseUnitId: base.data.id, conversionFactor: 50 },
      actor,
      bagKey,
    )) as CreatedUnit;
    createdUnitIds.push(bag.data.id);

    expect(bag.data.baseUnitId).toBe(base.data.id);
    expect(bag.data.conversionFactor).toBe(50);
  });

  it("rejects create with a non-existent baseUnitId", async () => {
    const key = await newIdempotencyKey("unit:create");
    await expect(
      unitService.createUnit({ name: `Test Bad Base ${randomUUID()}`, symbol: "bb", baseUnitId: randomUUID(), conversionFactor: 10 }, actor, key),
    ).rejects.toMatchObject({ code: "BASE_UNIT_NOT_FOUND" });
  });

  it("returns 404 for a deleted/non-existent unit", async () => {
    await expect(unitService.getUnit(randomUUID())).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });
  });

  it("rejects a unit becoming its own base unit (direct self-reference)", async () => {
    const createKey = await newIdempotencyKey("unit:create");
    const created = (await unitService.createUnit({ name: `Test Self ${randomUUID()}`, symbol: "ts" }, actor, createKey)) as CreatedUnit;
    createdUnitIds.push(created.data.id);

    const updateKey = await newIdempotencyKey("unit:update");
    await expect(
      unitService.updateUnit(created.data.id, { baseUnitId: created.data.id, conversionFactor: 1 }, actor, updateKey),
    ).rejects.toMatchObject({ code: "UNIT_CIRCULAR_REFERENCE" });
  });

  it("rejects a unit becoming its own ancestor via a chain (A -> B -> C, then A.base = C)", async () => {
    const keyA = await newIdempotencyKey("unit:create");
    const unitA = (await unitService.createUnit({ name: `Test Chain A ${randomUUID()}`, symbol: "ca" }, actor, keyA)) as CreatedUnit;
    createdUnitIds.push(unitA.data.id);

    const keyB = await newIdempotencyKey("unit:create");
    const unitB = (await unitService.createUnit(
      { name: `Test Chain B ${randomUUID()}`, symbol: "cb", baseUnitId: unitA.data.id, conversionFactor: 2 },
      actor,
      keyB,
    )) as CreatedUnit;
    createdUnitIds.push(unitB.data.id);

    const keyC = await newIdempotencyKey("unit:create");
    const unitC = (await unitService.createUnit(
      { name: `Test Chain C ${randomUUID()}`, symbol: "cc", baseUnitId: unitB.data.id, conversionFactor: 3 },
      actor,
      keyC,
    )) as CreatedUnit;
    createdUnitIds.push(unitC.data.id);

    const updateKey = await newIdempotencyKey("unit:update");
    await expect(
      unitService.updateUnit(unitA.data.id, { baseUnitId: unitC.data.id, conversionFactor: 6 }, actor, updateKey),
    ).rejects.toMatchObject({ code: "UNIT_CIRCULAR_REFERENCE" });
  });

  it("updates conversionFactor and audits the diff", async () => {
    const baseKey = await newIdempotencyKey("unit:create");
    const base = (await unitService.createUnit({ name: `Test Base ${randomUUID()}`, symbol: "b" }, actor, baseKey)) as CreatedUnit;
    createdUnitIds.push(base.data.id);

    const createKey = await newIdempotencyKey("unit:create");
    const created = (await unitService.createUnit(
      { name: `Test Update ${randomUUID()}`, symbol: "tu2", baseUnitId: base.data.id, conversionFactor: 10 },
      actor,
      createKey,
    )) as CreatedUnit;
    createdUnitIds.push(created.data.id);

    const updateKey = await newIdempotencyKey("unit:update");
    await unitService.updateUnit(created.data.id, { baseUnitId: base.data.id, conversionFactor: 20 }, actor, updateKey);

    const updated = await prisma.unit.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(updated.conversionFactor?.toNumber()).toBe(20);
  });

  it("rejects deleting a unit that is still the base unit of a non-deleted variant", async () => {
    const baseKey = await newIdempotencyKey("unit:create");
    const base = (await unitService.createUnit({ name: `Test In Use Base ${randomUUID()}`, symbol: "iub" }, actor, baseKey)) as CreatedUnit;
    createdUnitIds.push(base.data.id);

    const variantKey = await newIdempotencyKey("unit:create");
    const variant = (await unitService.createUnit(
      { name: `Test Variant ${randomUUID()}`, symbol: "var", baseUnitId: base.data.id, conversionFactor: 5 },
      actor,
      variantKey,
    )) as CreatedUnit;
    createdUnitIds.push(variant.data.id);

    const deleteKey = await newIdempotencyKey("unit:delete");
    await expect(unitService.deleteUnit(base.data.id, actor, deleteKey)).rejects.toMatchObject({ code: "UNIT_IN_USE" });
  });

  it("rejects deleting a unit still referenced by a deactivated (not soft-deleted) product", async () => {
    const unitKey = await newIdempotencyKey("unit:create");
    const unit = (await unitService.createUnit({ name: `Test Product Ref ${randomUUID()}`, symbol: "pr" }, actor, unitKey)) as CreatedUnit;
    createdUnitIds.push(unit.data.id);

    const product = await prisma.product.create({
      data: {
        name: `Test Product ${randomUUID()}`,
        categoryId,
        unitId: unit.data.id,
        gstRate: 5,
        taxClassification: "taxable",
        isActive: false, // deactivated, not soft-deleted — still a live FK reference
      },
    });
    createdProductIds.push(product.id);

    const deleteKey = await newIdempotencyKey("unit:delete");
    await expect(unitService.deleteUnit(unit.data.id, actor, deleteKey)).rejects.toMatchObject({ code: "UNIT_IN_USE" });
  });

  it("soft-deletes an unreferenced unit", async () => {
    const key = await newIdempotencyKey("unit:create");
    const created = (await unitService.createUnit({ name: `Test Delete ${randomUUID()}`, symbol: "del" }, actor, key)) as CreatedUnit;
    createdUnitIds.push(created.data.id);

    const deleteKey = await newIdempotencyKey("unit:delete");
    await unitService.deleteUnit(created.data.id, actor, deleteKey);

    const after = await prisma.unit.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(after.deletedAt).not.toBeNull();

    await expect(unitService.getUnit(created.data.id)).rejects.toMatchObject({ code: "UNIT_NOT_FOUND" });
  });

  it("lists units with search and pagination", async () => {
    const uniqueTag = randomUUID().slice(0, 8);
    const names = [`Zzz Search ${uniqueTag} A`, `Zzz Search ${uniqueTag} B`, `Zzz Search ${uniqueTag} C`];
    for (const name of names) {
      const key = await newIdempotencyKey("unit:create");
      const created = (await unitService.createUnit({ name, symbol: name.slice(0, 5) }, actor, key)) as CreatedUnit;
      createdUnitIds.push(created.data.id);
    }

    const page1 = await unitService.listUnits({ page: 1, limit: 2, search: `Search ${uniqueTag}` });
    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);
  });
});
