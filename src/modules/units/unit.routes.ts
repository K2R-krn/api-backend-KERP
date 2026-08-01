import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import { branchContext } from "../../middleware/branch-context.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import * as unitController from "./unit.controller.js";

export const unitRouter = Router();

unitRouter.get("/", authenticate, requireCap("unit:read"), branchContext, unitController.list);
unitRouter.get("/:id", authenticate, requireCap("unit:read"), branchContext, unitController.get);

unitRouter.post(
  "/",
  authenticate,
  requireCap("unit:write"),
  branchContext,
  requireIdempotencyKey("unit:create"),
  unitController.create,
);
unitRouter.patch(
  "/:id",
  authenticate,
  requireCap("unit:write"),
  branchContext,
  requireIdempotencyKey("unit:update"),
  unitController.update,
);
unitRouter.delete(
  "/:id",
  authenticate,
  requireCap("unit:write"),
  branchContext,
  requireIdempotencyKey("unit:delete"),
  unitController.remove,
);
