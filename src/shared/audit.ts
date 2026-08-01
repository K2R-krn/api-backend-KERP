import { Prisma } from "@prisma/client";
import { serializeBigInt } from "./serialize.js";
import type { AuthContext } from "./types.js";

export type Tx = Prisma.TransactionClient;

export type AuditAction =
  | "create"
  | "update"
  | "cancel"
  | "login"
  | "change_password"
  | "logout"
  | "deactivate"
  | "token_reuse_detected";

export interface AuditEvent {
  action: AuditAction;
  entityType: string;
  entityId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as never).getTime() === new Date(b as never).getTime();
  }
  if (typeof a === "bigint" || typeof b === "bigint") return String(a) === String(b);
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    return JSON.stringify(serializeBigInt(a)) === JSON.stringify(serializeBigInt(b));
  }
  return a === b;
}

/** Keeps only changed-fields on update; full row on create; never called for reads (TDD §13). */
export function leanDiff(
  before?: Record<string, unknown> | null,
  after?: Record<string, unknown> | null,
): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
  if (before == null) return { before: null, after: after ?? null };
  if (after == null) return { before, after: null };

  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!valuesEqual(before[key], after[key])) {
      changedBefore[key] = before[key];
      changedAfter[key] = after[key];
    }
  }
  return { before: changedBefore, after: changedAfter };
}

function toJsonInput(value: Record<string, unknown> | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/**
 * Always call inside the same transaction as the change it records (TDD §13) — that's what
 * guarantees the audit trail can never drift from the data it describes.
 */
export async function writeAudit(tx: Tx, ctx: AuthContext, event: AuditEvent): Promise<void> {
  const { before, after } = leanDiff(event.before, event.after);
  await tx.auditLog.create({
    data: {
      userId: ctx.userId,
      branchId: ctx.branchId ?? null,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      before: toJsonInput(before),
      after: toJsonInput(after),
    },
  });
}
