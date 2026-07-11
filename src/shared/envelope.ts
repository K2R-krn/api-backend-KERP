export interface SuccessEnvelope<T> {
  data: T;
  meta: Record<string, unknown> | null;
  error: null;
}

export interface ErrorDetail {
  code: string;
  message: string;
  details?: unknown;
}

export interface FailureEnvelope {
  data: null;
  meta: null;
  error: ErrorDetail;
}

export function success<T>(data: T, meta: Record<string, unknown> | null = null): SuccessEnvelope<T> {
  return { data, meta, error: null };
}

export function failure(code: string, message: string, details?: unknown): FailureEnvelope {
  return { data: null, meta: null, error: { code, message, ...(details !== undefined ? { details } : {}) } };
}
