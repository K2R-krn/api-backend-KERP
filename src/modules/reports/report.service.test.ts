import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import * as partyService from "../parties/party.service.js";
import * as saleService from "../sales/sale.service.js";
import type { SaleActor } from "../sales/sale.service.js";
import * as purchaseService from "../purchases/purchase.service.js";
import type { PurchaseActor } from "../purchases/purchase.service.js";
import * as paymentService from "../payments/payment.service.js";
import type { PaymentActor } from "../payments/payment.service.js";
import * as reportService from "./report.service.js";
import type { ReportActor } from "./report.service.js";

// TDD §22.1: service-layer tests run against the real dev DB, no mocks. Mirrors
// payment.service.test.ts's fixture/cleanup structure.

// "Today" for every ageing calculation below — voucher dates are expressed as N days before this,
// computed via plain ms-arithmetic (both are UTC-midnight `date` values, so subtracting
// N*86_400_000 always lands exactly N calendar days earlier with no DST ambiguity).
const AS_OF = new Date("2026-06-15T00:00:00.000Z");
const daysAgo = (n: number): Date => new Date(AS_OF.getTime() - n * 86_400_000);

let branchAId: string;
let branchBId: string;
let userId: string;
let writeActorA: SaleActor & PurchaseActor & PaymentActor;
let writeActorB: SaleActor;
let restrictedActor: ReportActor; // user_branches membership in branchA only
let superAdminActor: ReportActor;

let unitId: string;
let productId: string;
let customerId: string;
let customerBId: string;
let supplierId: string;

const createdBranchIds: string[] = [];
const createdPartyIds: string[] = [];
const createdProductIds: string[] = [];
const createdUnitIds: string[] = [];
const createdIdempotencyKeys: string[] = [];
const createdSaleIds: string[] = [];
const createdPurchaseIds: string[] = [];
const createdPaymentIds: string[] = [];

async function newIdempotencyKey(scope: string): Promise<string> {
  const key = randomUUID();
  await prisma.idempotencyKey.create({
    data: { key, userId, scope, requestHash: "test", status: "in_progress", expiresAt: new Date(Date.now() + 60_000) },
  });
  createdIdempotencyKeys.push(key);
  return key;
}

// 5% GST, exclusive, single line, no discount — unitRate a multiple of 20 paise keeps the tax an
// exact integer and round_off at 0, same reasoning as payment.service.test.ts's helper.
function grandTotalFor(unitRate: number): number {
  return unitRate + Math.round(unitRate * 0.05);
}

const UNIT_RATE = 200_000;
const GRAND_TOTAL = grandTotalFor(UNIT_RATE);

async function makeSale(customerIdParam: string, voucherDate: Date, creditUdhar: number, actor: SaleActor = writeActorA) {
  const key = await newIdempotencyKey("sale:confirm");
  const response = (await saleService.confirmSale(
    {
      customerId: customerIdParam,
      voucherDate,
      lines: [{ productId, unitRate: UNIT_RATE, billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
      paidCash: GRAND_TOTAL - creditUdhar,
      paidBank: 0,
      creditUdhar,
    },
    actor,
    key,
  )) as { data: { id: string } };
  createdSaleIds.push(response.data.id);
  return response.data.id;
}

async function makePurchase(supplierIdParam: string, voucherDate: Date, creditToSupplier: number) {
  const key = await newIdempotencyKey("purchase:confirm");
  const response = (await purchaseService.confirmPurchase(
    {
      supplierId: supplierIdParam,
      voucherDate,
      lines: [{ productId, unitRate: UNIT_RATE, billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
      paidCash: GRAND_TOTAL - creditToSupplier,
      paidBank: 0,
      creditToSupplier,
    },
    writeActorA,
    key,
  )) as { data: { id: string } };
  createdPurchaseIds.push(response.data.id);
  return response.data.id;
}

async function payAgainstSale(saleId: string, amount: number, voucherDate: Date = AS_OF) {
  const key = await newIdempotencyKey("payment:confirm");
  const response = (await paymentService.confirmPayment(
    { direction: "receipt", voucherDate, cashBankLedgerId: (await prisma.branch.findUniqueOrThrow({ where: { id: branchAId } })).cashLedgerId!, partyId: customerId, amount, allocations: [{ saleId, amount }] },
    writeActorA,
    key,
  )) as { data: { id: string } };
  createdPaymentIds.push(response.data.id);
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      username: `reporttest_${randomUUID()}`,
      passwordHash: "unused",
      name: "Report Service Test User",
      role: "admin",
      isActive: true,
      mustChangePassword: false,
    },
  });
  userId = user.id;
  restrictedActor = { userId, role: "accountant" };
  superAdminActor = { userId, role: "super_admin" };

  const branchA = await prisma.branch.create({
    data: { name: `Report Test Branch A ${randomUUID()}`, code: `RA${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  branchAId = branchA.id;
  createdBranchIds.push(branchAId);

  const branchB = await prisma.branch.create({
    data: { name: `Report Test Branch B ${randomUUID()}`, code: `RB${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  branchBId = branchB.id;
  createdBranchIds.push(branchBId);

  await prisma.userBranch.create({ data: { userId, branchId: branchAId } });

  writeActorA = { userId, role: "admin", branchId: branchAId };
  writeActorB = { userId, role: "admin", branchId: branchBId };

  const cashGroup = await prisma.accountGroup.findFirstOrThrow({ where: { name: "Cash-in-Hand", deletedAt: null } });
  const cashLedgerA = await prisma.ledger.create({
    data: { name: `Report Test Cash A ${randomUUID()}`, accountGroupId: cashGroup.id, branchId: branchAId },
  });
  await prisma.branch.update({ where: { id: branchAId }, data: { cashLedgerId: cashLedgerA.id } });

  const cashLedgerB = await prisma.ledger.create({
    data: { name: `Report Test Cash B ${randomUUID()}`, accountGroupId: cashGroup.id, branchId: branchBId },
  });
  await prisma.branch.update({ where: { id: branchBId }, data: { cashLedgerId: cashLedgerB.id } });

  const unit = await prisma.unit.create({ data: { name: `Report Test Kilogram ${randomUUID()}`, symbol: "kg" } });
  unitId = unit.id;
  createdUnitIds.push(unitId);

  const product = await prisma.product.create({
    data: { name: `Report Test Product ${randomUUID()}`, hsnCode: "31051000", unitId, gstRate: 5, taxClassification: "taxable" },
  });
  productId = product.id;
  createdProductIds.push(productId);

  await prisma.branchStock.create({ data: { branchId: branchAId, productId, quantity: 100_000, avgCost: 6_000n } });
  await prisma.branchStock.create({ data: { branchId: branchBId, productId, quantity: 100_000, avgCost: 6_000n } });

  const customer = (await partyService.createParty(
    { type: "customer", name: `Report Test Customer ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
    { userId, role: "admin", branchId: branchAId },
    await newIdempotencyKey("party:create"),
  )) as { data: { id: string } };
  customerId = customer.data.id;
  createdPartyIds.push(customerId);

  const customerB = (await partyService.createParty(
    { type: "customer", name: `Report Test Customer B ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
    { userId, role: "admin", branchId: branchBId },
    await newIdempotencyKey("party:create"),
  )) as { data: { id: string } };
  customerBId = customerB.data.id;
  createdPartyIds.push(customerBId);

  const supplier = (await partyService.createParty(
    { type: "supplier", name: `Report Test Supplier ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
    { userId, role: "admin", branchId: branchAId },
    await newIdempotencyKey("party:create"),
  )) as { data: { id: string } };
  supplierId = supplier.data.id;
  createdPartyIds.push(supplierId);
}, 30_000);

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
  await prisma.numberSeries.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.branchStock.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.party.deleteMany({ where: { id: { in: createdPartyIds } } });
  await prisma.userBranch.deleteMany({ where: { userId } });
  await prisma.ledger.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.branch.deleteMany({ where: { id: { in: createdBranchIds } } });
  await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await prisma.unit.deleteMany({ where: { id: { in: createdUnitIds } } });
  await prisma.idempotencyKey.deleteMany({ where: { key: { in: createdIdempotencyKeys } } });
  await prisma.auditLog.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}, 30_000);

describe("getReceivables — ageing buckets (TDD §34)", () => {
  it("assigns 0-30/31-60/61+ correctly at the exact day-30/day-31 boundary, and rolls up per party", async () => {
    const sale0 = await makeSale(customerId, daysAgo(0), 11_000);
    const sale30 = await makeSale(customerId, daysAgo(30), 22_000);
    const sale31 = await makeSale(customerId, daysAgo(31), 33_000);
    const sale60 = await makeSale(customerId, daysAgo(60), 44_000);
    const sale61 = await makeSale(customerId, daysAgo(61), 55_000);

    const report = await reportService.getReceivables({ branchId: branchAId, asOf: AS_OF }, restrictedActor);

    const byId = new Map(report.invoices.map((inv) => [inv.id, inv]));
    expect(byId.get(sale0)?.bucket).toBe("0-30");
    expect(byId.get(sale30)?.bucket).toBe("0-30"); // day 30 belongs to the FIRST bucket, not both
    expect(byId.get(sale31)?.bucket).toBe("31-60"); // day 31 is the very next bucket
    expect(byId.get(sale60)?.bucket).toBe("31-60");
    expect(byId.get(sale61)?.bucket).toBe("61+");

    const summary = report.summary.find((s) => s.partyId === customerId);
    expect(summary).toBeDefined();
    expect(summary?.total).toBe(165_000n);
    expect(summary?.bucket0to30).toBe(33_000n);
    expect(summary?.bucket31to60).toBe(77_000n);
    expect(summary?.bucket61plus).toBe(55_000n);
    expect(summary?.partyName).toBeTruthy();
  }, 30_000);

  it("excludes a cancelled sale even though its stale credit_udhar is still positive (CC-8)", async () => {
    const cancelledSaleId = await makeSale(customerId, daysAgo(5), 99_000);
    await saleService.cancelSale(cancelledSaleId, { cancelReason: "ageing CC-8 exclusion test" }, writeActorA, await newIdempotencyKey("sale:cancel"));

    const report = await reportService.getReceivables({ branchId: branchAId, asOf: AS_OF }, restrictedActor);
    expect(report.invoices.some((inv) => inv.id === cancelledSaleId)).toBe(false);
  }, 30_000);

  it("excludes a fully-paid sale (remainingBalance == 0)", async () => {
    const paidSaleId = await makeSale(customerId, daysAgo(10), 12_000);
    await payAgainstSale(paidSaleId, 12_000);

    const report = await reportService.getReceivables({ branchId: branchAId, asOf: AS_OF }, restrictedActor);
    expect(report.invoices.some((inv) => inv.id === paidSaleId)).toBe(false);
  });

  it("excludes an edited-down sale with a negative remainingBalance (§32.5 non-bug, proven not untested)", async () => {
    const saleId = await makeSale(customerId, daysAgo(15), 100_000);
    await payAgainstSale(saleId, 80_000); // remainingBalance now 20,000

    // Simulates editSale shrinking the bill below what's already been collected (§32.5) — direct
    // update, same technique payment.service.test.ts already uses for this exact scenario.
    // paid_cash must move opposite to keep the payment-split invariant satisfied.
    await prisma.sale.update({ where: { id: saleId }, data: { creditUdhar: 50_000n, paidCash: BigInt(GRAND_TOTAL) - 50_000n } });

    const report = await reportService.getReceivables({ branchId: branchAId, asOf: AS_OF }, restrictedActor);
    expect(report.invoices.some((inv) => inv.id === saleId)).toBe(false);
  }, 30_000);
});

describe("getReceivables — per-branch vs consolidated (TDD §7.2)", () => {
  it("per-branch mode only returns the named branch's sales", async () => {
    const saleA = await makeSale(customerId, daysAgo(0), 10_000);
    const saleB = await makeSale(customerBId, daysAgo(0), 20_000, writeActorB);

    const reportA = await reportService.getReceivables({ branchId: branchAId, asOf: AS_OF }, restrictedActor);
    expect(reportA.invoices.some((inv) => inv.id === saleA)).toBe(true);
    expect(reportA.invoices.some((inv) => inv.id === saleB)).toBe(false);
  }, 30_000);

  it("consolidated mode (no branch_id) is super_admin only", async () => {
    await expect(reportService.getReceivables({ branchId: null, asOf: AS_OF }, restrictedActor)).rejects.toMatchObject({
      code: "BRANCH_REQUIRED",
    });
  });

  it("consolidated mode returns sales across every branch for super_admin", async () => {
    const saleA = await makeSale(customerId, daysAgo(0), 10_000);
    const saleB = await makeSale(customerBId, daysAgo(0), 20_000, writeActorB);

    const consolidated = await reportService.getReceivables({ branchId: null, asOf: AS_OF }, superAdminActor);
    expect(consolidated.invoices.some((inv) => inv.id === saleA)).toBe(true);
    expect(consolidated.invoices.some((inv) => inv.id === saleB)).toBe(true);
  }, 30_000);

  it("rejects a non-super-admin actor naming a branch they don't belong to", async () => {
    await expect(reportService.getReceivables({ branchId: branchBId, asOf: AS_OF }, restrictedActor)).rejects.toMatchObject({
      code: "BRANCH_NOT_ALLOWED",
    });
  });
});

describe("getPayables — mirrors the sales query (TDD §34)", () => {
  it("buckets an outstanding purchase and excludes a cancelled one (CC-8)", async () => {
    const purchaseId = await makePurchase(supplierId, daysAgo(5), 15_000);
    const cancelledPurchaseId = await makePurchase(supplierId, daysAgo(5), 90_000);
    // purchases have no editPurchase/cancelPurchase service yet (Iteration 3 only built that pair
    // for sales) — a direct status flip is the only way to exercise this status column value; the
    // ageing query only reads `status`, so this still faithfully tests the CC-8 filter itself.
    await prisma.purchase.update({ where: { id: cancelledPurchaseId }, data: { status: "cancelled" } });

    const report = await reportService.getPayables({ branchId: branchAId, asOf: AS_OF }, restrictedActor);
    const byId = new Map(report.invoices.map((inv) => [inv.id, inv]));
    expect(byId.get(purchaseId)?.bucket).toBe("0-30");
    expect(byId.get(purchaseId)?.remainingBalance).toBe(15_000n);
    expect(report.invoices.some((inv) => inv.id === cancelledPurchaseId)).toBe(false);
  }, 30_000);
});
