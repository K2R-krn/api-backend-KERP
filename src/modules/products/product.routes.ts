import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import { branchContext } from "../../middleware/branch-context.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import * as productController from "./product.controller.js";

export const productRouter = Router();

productRouter.get("/", authenticate, requireCap("product:read"), branchContext, productController.list);
// Must be registered before "/:id" — otherwise Express would match "search" as an :id param.
productRouter.get("/search", authenticate, requireCap("sale:read"), branchContext, productController.searchBilling);
productRouter.get("/:id", authenticate, requireCap("product:read"), branchContext, productController.get);

productRouter.post(
  "/",
  authenticate,
  requireCap("product:write"),
  branchContext,
  requireIdempotencyKey("product:create"),
  productController.create,
);
productRouter.patch(
  "/:id",
  authenticate,
  requireCap("product:write"),
  branchContext,
  requireIdempotencyKey("product:update"),
  productController.update,
);
productRouter.post(
  "/:id/deactivate",
  authenticate,
  requireCap("product:write"),
  branchContext,
  requireIdempotencyKey("product:deactivate"),
  productController.deactivate,
);
