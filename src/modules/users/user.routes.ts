import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import * as userController from "./user.controller.js";

export const userRouter = Router();

// user:manage is super_admin-only end to end (TDD §7.2/§7.3) — every route below, reads included,
// requires it. No branchContext (see user.service.ts for why, same reasoning as branch.routes.ts).
userRouter.get("/", authenticate, requireCap("user:manage"), userController.list);
userRouter.get("/:id", authenticate, requireCap("user:manage"), userController.get);

userRouter.post(
  "/",
  authenticate,
  requireCap("user:manage"),
  requireIdempotencyKey("user:create"),
  userController.create,
);
userRouter.patch(
  "/:id",
  authenticate,
  requireCap("user:manage"),
  requireIdempotencyKey("user:update"),
  userController.update,
);