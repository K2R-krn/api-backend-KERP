import { z } from "zod";

// Ledger statement view (TDD §33) — date-range filter, both ends optional.
export const ledgerStatementQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type LedgerStatementQuery = z.infer<typeof ledgerStatementQuerySchema>;
