import type { Request, Response } from "express";
import { success } from "../../shared/envelope.js";
import { deleteIdempotencyKey } from "../../shared/idempotency.js";
import { parseWithSchema } from "../../shared/validate.js";
import { serializeBigInt } from "../../shared/serialize.js";
import * as categoryService from "./category.service.js";
import type { CategoryActor } from "./category.service.js";
import { createCategorySchema, listCategoriesQuerySchema, updateCategorySchema } from "./category.validation.js";

// branchContext always runs before these controllers (see category.routes.ts) and rejects the
// request before reaching here if auth/branchId are missing — safe to assert.
function actorFrom(req: Request): CategoryActor {
  return { userId: req.auth!.userId, role: req.auth!.role, branchId: req.auth!.branchId! };
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(createCategorySchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await categoryService.createCategory(input, actorFrom(req), key);
    res.status(201).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseWithSchema(listCategoriesQuerySchema, req.query);
  const result = await categoryService.listCategories(query);
  res.json(success(serializeBigInt(result.items), { total: result.total, page: result.page, limit: result.limit }));
}

export async function get(req: Request, res: Response): Promise<void> {
  const category = await categoryService.getCategory(req.params.id as string);
  res.json(success(serializeBigInt(category)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(updateCategorySchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await categoryService.updateCategory(req.params.id as string, input, actorFrom(req), key);
    res.json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const key = req.idempotencyKey!;
  try {
    const responseBody = await categoryService.deleteCategory(req.params.id as string, actorFrom(req), key);
    res.json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}
