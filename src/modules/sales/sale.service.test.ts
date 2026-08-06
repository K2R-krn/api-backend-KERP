import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import * as partyService from "./../parties/party.service.js";
import * as saleService from "./sale.service.js";
import type { SaleActor } from "./sale.service.js";
import { confirmFreshSaleSchema, createDraftSaleSchema } from "./sale.validation.js";

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
});

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
