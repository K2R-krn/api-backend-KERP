import { z } from "zod";

// Hand-written literals (not derived from shared/types.ts's ROLES) — same convention as
// party.validation.ts's partyType: this module's enum, not a reused shared tuple.
const roleSchema = z.enum(["super_admin", "admin", "employee", "accountant"]);

const branchIdsSchema = z
  .array(z.string().uuid())
  .refine((arr) => new Set(arr).size === arr.length, { message: "branchIds must not contain duplicates" });

// TDD §7.3 step 1: branch ids are supplied "for non-super-admin roles" — a super_admin bypasses
// user_branches entirely (§7.2), so assigning branches to one is rejected outright rather than
// silently accepted/ignored (dead rows nobody would ever consult). Every other role requires at
// least one branch; there'd be no branch the user could ever act in otherwise.
function checkRoleBranchPairing(
  data: { role: string; branchIds?: string[] },
  ctx: z.RefinementCtx,
): void {
  const hasBranches = (data.branchIds?.length ?? 0) > 0;
  if (data.role === "super_admin" && hasBranches) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["branchIds"],
      message: "super_admin users must not be assigned branches",
    });
  }
  if (data.role !== "super_admin" && !hasBranches) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["branchIds"],
      message: "branchIds is required for non-super-admin roles",
    });
  }
}

export const createUserSchema = z
  .object({
    username: z.string().trim().min(1),
    name: z.string().trim().min(1),
    email: z.string().trim().email().optional(),
    role: roleSchema,
    // Same minimum as auth.validation.ts's changePasswordSchema — one password policy, not two.
    initialPassword: z.string().min(8),
    branchIds: branchIdsSchema.optional(),
  })
  .superRefine(checkRoleBranchPairing);
export type CreateUserInput = z.infer<typeof createUserSchema>;

// username is deliberately absent — immutable post-creation (login identity behind
// ux_users_username_active), same "not in the schema" treatment every other module gives its
// non-editable fields. password is also absent — that's the separate change-password flow.
export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    email: z.string().trim().email().optional(),
    role: roleSchema.optional(),
    branchIds: branchIdsSchema.optional(),
    isActive: z.boolean().optional(),
  })
  // Only catches self-contained contradictions (role + branchIds disagree within this same
  // request) — NOT "role is non-super-admin and branchIds is simply absent", since an absent
  // branchIds on update means "leave branch membership as-is" (resolved against the user's
  // *existing* rows in user.service.ts, which needs DB state this schema doesn't have). Reusing
  // create's checkRoleBranchPairing here was wrong: it treats "omitted" and "explicitly empty"
  // as the same case, which unconditionally requires branchIds whenever role is being changed to
  // anything non-super-admin — rejecting every plain role-change request before it reaches the
  // service's existing-branches fallback. Caught live via the smoke test, not by the service
  // tests (they call the service directly, bypassing this schema entirely).
  .superRefine((data, ctx) => {
    if (data.role === undefined) return;
    if (data.role === "super_admin" && (data.branchIds?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["branchIds"],
        message: "super_admin users must not be assigned branches",
      });
    }
    if (data.role !== "super_admin" && data.branchIds !== undefined && data.branchIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["branchIds"],
        message: "branchIds must not be explicitly empty for a non-super-admin role",
      });
    }
  });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).optional(),
  role: roleSchema.optional(),
  isActive: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;