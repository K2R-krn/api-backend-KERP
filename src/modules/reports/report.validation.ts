import { z } from "zod";

// Outstanding / ageing report (TDD §34). Wire-level query params are snake_case (TDD §3.6),
// mapped to camelCase in report.controller.ts before reaching the service layer.
// branch_id omitted = consolidated (super_admin only, enforced in report.service.ts).
// as_of omitted = today (also defaulted in report.controller.ts).
export const outstandingQuerySchema = z.object({
  branch_id: z.string().uuid().optional(),
  as_of: z.coerce.date().optional(),
});
export type OutstandingQuery = z.infer<typeof outstandingQuerySchema>;
