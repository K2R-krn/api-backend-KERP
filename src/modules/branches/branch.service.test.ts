import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import * as branchService from "./branch.service.js";
import type { BranchActor } from "./branch.service.js";

// TDD §22.1: service-layer tests run against the real dev DB, no mocks. Each test creates and
// tears down its own throwaway branch/user rows.

let superAdmin: BranchActor;
let memberEmployee: BranchActor; // has a user_branches row for `memberBranchId` only
let outsiderEmployee: BranchActor; // has no user_branches rows at all
let memberBranchId: string;

const createdBranchIds: string[] = [];
// createBranch now also creates that branch's Cash ledger in the same transaction (TDD §26 step
// 10 dependency) — track these separately since deleting a branch only nulls ledgers.branch_id
// (ON DELETE SET NULL), it never removes the ledger row itself.
const createdCashLedgerIds: string[] = [];
const createdIdempotencyKeys: string[] = [];

async function newIdempotencyKey(userId: string, scope: string): Promise<string> {
  const key = randomUUID();
  await prisma.idempotencyKey.create({
    data: { key, userId, scope, requestHash: "test", status: "in_progress", expiresAt: new Date(Date.now() + 60_000) },
  });
  createdIdempotencyKeys.push(key);
  return key;
}

interface CreatedBranch {
  data: { id: string; code: string; stateCode: string; isActive: boolean; cashLedgerId: string };
}

beforeAll(async () => {
  const memberBranch = await prisma.branch.create({
    data: { name: `Member Branch ${randomUUID()}`, code: `MB${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  memberBranchId = memberBranch.id;
  createdBranchIds.push(memberBranchId);

  const superAdminUser = await prisma.user.create({
    data: {
      username: `branchtest_sa_${randomUUID()}`,
      passwordHash: "unused",
      name: "Branch Test Super Admin",
      role: "super_admin",
      isActive: true,
      mustChangePassword: false,
    },
  });
  superAdmin = { userId: superAdminUser.id, role: "super_admin" };

  const memberUser = await prisma.user.create({
    data: {
      username: `branchtest_member_${randomUUID()}`,
      passwordHash: "unused",
      name: "Branch Test Member Employee",
      role: "employee",
      isActive: true,
      mustChangePassword: false,
    },
  });
  await prisma.userBranch.create({ data: { userId: memberUser.id, branchId: memberBranchId } });
  memberEmployee = { userId: memberUser.id, role: "employee", branchId: memberBranchId };

  const outsiderUser = await prisma.user.create({
    data: {
      username: `branchtest_outsider_${randomUUID()}`,
      passwordHash: "unused",
      name: "Branch Test Outsider Employee",
      role: "employee",
      isActive: true,
      mustChangePassword: false,
    },
  });
  outsiderEmployee = { userId: outsiderUser.id, role: "employee" };
});

afterEach(async () => {
  if (createdIdempotencyKeys.length) {
    await prisma.idempotencyKey.deleteMany({ where: { key: { in: createdIdempotencyKeys } } });
    createdIdempotencyKeys.length = 0;
  }
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { userId: { in: [superAdmin.userId, memberEmployee.userId, outsiderEmployee.userId] } } });
  await prisma.userBranch.deleteMany({ where: { userId: memberEmployee.userId } });
  await prisma.branch.deleteMany({ where: { id: { in: createdBranchIds } } });
  // Deleting the branches above only nulls ledgers.branch_id (ON DELETE SET NULL) — the Cash
  // ledger rows createBranch made alongside them survive that and must be removed explicitly, or
  // every test run leaves orphaned "Cash - <code>" ledgers behind.
  await prisma.ledger.deleteMany({ where: { id: { in: createdCashLedgerIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [superAdmin.userId, memberEmployee.userId, outsiderEmployee.userId] } } });

  const leftoverLedgers = await prisma.ledger.count({ where: { id: { in: createdCashLedgerIds } } });
  if (leftoverLedgers > 0) {
    throw new Error(`branch.service.test.ts left ${leftoverLedgers} test Cash ledger(s) behind — cleanup did not fully succeed`);
  }
});

describe("branch.service", () => {
  it("creates a branch atomically", async () => {
    const key = await newIdempotencyKey(superAdmin.userId, "branch:create");
    const code = `BR${randomUUID().slice(0, 6)}`;

    const response = (await branchService.createBranch(
      { name: `Test Branch ${randomUUID()}`, code, stateCode: "24" },
      superAdmin,
      key,
    )) as CreatedBranch;
    createdBranchIds.push(response.data.id);
    createdCashLedgerIds.push(response.data.cashLedgerId);

    expect(response.data.code).toBe(code);
    expect(response.data.isActive).toBe(true);

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "branch", entityId: response.data.id, action: "create" },
    });
    expect(auditRow.userId).toBe(superAdmin.userId);
    expect(auditRow.branchId).toBeNull();

    const completedKey = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key } });
    expect(completedKey.status).toBe("completed");
  });

  it("rejects a duplicate branch code with a clean conflict error", async () => {
    const code = `DUP${randomUUID().slice(0, 6)}`;
    const key1 = await newIdempotencyKey(superAdmin.userId, "branch:create");
    const first = (await branchService.createBranch(
      { name: `Test Dup A ${randomUUID()}`, code, stateCode: "24" },
      superAdmin,
      key1,
    )) as CreatedBranch;
    createdBranchIds.push(first.data.id);
    createdCashLedgerIds.push(first.data.cashLedgerId);

    const key2 = await newIdempotencyKey(superAdmin.userId, "branch:create");
    await expect(
      branchService.createBranch({ name: `Test Dup B ${randomUUID()}`, code, stateCode: "24" }, superAdmin, key2),
    ).rejects.toMatchObject({ code: "BRANCH_CODE_ALREADY_EXISTS" });
  });

  it("returns 404 for a non-existent branch", async () => {
    await expect(branchService.getBranch(randomUUID(), superAdmin)).rejects.toMatchObject({ code: "BRANCH_NOT_FOUND" });
  });

  it("lets a super admin get any branch", async () => {
    const branch = await branchService.getBranch(memberBranchId, superAdmin);
    expect(branch.id).toBe(memberBranchId);
  });

  it("lets a member employee get a branch they belong to", async () => {
    const branch = await branchService.getBranch(memberBranchId, memberEmployee);
    expect(branch.id).toBe(memberBranchId);
  });

  it("rejects a non-member employee from getting a branch they don't belong to", async () => {
    await expect(branchService.getBranch(memberBranchId, outsiderEmployee)).rejects.toMatchObject({
      code: "BRANCH_NOT_ALLOWED",
    });
  });

  it("lists all branches for a super admin", async () => {
    const result = await branchService.listBranches({ page: 1, limit: 100 }, superAdmin);
    expect(result.items.some((b) => b.id === memberBranchId)).toBe(true);
  });

  it("scopes the branch list to user_branches for a non-super-admin", async () => {
    const memberResult = await branchService.listBranches({ page: 1, limit: 100 }, memberEmployee);
    expect(memberResult.items.map((b) => b.id)).toContain(memberBranchId);

    const outsiderResult = await branchService.listBranches({ page: 1, limit: 100 }, outsiderEmployee);
    expect(outsiderResult.items.map((b) => b.id)).not.toContain(memberBranchId);
    expect(outsiderResult.total).toBe(0);
  });

  it("updates a branch and audits the diff", async () => {
    const createKey = await newIdempotencyKey(superAdmin.userId, "branch:create");
    const created = (await branchService.createBranch(
      { name: `Test Update ${randomUUID()}`, code: `UPD${randomUUID().slice(0, 6)}`, stateCode: "24" },
      superAdmin,
      createKey,
    )) as CreatedBranch;
    createdBranchIds.push(created.data.id);
    createdCashLedgerIds.push(created.data.cashLedgerId);

    const updateKey = await newIdempotencyKey(superAdmin.userId, "branch:update");
    await branchService.updateBranch(created.data.id, { phone: "9999999999" }, superAdmin, updateKey);

    const updated = await prisma.branch.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(updated.phone).toBe("9999999999");

    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "branch", entityId: created.data.id, action: "update" },
    });
    const after = auditRow.after as Record<string, unknown>;
    expect(after["phone"]).toBe("9999999999");
  });

  it("deactivates a branch (is_active = false) without soft-deleting it", async () => {
    const createKey = await newIdempotencyKey(superAdmin.userId, "branch:create");
    const created = (await branchService.createBranch(
      { name: `Test Deactivate ${randomUUID()}`, code: `DEA${randomUUID().slice(0, 6)}`, stateCode: "24" },
      superAdmin,
      createKey,
    )) as CreatedBranch;
    createdBranchIds.push(created.data.id);
    createdCashLedgerIds.push(created.data.cashLedgerId);

    const deactivateKey = await newIdempotencyKey(superAdmin.userId, "branch:deactivate");
    await branchService.deactivateBranch(created.data.id, superAdmin, deactivateKey);

    const after = await prisma.branch.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(after.isActive).toBe(false);
    expect(after.deletedAt).toBeNull();
  });
});
