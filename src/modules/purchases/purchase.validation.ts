import { z } from "zod";

// Paise, bigint at rest. unitRate/discount are never signed (TDD §25.2, mirrored on purchases per
// §25.3); payment-split fields are nonnegative by the same rule.
const money = z.number().int().nonnegative();

// numeric(12,3) — at most 3 decimal places (mirrors sale.validation.ts's qty check).
const qty = z.number().nonnegative().refine((v) => Number.isInteger(Math.round(v * 1000)), {
  message: "quantity supports at most 3 decimal places",
});

export const purchaseLineInputSchema = z.object({
  productId: z.string().uuid(),
  // "net purchase cost per unit" (TDD §27 Inputs) — the discount/GST corrections resolved during
  // this session (see purchase.service.ts computeLine) derive the actual cost basis from this plus
  // discount/priceIncludesGst, not from unitRate alone.
  unitRate: z.number().int().nonnegative(),
  billedQty: qty,
  freeQty: qty.default(0),
  discount: money.default(0),
  priceIncludesGst: z.boolean(),
});
export type PurchaseLineInput = z.infer<typeof purchaseLineInputSchema>;

// TDD §27: purchases have a single entry mode (fresh create-and-confirm) — unlike sales, there is
// no hold/park equivalent (§28.2 and the Blueprint's hold/park description are both framed only in
// terms of sales/billing; §27 never opens with confirmSale's "fresh confirm, or confirming a
// parked draft" framing the way §26 does). No draft schema, no draftId variant.
export const confirmPurchaseSchema = z.object({
  supplierId: z.string().uuid(),
  // The supplier's own bill identity — distinct from our internal number_series voucher_number,
  // stored as-entered, never generated (TDD §25.3).
  supplierInvoiceNumber: z.string().trim().min(1).optional(),
  supplierInvoiceDate: z.coerce.date().optional(),
  voucherDate: z.coerce.date(),
  lines: z.array(purchaseLineInputSchema).min(1),
  paidCash: money.default(0),
  paidBank: money.default(0),
  bankLedgerId: z.string().uuid().optional(),
  creditToSupplier: money.default(0),
});
export type ConfirmPurchaseInput = z.infer<typeof confirmPurchaseSchema>;
