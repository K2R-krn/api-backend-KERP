import type { Request, Response } from "express";
import { success } from "../../shared/envelope.js";
import { deleteIdempotencyKey } from "../../shared/idempotency.js";
import { parseWithSchema } from "../../shared/validate.js";
import { serializeBigInt } from "../../shared/serialize.js";
import * as saleService from "./sale.service.js";
import type { SaleActor } from "./sale.service.js";
import { cancelSaleSchema, confirmSaleSchema, createDraftSaleSchema, editSaleSchema, isDraftConfirm } from "./sale.validation.js";

// branchContext always runs before these controllers (see sale.routes.ts) and rejects the request
// before reaching here if auth/branchId are missing — safe to assert, same pattern as every other
// module's controller.
function actorFrom(req: Request): SaleActor {
  return { userId: req.auth!.userId, role: req.auth!.role, branchId: req.auth!.branchId! };
}

export async function draft(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(createDraftSaleSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await saleService.createDraft(input, actorFrom(req), key);
    res.status(201).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function confirm(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(confirmSaleSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await saleService.confirmSale(input, actorFrom(req), key);
    // draft-confirm is a transition on an existing row (200); a fresh confirm creates one (201) —
    // mirrors confirmSale's own create-vs-update branching (TDD §28.2).
    res.status(isDraftConfirm(input) ? 200 : 201).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function edit(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(editSaleSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await saleService.editSale(req.params.id as string, input, actorFrom(req), key);
    res.status(200).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function cancel(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(cancelSaleSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await saleService.cancelSale(req.params.id as string, input, actorFrom(req), key);
    res.status(200).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function lastPrice(req: Request, res: Response): Promise<void> {
  const result = await saleService.getLastPrice(req.params.customerId as string, req.params.productId as string, actorFrom(req));
  // unitRate/effectiveRate are bigint — serializeBigInt(null) is a safe no-op, same pattern as
  // every other read endpoint in this codebase.
  res.json(success(serializeBigInt(result)));
}

export async function invoice(req: Request, res: Response): Promise<void> {
  const payload = await saleService.getInvoicePayload(req.params.id as string, actorFrom(req));
  res.json(success(serializeBigInt(payload)));
}
