import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/client.js";
import { BadRequestError, ForbiddenError, UnauthorizedError } from "../shared/errors.js";

function resolveBranchId(req: Request): string | undefined {
  const header = req.header("x-branch-id");
  if (header) return header;

  const body = req.body as Record<string, unknown> | undefined;
  if (typeof body?.["branchId"] === "string") return body["branchId"];

  const query = req.query["branch_id"];
  if (typeof query === "string") return query;

  return undefined;
}

// Branch isolation is enforced server-side here — never trust branch_id from the client
// beyond using it to look up membership (CLAUDE.md).
export async function branchContext(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.auth) throw new UnauthorizedError();

  const branchId = resolveBranchId(req);
  if (!branchId) throw new BadRequestError("BRANCH_REQUIRED");

  if (req.auth.role !== "super_admin") {
    const membership = await prisma.userBranch.findUnique({
      where: { userId_branchId: { userId: req.auth.userId, branchId } },
    });
    if (!membership) throw new ForbiddenError("BRANCH_NOT_ALLOWED");
  }

  req.auth.branchId = branchId;
  next();
}
