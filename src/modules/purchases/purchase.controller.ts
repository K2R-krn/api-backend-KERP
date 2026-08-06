import type { Request, Response } from "express";
import { success } from "../../shared/envelope.js";
import { deleteIdempotencyKey } from "../../shared/idempotency.js";
import { parseWithSchema } from "../../shared/validate.js";
import { serializeBigInt } from "../../shared/serialize.js";
import * as purchaseService from "./purchase.service.js";
import type { PurchaseActor } from "./purchase.service.js";
import { confirmPurchaseSchema } from "./purchase.validation.js";

// branchContext always runs before these controllers (see purchase.routes.ts) — safe to assert,
// same pattern as every other module's controller.
function actorFrom(req: Request): PurchaseActor {
  return { userId: req.auth!.userId, role: req.auth!.role, branchId: req.auth!.branchId! };
}

export async function confirm(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(confirmPurchaseSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await purchaseService.confirmPurchase(input, actorFrom(req), key);
    res.status(201).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function lastCost(req: Request, res: Response): Promise<void> {
  const result = await purchaseService.getLastCost(req.params.supplierId as string, req.params.productId as string, actorFrom(req));
  res.json(success(serializeBigInt(result)));
}
