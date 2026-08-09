import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import { NotFoundError } from "../../shared/errors.js";
import * as ledgerService from "./ledger.service.js";
import type { LedgerStatementActor } from "./ledger.service.js";

// TDD §22.1: service-layer tests run against the real dev DB, no mocks. Mirrors
// payment.service.test.ts's fixture/cleanup structure.

let branchAId: string;
let branchBId: string;
let userId: string;
let restrictedActor: LedgerStatementActor; // has user_branches membership in branchA only
let superAdminActor: LedgerStatementActor;

let ledgerAId: string; // branchId = branchA, statement/range/hand-calc fixture
let ledgerWrongBranchId: string; // branchId = branchB — restrictedActor has no membership here
let ledgerSharedId: string; // branchId = null — visible regardless of branch membership
let ledgerTieId: string; // dedicated tie-break fixture, isolated dates from ledgerA

const createdBranchIds: string[] = [];
const createdLedgerIds: string[] = [];

const OPENING_BALANCE = 1_000n;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      username: `ledgertest_${randomUUID()}`,
      passwordHash: "unused",
      name: "Ledger Statement Test User",
      role: "accountant",
      isActive: true,
      mustChangePassword: false,
    },
  });
  userId = user.id;
  restrictedActor = { userId, role: "accountant" };
  superAdminActor = { userId, role: "super_admin" };

  const branchA = await prisma.branch.create({
    data: { name: `Ledger Test Branch A ${randomUUID()}`, code: `LA${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  branchAId = branchA.id;
  createdBranchIds.push(branchAId);

  const branchB = await prisma.branch.create({
    data: { name: `Ledger Test Branch B ${randomUUID()}`, code: `LB${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  branchBId = branchB.id;
  createdBranchIds.push(branchBId);

  // restrictedActor is only a member of branchA — proves the object-level branch check, not the
  // acting-branch model branchContext would otherwise apply.
  await prisma.userBranch.create({ data: { userId, branchId: branchAId } });

  const cashGroup = await prisma.accountGroup.findFirstOrThrow({ where: { name: "Cash-in-Hand", deletedAt: null } });

  const ledgerA = await prisma.ledger.create({
    data: { name: `Statement Test Ledger A ${randomUUID()}`, accountGroupId: cashGroup.id, branchId: branchAId, openingBalance: OPENING_BALANCE },
  });
  ledgerAId = ledgerA.id;
  createdLedgerIds.push(ledgerAId);

  const ledgerWrongBranch = await prisma.ledger.create({
    data: { name: `Statement Test Ledger WrongBranch ${randomUUID()}`, accountGroupId: cashGroup.id, branchId: branchBId },
  });
  ledgerWrongBranchId = ledgerWrongBranch.id;
  createdLedgerIds.push(ledgerWrongBranchId);

  const ledgerShared = await prisma.ledger.create({
    data: { name: `Statement Test Ledger Shared ${randomUUID()}`, accountGroupId: cashGroup.id },
  });
  ledgerSharedId = ledgerShared.id;
  createdLedgerIds.push(ledgerSharedId);

  const ledgerTie = await prisma.ledger.create({
    data: { name: `Statement Test Ledger Tie ${randomUUID()}`, accountGroupId: cashGroup.id, branchId: branchAId },
  });
  ledgerTieId = ledgerTie.id;
  createdLedgerIds.push(ledgerTieId);

  // ledgerA: three distinct voucher_dates, distinct created_at — clean, unambiguous ordering for
  // the hand-calculated running-balance and [from,to]-range tests.
  const post = (ledgerId: string, voucherDate: string, amount: bigint, createdAt: Date) =>
    prisma.ledgerPosting.create({
      data: { ledgerId, branchId: branchAId, amount, voucherType: "receipt", voucherId: randomUUID(), voucherDate: new Date(voucherDate), createdAt },
    });

  await post(ledgerAId, "2026-01-01", 10_000n, new Date("2026-01-01T10:00:00Z"));
  await post(ledgerAId, "2026-01-05", -3_000n, new Date("2026-01-05T10:00:00Z"));
  await post(ledgerAId, "2026-01-10", 5_000n, new Date("2026-01-10T10:00:00Z"));

  // ledgerTie group A — same voucher_date, DIFFERENT created_at (created_at breaks the tie).
  await post(ledgerTieId, "2026-02-01", 500n, new Date("2026-02-01T09:00:00.000Z"));
  await post(ledgerTieId, "2026-02-01", 300n, new Date("2026-02-01T09:00:02.000Z"));

  // ledgerTie group B — same voucher_date AND same created_at (id is the only remaining
  // tiebreaker) — deliberately constructed, not left to chance.
  const sameInstant = new Date("2026-02-05T09:00:00.000Z");
  await post(ledgerTieId, "2026-02-05", 50n, sameInstant);
  await post(ledgerTieId, "2026-02-05", 20n, sameInstant);
}, 30_000);

afterAll(async () => {
  if (!userId) return;
  await prisma.ledgerPosting.deleteMany({ where: { ledgerId: { in: createdLedgerIds } } });
  await prisma.ledger.deleteMany({ where: { id: { in: createdLedgerIds } } });
  await prisma.userBranch.deleteMany({ where: { userId } });
  await prisma.branch.deleteMany({ where: { id: { in: createdBranchIds } } });
  await prisma.user.delete({ where: { id: userId } });
}, 30_000);

describe("getLedgerStatement — running balance (TDD §33)", () => {
  it("computes the running balance at each row by hand-calculation, no range supplied", async () => {
    const result = await ledgerService.getLedgerStatement(ledgerAId, {}, superAdminActor);

    expect(result.baseBalance).toBe(OPENING_BALANCE);
    expect(result.rows).toHaveLength(3);

    // opening 1000 -> +10000 -> 11000 -> -3000 -> 8000 -> +5000 -> 13000
    expect(result.rows[0]?.amount).toBe(10_000n);
    expect(result.rows[0]?.runningBalance).toBe(11_000n);
    expect(result.rows[1]?.amount).toBe(-3_000n);
    expect(result.rows[1]?.runningBalance).toBe(8_000n);
    expect(result.rows[2]?.amount).toBe(5_000n);
    expect(result.rows[2]?.runningBalance).toBe(13_000n);
  });

  it("folds everything before `from` into baseBalance and excludes postings outside [from, to]", async () => {
    const result = await ledgerService.getLedgerStatement(
      ledgerAId,
      { from: new Date("2026-01-03"), to: new Date("2026-01-10") },
      superAdminActor,
    );

    // base = opening (1000) + the Jan-1 posting (10000), which is strictly before `from`.
    expect(result.baseBalance).toBe(11_000n);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.voucherDate.toISOString().slice(0, 10))).toEqual(["2026-01-05", "2026-01-10"]);
    expect(result.rows[0]?.runningBalance).toBe(8_000n);
    expect(result.rows[1]?.runningBalance).toBe(13_000n);
  });

  it("with no `from`, base is opening_balance directly and every posting is included", async () => {
    const result = await ledgerService.getLedgerStatement(ledgerAId, { to: new Date("2026-01-05") }, superAdminActor);
    expect(result.baseBalance).toBe(OPENING_BALANCE);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]?.runningBalance).toBe(8_000n);
  });

  it("tie-breaks same-voucher_date postings by created_at", async () => {
    const result = await ledgerService.getLedgerStatement(
      ledgerTieId,
      { from: new Date("2026-02-01"), to: new Date("2026-02-01") },
      superAdminActor,
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.amount).toBe(500n);
    expect(result.rows[0]?.runningBalance).toBe(500n);
    expect(result.rows[1]?.amount).toBe(300n);
    expect(result.rows[1]?.runningBalance).toBe(800n);
  });

  it("tie-breaks same-voucher_date AND same-created_at postings by id, deterministically", async () => {
    const result = await ledgerService.getLedgerStatement(
      ledgerTieId,
      { from: new Date("2026-02-05"), to: new Date("2026-02-05") },
      superAdminActor,
    );
    expect(result.rows).toHaveLength(2);

    // id is the only remaining tiebreaker — sort the same two rows by id ourselves and confirm
    // the query's own order agrees, rather than assuming which specific row wins.
    const byId = [...result.rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(result.rows.map((r) => r.id)).toEqual(byId.map((r) => r.id));

    // Starts from result.baseBalance, not 0n — ledgerTie also carries the earlier group-A
    // postings (2026-02-01), which this ranged query correctly folds into baseBalance since
    // they're strictly before `from` (2026-02-05).
    let running = result.baseBalance;
    for (const row of result.rows) {
      running += row.amount;
      expect(row.runningBalance).toBe(running);
    }
    expect(running).toBe(result.baseBalance + 70n);

    // Re-running the identical query reproduces the identical order — not a per-call fluke.
    const again = await ledgerService.getLedgerStatement(
      ledgerTieId,
      { from: new Date("2026-02-05"), to: new Date("2026-02-05") },
      superAdminActor,
    );
    expect(again.rows.map((r) => r.id)).toEqual(result.rows.map((r) => r.id));
  });
});

describe("getLedgerStatement — branch access (object-level check, not branchContext)", () => {
  it("throws NotFoundError for a ledger that doesn't exist", async () => {
    await expect(ledgerService.getLedgerStatement(randomUUID(), {}, restrictedActor)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("allows a non-super-admin actor to view a ledger in a branch they belong to", async () => {
    await expect(ledgerService.getLedgerStatement(ledgerAId, {}, restrictedActor)).resolves.toBeDefined();
  });

  it("rejects a non-super-admin actor viewing a ledger in a branch they don't belong to", async () => {
    await expect(ledgerService.getLedgerStatement(ledgerWrongBranchId, {}, restrictedActor)).rejects.toMatchObject({
      code: "BRANCH_NOT_ALLOWED",
    });
  });

  it("super_admin bypasses the branch check entirely", async () => {
    await expect(ledgerService.getLedgerStatement(ledgerWrongBranchId, {}, superAdminActor)).resolves.toBeDefined();
  });

  it("a shared ledger (branch_id null) is visible regardless of branch membership", async () => {
    await expect(ledgerService.getLedgerStatement(ledgerSharedId, {}, restrictedActor)).resolves.toBeDefined();
  });
});
