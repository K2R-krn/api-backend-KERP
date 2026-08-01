import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import { branchContext } from "../../middleware/branch-context.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import * as categoryController from "./category.controller.js";

export const categoryRouter = Router();

categoryRouter.get("/", authenticate, requireCap("category:read"), branchContext, categoryController.list);
categoryRouter.get("/:id", authenticate, requireCap("category:read"), branchContext, categoryController.get);

categoryRouter.post(
  "/",
  authenticate,
  requireCap("category:write"),
  branchContext,
  requireIdempotencyKey("category:create"),
  categoryController.create,
);
categoryRouter.patch(
  "/:id",
  authenticate,
  requireCap("category:write"),
  branchContext,
  requireIdempotencyKey("category:update"),
  categoryController.update,
);
categoryRouter.delete(
  "/:id",
  authenticate,
  requireCap("category:write"),
  branchContext,
  requireIdempotencyKey("category:delete"),
  categoryController.remove,
);
