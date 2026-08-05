import { Prisma } from "@prisma/client";
import { runTransaction } from "../../db/client.js";
import { writeAudit, type Tx } from "../../shared/audit.js";
import { completeIdempotencyKey } from "../../shared/idempotency.js";
import { BadRequestError, ConflictError, InsufficientStockError, NotFoundError } from "../../shared/errors.js";
import { success } from "../../shared/envelope.js";
import { serializeBigInt } from "../../shared/serialize.js";
import { deriveFinancialYear } from "../../shared/financial-year.js";
import { allocateVoucherNumber, formatVoucherNumber } from "../../shared/number-series.js";
import type { Role } from "../../shared/types.js";
import { isDraftConfirm } from "./sale.validation.js";
import type { ConfirmSaleInput, CreateDraftSaleInput, SaleLineInput } from "./sale.validation.js";

export interface SaleActor {
  userId: string;
  role: Role;
  branchId: string;
}

// ============================================================================
// Money/quantity math — integer paise (bigint) and milli-units (integer) throughout, per
// CLAUDE.md's "never float for money" rule. Quantities are numeric(12,3); representing them as
// integer thousandths avoids float drift when summing many lines' billed/free qty for the
// negative-stock check (TDD §26 step 3) and the merged stock_movement (S-5).
// ============================================================================

function qtyToMilli(qty: number): number {
  return Math.round(qty * 1000);
}

function milliToDecimal(milli: number): Prisma.Decimal {
  return new Prisma.Decimal(milli).div(1000);
}

// Standard round-half-up on nonnegative bigints. TDD §3.11/§26 don't pin down half-up vs. banker's
// rounding — flagged as an open item in PROJECT_ROADMAP.md §9 for accountant confirmation.
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

// ============================================================================
// resolveSale — the pure(ish) computation core shared by createDraft and confirmSale (both entry
// modes). Does validation + GST math + document_type derivation. Deliberately does NOT touch
// branch_stock (no lock needed — that's confirm-only, step 2) or allocate a voucher number
// (confirm-only, step 7). Approved #4: always reads the LIVE product master, never a stale
// draft-time snapshot — a parked bill's rates/classification/active-status can drift just like its
// stock can (TDD §28.2 "drafts do NOT reserve stock").
// ============================================================================

interface ResolveSaleParams {
  customerId?: string;
  customerName?: string;
  customerVillage?: string;
  voucherDate: Date;
  lines: SaleLineInput[];
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

interface ResolvedSale {
  branch: { id: string; code: string; stateCode: string; cashLedgerId: string | null };
  companyProfile: {
    roundingMode: string;
    fyStartMonth: number;
    salesLedgerId: string | null;
    cgstLedgerId: string | null;
    sgstLedgerId: string | null;
    igstLedgerId: string | null;
    roundOffLedgerId: string | null;
  };
  customerId: string | null;
  customerLedgerId: string | null;
  customerName: string;
  customerVillage: string;
  voucherDate: Date;
  placeOfSupplyStateCode: string;
  isInterState: boolean;
  documentType: "tax_invoice" | "bill_of_supply" | "invoice_cum_bos";
  mixedRegisteredEdgeCase: boolean;
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

// TDD §26 step 4 — per-line GST computation. `product` carries the LIVE snapshot fields
// (gstRate/taxClassification/hsnCode/name/unit symbol); priceIncludesGst is caller input, not
// derived from the product (§26 Inputs list).
function computeLine(
  input: SaleLineInput,
  product: { name: string; hsnCode: string | null; gstRate: Prisma.Decimal; taxClassification: string; unit: { symbol: string } },
  isInterState: boolean,
): ResolvedLine {
  const unitRate = BigInt(input.unitRate);
  const billedQtyMilli = qtyToMilli(input.billedQty);
  const freeQtyMilli = qtyToMilli(input.freeQty);

  // Free qty excluded from taxable value (billed only).
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
    // exempt / nil_rated / non_gst: tax = 0 regardless of the stored gst_rate.
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
      // S-3 (locked): floor(lineTax/2) to CGST, remainder to SGST — sum stays exact.
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

async function resolveSale(tx: Tx, params: ResolveSaleParams, actor: SaleActor): Promise<ResolvedSale> {
  const branch = await tx.branch.findFirst({ where: { id: actor.branchId, deletedAt: null } });
  if (!branch) throw new NotFoundError("BRANCH_NOT_FOUND");

  const companyProfile = await tx.companyProfile.findFirst({ where: { deletedAt: null } });
  if (!companyProfile) throw new ConflictError("COMPANY_PROFILE_NOT_CONFIGURED");

  for (const line of params.lines) {
    if (line.billedQty === 0 && line.freeQty === 0) {
      throw new BadRequestError("EMPTY_LINE_REJECTED", { productId: line.productId });
    }
  }
  // S-1 (locked): free-only lines are allowed within a sale, but at least one line must carry
  // billedQty > 0 — a wholly-giveaway "sale" doesn't belong on a GST-significant invoice number.
  if (!params.lines.some((l) => l.billedQty > 0)) {
    throw new BadRequestError("WHOLLY_GIVEAWAY_SALE_REJECTED");
  }

  let customerId: string | null = null;
  let customerLedgerId: string | null = null;
  let customerName: string;
  let customerVillage: string;
  let buyerRegistered = false;
  let placeOfSupplyStateCode = branch.stateCode;

  if (params.customerId) {
    const party = await tx.party.findFirst({
      where: { id: params.customerId, owningBranchId: actor.branchId, deletedAt: null },
    });
    if (!party) throw new NotFoundError("CUSTOMER_NOT_FOUND");
    if (party.type === "supplier") throw new BadRequestError("PARTY_NOT_CUSTOMER", { partyId: party.id });
    customerId = party.id;
    customerLedgerId = party.ledgerId;
    customerName = party.name;
    customerVillage = party.village;
    buyerRegistered = party.gstin != null;
    placeOfSupplyStateCode = party.stateCode;
  } else {
    // Zod's superRefine already enforces this for HTTP callers; kept here as defense-in-depth for
    // this module's own draft-confirm path, which builds params directly (not through Zod).
    if (!params.customerName || !params.customerVillage) {
      throw new BadRequestError("CUSTOMER_NAME_VILLAGE_REQUIRED");
    }
    customerName = params.customerName;
    customerVillage = params.customerVillage;
  }

  const isInterState = placeOfSupplyStateCode !== branch.stateCode;

  const productIds = [...new Set(params.lines.map((l) => l.productId))];
  const products = await tx.product.findMany({
    where: { id: { in: productIds }, deletedAt: null },
    include: { unit: true },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  for (const productId of productIds) {
    const product = productById.get(productId);
    if (!product) throw new NotFoundError("PRODUCT_NOT_FOUND", { productId });
    // Approved #8: block confirmation on a deactivated product, not just a catalog-visibility
    // note. A draft parked while a product was active and confirmed after it's deactivated is a
    // direct consequence of approved #4 (fresh product read at confirm time) — without this check
    // a discontinued product could still be sold through a stale lingering draft.
    if (!product.isActive) {
      throw new BadRequestError("PRODUCT_DEACTIVATED", {
        productId,
        productName: product.name,
        reason: "This product is deactivated and cannot be sold. Reactivate it in the catalog, or remove this line from the sale.",
      });
    }
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

  // §23.1 document-type derivation. Approved #3: non_gst buckets with exempt/nil_rated (all three
  // collect no tax). Approved #2: the mixed+registered edge case (T-8) stores tax_invoice (the
  // document that actually carries tax — invoice_cum_bos is specifically the unregistered-buyer
  // document per GST Rule 46A) and is surfaced via the audit narration, not a 4th enum value.
  const nonTaxClassifications = new Set(["exempt", "nil_rated", "non_gst"]);
  const classifications = new Set(lines.map((l) => l.taxClassification));
  const allTaxable = [...classifications].every((c) => c === "taxable");
  const allNonTax = [...classifications].every((c) => nonTaxClassifications.has(c));

  let documentType: ResolvedSale["documentType"];
  let mixedRegisteredEdgeCase = false;
  if (allTaxable) {
    documentType = "tax_invoice";
  } else if (allNonTax) {
    documentType = "bill_of_supply";
  } else if (!buyerRegistered) {
    documentType = "invoice_cum_bos";
  } else {
    documentType = "tax_invoice";
    mixedRegisteredEdgeCase = true;
  }

  return {
    branch,
    companyProfile,
    customerId,
    customerLedgerId,
    customerName,
    customerVillage,
    voucherDate: params.voucherDate,
    placeOfSupplyStateCode,
    isInterState,
    documentType,
    mixedRegisteredEdgeCase,
    lines,
    totals: { totalTaxable, totalDiscount, totalCgst, totalSgst, totalIgst, roundOff, grandTotal },
  };
}

// ============================================================================
// ledger_postings assembly — TDD §26 step 10 / §18.3. resolveSystemLedgers checks only the
// ledgers THIS sale actually needs (per the design-review-approved gate), never the full set.
// ============================================================================

interface SystemLedgers {
  cashLedgerId: string | null;
  salesLedgerId: string | null;
  cgstLedgerId: string | null;
  sgstLedgerId: string | null;
  igstLedgerId: string | null;
  roundOffLedgerId: string | null;
}

function requireSystemLedger(value: string | null, ledger: string): string {
  if (value == null) throw new ConflictError("SYSTEM_LEDGER_NOT_CONFIGURED", { ledger });
  return value;
}

function resolveSystemLedgers(resolved: ResolvedSale, paidCash: bigint): SystemLedgers {
  const { totalTaxable, totalCgst, totalSgst, totalIgst, roundOff } = resolved.totals;
  return {
    cashLedgerId: paidCash > 0n ? requireSystemLedger(resolved.branch.cashLedgerId, "branch.cashLedgerId") : null,
    salesLedgerId:
      totalTaxable > 0n ? requireSystemLedger(resolved.companyProfile.salesLedgerId, "companyProfile.salesLedgerId") : null,
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

function buildPostings(
  resolved: ResolvedSale,
  systemLedgers: SystemLedgers,
  paymentSplit: { paidCash: bigint; paidBank: bigint; bankLedgerId: string | null; creditUdhar: bigint },
): PostingInput[] {
  const postings: PostingInput[] = [];
  const push = (ledgerId: string | null, amount: bigint): void => {
    if (amount !== 0n && ledgerId) postings.push({ ledgerId, amount });
  };

  push(systemLedgers.cashLedgerId, paymentSplit.paidCash);
  push(paymentSplit.bankLedgerId, paymentSplit.paidBank);
  push(resolved.customerLedgerId, paymentSplit.creditUdhar);
  push(systemLedgers.salesLedgerId, -resolved.totals.totalTaxable);
  push(systemLedgers.cgstLedgerId, -resolved.totals.totalCgst);
  push(systemLedgers.sgstLedgerId, -resolved.totals.totalSgst);
  push(systemLedgers.igstLedgerId, -resolved.totals.totalIgst);
  push(systemLedgers.roundOffLedgerId, -resolved.totals.roundOff);

  return postings;
}

// ============================================================================
// Shared row-shaping + audit helpers
// ============================================================================

function lineToRow(line: ResolvedLine, lineNumber: number, saleId: string, resolved: ResolvedSale, actor: SaleActor) {
  return {
    saleId,
    lineNumber,
    productId: line.productId,
    customerId: resolved.customerId,
    branchId: actor.branchId,
    saleDate: resolved.voucherDate,
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

// Reference-only per §13's transaction-entity exception — entity id (via writeAudit's entityId)
// plus a one-line summary, never the full row. Approved #2: the T-8 mixed+registered edge case
// gets an explicit narration line here (document_type alone can't carry it — the CHECK constraint
// has no 4th value), so the warning half of that locked decision isn't silently dropped.
function auditSummary(resolved: ResolvedSale, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    customerId: resolved.customerId,
    customerName: resolved.customerName,
    documentType: resolved.documentType,
    grandTotal: resolved.totals.grandTotal.toString(),
    ...(resolved.mixedRegisteredEdgeCase
      ? {
          note:
            "T-8 edge case (TDD §23.1 row 4 / §28.1): mixed taxable+exempt lines with a GST-registered buyer. Stored as tax_invoice; a separate Bill of Supply for the exempt lines was not auto-generated (out of Iteration-3 scope).",
        }
      : {}),
  };
}

// ============================================================================
// createDraft — TDD §28.2 park mechanics: a plain-shape insert (header + lines), no invoice
// number, no stock lock, no postings/movements. Still runs resolveSale (needed to fill the line
// items' NOT NULL computed columns with real GST math, not placeholders), but does NOT persist
// its totals/document_type/place_of_supply_state_code onto the header — the schema documents all
// three as "snapshot at confirm" (TDD §25.1), and the unconditional
// chk_sales_payment_split CHECK (paid_cash+paid_bank+credit_udhar=grand_total) makes storing a
// nonzero grand_total on a draft impossible anyway: a parked bill has no payment split yet by
// definition (approved #5). Found via the golden-math suite, not by inspection — an early version
// of this function stored the computed totals here and every non-zero-total draft failed that
// CHECK at insert.
// ============================================================================

export async function createDraft(input: CreateDraftSaleInput, actor: SaleActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(async (tx) => {
    const resolved = await resolveSale(
      tx,
      {
        customerId: input.customerId,
        customerName: input.customerName,
        customerVillage: input.customerVillage,
        voucherDate: input.voucherDate,
        lines: input.lines,
      },
      actor,
    );

    const sale = await tx.sale.create({
      data: {
        branchId: actor.branchId,
        customerId: resolved.customerId,
        customerName: resolved.customerName,
        customerVillage: resolved.customerVillage,
        voucherDate: resolved.voucherDate,
        status: "draft",
        createdBy: actor.userId,
        updatedBy: actor.userId,
      },
    });

    await tx.saleLineItem.createMany({
      data: resolved.lines.map((line, index) => lineToRow(line, index + 1, sale.id, resolved, actor)),
    });

    await writeAudit(tx, actor, {
      action: "create",
      entityType: "sale",
      entityId: sale.id,
      after: auditSummary(resolved, { status: "draft" }),
    });

    const lineItems = await tx.saleLineItem.findMany({ where: { saleId: sale.id }, orderBy: { lineNumber: "asc" } });
    const responseBody = success(serializeBigInt({ ...sale, lineItems }));
    await completeIdempotencyKey(tx, idempotencyKey, responseBody);
    return responseBody;
  });
}

// ============================================================================
// confirmSale — TDD §26. Two entry modes converge here: a fresh create-and-confirm, or confirming
// an existing draft (payment split supplied now, per approved #5 — a parked bill has none yet).
// ============================================================================

async function loadDraftWorkingInput(
  tx: Tx,
  draftId: string,
  actor: SaleActor,
): Promise<{
  id: string;
  customerId: string | null;
  customerName: string;
  customerVillage: string;
  voucherDate: Date;
  lines: SaleLineInput[];
  auditBefore: Record<string, unknown>;
}> {
  const draft = await tx.sale.findFirst({ where: { id: draftId, deletedAt: null }, include: { lineItems: true } });
  // Branch mismatch reports as not-found rather than forbidden — same "don't leak existence
  // across branch isolation" posture as party.service.ts's getParty.
  if (!draft || draft.branchId !== actor.branchId) throw new NotFoundError("DRAFT_NOT_FOUND");
  if (draft.status !== "draft") throw new ConflictError("SALE_NOT_DRAFT", { status: draft.status });

  return {
    id: draft.id,
    customerId: draft.customerId,
    customerName: draft.customerName,
    customerVillage: draft.customerVillage,
    voucherDate: draft.voucherDate,
    lines: draft.lineItems.map((li) => ({
      productId: li.productId,
      unitRate: Number(li.unitRate),
      billedQty: li.billedQty.toNumber(),
      freeQty: li.freeQty.toNumber(),
      discount: Number(li.discount),
      priceIncludesGst: li.priceIncludesGst,
    })),
    // Captured here, not hardcoded at the call site — a draft's status/invoiceNumber/grandTotal
    // are always exactly this ("draft"/null/0, per createDraft never persisting totals until
    // confirm), but reading them off the row we already fetched avoids a second source of truth
    // for that invariant drifting out of sync with createDraft later.
    auditBefore: { status: draft.status, invoiceNumber: draft.invoiceNumber, grandTotal: draft.grandTotal.toString() },
  };
}

async function assertBankLedgerExists(tx: Tx, ledgerId: string): Promise<void> {
  const ledger = await tx.ledger.findFirst({ where: { id: ledgerId, deletedAt: null } });
  if (!ledger) throw new NotFoundError("BANK_LEDGER_NOT_FOUND");
}

export async function confirmSale(input: ConfirmSaleInput, actor: SaleActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(
    async (tx) => {
      const draftMode = isDraftConfirm(input);
      let existingSaleId: string | null = null;
      let draftAuditBefore: Record<string, unknown> | null = null;
      let saleParams: ResolveSaleParams;

      if (draftMode) {
        const draft = await loadDraftWorkingInput(tx, input.draftId, actor);
        existingSaleId = draft.id;
        draftAuditBefore = draft.auditBefore;
        saleParams = {
          customerId: draft.customerId ?? undefined,
          customerName: draft.customerId ? undefined : draft.customerName,
          customerVillage: draft.customerId ? undefined : draft.customerVillage,
          voucherDate: draft.voucherDate,
          lines: draft.lines,
        };
      } else {
        saleParams = {
          customerId: input.customerId,
          customerName: input.customerName,
          customerVillage: input.customerVillage,
          voucherDate: input.voucherDate,
          lines: input.lines,
        };
      }

      const paidCash = BigInt(input.paidCash);
      const paidBank = BigInt(input.paidBank);
      const creditUdhar = BigInt(input.creditUdhar);
      const bankLedgerId = input.bankLedgerId ?? null;

      // Step 1 preflight — the payment-shape rules resolveSale doesn't own.
      if (creditUdhar > 0n && !saleParams.customerId) {
        throw new BadRequestError("CUSTOMER_REQUIRED_FOR_UDHAR");
      }
      if (paidBank > 0n && !bankLedgerId) {
        throw new BadRequestError("BANK_LEDGER_REQUIRED");
      }
      if (bankLedgerId && paidBank > 0n) {
        await assertBankLedgerExists(tx, bankLedgerId);
      }

      const resolved = await resolveSale(tx, saleParams, actor);

      // Step 5 payment-split integrity — against the post-round-off grand_total (S-4).
      const paidSum = paidCash + paidBank + creditUdhar;
      if (paidSum !== resolved.totals.grandTotal) {
        throw new BadRequestError("PAYMENT_SPLIT_MISMATCH", {
          grandTotal: resolved.totals.grandTotal.toString(),
          paidSum: paidSum.toString(),
        });
      }

      // Step 2 — lock branch_stock rows FOR UPDATE, ascending product_id, sequentially awaited
      // (CC-6: never Promise.all — different lock orders across voucher types deadlock).
      const distinctProductIds = [...new Set(resolved.lines.map((l) => l.productId))].sort();
      const stockByProduct = new Map<string, { quantityMilli: number; avgCost: bigint }>();
      for (const productId of distinctProductIds) {
        const rows = await tx.$queryRaw<{ quantity: Prisma.Decimal; avgCost: bigint }[]>`
          SELECT quantity, avg_cost AS "avgCost" FROM branch_stock
          WHERE branch_id = ${actor.branchId}::uuid AND product_id = ${productId}::uuid
          FOR UPDATE`;
        const row = rows[0];
        stockByProduct.set(productId, {
          quantityMilli: row ? qtyToMilli(row.quantity.toNumber()) : 0,
          avgCost: row ? BigInt(row.avgCost) : 0n,
        });
      }

      // Step 3 — negative-stock hard-block, read under the lock taken above.
      const requiredMilliByProduct = new Map<string, number>();
      for (const line of resolved.lines) {
        const required = line.billedQtyMilli + line.freeQtyMilli;
        requiredMilliByProduct.set(line.productId, (requiredMilliByProduct.get(line.productId) ?? 0) + required);
      }
      for (const [productId, requiredMilli] of requiredMilliByProduct) {
        const stock = stockByProduct.get(productId)!;
        if (requiredMilli > stock.quantityMilli) {
          throw new InsufficientStockError({
            productId,
            available: stock.quantityMilli / 1000,
            requested: requiredMilli / 1000,
          });
        }
      }

      // Step 7 — allocate the invoice number (row-locked; concurrent confirms serialize here).
      const financialYear = deriveFinancialYear(resolved.voucherDate, resolved.companyProfile.fyStartMonth);
      const allocated = await allocateVoucherNumber(tx, {
        branchId: actor.branchId,
        voucherType: "sale",
        financialYear,
        defaultPrefix: null,
        actorId: actor.userId,
      });
      const invoiceNumber = formatVoucherNumber(resolved.branch.code, financialYear, allocated.sequenceNumber);

      // Step 8 — write header + line items. T-1: the line set is replaced (delete + reinsert)
      // even on a first-time draft confirm, so fresh and draft-confirm share one write path.
      const headerData = {
        customerId: resolved.customerId,
        customerName: resolved.customerName,
        customerVillage: resolved.customerVillage,
        voucherDate: resolved.voucherDate,
        status: "confirmed",
        invoiceNumber,
        financialYear,
        placeOfSupplyStateCode: resolved.placeOfSupplyStateCode,
        documentType: resolved.documentType,
        totalTaxable: resolved.totals.totalTaxable,
        totalDiscount: resolved.totals.totalDiscount,
        totalCgst: resolved.totals.totalCgst,
        totalSgst: resolved.totals.totalSgst,
        totalIgst: resolved.totals.totalIgst,
        roundOff: resolved.totals.roundOff,
        grandTotal: resolved.totals.grandTotal,
        paidCash,
        paidBank,
        creditUdhar,
        bankLedgerId,
        updatedBy: actor.userId,
      };

      const sale = existingSaleId
        ? await tx.sale.update({ where: { id: existingSaleId }, data: headerData })
        : await tx.sale.create({ data: { ...headerData, branchId: actor.branchId, createdBy: actor.userId } });

      if (existingSaleId) {
        await tx.saleLineItem.deleteMany({ where: { saleId: existingSaleId } });
      }
      await tx.saleLineItem.createMany({
        data: resolved.lines.map((line, index) => lineToRow(line, index + 1, sale.id, resolved, actor)),
      });

      // Step 9 — decrement stock + one merged sale_out movement per product (S-5), valued at
      // avg_cost (COGS, never sale price); avg_cost itself is unchanged on an outbound movement.
      for (const [productId, requiredMilli] of requiredMilliByProduct) {
        const stock = stockByProduct.get(productId)!;
        const value = divRoundHalfUp(stock.avgCost * BigInt(requiredMilli), 1000n);
        await tx.stockMovement.create({
          data: {
            productId,
            branchId: actor.branchId,
            quantityDelta: milliToDecimal(-requiredMilli),
            movementType: "sale_out",
            rate: stock.avgCost,
            value,
            voucherType: "sale",
            voucherId: sale.id,
            voucherDate: resolved.voucherDate,
            avgCostAfter: stock.avgCost,
            createdBy: actor.userId,
          },
        });
        await tx.branchStock.update({
          where: { branchId_productId: { branchId: actor.branchId, productId } },
          data: { quantity: { decrement: milliToDecimal(requiredMilli) } },
        });
      }

      // Step 10 — ledger postings sourced from the stored header totals (never recomputed).
      const systemLedgers = resolveSystemLedgers(resolved, paidCash);
      const postings = buildPostings(resolved, systemLedgers, { paidCash, paidBank, bankLedgerId, creditUdhar });
      const postingSum = postings.reduce((acc, p) => acc + p.amount, 0n);
      if (postingSum !== 0n) {
        // Internal invariant failure (§18.1) — should be unreachable given the algebra above;
        // deliberately not a domain AppError, this rolls back the transaction as a 500.
        throw new Error(`ledger_postings for sale ${sale.id} do not sum to zero (got ${postingSum.toString()})`);
      }
      if (postings.length > 0) {
        await tx.ledgerPosting.createMany({
          data: postings.map((p) => ({
            ledgerId: p.ledgerId,
            branchId: actor.branchId,
            amount: p.amount,
            voucherType: "sale",
            voucherId: sale.id,
            voucherDate: resolved.voucherDate,
            createdBy: actor.userId,
          })),
        });
      }

      // Step 11 — audit + idempotency completion, both inside this same tx. A fresh confirm is a
      // create — reference-only per §13's immutable-transaction-entity exception, no before.
      // Confirming an existing draft is an update (draft -> confirmed transition), and §13's edit
      // exception requires a real before/after snapshot, not reference-only — draftAuditBefore
      // (captured off the draft row in loadDraftWorkingInput, before it was overwritten above) is
      // that before.
      await writeAudit(tx, actor, {
        action: existingSaleId ? "update" : "create",
        entityType: "sale",
        entityId: sale.id,
        before: draftAuditBefore ?? undefined,
        after: auditSummary(resolved, { invoiceNumber, status: "confirmed" }),
      });

      const lineItems = await tx.saleLineItem.findMany({ where: { saleId: sale.id }, orderBy: { lineNumber: "asc" } });
      const responseBody = success(serializeBigInt({ ...sale, lineItems }));
      await completeIdempotencyKey(tx, idempotencyKey, responseBody);
      return responseBody;
    },
    // Heavier than any other transaction in the app (N sequential stock locks + number-series
    // lock + header/line writes + N stock movements + up to 6 ledger postings + audit +
    // idempotency), over the same remote Nepal<->Mumbai path — raised above runTransaction's
    // 20s default (CLAUDE.md: generous timeouts on DB work).
    { timeout: 30_000 },
  );
}
