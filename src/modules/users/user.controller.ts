import type { Request, Response } from "express";
import { success } from "../../shared/envelope.js";
import { deleteIdempotencyKey } from "../../shared/idempotency.js";
import { parseWithSchema } from "../../shared/validate.js";
import * as userService from "./user.service.js";
import type { UserActor } from "./user.service.js";
import { createUserSchema, listUsersQuerySchema, updateUserSchema } from "./user.validation.js";

// Users routes don't run branchContext (see user.service.ts) — branchId comes only from the
// authenticated user's token and may legitimately be absent, same as branch.controller.ts.
function actorFrom(req: Request): UserActor {
  return { userId: req.auth!.userId, role: req.auth!.role, branchId: req.auth!.branchId };
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(createUserSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await userService.createUser(input, actorFrom(req), key);
    res.status(201).json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseWithSchema(listUsersQuerySchema, req.query);
  const result = await userService.listUsers(query);
  res.json(success(result.items, { total: result.total, page: result.page, limit: result.limit }));
}

export async function get(req: Request, res: Response): Promise<void> {
  const user = await userService.getUser(req.params.id as string);
  res.json(success(user));
}

export async function update(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(updateUserSchema, req.body);
  const key = req.idempotencyKey!;
  try {
    const responseBody = await userService.updateUser(req.params.id as string, input, actorFrom(req), key);
    res.json(responseBody);
  } catch (err) {
    await deleteIdempotencyKey(key);
    throw err;
  }
}