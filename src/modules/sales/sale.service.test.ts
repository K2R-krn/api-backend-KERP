import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import { requireCap } from "../../middleware/authorize.js";
import type { Role } from "../../shared/types.js";
import * as partyService from "./../parties/party.service.js";
import * as saleService from "./sale.service.js";
import type { SaleActor } from "./sale.service.js";
import { cancelSaleSchema, confirmFreshSaleSchema, createDraftSaleSchema } from "./sale.validation.js";

// TDD §22.1: service-layer tests run against the real dev DB, no mocks — the row lock, the
// GST math, and the ledger/stock side effects are exactly the things under test here.

interface SaleLine {
  id: string;
  productId: string;
  billedQty: number;
  freeQty: number;
  discount: number;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  lineTotal: number;
}

interface SaleData {
  id: string;
  status: string;
  invoiceNumber: string | null;
  documentType: string | null;
  totalTaxable: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  roundOff: number;
  grandTotal: number;
  paidCash: number;
  paidBank: number;
  creditUdhar: number;
  lineItems: SaleLine[];
}

interface SaleResponse {
  data: SaleData;
}

let branchId: string;
let branchCashLedgerId: string;
let noCashBranchId: string;
let unitId: string;
let bankLedgerId: string;
let actor: SaleActor;

let productTaxableId: string; // 5% GST, taxable
let productExemptId: string; // exempt, 0%
let customerIntraId: string; // party, stateCode 24 (same as branch)
let customerInterId: string; // party, stateCode 27 (different from branch)

const createdBranchIds: string[] = [];
const createdCashLedgerIds: string[] = []; // branchService.createBranch's own Cash ledger
const createdOtherLedgerIds: string[] = []; // bank ledger + party ledgers
const createdPartyIds: string[] = [];
const createdProductIds: string[] = [];
const createdUnitIds: string[] = [];
const createdIdempotencyKeys: string[] = [];
const createdSaleIds: string[] = [];

const VOUCHER_DATE = new Date("2026-06-15");

function money(n: number): number {
  return n; // paise, integer — named for readability at call sites below.
}

async function newIdempotencyKey(scope: string): Promise<string> {
  const key = randomUUID();
  await prisma.idempotencyKey.create({
    data: { key, userId: actor.userId, scope, requestHash: "test", status: "in_progress", expiresAt: new Date(Date.now() + 60_000) },
  });
  createdIdempotencyKeys.push(key);
  return key;
}

async function seedStock(targetBranchId: string, productId: string, quantity: number, avgCost: number): Promise<void> {
  await prisma.branchStock.create({ data: { branchId: targetBranchId, productId, quantity, avgCost: BigInt(avgCost) } });
}

async function assertPostingsSumToZero(saleId: string) {
  const postings = await prisma.ledgerPosting.findMany({ where: { voucherType: "sale", voucherId: saleId } });
  const sum = postings.reduce((acc, p) => acc + p.amount, 0n);
  expect(sum).toBe(0n);
  return postings;
}

// §28.4 edit/cancel suite — a ledger's running balance is just the sum of every posting against
// it (TDD §7, no separate stored-balance column).
async function ledgerBalance(ledgerId: string): Promise<bigint> {
  const postings = await prisma.ledgerPosting.findMany({ where: { ledgerId } });
  return postings.reduce((sum, p) => sum + p.amount, 0n);
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      username: `saletest_${randomUUID()}`,
      passwordHash: "unused",
      name: "Sale Service Test User",
      role: "admin",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const branch = await prisma.branch.create({
    data: { name: `Sale Test Branch ${randomUUID()}`, code: `ST${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  branchId = branch.id;
  createdBranchIds.push(branchId);

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

  // Deliberately created WITHOUT calling branchService.createBranch — cash_ledger_id stays null,
  // which is exactly the SYSTEM_LEDGER_NOT_CONFIGURED scenario (TDD §26 step 10).
  const noCashBranch = await prisma.branch.create({
    data: { name: `No Cash Branch ${randomUUID()}`, code: `NC${randomUUID().slice(0, 6)}`, stateCode: "24" },
  });
  noCashBranchId = noCashBranch.id;
  createdBranchIds.push(noCashBranchId);

  actor = { userId: user.id, role: "admin", branchId };

  const unit = await prisma.unit.create({ data: { name: `Test Kilogram ${randomUUID()}`, symbol: "kg" } });
  unitId = unit.id;
  createdUnitIds.push(unitId);

  const productTaxable = await prisma.product.create({
    data: { name: `Test Fertilizer ${randomUUID()}`, hsnCode: "31051000", unitId, gstRate: 5, taxClassification: "taxable" },
  });
  productTaxableId = productTaxable.id;
  createdProductIds.push(productTaxableId);

  const productExempt = await prisma.product.create({
    data: { name: `Test Seeds ${randomUUID()}`, hsnCode: "10019100", unitId, gstRate: 0, taxClassification: "exempt" },
  });
  productExemptId = productExempt.id;
  createdProductIds.push(productExemptId);

  // Generous shared stock — reused across every non-stock-focused test below.
  await seedStock(branchId, productTaxableId, 100_000, 6_000);
  await seedStock(branchId, productExemptId, 100_000, 2_000);
  await seedStock(noCashBranchId, productTaxableId, 1_000, 6_000);

  const intra = (await partyService.createParty(
    { type: "customer", name: `Test Intra Customer ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
    { userId: actor.userId, role: actor.role, branchId },
    await newIdempotencyKey("party:create"),
  )) as { data: { id: string; ledgerId: string; ledger: { id: string } } };
  customerIntraId = intra.data.id;
  createdPartyIds.push(intra.data.id);
  createdOtherLedgerIds.push(intra.data.ledger.id);

  const inter = (await partyService.createParty(
    { type: "customer", name: `Test Inter Customer ${randomUUID()}`, village: "Pune", stateCode: "27", openingBalance: 0 },
    { userId: actor.userId, role: actor.role, branchId },
    await newIdempotencyKey("party:create"),
  )) as { data: { id: string; ledgerId: string; ledger: { id: string } } };
  customerInterId = inter.data.id;
  createdPartyIds.push(inter.data.id);
  createdOtherLedgerIds.push(inter.data.ledger.id);
}, 30_000);

afterEach(async () => {
  if (createdIdempotencyKeys.length) {
    await prisma.idempotencyKey.deleteMany({ where: { key: { in: createdIdempotencyKeys } } });
    createdIdempotencyKeys.length = 0;
  }
});

afterAll(async () => {
  // Guard against beforeAll never reaching `actor = {...}` (e.g. a DB connection drop on its very
  // first query) — without this, afterAll's own actor.userId reads below throw a confusing
  // secondary TypeError on top of whatever killed beforeAll, instead of just the one real error.
  if (!actor) return;

  // Children-before-parents, matching the RESTRICT delete rules on the transaction schema's FKs
  // (prisma/migrations/*/migration.sql) — none of these cascade automatically.
  await prisma.ledgerPosting.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.stockMovement.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.saleLineItem.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.sale.deleteMany({ where: { id: { in: createdSaleIds } } });
  await prisma.numberSeries.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.branchStock.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.party.deleteMany({ where: { id: { in: createdPartyIds } } });
  await prisma.branch.deleteMany({ where: { id: { in: createdBranchIds } } });
  await prisma.ledger.deleteMany({ where: { id: { in: [...createdCashLedgerIds, ...createdOtherLedgerIds] } } });
  await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await prisma.unit.deleteMany({ where: { id: { in: createdUnitIds } } });
  await prisma.auditLog.deleteMany({ where: { userId: actor.userId } });
  await prisma.user.delete({ where: { id: actor.userId } });

  const leftoverSales = await prisma.sale.count({ where: { branchId: { in: createdBranchIds } } });
  if (leftoverSales > 0) {
    throw new Error("sale.service.test.ts left sale rows behind — cleanup did not fully succeed");
  }
  // This file's getLastPrice/getInvoicePayload additions push createdSaleIds well past what the
  // golden-math suite alone left to clean up — enough sequential round-trips over the remote
  // Nepal<->Mumbai path (CLAUDE.md) to exceed vitest.config.ts's global 15s hookTimeout.
}, 30_000);

describe("sale.validation — approved #1 (customerId/customerName exclusivity)", () => {
  it("rejects customerName/customerVillage supplied alongside customerId", () => {
    const result = createDraftSaleSchema.safeParse({
      customerId: randomUUID(),
      customerName: "Should not be here",
      voucherDate: VOUCHER_DATE,
      lines: [{ productId: randomUUID(), unitRate: 100, billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
    });
    expect(result.success).toBe(false);
  });

  it("requires customerName and customerVillage for an anonymous sale", () => {
    const result = createDraftSaleSchema.safeParse({
      voucherDate: VOUCHER_DATE,
      lines: [{ productId: randomUUID(), unitRate: 100, billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a bare customerId with no name/village", () => {
    const result = createDraftSaleSchema.safeParse({
      customerId: randomUUID(),
      voucherDate: VOUCHER_DATE,
      lines: [{ productId: randomUUID(), unitRate: 100, billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
    });
    expect(result.success).toBe(true);
  });
});

describe("confirmSale — golden-math suite (TDD §26/§22.1)", () => {
  it("computes a basic exclusive-GST sale exactly (hand-calculated)", async () => {
    // 10 kg @ ₹100 (10000 paise), 5% GST, exclusive, no discount, intra-state, full cash.
    // taxable=100000, tax=round(100000*0.05)=5000, cgst=2500, sgst=2500, grand=105000.
    const key = await newIdempotencyKey("sale:confirm");
    const response = (await saleService.confirmSale(
      {
        customerName: "Walk-in",
        customerVillage: "Anand",
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productTaxableId, unitRate: money(10_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(105_000),
        paidBank: 0,
        creditUdhar: 0,
      },
      actor,
      key,
    )) as SaleResponse;
    createdSaleIds.push(response.data.id);

    expect(response.data.status).toBe("confirmed");
    expect(response.data.invoiceNumber).toBeTruthy();
    expect(response.data.totalTaxable).toBe(100_000);
    expect(response.data.totalCgst).toBe(2_500);
    expect(response.data.totalSgst).toBe(2_500);
    expect(response.data.totalIgst).toBe(0);
    expect(response.data.roundOff).toBe(0);
    expect(response.data.grandTotal).toBe(105_000);
    expect(response.data.lineItems).toHaveLength(1);
    expect(response.data.lineItems[0]?.taxableValue).toBe(100_000);
    expect(response.data.lineItems[0]?.lineTotal).toBe(105_000);

    await assertPostingsSumToZero(response.data.id);
  });

  it("computes an inclusive-GST sale with an exact back-calc (hand-verified)", async () => {
    // 5 kg @ ₹21.00 inclusive (2100 paise), 5% GST -> taxable=10000, tax=500 exactly (10000*1.05=10500).
    const key = await newIdempotencyKey("sale:confirm");
    const response = (await saleService.confirmSale(
      {
        customerName: "Walk-in",
        customerVillage: "Anand",
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productTaxableId, unitRate: money(2_100), billedQty: 5, freeQty: 0, discount: 0, priceIncludesGst: true }],
        paidCash: money(10_500),
        paidBank: 0,
        creditUdhar: 0,
      },
      actor,
      key,
    )) as SaleResponse;
    createdSaleIds.push(response.data.id);

    expect(response.data.totalTaxable).toBe(10_000);
    expect(response.data.totalCgst).toBe(250);
    expect(response.data.totalSgst).toBe(250);
    expect(response.data.grandTotal).toBe(10_500);

    await assertPostingsSumToZero(response.data.id);
  });

  it("excludes free_qty from taxable value but still moves it out of stock", async () => {
    const before = await prisma.branchStock.findUniqueOrThrow({
      where: { branchId_productId: { branchId, productId: productTaxableId } },
    });

    const key = await newIdempotencyKey("sale:confirm");
    const response = (await saleService.confirmSale(
      {
        customerName: "Walk-in",
        customerVillage: "Anand",
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productTaxableId, unitRate: money(5_000), billedQty: 8, freeQty: 2, discount: 0, priceIncludesGst: false }],
        paidCash: money(42_000), // taxable 40000 + 5% (2000) = 42000
        paidBank: 0,
        creditUdhar: 0,
      },
      actor,
      key,
    )) as SaleResponse;
    createdSaleIds.push(response.data.id);

    expect(response.data.totalTaxable).toBe(40_000); // billed-only, free excluded
    expect(response.data.grandTotal).toBe(42_000);

    const after = await prisma.branchStock.findUniqueOrThrow({
      where: { branchId_productId: { branchId, productId: productTaxableId } },
    });
    expect(before.quantity.sub(after.quantity).toNumber()).toBeCloseTo(10, 6); // billed(8) + free(2)

    await assertPostingsSumToZero(response.data.id);
  });

  it("mixes taxable + exempt lines on one anonymous sale, deriving invoice_cum_bos", async () => {
    const key = await newIdempotencyKey("sale:confirm");
    const response = (await saleService.confirmSale(
      {
        customerName: "Walk-in",
        customerVillage: "Anand",
        voucherDate: VOUCHER_DATE,
        lines: [
          { productId: productTaxableId, unitRate: money(10_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false },
          { productId: productExemptId, unitRate: money(2_000), billedQty: 5, freeQty: 0, discount: 0, priceIncludesGst: false },
        ],
        paidCash: money(115_000), // (100000 + 5000 tax) + 10000 exempt = 115000
        paidBank: 0,
        creditUdhar: 0,
      },
      actor,
      key,
    )) as SaleResponse;
    createdSaleIds.push(response.data.id);

    expect(response.data.totalTaxable).toBe(110_000);
    expect(response.data.totalCgst).toBe(2_500);
    expect(response.data.grandTotal).toBe(115_000);
    // §23.1: mixed classifications + unregistered (anonymous) buyer -> invoice_cum_bos.
    expect(response.data.documentType).toBe("invoice_cum_bos");

    await assertPostingsSumToZero(response.data.id);
  });

  it(
    "posts CGST+SGST intra-state and IGST inter-state, split correctly",
    async () => {
      const intraKey = await newIdempotencyKey("sale:confirm");
      const intra = (await saleService.confirmSale(
        {
          customerId: customerIntraId,
          voucherDate: VOUCHER_DATE,
          lines: [{ productId: productTaxableId, unitRate: money(10_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: money(105_000),
          paidBank: 0,
          creditUdhar: 0,
        },
        actor,
        intraKey,
      )) as SaleResponse;
      createdSaleIds.push(intra.data.id);
      expect(intra.data.totalCgst).toBe(2_500);
      expect(intra.data.totalSgst).toBe(2_500);
      expect(intra.data.totalIgst).toBe(0);
      await assertPostingsSumToZero(intra.data.id);

      const interKey = await newIdempotencyKey("sale:confirm");
      const inter = (await saleService.confirmSale(
        {
          customerId: customerInterId,
          voucherDate: VOUCHER_DATE,
          lines: [{ productId: productTaxableId, unitRate: money(10_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: money(105_000),
          paidBank: 0,
          creditUdhar: 0,
        },
        actor,
        interKey,
      )) as SaleResponse;
      createdSaleIds.push(inter.data.id);
      expect(inter.data.totalCgst).toBe(0);
      expect(inter.data.totalSgst).toBe(0);
      expect(inter.data.totalIgst).toBe(5_000);
      await assertPostingsSumToZero(inter.data.id);
    },
    // Two full sequential confirmSale round-trips (each a multi-step transaction: stock lock,
    // number-series allocation, header/line writes, stock movement, ledger postings, audit,
    // idempotency) over the real Nepal<->Mumbai path exceeded the file's 15s default once under a
    // long full-suite run (CLAUDE.md: generous timeouts on DB-touching tests, not library
    // defaults) — same explicit-timeout treatment as the concurrency test below.
    30_000,
  );

  it("splits an ODD line tax floor-to-CGST/remainder-to-SGST (S-3), not just the even cases above", async () => {
    // 1 kg @ 50020 paise, 5% GST, exclusive -> taxable=50020, lineTax=round(50020*0.05)=2501
    // (odd) exactly, no rounding ambiguity. Every other test in this suite happens to land on an
    // even lineTax (5000/500/2000/...), which never exercises S-3's floor/remainder asymmetry.
    const key = await newIdempotencyKey("sale:confirm");
    const response = (await saleService.confirmSale(
      {
        customerName: "Walk-in",
        customerVillage: "Anand",
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productTaxableId, unitRate: money(50_020), billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(52_521),
        paidBank: 0,
        creditUdhar: 0,
      },
      actor,
      key,
    )) as SaleResponse;
    createdSaleIds.push(response.data.id);

    const line = response.data.lineItems[0];
    expect(line?.taxableValue).toBe(50_020);
    expect(line?.cgstAmount).toBe(1_250); // floor(2501/2)
    expect(line?.sgstAmount).toBe(1_251); // 2501 - 1250, the odd remainder
    expect(line?.cgstAmount).not.toBe(line?.sgstAmount);
    expect((line?.cgstAmount ?? 0) + (line?.sgstAmount ?? 0)).toBe(2_501);
    expect(response.data.totalCgst).toBe(1_250);
    expect(response.data.totalSgst).toBe(1_251);

    await assertPostingsSumToZero(response.data.id);
  });

  it("splits payment across cash + bank + customer udhar, posting all three ledgers", async () => {
    const key = await newIdempotencyKey("sale:confirm");
    const response = (await saleService.confirmSale(
      {
        customerId: customerIntraId,
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productTaxableId, unitRate: money(10_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(50_000),
        paidBank: money(30_000),
        bankLedgerId,
        creditUdhar: money(25_000),
      },
      actor,
      key,
    )) as SaleResponse;
    createdSaleIds.push(response.data.id);
    expect(response.data.grandTotal).toBe(105_000);

    const postings = await assertPostingsSumToZero(response.data.id);
    const byLedger = new Map(postings.map((p) => [p.ledgerId, p.amount]));
    expect(byLedger.get(branchCashLedgerId)).toBe(50_000n);
    expect(byLedger.get(bankLedgerId)).toBe(30_000n);

    const customer = await prisma.party.findUniqueOrThrow({ where: { id: customerIntraId } });
    expect(byLedger.get(customer.ledgerId)).toBe(25_000n);
  });

  it("rejects an over-sell against the locked stock quantity (negative-stock hard-block)", async () => {
    const lowStockProduct = await prisma.product.create({
      data: { name: `Low Stock ${randomUUID()}`, unitId, gstRate: 5, taxClassification: "taxable" },
    });
    createdProductIds.push(lowStockProduct.id);
    await seedStock(branchId, lowStockProduct.id, 2, 6_000);

    const key = await newIdempotencyKey("sale:confirm");
    await expect(
      saleService.confirmSale(
        {
          customerName: "Walk-in",
          customerVillage: "Anand",
          voucherDate: VOUCHER_DATE,
          lines: [{ productId: lowStockProduct.id, unitRate: money(10_000), billedQty: 5, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: money(52_500),
          paidBank: 0,
          creditUdhar: 0,
        },
        actor,
        key,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK", details: { productId: lowStockProduct.id, available: 2, requested: 5 } });

    const stockAfter = await prisma.branchStock.findUniqueOrThrow({
      where: { branchId_productId: { branchId, productId: lowStockProduct.id } },
    });
    expect(stockAfter.quantity.toNumber()).toBe(2); // untouched — the whole tx rolled back
  });

  it("rejects a wholly-giveaway sale (S-1) even though a free-only line is otherwise valid", async () => {
    const key = await newIdempotencyKey("sale:confirm");
    await expect(
      saleService.confirmSale(
        {
          customerName: "Walk-in",
          customerVillage: "Anand",
          voucherDate: VOUCHER_DATE,
          lines: [{ productId: productTaxableId, unitRate: money(10_000), billedQty: 0, freeQty: 3, discount: 0, priceIncludesGst: false }],
          paidCash: 0,
          paidBank: 0,
          creditUdhar: 0,
        },
        actor,
        key,
      ),
    ).rejects.toMatchObject({ code: "WHOLLY_GIVEAWAY_SALE_REJECTED" });
  });

  it("applies nearest_rupee round-off, posting the difference to the Round Off ledger", async () => {
    const profile = await prisma.companyProfile.findFirstOrThrow({ where: { deletedAt: null } });
    await prisma.companyProfile.update({ where: { id: profile.id }, data: { roundingMode: "nearest_rupee" } });

    try {
      // 3 kg @ ₹33.33 (3333 paise), 5% GST -> taxable=9999, tax=round(9999*0.05)=500 -> pre=10499
      // -> nearest rupee = 10500 -> round_off = +1.
      const key = await newIdempotencyKey("sale:confirm");
      const response = (await saleService.confirmSale(
        {
          customerName: "Walk-in",
          customerVillage: "Anand",
          voucherDate: VOUCHER_DATE,
          lines: [{ productId: productTaxableId, unitRate: money(3_333), billedQty: 3, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: money(10_500),
          paidBank: 0,
          creditUdhar: 0,
        },
        actor,
        key,
      )) as SaleResponse;
      createdSaleIds.push(response.data.id);

      expect(response.data.roundOff).toBe(1);
      expect(response.data.grandTotal).toBe(10_500);

      const postings = await assertPostingsSumToZero(response.data.id);
      const profileLedgers = await prisma.companyProfile.findUniqueOrThrow({ where: { id: profile.id } });
      const roundOffPosting = postings.find((p) => p.ledgerId === profileLedgers.roundOffLedgerId);
      expect(roundOffPosting?.amount).toBe(-1n);
    } finally {
      await prisma.companyProfile.update({ where: { id: profile.id }, data: { roundingMode: profile.roundingMode } });
    }
  });

  it(
    "serializes two concurrent sales against the same product: exactly one succeeds when combined demand exceeds stock",
    async () => {
      const product = await prisma.product.create({
        data: { name: `Concurrency Test ${randomUUID()}`, unitId, gstRate: 5, taxClassification: "taxable" },
      });
      createdProductIds.push(product.id);
      await seedStock(branchId, product.id, 5, 6_000); // exactly enough for one 3-unit sale, not two

      const makeCall = () =>
        newIdempotencyKey("sale:confirm").then((key) =>
          saleService.confirmSale(
            {
              customerName: "Walk-in",
              customerVillage: "Anand",
              voucherDate: VOUCHER_DATE,
              lines: [{ productId: product.id, unitRate: money(10_000), billedQty: 3, freeQty: 0, discount: 0, priceIncludesGst: false }],
              paidCash: money(31_500),
              paidBank: 0,
              creditUdhar: 0,
            },
            actor,
            key,
          ),
        );

      const [a, b] = await Promise.allSettled([makeCall(), makeCall()]);
      const results = [a, b];
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winner = (fulfilled[0] as PromiseFulfilledResult<unknown>).value as SaleResponse;
      createdSaleIds.push(winner.data.id);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "INSUFFICIENT_STOCK" });

      const stockAfter = await prisma.branchStock.findUniqueOrThrow({
        where: { branchId_productId: { branchId, productId: product.id } },
      });
      expect(stockAfter.quantity.toNumber()).toBe(2); // 5 - 3 (only the winner's decrement applied)

      await assertPostingsSumToZero(winner.data.id);
    },
    30_000,
  );

  it("throws SYSTEM_LEDGER_NOT_CONFIGURED when the branch has no cash ledger", async () => {
    const noCashActor: SaleActor = { userId: actor.userId, role: actor.role, branchId: noCashBranchId };
    const key = await newIdempotencyKey("sale:confirm");
    await expect(
      saleService.confirmSale(
        {
          customerName: "Walk-in",
          customerVillage: "Anand",
          voucherDate: VOUCHER_DATE,
          lines: [{ productId: productTaxableId, unitRate: money(10_000), billedQty: 5, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: money(52_500),
          paidBank: 0,
          creditUdhar: 0,
        },
        noCashActor,
        key,
      ),
    ).rejects.toMatchObject({ code: "SYSTEM_LEDGER_NOT_CONFIGURED", details: { ledger: "branch.cashLedgerId" } });

    // Nothing should have been written — no number consumed, no stock moved.
    const stockAfter = await prisma.branchStock.findUniqueOrThrow({
      where: { branchId_productId: { branchId: noCashBranchId, productId: productTaxableId } },
    });
    expect(stockAfter.quantity.toNumber()).toBe(1_000);
  });
});

describe("createDraft + confirmSale(draftId) — the confirm-existing-draft entry mode (TDD §28.2)", () => {
  it("parks a draft with real computed GST, then confirms it with the payment split supplied at confirm time", async () => {
    const draftKey = await newIdempotencyKey("sale:draft");
    const draft = (await saleService.createDraft(
      {
        customerName: "Parked Customer",
        customerVillage: "Anand",
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productTaxableId, unitRate: money(10_000), billedQty: 4, freeQty: 0, discount: 0, priceIncludesGst: false }],
      },
      actor,
      draftKey,
    )) as SaleResponse;

    expect(draft.data.status).toBe("draft");
    expect(draft.data.invoiceNumber).toBeNull();
    // Header totals are NOT persisted on a draft (TDD §25.1: document_type/place_of_supply/
    // financial_year are all "snapshot at confirm"; the unconditional chk_sales_payment_split
    // CHECK also makes a nonzero grand_total impossible before a payment split exists). The line
    // items still carry real computed GST math, not placeholders.
    expect(draft.data.totalTaxable).toBe(0);
    expect(draft.data.lineItems[0]?.taxableValue).toBe(40_000); // 4 * 10000, real GST math even while parked

    const confirmKey = await newIdempotencyKey("sale:confirm");
    const confirmed = (await saleService.confirmSale(
      { draftId: draft.data.id, paidCash: money(42_000), paidBank: 0, creditUdhar: 0 },
      actor,
      confirmKey,
    )) as SaleResponse;
    createdSaleIds.push(confirmed.data.id);

    expect(confirmed.data.id).toBe(draft.data.id); // same row, draft -> confirmed transition
    expect(confirmed.data.status).toBe("confirmed");
    expect(confirmed.data.invoiceNumber).toBeTruthy();
    expect(confirmed.data.grandTotal).toBe(42_000);

    await assertPostingsSumToZero(confirmed.data.id);
  });

  it("blocks confirmation with an actionable error when a parked product is deactivated before confirm (approved #8)", async () => {
    const product = await prisma.product.create({
      data: { name: `To Deactivate ${randomUUID()}`, unitId, gstRate: 5, taxClassification: "taxable" },
    });
    createdProductIds.push(product.id);
    await seedStock(branchId, product.id, 100, 6_000);

    const draftKey = await newIdempotencyKey("sale:draft");
    const draft = (await saleService.createDraft(
      {
        customerName: "Parked Customer",
        customerVillage: "Anand",
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: product.id, unitRate: money(10_000), billedQty: 5, freeQty: 0, discount: 0, priceIncludesGst: false }],
      },
      actor,
      draftKey,
    )) as SaleResponse;

    await prisma.product.update({ where: { id: product.id }, data: { isActive: false } });

    const confirmKey = await newIdempotencyKey("sale:confirm");
    await expect(
      saleService.confirmSale({ draftId: draft.data.id, paidCash: 0, paidBank: 0, creditUdhar: 0 }, actor, confirmKey),
    ).rejects.toMatchObject({ code: "PRODUCT_DEACTIVATED", details: { productId: product.id } });

    // The draft itself is untouched — still parkable/editable, not silently confirmed or deleted.
    const draftAfter = await prisma.sale.findUniqueOrThrow({ where: { id: draft.data.id } });
    expect(draftAfter.status).toBe("draft");
    createdSaleIds.push(draft.data.id);
  });
});

describe("sale.validation — approved #7 (zod boundary shape, not the rounding decision itself)", () => {
  it("confirmFreshSaleSchema applies payment-split defaults of 0", () => {
    const parsed = confirmFreshSaleSchema.parse({
      customerName: "Walk-in",
      customerVillage: "Anand",
      voucherDate: VOUCHER_DATE,
      lines: [{ productId: randomUUID(), unitRate: 100, billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
    });
    expect(parsed.paidCash).toBe(0);
    expect(parsed.paidBank).toBe(0);
    expect(parsed.creditUdhar).toBe(0);
  });
});

describe("getLastPrice — TDD §28.1 sale-side recall", () => {
  it("returns null when there is no prior confirmed sale for the pair", async () => {
    const freshCustomer = (await partyService.createParty(
      { type: "customer", name: `Recall Null Customer ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
      { userId: actor.userId, role: actor.role, branchId },
      await newIdempotencyKey("party:create"),
    )) as { data: { id: string; ledger: { id: string } } };
    createdPartyIds.push(freshCustomer.data.id);
    createdOtherLedgerIds.push(freshCustomer.data.ledger.id);

    const result = await saleService.getLastPrice(freshCustomer.data.id, productTaxableId, actor);
    expect(result).toBeNull();
  });

  it("recalls the most recent confirmed sale's rate, effectiveRate, date, and quantity (hand-worked)", async () => {
    // 4 @ 12000 paise, discount 2000: gross=48000, taxable=46000, 5% GST -> tax=2300 (cgst/sgst
    // 1150 each), grandTotal=48300. effectiveRate = round(48300/4) = 12075 (T-7b's formula).
    const key = await newIdempotencyKey("sale:confirm");
    const response = (await saleService.confirmSale(
      {
        customerId: customerIntraId,
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productTaxableId, unitRate: money(12_000), billedQty: 4, freeQty: 0, discount: money(2_000), priceIncludesGst: false }],
        paidCash: money(48_300),
        paidBank: 0,
        creditUdhar: 0,
      },
      actor,
      key,
    )) as SaleResponse;
    createdSaleIds.push(response.data.id);
    expect(response.data.grandTotal).toBe(48_300); // sanity check on the hand-worked numbers above

    const result = await saleService.getLastPrice(customerIntraId, productTaxableId, actor);
    expect(result).not.toBeNull();
    expect(result?.rate).toBe(12_000n); // prefill = unit_rate as entered, not net-of-discount
    expect(result?.effectiveRate).toBe(12_075n);
    expect(result?.quantity.toNumber()).toBe(4);
    expect(result?.date.toISOString().slice(0, 10)).toBe("2026-06-15");
  });

  it("ignores a parked (draft) sale — only status='confirmed' is recalled", async () => {
    const draftKey = await newIdempotencyKey("sale:draft");
    const draft = (await saleService.createDraft(
      {
        customerId: customerIntraId,
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productExemptId, unitRate: money(500), billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
      },
      actor,
      draftKey,
    )) as SaleResponse;
    createdSaleIds.push(draft.data.id);

    const result = await saleService.getLastPrice(customerIntraId, productExemptId, actor);
    expect(result).toBeNull();
  });
});

describe("getInvoicePayload — TDD §28.6 printable invoice payload", () => {
  it("assembles company/branch/sale/line-item data with a derived title and amount in words", async () => {
    const key = await newIdempotencyKey("sale:confirm");
    const response = (await saleService.confirmSale(
      {
        customerId: customerIntraId,
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productTaxableId, unitRate: money(10_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(105_000),
        paidBank: 0,
        creditUdhar: 0,
      },
      actor,
      key,
    )) as SaleResponse;
    createdSaleIds.push(response.data.id);

    // getInvoicePayload is called directly here (service layer, TDD §22.1) — bigint fields come
    // back raw, not serializeBigInt'd the way the controller/HTTP response would present them.
    const payload = (await saleService.getInvoicePayload(response.data.id, actor)) as {
      company: { businessName: string };
      branch: { name: string };
      documentTitle: string;
      amended: boolean;
      sale: { id: string; invoiceNumber: string; grandTotal: bigint; customer: { name: string } };
      lineItems: { productName: string; lineTotal: bigint }[];
      amountInWords: string;
    };

    expect(payload.documentTitle).toBe("Tax Invoice"); // all-taxable line, TDD §23.1 row 1
    expect(payload.amended).toBe(false);
    expect(payload.sale.id).toBe(response.data.id);
    expect(payload.sale.invoiceNumber).toBeTruthy();
    expect(payload.sale.grandTotal).toBe(105_000n);
    expect(payload.sale.customer.name).toBeTruthy();
    expect(payload.lineItems).toHaveLength(1);
    expect(payload.lineItems[0]?.lineTotal).toBe(105_000n);
    expect(payload.amountInWords).toContain("Rupees");
    expect(payload.company.businessName).toBeTruthy();
    expect(payload.branch.name).toContain("Sale Test Branch");
  }, 30_000);

  it("never surfaces the customer's live GSTIN — no snapshot column exists to freeze it against drift", async () => {
    // Regression guard for the live-join bug: a buyer who registers for GST AFTER a sale must
    // never have that later GSTIN appear on a reprint of the earlier bill (it can visibly
    // contradict a frozen bill_of_supply/tax_invoice document_type). Proven here by giving the
    // party a real gstin on file and asserting the payload still shows null.
    const registeredCustomer = (await partyService.createParty(
      {
        type: "customer",
        name: `Registered GSTIN Customer ${randomUUID()}`,
        village: "Anand",
        stateCode: "24",
        gstin: "24AAAAA0000A1Z5",
        openingBalance: 0,
      },
      { userId: actor.userId, role: actor.role, branchId },
      await newIdempotencyKey("party:create"),
    )) as { data: { id: string; ledger: { id: string } } };
    createdPartyIds.push(registeredCustomer.data.id);
    createdOtherLedgerIds.push(registeredCustomer.data.ledger.id);

    const key = await newIdempotencyKey("sale:confirm");
    const response = (await saleService.confirmSale(
      {
        customerId: registeredCustomer.data.id,
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productExemptId, unitRate: money(500), billedQty: 2, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(1_000),
        paidBank: 0,
        creditUdhar: 0,
      },
      actor,
      key,
    )) as SaleResponse;
    createdSaleIds.push(response.data.id);

    const payload = (await saleService.getInvoicePayload(response.data.id, actor)) as {
      sale: { customer: { gstin: string | null } };
    };
    expect(payload.sale.customer.gstin).toBeNull();
  });

  it("derives Bill of Supply for an all-exempt sale (TDD §23.1 row 2)", async () => {
    const key = await newIdempotencyKey("sale:confirm");
    const response = (await saleService.confirmSale(
      {
        customerName: "Walk-in",
        customerVillage: "Anand",
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productExemptId, unitRate: money(500), billedQty: 2, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(1_000),
        paidBank: 0,
        creditUdhar: 0,
      },
      actor,
      key,
    )) as SaleResponse;
    createdSaleIds.push(response.data.id);

    const payload = (await saleService.getInvoicePayload(response.data.id, actor)) as { documentTitle: string };
    expect(payload.documentTitle).toBe("Bill of Supply");
  });

  it("rejects a draft sale — no invoice number/stored totals exist yet to print", async () => {
    const draftKey = await newIdempotencyKey("sale:draft");
    const draft = (await saleService.createDraft(
      {
        customerName: "Parked",
        customerVillage: "Anand",
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productTaxableId, unitRate: money(1_000), billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
      },
      actor,
      draftKey,
    )) as SaleResponse;
    createdSaleIds.push(draft.data.id);

    await expect(saleService.getInvoicePayload(draft.data.id, actor)).rejects.toMatchObject({ code: "SALE_NOT_CONFIRMED" });
  });

  it("reports not-found for a sale outside the actor's branch (branch isolation)", async () => {
    const key = await newIdempotencyKey("sale:confirm");
    const response = (await saleService.confirmSale(
      {
        customerName: "Walk-in",
        customerVillage: "Anand",
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productTaxableId, unitRate: money(1_000), billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(1_050),
        paidBank: 0,
        creditUdhar: 0,
      },
      actor,
      key,
    )) as SaleResponse;
    createdSaleIds.push(response.data.id);

    const otherBranchActor: saleService.SaleActor = { ...actor, branchId: noCashBranchId };
    await expect(saleService.getInvoicePayload(response.data.id, otherBranchActor)).rejects.toMatchObject({ code: "SALE_NOT_FOUND" });
  });

  it("flags amended:true from an audit_logs update row (simulated directly — editSale's own coverage is in the §28.4 suite below)", async () => {
    const key = await newIdempotencyKey("sale:confirm");
    const response = (await saleService.confirmSale(
      {
        customerName: "Walk-in",
        customerVillage: "Anand",
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productTaxableId, unitRate: money(1_000), billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(1_050),
        paidBank: 0,
        creditUdhar: 0,
      },
      actor,
      key,
    )) as SaleResponse;
    createdSaleIds.push(response.data.id);

    await prisma.auditLog.create({
      data: { userId: actor.userId, branchId: actor.branchId, action: "update", entityType: "sale", entityId: response.data.id },
    });

    const payload = (await saleService.getInvoicePayload(response.data.id, actor)) as { amended: boolean };
    expect(payload.amended).toBe(true);
  }, 30_000);
});

describe("sale:editCancel capability — Blueprint §6.11 (Super Admin/Admin only, never Employee)", () => {
  it("allows super_admin and admin, rejects employee and accountant", () => {
    const next: NextFunction = () => undefined;
    for (const role of ["super_admin", "admin"] satisfies Role[]) {
      const req = { auth: { userId: "x", role, branchId: "y" } } as unknown as Request;
      expect(() => requireCap("sale:editCancel")(req, {} as Response, next)).not.toThrow();
    }
    for (const role of ["employee", "accountant"] satisfies Role[]) {
      const req = { auth: { userId: "x", role, branchId: "y" } } as unknown as Request;
      expect(() => requireCap("sale:editCancel")(req, {} as Response, next)).toThrow();
    }
  });
});

describe("editSale / cancelSale — TDD §28.4 (bill edit/cancel workflow)", () => {
  it("rejects editing or cancelling a draft sale", async () => {
    const draftKey = await newIdempotencyKey("sale:draft");
    const draft = (await saleService.createDraft(
      {
        customerName: "Parked",
        customerVillage: "Anand",
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productTaxableId, unitRate: money(1_000), billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
      },
      actor,
      draftKey,
    )) as SaleResponse;
    createdSaleIds.push(draft.data.id);

    const editKey = await newIdempotencyKey("sale:edit");
    await expect(
      saleService.editSale(
        draft.data.id,
        { lines: [{ productId: productTaxableId, unitRate: money(1_000), billedQty: 2, freeQty: 0, discount: 0, priceIncludesGst: false }] },
        actor,
        editKey,
      ),
    ).rejects.toMatchObject({ code: "SALE_NOT_CONFIRMED", details: { status: "draft" } });

    const cancelKey = await newIdempotencyKey("sale:cancel");
    await expect(saleService.cancelSale(draft.data.id, { cancelReason: "test" }, actor, cancelKey)).rejects.toMatchObject({
      code: "SALE_NOT_CONFIRMED",
      details: { status: "draft" },
    });
  });

  it("rejects editing or cancelling an already-cancelled sale", async () => {
    const key = await newIdempotencyKey("sale:confirm");
    const sale = (await saleService.confirmSale(
      {
        customerName: "Walk-in",
        customerVillage: "Anand",
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productTaxableId, unitRate: money(1_000), billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(1_050),
        paidBank: 0,
        creditUdhar: 0,
      },
      actor,
      key,
    )) as SaleResponse;
    createdSaleIds.push(sale.data.id);

    const cancelKey = await newIdempotencyKey("sale:cancel");
    await saleService.cancelSale(sale.data.id, { cancelReason: "wrong entry" }, actor, cancelKey);

    const editKey = await newIdempotencyKey("sale:edit");
    await expect(
      saleService.editSale(
        sale.data.id,
        { lines: [{ productId: productTaxableId, unitRate: money(1_000), billedQty: 2, freeQty: 0, discount: 0, priceIncludesGst: false }] },
        actor,
        editKey,
      ),
    ).rejects.toMatchObject({ code: "SALE_NOT_CONFIRMED", details: { status: "cancelled" } });

    const cancelAgainKey = await newIdempotencyKey("sale:cancel");
    await expect(saleService.cancelSale(sale.data.id, { cancelReason: "again" }, actor, cancelAgainKey)).rejects.toMatchObject({
      code: "SALE_NOT_CONFIRMED",
      details: { status: "cancelled" },
    });
  });

  it("cancelSaleSchema requires a non-empty cancel_reason", () => {
    expect(cancelSaleSchema.safeParse({}).success).toBe(false);
    expect(cancelSaleSchema.safeParse({ cancelReason: "" }).success).toBe(false);
    expect(cancelSaleSchema.safeParse({ cancelReason: "customer changed mind" }).success).toBe(true);
  });

  it(
    "reassigns the sale to a genuinely different customer — reverses the OLD customer's ledger via the sale's stored reference (even after that customer is deactivated) and debits the NEW one",
    async () => {
      const customerOld = (await partyService.createParty(
        { type: "customer", name: `Reassign Old Customer ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
        { userId: actor.userId, role: actor.role, branchId },
        await newIdempotencyKey("party:create"),
      )) as { data: { id: string; ledger: { id: string } } };
      createdPartyIds.push(customerOld.data.id);
      createdOtherLedgerIds.push(customerOld.data.ledger.id);

      const customerNew = (await partyService.createParty(
        { type: "customer", name: `Reassign New Customer ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
        { userId: actor.userId, role: actor.role, branchId },
        await newIdempotencyKey("party:create"),
      )) as { data: { id: string; ledger: { id: string } } };
      createdPartyIds.push(customerNew.data.id);
      createdOtherLedgerIds.push(customerNew.data.ledger.id);

      const key = await newIdempotencyKey("sale:confirm");
      const sale = (await saleService.confirmSale(
        {
          customerId: customerOld.data.id,
          voucherDate: VOUCHER_DATE,
          lines: [{ productId: productTaxableId, unitRate: money(10_000), billedQty: 5, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: 0,
          paidBank: 0,
          creditUdhar: money(52_500), // 5*10000=50000 taxable, 5% -> 2500 tax, grand 52500
        },
        actor,
        key,
      )) as SaleResponse;
      createdSaleIds.push(sale.data.id);
      expect(await ledgerBalance(customerOld.data.ledger.id)).toBe(52_500n);
      expect(await ledgerBalance(customerNew.data.ledger.id)).toBe(0n);

      // The old customer is deactivated BETWEEN the original sale and this edit — the reversal
      // must still succeed against them (it's undoing a ledger hit they already received, not
      // validating them as eligible for a new transaction).
      await partyService.deactivateParty(
        customerOld.data.id,
        { userId: actor.userId, role: actor.role, branchId },
        await newIdempotencyKey("party:deactivate"),
      );

      const editKey = await newIdempotencyKey("sale:edit");
      const edited = (await saleService.editSale(
        sale.data.id,
        {
          customerId: customerNew.data.id,
          lines: [{ productId: productTaxableId, unitRate: money(10_000), billedQty: 5, freeQty: 0, discount: 0, priceIncludesGst: false }],
        },
        actor,
        editKey,
      )) as SaleResponse & { data: { customerId: string | null } };

      expect(edited.data.customerId).toBe(customerNew.data.id);
      expect(edited.data.grandTotal).toBe(52_500);
      expect(edited.data.creditUdhar).toBe(52_500);

      // OLD customer: fully reversed, despite being deactivated in between.
      expect(await ledgerBalance(customerOld.data.ledger.id)).toBe(0n);
      // NEW customer: correctly debited for the re-applied charge.
      expect(await ledgerBalance(customerNew.data.ledger.id)).toBe(52_500n);

      // Audit: the customer change itself is in the before/after snapshot, not just totals/lines.
      const auditRow = await prisma.auditLog.findFirst({
        where: { entityType: "sale", entityId: sale.data.id, action: "update" },
        orderBy: { createdAt: "desc" },
      });
      expect(auditRow).not.toBeNull();
      const before = auditRow!.before as { customerId: string | null; customerName?: string };
      const after = auditRow!.after as { customerId: string | null; customerName?: string };
      expect(before.customerId).toBe(customerOld.data.id);
      expect(after.customerId).toBe(customerNew.data.id);
      expect(before.customerName).not.toBe(after.customerName);
    },
    30_000,
  );

  it(
    "reverses old postings/movements append-only (originals untouched) and re-applies new ones, each posting set summing to zero independently",
    async () => {
      // All-credit intra-state sale so every posting is a clean, distinguishable amount.
      const key = await newIdempotencyKey("sale:confirm");
      const sale = (await saleService.confirmSale(
        {
          customerId: customerIntraId,
          voucherDate: VOUCHER_DATE,
          lines: [{ productId: productTaxableId, unitRate: money(10_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: 0,
          paidBank: 0,
          creditUdhar: money(105_000),
        },
        actor,
        key,
      )) as SaleResponse;
      createdSaleIds.push(sale.data.id);

      const originalPostings = await prisma.ledgerPosting.findMany({ where: { voucherType: "sale", voucherId: sale.data.id } });
      const originalMovements = await prisma.stockMovement.findMany({ where: { voucherType: "sale", voucherId: sale.data.id } });
      expect(originalMovements).toHaveLength(1);
      expect(originalMovements[0]?.movementType).toBe("sale_out");
      const originalMovementSnapshot = originalMovements[0]!;

      // Edit: 10@10000 (taxable100000,cgst2500,sgst2500,grand105000) -> 6@12000
      // (taxable72000,cgst1800,sgst1800,grand75600). All-credit throughout, so creditUdhar just
      // tracks grandTotal.
      const editKey = await newIdempotencyKey("sale:edit");
      const edited = (await saleService.editSale(
        sale.data.id,
        { lines: [{ productId: productTaxableId, unitRate: money(12_000), billedQty: 6, freeQty: 0, discount: 0, priceIncludesGst: false }] },
        actor,
        editKey,
      )) as SaleResponse;
      expect(edited.data.totalTaxable).toBe(72_000);
      expect(edited.data.totalCgst).toBe(1_800);
      expect(edited.data.totalSgst).toBe(1_800);
      expect(edited.data.grandTotal).toBe(75_600);
      expect(edited.data.creditUdhar).toBe(75_600);

      // Original rows physically untouched (append-only — never mutated).
      const originalMovementAfter = await prisma.stockMovement.findUniqueOrThrow({ where: { id: originalMovementSnapshot.id } });
      expect(originalMovementAfter.movementType).toBe("sale_out");
      expect(originalMovementAfter.rate).toBe(originalMovementSnapshot.rate);
      expect(originalMovementAfter.value).toBe(originalMovementSnapshot.value);
      expect(originalMovementAfter.quantityDelta.toNumber()).toBeCloseTo(originalMovementSnapshot.quantityDelta.toNumber(), 6);
      for (const p of originalPostings) {
        const stillThere = await prisma.ledgerPosting.findUniqueOrThrow({ where: { id: p.id } });
        expect(stillThere.amount).toBe(p.amount);
        expect(stillThere.ledgerId).toBe(p.ledgerId);
      }

      // New movement rows: exactly one reversal (sale_reversal_in, restoring the original 10 at
      // the original out-rate) + one re-apply (sale_out, the new 6).
      const allMovements = await prisma.stockMovement.findMany({ where: { voucherType: "sale", voucherId: sale.data.id } });
      expect(allMovements).toHaveLength(3);
      const reversalMovement = allMovements.find((m) => m.movementType === "sale_reversal_in")!;
      expect(reversalMovement.quantityDelta.toNumber()).toBeCloseTo(10, 6);
      expect(reversalMovement.rate).toBe(originalMovementSnapshot.rate); // "at the original out-rate"
      expect(reversalMovement.referenceMovementId).toBe(originalMovementSnapshot.id);
      const reapplyMovement = allMovements.find((m) => m.movementType === "sale_out" && m.id !== originalMovementSnapshot.id)!;
      expect(reapplyMovement.quantityDelta.toNumber()).toBeCloseTo(-6, 6);
      expect(reapplyMovement.rate).toBe(originalMovementSnapshot.rate); // avg_cost never moved (no purchase happened)

      // New posting rows: partition into the reversal set (each exactly negates one original
      // posting) and the remainder (the re-apply set) — assert both sum to zero INDEPENDENTLY,
      // not just their combined total (which would be trivially zero either way).
      const allPostingsAfter = await prisma.ledgerPosting.findMany({ where: { voucherType: "sale", voucherId: sale.data.id } });
      const originalIds = new Set(originalPostings.map((p) => p.id));
      const newPostings = allPostingsAfter.filter((p) => !originalIds.has(p.id));

      const remainingOriginal = [...originalPostings];
      const reversalSet: typeof newPostings = [];
      const reapplySet: typeof newPostings = [];
      for (const p of newPostings) {
        const matchIndex = remainingOriginal.findIndex((o) => o.ledgerId === p.ledgerId && o.amount === -p.amount);
        if (matchIndex >= 0) {
          reversalSet.push(p);
          remainingOriginal.splice(matchIndex, 1);
        } else {
          reapplySet.push(p);
        }
      }
      expect(reversalSet).toHaveLength(originalPostings.length);
      expect(remainingOriginal).toHaveLength(0); // every original posting was reversed exactly once
      expect(reversalSet.reduce((s, p) => s + p.amount, 0n)).toBe(0n);
      expect(reapplySet.reduce((s, p) => s + p.amount, 0n)).toBe(0n);
      // Hand-verified re-apply amounts (all-credit, intra-state): Dr customer +75600, Cr Sales
      // -72000, Cr CGST -1800, Cr SGST -1800.
      expect(reapplySet).toHaveLength(4);
    },
    30_000,
  );

  it(
    "composes reversal + re-apply with the partially-paid auto-adjust exactly, across two successive edits (Blueprint §6.11 worked example)",
    async () => {
      const customer = (await partyService.createParty(
        { type: "customer", name: `Worked Example Customer ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
        { userId: actor.userId, role: actor.role, branchId },
        await newIdempotencyKey("party:create"),
      )) as { data: { id: string; ledger: { id: string } } };
      createdPartyIds.push(customer.data.id);
      createdOtherLedgerIds.push(customer.data.ledger.id);

      // Original: 3 units @ ₹1000 of the EXEMPT product (0% GST, keeps every figure exactly the
      // rupee amounts Blueprint §6.11's own worked example uses) = ₹3000. Paid ₹1000 cash, ₹2000
      // udhar — the example's own opening numbers.
      const key = await newIdempotencyKey("sale:confirm");
      const sale = (await saleService.confirmSale(
        {
          customerId: customer.data.id,
          voucherDate: VOUCHER_DATE,
          lines: [{ productId: productExemptId, unitRate: money(100_000), billedQty: 3, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: money(100_000),
          paidBank: 0,
          creditUdhar: money(200_000),
        },
        actor,
        key,
      )) as SaleResponse;
      createdSaleIds.push(sale.data.id);
      expect(sale.data.grandTotal).toBe(300_000);
      expect(await ledgerBalance(customer.data.ledger.id)).toBe(200_000n);

      // Edit 1: qty 3 -> 2.5 => new total ₹2500. paid_cash stays fixed at ₹1000; udhar 2000 -> 1500.
      const editKey1 = await newIdempotencyKey("sale:edit");
      const edited1 = (await saleService.editSale(
        sale.data.id,
        { lines: [{ productId: productExemptId, unitRate: money(100_000), billedQty: 2.5, freeQty: 0, discount: 0, priceIncludesGst: false }] },
        actor,
        editKey1,
      )) as SaleResponse;
      expect(edited1.data.grandTotal).toBe(250_000);
      expect(edited1.data.paidCash).toBe(100_000); // frozen — real cash already collected
      expect(edited1.data.paidBank).toBe(0);
      expect(edited1.data.creditUdhar).toBe(150_000);
      expect(await ledgerBalance(customer.data.ledger.id)).toBe(150_000n);

      // Edit 2 — editing the ALREADY-EDITED sale, proving the reversal is multi-edit-safe (it
      // reconstructs from the sale's current stored header, not a naive query-and-negate of every
      // historical posting row, which would double-undo history here). qty 2.5 -> 0.8 => new total
      // ₹800, below the ₹1000 already paid ⇒ credit_udhar = 800 - 1000 = -200: Blueprint §6.11's
      // negative-udhar customer-advance case.
      const editKey2 = await newIdempotencyKey("sale:edit");
      const edited2 = (await saleService.editSale(
        sale.data.id,
        { lines: [{ productId: productExemptId, unitRate: money(100_000), billedQty: 0.8, freeQty: 0, discount: 0, priceIncludesGst: false }] },
        actor,
        editKey2,
      )) as SaleResponse;
      expect(edited2.data.grandTotal).toBe(80_000);
      expect(edited2.data.paidCash).toBe(100_000); // still exactly the original real cash
      expect(edited2.data.creditUdhar).toBe(-20_000);
      expect(await ledgerBalance(customer.data.ledger.id)).toBe(-20_000n);

      // Stock: only the FINAL applied qty (0.8) ends up net-consumed — not the sum of every
      // intermediate edit's qty — proving each edit correctly backs out the prior state first.
      // quantityDelta is already signed (+in/-out, §25.7), so summing this voucher's movements
      // directly gives its net effect on branch_stock.
      const movements = await prisma.stockMovement.findMany({ where: { voucherType: "sale", voucherId: sale.data.id } });
      const netFromMovements = movements.reduce((sum, m) => sum + m.quantityDelta.toNumber(), 0);
      expect(netFromMovements).toBeCloseTo(-0.8, 6);
    },
    30_000,
  );

  it(
    "editing to new line values nets the same stock/ledger effect as entering those values fresh",
    async () => {
      const product = await prisma.product.create({
        data: { name: `Equivalence Product ${randomUUID()}`, hsnCode: "31051000", unitId, gstRate: 5, taxClassification: "taxable" },
      });
      createdProductIds.push(product.id);
      await seedStock(branchId, product.id, 1_000, 6_000);

      const customerA = (await partyService.createParty(
        { type: "customer", name: `Equivalence Customer A ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
        { userId: actor.userId, role: actor.role, branchId },
        await newIdempotencyKey("party:create"),
      )) as { data: { id: string; ledger: { id: string } } };
      createdPartyIds.push(customerA.data.id);
      createdOtherLedgerIds.push(customerA.data.ledger.id);

      const customerB = (await partyService.createParty(
        { type: "customer", name: `Equivalence Customer B ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
        { userId: actor.userId, role: actor.role, branchId },
        await newIdempotencyKey("party:create"),
      )) as { data: { id: string; ledger: { id: string } } };
      createdPartyIds.push(customerB.data.id);
      createdOtherLedgerIds.push(customerB.data.ledger.id);

      // Edit path: confirm 10@10000 (grand 105000), then edit down to 6@12000 (grand 75600).
      const keyA = await newIdempotencyKey("sale:confirm");
      const saleA = (await saleService.confirmSale(
        {
          customerId: customerA.data.id,
          voucherDate: VOUCHER_DATE,
          lines: [{ productId: product.id, unitRate: money(10_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: 0,
          paidBank: 0,
          creditUdhar: money(105_000),
        },
        actor,
        keyA,
      )) as SaleResponse;
      createdSaleIds.push(saleA.data.id);

      const editKeyA = await newIdempotencyKey("sale:edit");
      const editedA = (await saleService.editSale(
        saleA.data.id,
        { lines: [{ productId: product.id, unitRate: money(12_000), billedQty: 6, freeQty: 0, discount: 0, priceIncludesGst: false }] },
        actor,
        editKeyA,
      )) as SaleResponse;
      expect(editedA.data.grandTotal).toBe(75_600);
      expect(editedA.data.creditUdhar).toBe(75_600);

      const stockAfterEdit = await prisma.branchStock.findUniqueOrThrow({
        where: { branchId_productId: { branchId, productId: product.id } },
      });
      const ledgerAfterEdit = await ledgerBalance(customerA.data.ledger.id);

      // Direct path: confirm 6@12000 straight away on the SAME stock pool (already sitting at the
      // edit path's post-edit quantity) with a DIFFERENT customer, so their ledger starts at 0.
      const keyB = await newIdempotencyKey("sale:confirm");
      const saleB = (await saleService.confirmSale(
        {
          customerId: customerB.data.id,
          voucherDate: VOUCHER_DATE,
          lines: [{ productId: product.id, unitRate: money(12_000), billedQty: 6, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: 0,
          paidBank: 0,
          creditUdhar: money(75_600),
        },
        actor,
        keyB,
      )) as SaleResponse;
      createdSaleIds.push(saleB.data.id);
      expect(saleB.data.grandTotal).toBe(75_600);

      const stockAfterDirect = await prisma.branchStock.findUniqueOrThrow({
        where: { branchId_productId: { branchId, productId: product.id } },
      });
      const ledgerAfterDirect = await ledgerBalance(customerB.data.ledger.id);

      // Both paths consumed exactly 6 units of the same starting pool — the direct sale's own
      // consumption is the second -6 stacked on top of the edit path's already-applied -6.
      expect(stockAfterEdit.quantity.toNumber()).toBeCloseTo(1_000 - 6, 6);
      expect(stockAfterDirect.quantity.toNumber()).toBeCloseTo(1_000 - 6 - 6, 6);
      // Ledger equivalence: a customer whose only transaction is "6@12000 on credit" ends up with
      // the identical receivable whether it came from a fresh entry or an edit's re-apply.
      expect(ledgerAfterEdit).toBe(75_600n);
      expect(ledgerAfterDirect).toBe(75_600n);

      // Same avg_cost (6000, unmoved throughout — no purchase happened) drove both COGS rates.
      const editReapplyMovement = await prisma.stockMovement.findFirst({
        where: { voucherType: "sale", voucherId: saleA.data.id, movementType: "sale_out" },
        orderBy: { createdAt: "desc" },
      });
      const directMovement = await prisma.stockMovement.findFirst({
        where: { voucherType: "sale", voucherId: saleB.data.id, movementType: "sale_out" },
      });
      expect(editReapplyMovement?.rate).toBe(6_000n);
      expect(directMovement?.rate).toBe(6_000n);
      expect(editReapplyMovement?.value).toBe(directMovement?.value); // 6 units @ 6000 either way
    },
    30_000,
  );

  it(
    "cancelSale reverses stock/ledger, retains the invoice number (never reissued), and requires a mandatory reason",
    async () => {
      const customer = (await partyService.createParty(
        { type: "customer", name: `Cancel Customer ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
        { userId: actor.userId, role: actor.role, branchId },
        await newIdempotencyKey("party:create"),
      )) as { data: { id: string; ledger: { id: string } } };
      createdPartyIds.push(customer.data.id);
      createdOtherLedgerIds.push(customer.data.ledger.id);

      const stockBefore = await prisma.branchStock.findUniqueOrThrow({
        where: { branchId_productId: { branchId, productId: productTaxableId } },
      });

      const key = await newIdempotencyKey("sale:confirm");
      const sale = (await saleService.confirmSale(
        {
          customerId: customer.data.id,
          voucherDate: VOUCHER_DATE,
          lines: [{ productId: productTaxableId, unitRate: money(10_000), billedQty: 4, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: 0,
          paidBank: 0,
          creditUdhar: money(42_000),
        },
        actor,
        key,
      )) as SaleResponse;
      createdSaleIds.push(sale.data.id);
      expect(await ledgerBalance(customer.data.ledger.id)).toBe(42_000n);

      const cancelKey = await newIdempotencyKey("sale:cancel");
      const cancelled = (await saleService.cancelSale(sale.data.id, { cancelReason: "customer changed their mind" }, actor, cancelKey)) as {
        data: { status: string; invoiceNumber: string; cancelReason: string };
      };

      expect(cancelled.data.status).toBe("cancelled");
      expect(cancelled.data.invoiceNumber).toBe(sale.data.invoiceNumber); // retained, not reissued
      expect(cancelled.data.cancelReason).toBe("customer changed their mind");

      // Ledger fully unwound.
      expect(await ledgerBalance(customer.data.ledger.id)).toBe(0n);
      // Stock fully restored to its pre-sale level.
      const stockAfter = await prisma.branchStock.findUniqueOrThrow({
        where: { branchId_productId: { branchId, productId: productTaxableId } },
      });
      expect(stockAfter.quantity.toNumber()).toBeCloseTo(stockBefore.quantity.toNumber(), 6);

      // The number-series counter isn't rewound — a later confirm gets a strictly different
      // number, so the cancelled one can never come back into circulation (the partial unique
      // index also enforces this at the DB level; this proves the service doesn't try to work
      // around it by, say, reusing the freed-looking number).
      const nextKey = await newIdempotencyKey("sale:confirm");
      const nextSale = (await saleService.confirmSale(
        {
          customerName: "Walk-in",
          customerVillage: "Anand",
          voucherDate: VOUCHER_DATE,
          lines: [{ productId: productTaxableId, unitRate: money(1_000), billedQty: 1, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: money(1_050),
          paidBank: 0,
          creditUdhar: 0,
        },
        actor,
        nextKey,
      )) as SaleResponse;
      createdSaleIds.push(nextSale.data.id);
      expect(nextSale.data.invoiceNumber).not.toBe(sale.data.invoiceNumber);

      // Audit: a real before/after status-transition snapshot (§13's edit exception), not
      // reference-only.
      const auditRow = await prisma.auditLog.findFirst({
        where: { entityType: "sale", entityId: sale.data.id, action: "cancel" },
        orderBy: { createdAt: "desc" },
      });
      expect(auditRow).not.toBeNull();
      expect(auditRow?.before).not.toBeNull();
      expect(auditRow?.after).not.toBeNull();
      const before = auditRow!.before as { status: string };
      const after = auditRow!.after as { status: string; cancelReason: string };
      expect(before.status).toBe("confirmed");
      expect(after.status).toBe("cancelled");
      expect(after.cancelReason).toBe("customer changed their mind");
    },
    30_000,
  );
});
