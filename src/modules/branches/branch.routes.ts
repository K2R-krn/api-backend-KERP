import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import * as branchController from "./branch.controller.js";

export const branchRouter = Router();

// No branchContext here — see branch.service.ts for why (root-of-multi-branch, chicken-and-egg).
branchRouter.get("/", authenticate, requireCap("branch:read"), branchController.list);
branchRouter.get("/:id", authenticate, requireCap("branch:read"), branchController.get);

branchRouter.post(
  "/",
  authenticate,
  requireCap("branch:manage"),
  requireIdempotencyKey("branch:create"),
  branchController.create,
);
branchRouter.patch(
  "/:id",
  authenticate,
  requireCap("branch:manage"),
  requireIdempotencyKey("branch:update"),
  branchController.update,
);
branchRouter.post(
  "/:id/deactivate",
  authenticate,
  requireCap("branch:manage"),
  requireIdempotencyKey("branch:deactivate"),
  branchController.deactivate,
);
