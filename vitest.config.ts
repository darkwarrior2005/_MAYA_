import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These exercise real git repos and real subprocesses; on Windows a single
    // merge test runs a dozen git invocations, which overruns the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
