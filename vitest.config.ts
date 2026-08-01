import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Service-layer tests hit the real dev DB over the network (TDD §22.1, no mocks) — the
    // default 5s budget is too tight for tests doing several sequential round-trips.
    testTimeout: 15_000,
    // beforeAll/afterAll do their own sequential round-trips (create/cleanup throwaway
    // branch+user+audit rows) and are just as exposed to network latency as the tests
    // themselves — vitest's hookTimeout defaults to 10s regardless of testTimeout above it.
    hookTimeout: 15_000,
    // All service-layer test files share one real, connection/rate-limited dev DB (TDD §22.1 —
    // no mocks). Running files in parallel means their transactions compete for the same pool,
    // and holding transactions open longer (the timeout raise above) made that contention show up
    // as real failures: an FK violation and a timeout, both gone once files run one at a time.
    // Slower, but correct — this DB is a shared resource, not a per-file sandbox.
    fileParallelism: false,
  },
});
