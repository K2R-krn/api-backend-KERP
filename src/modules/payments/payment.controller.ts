import type { Request, Response } from "express";
import { deleteIdempotencyKey } from "../../shared/idempotency.js";
import { parseWithSchema } from "../../shared/validate.js";
import * as paymentService from "./payment.service.js";
import type { PaymentActor } from "./payment.service.js";
import { confirmPaymentSchema, fastExpenseEntrySchema } from "./payment.validation.js";

// branchContext always runs before these controllers (see payment.routes.ts) — safe to assert,
// same pattern as every other module's controller.
function actorFrom(req: Request): PaymentActor {
  return { userId: req.auth!.userId, role: req.auth!.role, branchId: req.auth!.branchId! };
}

export async function confirm(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(confirmPaymentSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await paymentService.confirmPayment(input, actorFrom(req), key);
    res.status(201).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function expense(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(fastExpenseEntrySchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await paymentService.fastExpenseEntry(input, actorFrom(req), key);
    res.status(201).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}
