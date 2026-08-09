import { prisma } from "../db/client.js";
import { ForbiddenError } from "./errors.js";
import type { Role } from "./types.js";

// Object-level branch check for read endpoints whose target's branch is a property of the thing
// being viewed (a ledger, a bill) rather than an "acting branch" the request declares up front —
// branchContext's mandatory-branch model doesn't fit those (it always requires branch_id and
// always checks it). super_admin bypasses; every other role needs a user_branches row for the
// target's branch. A null branchId (shared ledger, or a consolidated report already permitted for
// this role) has nothing to check — callers decide separately whether null is allowed at all.
export async function assertBranchAccess(actor: { userId: string; role: Role }, branchId: string | null): Promise<void> {
  if (branchId === null || actor.role === "super_admin") return;
  const membership = await prisma.userBranch.findUnique({
    where: { userId_branchId: { userId: actor.userId, branchId } },
  });
  if (!membership) throw new ForbiddenError("BRANCH_NOT_ALLOWED");
}
