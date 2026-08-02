import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/client.js";
import { UnauthorizedError } from "../shared/errors.js";
import { verifyAccessToken } from "../shared/tokens.js";
import type { Role } from "../shared/types.js";

export function extractBearerToken(req: Request): string {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) throw new UnauthorizedError("MISSING_TOKEN");
  return header.slice("Bearer ".length);
}

// Express 5 propagates rejected promises from async middleware to the error handler natively —
// no try/catch or express-async-handler needed here (CLAUDE.md).
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractBearerToken(req);
  const { userId } = verifyAccessToken(token);

  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (!user || !user.isActive) throw new UnauthorizedError("USER_INACTIVE");

  // Read role from the freshly-fetched row, not the JWT claim — the claim can be stale for up to
  // the access token's remaining 15-minute life if a Super Admin changes the user's role (users
  // module). This row is already fetched for the is_active check above, so using its role instead
  // of the token's closes that window at zero extra cost.
  req.auth = { userId: user.id, role: user.role as Role };
  next();
}
