import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import { branchContext } from "../../middleware/branch-context.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import * as saleController from "./sale.controller.js";

export const saleRouter = Router();

// Recall (§28.1) and the printable payload (§28.6) — read-only, sale:read.
saleRouter.get(
  "/customers/:customerId/products/:productId/last-price",
  authenticate,
  requireCap("sale:read"),
  branchContext,
  saleController.lastPrice,
);
saleRouter.get("/:id/invoice", authenticate, requireCap("sale:read"), branchContext, saleController.invoice);

// createDraft/confirmSale (TDD §26/§28.2) — atomic, fully built and tested in prior sessions;
// this is their first HTTP wiring.
saleRouter.post(
  "/draft",
  authenticate,
  requireCap("sale:create"),
  branchContext,
  requireIdempotencyKey("sale:draft"),
  saleController.draft,
);
saleRouter.post(
  "/confirm",
  authenticate,
  requireCap("sale:create"),
  branchContext,
  requireIdempotencyKey("sale:confirm"),
  saleController.confirm,
);

// editSale/cancelSale (TDD §28.4) — super_admin/admin only (Blueprint §6.11), enforced via
// sale:editCancel (already in the capability map, not sale:create).
saleRouter.patch(
  "/:id",
  authenticate,
  requireCap("sale:editCancel"),
  branchContext,
  requireIdempotencyKey("sale:edit"),
  saleController.edit,
);
saleRouter.post(
  "/:id/cancel",
  authenticate,
  requireCap("sale:editCancel"),
  branchContext,
  requireIdempotencyKey("sale:cancel"),
  saleController.cancel,
);
