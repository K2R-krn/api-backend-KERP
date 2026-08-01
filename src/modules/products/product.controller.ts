import type { Request, Response } from "express";
import { success } from "../../shared/envelope.js";
import { deleteIdempotencyKey } from "../../shared/idempotency.js";
import { parseWithSchema } from "../../shared/validate.js";
import { serializeBigInt } from "../../shared/serialize.js";
import * as productService from "./product.service.js";
import type { ProductActor } from "./product.service.js";
import { createProductSchema, listProductsQuerySchema, updateProductSchema } from "./product.validation.js";

// branchContext always runs before these controllers (see product.routes.ts) and rejects the
// request before reaching here if auth/branchId are missing — safe to assert.
function actorFrom(req: Request): ProductActor {
  return { userId: req.auth!.userId, role: req.auth!.role, branchId: req.auth!.branchId! };
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(createProductSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await productService.createProduct(input, actorFrom(req), key);
    res.status(201).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseWithSchema(listProductsQuerySchema, req.query);
  const result = await productService.listProducts(query);
  // purchasePrice/salePrice/mrp are bigint — serialize unconditionally, same as get() (bug #2).
  res.json(
    success(serializeBigInt(result.items), { total: result.total, page: result.page, limit: result.limit }),
  );
}

export async function get(req: Request, res: Response): Promise<void> {
  const product = await productService.getProduct(req.params.id as string);
  res.json(success(serializeBigInt(product)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(updateProductSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await productService.updateProduct(req.params.id as string, input, actorFrom(req), key);
    res.json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  const key = req.idempotencyKey!;
  try {
    const responseBody = await productService.deactivateProduct(req.params.id as string, actorFrom(req), key);
    res.json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}
