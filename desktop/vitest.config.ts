import { fileURLToPath } from "node:url";
import { searchForWorkspaceRoot } from "vite";
import { defineConfig } from "vitest/config";

// The offline guide uses the canonical repository manual. Vite checks both
// the path and its ?raw query; grant only the repository documentation directory.
export default defineConfig({
  server: { fs: { allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL("../docs", import.meta.url))] } },
  test: {
    maxWorkers: 4,
  },
});

