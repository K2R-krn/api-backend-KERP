import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import { branchContext } from "../../middleware/branch-context.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import * as purchaseController from "./purchase.controller.js";

export const purchaseRouter = Router();

// Last-cost recall (§28.1 purchase mirror) — read-only, purchase:read (deliberately excludes
// Employee — see authorize.ts).
purchaseRouter.get(
  "/suppliers/:supplierId/products/:productId/last-cost",
  authenticate,
  requireCap("purchase:read"),
  branchContext,
  purchaseController.lastCost,
);

// confirmPurchase (TDD §27) — atomic, fully built and tested in a prior session; this is its
// first HTTP wiring.
purchaseRouter.post(
  "/confirm",
  authenticate,
  requireCap("purchase:create"),
  branchContext,
  requireIdempotencyKey("purchase:confirm"),
  purchaseController.confirm,
);
