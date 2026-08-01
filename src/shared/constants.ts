// Fixed per TDD §11.4 — not env-configurable (unlike ACCESS_TOKEN_TTL/REFRESH_TOKEN_TTL).
export const REFRESH_GRACE_WINDOW_MS = 30_000;

// Fixed per TDD §14.2.
export const IDEMPOTENCY_STALE_THRESHOLD_MS = 60_000;
export const IDEMPOTENCY_KEY_TTL_MS = 48 * 60 * 60 * 1000;

// TDD §11.4 specifies a "limited token" for the must-change-password state but does not give a
// duration — this value is our own engineering default (not a locked spec number), chosen to be
// long enough to complete a password change but short enough to limit exposure of a token that
// grants partial access. Free to change.
export const MUST_CHANGE_PASSWORD_TOKEN_TTL_MS = 10 * 60 * 1000;

// Engineering default, not spec-locked. Prisma's own default (5000ms timeout / 2000ms maxWait)
// is tight for an interactive transaction over a remote connection (Supabase) once it does more
// than 2-3 round trips — observed transient "Transaction already closed" failures in
// party.service.test.ts at ~5.3s for a 4-5-query transaction. Every $transaction call should go
// through db/client.ts's runTransaction() so this lives in one place instead of being repeated,
// or silently defaulted to Prisma's tight numbers, at each call site. Free to raise further before
// Iteration 3's heavier Sale/Purchase transactions land.
export const TRANSACTION_TIMEOUT_MS = 10_000;
export const TRANSACTION_MAX_WAIT_MS = 5_000;

// 2-digit GST state/UT codes (TDD §3.8) — the "known list" that state_code is validated against.
export const GST_STATE_CODES = [
  "01", "02", "03", "04", "05", "06", "07", "08", "09", "10",
  "11", "12", "13", "14", "15", "16", "17", "18", "19", "20",
  "21", "22", "23", "24", "25", "26", "27", "28", "29", "30",
  "31", "32", "33", "34", "35", "36", "37", "38", "97",
] as const;
