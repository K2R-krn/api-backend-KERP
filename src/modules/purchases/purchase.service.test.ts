import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import * as partyService from "./../parties/party.service.js";
import * as purchaseService from "./purchase.service.js";
import type { PurchaseActor } from "./purchase.service.js";

// TDD §22.1: service-layer tests run against the real dev DB, no mocks — the row lock, the GST
// math, and the stock/ledger side effects are exactly the things under test here. Mirrors
// sale.service.test.ts's structure; company_profile.purchasesLedgerId already links a real
// "Purchases" ledger (this session's Step 0 migration + seed backfill, verified separately).

interface PurchaseLine {
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

interface PurchaseData {
  id: string;
  status: string;
  voucherNumber: string | null;
  totalTaxable: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  roundOff: number;
  grandTotal: number;
  paidCash: number;
  paidBank: number;
  creditToSupplier: number;
  lineItems: PurchaseLine[];
}

interface PurchaseResponse {
  data: PurchaseData;
}

let branchId: string;
let branchCashLedgerId: string;
let bankLedgerId: string;
let unitId: string;
let actor: PurchaseActor;

let supplierIntraId: string; // party, stateCode 24 (same as branch)
let supplierInterId: string; // party, stateCode 27 (different from branch)
let customerOnlyId: string; // party, type "customer" — for the PARTY_NOT_SUPPLIER rejection

const createdBranchIds: string[] = [];
const createdCashLedgerIds: string[] = [];
const createdOtherLedgerIds: string[] = [];
const createdPartyIds: string[] = [];
const createdProductIds: string[] = [];
const createdUnitIds: string[] = [];
const createdIdempotencyKeys: string[] = [];
const createdPurchaseIds: string[] = [];

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

async function newProduct(gstRate: number, taxClassification = "taxable"): Promise<string> {
  const product = await prisma.product.create({
    data: { name: `Test Purchase Product ${randomUUID()}`, unitId, gstRate, taxClassification },
  });
  createdProductIds.push(product.id);
  return product.id;
}

async function seedStock(productId: string, quantity: number, avgCost: number): Promise<void> {
  await prisma.branchStock.create({ data: { branchId, productId, quantity, avgCost: BigInt(avgCost) } });
}

async function assertPostingsSumToZero(purchaseId: string) {
  const postings = await prisma.ledgerPosting.findMany({ where: { voucherType: "purchase", voucherId: purchaseId } });
  const sum = postings.reduce((acc, p) => acc + p.amount, 0n);
  expect(sum).toBe(0n);
  return postings;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      username: `purchasetest_${randomUUID()}`,
      passwordHash: "unused",
      name: "Purchase Service Test User",
      role: "admin",
      isActive: true,
      mustChangePassword: false,
    },
  });

  const branch = await prisma.branch.create({
    data: { name: `Purchase Test Branch ${randomUUID()}`, code: `PT${randomUUID().slice(0, 6)}`, stateCode: "24" },
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

  actor = { userId: user.id, role: "admin", branchId };

  const unit = await prisma.unit.create({ data: { name: `Test Kilogram ${randomUUID()}`, symbol: "kg" } });
  unitId = unit.id;
  createdUnitIds.push(unitId);

  const intra = (await partyService.createParty(
    { type: "supplier", name: `Test Intra Supplier ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
    { userId: actor.userId, role: actor.role, branchId },
    await newIdempotencyKey("party:create"),
  )) as { data: { id: string; ledgerId: string; ledger: { id: string } } };
  supplierIntraId = intra.data.id;
  createdPartyIds.push(intra.data.id);
  createdOtherLedgerIds.push(intra.data.ledger.id);

  const inter = (await partyService.createParty(
    { type: "supplier", name: `Test Inter Supplier ${randomUUID()}`, village: "Pune", stateCode: "27", openingBalance: 0 },
    { userId: actor.userId, role: actor.role, branchId },
    await newIdempotencyKey("party:create"),
  )) as { data: { id: string; ledgerId: string; ledger: { id: string } } };
  supplierInterId = inter.data.id;
  createdPartyIds.push(inter.data.id);
  createdOtherLedgerIds.push(inter.data.ledger.id);

  const customerOnly = (await partyService.createParty(
    { type: "customer", name: `Test Customer Only ${randomUUID()}`, village: "Anand", stateCode: "24", openingBalance: 0 },
    { userId: actor.userId, role: actor.role, branchId },
    await newIdempotencyKey("party:create"),
  )) as { data: { id: string; ledgerId: string; ledger: { id: string } } };
  customerOnlyId = customerOnly.data.id;
  createdPartyIds.push(customerOnly.data.id);
  createdOtherLedgerIds.push(customerOnly.data.ledger.id);
}, 30_000);

afterEach(async () => {
  if (createdIdempotencyKeys.length) {
    await prisma.idempotencyKey.deleteMany({ where: { key: { in: createdIdempotencyKeys } } });
    createdIdempotencyKeys.length = 0;
  }
});

afterAll(async () => {
  // Children-before-parents, matching the RESTRICT delete rules on the transaction schema's FKs.
  await prisma.ledgerPosting.deleteMany({ where: { branchId: { in: createdBranchIds } } });
  await prisma.stockMovement.deleteMany({ where: { branchId: { in: createdBranchIds } } });
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

  const leftoverPurchases = await prisma.purchase.count({ where: { branchId: { in: createdBranchIds } } });
  if (leftoverPurchases > 0) {
    throw new Error("purchase.service.test.ts left purchase rows behind — cleanup did not fully succeed");
  }
  // getLastCost's additions push createdPurchaseIds past what the golden-math suite alone left to
  // clean up — raised past vitest.config.ts's global 15s hookTimeout for the same remote-DB-latency
  // reason as sale.service.test.ts's afterAll.
}, 30_000);

describe("confirmPurchase — golden-math suite (TDD §27/§22.1)", () => {
  it("computes a basic exclusive-GST purchase exactly (hand-calculated)", async () => {
    // 10 kg @ ₹50 (5000 paise), 5% GST, exclusive, no discount, intra-state, full cash.
    // taxable=50000, tax=round(50000*0.05)=2500, cgst=1250, sgst=1250, grand=52500.
    const productId = await newProduct(5);
    const key = await newIdempotencyKey("purchase:confirm");
    const response = (await purchaseService.confirmPurchase(
      {
        supplierId: supplierIntraId,
        voucherDate: VOUCHER_DATE,
        lines: [{ productId, unitRate: money(5_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(52_500),
        paidBank: 0,
        creditToSupplier: 0,
      },
      actor,
      key,
    )) as PurchaseResponse;
    createdPurchaseIds.push(response.data.id);

    expect(response.data.status).toBe("confirmed");
    expect(response.data.voucherNumber).toBeTruthy();
    expect(response.data.totalTaxable).toBe(50_000);
    expect(response.data.totalCgst).toBe(1_250);
    expect(response.data.totalSgst).toBe(1_250);
    expect(response.data.totalIgst).toBe(0);
    expect(response.data.roundOff).toBe(0);
    expect(response.data.grandTotal).toBe(52_500);
    expect(response.data.lineItems).toHaveLength(1);
    expect(response.data.lineItems[0]?.taxableValue).toBe(50_000);
    expect(response.data.lineItems[0]?.lineTotal).toBe(52_500);

    const postings = await assertPostingsSumToZero(response.data.id);
    const byLedger = new Map(postings.map((p) => [p.ledgerId, p.amount]));
    const profile = await prisma.companyProfile.findFirstOrThrow({ where: { deletedAt: null } });
    expect(byLedger.get(profile.purchasesLedgerId!)).toBe(50_000n); // Dr Purchases
    expect(byLedger.get(profile.cgstLedgerId!)).toBe(1_250n); // Dr GST-input
    expect(byLedger.get(profile.sgstLedgerId!)).toBe(1_250n);
    expect(byLedger.get(branchCashLedgerId)).toBe(-52_500n); // Cr Cash
  });

  it(
    "computes an inclusive-GST purchase with an exact back-calc, and avg_cost excludes the embedded GST",
    async () => {
      // 5 kg @ ₹21.00 inclusive (2100 paise), 5% GST -> gross=10500, taxable=round(10500*10000/10500)=10000,
      // tax=10500-10000=500 exactly. This session's resolved decision: the cost basis feeding
      // avg_cost is `taxableValue` (10000), NOT the raw discountedAmount (10500) — recoverable
      // input GST is never part of inventory cost. If this regressed to the gross figure, avg_cost
      // would land on 2100/unit instead of the correct 2000/unit below.
      const productId = await newProduct(5);
      const key = await newIdempotencyKey("purchase:confirm");
      const response = (await purchaseService.confirmPurchase(
        {
          supplierId: supplierIntraId,
          voucherDate: VOUCHER_DATE,
          lines: [{ productId, unitRate: money(2_100), billedQty: 5, freeQty: 0, discount: 0, priceIncludesGst: true }],
          paidCash: money(10_500),
          paidBank: 0,
          creditToSupplier: 0,
        },
        actor,
        key,
      )) as PurchaseResponse;
      createdPurchaseIds.push(response.data.id);

      expect(response.data.totalTaxable).toBe(10_000);
      expect(response.data.totalCgst).toBe(250);
      expect(response.data.totalSgst).toBe(250);
      expect(response.data.grandTotal).toBe(10_500);

      // value fed to avg_cost = taxableValue = 10000 (tax-excluded), in_qty = 5 units, starting
      // from a fresh product (no prior branch_stock row, old_qty=0, old_avg=0):
      // new_avg = round((0*0 + 10000*1000) / (0 + 5000)) = round(10,000,000 / 5000) = 2000 exact.
      const stock = await prisma.branchStock.findUniqueOrThrow({ where: { branchId_productId: { branchId, productId } } });
      expect(stock.avgCost).toBe(2_000n); // NOT 2100 — that would mean embedded GST leaked into cost.
      expect(stock.quantity.toNumber()).toBe(5);

      await assertPostingsSumToZero(response.data.id);
    },
  );

  it("posts CGST+SGST intra-state and IGST inter-state, split correctly", async () => {
    const productA = await newProduct(5);
    const intraKey = await newIdempotencyKey("purchase:confirm");
    const intra = (await purchaseService.confirmPurchase(
      {
        supplierId: supplierIntraId,
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productA, unitRate: money(5_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(52_500),
        paidBank: 0,
        creditToSupplier: 0,
      },
      actor,
      intraKey,
    )) as PurchaseResponse;
    createdPurchaseIds.push(intra.data.id);
    expect(intra.data.totalCgst).toBe(1_250);
    expect(intra.data.totalSgst).toBe(1_250);
    expect(intra.data.totalIgst).toBe(0);
    await assertPostingsSumToZero(intra.data.id);

    const productB = await newProduct(5);
    const interKey = await newIdempotencyKey("purchase:confirm");
    const inter = (await purchaseService.confirmPurchase(
      {
        supplierId: supplierInterId,
        voucherDate: VOUCHER_DATE,
        lines: [{ productId: productB, unitRate: money(5_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(52_500),
        paidBank: 0,
        creditToSupplier: 0,
      },
      actor,
      interKey,
    )) as PurchaseResponse;
    createdPurchaseIds.push(inter.data.id);
    expect(inter.data.totalCgst).toBe(0);
    expect(inter.data.totalSgst).toBe(0);
    expect(inter.data.totalIgst).toBe(2_500);
    await assertPostingsSumToZero(inter.data.id);
  });

  it(
    "THE critical case — free-qty purchase: avg_cost reflects the EXACT blended value, never a rate×qty-drifted figure (P-2 worked example)",
    async () => {
      // Worked example from the handoff, verified by hand:
      // 10 billed + 1 free @ ₹1000/unit (100000 paise) exclusive, no discount.
      //   grossPaise = 10 * 100000 = 1,000,000 paise exact (billed only; free excluded).
      //   value (= taxableValue, exclusive so no GST back-calc) = 1,000,000 paise exact.
      //   in_qty = 11 units (10 billed + 1 free).
      //   rate = round(value / in_qty) = round(1,000,000 / 11) = 90,909 paise.
      //     Sanity check on the drift this guards against: 90,909 × 11 = 999,999 ≠ 1,000,000 —
      //     a real 1-paisa drift if `rate` were ever multiplied back instead of using `value`.
      // Starting from a fresh product (old_qty=0, old_avg=0):
      //   new_avg = round((0*0 + value*1000) / (0 + 11000))
      //           = round(1,000,000,000 / 11,000) = 90,909 paise exact (same as `rate` here only
      //             because old_qty=0 — the two formulas coincide for a brand-new product but are
      //             NOT the same computation in general, see the next test for a case where they
      //             diverge).
      const productId = await newProduct(5);
      const key = await newIdempotencyKey("purchase:confirm");
      const response = (await purchaseService.confirmPurchase(
        {
          supplierId: supplierIntraId,
          voucherDate: VOUCHER_DATE,
          lines: [{ productId, unitRate: money(100_000), billedQty: 10, freeQty: 1, discount: 0, priceIncludesGst: false }],
          // grand_total: taxable=1,000,000 + 5% GST (round(1,000,000*0.05)=50,000) = 1,050,000.
          paidCash: money(1_050_000),
          paidBank: 0,
          creditToSupplier: 0,
        },
        actor,
        key,
      )) as PurchaseResponse;
      createdPurchaseIds.push(response.data.id);

      expect(response.data.lineItems[0]?.taxableValue).toBe(1_000_000);
      expect(response.data.lineItems[0]?.billedQty).toBe(10);
      expect(response.data.lineItems[0]?.freeQty).toBe(1);

      const stock = await prisma.branchStock.findUniqueOrThrow({ where: { branchId_productId: { branchId, productId } } });
      expect(stock.quantity.toNumber()).toBe(11); // 10 billed + 1 free, both moved into stock
      expect(stock.avgCost).toBe(90_909n); // the exact figure, not 90910/90000/etc.

      const movement = await prisma.stockMovement.findFirstOrThrow({ where: { voucherType: "purchase", voucherId: response.data.id } });
      expect(movement.value).toBe(1_000_000n); // authoritative, exact — never rate×qty
      expect(movement.rate).toBe(90_909n); // derived-after, display-only
      expect(movement.avgCostAfter).toBe(90_909n);
      expect(movement.quantityDelta.toNumber()).toBe(11);

      await assertPostingsSumToZero(response.data.id);
    },
  );

  it(
    "applies free-qty dilution against EXISTING stock (old_qty > 0), where the free-unit and running-average formulas genuinely diverge",
    async () => {
      // Seed 10 units already in stock @ avg_cost 6000 paise. Purchase 8 billed + 2 free @ ₹6000
      // exclusive (value = 8*6000 = 48000 exact, in_qty = 10 units).
      // new_avg = round((10000*6000 + 48000*1000) / (10000+10000))
      //         = round((60,000,000 + 48,000,000) / 20,000) = round(108,000,000/20,000) = 5400.
      // rate (display, derived from THIS movement alone) = round(48000/10) = 4800 — deliberately
      // different from the new avg_cost (5400), proving the two formulas are not interchangeable:
      // `rate` never feeds avg_cost, only `value` does (the precision rule this whole test class
      // exists to guard).
      const productId = await newProduct(5);
      await seedStock(productId, 10, 6_000);

      const key = await newIdempotencyKey("purchase:confirm");
      const response = (await purchaseService.confirmPurchase(
        {
          supplierId: supplierIntraId,
          voucherDate: VOUCHER_DATE,
          lines: [{ productId, unitRate: money(6_000), billedQty: 8, freeQty: 2, discount: 0, priceIncludesGst: false }],
          paidCash: money(50_400), // taxable 48000 + 5% (2400) = 50400
          paidBank: 0,
          creditToSupplier: 0,
        },
        actor,
        key,
      )) as PurchaseResponse;
      createdPurchaseIds.push(response.data.id);

      const stock = await prisma.branchStock.findUniqueOrThrow({ where: { branchId_productId: { branchId, productId } } });
      expect(stock.quantity.toNumber()).toBe(20); // 10 existing + 8 billed + 2 free
      expect(stock.avgCost).toBe(5_400n);

      const movement = await prisma.stockMovement.findFirstOrThrow({ where: { voucherType: "purchase", voucherId: response.data.id } });
      expect(movement.value).toBe(48_000n);
      expect(movement.rate).toBe(4_800n); // != avg_cost (5400) — confirms rate is never fed back in
      expect(movement.avgCostAfter).toBe(5_400n);

      await assertPostingsSumToZero(response.data.id);
    },
  );

  it("accepts a wholly-free purchase (P-1) — opposite of Sale's wholly-giveaway rejection", async () => {
    const productId = await newProduct(5);
    await seedStock(productId, 10, 6_000);

    const key = await newIdempotencyKey("purchase:confirm");
    const response = (await purchaseService.confirmPurchase(
      {
        supplierId: supplierIntraId,
        voucherDate: VOUCHER_DATE,
        lines: [{ productId, unitRate: money(1_000), billedQty: 0, freeQty: 5, discount: 0, priceIncludesGst: false }],
        paidCash: 0,
        paidBank: 0,
        creditToSupplier: 0,
      },
      actor,
      key,
    )) as PurchaseResponse;
    createdPurchaseIds.push(response.data.id);

    expect(response.data.status).toBe("confirmed"); // accepted, not rejected like S-1's sale equivalent
    expect(response.data.totalTaxable).toBe(0);
    expect(response.data.grandTotal).toBe(0);

    // Zero-value line -> zero-amount postings, all skipped (§18.3's "zero-amount postings are
    // never written"). Confirms "posts nothing to Purchases/GST for the free units" (§27 P-1 note).
    const postings = await prisma.ledgerPosting.findMany({ where: { voucherType: "purchase", voucherId: response.data.id } });
    expect(postings).toHaveLength(0);

    // Stock still moves in, and free stock with zero value correctly DILUTES avg_cost:
    // new_avg = round((10000*6000 + 0*1000) / (10000+5000)) = round(60,000,000/15000) = 4000.
    const stock = await prisma.branchStock.findUniqueOrThrow({ where: { branchId_productId: { branchId, productId } } });
    expect(stock.quantity.toNumber()).toBe(15); // 10 existing + 5 free
    expect(stock.avgCost).toBe(4_000n);
  });

  it("splits payment across cash + bank + credit_to_supplier, posting all three ledgers in reversed (Cr) direction", async () => {
    const productId = await newProduct(5);
    const key = await newIdempotencyKey("purchase:confirm");
    const response = (await purchaseService.confirmPurchase(
      {
        supplierId: supplierIntraId,
        voucherDate: VOUCHER_DATE,
        lines: [{ productId, unitRate: money(5_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(20_000),
        paidBank: money(20_000),
        bankLedgerId,
        creditToSupplier: money(12_500),
      },
      actor,
      key,
    )) as PurchaseResponse;
    createdPurchaseIds.push(response.data.id);
    expect(response.data.grandTotal).toBe(52_500);

    const postings = await assertPostingsSumToZero(response.data.id);
    const byLedger = new Map(postings.map((p) => [p.ledgerId, p.amount]));
    expect(byLedger.get(branchCashLedgerId)).toBe(-20_000n); // Cr Cash (reversed vs. Sale's Dr)
    expect(byLedger.get(bankLedgerId)).toBe(-20_000n); // Cr Bank

    const supplier = await prisma.party.findUniqueOrThrow({ where: { id: supplierIntraId } });
    expect(byLedger.get(supplier.ledgerId)).toBe(-12_500n); // Cr Supplier ledger
  });

  it("rejects a customer-only party as supplier (mirror of Sale's PARTY_NOT_CUSTOMER, opposite direction)", async () => {
    const productId = await newProduct(5);
    const key = await newIdempotencyKey("purchase:confirm");
    await expect(
      purchaseService.confirmPurchase(
        {
          supplierId: customerOnlyId,
          voucherDate: VOUCHER_DATE,
          lines: [{ productId, unitRate: money(5_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
          paidCash: money(52_500),
          paidBank: 0,
          creditToSupplier: 0,
        },
        actor,
        key,
      ),
    ).rejects.toMatchObject({ code: "PARTY_NOT_SUPPLIER", details: { partyId: customerOnlyId } });
  });

  it("throws SYSTEM_LEDGER_NOT_CONFIGURED when company_profile has no purchases ledger linked", async () => {
    const profile = await prisma.companyProfile.findFirstOrThrow({ where: { deletedAt: null } });
    const originalPurchasesLedgerId = profile.purchasesLedgerId;
    await prisma.companyProfile.update({ where: { id: profile.id }, data: { purchasesLedgerId: null } });

    const productId = await newProduct(5);

    try {
      const key = await newIdempotencyKey("purchase:confirm");
      await expect(
        purchaseService.confirmPurchase(
          {
            supplierId: supplierIntraId,
            voucherDate: VOUCHER_DATE,
            lines: [{ productId, unitRate: money(5_000), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
            paidCash: money(52_500),
            paidBank: 0,
            creditToSupplier: 0,
          },
          actor,
          key,
        ),
      ).rejects.toMatchObject({ code: "SYSTEM_LEDGER_NOT_CONFIGURED", details: { ledger: "companyProfile.purchasesLedgerId" } });

      // Nothing should have been written — whole tx rolled back, no branch_stock row created.
      const stock = await prisma.branchStock.findUnique({ where: { branchId_productId: { branchId, productId } } });
      expect(stock).toBeNull();
    } finally {
      await prisma.companyProfile.update({ where: { id: profile.id }, data: { purchasesLedgerId: originalPurchasesLedgerId } });
    }
  });

  it(
    "row-locking concurrency: two concurrent purchases of the same product both succeed (no oversell race to guard, unlike Sale) " +
      "but the avg_cost read-modify-write must still serialize — proving no lost update",
    async () => {
      // Unlike confirmSale's concurrency test (which proves exactly one of two racing sales wins
      // against a fixed stock ceiling), Purchase has no negative-stock check (§27 delta) — there is
      // no "must reject" outcome to prove. The real race here is different: both purchases read
      // branch_stock's (quantity, avg_cost) under FOR UPDATE and each writes a new avg_cost derived
      // from what they read. Without correct serialization, the second writer could read STALE
      // pre-first-purchase values and clobber the first purchase's update (a lost update) even
      // though neither purchase individually did anything wrong. So the meaningful proof here is:
      // both succeed, AND the final state reflects BOTH purchases applied (not one overwriting the
      // other).
      //
      // Using two DIFFERENT purchases (not identical) so a lost update would be detectable, but
      // chosen so the final numbers are order-invariant (same result whichever transaction's lock
      // wins first) — this keeps the assertion a single hand-computable number instead of "matches
      // one of two possible interleavings".
      // Starting fresh (old_qty=0, old_avg=0):
      //   Whichever purchase applies first sets avg_cost to its own rate exactly (old_qty=0 term
      //   vanishes). The second purchase then recomputes against that: for A=10@8000 then B=10@4000
      //   -> avg = round((10000*8000 + 40000*1000)/20000) = round(120,000,000/20000) = 6000.
      //   For B then A -> avg = round((10000*4000 + 80000*1000)/20000) = round(120,000,000/20000)
      //   = 6000 too (both orders land on total_value/total_qty = 120000/20 = 6000 exactly, no
      //   intermediate rounding remainder with these numbers) — so the correct outcome is
      //   unambiguous regardless of which purchase's lock wins.
      //   A lost update would instead leave avg_cost at just 8000 or just 4000 (whichever writer
      //   went last, ignoring the other's contribution) and quantity at 10 instead of 20 — both
      //   detectably wrong.
      const productId = await newProduct(5);

      const makeCall = (unitRate: number) =>
        newIdempotencyKey("purchase:confirm").then((key) =>
          purchaseService.confirmPurchase(
            {
              supplierId: supplierIntraId,
              voucherDate: VOUCHER_DATE,
              lines: [{ productId, unitRate: money(unitRate), billedQty: 10, freeQty: 0, discount: 0, priceIncludesGst: false }],
              paidCash: money(Math.round(unitRate * 10 * 1.05)),
              paidBank: 0,
              creditToSupplier: 0,
            },
            actor,
            key,
          ),
        );

      const [a, b] = await Promise.allSettled([makeCall(8_000), makeCall(4_000)]);
      const results = [a, b];
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(2); // both succeed — no negative-stock rejection possible here

      for (const r of fulfilled) {
        createdPurchaseIds.push(((r as PromiseFulfilledResult<unknown>).value as PurchaseResponse).data.id);
      }

      const stock = await prisma.branchStock.findUniqueOrThrow({ where: { branchId_productId: { branchId, productId } } });
      expect(stock.quantity.toNumber()).toBe(20); // 10 + 10, not 10 — proves neither write was lost
      expect(stock.avgCost).toBe(6_000n); // reflects BOTH purchases, not just whichever wrote last

      for (const r of fulfilled) {
        await assertPostingsSumToZero(((r as PromiseFulfilledResult<unknown>).value as PurchaseResponse).data.id);
      }
    },
    30_000,
  );
});

describe("getLastCost — TDD §28.1 purchase-side mirror of sale.service.ts's getLastPrice", () => {
  it("returns null when there is no prior confirmed purchase for the pair", async () => {
    const productId = await newProduct(5);
    const result = await purchaseService.getLastCost(supplierIntraId, productId, actor);
    expect(result).toBeNull();
  });

  it("recalls the most recent confirmed purchase's rate, effectiveRate, date, and quantity (hand-worked)", async () => {
    // 5 @ 8000 paise, no discount: taxable=40000, 5% GST -> tax=2000 (cgst/sgst 1000 each),
    // grandTotal=42000. effectiveRate = round(42000/5) = 8400 (same T-7b formula as sales).
    const productId = await newProduct(5);
    const key = await newIdempotencyKey("purchase:confirm");
    const response = (await purchaseService.confirmPurchase(
      {
        supplierId: supplierIntraId,
        voucherDate: VOUCHER_DATE,
        lines: [{ productId, unitRate: money(8_000), billedQty: 5, freeQty: 0, discount: 0, priceIncludesGst: false }],
        paidCash: money(42_000),
        paidBank: 0,
        creditToSupplier: 0,
      },
      actor,
      key,
    )) as PurchaseResponse;
    createdPurchaseIds.push(response.data.id);
    expect(response.data.grandTotal).toBe(42_000); // sanity check on the hand-worked numbers above

    const result = await purchaseService.getLastCost(supplierIntraId, productId, actor);
    expect(result).not.toBeNull();
    expect(result?.rate).toBe(8_000n);
    expect(result?.effectiveRate).toBe(8_400n);
    expect(result?.quantity.toNumber()).toBe(5);
    expect(result?.date.toISOString().slice(0, 10)).toBe("2026-06-15");
  });
});
