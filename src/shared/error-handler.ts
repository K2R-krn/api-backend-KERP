import type { NextFunction, Request, Response } from "express";
import { AppError } from "./errors.js";
import { failure } from "./envelope.js";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json(failure(err.code, err.message, err.details));
    return;
  }

  console.error(err);
  res.status(500).json(failure("INTERNAL", "An unexpected error occurred."));
}
