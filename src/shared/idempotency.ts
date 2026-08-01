import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/client.js";
import { IDEMPOTENCY_KEY_TTL_MS, IDEMPOTENCY_STALE_THRESHOLD_MS } from "./constants.js";
import { BadRequestError, ConflictError, UnauthorizedError } from "./errors.js";
import type { Tx } from "./audit.js";

function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}

/**
 * Pre-check half of TDD §14.2: validates/inserts the Idempotency-Key row, replays a completed
 * response, or rejects a concurrent/stale in-progress attempt. It does NOT flip the key to
 * "completed" — that must happen inside the service's own DB transaction (see
 * completeIdempotencyKey below), otherwise key-state and business-state could commit separately
 * and disagree after a crash. Nor does it delete the key on failure — the controller that calls
 * the service must do that in its own try/catch (see deleteIdempotencyKey below), since only the
 * controller actually awaits the service's outcome.
 *
 * No write endpoint exists yet to wire this into end-to-end (Iteration 3) — this lands the
 * mechanism so every Iteration-3 write endpoint inherits safe-retry for free (TDD §14.2 now-vs-later).
 */
export const requireIdempotencyKey = (scope: string) =>
  async function idempotencyPrecheck(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.auth) throw new UnauthorizedError();

    const key = req.header("idempotency-key");
    if (!key) throw new BadRequestError("IDEMPOTENCY_KEY_REQUIRED");

    const requestHash = hashRequestBody(req.body);
    const existing = await prisma.idempotencyKey.findUnique({ where: { key } });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new BadRequestError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
      }

      if (existing.status === "completed") {
        res.json(existing.response);
        return; // Replayed — do not call next(), the request is fully handled.
      }

      const ageMs = Date.now() - existing.createdAt.getTime();
      if (ageMs < IDEMPOTENCY_STALE_THRESHOLD_MS) {
        throw new ConflictError("IN_PROGRESS");
      }

      // Stale: safe to presume the original attempt is dead. This is only safe because of the
      // paired guarantee in TDD §16 — a ~10s statement/transaction timeout on API DB connections
      // means no transaction from the original attempt can still be alive at 60s.
      await prisma.idempotencyKey.delete({ where: { key } }).catch(() => undefined);
    }

    try {
      await prisma.idempotencyKey.create({
        data: {
          key,
          userId: req.auth.userId,
          scope,
          requestHash,
          status: "in_progress",
          expiresAt: new Date(Date.now() + IDEMPOTENCY_KEY_TTL_MS),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // Lost a race with a concurrent insert of the same key.
        throw new ConflictError("IN_PROGRESS");
      }
      throw err;
    }

    req.idempotencyKey = key;
    next();
  };

/** Call as the last write inside the service's own transaction, right before it commits. */
export async function completeIdempotencyKey(tx: Tx, key: string, response: unknown): Promise<void> {
  await tx.idempotencyKey.update({
    where: { key },
    data: { status: "completed", response: response as Prisma.InputJsonValue },
  });
}

/** Call from the controller's catch block on a handled service error (TDD §14.2 point 3). */
export async function deleteIdempotencyKey(key: string): Promise<void> {
  await prisma.idempotencyKey.delete({ where: { key } }).catch(() => undefined);
}
