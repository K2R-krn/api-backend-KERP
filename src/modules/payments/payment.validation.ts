import { z } from "zod";

// Paise, bigint at rest. A payment/allocation of zero has no meaning — unlike sale/purchase line
// fields (nonnegative, since a zero-amount line item is a valid no-op), amount here must be > 0.
const money = z.number().int().positive();

// payment_allocations' own CHECK: exactly one of sale_id/purchase_id per entry (TDD §25.5/§31.6).
const allocationInputSchema = z
  .object({
    saleId: z.string().uuid().optional(),
    purchaseId: z.string().uuid().optional(),
    amount: money,
  })
  .superRefine((input, ctx) => {
    if ((input.saleId !== undefined) === (input.purchaseId !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of saleId/purchaseId is required per allocation entry",
        path: ["saleId"],
      });
    }
  });
export type AllocationInput = z.infer<typeof allocationInputSchema>;

// payments' own CHECK: exactly one of party_id/counter_ledger_id (TDD §25.4).
function refinePartyOrCounterLedger<T extends { partyId?: string; counterLedgerId?: string }>(input: T, ctx: z.RefinementCtx): void {
  if ((input.partyId !== undefined) === (input.counterLedgerId !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "exactly one of partyId/counterLedgerId is required",
      path: ["partyId"],
    });
  }
}

// confirmPayment (TDD §31) — applies to both standalone Receipt and Payment vouchers.
// cash_bank_ledger_id is caller-supplied per §31.1 (frontend-resolved via the branch's CC-7 FK) —
// never a symbolic { type: 'cash' } flag for this schema/service to resolve.
export const confirmPaymentSchema = z
  .object({
    direction: z.enum(["receipt", "payment"]),
    voucherDate: z.coerce.date(),
    cashBankLedgerId: z.string().uuid(),
    partyId: z.string().uuid().optional(),
    counterLedgerId: z.string().uuid().optional(),
    amount: money,
    reference: z.string().trim().min(1).optional(),
    notes: z.string().trim().min(1).optional(),
    // §31.6: sum(allocations.amount) <= amount, remainder implicitly on-account/advance — no flag.
    allocations: z.array(allocationInputSchema).optional(),
  })
  .superRefine(refinePartyOrCounterLedger);
export type ConfirmPaymentInput = z.infer<typeof confirmPaymentSchema>;

// Fast Expense Entry (TDD §31.5) — simplified input. direction ('payment'), cash_bank_ledger_id
// (branch cash via CC-7), and party_id (null) are fixed server-side in payment.service.ts's
// fastExpenseEntry wrapper, not caller-supplied here.
export const fastExpenseEntrySchema = z.object({
  voucherDate: z.coerce.date(),
  amount: money,
  expenseLedgerId: z.string().uuid(),
  reference: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
});
export type FastExpenseEntryInput = z.infer<typeof fastExpenseEntrySchema>;
