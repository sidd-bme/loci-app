import { fileURLToPath } from "node:url";
import { searchForWorkspaceRoot } from "vite";
import { defineConfig } from "vitest/config";

const workerOverride = process.env.VITEST_MAX_WORKERS;
if (workerOverride !== undefined && (!/^[1-9][0-9]*$/.test(workerOverride) || !Number.isSafeInteger(Number(workerOverride)))) {
  throw new Error("VITEST_MAX_WORKERS must be a positive safe integer.");
}

// The offline guide uses the canonical repository manual. Vite checks both
// the path and its ?raw query; grant only the repository documentation directory.
export default defineConfig({
  server: { fs: { allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL("../docs", import.meta.url))] } },
  test: {
    // Keep memory-intensive renderer journeys within their existing per-test
    // budgets on hosted macOS by running test files serially.
    maxWorkers: workerOverride === undefined ? (process.env.CI ? 1 : 4) : Number(workerOverride),
  },
});

