import type { AuthContext } from "../shared/types.js";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      idempotencyKey?: string;
    }
  }
}

export {};
