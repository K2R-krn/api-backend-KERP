import { Prisma } from "@prisma/client";
import { runTransaction } from "../../db/client.js";
import { writeAudit, type Tx } from "../../shared/audit.js";
import { completeIdempotencyKey } from "../../shared/idempotency.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../shared/errors.js";
import { success } from "../../shared/envelope.js";
import { serializeBigInt } from "../../shared/serialize.js";
import { deriveFinancialYear } from "../../shared/financial-year.js";
import { allocateVoucherNumber, formatVoucherNumber } from "../../shared/number-series.js";
import type { Role } from "../../shared/types.js";
import type { ConfirmPurchaseInput, PurchaseLineInput } from "./purchase.validation.js";

export interface PurchaseActor {
  userId: string;
  role: Role;
  branchId: string;
}

// ============================================================================
// Money/quantity math — integer paise (bigint) and milli-units (integer) throughout, same
// CLAUDE.md "never float for money" rule and the same milli-unit representation sale.service.ts
// uses to avoid float drift when summing multiple lines' billed/free qty per product (mirroring
// S-5's merged-movement pattern here for purchase_in).
// ============================================================================

function qtyToMilli(qty: number): number {
  return Math.round(qty * 1000);
}

function milliToDecimal(milli: number): Prisma.Decimal {
  return new Prisma.Decimal(milli).div(1000);
}

// Standard round-half-up on nonnegative bigints — same as sale.service.ts (TDD §3.11/§26 don't
// pin down half-up vs. banker's rounding; flagged in PROJECT_ROADMAP.md §9).
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

// ============================================================================
// resolvePurchase — the pure(ish) computation core: preflight validation + GST math. Deliberately
// does NOT touch branch_stock (no lock needed here — that's confirm-only, mirroring resolveSale)
// and does NOT allocate a voucher number (confirm-only). Unlike resolveSale, there is no second
// entry mode to share this with — §27 purchases are single-entry (see purchase.validation.ts) —
// but the split still pays off: it keeps the pure GST computation separable from the
// stock-locking/number-allocation side effects, exactly like resolveSale.
// ============================================================================

interface ResolvePurchaseParams {
  supplierId: string;
  voucherDate: Date;
  lines: PurchaseLineInput[];
}

interface ResolvedLine {
  productId: string;
  unitRate: bigint;
  billedQtyMilli: number;
  freeQtyMilli: number;
  discount: bigint;
  gstRate: Prisma.Decimal;
  priceIncludesGst: boolean;
  taxClassification: string;
  hsnCode: string | null;
  productName: string;
  unitSymbol: string | null;
  taxableValue: bigint;
  cgstAmount: bigint;
  sgstAmount: bigint;
  igstAmount: bigint;
  lineTotal: bigint;
}

interface ResolvedPurchase {
  branch: { id: string; code: string; stateCode: string; cashLedgerId: string | null };
  companyProfile: {
    roundingMode: string;
    fyStartMonth: number;
    purchasesLedgerId: string | null;
    cgstLedgerId: string | null;
    sgstLedgerId: string | null;
    igstLedgerId: string | null;
    roundOffLedgerId: string | null;
  };
  supplierId: string;
  supplierLedgerId: string;
  voucherDate: Date;
  isInterState: boolean;
  lines: ResolvedLine[];
  totals: {
    totalTaxable: bigint;
    totalDiscount: bigint;
    totalCgst: bigint;
    totalSgst: bigint;
    totalIgst: bigint;
    roundOff: bigint;
    grandTotal: bigint;
  };
}

// TDD §27 step 3 — same per-line GST computation as confirmSale's computeLine (inclusive/exclusive
// back-calc, per-line rounding, floor/remainder CGST-SGST split), just relabeled "input GST"
// instead of "output GST" — the arithmetic doesn't change, only which ledgers the totals post to
// (buildPostings below). `taxableValue` here does double duty beyond the GST split: per this
// session's resolved discount/GST-inclusive corrections to TDD §27 step 6's stock-valuation
// formula, `taxableValue` (net of discount, net of embedded GST for inclusive lines — never the
// raw billed_qty×unit_rate) is also the exact cost basis that feeds the avg_cost recompute below.
// Recoverable input GST is never part of inventory cost (§18.4's periodic-Purchases model; ITC is
// a separate ledger, §18.3), so using taxableValue for both purposes is the same correction twice,
// not two different values that happen to collide.
function computeLine(
  input: PurchaseLineInput,
  product: { name: string; hsnCode: string | null; gstRate: Prisma.Decimal; taxClassification: string; unit: { symbol: string } },
  isInterState: boolean,
): ResolvedLine {
  const unitRate = BigInt(input.unitRate);
  const billedQtyMilli = qtyToMilli(input.billedQty);
  const freeQtyMilli = qtyToMilli(input.freeQty);

  // Free qty excluded from taxable value / cost basis (billed only) — free units cost nothing, per
  // P-2, that's the whole point of a scheme.
  const grossPaise = divRoundHalfUp(BigInt(billedQtyMilli) * unitRate, 1000n);
  const discount = BigInt(input.discount);
  if (discount > grossPaise) {
    throw new BadRequestError("DISCOUNT_EXCEEDS_LINE_AMOUNT", {
      productId: input.productId,
      discount: discount.toString(),
      lineAmount: grossPaise.toString(),
    });
  }
  const discountedAmount = grossPaise - discount;

  const gstRateHundredths = BigInt(Math.round(product.gstRate.toNumber() * 100));

  let taxableValue: bigint;
  let lineTax: bigint;
  if (product.taxClassification !== "taxable") {
    taxableValue = discountedAmount;
    lineTax = 0n;
  } else if (!input.priceIncludesGst) {
    taxableValue = discountedAmount;
    lineTax = divRoundHalfUp(taxableValue * gstRateHundredths, 10000n);
  } else {
    taxableValue = divRoundHalfUp(discountedAmount * 10000n, 10000n + gstRateHundredths);
    lineTax = discountedAmount - taxableValue;
  }

  let cgstAmount = 0n;
  let sgstAmount = 0n;
  let igstAmount = 0n;
  if (lineTax > 0n) {
    if (isInterState) {
      igstAmount = lineTax;
    } else {
      cgstAmount = lineTax / 2n;
      sgstAmount = lineTax - cgstAmount;
    }
  }

  return {
    productId: input.productId,
    unitRate,
    billedQtyMilli,
    freeQtyMilli,
    discount,
    gstRate: product.gstRate,
    priceIncludesGst: input.priceIncludesGst,
    taxClassification: product.taxClassification,
    hsnCode: product.hsnCode,
    productName: product.name,
    unitSymbol: product.unit.symbol,
    taxableValue,
    cgstAmount,
    sgstAmount,
    igstAmount,
    lineTotal: taxableValue + lineTax,
  };
}

async function resolvePurchase(tx: Tx, params: ResolvePurchaseParams, actor: PurchaseActor): Promise<ResolvedPurchase> {
  const branch = await tx.branch.findFirst({ where: { id: actor.branchId, deletedAt: null } });
  if (!branch) throw new NotFoundError("BRANCH_NOT_FOUND");

  const companyProfile = await tx.companyProfile.findFirst({ where: { deletedAt: null } });
  if (!companyProfile) throw new ConflictError("COMPANY_PROFILE_NOT_CONFIGURED");

  for (const line of params.lines) {
    if (line.billedQty === 0 && line.freeQty === 0) {
      throw new BadRequestError("EMPTY_LINE_REJECTED", { productId: line.productId });
    }
  }
  // P-1 (locked, deliberate asymmetry with S-1): NO wholly-free rejection. A purchase voucher
  // number is purely internal (never GST-filed), so an all-free inward consuming one is harmless —
  // unlike a sales invoice number, which is GST-significant. Every line may be free.

  // supplierId is NOT NULL on purchases (§25.3) — no anonymous-purchase equivalent to a walk-in
  // cash sale, so unlike resolveSale there's no branch for an absent supplier.
  const supplier = await tx.party.findFirst({
    where: { id: params.supplierId, owningBranchId: actor.branchId, deletedAt: null },
  });
  if (!supplier) throw new NotFoundError("SUPPLIER_NOT_FOUND");
  // Mirror of confirmSale's supplier-only-party rejection, opposite direction: reject
  // customer-only parties, accept supplier or both.
  if (supplier.type === "customer") throw new BadRequestError("PARTY_NOT_SUPPLIER", { partyId: supplier.id });

  // Step 1 resolution (this session): intra/inter-state decided by branch.stateCode vs. the
  // supplier's stateCode — mirrors §26 step 4's branch-vs-buyer-state logic with the party swapped
  // for supplier. Purchases have no place_of_supply_state_code column (§25.3 — that's an
  // outward-filing-declaration concept the supplier already made on their own invoice), so there's
  // no third field to reconcile the way §26 has to for anonymous/local sales.
  const isInterState = supplier.stateCode !== branch.stateCode;

  const productIds = [...new Set(params.lines.map((l) => l.productId))];
  const products = await tx.product.findMany({
    where: { id: { in: productIds }, deletedAt: null },
    include: { unit: true },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  for (const productId of productIds) {
    // Deliberately NO isActive gate here (unlike confirmSale's approved #8). The narrow reason is
    // that Purchase has no draft mode (this session's Step 0 resolution) — no stale-parked-draft
    // window where a product could go inactive between entry and confirm the way a sale's can. But
    // the deeper, more durable reason is conceptual, not just "no race exists today": deactivating
    // a product means "stop SELLING this," not "this product no longer exists." A purchase records
    // that goods physically arrived at the branch — real stock now sitting on a real shelf, whether
    // or not the product happens to be flagged active. Blocking that recording wouldn't stop the
    // goods from existing; it would only open a gap between the physical stock (in) and the
    // system's stock (still showing the old quantity) until someone works around the block. This
    // reasoning holds even if Purchase gets a draft/park mode later — it's about what deactivation
    // MEANS, not about timing.
    if (!productById.get(productId)) throw new NotFoundError("PRODUCT_NOT_FOUND", { productId });
  }

  const lines = params.lines.map((line) => computeLine(line, productById.get(line.productId)!, isInterState));

  const totalTaxable = lines.reduce((sum, l) => sum + l.taxableValue, 0n);
  const totalDiscount = lines.reduce((sum, l) => sum + l.discount, 0n);
  const totalCgst = lines.reduce((sum, l) => sum + l.cgstAmount, 0n);
  const totalSgst = lines.reduce((sum, l) => sum + l.sgstAmount, 0n);
  const totalIgst = lines.reduce((sum, l) => sum + l.igstAmount, 0n);
  const pre = totalTaxable + totalCgst + totalSgst + totalIgst;

  let grandTotal: bigint;
  let roundOff: bigint;
  if (companyProfile.roundingMode === "nearest_rupee") {
    grandTotal = divRoundHalfUp(pre, 100n) * 100n;
    roundOff = grandTotal - pre;
  } else {
    grandTotal = pre;
    roundOff = 0n;
  }

  return {
    branch,
    companyProfile,
    supplierId: supplier.id,
    supplierLedgerId: supplier.ledgerId,
    voucherDate: params.voucherDate,
    isInterState,
    lines,
    totals: { totalTaxable, totalDiscount, totalCgst, totalSgst, totalIgst, roundOff, grandTotal },
  };
}

// ============================================================================
// ledger_postings assembly — TDD §27 step 7 / §18.3's purchase map. resolveSystemLedgers checks
// only the ledgers THIS purchase actually needs, same gate confirmSale uses. Input GST reuses the
// SAME cgst/sgst/igst ledgers as output GST (company_profile has one CGST/SGST/IGST ledger each,
// not separate input/output pairs — confirmed reading TDD §18.3's posting map, which names no
// distinct "GST input" ledger set).
// ============================================================================

interface SystemLedgers {
  cashLedgerId: string | null;
  purchasesLedgerId: string | null;
  cgstLedgerId: string | null;
  sgstLedgerId: string | null;
  igstLedgerId: string | null;
  roundOffLedgerId: string | null;
}

function requireSystemLedger(value: string | null, ledger: string): string {
  if (value == null) throw new ConflictError("SYSTEM_LEDGER_NOT_CONFIGURED", { ledger });
  return value;
}

function resolveSystemLedgers(resolved: ResolvedPurchase, paidCash: bigint): SystemLedgers {
  const { totalTaxable, totalCgst, totalSgst, totalIgst, roundOff } = resolved.totals;
  return {
    cashLedgerId: paidCash > 0n ? requireSystemLedger(resolved.branch.cashLedgerId, "branch.cashLedgerId") : null,
    purchasesLedgerId:
      totalTaxable > 0n
        ? requireSystemLedger(resolved.companyProfile.purchasesLedgerId, "companyProfile.purchasesLedgerId")
        : null,
    cgstLedgerId:
      totalCgst > 0n ? requireSystemLedger(resolved.companyProfile.cgstLedgerId, "companyProfile.cgstLedgerId") : null,
    sgstLedgerId:
      totalSgst > 0n ? requireSystemLedger(resolved.companyProfile.sgstLedgerId, "companyProfile.sgstLedgerId") : null,
    igstLedgerId:
      totalIgst > 0n ? requireSystemLedger(resolved.companyProfile.igstLedgerId, "companyProfile.igstLedgerId") : null,
    roundOffLedgerId:
      roundOff !== 0n
        ? requireSystemLedger(resolved.companyProfile.roundOffLedgerId, "companyProfile.roundOffLedgerId")
        : null,
  };
}

interface PostingInput {
  ledgerId: string;
  amount: bigint;
}

// Posting direction is the reverse of Sale's (§27 step 7): Dr Purchases + Dr GST-input = Cr
// Cash/Bank + Cr Supplier. Concretely, every sign below is the negation of buildPostings' sale
// equivalent — including round_off, which sits on the opposite side of the equation from Sale's
// (worked check: pre = totalTaxable+cgst+sgst+igst on the Dr side, grandTotal = paid+credit on the
// Cr side, roundOff = grandTotal-pre; pre + roundOff - grandTotal = 0 requires pushing +roundOff
// here, not -roundOff as Sale does).
function buildPostings(
  resolved: ResolvedPurchase,
  systemLedgers: SystemLedgers,
  paymentSplit: { paidCash: bigint; paidBank: bigint; bankLedgerId: string | null; creditToSupplier: bigint },
): PostingInput[] {
  const postings: PostingInput[] = [];
  const push = (ledgerId: string | null, amount: bigint): void => {
    if (amount !== 0n && ledgerId) postings.push({ ledgerId, amount });
  };

  push(systemLedgers.purchasesLedgerId, resolved.totals.totalTaxable);
  push(systemLedgers.cgstLedgerId, resolved.totals.totalCgst);
  push(systemLedgers.sgstLedgerId, resolved.totals.totalSgst);
  push(systemLedgers.igstLedgerId, resolved.totals.totalIgst);
  push(systemLedgers.cashLedgerId, -paymentSplit.paidCash);
  push(paymentSplit.bankLedgerId, -paymentSplit.paidBank);
  push(resolved.supplierLedgerId, -paymentSplit.creditToSupplier);
  push(systemLedgers.roundOffLedgerId, resolved.totals.roundOff);

  return postings;
}

// ============================================================================
// Shared row-shaping + audit helpers
// ============================================================================

function lineToRow(line: ResolvedLine, lineNumber: number, purchaseId: string, resolved: ResolvedPurchase, actor: PurchaseActor) {
  return {
    purchaseId,
    lineNumber,
    productId: line.productId,
    supplierId: resolved.supplierId,
    branchId: actor.branchId,
    purchaseDate: resolved.voucherDate,
    unitRate: line.unitRate,
    billedQty: milliToDecimal(line.billedQtyMilli),
    freeQty: milliToDecimal(line.freeQtyMilli),
    discount: line.discount,
    gstRate: line.gstRate,
    priceIncludesGst: line.priceIncludesGst,
    taxClassification: line.taxClassification,
    hsnCode: line.hsnCode,
    productName: line.productName,
    unitSymbol: line.unitSymbol,
    taxableValue: line.taxableValue,
    cgstAmount: line.cgstAmount,
    sgstAmount: line.sgstAmount,
    igstAmount: line.igstAmount,
    lineTotal: line.lineTotal,
  };
}

// Reference-only per §13's transaction-entity exception, always a create — purchases have no
// draft-confirm entry mode (this session's Step 0 resolution), so unlike auditSummary in
// sale.service.ts there is no update/before-after branch to account for.
function auditSummary(resolved: ResolvedPurchase, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    supplierId: resolved.supplierId,
    grandTotal: resolved.totals.grandTotal.toString(),
  };
}

async function assertBankLedgerExists(tx: Tx, ledgerId: string): Promise<void> {
  const ledger = await tx.ledger.findFirst({ where: { id: ledgerId, deletedAt: null } });
  if (!ledger) throw new NotFoundError("BANK_LEDGER_NOT_FOUND");
}

// ============================================================================
// confirmPurchase — TDD §27. Single entry mode (Step 0 resolution, confirmed): always a fresh
// create-and-confirm in one call, never a draft/park + separate confirm the way confirmSale has.
// ============================================================================

export async function confirmPurchase(input: ConfirmPurchaseInput, actor: PurchaseActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(
    async (tx) => {
      const paidCash = BigInt(input.paidCash);
      const paidBank = BigInt(input.paidBank);
      const creditToSupplier = BigInt(input.creditToSupplier);
      const bankLedgerId = input.bankLedgerId ?? null;

      if (paidBank > 0n && !bankLedgerId) {
        throw new BadRequestError("BANK_LEDGER_REQUIRED");
      }
      if (bankLedgerId && paidBank > 0n) {
        await assertBankLedgerExists(tx, bankLedgerId);
      }

      const resolved = await resolvePurchase(tx, { supplierId: input.supplierId, voucherDate: input.voucherDate, lines: input.lines }, actor);

      // Payment-split integrity against the post-round-off grand_total — same rule as Sale's S-4,
      // just against credit_to_supplier instead of credit_udhar.
      const paidSum = paidCash + paidBank + creditToSupplier;
      if (paidSum !== resolved.totals.grandTotal) {
        throw new BadRequestError("PAYMENT_SPLIT_MISMATCH", {
          grandTotal: resolved.totals.grandTotal.toString(),
          paidSum: paidSum.toString(),
        });
      }

      // Step 2 (§27 delta) — lock branch_stock rows FOR UPDATE, ascending product_id (CC-6), same
      // sequential-not-Promise.all discipline as confirmSale. Unlike Sale, a missing row is CREATED
      // here (first-ever stock of this product at this branch) rather than rejected. Same
      // insert-then-lock race-avoidance as allocateVoucherNumber's number_series pattern: a bare
      // "SELECT ... FOR UPDATE, create if missing" would let two concurrent purchases of a
      // brand-new product both observe "no row" and both attempt to create one.
      const distinctProductIds = [...new Set(resolved.lines.map((l) => l.productId))].sort();
      const stockByProduct = new Map<string, { quantityMilli: number; avgCost: bigint }>();
      for (const productId of distinctProductIds) {
        await tx.$executeRaw`
          INSERT INTO branch_stock (branch_id, product_id, quantity, avg_cost)
          VALUES (${actor.branchId}::uuid, ${productId}::uuid, 0, 0)
          ON CONFLICT (branch_id, product_id) DO NOTHING`;
        const rows = await tx.$queryRaw<{ quantity: Prisma.Decimal; avgCost: bigint }[]>`
          SELECT quantity, avg_cost AS "avgCost" FROM branch_stock
          WHERE branch_id = ${actor.branchId}::uuid AND product_id = ${productId}::uuid
          FOR UPDATE`;
        const row = rows[0]!;
        stockByProduct.set(productId, { quantityMilli: qtyToMilli(row.quantity.toNumber()), avgCost: BigInt(row.avgCost) });
      }
      // No negative-stock block (§27 delta) — purchases only ever add. The lock above is still
      // mandatory: it guards the avg_cost read-modify-write against concurrency, it just isn't
      // gating a quantity check the way Sale's is.

      // Step 5 (§27) — allocate the voucher number (row-locked; concurrent confirms serialize
      // here). Internal-only, distinct from supplier_invoice_number (stored as-entered above).
      const financialYear = deriveFinancialYear(resolved.voucherDate, resolved.companyProfile.fyStartMonth);
      const allocated = await allocateVoucherNumber(tx, {
        branchId: actor.branchId,
        voucherType: "purchase",
        financialYear,
        defaultPrefix: null,
        actorId: actor.userId,
      });
      const voucherNumber = formatVoucherNumber(resolved.branch.code, financialYear, allocated.sequenceNumber);

      // Write header + line items. Always a fresh create (no existing draft row to update).
      const purchase = await tx.purchase.create({
        data: {
          branchId: actor.branchId,
          supplierId: resolved.supplierId,
          voucherDate: resolved.voucherDate,
          status: "confirmed",
          voucherNumber,
          financialYear,
          supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
          supplierInvoiceDate: input.supplierInvoiceDate ?? null,
          totalTaxable: resolved.totals.totalTaxable,
          totalDiscount: resolved.totals.totalDiscount,
          totalCgst: resolved.totals.totalCgst,
          totalSgst: resolved.totals.totalSgst,
          totalIgst: resolved.totals.totalIgst,
          roundOff: resolved.totals.roundOff,
          grandTotal: resolved.totals.grandTotal,
          paidCash,
          paidBank,
          creditToSupplier,
          bankLedgerId,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
      });

      await tx.purchaseLineItem.createMany({
        data: resolved.lines.map((line, index) => lineToRow(line, index + 1, purchase.id, resolved, actor)),
      });

      // Step 6 (§27 delta) — stock increment + one merged purchase_in movement per product (S-5's
      // merge pattern, same rationale). This is the highest-stakes part of the session (P-2): the
      // value fed into both the movement and the avg_cost recompute is the per-product SUM of each
      // line's `taxableValue` (this session's resolved cost basis — net of discount, net of
      // embedded GST for inclusive lines) — never a re-derived rate×qty, which is exactly the
      // figure the locked precision rule forbids multiplying back.
      const valueByProduct = new Map<string, bigint>();
      const qtyMilliByProduct = new Map<string, number>();
      for (const line of resolved.lines) {
        valueByProduct.set(line.productId, (valueByProduct.get(line.productId) ?? 0n) + line.taxableValue);
        qtyMilliByProduct.set(line.productId, (qtyMilliByProduct.get(line.productId) ?? 0) + line.billedQtyMilli + line.freeQtyMilli);
      }

      for (const [productId, inQtyMilli] of qtyMilliByProduct) {
        const value = valueByProduct.get(productId)!;
        const stock = stockByProduct.get(productId)!;

        // rate: derived-after, display/reference only — round(value / (billed+free qty)). Never
        // multiplied back to recompute value or feed avg_cost (that's the exact drift P-2 guards
        // against: 90909 paise × 11 units ≠ 1,000,000 paise).
        const rate = divRoundHalfUp(value * 1000n, BigInt(inQtyMilli));

        // avg-cost recompute: new_avg = (old_qty×old_avg + value) / (old_qty + in_qty), the textbook
        // weighted-average formula in whole units. This line computes it with bigints using the
        // milli-quantities already on hand, so a careful reader needs the scaling spelled out:
        //   oldQtyMilli × avgCost = (q_old×1000) × avg = 1000 × (q_old×avg) = 1000 × old_total_value.
        // That term is implicitly ALREADY scaled ×1000, purely because quantity is stored in milli
        // units — avgCost itself is plain paise-per-unit, never milli-scaled. `value` (this
        // purchase's total cost, plain paise, same as old_total_value's unit) must be multiplied by
        // the same ×1000 before being added, or the addition mixes a ×1000-scaled term with an
        // unscaled one — silently wrong, not a rounding nuance. Dividing by (oldQtyMilli+inQtyMilli),
        // which carries that same ×1000 on the denominator, cancels it back out exactly:
        //   (1000×old_total_value + 1000×value) / (1000×total_qty) = (old_total_value+value)/total_qty
        // — the correct paise-per-unit answer. (Verified by an independent reviewer against a
        // clean-room whole-unit recompute with no milli arithmetic at all — same result.)
        const oldQtyMilli = BigInt(stock.quantityMilli);
        const newAvgCost = divRoundHalfUp(oldQtyMilli * stock.avgCost + value * 1000n, oldQtyMilli + BigInt(inQtyMilli));

        await tx.stockMovement.create({
          data: {
            productId,
            branchId: actor.branchId,
            quantityDelta: milliToDecimal(inQtyMilli),
            movementType: "purchase_in",
            rate,
            value,
            voucherType: "purchase",
            voucherId: purchase.id,
            voucherDate: resolved.voucherDate,
            avgCostAfter: newAvgCost,
            createdBy: actor.userId,
          },
        });
        await tx.branchStock.update({
          where: { branchId_productId: { branchId: actor.branchId, productId } },
          data: { quantity: { increment: milliToDecimal(inQtyMilli) }, avgCost: newAvgCost },
        });
      }

      // Step 7 (§27) — ledger postings, reversed direction from Sale (Dr Purchases + Dr GST-input =
      // Cr Cash/Bank + Cr Supplier), sourced from the stored header totals, never recomputed.
      const systemLedgers = resolveSystemLedgers(resolved, paidCash);
      const postings = buildPostings(resolved, systemLedgers, { paidCash, paidBank, bankLedgerId, creditToSupplier });
      const postingSum = postings.reduce((acc, p) => acc + p.amount, 0n);
      if (postingSum !== 0n) {
        throw new Error(`ledger_postings for purchase ${purchase.id} do not sum to zero (got ${postingSum.toString()})`);
      }
      if (postings.length > 0) {
        await tx.ledgerPosting.createMany({
          data: postings.map((p) => ({
            ledgerId: p.ledgerId,
            branchId: actor.branchId,
            amount: p.amount,
            voucherType: "purchase",
            voucherId: purchase.id,
            voucherDate: resolved.voucherDate,
            createdBy: actor.userId,
          })),
        });
      }

      // Step 8 (§27) — audit + idempotency, both inside this same tx. Always a create (no
      // draft-confirm update branch to handle, unlike Sale).
      await writeAudit(tx, actor, {
        action: "create",
        entityType: "purchase",
        entityId: purchase.id,
        after: auditSummary(resolved, { voucherNumber, status: "confirmed" }),
      });

      const lineItems = await tx.purchaseLineItem.findMany({ where: { purchaseId: purchase.id }, orderBy: { lineNumber: "asc" } });
      const responseBody = success(serializeBigInt({ ...purchase, lineItems }));
      await completeIdempotencyKey(tx, idempotencyKey, responseBody);
      return responseBody;
    },
    // Same generous-timeout rationale as confirmSale (CLAUDE.md: remote-DB latency) — heavier than
    // a simple master write, though lighter than confirmSale (no negative-stock read path, no
    // document_type derivation).
    { timeout: 30_000 },
  );
}
