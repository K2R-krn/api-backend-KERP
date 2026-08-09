import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import * as partyService from "./../parties/party.service.js";
import * as saleService from "./../sales/sale.service.js";
import * as purchaseService from "./../purchases/purchase.service.js";
import * as paymentService from "./payment.service.js";
import type { PaymentActor } from "./payment.service.js";
import type { AllocationInput } from "./payment.validation.js";

// TDD §22.1: service-layer tests run against the real dev DB, no mocks — the row locks, the
// posting math, and the allocation guards are exactly the things under test here. Mirrors
// sale.service.test.ts / purchase.service.test.ts's structure.

interface PaymentAllocationRow {
  id: string;
  saleId: string | null;
  purchaseId: string | null;
  amount: number;
}

interface PaymentData {
  id: string;
  status: string;
  direction: string;
  voucherNumber: string | null;
  amount: number;
  partyId: string | null;
  counterLedgerId: string | null;
  cashBankLedgerId: string;
  allocations: PaymentAllocationRow[];
}

interface PaymentResponse {
  data: PaymentData;
}

let branchId: string;
let branchCashLedgerId: string;
let bankLedgerId: string;
let expenseLedgerId: string;
let unitId: string;
let productId: string;
let actor: PaymentActor;

let customerId: string;
let customerLedgerId: string;
let supplierId: string;
let supplierLedgerId: string;

let wrongBranchId: string;
let wrongBranchActor: PaymentActor;
let wrongBranchCustomerId: string;

const createdBranchIds: string[] = [];
const createdCashLedgerIds: string[] = [];
const createdOtherLedgerIds: string[] = [];
const createdPartyIds: string[] = [];
const createdProductIds: string[] = [];
const createdUnitIds: string[] = [];
const createdIdempotencyKeys: string[] = [];
const createdSaleIds: string[] = [];
const createdPurchaseIds: string[] = [];
const createdPaymentIds: string[] = [];

const VOUCHER_DATE = new Date("2026-06-15");

async function newIdempotencyKey(scope: string): Promise<string> {
  const key = randomUUID();
  await prisma.idempotencyKey.create({
    data: { key, userId: actor.userId, scope, requestHash: "test", status: "in_progress", expiresAt: new Date(Date.now() + 60_000) },
  });
  createdIdempotencyKeys.push(key);
  return key;
}

async function assertPostingsSumToZero(voucherType: string, voucherId: string) {
  const postings = await prisma.ledgerPosting.findMany({ where: { voucherType, voucherId } });
  const sum = postings.reduce((acc, p) => acc + p.amount, 0n);
  expect(sum).toBe(0n);
  return postings;
}

async function ledgerBalance(ledgerId: string): Promise<bigint> {
  const postings = await prisma.ledgerPosting.findMany({ where: { ledgerId } });
  return postings.reduce((sum, p) => sum + p.amount, 0n);
}

// remainingBalance (TDD §32.4) takes no lock and does no guard-checking itself — tests call it
// through a bare $transaction, exactly the "reusable later for a read-only view" shape §32.4
// describes, distinct from confirmPayment's own caller-side lock+guards.
async function readRemainingBalance(target: { saleId: string } | { purchaseId: string }): Promise<bigint> {
  return prisma.$transaction((tx) => paymentService.remainingBalance(tx, target));
}

// 5% GST, exclusive, single line, no discount — unitRate always a multiple of 20 paise so the tax
// is an exact integer (no rounding ambiguity) and, combined with company_profile's whole-rupee
// amounts here, round_off is always 0 regardless of the live company_profile.rounding_mode.
function grandTotalFor(unitRate: number): number {
  return unitRate + Math.round(unitRate * 0.05);
}

async function makeSale(customerIdParam: string, unitRate: number, creditUdhar: number, actorParam: PaymentActor = actor) {
  const grandTotal = grandTotalFor(unitRate);
  const key = await newIdempotencyKey("sale:confirm");
  const response = (await saleService.confirmSale(
    {
      customerId: customerIdParam,
      voucherDate: VOUCHER_DATE,
      lines: [{ productId, unitRate, billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
      paidCash: grandTotal - creditUdhar,
      paidBank: 0,
      creditUdhar,
    },
    actorParam,
    key,
  )) as { data: { id: string } };
  createdSaleIds.push(response.data.id);
  return { id: response.data.id, grandTotal };
}

async function makePurchase(supplierIdParam: string, unitRate: number, creditToSupplier: number) {
  const grandTotal = grandTotalFor(unitRate);
  const key = await newIdempotencyKey("purchase:confirm");
  const response = (await purchaseService.confirmPurchase(
    {
      supplierId: supplierIdParam,
      voucherDate: VOUCHER_DATE,
      lines: [{ productId, unitRate, billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
      paidCash: grandTotal - creditToSupplier,
      paidBank: 0,
      creditToSupplier,
    },
    actor,
    key,
  )) as { data: { id: string } };
  createdPurchaseIds.push(response.data.id);
  return { id: response.data.id, grandTotal };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      username: `paymenttest_${randomUUID()}`,
      passwordHash: "unused",
      name: "Payment Service Test User",
      role: "admin",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const branch = await prisma.branch.create({
    data: { name: `Payment Test Branch ${randomUUID()}`, code: `PY${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  branchId = branch.id;
  createdBranchIds.push(branchId);
  actor = { userId: user.id, role: "admin", branchId };

  const cashGroup = await prisma.accountGroup.findFirstOrThrow({ where: { name: "Cash-in-Hand", deletedAt: null } });
  const cashLedger = await prisma.ledger.create({
    data: { name: `Test Cash ${randomUUID()}`, accountGroupId: cashGroup.id, branchId, createdBy: user.id, updatedBy: user.id },
  });
  branchCashLedgerId = cashLedger.id;
  createdCashLedgerIds.push(cashLedger.id);
  await prisma.branch.update({ where: { id: branchId }, data: { cashLedgerId: cashLedger.id } });

  const bankGroup = await prisma.accountGroup.findFirstOrThrow({ where: { name: "Bank Accounts", deletedAt: null } });
  const bankLedger = await prisma.ledger.create({
    data: { name: `Test Bank ${randomUUID()}`, accountGroupId: bankGroup.id, branchId, createdBy: user.id, updatedBy: user.id },
  });
  bankLedgerId = bankLedger.id;
  createdOtherLedgerIds.push(bankLedger.id);

  const expenseGroup = await prisma.accountGroup.findFirstOrThrow({ where: { name: "Direct/Indirect Expenses", deletedAt: null } });
  const expenseLedger = await prisma.ledger.create({
    data: { name: `Test Staff Tea ${randomUUID()}`, accountGroupId: expenseGroup.id, branchId, createdBy: user.id, updatedBy: user.id },
  });
  expenseLedgerId = expenseLedger.id;
  createdOtherLedgerIds.push(expenseLedger.id);

  const wrongBranch = await prisma.branch.create({
    data: { name: `Payment Wrong Branch ${randomUUID()}`, code: `PW${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  wrongBranchId = wrongBranch.id;
  createdBranchIds.push(wrongBranchId);
  wrongBranchActor = { userId: user.id, role: "admin", branchId: wrongBranchId };

  const unit = await prisma.unit.create({ data: { name: `Test Kilogram ${randomUUID()}`, symbol: "kg" } });
  unitId = unit.id;
  createdUnitIds.push(unitId);

  const product = await prisma.product.create({
    data: { name: `Test Payment Product ${randomUUID()}`, hsnCode: "31051000", unitId, gstRate: 5, taxClassification: "taxable" },
  });
  productId = product.id;
  createdProductIds.push(productId);

  await prisma.branchStock.create({ data: { branchId, productId, quantity: 100_000, avgCost: 6_000n } });
  await prisma.branchStock.create({ data: { branchId: wrongBranchId, productId, quantity: 100_000, avgCost: 6_000n } });

  const customer = (await partyService.createParty(
    { type: "customer", name: `Test Payment Customer ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
    { userId: actor.userId, role: actor.role, branchId },
    await newIdempotencyKey("party:create"),
  )) as { data: { id: string; ledgerId: string } };
  customerId = customer.data.id;
  customerLedgerId = customer.data.ledgerId;
  createdPartyIds.push(customerId);
  createdOtherLedgerIds.push(customerLedgerId);

  const supplier = (await partyService.createParty(
    { type: "supplier", name: `Test Payment Supplier ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
    { userId: actor.userId, role: actor.role, branchId },
    await newIdempotencyKey("party:create"),
  )) as { data: { id: string; ledgerId: string } };
  supplierId = supplier.data.id;
  supplierLedgerId = supplier.data.ledgerId;
  createdPartyIds.push(supplierId);
  createdOtherLedgerIds.push(supplierLedgerId);

  const wrongBranchCustomer = (await partyService.createParty(
    { type: "customer", name: `Test Wrong Branch Customer ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
    { userId: actor.userId, role: actor.role, branchId: wrongBranchId },
    await newIdempotencyKey("party:create"),
  )) as { data: { id: string; ledgerId: string } };
  wrongBranchCustomerId = wrongBranchCustomer.data.id;
  createdPartyIds.push(wrongBranchCustomerId);
  createdOtherLedgerIds.push(wrongBranchCustomer.data.ledgerId);
}, 30_000);

afterEach(async () => {
  if (createdIdempotencyKeys.length) {
    await prisma.idempotencyKey.deleteMany({ where: { key: { in: createdIdempotencyKeys } } });
    createdIdempotencyKeys.length = 0;
  }
});

afterAll(async () => {
  if (!actor) return;

  // Children-before-parents, matching the RESTRICT delete rules on the transaction schema's FKs.
  await prisma.ledgerPosting.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.stockMovement.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: createdPaymentIds } } });
  await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } });
  await prisma.saleLineItem.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.sale.deleteMany({ where: { id: { in: createdSaleIds } } });
  await prisma.purchaseLineItem.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.purchase.deleteMany({ where: { id: { in: createdPurchaseIds } } });
  await prisma.numberSeries.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.branchStock.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.party.deleteMany({ where: { id: { in: createdPartyIds } } });
  await prisma.branch.deleteMany({ where: { id: { in: createdBranchIds } } });
  await prisma.ledger.deleteMany({ where: { id: { in: [...createdCashLedgerIds, ...createdOtherLedgerIds] } } });
  await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await prisma.unit.deleteMany({ where: { id: { in: createdUnitIds } } });
  await prisma.auditLog.deleteMany({ where: { userId: actor.userId } });
  await prisma.user.delete({ where: { id: actor.userId } });

  const leftoverPayments = await prisma.payment.count({ where: { branchId: { in: createdBranchIds } } });
  if (leftoverPayments > 0) {
    throw new Error("payment.service.test.ts left payment rows behind — cleanup did not fully succeed");
  }
}, 30_000);

describe("confirmPayment — basic receipt/payment posting (TDD §31.3)", () => {
  it("posts a basic receipt against a party — money in, party ledger credited, cash ledger debited", async () => {
    const cashBefore = await ledgerBalance(branchCashLedgerId);
    const partyBefore = await ledgerBalance(customerLedgerId);

    const key = await newIdempotencyKey("payment:confirm");
    const response = (await paymentService.confirmPayment(
      { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: customerId, amount: 50_000 },
      actor,
      key,
    )) as PaymentResponse;
    createdPaymentIds.push(response.data.id);

    expect(response.data.status).toBe("confirmed");
    expect(response.data.direction).toBe("receipt");
    expect(response.data.voucherNumber).toBeTruthy();
    expect(response.data.partyId).toBe(customerId);

    const postings = await assertPostingsSumToZero("receipt", response.data.id);
    expect(postings).toHaveLength(2);

    expect(await ledgerBalance(branchCashLedgerId)).toBe(cashBefore + 50_000n);
    expect(await ledgerBalance(customerLedgerId)).toBe(partyBefore - 50_000n);
  });

  it("posts a basic standalone payment against a party — money out, party ledger debited, cash ledger credited", async () => {
    const cashBefore = await ledgerBalance(branchCashLedgerId);
    const partyBefore = await ledgerBalance(supplierLedgerId);

    const key = await newIdempotencyKey("payment:confirm");
    const response = (await paymentService.confirmPayment(
      { direction: "payment", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: supplierId, amount: 30_000 },
      actor,
      key,
    )) as PaymentResponse;
    createdPaymentIds.push(response.data.id);

    expect(response.data.direction).toBe("payment");
    expect(response.data.partyId).toBe(supplierId);

    const postings = await assertPostingsSumToZero("payment", response.data.id);
    expect(postings).toHaveLength(2);

    expect(await ledgerBalance(branchCashLedgerId)).toBe(cashBefore - 30_000n);
    expect(await ledgerBalance(supplierLedgerId)).toBe(partyBefore + 30_000n);
  });

  it("accepts a Bank Accounts-group ledger for cash_bank_ledger_id, not just Cash-in-Hand", async () => {
    const key = await newIdempotencyKey("payment:confirm");
    const response = (await paymentService.confirmPayment(
      { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: bankLedgerId, partyId: customerId, amount: 10_000 },
      actor,
      key,
    )) as PaymentResponse;
    createdPaymentIds.push(response.data.id);
    expect(response.data.cashBankLedgerId).toBe(bankLedgerId);
    await assertPostingsSumToZero("receipt", response.data.id);
  });

  it("rejects cash_bank_ledger_id pointing at a non-Cash/Bank ledger (a customer's own receivable ledger)", async () => {
    const key = await newIdempotencyKey("payment:confirm");
    await expect(
      paymentService.confirmPayment(
        { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: customerLedgerId, partyId: customerId, amount: 10_000 },
        actor,
        key,
      ),
    ).rejects.toMatchObject({ code: "CASH_BANK_LEDGER_INVALID_GROUP" });
  });
});

describe("Fast Expense Entry (TDD §31.5)", () => {
  it("posts an expense via counter_ledger_id, party_id null, cash defaulted via CC-7", async () => {
    const cashBefore = await ledgerBalance(branchCashLedgerId);
    const expenseBefore = await ledgerBalance(expenseLedgerId);

    const key = await newIdempotencyKey("payment:expense");
    const response = (await paymentService.fastExpenseEntry(
      { voucherDate: VOUCHER_DATE, amount: 5_000, expenseLedgerId, notes: "Staff Tea" },
      actor,
      key,
    )) as PaymentResponse;
    createdPaymentIds.push(response.data.id);

    expect(response.data.direction).toBe("payment");
    expect(response.data.partyId).toBeNull();
    expect(response.data.counterLedgerId).toBe(expenseLedgerId);
    expect(response.data.cashBankLedgerId).toBe(branchCashLedgerId);

    await assertPostingsSumToZero("payment", response.data.id);
    expect(await ledgerBalance(branchCashLedgerId)).toBe(cashBefore - 5_000n);
    expect(await ledgerBalance(expenseLedgerId)).toBe(expenseBefore + 5_000n);
  });
});

describe("remainingBalance — TDD §32 (pure formula, no locking, no guards inside)", () => {
  it("computes credit_udhar minus allocations for a sale", async () => {
    const { id: saleId } = await makeSale(customerId, 200_000, 150_000);
    expect(await readRemainingBalance({ saleId })).toBe(150_000n);

    const key = await newIdempotencyKey("payment:confirm");
    const response = (await paymentService.confirmPayment(
      { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: customerId, amount: 60_000, allocations: [{ saleId, amount: 60_000 }] },
      actor,
      key,
    )) as PaymentResponse;
    createdPaymentIds.push(response.data.id);

    expect(await readRemainingBalance({ saleId })).toBe(90_000n);
  });

  it("computes credit_to_supplier minus allocations for a purchase", async () => {
    const { id: purchaseId } = await makePurchase(supplierId, 200_000, 150_000);
    expect(await readRemainingBalance({ purchaseId })).toBe(150_000n);
  });

  it("is a pure formula with no guards inside — a cancelled sale still returns its stale credit_udhar minus allocations (§32.4/§32.5); guard enforcement lives in confirmPayment's caller-side checks", async () => {
    const { id: saleId } = await makeSale(customerId, 100_000, 100_000);
    await saleService.cancelSale(saleId, { cancelReason: "remainingBalance guard-shape test" }, actor, await newIdempotencyKey("sale:cancel"));
    expect(await readRemainingBalance({ saleId })).toBe(100_000n);
  }, 30_000);
});

describe("confirmPayment — payment allocation (TDD §31.6/§31.7)", () => {
  it("allocates a receipt against a sale — partial payoff, then a second receipt reaches remainingBalance exactly 0", async () => {
    const { id: saleId } = await makeSale(customerId, 1_000_000, 1_000_000);
    expect(await readRemainingBalance({ saleId })).toBe(1_000_000n);

    const key1 = await newIdempotencyKey("payment:confirm");
    const partial = (await paymentService.confirmPayment(
      { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: customerId, amount: 400_000, allocations: [{ saleId, amount: 400_000 }] },
      actor,
      key1,
    )) as PaymentResponse;
    createdPaymentIds.push(partial.data.id);
    expect(partial.data.allocations).toHaveLength(1);
    expect(partial.data.allocations[0]?.amount).toBe(400_000);
    expect(await readRemainingBalance({ saleId })).toBe(600_000n);

    const key2 = await newIdempotencyKey("payment:confirm");
    const full = (await paymentService.confirmPayment(
      { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: customerId, amount: 600_000, allocations: [{ saleId, amount: 600_000 }] },
      actor,
      key2,
    )) as PaymentResponse;
    createdPaymentIds.push(full.data.id);
    expect(await readRemainingBalance({ saleId })).toBe(0n);
  }, 30_000);

  it("allocates a payment against a purchase — partial payoff", async () => {
    const { id: purchaseId } = await makePurchase(supplierId, 500_000, 500_000);
    const key = await newIdempotencyKey("payment:confirm");
    const response = (await paymentService.confirmPayment(
      { direction: "payment", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: supplierId, amount: 200_000, allocations: [{ purchaseId, amount: 200_000 }] },
      actor,
      key,
    )) as PaymentResponse;
    createdPaymentIds.push(response.data.id);
    expect(response.data.allocations[0]?.amount).toBe(200_000);
    expect(await readRemainingBalance({ purchaseId })).toBe(300_000n);
  });

  it("allocates one receipt across multiple sales in a single payment (multi-target, §32.3 fixed lock order)", async () => {
    const sale3 = await makeSale(customerId, 300_000, 300_000);
    const sale4 = await makeSale(customerId, 400_000, 400_000);

    const key = await newIdempotencyKey("payment:confirm");
    const response = (await paymentService.confirmPayment(
      {
        direction: "receipt",
        voucherDate: VOUCHER_DATE,
        cashBankLedgerId: branchCashLedgerId,
        partyId: customerId,
        amount: 700_000,
        allocations: [
          { saleId: sale3.id, amount: 300_000 },
          { saleId: sale4.id, amount: 400_000 },
        ] satisfies AllocationInput[],
      },
      actor,
      key,
    )) as PaymentResponse;
    createdPaymentIds.push(response.data.id);

    expect(response.data.allocations).toHaveLength(2);
    expect(await readRemainingBalance({ saleId: sale3.id })).toBe(0n);
    expect(await readRemainingBalance({ saleId: sale4.id })).toBe(0n);
    await assertPostingsSumToZero("receipt", response.data.id);
  }, 30_000);

  it("rejects over-allocation — allocation amount exceeds remainingBalance, whole transaction rolls back", async () => {
    const { id: saleId } = await makeSale(customerId, 200_000, 150_000);
    const key = await newIdempotencyKey("payment:confirm");
    await expect(
      paymentService.confirmPayment(
        { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: customerId, amount: 200_000, allocations: [{ saleId, amount: 200_000 }] },
        actor,
        key,
      ),
    ).rejects.toMatchObject({ code: "ALLOCATION_EXCEEDS_REMAINING_BALANCE" });
    expect(await readRemainingBalance({ saleId })).toBe(150_000n);
  });

  it("rejects an allocation against a sale already fully paid (remainingBalance == 0, NOTHING_OUTSTANDING)", async () => {
    const { id: saleId } = await makeSale(customerId, 100_000, 100_000);
    const key1 = await newIdempotencyKey("payment:confirm");
    const full = (await paymentService.confirmPayment(
      { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: customerId, amount: 100_000, allocations: [{ saleId, amount: 100_000 }] },
      actor,
      key1,
    )) as PaymentResponse;
    createdPaymentIds.push(full.data.id);
    expect(await readRemainingBalance({ saleId })).toBe(0n);

    const key2 = await newIdempotencyKey("payment:confirm");
    await expect(
      paymentService.confirmPayment(
        { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: customerId, amount: 1, allocations: [{ saleId, amount: 1 }] },
        actor,
        key2,
      ),
    ).rejects.toMatchObject({ code: "NOTHING_OUTSTANDING" });
  }, 30_000);

  it("rejects an allocation against a sale with a negative credit_udhar advance (§28.4 T-5 / §32.5) — remainingBalance <= 0 the same way", async () => {
    const { id: saleId } = await makeSale(customerId, 100_000, 50_000);
    // Simulates editSale shrinking a bill below what's already collected (§32.5's documented
    // non-bug) by writing credit_udhar negative directly — exercises remainingBalance's
    // zero/negative guard shape, not editSale's own math (already covered by sale.service.test.ts).
    // paid_cash must move opposite to keep chk_sales_payment_split (paid_cash+paid_bank+credit_udhar
    // = grand_total) satisfied — grandTotalFor(100_000) = 105_000, so credit_udhar=-20_000 requires
    // paid_cash=125_000.
    await prisma.sale.update({ where: { id: saleId }, data: { creditUdhar: -20_000n, paidCash: 125_000n } });

    const key = await newIdempotencyKey("payment:confirm");
    await expect(
      paymentService.confirmPayment(
        { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: customerId, amount: 10_000, allocations: [{ saleId, amount: 10_000 }] },
        actor,
        key,
      ),
    ).rejects.toMatchObject({ code: "NOTHING_OUTSTANDING" });
  }, 30_000);

  it("rejects an allocation against a cancelled sale (CC-8)", async () => {
    const { id: saleId } = await makeSale(customerId, 100_000, 100_000);
    await saleService.cancelSale(saleId, { cancelReason: "CC-8 allocation-rejection test" }, actor, await newIdempotencyKey("sale:cancel"));

    const key = await newIdempotencyKey("payment:confirm");
    await expect(
      paymentService.confirmPayment(
        { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: customerId, amount: 50_000, allocations: [{ saleId, amount: 50_000 }] },
        actor,
        key,
      ),
    ).rejects.toMatchObject({ code: "ALLOCATION_TARGET_NOT_CONFIRMED", details: { status: "cancelled" } });
  }, 30_000);

  it("rejects an allocation against a target in a different branch", async () => {
    // wrongBranch has no cash ledger configured — credit_udhar must equal the FULL grand_total
    // (paid_cash=0) so confirmSale never needs to resolve branch.cashLedgerId (CC-7) for it.
    const { id: wrongBranchSaleId } = await makeSale(wrongBranchCustomerId, 100_000, grandTotalFor(100_000), wrongBranchActor);

    const key = await newIdempotencyKey("payment:confirm");
    await expect(
      paymentService.confirmPayment(
        { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: customerId, amount: 50_000, allocations: [{ saleId: wrongBranchSaleId, amount: 50_000 }] },
        actor,
        key,
      ),
    ).rejects.toMatchObject({ code: "ALLOCATION_TARGET_WRONG_BRANCH" });
  });

  it("rejects a payment (money out) allocating against a sale_id (locked §31.6 direction pairing)", async () => {
    const { id: saleId } = await makeSale(customerId, 100_000, 100_000);
    const key = await newIdempotencyKey("payment:confirm");
    await expect(
      paymentService.confirmPayment(
        { direction: "payment", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: supplierId, amount: 50_000, allocations: [{ saleId, amount: 50_000 }] },
        actor,
        key,
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_CANNOT_ALLOCATE_TO_SALE" });
  });

  it("rejects a receipt (money in) allocating against a purchase_id (locked §31.6 direction pairing)", async () => {
    const { id: purchaseId } = await makePurchase(supplierId, 100_000, 100_000);
    const key = await newIdempotencyKey("payment:confirm");
    await expect(
      paymentService.confirmPayment(
        { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: customerId, amount: 50_000, allocations: [{ purchaseId, amount: 50_000 }] },
        actor,
        key,
      ),
    ).rejects.toMatchObject({ code: "RECEIPT_CANNOT_ALLOCATE_TO_PURCHASE" });
  });

  it("serializes two concurrent payments allocating against the same sale — combined amount exceeds remainingBalance, exactly one succeeds", async () => {
    const { id: saleId } = await makeSale(customerId, 1_000_000, 1_000_000);
    const keyA = await newIdempotencyKey("payment:confirm");
    const keyB = await newIdempotencyKey("payment:confirm");

    const attempt = (key: string) =>
      paymentService.confirmPayment(
        { direction: "receipt", voucherDate: VOUCHER_DATE, cashBankLedgerId: branchCashLedgerId, partyId: customerId, amount: 700_000, allocations: [{ saleId, amount: 700_000 }] },
        actor,
        key,
      );

    const results = await Promise.allSettled([attempt(keyA), attempt(keyB)]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    // Two 700,000 attempts against a 1,000,000 balance: whichever locks the sale row first commits
    // (remaining -> 300,000); the second then sees that updated balance and 700,000 > 300,000 is a
    // clean over-allocation rejection, not a lost-update or a double-spend.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "ALLOCATION_EXCEEDS_REMAINING_BALANCE" });

    const winner = fulfilled[0]!.value as PaymentResponse;
    createdPaymentIds.push(winner.data.id);

    expect(await readRemainingBalance({ saleId })).toBe(300_000n);
  }, 30_000);
});

describe("confirmPayment — idempotency replay (TDD §14.2)", () => {
  it("replays the completed response on a repeated request with the same Idempotency-Key, never re-executing the service", async () => {
    const key = randomUUID();
    const body = {
      direction: "receipt" as const,
      voucherDate: VOUCHER_DATE,
      cashBankLedgerId: branchCashLedgerId,
      partyId: customerId,
      amount: 15_000,
    };
    const req = {
      auth: { userId: actor.userId, role: actor.role, branchId: actor.branchId },
      header: (name: string) => (name.toLowerCase() === "idempotency-key" ? key : undefined),
      body,
    } as unknown as Request;

    let jsonBody: unknown;
    const res = { json: (b: unknown) => { jsonBody = b; } } as unknown as Response;
    const next: NextFunction = () => undefined;

    await requireIdempotencyKey("payment:confirm")(req, res, next);
    const response = (await paymentService.confirmPayment(body, actor, key)) as PaymentResponse;
    createdPaymentIds.push(response.data.id);
    // completeIdempotencyKey wrote the row inside confirmPayment's own tx — clean it up ourselves,
    // this test bypasses newIdempotencyKey's own create-then-track helper.
    createdIdempotencyKeys.push(key);

    let nextCalledOnReplay = false;
    const next2: NextFunction = () => {
      nextCalledOnReplay = true;
    };
    await requireIdempotencyKey("payment:confirm")(req, res, next2);

    expect(nextCalledOnReplay).toBe(false);
    expect(jsonBody).toEqual(response);
  });
});
