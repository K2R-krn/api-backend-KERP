import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireCap } from "../../middleware/authorize.js";
import { branchContext } from "../../middleware/branch-context.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import * as partyController from "./party.controller.js";

export const partyRouter = Router();

partyRouter.get("/", authenticate, requireCap("party:read"), branchContext, partyController.list);
partyRouter.get("/:id", authenticate, requireCap("party:read"), branchContext, partyController.get);

partyRouter.post(
  "/",
  authenticate,
  requireCap("party:write"),
  branchContext,
  requireIdempotencyKey("party:create"),
  partyController.create,
);
partyRouter.patch(
  "/:id",
  authenticate,
  requireCap("party:write"),
  branchContext,
  requireIdempotencyKey("party:update"),
  partyController.update,
);
partyRouter.post(
  "/:id/deactivate",
  authenticate,
  requireCap("party:write"),
  branchContext,
  requireIdempotencyKey("party:deactivate"),
  partyController.deactivate,
);
