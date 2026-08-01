import { PrismaClient, type Prisma } from "@prisma/client";
import { TRANSACTION_MAX_WAIT_MS, TRANSACTION_TIMEOUT_MS } from "../shared/constants.js";

declare global {
  var __prisma: PrismaClient | undefined;
}

export const prisma = globalThis.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = prisma;
}

/**
 * The one place every `$transaction` call in the app should go through, so the timeout is
 * consistent (and generous enough for a remote DB connection) instead of silently defaulting to
 * Prisma's tight 5000ms/2000ms, or being repeated ad hoc at each call site. Pass `options` to
 * override for a known-heavier transaction (e.g. the seed script's ~20 round trips).
 */
export function runTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  return prisma.$transaction(fn, {
    timeout: options?.timeout ?? TRANSACTION_TIMEOUT_MS,
    maxWait: options?.maxWait ?? TRANSACTION_MAX_WAIT_MS,
  });
}
