const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses simple durations like "15m", "14d", "30s" into milliseconds. */
export function parseDurationToMs(input: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(input.trim());
  const amount = match?.[1];
  const unit = match?.[2];
  if (!amount || !unit) {
    throw new Error(`Invalid duration "${input}" — expected formats like "15m", "14d", "30s".`);
  }
  return Number(amount) * UNIT_MS[unit]!;
}
