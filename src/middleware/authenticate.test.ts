import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../db/client.js";
import { signAccessToken } from "../shared/tokens.js";
import { authenticate } from "./authenticate.js";

// TDD §11.2: access tokens are stateless (verified by signature, no DB hit for the token itself)
// — but authenticate.ts already does a DB round trip every request to check is_active. This test
// proves role now comes from that same fresh row, not the (potentially stale) JWT claim, so a
// role change takes effect on the very next request rather than waiting up to 15 minutes for the
// old access token to expire.

function fakeReq(token: string): Request {
  return {
    header: (name: string) => (name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined),
  } as unknown as Request;
}

const fakeRes = {} as Response;
const noopNext: NextFunction = () => undefined;

describe("authenticate", () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("uses the freshly-fetched row's role, not the JWT's role claim, once the DB role has changed", async () => {
    const user = await prisma.user.create({
      data: {
        username: `authenticatetest_${randomUUID()}`,
        passwordHash: "unused",
        name: "Authenticate Test User",
        role: "employee",
        isActive: true,
        mustChangePassword: false,
      },
    });
    createdUserIds.push(user.id);

    // Token minted while still an employee — its embedded role claim is now stale.
    const token = signAccessToken({ userId: user.id, role: "employee" });

    const firstReq = fakeReq(token);
    await authenticate(firstReq, fakeRes, noopNext);
    expect(firstReq.auth?.role).toBe("employee");

    // Super Admin promotes them mid-session — no new token issued, same old token still in use.
    await prisma.user.update({ where: { id: user.id }, data: { role: "admin" } });

    const secondReq = fakeReq(token);
    await authenticate(secondReq, fakeRes, noopNext);
    expect(secondReq.auth?.role).toBe("admin");
  }, 30_000); // user.create + 2x authenticate (DB lookup each) + user.update — same headroom as
  // the other multi-round-trip tests in this suite (CLAUDE.md: generous timeouts on this connection).
});