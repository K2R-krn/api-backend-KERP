import type { Request, Response } from "express";
import { extractBearerToken } from "../../middleware/authenticate.js";
import { success } from "../../shared/envelope.js";
import { verifyAccessToken, verifyMustChangePasswordToken } from "../../shared/tokens.js";
import { parseWithSchema } from "../../shared/validate.js";
import * as authService from "./auth.service.js";
import { changePasswordSchema, loginSchema, logoutSchema, refreshSchema } from "./auth.validation.js";

function bearerUserId(req: Request): string {
  return verifyAccessToken(extractBearerToken(req)).userId;
}

export async function login(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(loginSchema, req.body);
  const result = await authService.login(input, { userAgent: req.header("user-agent") });
  res.json(success(result));
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(refreshSchema, req.body);
  const result = await authService.refresh(input, { userAgent: req.header("user-agent") });
  res.json(success(result));
}

// Bypasses the `authenticate` middleware by design: a must-change-password user was never
// issued a normal access token (TDD §11.4), so this endpoint accepts either the limited
// changePasswordToken from login, or a normal Bearer token for a voluntary password change.
export async function changePassword(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(changePasswordSchema, req.body);
  const userId = input.changePasswordToken
    ? verifyMustChangePasswordToken(input.changePasswordToken).userId
    : bearerUserId(req);

  await authService.changePassword(input, { userId });
  res.json(success({ changed: true }));
}

export async function logout(req: Request, res: Response): Promise<void> {
  const input = parseWithSchema(logoutSchema, req.body);
  await authService.logout(input);
  res.json(success({ loggedOut: true }));
}
