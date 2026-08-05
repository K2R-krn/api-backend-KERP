export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
    Error.captureStackTrace(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(details?: unknown) {
    super("VALIDATION_ERROR", "Invalid input", 422, details);
  }
}

// Stable per-throw codes (e.g. USER_INACTIVE, BRANCH_NOT_ALLOWED) are part of the API
// contract — clients branch on `code`, never on message text (TDD §15.2). Each subclass
// below takes the specific code as its argument; the message stays a fixed, generic label.
export class UnauthorizedError extends AppError {
  constructor(code = "UNAUTHORIZED", details?: unknown) {
    super(code, "Unauthorized", 401, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(code = "FORBIDDEN", details?: unknown) {
    super(code, "Forbidden", 403, details);
  }
}

export class NotFoundError extends AppError {
  constructor(code = "NOT_FOUND", details?: unknown) {
    super(code, "Not found", 404, details);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, details?: unknown) {
    super(code, "Conflict", 409, details);
  }
}

export class BadRequestError extends AppError {
  constructor(code: string, details?: unknown) {
    super(code, "Bad request", 400, details);
  }
}

// TDD §15.1 / §26 step 3 — named separately from the generic BadRequestError because the client
// needs the structured {productId, available, requested} shape to render a useful message, not
// just a code.
export class InsufficientStockError extends AppError {
  constructor(details: { productId: string; available: number; requested: number }) {
    super("INSUFFICIENT_STOCK", "Not enough stock", 409, details);
  }
}
