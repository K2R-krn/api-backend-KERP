import { Prisma } from "@prisma/client";
import { prisma, runTransaction } from "../../db/client.js";
import { writeAudit, type Tx } from "../../shared/audit.js";
import { completeIdempotencyKey } from "../../shared/idempotency.js";
import { BadRequestError, ConflictError, InsufficientStockError, NotFoundError } from "../../shared/errors.js";
import { success } from "../../shared/envelope.js";
import { serializeBigInt } from "../../shared/serialize.js";
import { amountInWords } from "../../shared/amount-in-words.js";
import { deriveFinancialYear } from "../../shared/financial-year.js";
import { allocateVoucherNumber, formatVoucherNumber } from "../../shared/number-series.js";
import type { Role } from "../../shared/types.js";
import { isDraftConfirm } from "./sale.validation.js";
import type { CancelSaleInput, ConfirmSaleInput, CreateDraftSaleInput, EditSaleInput, SaleLineInput } from "./sale.validation.js";

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

// Narrowed to just the fields resolveSystemLedgers/buildPostings actually touch. A full
// ResolvedSale (confirmSale/editSale's re-apply) satisfies this structurally, but editSale's
// reversal (TDD §28.4) also needs to feed these two functions a shape built from the sale's
// *stored* pre-edit header — which was never a live resolveSale result — so the parameter type is
// the Pick, not ResolvedSale itself.
type PostingSourceSale = Pick<ResolvedSale, "branch" | "companyProfile" | "customerLedgerId" | "totals">;

function resolveSystemLedgers(resolved: PostingSourceSale, paidCash: bigint): SystemLedgers {
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
  resolved: PostingSourceSale,
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

// ============================================================================
// editSale / cancelSale — TDD §28.4 + Blueprint §6.11. Both reverse the sale's currently-effective
// stock/ledger footprint (append-only: new compensating rows, originals never mutated) inside one
// runTransaction, same CC-6 lock-ordering and failure/rollback discipline as confirmSale.
//
// Design-session-confirmed scope (see the two questions resolved before this code was written):
//   - editSale MAY change the customer (customerId/customerName/customerVillage), with these
//     guardrails: the OLD customer for reversal purposes comes from the sale's own stored
//     `customerId` (never re-derived from the caller's new input), looked up WITHOUT an
//     active/deletedAt filter (reversal targets whatever ledger the original posting actually hit,
//     it isn't validating a party as eligible for a new transaction); the NEW customer (if any)
//     goes through resolveSale's full live validation, identically to confirmSale; a nonzero
//     derived credit_udhar (positive OR negative/advance) with no resulting customer is rejected,
//     the same shape as confirmSale's CUSTOMER_REQUIRED_FOR_UDHAR check.
//     One-line FK re-confirmation (requested during design): sale_line_items.customerId stays a
//     real FK under this decision because it holds at the ROW level, not across the sale's
//     lifetime — T-1 means a line row is never updated in place, only deleted-and-replaced
//     wholesale, so a customer-changing edit simply deletes the old rows (still validly pointing
//     at the old customer, until deleted) and inserts entirely new rows carrying the new
//     customerId; no single row's FK value ever changes underneath it.
//   - voucherDate is NOT editable (confirmed fixed) — invoice_number/financial_year were allocated
//     once against it and are never reallocated on edit (§28.4), so letting the date drift would
//     reintroduce the exact frozen-field-vs-live-related-field contradiction the §28.6 invoice
//     payload session already caught once (there: customer GSTIN vs frozen document_type). A real
//     date correction is cancel-and-recreate, not this flow.
//   - There is no `edit_reason` column in the locked §25.1 schema (unlike `cancel_reason`) — edit
//     provenance lives entirely in the audit log's before/after snapshot (T-1's stated rationale).
// ============================================================================

// TDD §20 / §28.4 T-6 (locked): a sale whose voucher_date falls on or before the branch's last
// CLOSED day can't be edited/cancelled directly (Credit Note, or an audited Admin day-reopen,
// instead). Iteration 4 owns the day-close feature and its schema (roadmap §29.1) — as of this
// session there is no day-close table anywhere in the schema (checked: no such table/column exists
// yet), so nothing has ever been closed. This function is the single call site both editSale and
// cancelSale route through; it's written for real (not `if (false)` inlined at each call site) so
// that when Iteration 4 adds the day-close table, only this function's body gains a real query —
// callers and the error contract (a stable ConflictError code) never change.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- real signature for Iteration 4's future body; see comment above.
async function assertNotPastDayClose(_tx: Tx, _branchId: string, _voucherDate: Date): Promise<void> {
  // No day-close state exists yet — every voucher_date is therefore always "not closed." Once
  // Iteration 4 lands a day-close table, replace this body with a real lookup and throw
  // ConflictError("SALE_DATE_LOCKED_BY_DAY_CLOSE", { lastClosedDate }) when voucherDate <= it.
}

// Sums (billedQty + freeQty) per product from either a resolveSale line array or a sale's stored
// line items (after mapping to this shared shape) — used for both the OLD (what reversal restores)
// and NEW (what re-apply requires) required-quantity maps.
function sumRequiredMilliByProduct(lines: { productId: string; billedQtyMilli: number; freeQtyMilli: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) {
    const total = line.billedQtyMilli + line.freeQtyMilli;
    map.set(line.productId, (map.get(line.productId) ?? 0) + total);
  }
  return map;
}

// Shared by confirmSale's step-10 shape and both editSale's reversal/re-apply posting sets: assert
// the postings sum to zero (§18.1) and write them.
async function writePostings(tx: Tx, actor: SaleActor, saleId: string, voucherDate: Date, postings: PostingInput[]): Promise<void> {
  const sum = postings.reduce((acc, p) => acc + p.amount, 0n);
  if (sum !== 0n) {
    // Internal invariant failure — unreachable given buildPostings' algebra; not a domain AppError
    // (rolls back the transaction as a 500), same posture as confirmSale's own check.
    throw new Error(`ledger_postings for sale ${saleId} do not sum to zero (got ${sum.toString()})`);
  }
  if (postings.length > 0) {
    await tx.ledgerPosting.createMany({
      data: postings.map((p) => ({
        ledgerId: p.ledgerId,
        branchId: actor.branchId,
        amount: p.amount,
        voucherType: "sale",
        voucherId: saleId,
        voucherDate,
        createdBy: actor.userId,
      })),
    });
  }
}

type SaleWithLines = Prisma.SaleGetPayload<{ include: { lineItems: true } }>;

// Reverses a sale's CURRENTLY-effective stock and ledger footprint — used identically by editSale
// (before re-applying the revised lines) and cancelSale (which stops here). "Currently-effective"
// matters because ledger_postings/stock_movements are append-only with no batch/generation marker:
// after a sale has been edited more than once, simply querying-and-negating old posting rows would
// double-undo history. Instead this RECONSTRUCTS what confirmSale's own buildPostings would have
// produced from the sale's stored (pre-this-edit) header — via the same PostingSourceSale shape —
// and negates that, which is correct no matter how many prior edits happened, since the stored
// header is always the single current source of truth (CC-3). Stock reversal reads the CURRENT
// `sale_line_items` (always up to date, T-1 replace-not-append) for quantity, and looks up each
// product's most recent `sale_out`-type stock_movement for this voucher to get the exact rate to
// undo — "the original out-rate" in §28.4's wording, generalized to "whichever out-rate is
// currently in force," so avg_cost is neutrally restored regardless of edit count.
async function reverseSaleEffects(
  tx: Tx,
  actor: SaleActor,
  existing: SaleWithLines,
  branchAndCompany: { branch: ResolvedSale["branch"]; companyProfile: ResolvedSale["companyProfile"] },
  stockByProduct: Map<string, { quantityMilli: number; avgCost: bigint }>,
): Promise<Map<string, number>> {
  const oldRequiredMilliByProduct = sumRequiredMilliByProduct(
    existing.lineItems.map((li) => ({
      productId: li.productId,
      billedQtyMilli: qtyToMilli(li.billedQty.toNumber()),
      freeQtyMilli: qtyToMilli(li.freeQty.toNumber()),
    })),
  );

  // --- Stock: restore quantity at whichever rate is currently in force, avg_cost untouched. ---
  for (const [productId, requiredMilli] of oldRequiredMilliByProduct) {
    if (requiredMilli === 0) continue;
    const lastOut = await tx.stockMovement.findFirst({
      where: { voucherType: "sale", voucherId: existing.id, productId, movementType: "sale_out" },
      orderBy: { createdAt: "desc" },
    });
    if (!lastOut) {
      // Invariant: a confirmed sale with a nonzero required qty for this product must have written
      // a sale_out movement at confirm (or a prior edit's re-apply). Not a domain AppError.
      throw new Error(`invariant violated: no prior sale_out movement for sale ${existing.id} product ${productId}`);
    }
    const value = divRoundHalfUp(lastOut.rate * BigInt(requiredMilli), 1000n);
    await tx.stockMovement.create({
      data: {
        productId,
        branchId: actor.branchId,
        quantityDelta: milliToDecimal(requiredMilli),
        movementType: "sale_reversal_in",
        rate: lastOut.rate,
        value,
        voucherType: "sale",
        voucherId: existing.id,
        voucherDate: existing.voucherDate,
        referenceMovementId: lastOut.id,
        avgCostAfter: stockByProduct.get(productId)!.avgCost,
        createdBy: actor.userId,
      },
    });
    await tx.branchStock.update({
      where: { branchId_productId: { branchId: actor.branchId, productId } },
      data: { quantity: { increment: milliToDecimal(requiredMilli) } },
    });
    stockByProduct.get(productId)!.quantityMilli += requiredMilli;
  }

  // --- Ledger: reconstruct the current postings from the stored header, negate, write. ---
  let oldCustomerLedgerId: string | null = null;
  if (existing.customerId) {
    // No deletedAt/active filter — reversal targets whichever ledger the current posting set
    // actually hits, not eligibility for a new transaction (design-session guardrail).
    const oldParty = await tx.party.findFirst({ where: { id: existing.customerId } });
    if (!oldParty) {
      throw new Error(`invariant violated: customer ${existing.customerId} referenced by sale ${existing.id} not found`);
    }
    oldCustomerLedgerId = oldParty.ledgerId;
  }

  const oldState: PostingSourceSale = {
    branch: branchAndCompany.branch,
    companyProfile: branchAndCompany.companyProfile,
    customerLedgerId: oldCustomerLedgerId,
    totals: {
      totalTaxable: existing.totalTaxable,
      totalDiscount: existing.totalDiscount,
      totalCgst: existing.totalCgst,
      totalSgst: existing.totalSgst,
      totalIgst: existing.totalIgst,
      roundOff: existing.roundOff,
      grandTotal: existing.grandTotal,
    },
  };
  const oldSystemLedgers = resolveSystemLedgers(oldState, existing.paidCash);
  const oldPostings = buildPostings(oldState, oldSystemLedgers, {
    paidCash: existing.paidCash,
    paidBank: existing.paidBank,
    bankLedgerId: existing.bankLedgerId,
    creditUdhar: existing.creditUdhar,
  });
  await writePostings(
    tx,
    actor,
    existing.id,
    existing.voucherDate,
    oldPostings.map((p) => ({ ledgerId: p.ledgerId, amount: -p.amount })),
  );

  return oldRequiredMilliByProduct;
}

async function loadConfirmedSaleForEditOrCancel(tx: Tx, saleId: string, actor: SaleActor): Promise<SaleWithLines> {
  const existing = await tx.sale.findFirst({ where: { id: saleId, deletedAt: null }, include: { lineItems: true } });
  // Branch mismatch reports as not-found — same posture as loadDraftWorkingInput/getInvoicePayload.
  if (!existing || existing.branchId !== actor.branchId) throw new NotFoundError("SALE_NOT_FOUND");
  if (existing.status !== "confirmed") throw new ConflictError("SALE_NOT_CONFIRMED", { status: existing.status });
  return existing;
}

export async function editSale(saleId: string, input: EditSaleInput, actor: SaleActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(
    async (tx) => {
      const existing = await loadConfirmedSaleForEditOrCancel(tx, saleId, actor);
      await assertNotPastDayClose(tx, actor.branchId, existing.voucherDate);

      // Customer fields are optional on editSale's input (the design session approved letting edit
      // change the customer), but "all three omitted" must mean "keep the sale's existing
      // customer," not "anonymous" — resolveSale's own create-mode semantics would otherwise demand
      // customerName/customerVillage on every line-only edit of a named sale. Any field actually
      // supplied is treated as an explicit customer change, validated by resolveSale exactly like
      // confirmSale (approved #1: a given customerId always uses the party's own name/village
      // snapshot, never caller-supplied alongside it).
      const wantsCustomerChange = input.customerId !== undefined || input.customerName !== undefined || input.customerVillage !== undefined;
      const customerParams = wantsCustomerChange
        ? { customerId: input.customerId, customerName: input.customerName, customerVillage: input.customerVillage }
        : existing.customerId
          ? { customerId: existing.customerId }
          : { customerName: existing.customerName, customerVillage: existing.customerVillage };

      // Re-resolve the NEW state (fresh party/product reads, full GST recompute) — voucherDate is
      // pinned to the original (confirmed not editable, see the module-header note above).
      const resolved = await resolveSale(tx, { ...customerParams, voucherDate: existing.voucherDate, lines: input.lines }, actor);

      // T-5 (locked): paid_cash/paid_bank/bank_ledger_id are frozen — real money already moved and
      // never appear in editSale's input. credit_udhar is derived and may go negative (advance).
      const paidCash = existing.paidCash;
      const paidBank = existing.paidBank;
      const bankLedgerId = existing.bankLedgerId;
      const creditUdhar = resolved.totals.grandTotal - paidCash - paidBank;
      if (creditUdhar !== 0n && !resolved.customerId) {
        throw new BadRequestError("CUSTOMER_REQUIRED_FOR_UDHAR");
      }

      // CC-6 — lock branch_stock for the UNION of old and new products, ascending product_id.
      const unionProductIds = [
        ...new Set([...existing.lineItems.map((li) => li.productId), ...resolved.lines.map((l) => l.productId)]),
      ].sort();
      const stockByProduct = new Map<string, { quantityMilli: number; avgCost: bigint }>();
      for (const productId of unionProductIds) {
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

      // §28.4 step 3 — negative-stock block against the NEW required qty, net of what the
      // reversal below will restore (read under the lock taken above, same safety as confirmSale).
      const oldRequiredMilliByProduct = sumRequiredMilliByProduct(
        existing.lineItems.map((li) => ({
          productId: li.productId,
          billedQtyMilli: qtyToMilli(li.billedQty.toNumber()),
          freeQtyMilli: qtyToMilli(li.freeQty.toNumber()),
        })),
      );
      const newRequiredMilliByProduct = sumRequiredMilliByProduct(resolved.lines);
      for (const productId of unionProductIds) {
        const stock = stockByProduct.get(productId)!;
        const restored = oldRequiredMilliByProduct.get(productId) ?? 0;
        const required = newRequiredMilliByProduct.get(productId) ?? 0;
        const availableAfterReversal = stock.quantityMilli + restored;
        if (required > availableAfterReversal) {
          throw new InsufficientStockError({ productId, available: availableAfterReversal / 1000, requested: required / 1000 });
        }
      }

      // Reverse the currently-effective postings + stock (append-only, multi-edit-safe).
      await reverseSaleEffects(tx, actor, existing, { branch: resolved.branch, companyProfile: resolved.companyProfile }, stockByProduct);

      // Re-apply the revised lines — confirmSale steps 4-10, reused via resolveSale/buildPostings.
      // Invoice number/financial_year are retained (§28.4) — never touched here.
      const updatedSale = await tx.sale.update({
        where: { id: saleId },
        data: {
          customerId: resolved.customerId,
          customerName: resolved.customerName,
          customerVillage: resolved.customerVillage,
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
        },
      });

      // T-1: replace the line set (delete superseded + insert revised), history via the audit
      // snapshot below, never soft-deleted.
      await tx.saleLineItem.deleteMany({ where: { saleId } });
      await tx.saleLineItem.createMany({
        data: resolved.lines.map((line, index) => lineToRow(line, index + 1, saleId, resolved, actor)),
      });

      for (const [productId, requiredMilli] of newRequiredMilliByProduct) {
        if (requiredMilli === 0) continue;
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
            voucherId: saleId,
            voucherDate: existing.voucherDate,
            avgCostAfter: stock.avgCost,
            createdBy: actor.userId,
          },
        });
        await tx.branchStock.update({
          where: { branchId_productId: { branchId: actor.branchId, productId } },
          data: { quantity: { decrement: milliToDecimal(requiredMilli) } },
        });
      }

      const newSystemLedgers = resolveSystemLedgers(resolved, paidCash);
      const newPostings = buildPostings(resolved, newSystemLedgers, { paidCash, paidBank, bankLedgerId, creditUdhar });
      await writePostings(tx, actor, saleId, existing.voucherDate, newPostings);

      const lineItems = await tx.saleLineItem.findMany({ where: { saleId }, orderBy: { lineNumber: "asc" } });

      // §13's edit exception — full before/after snapshot (header + line array), not
      // reference-only. The line array is logged wholesale either way (leanDiff can't per-line
      // diff — T-1's rationale), so the full existing/updated rows (with their line items) are
      // passed straight through.
      await writeAudit(tx, actor, {
        action: "update",
        entityType: "sale",
        entityId: saleId,
        before: serializeBigInt(existing) as unknown as Record<string, unknown>,
        after: serializeBigInt({ ...updatedSale, lineItems }) as unknown as Record<string, unknown>,
      });

      const responseBody = success(serializeBigInt({ ...updatedSale, lineItems }));
      await completeIdempotencyKey(tx, idempotencyKey, responseBody);
      return responseBody;
    },
    // Heavier than confirmSale (reversal + re-apply in one tx) — same generous remote-DB timeout.
    { timeout: 30_000 },
  );
}

export async function cancelSale(saleId: string, input: CancelSaleInput, actor: SaleActor, idempotencyKey: string): Promise<unknown> {
  return runTransaction(
    async (tx) => {
      const existing = await loadConfirmedSaleForEditOrCancel(tx, saleId, actor);
      await assertNotPastDayClose(tx, actor.branchId, existing.voucherDate);

      const branch = await tx.branch.findFirst({ where: { id: actor.branchId, deletedAt: null } });
      if (!branch) throw new NotFoundError("BRANCH_NOT_FOUND");
      const companyProfile = await tx.companyProfile.findFirst({ where: { deletedAt: null } });
      if (!companyProfile) throw new ConflictError("COMPANY_PROFILE_NOT_CONFIGURED");

      // CC-6 — lock branch_stock for the sale's own products, ascending product_id.
      const productIds = [...new Set(existing.lineItems.map((li) => li.productId))].sort();
      const stockByProduct = new Map<string, { quantityMilli: number; avgCost: bigint }>();
      for (const productId of productIds) {
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

      // Same reversal as editSale's first half; cancelSale stops here — no re-apply.
      await reverseSaleEffects(tx, actor, existing, { branch, companyProfile }, stockByProduct);

      const updatedSale = await tx.sale.update({
        where: { id: saleId },
        data: {
          status: "cancelled",
          cancelReason: input.cancelReason,
          cancelledAt: new Date(),
          cancelledBy: actor.userId,
          updatedBy: actor.userId,
        },
      });

      // Same §13 edit-exception treatment as editSale — a status transition with real before/after.
      await writeAudit(tx, actor, {
        action: "cancel",
        entityType: "sale",
        entityId: saleId,
        before: serializeBigInt(existing) as unknown as Record<string, unknown>,
        after: serializeBigInt({ ...updatedSale, lineItems: existing.lineItems }) as unknown as Record<string, unknown>,
      });

      const responseBody = success(serializeBigInt({ ...updatedSale, lineItems: existing.lineItems }));
      await completeIdempotencyKey(tx, idempotencyKey, responseBody);
      return responseBody;
    },
    { timeout: 30_000 },
  );
}

// ============================================================================
// getLastPrice — TDD §28.1 sale-side recall. Post-seek branch filter (T-7a): the locked
// (customer_id, product_id, sale_date DESC) index (§6.14/§25.2) stays unchanged; branch_id is an
// extra predicate Postgres applies while walking the index-ordered rows, not a second index. No
// party-existence precheck — an unknown/foreign customerId just yields no matching lines, same
// outcome as "no prior sale" (§28.1 "endpoint stays pure").
// ============================================================================

export interface LastPriceResult {
  rate: bigint;
  effectiveRate: bigint;
  date: Date;
  quantity: Prisma.Decimal;
}

export async function getLastPrice(customerId: string, productId: string, actor: SaleActor): Promise<LastPriceResult | null> {
  const line = await prisma.saleLineItem.findFirst({
    where: {
      customerId,
      productId,
      branchId: actor.branchId,
      sale: { status: "confirmed", deletedAt: null },
    },
    // saleDate alone isn't a fully deterministic order on same-day repeat purchases — createdAt
    // is the tiebreaker (TDD doesn't discuss ties; this is the obvious resolution).
    orderBy: [{ saleDate: "desc" }, { createdAt: "desc" }],
  });
  if (!line) return null;

  // T-7b (locked): rate = unit_rate as entered (prefill); effectiveRate = round(line_total ÷
  // billed_qty) as separate display context, never fed back into a field.
  const billedQtyMilli = qtyToMilli(line.billedQty.toNumber());
  const effectiveRate = billedQtyMilli > 0 ? divRoundHalfUp(line.lineTotal * 1000n, BigInt(billedQtyMilli)) : 0n;

  return { rate: line.unitRate, effectiveRate, date: line.saleDate, quantity: line.billedQty };
}

// ============================================================================
// getInvoicePayload — TDD §28.6. Pure read/assembly at print time. company_profile/branch
// identity and the customer's live GSTIN are looked up fresh (a reprint should reflect the
// current letterhead, and there's no customer_gstin column on `sales` to freeze — §25.1 only
// denormalizes name/village). Every money figure and document_type come from the stored, frozen
// sale header/lines and are never recomputed or re-derived (CC-3). Guarded on `status !==
// "draft"` rather than `=== "confirmed"` so a future cancelSale (§28.4, not built yet) doesn't
// require revisiting this guard — a cancelled sale keeps its stored totals/lines untouched
// (§28.4 cancel step 3) and stays legitimately reprintable, marked cancelled.
// ============================================================================

const DOCUMENT_TITLES: Record<string, string> = {
  tax_invoice: "Tax Invoice",
  bill_of_supply: "Bill of Supply",
  invoice_cum_bos: "Invoice-cum-Bill of Supply",
};

export async function getInvoicePayload(saleId: string, actor: SaleActor): Promise<unknown> {
  const sale = await prisma.sale.findFirst({
    where: { id: saleId, deletedAt: null },
    include: { lineItems: { orderBy: { lineNumber: "asc" } } },
  });
  // Branch mismatch reports as not-found, same posture as loadDraftWorkingInput/party.getParty.
  if (!sale || sale.branchId !== actor.branchId) throw new NotFoundError("SALE_NOT_FOUND");
  if (sale.status === "draft") throw new ConflictError("SALE_NOT_CONFIRMED", { status: sale.status });

  const [branch, companyProfile, amendedCount] = await Promise.all([
    prisma.branch.findFirst({ where: { id: sale.branchId, deletedAt: null } }),
    prisma.companyProfile.findFirst({ where: { deletedAt: null } }),
    // "Amended" marker (§28.6, resolved per the design session): derived from an audit_logs EXISTS
    // check (entity_type='sale', action='update') rather than a stored flag — avoids a redundant
    // column for something the audit trail already proves.
    prisma.auditLog.count({ where: { entityType: "sale", entityId: saleId, action: "update" } }),
  ]);
  if (!branch) throw new NotFoundError("BRANCH_NOT_FOUND");
  if (!companyProfile) throw new ConflictError("COMPANY_PROFILE_NOT_CONFIGURED");

  return {
    company: {
      businessName: companyProfile.businessName,
      legalName: companyProfile.legalName,
      logoUrl: companyProfile.logoUrl,
      invoiceTerms: companyProfile.invoiceTerms,
      invoiceFooter: companyProfile.invoiceFooter,
    },
    branch: { name: branch.name, gstin: branch.gstin, address: branch.address, stateCode: branch.stateCode },
    documentTitle: DOCUMENT_TITLES[sale.documentType ?? ""] ?? sale.documentType,
    amended: amendedCount > 0,
    sale: {
      id: sale.id,
      invoiceNumber: sale.invoiceNumber,
      voucherDate: sale.voucherDate,
      status: sale.status,
      documentType: sale.documentType,
      placeOfSupplyStateCode: sale.placeOfSupplyStateCode,
      customer: {
        id: sale.customerId,
        name: sale.customerName,
        village: sale.customerVillage,
        // Deliberately NOT a live join to the party's current GSTIN — that's exactly the drift
        // document_type is frozen to avoid (a buyer who registered for GST after this sale would
        // make an old bill_of_supply reprint show a real GSTIN, a legally-relevant contradiction).
        // There's no customer_gstin snapshot column on `sales` (§25.1 only denormalizes
        // name/village), so there is genuinely nothing frozen to show here today — surfacing null
        // rather than live/possibly-wrong data. A real fix needs a schema addition (a
        // customer_gstin snapshot column written at confirm time, mirroring customer_name/
        // customer_village) — flagged, not silently added, per CLAUDE.md's schema-change rule.
        gstin: null as string | null,
      },
      totalTaxable: sale.totalTaxable,
      totalDiscount: sale.totalDiscount,
      totalCgst: sale.totalCgst,
      totalSgst: sale.totalSgst,
      totalIgst: sale.totalIgst,
      roundOff: sale.roundOff,
      grandTotal: sale.grandTotal,
      paidCash: sale.paidCash,
      paidBank: sale.paidBank,
      creditUdhar: sale.creditUdhar,
    },
    lineItems: sale.lineItems.map((li) => ({
      lineNumber: li.lineNumber,
      productId: li.productId,
      productName: li.productName,
      hsnCode: li.hsnCode,
      unitSymbol: li.unitSymbol,
      billedQty: li.billedQty,
      freeQty: li.freeQty,
      unitRate: li.unitRate,
      discount: li.discount,
      taxClassification: li.taxClassification,
      taxableValue: li.taxableValue,
      cgstAmount: li.cgstAmount,
      sgstAmount: li.sgstAmount,
      igstAmount: li.igstAmount,
      lineTotal: li.lineTotal,
    })),
    amountInWords: amountInWords(sale.grandTotal),
  };
}
