import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import * as partyService from "../parties/party.service.js";
import * as saleService from "../sales/sale.service.js";
import * as purchaseService from "../purchases/purchase.service.js";
import * as paymentService from "../payments/payment.service.js";
import * as dayCloseService from "./day-close.service.js";
import type { DayCloseActor } from "./day-close.service.js";
import { reopenDaySchema } from "./day-close.validation.js";

// TDD §22.1: service-layer tests run against the real dev DB, no mocks — the advisory lock, the
// ledger_postings-sourced sum, and the retroactive guard on confirmSale/confirmPurchase/
// confirmPayment are exactly the things under test here. Mirrors payment.service.test.ts's
// structure. Every scenario below gets its OWN fresh branch (setupBranch) — day_closes is a
// per-branch state machine, and several scenarios specifically depend on "no prior day_closes row
// exists yet," which only holds if branches are never shared across tests.

let cashGroupId: string;
let unitId: string;
let productId: string;
let userId: string;

const createdBranchIds: string[] = [];
const createdLedgerIds: string[] = [];
const createdPartyIds: string[] = [];
const createdIdempotencyKeys: string[] = [];
const createdSaleIds: string[] = [];
const createdPurchaseIds: string[] = [];
const createdPaymentIds: string[] = [];

// One fixed base date + a monotonically increasing day offset per test, so every test's dates are
// disjoint from every other test's — ledger_postings/day_closes are summed per (branch, date), and
// branches are already disjoint per setupBranch, but keeping dates disjoint too removes any chance
// of a within-branch cross-test date collision if a future edit ever reuses a branch.
const BASE_DATE = Date.UTC(2026, 4, 1); // 2026-05-01
let dayCounter = 0;
function nextDay(): Date {
  const d = new Date(BASE_DATE + dayCounter * 86_400_000);
  dayCounter += 1;
  return d;
}
function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * 86_400_000);
}

async function newIdempotencyKey(scope: string): Promise<string> {
  const key = randomUUID();
  await prisma.idempotencyKey.create({
    data: { key, userId, scope, requestHash: "test", status: "in_progress", expiresAt: new Date(Date.now() + 60_000) },
  });
  createdIdempotencyKeys.push(key);
  return key;
}

// 5% GST, exclusive, unitRate a multiple of 20 so the tax is an exact integer and round_off is
// always 0 — same convention as payment.service.test.ts's grandTotalFor.
function grandTotalFor(unitRate: number): number {
  return unitRate + Math.round(unitRate * 0.05);
}

interface BranchCtx {
  branchId: string;
  cashLedgerId: string;
  customerId: string;
  supplierId: string;
  actor: DayCloseActor;
}

// Fresh branch + cash ledger + branch_stock (shared product) + one customer + one supplier, per
// test. account groups/unit/product are global masters, created once in beforeAll and reused.
async function setupBranch(label: string): Promise<BranchCtx> {
  const branch = await prisma.branch.create({
    data: { name: `DayClose ${label} ${randomUUID()}`, code: `DC${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  createdBranchIds.push(branch.id);

  const cashLedger = await prisma.ledger.create({
    data: { name: `DC Cash ${randomUUID()}`, accountGroupId: cashGroupId, branchId: branch.id, createdBy: userId, updatedBy: userId },
  });
  createdLedgerIds.push(cashLedger.id);
  await prisma.branch.update({ where: { id: branch.id }, data: { cashLedgerId: cashLedger.id } });

  await prisma.branchStock.create({ data: { branchId: branch.id, productId, quantity: 100_000, avgCost: 6_000n } });

  const actor: DayCloseActor = { userId, role: "admin", branchId: branch.id };

  const customer = (await partyService.createParty(
    { type: "customer", name: `DC Cust ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
    actor,
    await newIdempotencyKey("party:create"),
  )) as { data: { id: string; ledgerId: string } };
  createdPartyIds.push(customer.data.id);
  createdLedgerIds.push(customer.data.ledgerId);

  const supplier = (await partyService.createParty(
    { type: "supplier", name: `DC Supp ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
    actor,
    await newIdempotencyKey("party:create"),
  )) as { data: { id: string; ledgerId: string } };
  createdPartyIds.push(supplier.data.id);
  createdLedgerIds.push(supplier.data.ledgerId);

  return { branchId: branch.id, cashLedgerId: cashLedger.id, customerId: customer.data.id, supplierId: supplier.data.id, actor };
}

async function makeSale(
  b: BranchCtx,
  voucherDate: Date,
  unitRate: number,
  paidCash: number,
): Promise<{ id: string; grandTotal: number }> {
  const grandTotal = grandTotalFor(unitRate);
  const key = await newIdempotencyKey("sale:confirm");
  const response = (await saleService.confirmSale(
    {
      customerId: b.customerId,
      voucherDate,
      lines: [{ productId, unitRate, billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
      paidCash,
      paidBank: 0,
      creditUdhar: grandTotal - paidCash,
    },
    b.actor,
    key,
  )) as { data: { id: string } };
  createdSaleIds.push(response.data.id);
  return { id: response.data.id, grandTotal };
}

async function makePurchase(b: BranchCtx, voucherDate: Date, unitRate: number, paidCash: number): Promise<{ id: string; grandTotal: number }> {
  const grandTotal = grandTotalFor(unitRate);
  const key = await newIdempotencyKey("purchase:confirm");
  const response = (await purchaseService.confirmPurchase(
    {
      supplierId: b.supplierId,
      voucherDate,
      lines: [{ productId, unitRate, billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
      paidCash,
      paidBank: 0,
      creditToSupplier: grandTotal - paidCash,
    },
    b.actor,
    key,
  )) as { data: { id: string } };
  createdPurchaseIds.push(response.data.id);
  return { id: response.data.id, grandTotal };
}

async function makeReceipt(b: BranchCtx, voucherDate: Date, amount: number): Promise<string> {
  const key = await newIdempotencyKey("payment:confirm");
  const response = (await paymentService.confirmPayment(
    { direction: "receipt", voucherDate, cashBankLedgerId: b.cashLedgerId, partyId: b.customerId, amount },
    b.actor,
    key,
  )) as { data: { id: string } };
  createdPaymentIds.push(response.data.id);
  return response.data.id;
}

async function makePayment(b: BranchCtx, voucherDate: Date, amount: number): Promise<string> {
  const key = await newIdempotencyKey("payment:confirm");
  const response = (await paymentService.confirmPayment(
    { direction: "payment", voucherDate, cashBankLedgerId: b.cashLedgerId, partyId: b.supplierId, amount },
    b.actor,
    key,
  )) as { data: { id: string } };
  createdPaymentIds.push(response.data.id);
  return response.data.id;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      username: `dayclosetest_${randomUUID()}`,
      passwordHash: "unused",
      name: "Day Close Test User",
      role: "admin",
      isActive: true,
      mustChangePassword: false,
    },
  });
  userId = user.id;

  const cashGroup = await prisma.accountGroup.findFirstOrThrow({ where: { name: "Cash-in-Hand", deletedAt: null } });
  cashGroupId = cashGroup.id;

  const unit = await prisma.unit.create({ data: { name: `DC Kilogram ${randomUUID()}`, symbol: "kg" } });
  unitId = unit.id;

  const product = await prisma.product.create({
    data: { name: `DC Product ${randomUUID()}`, hsnCode: "31051000", unitId, gstRate: 5, taxClassification: "taxable" },
  });
  productId = product.id;
}, 30_000);

afterEach(async () => {
  if (createdIdempotencyKeys.length) {
    await prisma.idempotencyKey.deleteMany({ where: { key: { in: createdIdempotencyKeys } } });
    createdIdempotencyKeys.length = 0;
  }
});

afterAll(async () => {
  if (!userId) return;

  await prisma.ledgerPosting.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.stockMovement.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: createdPaymentIds } } });
  await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } });
  await prisma.saleLineItem.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.sale.deleteMany({ where: { id: { in: createdSaleIds } } });
  await prisma.purchaseLineItem.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.purchase.deleteMany({ where: { id: { in: createdPurchaseIds } } });
  await prisma.dayClose.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.numberSeries.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.branchStock.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.party.deleteMany({ where: { id: { in: createdPartyIds } } });
  await prisma.branch.deleteMany({ where: { id: { in: createdBranchIds } } });
  await prisma.ledger.deleteMany({ where: { id: { in: createdLedgerIds } } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.unit.deleteMany({ where: { id: unitId } });
  await prisma.auditLog.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });

  const leftover = await prisma.dayClose.count({ where: { branchId: { in: createdBranchIds } } });
  if (leftover > 0) {
    throw new Error("day-close.service.test.ts left day_closes rows behind — cleanup did not fully succeed");
  }
}, 30_000);

describe("closeDay — expected_closing_cash from real ledger_postings (TDD §35.2/§35.6)", () => {
  it("computes expected_closing_cash from a mixed day (sale + purchase + receipt + payment cash legs) and short_over correctly", async () => {
    const b = await setupBranch("Mixed");
    const D = nextDay();

    const sale = await makeSale(b, D, 2000, 1000); // Dr Cash +1000
    const purchase = await makePurchase(b, D, 2000, 500); // Cr Cash -500
    await makeReceipt(b, D, 300); // Dr Cash +300
    await makePayment(b, D, 200); // Cr Cash -200
    void sale;
    void purchase;

    const openingCash = 100_000;
    const cashDelta = 1000 - 500 + 300 - 200; // = 600
    const expected = openingCash + cashDelta;
    const actualCountedCash = expected - 250; // deliberate short by 250

    const key = await newIdempotencyKey("day-close:close");
    const response = (await dayCloseService.closeDay(
      { closeDate: D, actualCountedCash, openingCash, note: "hand-verified mixed day" },
      b.actor,
      key,
    )) as { data: { openingCash: number; expectedClosingCash: number; actualCountedCash: number; shortOver: number; status: string } };

    expect(response.data.status).toBe("closed");
    expect(response.data.openingCash).toBe(openingCash);
    expect(response.data.expectedClosingCash).toBe(expected);
    expect(response.data.actualCountedCash).toBe(actualCountedCash);
    expect(response.data.shortOver).toBe(-250);
  });

  it("requires a manually-supplied opening_cash for a branch's very first-ever close, and stores it exactly when supplied", async () => {
    const b = await setupBranch("FirstClose");
    const D = nextDay();

    const key1 = await newIdempotencyKey("day-close:close");
    await expect(
      dayCloseService.closeDay({ closeDate: D, actualCountedCash: 50_000 }, b.actor, key1),
    ).rejects.toMatchObject({ code: "OPENING_CASH_REQUIRED_FOR_FIRST_CLOSE" });

    const key2 = await newIdempotencyKey("day-close:close");
    const response = (await dayCloseService.closeDay(
      { closeDate: D, actualCountedCash: 50_000, openingCash: 50_000 },
      b.actor,
      key2,
    )) as { data: { openingCash: number; expectedClosingCash: number; shortOver: number } };

    expect(response.data.openingCash).toBe(50_000);
    expect(response.data.expectedClosingCash).toBe(50_000); // no postings that day
    expect(response.data.shortOver).toBe(0);
  });

  it("sources opening_cash from the previous CLOSED day's actual_counted_cash, not its expected_closing_cash — a deliberate day-1 shortfall carries forward", async () => {
    const b = await setupBranch("OpeningCashChain");
    const day1 = nextDay();
    const day2 = addDays(day1, 1);

    // Day 1: opening 100000, no postings that day, expected = 100000, but the operator counts
    // 99000 — a deliberate 1000-paise shortfall.
    const key1 = await newIdempotencyKey("day-close:close");
    const day1Response = (await dayCloseService.closeDay(
      { closeDate: day1, actualCountedCash: 99_000, openingCash: 100_000 },
      b.actor,
      key1,
    )) as { data: { expectedClosingCash: number; actualCountedCash: number; shortOver: number } };
    expect(day1Response.data.expectedClosingCash).toBe(100_000);
    expect(day1Response.data.shortOver).toBe(-1000);

    // Day 2: a real cash sale of 400 lands on day 2. opening_cash must be day 1's
    // actual_counted_cash (99000), NOT its expected_closing_cash (100000) — otherwise the 1000
    // shortfall would be silently absorbed instead of carrying forward.
    await makeSale(b, day2, 2000, 400);
    const key2 = await newIdempotencyKey("day-close:close");
    const day2Response = (await dayCloseService.closeDay(
      { closeDate: day2, actualCountedCash: 99_400 },
      b.actor,
      key2,
    )) as { data: { openingCash: number; expectedClosingCash: number; shortOver: number } };

    expect(day2Response.data.openingCash).toBe(99_000);
    expect(day2Response.data.openingCash).not.toBe(100_000);
    expect(day2Response.data.expectedClosingCash).toBe(99_400);
    expect(day2Response.data.shortOver).toBe(0);
  });

  it("rejects a double-close attempt with DAY_ALREADY_CLOSED", async () => {
    const b = await setupBranch("DoubleClose");
    const D = nextDay();

    const key1 = await newIdempotencyKey("day-close:close");
    await dayCloseService.closeDay({ closeDate: D, actualCountedCash: 10_000, openingCash: 10_000 }, b.actor, key1);

    const key2 = await newIdempotencyKey("day-close:close");
    await expect(
      dayCloseService.closeDay({ closeDate: D, actualCountedCash: 10_000, openingCash: 10_000 }, b.actor, key2),
    ).rejects.toMatchObject({ code: "DAY_ALREADY_CLOSED" });
  });

  it("Iteration 5 forward-compat: an arbitrary, not-otherwise-used voucher_type posted to the cash ledger is still included in expected_closing_cash (the formula is voucher-type-agnostic)", async () => {
    const b = await setupBranch("ForwardCompat");
    const D = nextDay();

    // Simulates a future contra voucher — a voucher_type this session's code never writes.
    await prisma.ledgerPosting.create({
      data: {
        ledgerId: b.cashLedgerId,
        branchId: b.branchId,
        amount: 555n,
        voucherType: "contra",
        voucherId: randomUUID(),
        voucherDate: D,
        createdBy: userId,
      },
    });

    const key = await newIdempotencyKey("day-close:close");
    const response = (await dayCloseService.closeDay(
      { closeDate: D, actualCountedCash: 10_555, openingCash: 10_000 },
      b.actor,
      key,
    )) as { data: { expectedClosingCash: number; shortOver: number; breakdown: { voucherType: string; total: number }[] } };

    expect(response.data.expectedClosingCash).toBe(10_555);
    expect(response.data.shortOver).toBe(0);
    expect(response.data.breakdown).toContainEqual({ voucherType: "contra", total: 555 });
  });
});

describe("reopenDay — TDD §35.6/§35.7/§35.8", () => {
  it("reopenDaySchema requires a non-empty reason", () => {
    const result = reopenDaySchema.safeParse({ closeDate: new Date("2026-05-01") });
    expect(result.success).toBe(false);
  });

  it("rejects reopening a day that was never closed", async () => {
    const b = await setupBranch("ReopenNeverClosed");
    const D = nextDay();

    await expect(
      dayCloseService.reopenDay({ closeDate: D, reason: "test" }, b.actor, await newIdempotencyKey("day-close:reopen")),
    ).rejects.toMatchObject({ code: "DAY_CLOSE_NOT_FOUND" });
  });

  it("succeeds with a mandatory reason, and a reclose after reopen recomputes and re-closes correctly", async () => {
    const b = await setupBranch("ReopenReclose");
    const D = nextDay();

    await dayCloseService.closeDay(
      { closeDate: D, actualCountedCash: 10_000, openingCash: 10_000 },
      b.actor,
      await newIdempotencyKey("day-close:close"),
    );

    const reopenResponse = (await dayCloseService.reopenDay(
      { closeDate: D, reason: "counted cash again, need to correct" },
      b.actor,
      await newIdempotencyKey("day-close:reopen"),
    )) as { data: { status: string; reopenReason: string | null; reopenedAt: string | null } };
    expect(reopenResponse.data.status).toBe("reopened");
    expect(reopenResponse.data.reopenReason).toBe("counted cash again, need to correct");
    expect(reopenResponse.data.reopenedAt).toBeTruthy();

    // Reclose: recomputes fresh (a new sale landed while reopened) and clears the reopen trail.
    // Deliberately NOT re-supplying openingCash — D is still this branch's first-ever close date
    // (no prior CLOSED day exists before it), but a reclose is not a new "first call" (§35.3): the
    // already-pinned opening_cash on the existing row must be reused, not re-demanded.
    await makeSale(b, D, 2000, 250);
    const recloseResponse = (await dayCloseService.closeDay(
      { closeDate: D, actualCountedCash: 10_250 },
      b.actor,
      await newIdempotencyKey("day-close:close"),
    )) as {
      data: { status: string; openingCash: number; expectedClosingCash: number; reopenReason: string | null; reopenedAt: string | null };
    };
    expect(recloseResponse.data.status).toBe("closed");
    expect(recloseResponse.data.openingCash).toBe(10_000); // still no prior CLOSED day before D
    expect(recloseResponse.data.expectedClosingCash).toBe(10_250);
    expect(recloseResponse.data.reopenReason).toBeNull();
    expect(recloseResponse.data.reopenedAt).toBeNull();

    // Now genuinely closed again — a further close attempt is rejected.
    await expect(
      dayCloseService.closeDay({ closeDate: D, actualCountedCash: 10_250 }, b.actor, await newIdempotencyKey("day-close:close")),
    ).rejects.toMatchObject({ code: "DAY_ALREADY_CLOSED" });
  });

  it("the GST-filed-period reopen guard is present and runs (proven by direct invocation, not by its absence) — currently vacuously permissive since no filed-period state exists until Iteration 6", async () => {
    await expect(
      dayCloseService.assertGstPeriodNotFiled(prisma as never, randomUUID(), new Date("2026-05-01")),
    ).resolves.toBeUndefined();
  });
});

describe("retroactive block — confirmSale/confirmPurchase/confirmPayment on a closed day (TDD §35.4, blanket scope)", () => {
  it("blocks a NEW sale, purchase, and receipt/payment dated on or before a closed day — including a pure-udhar sale with no cash involvement", async () => {
    const b = await setupBranch("RetroBlock");
    const closedDate = nextDay();
    const beforeClosedDate = addDays(closedDate, -1);
    const afterClosedDate = addDays(closedDate, 1);

    await dayCloseService.closeDay(
      { closeDate: closedDate, actualCountedCash: 10_000, openingCash: 10_000 },
      b.actor,
      await newIdempotencyKey("day-close:close"),
    );

    // ON the closed day.
    await expect(makeSale(b, closedDate, 2000, 1000)).rejects.toMatchObject({ code: "VOUCHER_DATE_LOCKED_BY_DAY_CLOSE" });
    await expect(makePurchase(b, closedDate, 2000, 1000)).rejects.toMatchObject({ code: "VOUCHER_DATE_LOCKED_BY_DAY_CLOSE" });
    await expect(makeReceipt(b, closedDate, 500)).rejects.toMatchObject({ code: "VOUCHER_DATE_LOCKED_BY_DAY_CLOSE" });

    // BEFORE the closed day ("on or before").
    await expect(makeSale(b, beforeClosedDate, 2000, 1000)).rejects.toMatchObject({ code: "VOUCHER_DATE_LOCKED_BY_DAY_CLOSE" });

    // Pure udhar — zero cash involvement — still blocked (blanket scope, not narrowed to
    // cash-touching vouchers).
    const grandTotal = grandTotalFor(2000);
    await expect(
      saleService.confirmSale(
        {
          customerId: b.customerId,
          voucherDate: closedDate,
          lines: [{ productId, unitRate: 2000, billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: 0,
          paidBank: 0,
          creditUdhar: grandTotal,
        },
        b.actor,
        await newIdempotencyKey("sale:confirm"),
      ),
    ).rejects.toMatchObject({ code: "VOUCHER_DATE_LOCKED_BY_DAY_CLOSE" });

    // Positive control — AFTER the closed day is unaffected.
    const afterSale = await makeSale(b, afterClosedDate, 2000, 1000);
    expect(afterSale.id).toBeTruthy();
  });
});

describe("editSale / cancelSale — still correctly blocked on a closed day (regression, TDD §20)", () => {
  it("blocks editSale and cancelSale on a sale dated on a now-closed day", async () => {
    const b = await setupBranch("EditCancelRegression");
    const D = nextDay();

    const sale = await makeSale(b, D, 2000, 1000);

    await dayCloseService.closeDay(
      { closeDate: D, actualCountedCash: 10_000, openingCash: 10_000 },
      b.actor,
      await newIdempotencyKey("day-close:close"),
    );

    await expect(
      saleService.editSale(
        sale.id,
        { customerId: b.customerId, lines: [{ productId, unitRate: 2100, billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }] },
        b.actor,
        await newIdempotencyKey("sale:edit"),
      ),
    ).rejects.toMatchObject({ code: "VOUCHER_DATE_LOCKED_BY_DAY_CLOSE" });

    await expect(
      saleService.cancelSale(sale.id, { cancelReason: "test" }, b.actor, await newIdempotencyKey("sale:cancel")),
    ).rejects.toMatchObject({ code: "VOUCHER_DATE_LOCKED_BY_DAY_CLOSE" });
  });
});

describe("concurrency — the advisory lock genuinely serializes closeDay against a concurrent confirmSale for the same (branch, date) (TDD §35.5)", () => {
  it("never produces a silently-inconsistent outcome: either the sale lands and is reflected in expected_closing_cash, or the sale is blocked because the day closed first", async () => {
    const b = await setupBranch("Concurrency");
    const D = nextDay();
    const cashPaid = 777;
    const grandTotal = grandTotalFor(2000);

    const closeKey = await newIdempotencyKey("day-close:close");
    const saleKey = await newIdempotencyKey("sale:confirm");

    const [closeSettled, saleSettled] = await Promise.allSettled([
      dayCloseService.closeDay({ closeDate: D, actualCountedCash: 50_000, openingCash: 50_000 }, b.actor, closeKey),
      saleService.confirmSale(
        {
          customerId: b.customerId,
          voucherDate: D,
          lines: [{ productId, unitRate: 2000, billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: cashPaid,
          paidBank: 0,
          creditUdhar: grandTotal - cashPaid,
        },
        b.actor,
        saleKey,
      ),
    ]);

    // closeDay is always the first close for this date, and nothing blocks it regardless of race
    // order — it must always succeed.
    expect(closeSettled.status).toBe("fulfilled");
    if (closeSettled.status !== "fulfilled") throw new Error("unreachable");
    const closeData = (closeSettled.value as { data: { expectedClosingCash: number } }).data;

    if (saleSettled.status === "fulfilled") {
      const saleId = (saleSettled.value as { data: { id: string } }).data.id;
      createdSaleIds.push(saleId);
      // The sale's transaction won the lock first and committed before closeDay's expected-cash
      // query ran — it MUST be reflected, not silently dropped.
      expect(closeData.expectedClosingCash).toBe(50_000 + cashPaid);
    } else {
      // closeDay won the lock first and closed the day before the sale's transaction acquired the
      // lock — the sale is correctly blocked, not silently allowed to drift the closed figure.
      expect((saleSettled.reason as { code?: string }).code).toBe("VOUCHER_DATE_LOCKED_BY_DAY_CLOSE");
      expect(closeData.expectedClosingCash).toBe(50_000);
    }
  });
});
