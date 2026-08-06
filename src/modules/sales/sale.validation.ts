import { z } from "zod";

// Paise, bigint at rest. unitRate/discount are never signed (TDD §25.2); payment-split fields are
// nonnegative by the same rule — a negative payment/credit has no meaning here.
const money = z.number().int().nonnegative();

// numeric(12,3) — at most 3 decimal places (mirrors product.validation.ts's gstRate 2-decimal
// check for the same reason: enforce the column's shape, not a business rule).
const qty = z.number().nonnegative().refine((v) => Number.isInteger(Math.round(v * 1000)), {
  message: "quantity supports at most 3 decimal places",
});

export const saleLineInputSchema = z.object({
  productId: z.string().uuid(),
  unitRate: z.number().int().nonnegative(),
  billedQty: qty,
  freeQty: qty.default(0),
  discount: money.default(0),
  // TDD §26 Inputs: "the effective priceIncludesGst per line" is caller-supplied, not derived
  // from the product master at compute time (unlike gstRate/taxClassification/hsnCode, which are
  // live product snapshots — see resolveSale in sale.service.ts).
  priceIncludesGst: z.boolean(),
});
export type SaleLineInput = z.infer<typeof saleLineInputSchema>;

// Shared by both create-flows (fresh draft and fresh create-and-confirm). Approved resolution
// (#1): when customerId is given, customerName/customerVillage are ALWAYS the party's own
// snapshot — the caller must not also supply them (avoids the caller silently believing an
// override took effect). When customerId is absent (anonymous sale), both become required
// free-text input.
const saleCustomerFields = {
  customerId: z.string().uuid().optional(),
  customerName: z.string().trim().min(1).optional(),
  customerVillage: z.string().trim().min(1).optional(),
};

function refineCustomerFields<T extends { customerId?: string; customerName?: string; customerVillage?: string }>(
  input: T,
  ctx: z.RefinementCtx,
): void {
  if (input.customerId) {
    if (input.customerName !== undefined || input.customerVillage !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "customerName/customerVillage must not be supplied when customerId is given — they are always snapshotted from the party",
        path: ["customerName"],
      });
    }
    return;
  }
  if (!input.customerName || !input.customerVillage) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "customerName and customerVillage are required for an anonymous (no customerId) sale",
      path: ["customerName"],
    });
  }
}

// Park mechanics only (TDD §28.2): a plain insert, no payment split (undecided until confirm).
export const createDraftSaleSchema = z
  .object({
    ...saleCustomerFields,
    voucherDate: z.coerce.date(),
    lines: z.array(saleLineInputSchema).min(1),
  })
  .superRefine(refineCustomerFields);
export type CreateDraftSaleInput = z.infer<typeof createDraftSaleSchema>;

const paymentSplitFields = {
  paidCash: money.default(0),
  paidBank: money.default(0),
  bankLedgerId: z.string().uuid().optional(),
  creditUdhar: money.default(0),
};

// Fresh entry mode: create-and-confirm in one call (TDD §26/§28.2).
export const confirmFreshSaleSchema = z
  .object({
    ...saleCustomerFields,
    voucherDate: z.coerce.date(),
    lines: z.array(saleLineInputSchema).min(1),
    ...paymentSplitFields,
  })
  .superRefine(refineCustomerFields);
export type ConfirmFreshSaleInput = z.infer<typeof confirmFreshSaleSchema>;

// Confirm-existing-draft entry mode (TDD §28.2): the draft supplies customer/lines; payment is
// decided now, at confirm time, per the approved #5 resolution (a parked bill has no payment yet).
export const confirmDraftSaleSchema = z.object({
  draftId: z.string().uuid(),
  ...paymentSplitFields,
});
export type ConfirmDraftSaleInput = z.infer<typeof confirmDraftSaleSchema>;

export type ConfirmSaleInput = ConfirmDraftSaleInput | ConfirmFreshSaleInput;

export function isDraftConfirm(input: ConfirmSaleInput): input is ConfirmDraftSaleInput {
  return "draftId" in input;
}

// HTTP boundary only (TDD §28.2 "confirmSale accepts two entry modes") — the service itself
// stays typed on the narrower ConfirmSaleInput union; this just lets the controller validate
// either shape from one POST /sales/confirm body via parseWithSchema.
export const confirmSaleSchema = z.union([confirmDraftSaleSchema, confirmFreshSaleSchema]);
