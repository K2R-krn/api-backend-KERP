import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/client.js";
import { UnauthorizedError } from "../shared/errors.js";
import { verifyAccessToken } from "../shared/tokens.js";

export function extractBearerToken(req: Request): string {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) throw new UnauthorizedError("MISSING_TOKEN");
  return header.slice("Bearer ".length);
}

// Express 5 propagates rejected promises from async middleware to the error handler natively —
// no try/catch or express-async-handler needed here (CLAUDE.md).
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractBearerToken(req);
  const { userId, role } = verifyAccessToken(token);

  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (!user || !user.isActive) throw new UnauthorizedError("USER_INACTIVE");

  req.auth = { userId: user.id, role };
  next();
}
